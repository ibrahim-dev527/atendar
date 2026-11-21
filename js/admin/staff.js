import { esc, openModal, confirmDialog, toast, setBusy, statusBadge, emptyState, skeletonRows, initReveal, $, $$ } from "/js/ui.js";
import { call, q } from "/js/api.js";

const ROLES = { super_admin: "Super Administrator", admin: "Administrator", lecturer: "Lecturer", course_rep: "Course Representative" };

export async function mount(ctx, root) {
  const { sb } = ctx;
  root.innerHTML = `<div class="page-head reveal"><div><h1>Staff &amp; roles</h1><p>Only Super Administrators can invite staff or change roles. Everything here is audited.</p></div>
    <button class="btn primary" id="inviteBtn"><span class="lbl">✉️ Invite staff</span></button></div>
    <div class="card reveal" style="padding:14px"><div id="table">${skeletonRows(4)}</div></div>`;
  initReveal();

  async function load() {
    const { data, error } = await q(sb.from("profiles").select("id,full_name,email,is_active,created_at,user_roles!user_roles_user_id_fkey(role)").order("created_at"));
    const box = $("#table", root);
    if (error) { box.innerHTML = `<div class="notice bad">${esc(error)}</div>`; return; }
    const list = data || [];
    box.innerHTML = list.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
      ${list.map((p, i) => { const role = Array.isArray(p.user_roles) ? p.user_roles[0]?.role : p.user_roles?.role; return `<tr style="--i:${i}"><td><b>${esc(p.full_name || "–")}</b></td><td>${esc(p.email)}</td><td>${role ? `<span class="badge info">${esc(ROLES[role])}</span>` : '<span class="badge warn">no access</span>'}</td>
        <td><div class="actions-cell"><button class="btn small" data-role="${esc(p.id)}" data-cur="${esc(role || "")}" data-name="${esc(p.full_name || p.email)}">Change role</button></div></td></tr>`; }).join("")}</tbody></table></div>` : emptyState("🛡️", "No staff yet", "");
    $$("[data-role]", box).forEach((b) => b.addEventListener("click", () => roleDialog(b.dataset.role, b.dataset.cur, b.dataset.name)));
  }

  function roleDialog(userId, cur, name) {
    const m = openModal(`<h3>Role for ${esc(name)}</h3>
      <div class="field"><label for="r_role">Role</label><select id="r_role" class="input">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}"${k === cur ? " selected" : ""}>${v}</option>`).join("")}<option value="__none">No access (remove role)</option></select></div>
      <div class="field"><label for="r_why">Reason (recorded in the audit log)</label><input id="r_why" class="input" maxlength="300" placeholder="e.g. Teaches ACC101 this semester"></div><div class="err" id="r_err" role="alert"></div>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="r_go"><span class="lbl">Save role</span></button></div>`);
    $("[data-close]", m.el).addEventListener("click", m.close);
    $("#r_go", m.el).addEventListener("click", async () => {
      const why = $("#r_why", m.el).value.trim(), v = $("#r_role", m.el).value;
      if (why.length < 3) return ($("#r_err", m.el).textContent = "Please give a reason.");
      setBusy($("#r_go", m.el), true);
      const r = await call(sb, "admin_set_role", { p_user: userId, p_role: v === "__none" ? null : v, p_reason: why });
      setBusy($("#r_go", m.el), false);
      if (!r.ok) return ($("#r_err", m.el).textContent = r.message);
      toast("Role updated.", "good"); m.close(); load();
    });
  }

  $("#inviteBtn", root).addEventListener("click", () => {
    const m = openModal(`<h3>✉️ Invite staff</h3><p class="muted">They'll get an email to set their password. They can't do anything until you've given them a role, which this form does for you.</p>
      <form id="inv" novalidate><div class="field"><label for="i_name">Full name</label><input id="i_name" class="input" maxlength="100"></div>
      <div class="field"><label for="i_email">Email</label><input id="i_email" type="email" class="input" maxlength="120"></div>
      <div class="field"><label for="i_role">Role</label><select id="i_role" class="input"><option value="lecturer">Lecturer</option><option value="course_rep">Course Representative</option><option value="admin">Administrator</option></select></div>
      <div class="field"><label for="i_why">Reason</label><input id="i_why" class="input" maxlength="300" placeholder="e.g. Class rep for Level 100 Accounting"></div>
      <div class="err" id="i_err" role="alert"></div><div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="i_go"><span class="lbl">Send invitation</span></button></div></form>`);
    $("[data-close]", m.el).addEventListener("click", m.close);
    $("#inv", m.el).addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#i_err", m.el); err.textContent = "";
      const body = { full_name: $("#i_name", m.el).value.trim(), email: $("#i_email", m.el).value.trim(), role: $("#i_role", m.el).value, reason: $("#i_why", m.el).value.trim() };
      if (body.full_name.length < 2) return (err.textContent = "Enter their name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return (err.textContent = "Enter a valid email address.");
      if (body.reason.length < 3) return (err.textContent = "Please give a reason.");
      setBusy($("#i_go", m.el), true, "Sending…");
      try {
        const { data, error } = await sb.functions.invoke("invite-staff", { body });
        if (error || !data?.ok) { let msg = data?.message; if (!msg && error?.context?.json) { try { msg = (await error.context.json())?.message; } catch {} } err.textContent = msg || "Couldn't send the invitation. Has the invite-staff function been deployed? (See README.)"; return; }
        toast("Invitation sent.", "good"); m.close(); load();
      } catch { err.textContent = "Couldn't reach the server. Please try again."; }
      finally { setBusy($("#i_go", m.el), false); }
    });
  });

  await load();
  return {};
}
