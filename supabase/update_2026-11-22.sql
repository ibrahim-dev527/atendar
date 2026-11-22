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
