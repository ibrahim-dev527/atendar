// Edge Function: invite-staff
// Lets a SUPER ADMIN invite a new staff member by email and assign their role.
// The service-role key is used here, server-side only. It is injected by
// Supabase at runtime and never appears in the frontend or the repo.
//
// Deploy:  supabase functions deploy invite-staff
// Call:    supabase.functions.invoke('invite-staff', { body: { email, full_name, role, reason } })
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["admin", "lecturer", "course_rep"]; // super_admin is never granted via invite

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Who is calling? Use THEIR token, then ask the database for their role.
  const caller = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData } = await caller.auth.getUser();
  if (!userData?.user) return json({ ok: false, message: "Please sign in again." }, 401);
  const { data: role } = await caller.rpc("staff_role");
  if (role !== "super_admin") {
    return json({ ok: false, message: "Only a Super Administrator can invite staff." }, 403);
  }

  // 2. Validate input
  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ ok: false, message: "Invalid request." }, 400); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const fullName = String(body.full_name ?? "").trim();
  const newRole = String(body.role ?? "");
  const reason = String(body.reason ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, message: "Enter a valid email address." }, 400);
  if (fullName.length < 2) return json({ ok: false, message: "Enter the staff member's name." }, 400);
  if (!ROLES.includes(newRole)) return json({ ok: false, message: "Choose a valid role." }, 400);
  if (reason.length < 3) return json({ ok: false, message: "Please give a reason." }, 400);

  // 3. Invite (service role) and assign the role
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: Deno.env.get("INVITE_REDIRECT_URL") ?? undefined,
  });
  if (error || !invited?.user) {
    return json({ ok: false, message: "Could not send the invitation. The email may already be registered." }, 400);
  }
  const uid = invited.user.id;
  // profile row is created by the on_auth_user_created trigger; make sure of the name
  await admin.from("profiles").update({ full_name: fullName }).eq("id", uid);
  const { error: roleErr } = await admin.from("user_roles")
    .insert({ user_id: uid, role: newRole, granted_by: userData.user.id });
  if (roleErr) return json({ ok: false, message: "Invitation sent but the role could not be assigned. Assign it from the staff page." }, 500);

  await admin.from("audit_logs").insert({
    actor_id: userData.user.id, actor_role: "super_admin", action: "staff.invite",
    entity_type: "user", entity_id: uid, reason, details: { email, role: newRole },
  });
  return json({ ok: true, user_id: uid });
});
