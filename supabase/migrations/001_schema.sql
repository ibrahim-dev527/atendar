-- ============================================================================
-- Atendar | Migration 001: schema
-- Powered by Ibratechh
--
-- Run order: 001_schema.sql -> 002_functions.sql -> 003_rls.sql -> 004_seed.sql
-- Target: Supabase (Postgres 15+). Safe to read top to bottom.
--
-- Conventions
--   * Every table has a uuid primary key and created_at timestamptz.
--   * Status columns are text + CHECK constraints (easy to extend later).
--   * Students are NOT Supabase Auth users. Only staff are.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- ----------------------------------------------------------------------------
-- Generic helpers
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- Staff identity
-- ----------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- One role per staff member. Writable ONLY through admin_set_role() /
-- bootstrap_super_admin() / the invite-staff Edge Function.
create table public.user_roles (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  role        text not null check (role in ('super_admin','admin','lecturer','course_rep')),
  granted_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Create a profile automatically for every new Auth user.
-- It deliberately grants NO role: a new account can do nothing until a
-- Super Administrator assigns one.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Academic structure (all expandable lookups, nothing hardcoded)
-- ----------------------------------------------------------------------------
create table public.programmes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code = upper(code)),
  name        text not null unique,
  department  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.academic_levels (
  id          uuid primary key default gen_random_uuid(),
  level_number int not null unique check (level_number between 100 and 900),
  name        text not null unique,                 -- e.g. 'Level 100'
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.class_groups (
  id            uuid primary key default gen_random_uuid(),
  programme_id  uuid not null references public.programmes(id) on delete restrict,
  level_id      uuid not null references public.academic_levels(id) on delete restrict,
  name          text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (programme_id, level_id, name)
);
create index idx_class_groups_prog_level on public.class_groups (programme_id, level_id);

create table public.academic_periods (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,                 -- e.g. '2026/2027 Semester 1'
  starts_on   date not null,
  ends_on     date not null,
  is_current  boolean not null default false,
  created_at  timestamptz not null default now(),
  check (ends_on > starts_on)
);
create unique index uq_one_current_period on public.academic_periods (is_current) where is_current;

-- ----------------------------------------------------------------------------
-- Students: the single central register
-- ----------------------------------------------------------------------------
create table public.students (
  id                  uuid primary key default gen_random_uuid(),   -- internal id
  student_id          text not null,                                 -- normalised (UPPER, no spaces)
  full_name           text not null,
  whatsapp_number     text not null,                                 -- E.164, e.g. +233544823484
  programme_id        uuid not null references public.programmes(id)     on delete restrict,
  level_id            uuid not null references public.academic_levels(id) on delete restrict,
  class_group_id      uuid not null references public.class_groups(id)   on delete restrict,
  status              text not null default 'active' check (status in ('active','inactive')),
  registration_source text not null default 'self'   check (registration_source in ('self','admin')),
  registered_by       uuid references public.profiles(id) on delete set null,
  pin_hash            text,                          -- reserved for a future PIN/OTP upgrade; unused in v1
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_students_student_id unique (student_id),
  constraint chk_student_id_format  check (student_id ~ '^[0-9]{6,10}[A-Z]?$' and student_id = upper(student_id)),
  constraint chk_whatsapp_e164      check (whatsapp_number ~ '^\+233[235][0-9]{8}$'),
  constraint chk_full_name_len      check (char_length(full_name) between 2 and 120)
);
create trigger trg_students_touch before update on public.students
  for each row execute function public.touch_updated_at();

create index idx_students_name_trgm on public.students using gin (full_name extensions.gin_trgm_ops);
create index idx_students_sid_trgm  on public.students using gin (student_id extensions.gin_trgm_ops);
create index idx_students_whatsapp  on public.students (whatsapp_number);
create index idx_students_filters   on public.students (programme_id, level_id, class_group_id, status);

-- ----------------------------------------------------------------------------
-- Courses, staff assignments, enrolments
-- ----------------------------------------------------------------------------
create table public.courses (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null check (code = upper(code)),
  name               text not null,
  programme_id       uuid not null references public.programmes(id)      on delete restrict,
  level_id           uuid not null references public.academic_levels(id) on delete restrict,
  class_group_id     uuid references public.class_groups(id)             on delete restrict, -- null = all groups
  academic_period_id uuid references public.academic_periods(id)         on delete restrict,
  is_archived        boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_courses_touch before update on public.courses
  for each row execute function public.touch_updated_at();
create unique index uq_course_code_period on public.courses
  (code, coalesce(academic_period_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index idx_courses_filters on public.courses (programme_id, level_id, class_group_id) where not is_archived;

create table public.course_assignments (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null references public.courses(id)  on delete cascade,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  assignment_role     text not null check (assignment_role in ('lecturer','course_rep')),
  can_create_sessions boolean not null default true,
  created_at          timestamptz not null default now(),
  unique (course_id, user_id)
);
create index idx_course_assignments_user on public.course_assignments (user_id);

create table public.course_enrollments (
  course_id    uuid not null references public.courses(id)  on delete cascade,
  student_id   uuid not null references public.students(id) on delete cascade,
  status       text not null default 'active' check (status in ('active','dropped')),
  enrolled_at  timestamptz not null default now(),
  primary key (course_id, student_id)
);
create index idx_enrollments_student on public.course_enrollments (student_id);

-- ----------------------------------------------------------------------------
-- Attendance
-- ----------------------------------------------------------------------------
create table public.attendance_sessions (
  id                 uuid primary key default gen_random_uuid(),
  course_id          uuid not null references public.courses(id) on delete restrict,
  title              text not null,
  session_date       date not null,
  scheduled_start    time,
  duration_minutes   int  not null check (duration_minutes between 1 and 240),
  attendance_code    text check (attendance_code is null or attendance_code ~ '^[A-Za-z0-9]{3,12}$'),
  late_after_minutes int  check (late_after_minutes is null or late_after_minutes > 0),
  -- Unguessable link token (192 bits). This, not the row id, is what goes in the URL/QR.
  public_token       text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  -- Short spoken code (e.g. K7M2QX): students can type it instead of scanning the QR / opening the link.
  join_code          text unique check (join_code is null or join_code ~ '^[A-Z0-9]{6}$'),
  status             text not null default 'scheduled' check (status in ('scheduled','open','closed','expired')),
  opens_at           timestamptz,
  closes_at          timestamptz,
  closed_at          timestamptz,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index idx_sessions_course_date on public.attendance_sessions (course_id, session_date desc);
create index idx_sessions_status      on public.attendance_sessions (status) where status = 'open';

-- Snapshot of who was EXPECTED at a session, taken when it is opened.
-- Late joiners therefore never have earlier sessions counted against them.
create table public.session_roster (
  session_id  uuid not null references public.attendance_sessions(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  added_by_override boolean not null default false,
  primary key (session_id, student_id)
);
create index idx_roster_student on public.session_roster (student_id);

create table public.attendance_records (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.attendance_sessions(id) on delete cascade,
  student_id    uuid not null references public.students(id)           on delete cascade,
  status        text not null default 'present' check (status in ('present','late','excused')),
  source        text not null default 'student' check (source in ('student','admin_override')),
  submitted_at  timestamptz not null default now(),   -- database time, never client time
  -- DUPLICATE PROTECTION: one row per student per session, enforced by the database
  constraint uq_attendance_once unique (session_id, student_id)
);
create index idx_records_student on public.attendance_records (student_id);
create index idx_records_session_time on public.attendance_records (session_id, submitted_at);

-- Device restriction (a DETERRENT only, see docs). We store a SHA-256 hash of
-- the random browser token, never the token itself.
create table public.attendance_devices (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.attendance_sessions(id) on delete cascade,
  device_hash  text not null,
  student_id   uuid not null references public.students(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  constraint uq_device_per_session unique (session_id, device_hash)
);

create table public.attendance_overrides (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.attendance_sessions(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  action      text not null check (action in ('mark_present','mark_late','mark_excused','remove')),
  reason      text not null check (char_length(btrim(reason)) >= 3),
  performed_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index idx_overrides_session on public.attendance_overrides (session_id);

-- ----------------------------------------------------------------------------
-- Audit log (append-only)
-- ----------------------------------------------------------------------------
create table public.audit_logs (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid,                    -- staff user; null = student / system
  actor_role   text,
  action       text not null,           -- e.g. 'student.update'
  entity_type  text not null,
  entity_id    text,
  reason       text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index idx_audit_created on public.audit_logs (created_at desc);
create index idx_audit_entity  on public.audit_logs (entity_type, entity_id);

create or replace function public.audit_logs_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs is append-only';
end $$;
create trigger trg_audit_no_update before update or delete on public.audit_logs
  for each row execute function public.audit_logs_immutable();
create trigger trg_audit_no_truncate before truncate on public.audit_logs
  for each statement execute function public.audit_logs_immutable();

-- ----------------------------------------------------------------------------
-- Supporting tables
-- ----------------------------------------------------------------------------
create table public.rate_limits (
  bucket        text not null,
  key           text not null,
  window_start  timestamptz not null,
  hits          int not null default 0,
  primary key (bucket, key, window_start)
);

create table public.student_access_tokens (
  token_hash  text primary key,                       -- SHA-256 of the token
  student_id  uuid not null references public.students(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index idx_sat_student on public.student_access_tokens (student_id);

create table public.app_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);
