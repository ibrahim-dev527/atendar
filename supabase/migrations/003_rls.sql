-- ============================================================================
-- Atendar | Migration 003: privileges + Row Level Security
-- Powered by Ibratechh
--
-- SECURITY MODEL
--   anon          (every student / the public)  -> NO table access at all.
--                                                  Only the whitelisted RPCs below.
--   authenticated (staff only; public sign-ups are disabled) -> table access
--                  limited by RLS and the caller's role.
--   Writes to sensitive data (students, sessions, attendance, roles) happen
--   only through SECURITY DEFINER RPCs that validate and audit the change.
-- ============================================================================

-- 1. Start from zero: nobody gets anything by default ------------------------
revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges in schema public revoke all on tables    from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- 2. Turn on RLS everywhere ---------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.user_roles           enable row level security;
alter table public.programmes           enable row level security;
alter table public.academic_levels      enable row level security;
alter table public.class_groups         enable row level security;
alter table public.academic_periods     enable row level security;
alter table public.students             enable row level security;
alter table public.courses              enable row level security;
alter table public.course_assignments   enable row level security;
alter table public.course_enrollments   enable row level security;
alter table public.attendance_sessions  enable row level security;
alter table public.session_roster       enable row level security;
alter table public.attendance_records   enable row level security;
alter table public.attendance_devices   enable row level security;
alter table public.attendance_overrides enable row level security;
alter table public.audit_logs           enable row level security;
alter table public.rate_limits          enable row level security;
alter table public.student_access_tokens enable row level security;
alter table public.app_settings         enable row level security;

-- 3. Table privileges for STAFF (authenticated). RLS then narrows rows. -------
grant select on public.profiles, public.user_roles, public.course_assignments,
                public.attendance_sessions, public.session_roster, public.attendance_records,
                public.attendance_devices, public.attendance_overrides, public.audit_logs,
                public.app_settings                      to authenticated;

-- students: every column EXCEPT whatsapp_number and pin_hash. WhatsApp numbers
-- are only reachable through admin_list_students() / student_analytics(),
-- which check the role. (Clients must list columns; `select *` is denied.)
grant select (id, student_id, full_name, programme_id, level_id, class_group_id,
              status, registration_source, created_at, updated_at)
  on public.students to authenticated;

-- lookup + course tables: staff may read; admins may write (RLS enforces who)
grant select, insert, update, delete on public.programmes, public.academic_levels,
      public.class_groups, public.academic_periods, public.courses,
      public.course_assignments, public.course_enrollments to authenticated;
grant update on public.app_settings to authenticated;

-- 4. Policies -----------------------------------------------------------------
-- profiles / roles: see yourself; admins see everyone. No direct writes.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_admin_or_super());
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin_or_super());

-- lookups: any active staff can read; admin/super can change
do $$
declare t text;
begin
  foreach t in array array['programmes','academic_levels','class_groups','academic_periods'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (public.staff_role() is not null)', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.is_admin_or_super())', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.is_admin_or_super()) with check (public.is_admin_or_super())', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.is_admin_or_super())', t);
  end loop;
end $$;

-- students: admins see all; lecturers/reps see only students enrolled in their courses
create policy students_select on public.students for select to authenticated
  using (
    public.is_admin_or_super()
    or exists (
      select 1 from public.course_enrollments e
      where e.student_id = students.id and public.can_access_course(e.course_id))
  );
-- (No INSERT/UPDATE/DELETE policy: all student writes go through audited RPCs.)

-- courses
create policy courses_select on public.courses for select to authenticated
  using (public.can_access_course(id));
create policy courses_insert on public.courses for insert to authenticated
  with check (public.is_admin_or_super());
create policy courses_update on public.courses for update to authenticated
  using (public.is_admin_or_super()) with check (public.is_admin_or_super());
create policy courses_delete on public.courses for delete to authenticated
  using (public.is_admin_or_super());

create policy ca_select on public.course_assignments for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin_or_super());
create policy ca_insert on public.course_assignments for insert to authenticated
  with check (public.is_admin_or_super());
create policy ca_update on public.course_assignments for update to authenticated
  using (public.is_admin_or_super()) with check (public.is_admin_or_super());
create policy ca_delete on public.course_assignments for delete to authenticated
  using (public.is_admin_or_super());

create policy enroll_select on public.course_enrollments for select to authenticated
  using (public.can_access_course(course_id));
create policy enroll_insert on public.course_enrollments for insert to authenticated
  with check (public.is_admin_or_super());
create policy enroll_update on public.course_enrollments for update to authenticated
  using (public.is_admin_or_super()) with check (public.is_admin_or_super());
create policy enroll_delete on public.course_enrollments for delete to authenticated
  using (public.is_admin_or_super());

-- sessions, roster, records: read-only for staff who can access the course.
-- These policies are also what protects Supabase Realtime payloads.
create policy sessions_select on public.attendance_sessions for select to authenticated
  using (public.can_access_course(course_id));
create policy roster_select on public.session_roster for select to authenticated
  using (exists (select 1 from public.attendance_sessions s
                 where s.id = session_roster.session_id and public.can_access_course(s.course_id)));
create policy records_select on public.attendance_records for select to authenticated
  using (exists (select 1 from public.attendance_sessions s
                 where s.id = attendance_records.session_id and public.can_access_course(s.course_id)));

-- integrity + audit tables: administrators only
create policy devices_select on public.attendance_devices for select to authenticated
  using (public.is_admin_or_super());
create policy overrides_select on public.attendance_overrides for select to authenticated
  using (public.is_admin_or_super());
create policy audit_select on public.audit_logs for select to authenticated
  using (public.is_admin_or_super());

-- settings: admins read, Super Admin changes
create policy settings_select on public.app_settings for select to authenticated
  using (public.is_admin_or_super());
create policy settings_update on public.app_settings for update to authenticated
  using (public.staff_role() = 'super_admin') with check (public.staff_role() = 'super_admin');

-- rate_limits, student_access_tokens: RLS on, NO policies => unreachable via API.

-- 5. Audit trigger for direct admin edits on course structure ----------------
create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare j_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
        j_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
begin
  if (select auth.uid()) is null then          -- system actions (e.g. auto-enrolment) are not logged here
    return coalesce(new, old);
  end if;
  insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details)
  values ((select auth.uid()), public.staff_role(), tg_table_name || '.' || lower(tg_op), tg_table_name,
          coalesce(j_new->>'id', j_old->>'id', coalesce(j_new->>'course_id', j_old->>'course_id')),
          jsonb_build_object('old', j_old, 'new', j_new));
  return coalesce(new, old);
end $$;

create trigger trg_audit_courses after insert or update or delete on public.courses
  for each row execute function public.audit_row_change();
create trigger trg_audit_assignments after insert or update or delete on public.course_assignments
  for each row execute function public.audit_row_change();
create trigger trg_audit_enrollments after insert or update or delete on public.course_enrollments
  for each row execute function public.audit_row_change();

-- 6. Function privileges ------------------------------------------------------
-- 6a. Student / public RPCs (anon + authenticated)
grant execute on function
  public.get_public_config(),
  public.register_student(text, text, text, uuid, uuid, uuid),
  public.get_session_public(text),
  public.lookup_student_for_session(text, text),
  public.submit_attendance(text, text, text, text),
  public.student_login(text),
  public.student_dashboard(text),
  public.student_logout(text)
to anon, authenticated;

-- 6b. Staff RPCs + helpers used inside RLS policies (authenticated only)
grant execute on function
  public.staff_role(),
  public.is_admin_or_super(),
  public.can_access_course(uuid),
  public.can_manage_course_sessions(uuid),
  public.admin_create_student(text, text, text, uuid, uuid, uuid, text),
  public.admin_update_student(uuid, jsonb, text),
  public.admin_list_students(text, uuid, uuid, uuid, text, int, int),
  public.admin_set_role(uuid, text, text),
  public.admin_override_attendance(uuid, uuid, text, text),
  public.create_session(uuid, text, date, time, int, text, int),
  public.open_session(uuid),
  public.close_session(uuid),
  public.reopen_session(uuid, int, text),
  public.session_summary(uuid),
  public.student_analytics(uuid),
  public.dashboard_stats(),
  public.normalize_student_id(text),
  public.normalize_gh_phone(text)
to authenticated;

-- 6c. NOT granted to any API role (callable only by the database owner):
--     bootstrap_super_admin, _create_student, _student_stats, _audit, _rate_ok,
--     _setting, _sha256, _client_key, _enroll_student_in_matching_courses

-- 7. Realtime: publish attendance_records so staff dashboards update live.
--    RLS above decides which staff receive which rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendance_records') then
    alter publication supabase_realtime add table public.attendance_records;
  end if;
end $$;
