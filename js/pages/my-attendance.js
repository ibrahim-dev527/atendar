import { initChrome, renderFooter, esc, toast, setBusy, ringHtml, animateRings, countUp, fmtDate, statusBadge, emptyState, $, $$ } from "/js/ui.js";
import { isConfigured, studentClient } from "/js/supabase.js";
import { call } from "/js/api.js";
import { normalizeStudentId } from "/js/validators.js";

initChrome();
renderFooter($("#app"));
const sb = isConfigured ? studentClient() : null;
const KEY = "atu_stoken";
const IDLE_MS = 5 * 60 * 1000;
let idleTimer = null;
if (!sb) $("#cfgWarn").classList.remove("hidden");

const getToken = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const setToken = (t) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch {} };

function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => logout("You were signed out after a few minutes of inactivity."), IDLE_MS); }
["pointerdown", "keydown", "scroll", "touchstart"].forEach((ev) => window.addEventListener(ev, () => getToken() && resetIdle(), { passive: true }));

async function logout(msg) {
  const t = getToken(); setToken(null); clearTimeout(idleTimer);
  if (t && sb) call(sb, "student_logout", { p_token: t });
  $("#dashView").classList.add("hidden"); $("#dashView").innerHTML = "";
  $("#logout").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  $("#sid").value = ""; $("#l4").value = "";
  if (msg) toast(msg, "info", 6000);
}
$("#logout").addEventListener("click", () => logout("You have been signed out. Your information is no longer on this screen."));
window.addEventListener("pagehide", () => { /* keep token only for this tab; sessionStorage clears when the tab closes */ });

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) return;
  const err = $("#loginErr"); err.textContent = "";
  const sid = normalizeStudentId($("#sid").value), l4 = $("#l4").value.trim();
  if (sid.length < 4) { err.textContent = "Enter your Student ID."; return; }
  if (!/^\d{4}$/.test(l4)) { err.textContent = "Enter exactly the last 4 digits of your WhatsApp number."; return; }
  setBusy($("#loginBtn"), true, "Checking…");
  const r = await call(sb, "student_login", { p_student_id: sid, p_last4: l4 });
  setBusy($("#loginBtn"), false);
  if (!r.ok) { err.textContent = r.message; toast(r.message, "bad"); return; }
  setToken(r.token);
  await showDashboard();
});

async function showDashboard() {
  const t = getToken();
  if (!t) return;
  $("#dashView").classList.remove("hidden");
  $("#dashView").innerHTML = '<div class="card"><div class="skeleton" style="height:150px;margin-bottom:12px"></div><div class="skeleton" style="height:60px"></div></div>';
  $("#loginView").classList.add("hidden");
  const r = await call(sb, "student_dashboard", { p_token: t });
  if (!r.ok) { setToken(null); $("#dashView").classList.add("hidden"); $("#loginView").classList.remove("hidden"); if (r.code !== "SESSION_ENDED") toast(r.message, "bad"); else toast(r.message, "info"); return; }
  render(r);
  $("#logout").classList.remove("hidden");
  resetIdle();
}

function render({ student: s, stats: st }) {
  const rate = st.rate;
  const sessions = st.sessions || [];
  $("#dashView").innerHTML = `
    <div class="card glow reveal in">
      <div class="me-head">
        ${ringHtml(rate, { size: 170 })}
        <div class="me-info">
          <span class="badge info">Student</span>
          <h2>${esc(s.full_name)}</h2>
          <div class="muted">ID: <b style="color:var(--text)">${esc(s.student_id)}</b></div>
          <div class="chips"><span class="badge">${esc(s.programme)}</span><span class="badge">${esc(s.level)}</span><span class="badge">${esc(s.class_group)}</span></div>
          <div class="fraction">${st.summary ? `Attendance: ${esc(st.summary)}` : "No attendance history yet"}</div>
        </div>
      </div>
      <div class="tiles">
        <div class="tile c"><b data-n="${st.eligible}">0</b><span>Eligible sessions</span></div>
        <div class="tile g"><b data-n="${st.attended}">0</b><span>Attended</span></div>
        <div class="tile r"><b data-n="${st.missed}">0</b><span>Missed</span></div>
        <div class="tile a"><b data-n="${st.excused}">0</b><span>Excused</span></div>
      </div>
      ${rate != null && rate < 75 ? '<div class="notice warn"><span>⚠️</span><span>Your attendance is below 75%. Try not to miss more classes.</span></div>' : ""}
    </div>
    <div class="card reveal in" style="margin-top:16px">
      <h3>My sessions</h3>
      ${sessions.length ? sessions.map((x, i) => `<div class="sess" style="--i:${i}"><div><b>${esc(x.course_code)} · ${esc(x.title)}</b><small>${esc(x.course_name)} · ${esc(fmtDate(x.session_date))}</small></div>${statusBadge(x.status)}</div>`).join("")
        : emptyState("🗓️", "No attendance history yet", "Your sessions will appear here after your first class with attendance.")}
    </div>
    <p class="hint" style="text-align:center;margin-top:14px">Excused sessions aren't counted against your rate. Something wrong? Contact the system administrator.</p>`;
  animateRings($("#dashView"));
  $$("[data-n]", $("#dashView")).forEach((b) => countUp(b, Number(b.dataset.n), { duration: 1000 }));
}

if (sb && getToken()) showDashboard();
