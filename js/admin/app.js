// Admin shell: auth guard, role-aware navigation, hash router.
import { initChrome, renderFooter, toast, esc, $, $$ } from "/js/ui.js";
import { isConfigured, staffClient } from "/js/supabase.js";

initChrome();
if (!isConfigured) location.replace("/admin/login.html");
const sb = staffClient();

const ALL = ["super_admin", "admin", "lecturer", "course_rep"];
const ADM = ["super_admin", "admin"];
const ROUTES = {
  dashboard: { label: "Dashboard", icon: "🏠", roles: ALL, load: () => import("/js/admin/dashboard.js") },
  students: { label: "Students", icon: "🎓", roles: ALL, load: () => import("/js/admin/students.js") },
  courses: { label: "Courses", icon: "📚", roles: ALL, load: () => import("/js/admin/courses.js") },
  sessions: { label: "Sessions", icon: "📡", roles: ALL, load: () => import("/js/admin/sessions.js") },
  records: { label: "Records & Reports", icon: "🗂️", roles: ALL, load: () => import("/js/admin/records.js") },
  setup: { label: "Setup", icon: "⚙️", roles: ADM, load: () => import("/js/admin/setup.js") },
  staff: { label: "Staff & Roles", icon: "🛡️", roles: ["super_admin"], load: () => import("/js/admin/staff.js") },
  audit: { label: "Audit Log", icon: "🧾", roles: ADM, load: () => import("/js/admin/audit.js") },
};
const ROLE_NAMES = { super_admin: "Super Administrator", admin: "Administrator", lecturer: "Lecturer", course_rep: "Course Representative" };

const ctx = { sb, role: null, isAdmin: false, user: null, email: "" };
let current = null, navToken = 0;

async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data?.session) return location.replace("/admin/login.html");
  ctx.user = data.session.user; ctx.email = ctx.user.email;
  const { data: role, error } = await sb.rpc("staff_role");
  if (error || !role) { await sb.auth.signOut(); return location.replace("/admin/login.html"); }
  ctx.role = role; ctx.isAdmin = ADM.includes(role);
  $("#who").textContent = ctx.email; $("#roleLabel").textContent = ROLE_NAMES[role];
  $("#nav").innerHTML = Object.entries(ROUTES).filter(([, r]) => r.roles.includes(role))
    .map(([k, r]) => `<a href="#/${k}" data-r="${k}"><span class="ico">${r.icon}</span>${esc(r.label)}</a>`).join("");
  renderFooter($("#main"));
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") location.replace("/admin/login.html"); });
  window.addEventListener("hashchange", route);
  route();
}

async function route() {
  const [, name = "dashboard", ...params] = location.hash.replace(/^#/, "").split("/");
  const def = ROUTES[name];
  const view = $("#view");
  document.body.classList.remove("nav-open");
  if (!def || !def.roles.includes(ctx.role)) { location.hash = "#/dashboard"; return; }
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.r === name));
  const my = ++navToken;
  try { await current?.unmount?.(); } catch {}
  current = null;
  view.innerHTML = '<div class="skeleton" style="height:120px;margin-bottom:14px"></div><div class="skeleton" style="height:260px"></div>';
  try {
    const mod = await def.load();
    if (my !== navToken) return;
    view.innerHTML = "";
    const inst = await mod.mount(ctx, view, params);
    if (my !== navToken) { await inst?.unmount?.(); return; }
    current = inst || null;
    window.scrollTo({ top: 0 });
  } catch (e) {
    console.error(e);
    if (my === navToken) view.innerHTML = '<div class="card"><div class="empty"><span class="big">😕</span><b>This page could not load</b><p>Check your connection and refresh. If it keeps happening, tell the developer.</p></div></div>';
  }
}

$("#menuBtn").addEventListener("click", () => document.body.classList.toggle("nav-open"));
$("#scrim").addEventListener("click", () => document.body.classList.remove("nav-open"));
$("#signout").addEventListener("click", async () => { await sb.auth.signOut(); location.replace("/admin/login.html"); });

boot();
