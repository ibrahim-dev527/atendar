# Atendar: Classroom Attendance Platform

Powered by [Ibratechh](https://ibratechh.com) · Support: 0544823484

Plain HTML/CSS/JS frontend + Supabase (Postgres, Auth, Realtime, RLS, RPCs). No frameworks, no build tools beyond a tiny Node script for Vercel.

## 1. Supabase (about 10 minutes)

1. Create a project at supabase.com.
2. **Authentication → Providers → Email**: turn **OFF "Allow new users to sign up"**.
3. **SQL Editor**: paste all of `supabase/setup.sql` and run it once (fresh project only).
4. **Authentication → Users → Add user**: create your own staff login (strong password).
5. Copy that user's UUID and run once in the SQL Editor:
   ```sql
   select public.bootstrap_super_admin('PASTE-YOUR-USER-UUID');
   ```
   It refuses to run again once a Super Admin exists.
6. **Project Settings → API**: copy the Project URL and the **anon / publishable** key. Never use the `service_role` key in the frontend.

## 2. Configure the site

`js/config.js` is already filled with your project URL and **publishable** key (safe for browsers). To change them, edit that file, or on Vercel set environment variables `SUPABASE_URL` and `SUPABASE_ANON_KEY` (see `.env.example`). The build refuses a service-role/secret key.

Local preview: `npm start` → http://localhost:3000

## 3. Deploy to Vercel

Import the folder/repo. `vercel.json` already sets the build command (`node scripts/build.js`), output (`dist`) and security headers. Add the two env vars, deploy.
Then in Supabase **Authentication → URL Configuration** set the Site URL to your Vercel URL.

## 4. First use

1. Sign in at `/admin/login.html`.
2. **Students → Add student** lets you register students yourself (no WhatsApp OTP needed); they are enrolled in matching courses automatically.
3. **Setup**: rename the placeholder "Group A" / add your real programmes, levels, class groups, periods.
3. **Courses**: add courses; **Enrolments**: they auto-fill from matching registrations (or enrol manually).
4. Share `/register.html` with students. Students register themselves.
5. **Sessions → New session → Start**. Share the link / show the QR. **Students can register at any time, even while a session is running: they join that session's class list automatically, so totals always add up. Sessions that have already closed are never changed.

Optional: invite more staff from the dashboard by deploying the Edge Function:
`supabase functions deploy invite-staff` (uses the service-role key **server-side only**, provided automatically by Supabase).

## Honest limitations

- **A Student ID is not a secret.** Classmates who know it could try to mark someone present. Controls: roster check, device deterrent, optional attendance code, short windows, audit trail, admin overrides. **This system reduces proxy attendance; it cannot eliminate it.**
- The one-device-per-session check is a **deterrent**: clearing browser data, another browser or a different phone bypasses it.
- Student dashboard sign-in (ID + last 4 WhatsApp digits) is weak by design: it stops casual snooping only.
- Rate limits are per IP; campus Wi-Fi shares IPs, so limits are generous (tunable in `app_settings`).
- Student ID format: 6-10 digits plus an optional letter (e.g. 01244542B). If some IDs differ, the pattern is in `001_schema.sql`/`002_functions.sql` and `js/validators.js`.
- Excused sessions are excluded from the attendance-rate denominator.

## Tested / not tested

Tested: database layer (116 assertions incl. concurrency, on plain Postgres 16); student register → check-in → dashboard and all admin pages loading in Chrome against a local Postgres through a small shim.
**Not tested on a real Supabase project:** admin table queries with nested data via PostgREST, RLS through the API, Realtime live monitor, PDF/XLSX/DOCX downloads in a browser, the `invite-staff` function, QR scanning on phones. Do a quick pass of these before the first real class.

## Tests

`supabase/tests/001_full_test.sql` is for a throwaway Postgres only (never your live project).
