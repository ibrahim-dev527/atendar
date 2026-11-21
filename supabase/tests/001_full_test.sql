-- ============================================================================
-- Atendar | database test suite (run against a THROWAWAY database only)
-- Needs migrations 001-004 applied. Prints PASS lines; any failure aborts.
-- Locally it was run on plain Postgres 16 with stub roles/auth (see README).
-- ============================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;
drop schema if exists t cascade;
create schema t;
grant usage on schema t to public;
create table t.ctx (k text primary key, v text);
grant all on t.ctx to public;
create function t.ok(c boolean, m text) returns void language plpgsql as $$
begin if c is not true then raise exception 'FAIL: %', m; end if; raise notice 'PASS: %', m; end $$;
create function t.root() returns void language plpgsql as $$ begin execute 'reset role'; perform set_config('request.jwt.claim.sub','',false); end $$;
create function t.anon(h text default '1.1.1.1') returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claim.sub','',false);
  perform set_config('request.headers', json_build_object('x-forwarded-for', h)::text, false); execute 'set role anon'; end $$;
create function t.staff(u uuid) returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claim.sub', u::text, false); execute 'set role authenticated'; end $$;
create function t.get(k text) returns text language sql as $$ select v from t.ctx where k = $1 $$;
grant execute on all functions in schema t to public;

-- ---------------------------------------------------------------- bootstrap
do $$
declare su uuid; ad uuid; lec uuid; rep uuid; lec2 uuid; r jsonb;
begin
  perform t.root();
  insert into auth.users (email) values ('super@x.test') returning id into su;
  insert into auth.users (email) values ('admin@x.test') returning id into ad;
  insert into auth.users (email) values ('lec@x.test') returning id into lec;
  insert into auth.users (email) values ('rep@x.test') returning id into rep;
  insert into auth.users (email) values ('lec2@x.test') returning id into lec2;
  insert into t.ctx values ('su',su::text),('ad',ad::text),('lec',lec::text),('rep',rep::text),('lec2',lec2::text);
  perform t.ok((select count(*) from public.user_roles) = 0, 'new auth users get NO role automatically');
  perform public.bootstrap_super_admin(su);
  perform t.ok((select role from public.user_roles where user_id = su) = 'super_admin', 'bootstrap creates super admin');
  begin perform public.bootstrap_super_admin(ad); perform t.ok(false, 'second bootstrap must fail');
  exception when others then perform t.ok(sqlerrm like '%already exists%', 'second bootstrap is refused'); end;

  perform t.anon();
  begin perform public.bootstrap_super_admin(ad); perform t.ok(false, 'anon must not run bootstrap');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot execute bootstrap_super_admin'); end;

  perform t.staff(ad);
  r := public.admin_set_role(ad, 'super_admin', 'trying to self-promote');
  perform t.ok(r->>'code' = 'FORBIDDEN', 'non-super cannot assign roles (self-promotion blocked)');
  begin insert into public.user_roles (user_id, role) values (ad, 'super_admin'); perform t.ok(false, 'direct role insert must fail');
  exception when insufficient_privilege then perform t.ok(true, 'authenticated cannot write user_roles directly'); end;

  perform t.staff(su);
  perform t.ok((public.admin_set_role(ad,  'admin',      'Class admin'))->>'ok' = 'true', 'super assigns admin');
  perform t.ok((public.admin_set_role(lec, 'lecturer',   'Teaches ACC101'))->>'ok' = 'true', 'super assigns lecturer');
  perform t.ok((public.admin_set_role(rep, 'course_rep', 'Class rep'))->>'ok' = 'true', 'super assigns course rep');
  perform t.ok((public.admin_set_role(lec2,'lecturer',   'Teaches ACC102'))->>'ok' = 'true', 'super assigns 2nd lecturer');
  r := public.admin_set_role(su, 'admin', 'demote self');
  perform t.ok(r->>'code' = 'LAST_SUPER_ADMIN', 'last super admin cannot be demoted');
  r := public.admin_set_role(lec, 'admin', '');
  perform t.ok(r->>'code' = 'REASON_REQUIRED', 'role change requires a reason');
  perform t.root();
  update public.app_settings set value='100000' where key like 'rl_%';
end $$;

-- ------------------------------------------------------------------ courses
do $$
declare ad uuid := t.get('ad')::uuid; lec uuid := t.get('lec')::uuid; rep uuid := t.get('rep')::uuid; lec2 uuid := t.get('lec2')::uuid;
        p uuid; l uuid; g uuid; c1 uuid; c2 uuid;
begin
  perform t.staff(ad);
  select id into p from public.programmes where code='ACC';
  select id into l from public.academic_levels where level_number=100;
  select id into g from public.class_groups where name='Group A';
  insert into public.courses (code,name,programme_id,level_id,class_group_id) values ('ACC101','Financial Accounting I',p,l,g) returning id into c1;
  insert into public.courses (code,name,programme_id,level_id,class_group_id) values ('ACC102','Business Math',p,l,g) returning id into c2;
  insert into public.course_assignments (course_id,user_id,assignment_role) values (c1,lec,'lecturer'),(c1,rep,'course_rep'),(c2,lec2,'lecturer');
  insert into t.ctx values ('p',p::text),('l',l::text),('g',g::text),('c1',c1::text),('c2',c2::text);
  perform t.ok((select count(*) from public.audit_logs where action like 'courses.%') = 2, 'direct course creation is audit-logged');
  perform t.staff(lec);
  begin insert into public.courses (code,name,programme_id,level_id) values ('HACK1','x',p,l); perform t.ok(false,'lecturer must not create courses');
  exception when others then perform t.ok(true, 'lecturer cannot create courses (RLS)'); end;
end $$;

-- ------------------------------------------------------------ registration
do $$
declare p uuid := t.get('p')::uuid; l uuid := t.get('l')::uuid; g uuid := t.get('g')::uuid; r jsonb; n int;
        l2 uuid := (select id from public.academic_levels where level_number=200);
begin
  perform t.anon();
  perform t.ok((public.get_public_config())->>'admin_contact' = '0544823484', 'public config exposes admin contact');
  r := public.register_student('Ama Mensah',' 0124 1001 a ','0244123456',p,l,g);
  perform t.ok(r->>'ok'='true' and r->>'student_id'='01241001A', 'registers + normalises ID " ac 1001 " -> 01241001A');
  r := public.register_student('Duplicate Person','01241001A','0244999999',p,l,g);
  perform t.ok(r->>'code'='STUDENT_ID_EXISTS', 'duplicate Student ID rejected');
  r := public.register_student('Duplicate Person','01241001a','0244999999',p,l,g);
  perform t.ok(r->>'code'='STUDENT_ID_EXISTS', 'duplicate detected case-insensitively');
  r := public.register_student('Kofi Boateng','01241002A','+233 54 482 3484',p,l,g);
  perform t.ok(r->>'ok'='true', 'accepts +233 formatted phone');
  perform public.register_student('Yaa Asare','01241003A','233201234567',p,l,g);
  perform public.register_student('Kwame Owusu','01241004A','0501234567',p,l,g);
  r := public.register_student('Bad Phone','01241005A','12345',p,l,g);
  perform t.ok(r->>'code'='INVALID_PHONE', 'invalid phone rejected');
  r := public.register_student('Bad Phone','01241005A','0944123456',p,l,g);
  perform t.ok(r->>'code'='INVALID_PHONE', 'non-Ghana prefix (09x) rejected');
  r := public.register_student('X','01241006A','0244123456',p,l,g);
  perform t.ok(r->>'code'='INVALID_NAME', 'one-letter name rejected');
  r := public.register_student('Mismatch','01241007A','0244123456',p,l2,g);
  perform t.ok(r->>'code'='INVALID_PLACEMENT', 'programme/level/group mismatch rejected');
  perform t.root();
  perform t.ok((select whatsapp_number from public.students where student_id='01241002A') = '+233544823484', 'WhatsApp stored as E.164');
  perform t.ok((select count(*) from public.course_enrollments e join public.students s on s.id=e.student_id where s.student_id='01241001A') = 2, 'auto-enrolled into 2 matching courses');
  insert into t.ctx select 'S'||substr(student_id,8,1), id::text from public.students;
  -- anonymous browser access
  perform t.anon();
  begin perform count(*) from public.students; perform t.ok(false,'anon SELECT on students must fail');
  exception when insufficient_privilege then perform t.ok(true,'anon cannot read students table'); end;
  begin perform count(*) from public.attendance_records; perform t.ok(false,'anon SELECT on records must fail');
  exception when insufficient_privilege then perform t.ok(true,'anon cannot read attendance_records'); end;
  begin insert into public.attendance_records (session_id,student_id) values (gen_random_uuid(),gen_random_uuid()); perform t.ok(false,'anon insert must fail');
  exception when insufficient_privilege then perform t.ok(true,'anon cannot write attendance_records directly'); end;
  begin perform public.admin_list_students(); perform t.ok(false,'anon admin RPC must fail');
  exception when insufficient_privilege then perform t.ok(true,'anon cannot execute admin RPCs'); end;
  begin perform public._create_student('a','b','c',p,l,g,'self',null); perform t.ok(false,'internal fn must fail');
  exception when insufficient_privilege then perform t.ok(true,'anon cannot execute internal helpers'); end;
end $$;

-- ------------------------------------------------- admin-assisted + recovery
do $$
declare ad uuid := t.get('ad')::uuid; p uuid := t.get('p')::uuid; l uuid := t.get('l')::uuid; g uuid := t.get('g')::uuid; r jsonb; sid uuid;
begin
  perform t.staff(ad);
  r := public.admin_create_student('Esi Quartey','01241005A','0261234567',p,l,g,'');
  perform t.ok(r->>'code'='REASON_REQUIRED', 'manual add needs a reason');
  r := public.admin_create_student('Esi Quartey','01241005A','0261234567',p,l,g,'Student could not register');
  perform t.ok(r->>'ok'='true', 'admin manually adds student (same central table)');
  r := public.admin_create_student('Esi Again','01241005a','0261234567',p,l,g,'dup test');
  perform t.ok(r->>'code'='STUDENT_ID_EXISTS', 'admin cannot create duplicate Student ID');
  sid := (r->>'id')::uuid;
  perform t.ok((select registration_source from public.students where student_id='01241005A')='admin', 'manual student marked source=admin');
  r := public.admin_update_student(t.get('S4')::uuid, '{"status":"inactive"}', 'Suspended for testing');
  perform t.ok(r->>'ok'='true', 'admin deactivates a student');
  r := public.admin_update_student(t.get('S3')::uuid, '{"student_id":"01241001A"}', 'collision test');
  perform t.ok(r->>'code'='STUDENT_ID_EXISTS', 'editing to an existing ID is refused');
  r := public.admin_update_student(t.get('S3')::uuid, '{"whatsapp_number":"0244000000"}', 'Corrected number');
  perform t.ok(r->>'ok'='true', 'admin corrects WhatsApp number');
  r := public.admin_update_student(t.get('S3')::uuid, '{"whatsapp_number":"0201234567"}', 'Restore number');
  perform t.ok((select count(*) from public.audit_logs where action='student.update' and reason is not null) = 3, 'every student change is audit-logged with reason');
  perform t.ok((select details->'before'->>'status' from public.audit_logs where reason='Suspended for testing') = 'active', 'audit stores before/after values');
  r := public.admin_list_students('0261234');
  perform t.ok((r->>'total')::int = 1, 'admin search by WhatsApp number works');
  r := public.admin_list_students('ama');
  perform t.ok((r->>'total')::int = 1, 'admin search by name works');
  r := public.admin_list_students('0124100');
  perform t.ok((r->>'total')::int >= 4, 'admin search by Student ID works');
  r := public.admin_list_students(null,null,null,null,'inactive');
  perform t.ok((r->>'total')::int = 1, 'status filter works');
  perform t.root();
  insert into t.ctx select 'S5', id::text from public.students where student_id='01241005A';
  begin delete from public.audit_logs; perform t.ok(false,'audit delete must fail');
  exception when others then perform t.ok(sqlerrm like '%append-only%', 'audit_logs cannot be deleted'); end;
  begin update public.audit_logs set reason='x'; perform t.ok(false,'audit update must fail');
  exception when others then perform t.ok(sqlerrm like '%append-only%', 'audit_logs cannot be edited'); end;
end $$;

-- ------------------------------------------------------------ session rules
do $$
declare lec uuid := t.get('lec')::uuid; rep uuid := t.get('rep')::uuid; lec2 uuid := t.get('lec2')::uuid; c1 uuid := t.get('c1')::uuid; r jsonb; sid uuid; tok text;
begin
  perform t.staff(lec2);
  r := public.create_session(c1,'Wrong course',current_date,null,10);
  perform t.ok(r->>'code'='FORBIDDEN', 'lecturer cannot create sessions for a course not assigned to them');
  perform t.staff(rep);
  r := public.create_session(c1,'Week 1',current_date,'09:00',10,'ABC123');
  perform t.ok(r->>'ok'='true', 'course rep creates session for assigned course');
  sid := (r->>'id')::uuid; tok := r->>'public_token';
  perform t.ok(length(tok) = 48, 'session link token is 192-bit random');
  perform t.anon();
  r := public.lookup_student_for_session(tok,'01241001A');
  perform t.ok(r->>'code'='SESSION_EXPIRED', 'unstarted session rejects attendance');
  perform t.staff(rep);
  r := public.open_session(sid);
  perform t.ok(r->>'ok'='true' and (r->>'roster_size')::int = 4, 'opening snapshots roster (4 active enrolled students)');
  insert into t.ctx values ('sess1', sid::text), ('tok1', tok);
end $$;

-- --------------------------------------------------------------- attendance
do $$
declare tok text := t.get('tok1'); sid uuid := t.get('sess1')::uuid; r jsonb; dA text := repeat('a',40); dB text := repeat('b',40);
        p uuid := t.get('p')::uuid; l uuid := t.get('l')::uuid; g uuid := t.get('g')::uuid;
begin
  perform t.anon();
  r := public.get_session_public(tok);
  perform t.ok(r->>'status'='open' and (r->>'seconds_remaining')::int between 595 and 600 and (r->>'requires_code')::boolean, 'public session info: open, ~10min left, code required, no student data');
  perform t.ok(not (r ? 'full_name'), 'public session info leaks no student data');
  r := public.lookup_student_for_session(tok,'01241001A');
  perform t.ok(r->>'ok'='true' and r->>'full_name'='Ama Mensah', 'lookup returns the REGISTERED name from the database');
  r := public.lookup_student_for_session(tok,'  0124 1001a');
  perform t.ok(r->>'ok'='true', 'lookup normalises typed ID');
  r := public.lookup_student_for_session(tok,'ZZ9999');
  perform t.ok(r->>'code'='NOT_REGISTERED', 'unregistered ID rejected');
  r := public.lookup_student_for_session(tok,'01241004A');
  perform t.ok(r->>'code'='NOT_ENROLLED' or r->>'code'='INACTIVE', 'inactive student cannot proceed');
  r := public.submit_attendance(tok,'01241004A',dB,'ABC123');
  perform t.ok(r->>'code'='INACTIVE' or r->>'code'='NOT_ENROLLED', 'inactive student cannot submit');
  r := public.submit_attendance(tok,'01241001A',dA,'WRONG');
  perform t.ok(r->>'code'='BAD_CODE', 'wrong attendance code rejected');
  r := public.submit_attendance(tok,'01241001A','short');
  perform t.ok(r->>'code'='BAD_DEVICE', 'missing/short device token rejected');
  r := public.submit_attendance(tok,'01241001A',dA,'abc123');
  perform t.ok(r->>'ok'='true' and r->>'full_name'='Ama Mensah', 'registered student marks attendance (code is case-insensitive)');
  r := public.submit_attendance(tok,'01241001A',dA,'ABC123');
  perform t.ok(r->>'code'='ALREADY_MARKED', 'duplicate attendance rejected');
  r := public.submit_attendance(tok,'01241001A',dB,'ABC123');
  perform t.ok(r->>'code'='ALREADY_MARKED', 'duplicate rejected even from another device');
  r := public.submit_attendance(tok,'01241002A',dA,'ABC123');
  perform t.ok(r->>'code'='DEVICE_USED', 'same device cannot mark a DIFFERENT student');
  r := public.submit_attendance(tok,'01241002A',dB,'ABC123');
  perform t.ok(r->>'ok'='true', 'other student on own device succeeds');
  -- late joiner: registers AFTER session opened
  r := public.register_student('Late Joiner','01241008A','0244555666',p,l,g);
  r := public.submit_attendance(tok,'01241008A',repeat('c',40),'ABC123');
  perform t.ok(r->>'ok'='true', 'student who registered after the session opened CAN still mark attendance');
  perform t.root();
  perform t.ok((select count(*) from public.session_roster where session_id=sid) = 5, 'roster grew to include the late registrant (4 -> 5)');
  perform t.ok((select count(*) from public.attendance_records where session_id=sid) = 3, 'exactly 3 records stored');
  perform t.ok((select submitted_at from public.attendance_records limit 1) between now() - interval '1 minute' and now(), 'timestamp comes from database clock');
  perform t.ok((select device_hash from public.attendance_devices limit 1) <> dA, 'only a HASH of the device token is stored');
  insert into t.ctx select 'S8', id::text from public.students where student_id='01241008A';

  -- close / expire / reopen
  perform t.staff(t.get('rep')::uuid);
  perform t.ok((public.close_session(sid))->>'ok'='true', 'course rep closes session manually');
  perform t.anon();
  r := public.submit_attendance(tok,'01241003A',repeat('d',40),'ABC123');
  perform t.ok(r->>'code'='SESSION_CLOSED', 'closed session rejects attendance with clear code');
  perform t.staff(t.get('rep')::uuid);
  perform t.ok((public.reopen_session(sid,5,'because'))->>'code'='FORBIDDEN', 'course rep cannot reopen');
  perform t.staff(t.get('ad')::uuid);
  perform t.ok((public.reopen_session(sid,5,''))->>'code'='REASON_REQUIRED', 'reopen needs a reason');
  perform t.ok((public.reopen_session(sid,5,'Students had network trouble'))->>'ok'='true', 'admin reopens with reason');
  perform t.anon();
  r := public.submit_attendance(tok,'01241003A',repeat('d',40),'ABC123');
  perform t.ok(r->>'ok'='true', 'reopened session accepts attendance again');
  perform t.root();
  update public.attendance_sessions set closes_at = now() - interval '1 second' where id = sid;   -- simulate time passing
  perform t.anon();
  r := public.submit_attendance(tok,'01241005A',repeat('e',40),'ABC123');
  perform t.ok(r->>'code'='SESSION_EXPIRED', 'expiry is decided by database time (no cron needed)');
  r := public.get_session_public(tok);
  perform t.ok(r->>'status'='expired' and (r->>'seconds_remaining')::int = 0, 'expired session reports 0 seconds');
  perform t.root();
  perform t.ok((select count(*) from public.audit_logs where action in ('session.create','session.open','session.close','session.reopen')) = 4, 'session lifecycle audited');
end $$;

-- ---------------------------------------------------- analytics (5/6 etc.)
do $$
declare ad uuid := t.get('ad')::uuid; c1 uuid := t.get('c1')::uuid; r jsonb; sid uuid; tok text; i int;
        s1 text := '01241001A'; s2 text := '01241002A'; s3 text := '01241003A';
begin
  -- Sessions 2..6 (session 1 already exists, giving 6 finished sessions in total)
  for i in 2..6 loop
    perform t.staff(ad);
    r := public.create_session(c1,'Week '||i,current_date,null,10); sid := (r->>'id')::uuid; tok := r->>'public_token';
    perform public.open_session(sid);
    perform t.anon();
    -- 01241001A attends all, 01241002A misses only week 6, 01241003A attends weeks 1(already),2,3 only
    perform public.submit_attendance(tok, s1, md5('d1'||i)||md5('x'||i), null);
    if i <> 6 then perform public.submit_attendance(tok, s2, md5('d2'||i)||md5('y'||i), null); end if;
    if i in (2,3) then perform public.submit_attendance(tok, s3, md5('d3'||i)||md5('z'||i), null); end if;
    perform t.staff(ad);
    perform public.close_session(sid);
  end loop;
  perform t.ok((public.student_analytics(t.get('S1')::uuid))->'stats'->>'summary' = '6/6', 'student attending all: Attendance 6/6');
  perform t.ok(((public.student_analytics(t.get('S1')::uuid))->'stats'->>'rate')::numeric = 100.0, 'rate 100%');
  r := public.student_analytics(t.get('S2')::uuid);
  perform t.ok(r->'stats'->>'summary' = '5/6' and (r->'stats'->>'rate')::numeric = 83.3, 'student attending 5 of 6: 5/6 = 83.3%');
  r := public.student_analytics(t.get('S3')::uuid);
  perform t.ok(r->'stats'->>'summary' = '3/6' and (r->'stats'->>'rate')::numeric = 50.0, 'student attending 3 of 6: 3/6 = 50%');
  perform t.ok((r->'stats'->>'missed')::int = 3 and jsonb_array_length(r->'stats'->'sessions') = 6, 'missed count and per-session list correct');
  perform t.ok(r->'student'->>'whatsapp_number' is not null, 'admin analytics includes WhatsApp number');
  -- late joiner 01241008A enrolled via registration after session 1; sessions 2-6 opened AFTER they enrolled -> count
  r := public.student_analytics(t.get('S8')::uuid);
  perform t.ok(r->'stats'->>'summary' = '1/6', 'late registrant who checked in mid-session counts: 1/6 (session 1 included, then missed 2-6)');
  -- brand-new student with no history
  perform t.root();
  r := public.register_student('Brand New','01241099A','0244777888',t.get('p')::uuid,t.get('l')::uuid,t.get('g')::uuid);
  perform t.ok((public._student_stats((r->>'id')::uuid,false))->>'rate' is null, 'student with no sessions yet: rate is null (UI shows no-history message)');
  delete from public.students where student_id = '01241099A';
  -- unrelated course sessions must not count
  perform t.staff(t.get('lec2')::uuid);
  r := public.create_session(t.get('c2')::uuid,'Math wk1',current_date,null,10); sid := (r->>'id')::uuid;
  perform public.open_session(sid); perform public.close_session(sid);
  perform t.staff(ad);
  perform t.ok((public.student_analytics(t.get('S1')::uuid))->'stats'->>'summary' = '6/7', 'a different course adds its own sessions (6/7 across courses)');
  perform t.staff(t.get('lec')::uuid);
  r := public.student_analytics(t.get('S1')::uuid);
  perform t.ok(r->'stats'->>'summary' = '6/6', 'lecturer of ACC101 only sees ACC101 sessions (not ACC102)');
  perform t.ok(r->'student'->>'whatsapp_number' is null, 'lecturer analytics hides WhatsApp number');
  perform t.ok((public.dashboard_stats())->>'students' is null, 'lecturer dashboard hides global student count');
  perform t.staff(ad);
  r := public.dashboard_stats();
  perform t.ok((r->>'students')::int = 6 and (r->>'courses')::int = 2 and (r->>'sessions')::int = 7, 'dashboard counts are real (6 students, 2 courses, 7 sessions)');
end $$;

-- ------------------------------------------------ overrides + staff RLS
do $$
declare ad uuid := t.get('ad')::uuid; lec uuid := t.get('lec')::uuid; lec2 uuid := t.get('lec2')::uuid; sid uuid := t.get('sess1')::uuid; r jsonb; n int;
begin
  perform t.staff(ad);
  r := public.admin_override_attendance(sid, t.get('S5')::uuid, 'mark_present', '');
  perform t.ok(r->>'code'='REASON_REQUIRED', 'override without reason rejected');
  r := public.admin_override_attendance(sid, t.get('S5')::uuid, 'mark_present', 'Device conflict: verified in class');
  perform t.ok(r->>'ok'='true', 'admin override (device restriction bypass) works');
  perform t.ok((select count(*) from public.attendance_overrides) = 1 and (select count(*) from public.audit_logs where action='attendance.override' and reason like 'Device conflict%') = 1, 'override stored + audited with reason');
  perform t.ok((select source from public.attendance_records where session_id=sid and student_id=t.get('S5')::uuid) = 'admin_override', 'record flagged as admin_override');
  perform t.ok((public.admin_override_attendance(sid, t.get('S5')::uuid, 'remove', 'Entered by mistake'))->>'ok'='true', 'admin removes a record');

  perform t.staff(lec);
  perform t.ok((public.admin_override_attendance(sid, t.get('S1')::uuid, 'mark_present', 'x y z'))->>'code'='FORBIDDEN', 'lecturer cannot override');
  perform t.ok((public.admin_list_students())->>'code'='FORBIDDEN', 'lecturer cannot list students with phone numbers');
  begin perform whatsapp_number from public.students; perform t.ok(false,'whatsapp column must be blocked');
  exception when insufficient_privilege then perform t.ok(true,'lecturer cannot SELECT students.whatsapp_number'); end;
  begin perform * from public.students; perform t.ok(false,'select * must be blocked');
  exception when insufficient_privilege then perform t.ok(true,'select * on students denied (phone column protected)'); end;
  perform t.ok((select count(*) from public.students) = 6, 'lecturer sees only students enrolled in own course (6 enrolled in ACC101)');
  perform t.ok((select count(*) from public.audit_logs) = 0, 'lecturer cannot read audit log');
  perform t.ok((select count(*) from public.attendance_devices) = 0, 'lecturer cannot read device table');
  perform t.ok((select count(*) from public.attendance_sessions) = 6, 'lecturer sees only own-course sessions (6 of 7)');
  perform t.staff(lec2);
  perform t.ok((select count(*) from public.attendance_records) = 0, 'other lecturer sees none of ACC101 records');
  perform t.ok((select count(*) from public.students) = 6, 'other lecturer sees students via ACC102 enrolments only') ;
end $$;

-- ------------------------------------------------ student portal (no password)
do $$
declare r jsonb; tok text; i int;
begin
  perform t.anon('9.9.9.9');
  r := public.student_login('01241001A','0000');
  perform t.ok(r->>'code'='BAD_CREDENTIALS', 'wrong last-4 rejected');
  r := public.student_login('NOPE0000','3456');
  perform t.ok(r->>'code'='BAD_CREDENTIALS', 'unknown ID gives identical error (no enumeration)');
  r := public.student_login('01241001A','3456');
  perform t.ok(r->>'ok'='true' and length(r->>'token')=64, 'correct ID + last 4 digits issues random token');
  tok := r->>'token';
  r := public.student_dashboard(tok);
  perform t.ok(r->'student'->>'full_name'='Ama Mensah' and r->'stats'->>'summary'='6/7', 'student sees own dashboard across all their courses (6/7)');
  perform t.ok(not (r->'student' ? 'whatsapp_number'), 'dashboard does not expose phone number');
  perform t.ok((public.student_dashboard('garbage'))->>'code'='SESSION_ENDED', 'invalid token rejected');
  perform public.student_logout(tok);
  perform t.ok((public.student_dashboard(tok))->>'code'='SESSION_ENDED', 'logout revokes token server-side');
  perform t.root();
  perform t.ok((select count(*) from public.student_access_tokens where token_hash = tok) = 0, 'raw token is never stored (hash only)');
  perform t.anon('8.8.8.8');
  for i in 1..6 loop perform public.student_login('01241002A','0000'); end loop;
  r := public.student_login('01241002A','3484');
  perform t.ok(r->>'code'='RATE_LIMITED', 'brute-force on one Student ID is throttled even with the right digits');
end $$;

-- -------------------------------------------------------------- rate limits
do $$
declare r jsonb; i int; tok text;
begin
  perform t.root();
  select public_token into tok from public.attendance_sessions limit 1;
  update public.app_settings set value='3' where key='rl_lookup_max';
  perform t.anon('7.7.7.7');
  for i in 1..3 loop r := public.lookup_student_for_session(tok,'ZZ'||i||'999'); end loop;
  r := public.lookup_student_for_session(tok,'01241001A');
  perform t.ok(r->>'code'='RATE_LIMITED', 'ID lookups are rate limited per client');
  perform t.anon('6.6.6.6');
  r := public.lookup_student_for_session(tok,'01241001A');
  perform t.ok(r->>'code' <> 'RATE_LIMITED', 'a different client is unaffected');
  perform t.root();
  update public.app_settings set value='100000' where key='rl_lookup_max';
end $$;
select 'ALL DATABASE TESTS PASSED' as result;
