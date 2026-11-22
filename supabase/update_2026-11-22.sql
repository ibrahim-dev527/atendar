-- ============================================================================
--  Atendar | UPDATE for projects that already ran the earlier setup.sql
--  Run ONCE in Supabase SQL Editor. Safe to run twice.
--  What it does:
--   1. Student sign-in now uses the Student ID only (no WhatsApp digits).
--   2. Renames the starter data: programme "Accounting" -> "Accounting and
--      Finance Analytics", class "Group A" -> "BTech Accounting and Finance
--      Analytics Lvl 100". (Only if you have not already changed them.)
--  Powered by Ibratechh
-- ============================================================================

drop function if exists public.student_login(text, text);

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

revoke all on function public.student_login(text) from public;
grant execute on function public.student_login(text) to anon, authenticated;

-- starter data
update public.programmes
   set name = 'Accounting and Finance Analytics', code = 'AFA'
 where code = 'ACC' and name = 'Accounting'
   and not exists (select 1 from public.programmes where code = 'AFA');

update public.class_groups
   set name = 'BTech Accounting and Finance Analytics Lvl 100'
 where name = 'Group A'
   and programme_id in (select id from public.programmes where code = 'AFA');


-- ============================================================================
-- Part 2: short "class code" (join code) so students can type a code instead of
-- scanning the QR / opening the link.
-- ============================================================================
alter table public.attendance_sessions add column if not exists join_code text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'attendance_sessions_join_code_key') then
    alter table public.attendance_sessions add constraint attendance_sessions_join_code_key unique (join_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attendance_sessions_join_code_check') then
    alter table public.attendance_sessions add constraint attendance_sessions_join_code_check check (join_code is null or join_code ~ '^[A-Z0-9]{6}$');
  end if;
end $$;

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

-- give every existing session a code
update public.attendance_sessions set join_code = public._new_join_code() where join_code is null;

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

revoke all on function public._new_join_code() from public, anon, authenticated;
revoke all on function public.create_session(uuid, text, date, time, int, text, int) from public, anon;
grant execute on function public.create_session(uuid, text, date, time, int, text, int) to authenticated;
revoke all on function public.resolve_join_code(text) from public;
grant execute on function public.resolve_join_code(text) to anon, authenticated;
