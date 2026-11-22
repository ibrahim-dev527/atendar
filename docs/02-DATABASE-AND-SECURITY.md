# Phase 2: Database and Security Plan

Powered by Ibratechh

## Files

| File | Purpose |
|---|---|
| `supabase/setup.sql` | **Run this one file** in the SQL Editor: it is 001-004 combined |
| `supabase/migrations/001_schema.sql` | 19 tables, constraints, indexes, triggers |
| `supabase/migrations/002_functions.sql` | Validation helpers and all RPCs (registration, attendance, sessions, analytics, overrides, roles) |
| `supabase/migrations/003_rls.sql` | Privilege lockdown, RLS on every table, policies, audit triggers, Realtime |
| `supabase/migrations/004_seed.sql` | Settings and starter lookups (Accounting, Levels 100-400, "Group A"). **No fake students/courses.** |
| `supabase/functions/invite-staff/index.ts` | Edge Function: Super Admin invites staff (uses service-role key server-side) |
| `supabase/tests/001_full_test.sql` | 118-assertion test suite |

## How to apply

1. Create a Supabase project.
2. **Authentication → Providers → Email:** turn **off** "Allow new users to sign up". (Staff are created by you or invited; nobody can self-register as staff.)
3. SQL Editor: paste and run `supabase/setup.sql` once (it is 001-004 combined; run it on a fresh project).
4. Create your own login: **Authentication → Users → Add user** (strong password; enable MFA later).
5. Copy that user's UUID and run, once, in the SQL Editor:
   ```sql
   select public.bootstrap_super_admin('PASTE-YOUR-USER-UUID');
   ```
   It refuses to run again once any Super Admin exists, and it is not executable through the API (only from the SQL Editor), so it cannot be used to seize control later.
6. Optional: `supabase functions deploy invite-staff` to invite more staff from the dashboard.

## What each caller can touch

| Caller | Direct table access | RPCs |
|---|---|---|
| `anon` (all students) | **None. Every table is locked.** | `get_public_config`, `register_student`, `get_session_public`, `lookup_student_for_session`, `submit_attendance`, `student_login`, `student_dashboard`, `student_logout` |
| Lecturer / Course Rep | Read-only on own courses' sessions, rosters, records and enrolled students (no WhatsApp column) | session create/open/close for assigned courses, `session_summary`, `student_analytics` (own courses only) |
| Admin | Above for all courses; write on courses, enrolments, lookups; read audit/devices/overrides | + student create/update/list (incl. WhatsApp), reopen, override |
| Super Admin | Everything above | + `admin_set_role`, settings |

Notable protections:
- **WhatsApp numbers:** column excluded from every staff `SELECT` grant on `students`; only `admin_list_students` and `student_analytics` return it, and only to Admin/Super Admin.
- **Roles can only be written** by `admin_set_role` (Super Admin), the invite Edge Function, or the one-time bootstrap. The last Super Admin cannot be removed.
- **Audit log is append-only** (update, delete and truncate are blocked by triggers). Student changes, role changes, session lifecycle and overrides are logged by the RPCs with a mandatory reason; direct edits to courses/assignments/enrolments are logged by a trigger (without a reason field).
- Every `SECURITY DEFINER` function pins `search_path = ''`.

## What I verified (plain PostgreSQL 16 with stub Supabase roles)

118 assertions pass, including:
- Duplicate Student IDs rejected, case/space-insensitively; admin cannot create duplicates either.
- Anonymous role cannot read or write any table, cannot call admin RPCs, internal helpers or bootstrap.
- Lecturers cannot read `whatsapp_number` (column denied, `select *` denied), cannot override, cannot create sessions for others' courses.
- Registered name always comes from the database; inactive, unregistered and non-enrolled students are rejected.
- Closed and expired sessions reject attendance (expiry by database clock); reopen needs an admin and a reason.
- Duplicate attendance rejected; same device cannot mark two students.
- Analytics: 6/6 = 100%, 5/6 = 83.3%, 3/6 = 50%; late joiners are not charged for earlier sessions; other courses don't leak in; no history returns null.
- Brute-force throttling on ID lookups and student sign-in.
- **40 simultaneous connections:** out of 20 parallel attempts for the same student exactly 1 recorded; with one shared device across two students exactly 1 student recorded.

## What I have NOT verified (please treat as untested)

- **Supabase-specific behaviour** on a real project: PostgREST passing `x-forwarded-for` in `request.headers` (rate limiting falls back to a shared "unknown" key if it doesn't), Realtime delivery under these RLS policies, and `auth.users` triggers. Please test these on your own project (see README checklist).
- **The `invite-staff` Edge Function** has not been run (no Supabase/Deno runtime here).
- The frontend is built and was smoke-tested in Chrome against a local Postgres with a small RPC shim (student register, check-in, dashboard; all admin routes load). Not tested against real PostgREST: admin table queries with nested data, RLS through the API, Realtime, file exports in a browser, or the Edge Function.

## Limitations (also go in the README)

1. **A Student ID is not a secret.** Anyone who knows a classmate's ID can try to mark them present. Controls: roster check, device deterrent, optional attendance code, short windows, audit trail, admin overrides.
2. **Device restriction is a deterrent, not identification.** Clearing storage, another browser, private mode or another phone bypasses it. Only a hash is stored; no hardware fingerprinting.
3. **Student dashboard sign-in** (Student ID + last 4 WhatsApp digits) is weak; it stops casual snooping, not a classmate who knows the number.
4. **Shared campus IPs** can make per-IP throttling coarse; limits are generous and adjustable in `app_settings`.
   Students who register or are enrolled while a session is open are added to its roster automatically (trigger + fallback at check-in); closed sessions are never changed.
5. Ghana numbers only (02x/05x mobile, 03x). Student IDs must be 6-10 digits plus an optional letter (e.g. 01244542B).
6. Staff `SELECT` on `students` must name columns; `select *` is denied by design.
7. Reopening a session keeps its original `opens_at`, so if `late_after_minutes` is set, submissions after a reopen are marked late.


---
**Update 2026-11-22:** `class_groups` is presented as **Classes** (a programme has many classes, each with a level; students pick programme then class; courses belong to a class). `student_login(student_id)` now needs only the Student ID. Starter data: programme *Accounting and Finance Analytics*, class *BTech Accounting and Finance Analytics Lvl 100*.
