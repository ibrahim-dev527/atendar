# Atendar: Phase 1 Architecture

Powered by Ibratechh. Target: Level 100 Accounting at ATU (Ghana), built to expand to any programme, level or department.

---

## 1. Requirements analysis (what the brief actually demands)

| Concern | Decision |
|---|---|
| Students have **no passwords** | Students are identified by Student ID only. This is a *weak* identifier (IDs are guessable and semi-public). The design assumes this and limits damage: students can only reach data through narrow RPCs that return minimal fields, never through table access. |
| Staff need real auth | Supabase Auth (email + password, optionally MFA) for Super Admin, Admin, Lecturer, Course Rep. |
| Attendance must be tamper-resistant | All writes go through one atomic `SECURITY DEFINER` function using database time. Students have **zero** direct table privileges. |
| Expandable | Programmes, levels, class groups, academic periods and courses are all lookup tables, never hardcoded. Level 100 Accounting is just seed data. |
| No framework, Vercel hosting | Static HTML/CSS/vanilla JS with ES modules. No build step is required. Supabase JS loaded as an ES module. |

### Key principle

> The browser is untrusted. The anon key is public by design, so security lives entirely in Postgres: RLS for staff, RPC functions for students.

---

## 2. Application structure

```
atu-attendance/
├── index.html                 Student landing (Create Account / Mark Attendance / My Attendance)
├── register.html              Student registration
├── attend.html                Attendance link target (?s=<session_token>)
├── my-attendance.html         Student personal dashboard
├── admin/
│   ├── login.html
│   ├── index.html             Dashboard overview
│   ├── students.html          Student management + search + analytics
│   ├── courses.html           Courses, assignments, enrolments
│   ├── sessions.html          Create/manage sessions, QR, live monitor
│   ├── records.html           History, filters, exports
│   └── staff.html             Staff and roles (Super Admin only)
├── css/
│   ├── tokens.css             Colour, type, spacing variables
│   ├── base.css
│   └── components.css
├── js/
│   ├── config.js              Reads public URL + anon key (injected at deploy)
│   ├── supabase.js            Client singleton
│   ├── api/                   students.js, attendance.js, courses.js, reports.js
│   ├── ui/                    toast.js, modal.js, table.js, footer.js
│   ├── lib/                   validators.js, device.js, format.js, export-*.js
│   └── pages/                 one module per page
├── assets/developer.jpg       Developer photo (provided)
├── supabase/
│   ├── migrations/            001 to 004 (schema, functions, RLS, seed)
│   └── functions/             Edge Functions (see §6)
├── vercel.json                Security headers (CSP, frame-ancestors, etc.)
├── .env.example
└── README.md
```

Because there is no bundler, the public URL and anon key live in `js/config.js`, generated at deploy time from Vercel environment variables by a tiny `scripts/build-config.js` (the build command on Vercel). The **service-role key is never used in the frontend**; it exists only as an Edge Function secret.

---

## 3. Database relationship design

```
programmes ─┐
academic_levels ─┼──< class_groups
            │
students ───┴── (programme_id, level_id, class_group_id)
   │
   ├──< course_enrollments >── courses ──< course_assignments >── profiles (staff)
   │                              │
   │                              └── academic_periods
   │
   └──< attendance_records >── attendance_sessions >── courses
              │                        │
              └── attendance_devices ──┘
attendance_overrides ──> attendance_records / sessions
audit_logs  (append-only, every privileged action)
profiles ──1:1── auth.users ;  user_roles ──> profiles
```

### Tables (19)

The brief's 15 tables plus four I judged necessary:

| Table | Purpose |
|---|---|
| `profiles` | Staff display info, 1:1 with `auth.users` |
| `user_roles` | Role per staff member (`super_admin`, `admin`, `lecturer`, `course_rep`) |
| `students` | Central register. Unique normalised `student_id`, unique internal `id` (uuid), `whatsapp_number` (E.164), status |
| `programmes`, `academic_levels`, `class_groups` | Lookups; class group belongs to programme + level |
| `academic_periods` | Semesters / academic years, one flagged current |
| `courses` | Code, name, programme/level/group/period, archived flag |
| `course_assignments` | Which staff (lecturer / rep) manage which course |
| `course_enrollments` | Which students are expected at a course, **with `enrolled_at`** |
| `attendance_sessions` | One class meeting: public token, opens/closes times, status |
| `attendance_records` | One row per student per session, `UNIQUE(session_id, student_id)` |
| `attendance_devices` | Hashed device token → first student, per session, `UNIQUE(session_id, device_hash)` |
| `attendance_overrides` | Admin corrections and device overrides, with mandatory reason |
| `audit_logs` | Append-only trail |
| **`rate_limits`** *(added)* | DB-side throttling of student-ID lookups, logins and submissions |
| **`student_access_tokens`** *(added)* | Short-lived hashed tokens for the student dashboard (see §5.3) |
| **`session_roster`** *(added)* | Snapshot of the students expected at a session when it starts |
| **`app_settings`** *(added)* | Admin contact number, rate-limit thresholds, auto-enrol switch |

### Why `session_roster`

The brief says that if a student joins a course late, earlier sessions must not count against them. Rather than recompute from `enrolled_at` forever (fragile if someone un-enrols and re-enrols), each session snapshots its expected students when it is **opened**. Analytics then count `session_roster` rows for that student. A late joiner is simply absent from earlier rosters. Attendance by someone *not* on the roster (for example an unenrolled student who legitimately attended) is rejected by default; admins can enrol the student and add them via override. *Update: the roster also grows while a session is open: a trigger adds anyone newly enrolled or registered, so totals add up; closed sessions never change.*

### Analytics definition

- **Eligible** = sessions whose roster contains the student and that are `closed` or `expired` (a still-open session is not yet a "miss").
- **Attended** = eligible sessions with an `attendance_records` row whose status is `present` or `late`. `excused` is **removed from the denominator** (shown separately) so an excused absence does not hurt the rate. This is a configurable policy flagged in the README.
- **Rate** = attended / eligible, one decimal place. Zero eligible → "No attendance history yet".

---

## 4. Student registration flow

1. Student opens `register.html`, fills Full Name, Student ID, WhatsApp, Programme, Level, Class/Group (dropdowns from lookup tables via a narrow public RPC).
2. Client-side validation (UX only): required fields, ID format, Ghana phone.
3. Client calls `rpc('register_student', {...})`.
4. **Server** (authoritative):
   - Normalise ID: `upper(regexp_replace(trim(id), '\s+', '', 'g'))`.
   - Normalise phone to E.164 (`0544823484` → `+233544823484`; accepts `+233…`, `233…`, `0…`; validates network prefix length).
   - Validate that programme, level and group exist and are consistent with each other.
   - Rate-limit by caller fingerprint.
   - `INSERT` guarded by the unique constraint (race-safe). A conflict returns a friendly `STUDENT_ID_EXISTS`, never a raw error.
   - Status is set to `active` automatically, per the brief.
   - Audit-log the event (`student.self_register`).
5. Success message plus the admin-contact recovery notice (`0544823484`) is shown on register and portal pages. The number is stored in `app_settings` so it can change without redeploying.

**Auto-enrolment:** when a student registers, the function enrols them in non-archived courses matching their programme, level and group (a course with no group applies to all groups). Because each session snapshots its roster when opened, joining later never counts earlier sessions against the student. Controlled by the `auto_enroll` setting.

**Admin-assisted registration** uses the same table through `admin_create_student(...)` and `admin_update_student(...)`, which require a reason and write an audit entry. There is no second database.

---

## 5. Attendance workflow

### 5.1 Session lifecycle

`scheduled → open → closed` (and `expired` is derived, then materialised).

- Creating a session sets `duration_minutes` and a **unique, unguessable `public_token`** (≥128 bits). The attendance URL is `/attend.html?s=<token>`; the QR encodes the same URL.
- `open_session()` sets `opens_at = now()`, `closes_at = now() + duration`, snapshots the roster, and audit-logs.
- **Is it open?** is decided in SQL as `status='open' AND now() < closes_at`. The countdown in the browser is cosmetic; it is initialised from a server-supplied `seconds_remaining`.
- Expiry needs no cron: the check is evaluated at every submission. A `pg_cron` job (optional) tidies `status` to `expired` for reporting; correctness never depends on it.
- Manual close and reopen are staff RPCs. Reopen requires a reason and audit-logs.

### 5.2 Student submits attendance (two steps, both server-validated)

**Step A: `lookup_student_for_session(token, student_id)`**
Returns the student's **registered full name** only if the session is open, the student exists, is active and is on the session roster. The student confirms the name on screen. Throttled per client.

**Step B: `submit_attendance(token, student_id, device_token, code)`**
Re-validates everything from scratch (nothing from Step A is trusted) in one transaction:
1. Lock the session row (serialises concurrent submissions for that session); verify it is open by DB time.
2. Verify the optional attendance code.
3. Verify the student exists, is active and is on the roster.
4. Reject if this student already has a record (`ALREADY_MARKED`).
5. Device check: if this device's hash is already bound to a *different* student in this session, reject (`DEVICE_USED`).
6. Insert the device binding and the `attendance_records` row with `submitted_at = now()`. `UNIQUE(session_id, student_id)` and `UNIQUE(session_id, device_hash)` are the final backstop.

The student never sends a name, and a typed name is never trusted. Business errors come back as `{ok:false, code, message}` (not exceptions) so rate-limit counters still persist when an attempt fails. Codes: `SESSION_EXPIRED`, `SESSION_CLOSED`, `NOT_REGISTERED`, `INACTIVE`, `NOT_ENROLLED`, `ALREADY_MARKED`, `DEVICE_USED`, `BAD_CODE`, `BAD_DEVICE`, `RATE_LIMITED`.

The optional **attendance code** (shown or spoken in class) is the strongest anti-proxy control in the design, because a forwarded link alone is not enough.

**Device override:** there is no separate "unlock" switch. An administrator resolves a legitimate device conflict by marking the student present through `admin_override_attendance`, which requires a written reason and is written to `attendance_overrides` and `audit_logs`.

### 5.3 Student dashboard without passwords

The brief requires students to see only their own history. A bare student ID cannot protect that, so:

- **Access requires the student ID plus the last 4 digits of the WhatsApp number they registered with.** That is a lightweight second factor from a value an attacker doesn't automatically have. It is still not strong authentication.
- On success, `student_login()` returns a random **access token** (stored hashed, 30-minute expiry, revocable). The token is kept in `sessionStorage` (cleared when the tab closes) and sent to `student_dashboard(token)`.
- "End session" calls `student_logout(token)`, which revokes it server-side and clears storage.
- Failed attempts are throttled per student ID **and** per client.
- Nothing is exposed through predictable URLs; the dashboard has no ID in its URL.

### 5.4 Live monitoring

Staff subscribe to Supabase Realtime on `attendance_records` filtered by `session_id`. RLS applies to Realtime, so only authorised staff receive events. Student names are joined client-side via a staff-only view.

---

## 6. Security approach

### 6.1 Threat model and mitigations

| Risk | Mitigation |
|---|---|
| Anyone reads the student table | RLS on, **no policies for `anon`**, and `REVOKE ALL` on tables from `anon`. Students use RPCs only. |
| WhatsApp numbers leaked | Never returned by any student-facing RPC except to the owner after `student_login`. Staff access is role-checked. |
| Student ID enumeration / name harvesting | Lookup requires a valid open session token, only returns data for rostered active students, and is rate-limited per client and per session. |
| Fake attendance via typed names | Name is always read from the database. |
| Duplicate attendance (race) | `UNIQUE(session_id, student_id)` plus row-lock in the function. |
| Proxy attendance (shared device) | Device-token deterrent (see §8), optional live attendance code, roster check. |
| Expired session accepted | Time decided by `now()` in Postgres. |
| Self-granting admin | `user_roles` writable only by `super_admin` via RPC. Staff sign-up is by invite only, and public Auth sign-ups are disabled. |
| First Super Admin | Bootstrap script (see §6.3). |
| Privilege escalation via `SECURITY DEFINER` | Every definer function sets `search_path = ''`, uses fully qualified names, and checks role inside. |
| Service-role key leak | Only in Edge Function secrets. Never in repo or frontend. |
| XSS | Strict CSP in `vercel.json`, all dynamic text inserted with `textContent`, never `innerHTML`. |
| CSV/Excel formula injection in exports | Cells starting with `= + - @` are prefixed with `'`. |
| Audit tampering | `audit_logs` is insert-only (no UPDATE/DELETE policy; trigger blocks both). |
| Brute force | `rate_limits` table with windowed counters. Supabase Auth's own limits for staff. |

### 6.2 Roles and permissions

| Capability | Super Admin | Admin | Lecturer | Course Rep |
|---|:-:|:-:|:-:|:-:|
| Manage staff and roles | ✔ | | | |
| Manage students / recovery | ✔ | ✔ | | |
| View WhatsApp numbers | ✔ | ✔ | ✘ | ✘ |
| Manage courses and enrolments | ✔ | ✔ | | |
| Create/run sessions | ✔ | ✔ | assigned | assigned (if `can_create_sessions`) |
| View attendance and analytics | ✔ | ✔ | assigned | assigned |
| Override / reopen / correct | ✔ | ✔ | | |
| Export | ✔ | ✔ | assigned | assigned |
| Read audit log | ✔ | ✔ | | |

Course-rep session creation is gated by a flag on `course_assignments` ("subject to administrator permissions", per the brief).

### 6.3 Creating the first Super Administrator securely

1. In Supabase dashboard → Authentication → **disable public sign-ups**.
2. Create your own user **manually** in Authentication → Users (strong password, enable MFA afterwards).
3. In the SQL editor, run once: `select public.bootstrap_super_admin('<your-auth-user-uuid>');`
4. The function **refuses to run if a Super Admin already exists**, so it cannot be replayed to seize control. It is revoked from `anon` and `authenticated`, so it can only run from the SQL editor (postgres role).
5. Further staff are added by the Super Admin via invite; roles are assigned only through `admin_set_role()`.

No default passwords exist anywhere in the repo.

### 6.4 Edge Functions vs database functions

Almost everything is a database function, which gives atomicity and keeps latency low. Edge Functions are used for what the database cannot do safely on its own:

- `invite-staff`: creates the Auth user using the service-role key (server-side only), then assigns the role.
- Exports are generated client-side from role-checked queries, so no export function is needed.

---

## 7. Rate limiting

A `rate_limits(bucket, key, window_start, hits)` table with `check_rate_limit(bucket, key, max, window)` called inside the student-facing RPCs. The `key` combines the client IP (read from `request.headers` → `x-forwarded-for`) with the target (student ID or session). Typical limits: 10 ID lookups per 5 min per client, 5 login attempts per 15 min per student ID, 5 registrations per hour per client. Limits are tunable in `app_settings`.

Honest caveat: IPs on campus Wi-Fi are shared (NAT), so limits are deliberately generous for lookups. Per-session limits protect against one shared IP being locked out by a single abuser.

---

## 8. Honest limitations (also stated in the README)

1. **A student ID is not a secret.** Anyone who knows a classmate's ID can attempt to mark them present. Mitigations, not guarantees: device restriction, the optional live attendance code, roster check, short session windows, audit trail, and admin override tools.
2. **Device restriction is a deterrent, not device identification.** It relies on a random token in browser storage. Students can bypass it by clearing storage, switching browsers, using private mode, or using another phone. We store only a SHA-256 hash of the token. We do **not** fingerprint hardware.
3. **The dashboard second factor (last 4 WhatsApp digits)** is weak. It stops casual snooping, not a determined classmate who knows the number.
4. **IP-based rate limits** can misfire on shared campus networks.
5. **The system cannot prove physical presence.** The live attendance code and keeping the window short are the best practical controls without GPS or biometrics, which are outside the first version.
6. If stronger identity is required later, the clean upgrade path is a per-student PIN set at registration, or an SMS/WhatsApp OTP. The schema reserves `students.pin_hash` (nullable, unused in v1) so this needs no migration pain.

---

## 9. Build plan (unchanged from the brief)

| Phase | Output |
|---|---|
| 1 | This document |
| 2 | `001_schema.sql`, `002_functions.sql`, `003_rls.sql`, `004_seed.sql`, `invite-staff` Edge Function, SQL test script |
| 3 | Registration UI + admin-assisted registration |
| 4 | Admin dashboard, students, courses, roles, search |
| 5 | Sessions, QR, countdown, attend pop-up, devices, realtime |
| 6 | Analytics and PDF/XLSX/DOCX exports |
| 7 | Testing, Vercel + Supabase deployment docs, README |

## 10. Decisions that need your confirmation

1. **Excused absences leave the denominator** (default). Alternative: count them as absent. Say if you want it changed.
2. **Dashboard access = Student ID + last 4 digits of WhatsApp.** The brief says "identify with student ID" only; I added the second factor because a bare ID would expose full attendance histories to anyone. Tell me if you would rather keep ID-only (not recommended).
3. **Late rule:** a session can optionally set `late_after_minutes`; submissions after that point are recorded as `late` (and count as attended). Off by default.
4. **Auto-enrolment on registration** into matching courses: on by default.


---
**Update 2026-11-22:** `class_groups` is presented as **Classes** (a programme has many classes, each with a level; students pick programme then class; courses belong to a class). `student_login(student_id)` now needs only the Student ID. Starter data: programme *Accounting and Finance Analytics*, class *BTech Accounting and Finance Analytics Lvl 100*.
