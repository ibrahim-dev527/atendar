-- ============================================================================
-- Atendar | Migration 002: functions
-- Powered by Ibratechh
--
-- DESIGN RULES
--  1. Every SECURITY DEFINER function sets search_path = '' and uses fully
--     qualified names, so it cannot be hijacked by a malicious schema.
--  2. Student-facing and staff-facing RPCs RETURN jsonb {ok, code, ...} for
--     business errors instead of RAISING. Raising would roll back the
--     transaction, including the rate-limit counter we just incremented,
--     which would make failed attempts free.
--  3. Staff RPCs check the caller's role INSIDE the function.
--  4. Internal helpers (prefixed with _) are never granted to API roles.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Normalisation and validation
-- ----------------------------------------------------------------------------
create or replace function public.normalize_student_id(p text)
returns text language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g'))
$$;

create or replace function public.normalize_full_name(p text)
returns text language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))
$$;

-- Accepts 0544823484, 544823484, 233544823484, +233 54 482 3484, 054-482-3484.
-- Returns E.164 (+233544823484) or NULL when invalid.
create or replace function public.normalize_gh_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
  nat text;
begin
  if d like '233%' and length(d) = 12 then nat := substr(d, 4);
  elsif d like '0%'   and length(d) = 10 then nat := substr(d, 2);
  elsif length(d) = 9                    then nat := d;
  else return null;
  end if;
  if nat ~ '^[235][0-9]{8}$' then return '+233' || nat; end if;
  return null;
end $$;

-- ----------------------------------------------------------------------------
-- Role helpers (used by RLS policies and RPCs)
-- ----------------------------------------------------------------------------
create or replace function public.staff_role()
returns text language sql stable security definer set search_path = '' as $$
  select ur.role
  from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = (select auth.uid())
$$;

create or replace function public.is_admin_or_super()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.staff_role() in ('super_admin','admin'), false)
$$;

create or replace function public.can_access_course(p_course uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when public.staff_role() in ('super_admin','admin') then true
    when public.staff_role() in ('lecturer','course_rep') then exists (
      select 1 from public.course_assignments ca
      where ca.course_id = p_course and ca.user_id = (select auth.uid()))
    else false end
$$;

-- Can the caller start/close sessions for this course?
create or replace function public.can_manage_course_sessions(p_course uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when public.staff_role() in ('super_admin','admin') then true
    when public.staff_role() in ('lecturer','course_rep') then exists (
      select 1 from public.course_assignments ca
      where ca.course_id = p_course
        and ca.user_id = (select auth.uid())
        and ca.can_create_sessions)
    else false end
$$;

-- Effective session state, decided by DATABASE time.
create or replace function public.session_is_open(s public.attendance_sessions)
returns boolean language sql stable set search_path = '' as $$
  select s.status = 'open' and s.closes_at is not null and now() < s.closes_at
$$;

create or replace function public.session_effective_status(s public.attendance_sessions)
returns text language sql stable set search_path = '' as $$
  select case
    when s.status = 'open' and now() >= s.closes_at then 'expired'
    else s.status end
$$;

-- ----------------------------------------------------------------------------
-- Audit + rate limiting (internal)
-- ----------------------------------------------------------------------------
create or replace function public._audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_reason text default null, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, reason, details)
  values ((select auth.uid()), public.staff_role(), p_action, p_entity_type, p_entity_id, p_reason, coalesce(p_details, '{}'::jsonb));
end $$;

-- Best-effort client identity for throttling. Behind Supabase, PostgREST puts
-- request headers in a GUC. NOTE: shared campus Wi-Fi means many students may
-- share one IP, so limits are deliberately generous.
create or replace function public._client_key()
returns text language plpgsql stable set search_path = '' as $$
declare h jsonb;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then h := null;
  end;
  return coalesce(
    nullif(btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''),
    nullif(h->>'x-real-ip', ''),
    'unknown');
end $$;

-- Fixed-window counter. Returns TRUE when the caller is still within the limit.
create or replace function public._rate_ok(p_bucket text, p_key text, p_max int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into public.rate_limits (bucket, key, window_start, hits)
  values (p_bucket, p_key, v_start, 1)
  on conflict (bucket, key, window_start)
  do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  -- opportunistic cleanup keeps the table small without needing cron
  if random() < 0.02 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end $$;

create or replace function public._setting(p_key text, p_default text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select value from public.app_settings where key = p_key), p_default)
$$;

create or replace function public._sha256(p text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p, 'sha256'), 'hex')
$$;

-- ----------------------------------------------------------------------------
-- Student creation (shared by self-registration and admin-assisted)
-- ----------------------------------------------------------------------------
create or replace function public._enroll_student_in_matching_courses(p_student uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if public._setting('auto_enroll', 'true') <> 'true' then return 0; end if;
  insert into public.course_enrollments (course_id, student_id)
  select c.id, s.id
  from public.students s
  join public.courses c
    on c.programme_id = s.programme_id
   and c.level_id = s.level_id
   and (c.class_group_id is null or c.class_group_id = s.class_group_id)
  left join public.academic_periods ap on ap.id = c.academic_period_id
  where s.id = p_student
    and not c.is_archived
    and (c.academic_period_id is null or ap.is_current)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public._create_student(
  p_full_name text, p_student_id text, p_whatsapp text,
  p_programme uuid, p_level uuid, p_group uuid,
  p_source text, p_registered_by uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := public.normalize_full_name(p_full_name);
  v_sid   text := public.normalize_student_id(p_student_id);
  v_phone text := public.normalize_gh_phone(p_whatsapp);
  v_id    uuid;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 120 or v_name !~ '^[^0-9<>@#$%^&*=+{}\[\]|\\~`]+$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_NAME',
      'message', 'Please enter your full name using letters only.');
  end if;
  if v_sid !~ '^[0-9]{6,10}[A-Z]?$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STUDENT_ID',
      'message', 'That Student ID does not look right. For example 01244542B.');
  end if;
  if v_phone is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PHONE',
      'message', 'Enter a valid Ghana WhatsApp number, e.g. 0244123456.');
  end if;
  if not exists (
    select 1 from public.class_groups g
    join public.programmes p on p.id = g.programme_id and p.is_active
    join public.academic_levels l on l.id = g.level_id and l.is_active
    where g.id = p_group and g.is_active and g.programme_id = p_programme and g.level_id = p_level
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PLACEMENT',
      'message', 'The programme, level and class/group you chose do not match. Please choose again.');
  end if;

  begin
    insert into public.students
      (student_id, full_name, whatsapp_number, programme_id, level_id, class_group_id,
       status, registration_source, registered_by)
    values (v_sid, v_name, v_phone, p_programme, p_level, p_group, 'active', p_source, p_registered_by)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'STUDENT_ID_EXISTS',
      'message', 'This Student ID is already registered. If you need help, contact the system administrator.');
  end;

  perform public._enroll_student_in_matching_courses(v_id);
  return jsonb_build_object('ok', true, 'id', v_id, 'student_id', v_sid, 'full_name', v_name);
end $$;

-- Public: dropdown data for the registration form. No student data.
create or replace function public.get_public_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin_contact', public._setting('admin_contact', '0544823484'),
    'programmes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                            from public.programmes where is_active), '[]'),
    'levels',     coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by level_number)
                            from public.academic_levels where is_active), '[]'),
    'class_groups', coalesce((select jsonb_agg(jsonb_build_object(
                              'id', id, 'name', name, 'programme_id', programme_id, 'level_id', level_id) order by name)
                              from public.class_groups where is_active), '[]'))
$$;

-- Public: self registration
create or replace function public.register_student(
  p_full_name text, p_student_id text, p_whatsapp text,
  p_programme uuid, p_level uuid, p_class_group uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public._rate_ok('register', public._client_key(),
        public._setting('rl_register_max', '300')::int, 3600) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED',
      'message', 'Too many registration attempts. Please wait a while and try again.');
  end if;

  r := public._create_student(p_full_name, p_student_id, p_whatsapp,
                              p_programme, p_level, p_class_group, 'self', null);
  if (r->>'ok')::boolean then
    perform public._audit('student.self_register', 'student', r->>'id', 'Self registration',
      jsonb_build_object('student_id', r->>'student_id'));
  end if;
  return r;
end $$;

-- ----------------------------------------------------------------------------
-- Admin: student management
-- ----------------------------------------------------------------------------
create or replace function public.admin_create_student(
  p_full_name text, p_student_id text, p_whatsapp text,
  p_programme uuid, p_level uuid, p_class_group uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.is_admin_or_super() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You do not have permission to do this.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Please give a reason for this change.');
  end if;
  r := public._create_student(p_full_name, p_student_id, p_whatsapp,
                              p_programme, p_level, p_class_group, 'admin', (select auth.uid()));
  if (r->>'ok')::boolean then
    perform public._audit('student.admin_create', 'student', r->>'id', p_reason,
      jsonb_build_object('student_id', r->>'student_id'));
  end if;
  return r;
end $$;

-- p_changes may contain: full_name, student_id, whatsapp_number, programme_id,
-- level_id, class_group_id, status ('active' | 'inactive')
create or replace function public.admin_update_student(
  p_id uuid, p_changes jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  old_row public.students;
  new_row public.students;
  v_phone text;
  v_sid text;
  v_name text;
begin
  if not public.is_admin_or_super() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You do not have permission to do this.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Please give a reason for this change.');
  end if;
  select * into old_row from public.students where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Student not found.');
  end if;

  if p_changes ? 'full_name' then
    v_name := public.normalize_full_name(p_changes->>'full_name');
    if char_length(v_name) < 2 then
      return jsonb_build_object('ok', false, 'code', 'INVALID_NAME', 'message', 'Name is too short.');
    end if;
  else v_name := old_row.full_name; end if;

  if p_changes ? 'student_id' then
    v_sid := public.normalize_student_id(p_changes->>'student_id');
    if v_sid !~ '^[0-9]{6,10}[A-Z]?$' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_STUDENT_ID', 'message', 'Invalid Student ID format.');
    end if;
  else v_sid := old_row.student_id; end if;

  if p_changes ? 'whatsapp_number' then
    v_phone := public.normalize_gh_phone(p_changes->>'whatsapp_number');
    if v_phone is null then
      return jsonb_build_object('ok', false, 'code', 'INVALID_PHONE', 'message', 'Invalid Ghana WhatsApp number.');
    end if;
  else v_phone := old_row.whatsapp_number; end if;

  if p_changes ? 'status' and (p_changes->>'status') not in ('active','inactive') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'message', 'Status must be active or inactive.');
  end if;

  begin
    update public.students set
      full_name       = v_name,
      student_id      = v_sid,
      whatsapp_number = v_phone,
      programme_id    = coalesce((p_changes->>'programme_id')::uuid, programme_id),
      level_id        = coalesce((p_changes->>'level_id')::uuid, level_id),
      class_group_id  = coalesce((p_changes->>'class_group_id')::uuid, class_group_id),
      status          = coalesce(p_changes->>'status', status)
    where id = p_id
    returning * into new_row;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'code', 'STUDENT_ID_EXISTS',
        'message', 'Another student already has that Student ID.');
    when foreign_key_violation then
      return jsonb_build_object('ok', false, 'code', 'INVALID_PLACEMENT', 'message', 'Programme, level or group does not exist.');
  end;

  if not exists (select 1 from public.class_groups g
                 where g.id = new_row.class_group_id and g.programme_id = new_row.programme_id and g.level_id = new_row.level_id) then
    raise exception 'placement mismatch';   -- raising here rolls the update back
  end if;

  perform public._audit('student.update', 'student', p_id::text, p_reason,
    jsonb_build_object(
      'before', jsonb_build_object('student_id', old_row.student_id, 'full_name', old_row.full_name,
        'whatsapp_number', old_row.whatsapp_number, 'status', old_row.status,
        'programme_id', old_row.programme_id, 'level_id', old_row.level_id, 'class_group_id', old_row.class_group_id),
      'after', jsonb_build_object('student_id', new_row.student_id, 'full_name', new_row.full_name,
        'whatsapp_number', new_row.whatsapp_number, 'status', new_row.status,
        'programme_id', new_row.programme_id, 'level_id', new_row.level_id, 'class_group_id', new_row.class_group_id)));

  return jsonb_build_object('ok', true, 'id', p_id);
exception when raise_exception then
  return jsonb_build_object('ok', false, 'code', 'INVALID_PLACEMENT',
    'message', 'The programme, level and class/group do not match.');
end $$;

-- Searchable, filterable, paginated list including WhatsApp numbers.
-- Admin / Super Admin ONLY: this is how WhatsApp numbers stay protected.
create or replace function public.admin_list_students(
  p_query text default null, p_programme uuid default null, p_level uuid default null,
  p_class_group uuid default null, p_status text default null,
  p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  q text := nullif(btrim(coalesce(p_query, '')), '');
  q_sid text := public.normalize_student_id(p_query);
  q_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  q_tail text;
  v_total bigint;
  v_rows jsonb;
begin
  if not public.is_admin_or_super() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You do not have permission to do this.');
  end if;
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 5000);
  p_offset := greatest(coalesce(p_offset, 0), 0);
  q_tail := case when length(q_digits) >= 4
                 then regexp_replace(regexp_replace(q_digits, '^233', ''), '^0', '') end;

  with filtered as (
    select s.* from public.students s
    where (p_programme   is null or s.programme_id   = p_programme)
      and (p_level       is null or s.level_id       = p_level)
      and (p_class_group is null or s.class_group_id = p_class_group)
      and (p_status      is null or s.status         = p_status)
      and (q is null
           or s.full_name ilike '%' || replace(replace(q, '%', ''), '_', '') || '%'
           or s.student_id like '%' || replace(replace(q_sid, '%', ''), '_', '') || '%'
           or (q_tail is not null and s.whatsapp_number like '%' || q_tail || '%'))
  )
  select (select count(*) from filtered),
         coalesce(jsonb_agg(to_jsonb(x) order by x.full_name), '[]'::jsonb)
  into v_total, v_rows
  from (
    select f.id, f.student_id, f.full_name, f.whatsapp_number, f.status, f.created_at,
           f.registration_source, f.programme_id, f.level_id, f.class_group_id,
           p.name as programme, l.name as level, g.name as class_group
    from filtered f
    join public.programmes p on p.id = f.programme_id
    join public.academic_levels l on l.id = f.level_id
    join public.class_groups g on g.id = f.class_group_id
    order by f.full_name
    limit p_limit offset p_offset
  ) x;

  return jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows);
end $$;

-- ----------------------------------------------------------------------------
-- Staff / role management
-- ----------------------------------------------------------------------------
-- ONE-TIME bootstrap. Run from the Supabase SQL editor only (not callable via API).
create or replace function public.bootstrap_super_admin(p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.user_roles where role = 'super_admin') then
    raise exception 'A Super Administrator already exists. Bootstrap is disabled.';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'No auth user with that id. Create the user in Authentication > Users first.';
  end if;
  insert into public.profiles (id, email)
    select id, email from auth.users where id = p_user
    on conflict (id) do nothing;
  insert into public.user_roles (user_id, role, granted_by) values (p_user, 'super_admin', p_user);
  insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, reason)
    values (p_user, 'super_admin', 'staff.bootstrap_super_admin', 'user', p_user::text, 'Initial setup');
  return 'Super Administrator created.';
end $$;

-- Super Admin only. p_role = null removes the role (staff loses access).
create or replace function public.admin_set_role(p_user uuid, p_role text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  if public.staff_role() is distinct from 'super_admin' then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Only a Super Administrator can manage staff roles.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Please give a reason for this change.');
  end if;
  if p_role is not null and p_role not in ('super_admin','admin','lecturer','course_rep') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ROLE', 'message', 'Unknown role.');
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Staff account not found.');
  end if;

  select role into v_old from public.user_roles where user_id = p_user;
  if v_old = 'super_admin' and p_role is distinct from 'super_admin'
     and (select count(*) from public.user_roles where role = 'super_admin') <= 1 then
    return jsonb_build_object('ok', false, 'code', 'LAST_SUPER_ADMIN', 'message', 'You cannot remove the last Super Administrator.');
  end if;

  if p_role is null then
    delete from public.user_roles where user_id = p_user;
  else
    insert into public.user_roles (user_id, role, granted_by)
    values (p_user, p_role, (select auth.uid()))
    on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by;
  end if;

  perform public._audit('staff.set_role', 'user', p_user::text, p_reason,
    jsonb_build_object('old_role', v_old, 'new_role', p_role));
  return jsonb_build_object('ok', true);
end $$;

-- ----------------------------------------------------------------------------
-- Attendance sessions (staff)
-- ----------------------------------------------------------------------------
create or replace function public._new_join_code()
returns text language plpgsql volatile set search_path = '' as $$
declare v text; i int; alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  loop
    v := '';
    for i in 1..6 loop
      v := v || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.attendance_sessions where join_code = v);
  end loop;
  return v;
end $$;

create or replace function public.create_session(
  p_course uuid, p_title text, p_date date, p_start time, p_duration int,
  p_code text default null, p_late_after int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_token text;
begin
  if not public.can_manage_course_sessions(p_course) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You are not allowed to create sessions for this course.');
  end if;
  if not exists (select 1 from public.courses where id = p_course and not is_archived) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Course not found or archived.');
  end if;
  if char_length(btrim(coalesce(p_title, ''))) < 2 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TITLE', 'message', 'Please enter a session title.');
  end if;
  if p_duration is null or p_duration < 1 or p_duration > 240 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DURATION', 'message', 'Duration must be between 1 and 240 minutes.');
  end if;
  if nullif(p_code, '') is not null and p_code !~ '^[A-Za-z0-9]{3,12}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CODE', 'message', 'Attendance code must be 3 to 12 letters or numbers.');
  end if;

  insert into public.attendance_sessions
    (course_id, title, session_date, scheduled_start, duration_minutes, attendance_code, late_after_minutes, created_by, join_code)
  values (p_course, btrim(p_title), coalesce(p_date, current_date), p_start, p_duration,
          nullif(p_code, ''), p_late_after, (select auth.uid()), public._new_join_code())
  returning id, public_token into v_id, v_token;

  perform public._audit('session.create', 'attendance_session', v_id::text, null,
    jsonb_build_object('course_id', p_course, 'title', p_title));
  return jsonb_build_object('ok', true, 'id', v_id, 'public_token', v_token);
end $$;

-- Opening snapshots the roster and starts the clock (database time).
create or replace function public.open_session(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.attendance_sessions; n int;
begin
  select * into s from public.attendance_sessions where id = p_session for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Session not found.');
  end if;
  if not public.can_manage_course_sessions(s.course_id) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You are not allowed to manage this session.');
  end if;
  if s.status <> 'scheduled' then
    return jsonb_build_object('ok', false, 'code', 'BAD_STATE',
      'message', 'Only a new session can be started. Use "Reopen" for a finished one.');
  end if;

  insert into public.session_roster (session_id, student_id)
  select s.id, e.student_id
  from public.course_enrollments e
  join public.students st on st.id = e.student_id and st.status = 'active'
  where e.course_id = s.course_id and e.status = 'active' and e.enrolled_at <= now()
  on conflict do nothing;
  get diagnostics n = row_count;

  update public.attendance_sessions
     set status = 'open', opens_at = now(), closes_at = now() + make_interval(mins => s.duration_minutes)
   where id = s.id
  returning * into s;

  perform public._audit('session.open', 'attendance_session', s.id::text, null,
    jsonb_build_object('roster_size', n, 'closes_at', s.closes_at));
  return jsonb_build_object('ok', true, 'opens_at', s.opens_at, 'closes_at', s.closes_at, 'roster_size', n);
end $$;

create or replace function public.close_session(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.attendance_sessions;
begin
  select * into s from public.attendance_sessions where id = p_session for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Session not found.');
  end if;
  if not public.can_manage_course_sessions(s.course_id) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You are not allowed to manage this session.');
  end if;
  if s.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'BAD_STATE', 'message', 'This session is not open.');
  end if;
  update public.attendance_sessions
     set status = case when now() >= closes_at then 'expired' else 'closed' end,
         closed_at = now(),
         closes_at = least(closes_at, now())
   where id = s.id;
  perform public._audit('session.close', 'attendance_session', s.id::text);
  return jsonb_build_object('ok', true);
end $$;

-- Admin / Super Admin only, reason required.
create or replace function public.reopen_session(p_session uuid, p_minutes int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.attendance_sessions;
begin
  if not public.is_admin_or_super() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Only an administrator can reopen a session.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Please give a reason for reopening.');
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DURATION', 'message', 'Choose 1 to 240 minutes.');
  end if;
  select * into s from public.attendance_sessions where id = p_session for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Session not found.');
  end if;
  if s.status = 'scheduled' then
    return jsonb_build_object('ok', false, 'code', 'BAD_STATE', 'message', 'This session has not been started yet.');
  end if;
  update public.attendance_sessions
     set status = 'open', closes_at = now() + make_interval(mins => p_minutes), closed_at = null
   where id = s.id;
  perform public._audit('session.reopen', 'attendance_session', s.id::text, p_reason,
    jsonb_build_object('minutes', p_minutes, 'previous_status', public.session_effective_status(s)));
  return jsonb_build_object('ok', true);
end $$;

-- Live counters for the monitor screen.
create or replace function public.session_summary(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.attendance_sessions;
  v_enrolled int; v_present int; v_late int; v_excused int; v_eff text; v_finished boolean;
begin
  select * into s from public.attendance_sessions where id = p_session;
  if not found or not public.can_access_course(s.course_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Session not found.');
  end if;
  v_eff := public.session_effective_status(s);
  v_finished := v_eff in ('closed', 'expired');
  select count(*) into v_enrolled from public.session_roster where session_id = s.id;
  select count(*) filter (where status = 'present'),
         count(*) filter (where status = 'late'),
         count(*) filter (where status = 'excused')
    into v_present, v_late, v_excused
    from public.attendance_records where session_id = s.id;
  return jsonb_build_object(
    'ok', true, 'status', v_eff,
    'seconds_remaining', case when v_eff = 'open' then greatest(0, ceil(extract(epoch from (s.closes_at - now())))::int) else 0 end,
    'enrolled', v_enrolled, 'present', v_present, 'late', v_late, 'excused', v_excused,
    'absent', case when v_finished then greatest(0, v_enrolled - v_present - v_late - v_excused) end,
    'attendance_rate', case when v_enrolled - v_excused > 0
        then round(100.0 * (v_present + v_late) / (v_enrolled - v_excused), 1) end);
end $$;

-- ----------------------------------------------------------------------------
-- Attendance: STUDENT-FACING (anon). Narrow, throttled, server-validated.
-- ----------------------------------------------------------------------------
-- Session info for the attendance pop-up. Contains NO student data.
create or replace function public.get_session_public(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.attendance_sessions; c public.courses; v_eff text;
begin
  if not public._rate_ok('session_info', public._client_key(),
        public._setting('rl_session_info_max', '800')::int, 300) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Too many requests. Please wait a moment.');
  end if;
  select * into s from public.attendance_sessions where public_token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_FOUND', 'message', 'This attendance link is not valid.');
  end if;
  select * into c from public.courses where id = s.course_id;
  v_eff := public.session_effective_status(s);
  return jsonb_build_object(
    'ok', true, 'status', v_eff,
    'course_name', c.name, 'course_code', c.code, 'title', s.title,
    'requires_code', s.attendance_code is not null,
    'seconds_remaining', case when v_eff = 'open' then greatest(0, ceil(extract(epoch from (s.closes_at - now())))::int) else 0 end);
end $$;

-- Student typed the short class code instead of scanning the QR: return the session link token.
create or replace function public.resolve_join_code(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); s public.attendance_sessions;
begin
  if not public._rate_ok('join_code', public._client_key(), public._setting('rl_lookup_max', '400')::int, 300) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Too many attempts. Please wait a moment.');
  end if;
  select * into s from public.attendance_sessions where join_code = v;
  if v !~ '^[A-Z0-9]{6}$' or not found then
    return jsonb_build_object('ok', false, 'code', 'CODE_NOT_FOUND', 'message', 'We could not find a session with that code. Check it with your lecturer or course rep.');
  end if;
  return jsonb_build_object('ok', true, 'token', s.public_token);
end $$;

-- Step 1: student types their ID; we return the REGISTERED name to confirm.
create or replace function public.lookup_student_for_session(p_token text, p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.attendance_sessions; st public.students; v_sid text := public.normalize_student_id(p_student_id);
begin
  if not public._rate_ok('lookup', public._client_key(),
        public._setting('rl_lookup_max', '400')::int, 300) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Too many attempts. Please wait a few minutes and try again.');
  end if;

  select * into s from public.attendance_sessions where public_token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_FOUND', 'message', 'This attendance link is not valid.');
  end if;
  if public.session_effective_status(s) = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'SESSION_CLOSED', 'message', 'This attendance session has been closed by your lecturer.');
  end if;
  if not public.session_is_open(s) then
    return jsonb_build_object('ok', false, 'code', 'SESSION_EXPIRED', 'message', 'This attendance session has expired.');
  end if;

  select * into st from public.students where student_id = v_sid;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_REGISTERED',
      'message', 'This Student ID is not registered. Please create an account first.');
  end if;
  if st.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'INACTIVE',
      'message', 'Your account is inactive. Please contact the system administrator.');
  end if;
  if not exists (select 1 from public.session_roster where session_id = s.id and student_id = st.id) then
    -- registered/enrolled after the session started: they still count (roster grows)
    if exists (select 1 from public.course_enrollments where course_id = s.course_id and student_id = st.id and status = 'active') then
      insert into public.session_roster (session_id, student_id) values (s.id, st.id) on conflict do nothing;
    else
      return jsonb_build_object('ok', false, 'code', 'NOT_ENROLLED',
        'message', 'You are not enrolled in this course. Please contact the system administrator.');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'full_name', st.full_name,
    'already_marked', exists (select 1 from public.attendance_records where session_id = s.id and student_id = st.id));
end $$;

-- Step 2: record attendance atomically.
create or replace function public.submit_attendance(
  p_token text, p_student_id text, p_device_token text, p_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.attendance_sessions;
  st public.students;
  v_sid text := public.normalize_student_id(p_student_id);
  v_hash text;
  v_dev_student uuid;
  v_status text := 'present';
  v_rec_time timestamptz;
begin
  if not public._rate_ok('submit', public._client_key(),
        public._setting('rl_submit_max', '400')::int, 300) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', 'Too many attempts. Please wait a few minutes and try again.');
  end if;

  if p_device_token is null or char_length(p_device_token) < 32 or char_length(p_device_token) > 128 then
    return jsonb_build_object('ok', false, 'code', 'BAD_DEVICE',
      'message', 'Your browser could not be verified. Please refresh the page and try again.');
  end if;
  v_hash := public._sha256(p_device_token);

  -- Row lock serialises concurrent submissions for this session, so the
  -- device and duplicate checks below cannot race. UNIQUE constraints remain
  -- as the final backstop.
  select * into s from public.attendance_sessions where public_token = p_token for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_FOUND', 'message', 'This attendance link is not valid.');
  end if;
  if public.session_effective_status(s) = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'SESSION_CLOSED', 'message', 'This attendance session has been closed by your lecturer.');
  end if;
  if not public.session_is_open(s) then
    return jsonb_build_object('ok', false, 'code', 'SESSION_EXPIRED', 'message', 'This attendance session has expired.');
  end if;

  if s.attendance_code is not null and lower(coalesce(btrim(p_code), '')) <> lower(s.attendance_code) then
    return jsonb_build_object('ok', false, 'code', 'BAD_CODE', 'message', 'The attendance code is incorrect. Check the code shown in class.');
  end if;

  select * into st from public.students where student_id = v_sid;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_REGISTERED', 'message', 'This Student ID is not registered. Please create an account first.');
  end if;
  if st.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'INACTIVE', 'message', 'Your account is inactive. Please contact the system administrator.');
  end if;
  if not exists (select 1 from public.session_roster where session_id = s.id and student_id = st.id) then
    if exists (select 1 from public.course_enrollments where course_id = s.course_id and student_id = st.id and status = 'active') then
      insert into public.session_roster (session_id, student_id) values (s.id, st.id) on conflict do nothing;
    else
      return jsonb_build_object('ok', false, 'code', 'NOT_ENROLLED', 'message', 'You are not enrolled in this course. Please contact the system administrator.');
    end if;
  end if;

  if exists (select 1 from public.attendance_records where session_id = s.id and student_id = st.id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_MARKED', 'message', 'You have already been marked present for this session.');
  end if;

  select student_id into v_dev_student from public.attendance_devices
   where session_id = s.id and device_hash = v_hash;
  if found and v_dev_student <> st.id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_USED',
      'message', 'This device has already been used to mark attendance for another student in this session. If this is a mistake, ask your lecturer or the administrator.');
  end if;

  if s.late_after_minutes is not null and now() > s.opens_at + make_interval(mins => s.late_after_minutes) then
    v_status := 'late';
  end if;

  begin
    insert into public.attendance_devices (session_id, device_hash, student_id)
    values (s.id, v_hash, st.id) on conflict do nothing;
    insert into public.attendance_records (session_id, student_id, status, source)
    values (s.id, st.id, v_status, 'student')
    returning submitted_at into v_rec_time;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_MARKED', 'message', 'You have already been marked present for this session.');
  end;

  return jsonb_build_object('ok', true, 'full_name', st.full_name, 'status', v_status, 'submitted_at', v_rec_time);
end $$;

-- ----------------------------------------------------------------------------
-- Admin override of attendance (this is also the "device restriction override")
-- ----------------------------------------------------------------------------
-- Actions: mark_present | mark_late | mark_excused | remove
create or replace function public.admin_override_attendance(
  p_session uuid, p_student uuid, p_action text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.attendance_sessions; v_status text;
begin
  if not public.is_admin_or_super() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Only an administrator can correct attendance.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'Please explain why you are changing this record.');
  end if;
  if p_action not in ('mark_present','mark_late','mark_excused','remove') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'message', 'Unknown action.');
  end if;
  select * into s from public.attendance_sessions where id = p_session for update;
  if not found or s.status = 'scheduled' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Session not found or not started yet.');
  end if;
  if not exists (select 1 from public.students where id = p_student) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Student not found.');
  end if;

  if p_action = 'remove' then
    delete from public.attendance_records where session_id = p_session and student_id = p_student;
  else
    v_status := case p_action when 'mark_present' then 'present' when 'mark_late' then 'late' else 'excused' end;
    -- ensure the student counts as expected for this session
    insert into public.session_roster (session_id, student_id, added_by_override)
    values (p_session, p_student, true) on conflict do nothing;
    insert into public.attendance_records (session_id, student_id, status, source)
    values (p_session, p_student, v_status, 'admin_override')
    on conflict (session_id, student_id)
    do update set status = excluded.status, source = 'admin_override';
  end if;

  insert into public.attendance_overrides (session_id, student_id, action, reason, performed_by)
  values (p_session, p_student, p_action, btrim(p_reason), (select auth.uid()));
  perform public._audit('attendance.override', 'attendance_session', p_session::text, p_reason,
    jsonb_build_object('student_id', p_student, 'action', p_action));
  return jsonb_build_object('ok', true);
end $$;

-- ----------------------------------------------------------------------------
-- Analytics
-- ----------------------------------------------------------------------------
-- Eligible sessions = sessions whose ROSTER contained the student and that have
-- finished. Excused sessions leave the denominator (policy: excused absences do
-- not hurt the rate). Never counts unrelated courses or sessions before the
-- student was enrolled.
create or replace function public._student_stats(p_student uuid, p_restrict_to_staff boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb; v_eligible int; v_attended int; v_excused int; v_missed int;
begin
  select coalesce(jsonb_agg(x order by x.session_date desc, x.opens_at desc nulls last), '[]'::jsonb)
  into v_rows
  from (
    select s.id as session_id, c.code as course_code, c.name as course_name, s.title,
           s.session_date, s.opens_at,
           coalesce(r.status, 'absent') as status, r.submitted_at
    from public.session_roster sr
    join public.attendance_sessions s on s.id = sr.session_id
    join public.courses c on c.id = s.course_id
    left join public.attendance_records r on r.session_id = s.id and r.student_id = sr.student_id
    where sr.student_id = p_student
      and public.session_effective_status(s) in ('closed', 'expired')
      and (not p_restrict_to_staff or public.can_access_course(s.course_id))
  ) x;

  select count(*) filter (where e->>'status' <> 'excused'),
         count(*) filter (where e->>'status' in ('present','late')),
         count(*) filter (where e->>'status' = 'excused'),
         count(*) filter (where e->>'status' = 'absent')
  into v_eligible, v_attended, v_excused, v_missed
  from jsonb_array_elements(v_rows) e;

  return jsonb_build_object(
    'eligible', v_eligible, 'attended', v_attended, 'excused', v_excused, 'missed', v_missed,
    'rate', case when v_eligible > 0 then round(100.0 * v_attended / v_eligible, 1) end,
    'summary', case when v_eligible > 0 then v_attended || '/' || v_eligible end,
    'sessions', v_rows);
end $$;

create or replace function public.student_analytics(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare st public.students; v_phone boolean := public.is_admin_or_super();
begin
  if public.staff_role() is null then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You do not have permission to do this.');
  end if;
  select * into st from public.students where id = p_student;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Student not found.');
  end if;
  return jsonb_build_object('ok', true,
    'student', jsonb_build_object(
      'id', st.id, 'student_id', st.student_id, 'full_name', st.full_name, 'status', st.status,
      'whatsapp_number', case when v_phone then st.whatsapp_number end,
      'programme', (select name from public.programmes where id = st.programme_id),
      'level', (select name from public.academic_levels where id = st.level_id),
      'class_group', (select name from public.class_groups where id = st.class_group_id)),
    'stats', public._student_stats(st.id, true));
end $$;

-- Overview cards (scoped to what the caller may see)
create or replace function public.dashboard_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_att bigint; v_el bigint;
begin
  if public.staff_role() is null then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'You do not have permission to do this.');
  end if;
  select count(*) filter (where r.status in ('present','late')),
         count(*) filter (where r.status <> 'excused')
    into v_att, v_el
  from public.attendance_records r
  join public.attendance_sessions s on s.id = r.session_id
  where public.can_access_course(s.course_id);

  return jsonb_build_object('ok', true,
    'students', case when public.is_admin_or_super() then (select count(*) from public.students) end,
    'courses', (select count(*) from public.courses c where not c.is_archived and public.can_access_course(c.id)),
    'sessions', (select count(*) from public.attendance_sessions s where public.can_access_course(s.course_id)),
    'active_sessions', (select count(*) from public.attendance_sessions s
                        where public.session_is_open(s) and public.can_access_course(s.course_id)),
    'submissions', (select count(*) from public.attendance_records r
                    join public.attendance_sessions s on s.id = r.session_id
                    where public.can_access_course(s.course_id)),
    'overall_rate', (select round(100.0 * sum(case when sr_att then 1 else 0 end) / nullif(count(*), 0), 1)
       from (select exists (select 1 from public.attendance_records r
                             where r.session_id = ro.session_id and r.student_id = ro.student_id
                               and r.status in ('present','late')) as sr_att
             from public.session_roster ro
             join public.attendance_sessions s on s.id = ro.session_id
             where public.session_effective_status(s) in ('closed','expired')
               and public.can_access_course(s.course_id)
               and not exists (select 1 from public.attendance_records r2
                               where r2.session_id = ro.session_id and r2.student_id = ro.student_id
                                 and r2.status = 'excused')) q));
end $$;

-- ----------------------------------------------------------------------------
-- Student portal access (no passwords): Student ID + last 4 digits of the
-- registered WhatsApp number -> short-lived revocable token.
-- WEAK second factor by design; documented in the README.
-- ----------------------------------------------------------------------------
create or replace function public.student_login(p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sid text := public.normalize_student_id(p_student_id);
  st public.students; v_token text;
  v_bad jsonb := jsonb_build_object('ok', false, 'code', 'BAD_CREDENTIALS',
    'message', 'We could not find an active student with that Student ID. Check it and try again, or contact the system administrator.');
begin
  if not public._rate_ok('login_client', public._client_key(),
        public._setting('rl_login_max', '300')::int, 900)
     or not public._rate_ok('login_sid', v_sid, 30, 900) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED',
      'message', 'Too many attempts. Please wait 15 minutes or contact the system administrator.');
  end if;
  select * into st from public.students where student_id = v_sid;
  if not found or st.status <> 'active' then
    return v_bad;
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.student_access_tokens (token_hash, student_id, expires_at)
  values (public._sha256(v_token), st.id, now() + interval '30 minutes');
  delete from public.student_access_tokens where expires_at < now() - interval '1 day';
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_in', 1800);
end $$;

create or replace function public.student_dashboard(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t public.student_access_tokens; st public.students;
begin
  select * into t from public.student_access_tokens where token_hash = public._sha256(coalesce(p_token, ''));
  if not found or t.revoked_at is not null or t.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'SESSION_ENDED', 'message', 'Your session has ended. Please sign in again.');
  end if;
  select * into st from public.students where id = t.student_id and status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SESSION_ENDED', 'message', 'Your session has ended. Please sign in again.');
  end if;
  return jsonb_build_object('ok', true,
    'student', jsonb_build_object('student_id', st.student_id, 'full_name', st.full_name,
      'programme', (select name from public.programmes where id = st.programme_id),
      'level', (select name from public.academic_levels where id = st.level_id),
      'class_group', (select name from public.class_groups where id = st.class_group_id)),
    'stats', public._student_stats(st.id, false));
end $$;

create or replace function public.student_logout(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.student_access_tokens set revoked_at = now()
   where token_hash = public._sha256(coalesce(p_token, '')) and revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;


-- ----------------------------------------------------------------------------
-- Students who register / are enrolled while a session is running are added to
-- that session's roster straight away, so the totals always add up.
-- (Closed or expired sessions are never changed: nobody is charged retroactively.)
-- ----------------------------------------------------------------------------
create or replace function public._roster_follow_enrollment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'active' then
    insert into public.session_roster (session_id, student_id)
    select a.id, new.student_id
    from public.attendance_sessions a
    join public.students st on st.id = new.student_id and st.status = 'active'
    where a.course_id = new.course_id and public.session_is_open(a)
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists trg_roster_follow_enrollment on public.course_enrollments;
create trigger trg_roster_follow_enrollment
after insert or update of status on public.course_enrollments
for each row execute function public._roster_follow_enrollment();
revoke all on function public._roster_follow_enrollment() from public, anon, authenticated;
