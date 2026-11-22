-- ============================================================================
-- Atendar | Migration 004: starter configuration
-- Powered by Ibratechh
--
-- Lookup data and settings ONLY. No fake students, courses or attendance.
-- Edit/extend all of this later from the admin dashboard.
-- ============================================================================

insert into public.app_settings (key, value) values
  ('admin_contact',   '0544823484'),   -- shown in the recovery notice
  ('auto_enroll',     'true'),         -- enrol new students in matching courses
  -- Throttles are PER CLIENT IP. Many students share one campus Wi-Fi IP, so
  -- these are generous: they stop scripted guessing, not a lecture hall.
  ('rl_register_max',     '300'),   -- registrations per IP per hour
  ('rl_lookup_max',       '400'),   -- Student ID lookups per IP per 5 min
  ('rl_submit_max',       '400'),   -- attendance submissions per IP per 5 min
  ('rl_session_info_max', '800'),   -- attendance-page loads per IP per 5 min
  ('rl_login_max',        '300')    -- student-dashboard sign-ins per IP per 15 min
on conflict (key) do nothing;

insert into public.programmes (code, name, department) values
  ('AFA', 'Accounting and Finance Analytics', 'Accounting and Finance')
on conflict (code) do nothing;

insert into public.academic_levels (level_number, name) values
  (100, 'Level 100'), (200, 'Level 200'), (300, 'Level 300'), (400, 'Level 400')
on conflict (level_number) do nothing;

-- First class, so registration works on day one. Add more programmes and classes
-- (BTech / HND / Diploma, Level 100-400) in Admin -> Setup.
insert into public.class_groups (programme_id, level_id, name)
select p.id, l.id, 'BTech Accounting and Finance Analytics Lvl 100'
from public.programmes p, public.academic_levels l
where p.code = 'AFA' and l.level_number = 100
on conflict do nothing;
