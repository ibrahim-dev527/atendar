import { initChrome, renderFooter, openModal, esc, toast, setBusy, confetti, mmss, fmtDateTime, $, $$ } from "/js/ui.js";
import { isConfigured, studentClient } from "/js/supabase.js";
import { call } from "/js/api.js";
import { deviceToken } from "/js/device.js";
import { normalizeStudentId, validStudentId } from "/js/validators.js";

initChrome();
renderFooter($("#app"));

const token = new URLSearchParams(location.search).get("s") || "";
const sb = isConfigured ? studentClient() : null;
const R = 50, C = 2 * Math.PI * R;
let info = null, deadline = 0, total = 1, timer = null, resync = null, modal = null, finished = false;
let student = null; // {sid, name}

const backdrop = $("#backdrop");
function setBackdrop(html) { backdrop.innerHTML = html; }

if (!sb) setBackdrop('<span class="big-icon">🔧</span><h3>Not connected yet</h3><p class="muted">This site hasn\'t been connected to its database. Please tell the administrator.</p>');
else if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) setBackdrop('<span class="big-icon">🔗</span><h3>This link isn\'t valid</h3><p class="muted">Please scan the QR code again, or ask your lecturer to share the attendance link.</p><a class="btn primary" href="/">Go home</a>');
else boot();

async function boot() {
  info = await call(sb, "get_session_public", { p_token: token });
  if (!info.ok) { setBackdrop(`<span class="big-icon">⚠️</span><h3>${esc(info.message)}</h3><a class="btn primary" href="/">Go home</a>`); return; }
  if (info.status === "scheduled") renderWaiting();
  else if (info.status === "open") { startClock(info.seconds_remaining); renderStart(); openPopup(); }
  else { renderStart(); showEnded(info.status === "closed" ? "SESSION_CLOSED" : "SESSION_EXPIRED"); }
  resync = setInterval(refreshInfo, 25000);
}
function renderStart() {
  setBackdrop(`<div class="att-head"><span class="code">${esc(info.course_code)}</span><h3>${esc(info.course_name)}</h3><p class="muted">${esc(info.title)}</p></div>
    <button class="btn primary big pulse" id="openForm"><span class="lbl">📲 Mark my attendance</span></button>`);
  $("#openForm").addEventListener("click", openPopup);
}
function renderWaiting() {
  setBackdrop(`<div class="att-head"><span class="code">${esc(info.course_code)}</span><h3>${esc(info.course_name)}</h3><p class="muted">${esc(info.title)}</p></div>
    <span class="big-icon">⏳</span><h3>Not started yet</h3><p class="muted">Your lecturer hasn't opened attendance yet. This page will update by itself. Keep it open.</p>`);
}

function startClock(secs) {
  deadline = performance.now() + secs * 1000;
  total = Math.max(secs, 1);
  clearInterval(timer);
  timer = setInterval(tick, 250);
}
function remaining() { return Math.max(0, Math.ceil((deadline - performance.now()) / 1000)); }

async function refreshInfo() {
  if (finished) return;
  const r = await call(sb, "get_session_public", { p_token: token });
  if (!r.ok) return;
  const was = info.status;
  info = r;
  if (r.status === "scheduled") return;
  if (was === "scheduled" && r.status === "open") { startClock(r.seconds_remaining); renderStart(); openPopup(); return; }
  if (r.status !== "open") return showEnded(r.status === "closed" ? "SESSION_CLOSED" : "SESSION_EXPIRED");
  startClock(r.seconds_remaining); // resync to the SERVER clock
}

function tick() {
  const rem = remaining();
  const cd = $("#cd", modal?.el || document);
  if (cd) {
    $(".b", cd).style.strokeDashoffset = C * (1 - rem / total);
    $(".num b", cd).textContent = mmss(rem);
    cd.classList.toggle("low", rem <= total * 0.5 && rem > total * 0.2);
    cd.classList.toggle("crit", rem <= Math.min(20, total * 0.2) && rem > 0);
  }
  if (rem <= 0 && !finished) showEnded("SESSION_EXPIRED");
}

function cdHtml() {
  return `<div class="cd" id="cd" role="timer" aria-label="Time remaining"><svg viewBox="0 0 120 120"><circle class="t" cx="60" cy="60" r="${R}"/>
    <circle class="b" cx="60" cy="60" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg><div class="num"><b>${mmss(remaining())}</b><span>left</span></div></div>`;
}
function head() { return `<div class="att-head"><span class="code">${esc(info.course_code)}</span><h3>${esc(info.course_name)}</h3><p class="muted">${esc(info.title)}</p></div>`; }

function openPopup() {
  if (finished || modal) return;
  modal = openModal('<div id="pane"></div>', { onClose: () => { modal = null; } });
  viewEntry();
}
const pane = () => $("#pane", modal.el);
function show(html) { const p = pane(); p.innerHTML = html; p.classList.remove("pane-enter"); void p.offsetWidth; p.classList.add("pane-enter"); }

function viewEntry(prefill = "", errMsg = "") {
  show(`${head()}${cdHtml()}
    <form id="f" novalidate>
      <div class="field"><label for="sid">Your Student ID</label>
        <input id="sid" class="input id-input" value="${esc(prefill)}" placeholder="Student ID" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="12"></div>
      ${info.requires_code ? `<div class="field"><label for="code">Attendance code <span class="muted">(shown in class)</span></label><input id="code" class="input id-input" placeholder="Code" autocomplete="off" maxlength="12"></div>` : ""}
      <div class="err" id="err" role="alert">${esc(errMsg)}</div>
      <button class="btn primary big" id="next" type="submit"><span class="lbl">Continue →</span></button>
    </form>`);
  tick();
  $("#sid", modal.el).focus();
  $("#f", modal.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const sid = normalizeStudentId($("#sid", modal.el).value);
    const code = $("#code", modal.el)?.value.trim() ?? "";
    const err = $("#err", modal.el);
    if (!validStudentId(sid)) { err.textContent = "Enter your Student ID."; $("#sid", modal.el).classList.add("invalid"); return; }
    if (info.requires_code && !code) { err.textContent = "Enter the attendance code shown in class."; return; }
    err.textContent = "";
    setBusy($("#next", modal.el), true, "Checking…");
    const r = await call(sb, "lookup_student_for_session", { p_token: token, p_student_id: sid });
    if (!modal) return;
    setBusy($("#next", modal.el), false);
    if (r.ok) { student = { sid, name: r.full_name, code }; return r.already_marked ? viewAlready() : viewConfirm(); }
    if (r.code === "SESSION_EXPIRED" || r.code === "SESSION_CLOSED" || r.code === "SESSION_NOT_FOUND") return showEnded(r.code, r.message);
    err.textContent = r.message;
    $("#sid", modal.el).classList.add("invalid");
  });
}

function viewConfirm(errMsg = "") {
  show(`${head()}${cdHtml()}
    <div class="whoami"><small>Is this you?</small><b>${esc(student.name)}</b><span>${esc(student.sid)}</span></div>
    <div class="err" id="err" role="alert">${esc(errMsg)}</div>
    <div class="stack">
      <button class="btn primary big" id="submit"><span class="lbl">✅ Yes, Submit Attendance</span></button>
      <button class="btn ghost" id="back">That's not me</button>
    </div>`);
  tick();
  $("#back", modal.el).addEventListener("click", () => viewEntry(student.sid));
  $("#submit", modal.el).addEventListener("click", submit);
}

let sending = false;
async function submit() {
  if (sending) return; // no accidental double submits
  sending = true;
  setBusy($("#submit", modal.el), true, "Submitting…");
  const r = await call(sb, "submit_attendance", { p_token: token, p_student_id: student.sid, p_device_token: deviceToken(), p_code: student.code || null });
  sending = false;
  if (!modal) return;
  if (r.ok) return viewSuccess(r);
  setBusy($("#submit", modal.el), false);
  if (r.code === "ALREADY_MARKED") return viewAlready();
  if (["SESSION_EXPIRED", "SESSION_CLOSED", "SESSION_NOT_FOUND"].includes(r.code)) return showEnded(r.code, r.message);
  if (r.code === "BAD_CODE") return viewEntry(student.sid, r.message);
  viewConfirm(r.message);
}

function viewSuccess(r) {
  finished = true; clearInterval(timer); clearInterval(resync);
  show(`<div style="text-align:center">
    <svg class="check" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="30"/><path d="M26 41l10 10 19-22"/></svg>
    <h2>You're marked ${r.status === "late" ? "late" : "present"}! 🎉</h2>
    <p class="muted"><b style="color:var(--text)">${esc(r.full_name)}</b><br>${esc(info.course_code)} · ${esc(info.title)}<br>${esc(fmtDateTime(r.submitted_at))}</p>
    ${r.status === "late" ? '<div class="notice warn" style="text-align:left;margin-bottom:12px"><span>⏰</span><span>You arrived after the late cut-off, so you were recorded as late.</span></div>' : ""}
    <div class="stack"><a class="btn primary" href="/my-attendance.html"><span class="lbl">📊 See my attendance</span></a><button class="btn" data-close>Close</button></div></div>`);
  confetti();
  $("[data-close]", modal.el)?.addEventListener("click", () => modal?.close());
  setBackdrop(`<span class="big-icon">✅</span><h3>Attendance recorded</h3><p class="muted">${esc(r.full_name)} · ${esc(info.course_code)}</p>`);
}

function viewAlready() {
  finished = true; clearInterval(timer); clearInterval(resync);
  show(`<div style="text-align:center"><span class="big-icon">👍</span><h2>Already marked</h2>
    <p class="muted"><b style="color:var(--text)">${esc(student.name)}</b>, you have already been marked present for this session. You don't need to do anything else.</p>
    <div class="stack"><a class="btn primary" href="/my-attendance.html">📊 See my attendance</a><button class="btn" data-close>Close</button></div></div>`);
  $("[data-close]", modal.el)?.addEventListener("click", () => modal?.close());
}

function showEnded(code, message) {
  if (finished) return;
  finished = true; clearInterval(timer); clearInterval(resync);
  const closed = code === "SESSION_CLOSED";
  const text = message || (closed ? "This attendance session has been closed by your lecturer." : "This attendance session has expired.");
  const html = `<div style="text-align:center"><svg class="check bad" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="30"/><path d="M29 29l22 22M51 29L29 51"/></svg>
    <h2>${closed ? "Session closed" : "Time's up"}</h2><p class="muted">${esc(text)}</p>
    <div class="notice warn" style="text-align:left;margin:12px 0"><span>🗣️</span><span><b>Had a problem marking your attendance?</b> Tell your course rep or lecturer about the issue <b>before the lecturer leaves the class</b>, so it can be sorted out while everyone is still here.</span></div>
    <p class="muted">Still stuck afterwards? Contact the system administrator.</p><button class="btn" data-close>Close</button></div>`;
  if (!modal) modal = openModal('<div id="pane"></div>', { onClose: () => { modal = null; } });
  show(html);
  $("[data-close]", modal.el)?.addEventListener("click", () => modal?.close());
  setBackdrop(`<span class="big-icon">⌛</span><h3>${closed ? "Session closed" : "Session expired"}</h3><p class="muted">${esc(info?.course_code || "")} · ${esc(info?.title || "")}</p>`);
}
