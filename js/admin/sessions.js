import { esc, openModal, confirmDialog, toast, setBusy, debounce, fmtDate, fmtDateTime, fmtTime, mmss, statusBadge, emptyState, skeletonRows, initReveal, countUp, $, $$ } from "/js/ui.js";
import { call, q } from "/js/api.js";
import { effStatus, fetchAll, sessionLink, copyText, qrDataUrl } from "/js/admin/common.js";

export async function mount(ctx, root, params) {
  return params[0] ? monitor(ctx, root, params[0]) : list(ctx, root);
}

// ========================================================================= list + create
async function list(ctx, root) {
  const { sb, isAdmin } = ctx;
  let courses = [], sessions = [], filter = "", manageable = new Set();
  root.innerHTML = `
    <div class="page-head reveal"><div><h1>Attendance sessions</h1><p>Start a session, share the QR code, and watch check-ins arrive live.</p></div>
      <button class="btn primary" id="newBtn"><span class="lbl">➕ New session</span></button></div>
    <div class="toolbar reveal"><select id="fCourse" class="input"><option value="">All courses</option></select></div>
    <div class="card reveal" style="padding:14px"><div id="table">${skeletonRows(5)}</div></div>`;
  initReveal();

  async function load() {
    const { data: cs, error: ce } = await q(sb.from("courses").select("id,code,name,is_archived,course_assignments(assignment_role,profiles(full_name,email))").order("code"));
    if (ce) { $("#table", root).innerHTML = `<div class="notice bad">${esc(ce)}</div>`; return; }
    courses = cs || [];
    if (isAdmin) manageable = new Set(courses.map((c) => c.id));
    else { const { data: as } = await q(sb.from("course_assignments").select("course_id,can_create_sessions").eq("user_id", ctx.user.id)); manageable = new Set((as || []).filter((a) => a.can_create_sessions).map((a) => a.course_id)); }
    $("#fCourse", root).innerHTML = '<option value="">All courses</option>' + courses.map((c) => `<option value="${esc(c.id)}">${esc(c.code)} · ${esc(c.name)}</option>`).join("");
    $("#fCourse", root).value = filter;
    let qb = sb.from("attendance_sessions").select("id,title,session_date,scheduled_start,duration_minutes,attendance_code,join_code,status,opens_at,closes_at,public_token,course_id,courses(code,name)").order("created_at", { ascending: false }).limit(150);
    if (filter) qb = qb.eq("course_id", filter);
    const { data, error } = await q(qb);
    if (error) { $("#table", root).innerHTML = `<div class="notice bad">${esc(error)}</div>`; return; }
    sessions = data || []; draw();
  }

  function draw() {
    const box = $("#table", root);
    if (!sessions.length) { box.innerHTML = emptyState("📡", "No sessions yet", "Create your first attendance session to get a QR code for the class."); return; }
    box.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Course</th><th>Session</th><th>Duration</th><th>Status</th><th></th></tr></thead><tbody>
      ${sessions.map((s, i) => { const st = effStatus(s), can = manageable.has(s.course_id); return `<tr style="--i:${i}">
        <td>${esc(fmtDate(s.session_date))}<br><small class="muted">${esc(s.scheduled_start?.slice(0, 5) || "")}</small></td>
        <td><b>${esc(s.courses?.code)}</b><br><small class="muted">${esc(s.courses?.name)}</small></td><td>${esc(s.title)}${s.attendance_code ? ' <span class="badge info">🔑 code</span>' : ""}</td>
        <td>${s.duration_minutes} min</td><td>${st === "open" ? '<span class="live-dot"></span> ' : ""}${statusBadge(st)}</td>
        <td><div class="actions-cell">
          ${st === "scheduled" && can ? `<button class="btn small primary" data-a="start" data-id="${esc(s.id)}">▶ Start</button>` : ""}
          <a class="btn small" href="#/sessions/${esc(s.id)}">${st === "open" ? "📡 Monitor" : "👁 View"}</a>
          ${st === "open" && can ? `<button class="btn small danger" data-a="close" data-id="${esc(s.id)}">⏹ Close</button>` : ""}
          ${(st === "closed" || st === "expired") && isAdmin ? `<button class="btn small" data-a="reopen" data-id="${esc(s.id)}">🔓 Reopen</button>` : ""}
          <button class="btn small" data-a="copy" data-id="${esc(s.id)}">🔗 Link</button></div></td></tr>`; }).join("")}</tbody></table></div>`;
    $$("[data-a]", box).forEach((b) => b.addEventListener("click", () => act(b.dataset.a, sessions.find((s) => s.id === b.dataset.id), b)));
  }

  async function act(a, s, btn) {
    if (!s) return;
    if (a === "copy") return toast((await copyText(sessionLink(s.public_token))) ? "Attendance link copied." : "Couldn't copy. Open the session to see the link.", "good");
    if (a === "start") { setBusy(btn, true); const r = await call(sb, "open_session", { p_session: s.id }); setBusy(btn, false); if (!r.ok) return toast(r.message, "bad"); toast(`Attendance is open (${r.roster_size} students expected).`, "good"); location.hash = `#/sessions/${s.id}`; return; }
    if (a === "close") { if (!(await confirmDialog({ title: "Close this session?", body: "Students will no longer be able to mark attendance.", confirmText: "Close session", danger: true }))) return; const r = await call(sb, "close_session", { p_session: s.id }); if (!r.ok) return toast(r.message, "bad"); toast("Session closed.", "good"); return load(); }
    if (a === "reopen") return reopenDialog(sb, s, load);
  }

  $("#fCourse", root).addEventListener("change", (e) => { filter = e.target.value; load(); });
  $("#newBtn", root).addEventListener("click", () => openCreate());

  function openCreate() {
    const usable = courses.filter((c) => !c.is_archived && manageable.has(c.id));
    if (!usable.length) return toast(isAdmin ? "Add a course first (Courses page)." : "You haven't been given a course you can start sessions for. Ask an administrator.", "info", 6000);
    const today = new Date(), hh = String(today.getHours()).padStart(2, "0"), mm = String(today.getMinutes()).padStart(2, "0");
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const m = openModal(`<h3>📡 New attendance session</h3>
      <form id="nf" novalidate>
        <div class="field"><label for="n_course">Course</label><select id="n_course" class="input">${usable.map((c) => `<option value="${esc(c.id)}">${esc(c.code)} · ${esc(c.name)}</option>`).join("")}</select><div class="hint" id="n_staff"></div></div>
        <div class="field"><label for="n_title">Session title</label><input id="n_title" class="input" maxlength="100" placeholder="e.g. Week 3 Lecture"></div>
        <div class="row"><div class="field"><label for="n_date">Date</label><input id="n_date" type="date" class="input" value="${iso}"></div><div class="field"><label for="n_time">Start time</label><input id="n_time" type="time" class="input" value="${hh}:${mm}"></div></div>
        <div class="row"><div class="field"><label for="n_dur">Attendance stays open for</label><select id="n_dur" class="input"><option value="5">5 minutes</option><option value="10" selected>10 minutes</option><option value="15">15 minutes</option><option value="20">20 minutes</option><option value="30">30 minutes</option><option value="custom">Custom…</option></select></div>
          <div class="field hidden" id="n_cw"><label for="n_custom">Custom minutes (1 to 240)</label><input id="n_custom" type="number" min="1" max="240" class="input" value="45"></div></div>
        <div class="row"><div class="field"><label for="n_code">Attendance code <span class="muted">(optional)</span></label><div style="display:flex;gap:8px"><input id="n_code" class="input" maxlength="12" placeholder="e.g. 4821" autocomplete="off"><button type="button" class="btn" id="n_gen" title="Generate">🎲</button></div><div class="hint">Students must type this code, so read it out or show it in class. It stops forwarded links being used by people who aren't there.</div></div>
          <div class="field"><label for="n_late">Mark as late after <span class="muted">(optional, minutes)</span></label><input id="n_late" type="number" min="1" max="240" class="input" placeholder="e.g. 10"></div></div>
        <label style="display:flex;gap:10px;align-items:center;margin-bottom:6px"><input type="checkbox" id="n_now" checked> Start attendance immediately</label>
        <div class="err" id="nerr" role="alert"></div>
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="nsave"><span class="lbl">Create session</span></button></div></form>`);
    const el = m.el;
    const staffTxt = () => { const c = usable.find((x) => x.id === $("#n_course", el).value); const names = (c?.course_assignments || []).map((a) => `${a.assignment_role === "lecturer" ? "Lecturer" : "Rep"}: ${a.profiles?.full_name || a.profiles?.email}`); $("#n_staff", el).textContent = names.length ? names.join(" · ") : "No lecturer or course rep assigned yet."; };
    staffTxt(); $("#n_course", el).addEventListener("change", staffTxt);
    $("#n_dur", el).addEventListener("change", (e) => $("#n_cw", el).classList.toggle("hidden", e.target.value !== "custom"));
    $("#n_gen", el).addEventListener("click", () => { $("#n_code", el).value = String(Math.floor(1000 + Math.random() * 9000)); });
    $("[data-close]", el).addEventListener("click", m.close);
    $("#nf", el).addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#nerr", el); err.textContent = "";
      const dur = $("#n_dur", el).value === "custom" ? Number($("#n_custom", el).value) : Number($("#n_dur", el).value);
      const title = $("#n_title", el).value.trim(), code = $("#n_code", el).value.trim(), late = $("#n_late", el).value;
      if (title.length < 2) return (err.textContent = "Give the session a title.");
      if (!Number.isInteger(dur) || dur < 1 || dur > 240) return (err.textContent = "Duration must be between 1 and 240 minutes.");
      if (code && !/^[A-Za-z0-9]{3,12}$/.test(code)) return (err.textContent = "The code must be 3 to 12 letters or numbers.");
      setBusy($("#nsave", el), true, "Creating…");
      const r = await call(sb, "create_session", { p_course: $("#n_course", el).value, p_title: title, p_date: $("#n_date", el).value || null, p_start: $("#n_time", el).value || null, p_duration: dur, p_code: code || null, p_late_after: late ? Number(late) : null });
      if (!r.ok) { setBusy($("#nsave", el), false); err.textContent = r.message; return; }
      if ($("#n_now", el).checked) {
        const o = await call(sb, "open_session", { p_session: r.id });
        setBusy($("#nsave", el), false);
        if (!o.ok) { toast(`Session created, but it couldn't start: ${o.message}`, "bad", 7000); m.close(); return load(); }
        toast(`Attendance is open (${o.roster_size} students expected).`, "good"); m.close(); location.hash = `#/sessions/${r.id}`; return;
      }
      setBusy($("#nsave", el), false); toast("Session created. Press Start when you're ready.", "good"); m.close(); load();
    });
  }
  await load();
  return {};
}

async function reopenDialog(sb, s, done) {
  const m = openModal(`<h3>🔓 Reopen session</h3><p class="muted">Students will be able to mark attendance again. This is recorded in the audit log.</p>
    <div class="row"><div class="field"><label for="r_min">Reopen for</label><select id="r_min" class="input"><option value="5">5 minutes</option><option value="10" selected>10 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option></select></div></div>
    <div class="field"><label for="r_why">Reason</label><input id="r_why" class="input" maxlength="300" placeholder="e.g. Network was down for the class"></div><div class="err" id="r_err"></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="r_go"><span class="lbl">Reopen</span></button></div>`);
  $("[data-close]", m.el).addEventListener("click", m.close);
  $("#r_go", m.el).addEventListener("click", async () => {
    const why = $("#r_why", m.el).value.trim();
    if (why.length < 3) return ($("#r_err", m.el).textContent = "Please give a reason.");
    setBusy($("#r_go", m.el), true);
    const r = await call(sb, "reopen_session", { p_session: s.id, p_minutes: Number($("#r_min", m.el).value), p_reason: why });
    setBusy($("#r_go", m.el), false);
    if (!r.ok) return ($("#r_err", m.el).textContent = r.message);
    toast("Session reopened.", "good"); m.close(); done?.();
  });
}

// ========================================================================= live monitor
async function monitor(ctx, root, id) {
  const { sb, isAdmin } = ctx;
  let sess = null, roster = [], records = [], sum = null, deadline = 0, qrUrl = "", tab = "present", search = "", known = new Set(), first = true;
  let channel = null, tickT = null, pollT = null, refreshT = null, proj = null, dead = false, canManage = isAdmin;
  let expiring = false;
  root.innerHTML = `<div class="skeleton" style="height:120px;margin-bottom:12px"></div><div class="skeleton" style="height:300px"></div>`;

  const { data, error } = await q(sb.from("attendance_sessions").select("id,title,session_date,duration_minutes,attendance_code,join_code,status,opens_at,closes_at,public_token,late_after_minutes,course_id,courses(code,name)").eq("id", id).single());
  if (error || !data) { root.innerHTML = `<div class="card">${emptyState("🔍", "Session not found", "It may have been removed, or you may not have access to it.")}<div style="text-align:center"><a class="btn" href="#/sessions">← Back to sessions</a></div></div>`; return {}; }
  sess = data;
  if (!isAdmin) { const { data: as } = await q(sb.from("course_assignments").select("can_create_sessions").eq("course_id", sess.course_id).eq("user_id", ctx.user.id)); canManage = !!as?.[0]?.can_create_sessions; }
  const link = sessionLink(sess.public_token);
  qDataUrl();
  async function qDataUrl() { try { qrUrl = await qrDataUrl(link, 520); } catch (e) { console.error(e); } paintQr(); }

  root.innerHTML = `
    <div class="page-head"><div><a href="#/sessions" class="muted">← All sessions</a><h1 style="margin-top:6px">${esc(sess.courses?.code)} · ${esc(sess.title)}</h1><p>${esc(sess.courses?.name)} · ${esc(fmtDate(sess.session_date))} · <span id="stBadge"></span> <span id="liveTag" class="muted"></span></p></div><div id="topActions" style="display:flex;gap:8px;flex-wrap:wrap"></div></div>
    <div class="monitor">
      <div class="card qr-box" id="left"></div>
      <div id="right"></div></div>`;

  function paintQr() { const b = $("#qrImg", root); if (b && qrUrl) b.src = qrUrl; }
  const remaining = () => Math.max(0, Math.ceil((deadline - performance.now()) / 1000));

  function paintLeft() {
    const st = sum?.status || effStatus(sess);
    $("#stBadge", root).innerHTML = (st === "open" ? '<span class="live-dot"></span> ' : "") + statusBadge(st);
    $("#left", root).innerHTML = `
      ${st === "open" ? `<div class="big-timer" id="bigT">${mmss(remaining())}</div><div class="muted" style="margin-bottom:10px">time left to mark attendance</div>` : `<div class="muted" style="margin-bottom:10px">${st === "scheduled" ? "Not started yet" : st === "closed" ? "Session closed" : "Session expired"}</div>`}
      <img id="qrImg" alt="QR code for the attendance link" ${qrUrl ? `src="${qrUrl}"` : ""}>
      ${sess.join_code ? `<div style="margin-top:12px"><div class="muted" style="font-size:.78rem">CLASS CODE (students can type this instead of scanning)</div><div style="font:800 2.2rem var(--font-head);letter-spacing:.25em" class="gradient-text">${esc(sess.join_code)}</div></div>` : ""}
      ${sess.attendance_code ? `<div style="margin-top:12px"><div class="muted" style="font-size:.78rem">ATTENDANCE CODE (extra code students must also enter)</div><div style="font:800 2rem var(--font-head);letter-spacing:.2em" class="gradient-text">${esc(sess.attendance_code)}</div></div>` : ""}
      <div class="link-box"><input class="input" readonly value="${esc(link)}" id="linkIn" aria-label="Attendance link"><button class="btn" id="copyBtn">Copy</button></div>
      <div style="display:grid;gap:8px;margin-top:12px"><button class="btn" id="projBtn">🖥️ Show on projector</button></div>`;
    paintQr();
    $("#copyBtn", root).addEventListener("click", async () => toast((await copyText(link)) ? "Link copied." : "Couldn't copy automatically. Select the link and copy it.", "good"));
    $("#linkIn", root).addEventListener("focus", (e) => e.target.select());
    $("#projBtn", root).addEventListener("click", showProjector);
    const ta = $("#topActions", root); ta.innerHTML = "";
    if (st === "scheduled" && canManage) ta.innerHTML = '<button class="btn primary" id="startBtn">▶ Start attendance now</button>';
    if (st === "open" && canManage) ta.innerHTML = '<button class="btn danger" id="closeBtn">⏹ Close session</button>';
    if ((st === "closed" || st === "expired") && isAdmin) ta.innerHTML = '<button class="btn" id="reopenBtn">🔓 Reopen</button>';
    $("#startBtn", root)?.addEventListener("click", async (e) => { setBusy(e.currentTarget, true); const r = await call(sb, "open_session", { p_session: id }); setBusy(e.currentTarget, false); if (!r.ok) return toast(r.message, "bad"); toast(`Attendance is open (${r.roster_size} students expected).`, "good"); await full(); });
    $("#closeBtn", root)?.addEventListener("click", async () => { if (!(await confirmDialog({ title: "Close this session?", body: "Students will no longer be able to mark attendance.", confirmText: "Close session", danger: true }))) return; const r = await call(sb, "close_session", { p_session: id }); if (!r.ok) return toast(r.message, "bad"); toast("Session closed.", "good"); await full(); });
    $("#reopenBtn", root)?.addEventListener("click", () => reopenDialog(sb, sess, full));
  }

  function paintRight() {
    const st = sum?.status || effStatus(sess), done = st === "closed" || st === "expired";
    const rate = sum?.attendance_rate;
    const presentIds = new Set(records.map((r) => r.student_id));
    const rmap = new Map(roster.map((r) => [r.student_id, r.students]));
    const needle = search.toLowerCase();
    const match = (stu) => !needle || (stu?.full_name || "").toLowerCase().includes(needle) || (stu?.student_id || "").toLowerCase().includes(needle);
    const presentRows = [...records].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).filter((r) => match(rmap.get(r.student_id)));
    const absentRows = roster.filter((r) => !presentIds.has(r.student_id) && match(r.students));
    const T = (label, val, col = "") => `<div class="tile"><b ${col ? `style="color:var(--${col})"` : ""} data-n="${val ?? ""}">${val ?? "–"}</b><span>${label}</span></div>`;
    $("#right", root).innerHTML = `
      <div class="counts">${T("Enrolled", sum?.enrolled ?? roster.length)}${T("Present", (sum?.present ?? 0) + (sum?.late ?? 0), "green")}${sum?.late ? T("Late", sum.late, "amber") : ""}${T("Excused", sum?.excused ?? 0, "cyan")}${T("Absent", done ? sum?.absent : null, "red")}${`<div class="tile"><b>${rate == null ? "–" : Math.round(rate) + "%"}</b><span>Attendance</span></div>`}</div>
      <div class="card" style="padding:16px">
        <div class="toolbar" style="margin-bottom:8px"><div class="search"><input id="mSearch" class="input" placeholder="Search by name or Student ID…" value="${esc(search)}" autocomplete="off"></div>
          <div class="tabs" style="margin:0"><button class="tab ${tab === "present" ? "active" : ""}" data-tab="present">✅ Present (${records.length})</button><button class="tab ${tab === "absent" ? "active" : ""}" data-tab="absent">${done ? "❌ Absent" : "⏳ Not yet"} (${roster.length - presentIds.size < 0 ? 0 : roster.length - presentIds.size})</button></div></div>
        <div id="feed" style="max-height:520px;overflow:auto">
          ${tab === "present" ? (presentRows.length ? presentRows.map((r) => { const stu = rmap.get(r.student_id); const isNew = !first && !known.has(r.id); return `<div class="feed-row ${isNew ? "new" : ""}"><span><b>${esc(stu?.full_name || "Unknown")}</b> <span class="muted">${esc(stu?.student_id || "")}</span> ${r.status !== "present" ? statusBadge(r.status) : ""} ${r.source === "admin_override" ? '<span class="badge warn" title="Set by an administrator">override</span>' : ""}</span><span style="display:flex;gap:8px;align-items:center"><span class="muted">${esc(fmtTime(r.submitted_at))}</span>${isAdmin ? `<button class="btn small" data-undo="${esc(r.student_id)}" title="Remove this record">↩︎</button>` : ""}</span></div>`; }).join("") : emptyState("👀", needle ? "No match" : "Waiting for students…", needle ? "" : "Check-ins will appear here the moment they happen."))
          : (absentRows.length ? absentRows.map((r) => `<div class="feed-row"><span><b>${esc(r.students?.full_name)}</b> <span class="muted">${esc(r.students?.student_id)}</span></span>${isAdmin ? `<span style="display:flex;gap:6px"><button class="btn small primary" data-mark="${esc(r.student_id)}" data-as="mark_present">Mark present</button><button class="btn small" data-mark="${esc(r.student_id)}" data-as="mark_excused">Excused</button></span>` : ""}</div>`).join("") : emptyState("🎉", needle ? "No match" : "Everyone is accounted for", ""))}
        </div></div>`;
    records.forEach((r) => known.add(r.id)); first = false;
    $$("[data-tab]", root).forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; paintRight(); }));
    const si = $("#mSearch", root);
    si.addEventListener("input", debounce((e) => { search = e.target.value.trim(); paintRight(); const n = $("#mSearch", root); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 200));
    $$("[data-mark]", root).forEach((b) => b.addEventListener("click", () => override(b.dataset.mark, b.dataset.as, rmap.get(b.dataset.mark))));
    $$("[data-undo]", root).forEach((b) => b.addEventListener("click", () => override(b.dataset.undo, "remove", rmap.get(b.dataset.undo))));
  }

  async function override(studentId, action, stu) {
    const verb = { mark_present: "Mark present", mark_excused: "Mark excused", remove: "Remove attendance for" }[action];
    const reason = await confirmDialog({ title: `${verb} ${stu?.full_name || "student"}?`, body: "This overrides the normal check-in rules (including the device restriction). It is recorded in the audit log.", confirmText: verb.split(" ")[0] === "Remove" ? "Remove" : "Confirm", danger: action === "remove", reason: true });
    if (!reason) return;
    const r = await call(sb, "admin_override_attendance", { p_session: id, p_student: studentId, p_action: action, p_reason: reason });
    if (!r.ok) return toast(r.message, "bad");
    toast("Attendance updated.", "good"); await data_();
  }

  async function data_() {
    if (dead) return;
    try {
      const [ro, re] = await Promise.all([
        fetchAll(() => sb.from("session_roster").select("student_id,students(student_id,full_name)").eq("session_id", id).order("student_id")),
        fetchAll(() => sb.from("attendance_records").select("id,student_id,status,source,submitted_at").eq("session_id", id).order("submitted_at").order("id")),
      ]);
      roster = ro; records = re;
    } catch (e) { console.error(e); toast("Couldn't refresh the list. Retrying…", "bad", 2500); }
    const s = await call(sb, "session_summary", { p_session: id });
    if (dead) return;
    if (s.ok) { sum = s; deadline = performance.now() + s.seconds_remaining * 1000; }
    const prev = $("#left", root)?.dataset.st; const st = sum?.status || effStatus(sess);
    if (prev !== st) { await reload(); }
    paintRight(); tickPaint();
  }
  async function reload() { const { data: d } = await q(sb.from("attendance_sessions").select("id,title,session_date,duration_minutes,attendance_code,join_code,status,opens_at,closes_at,public_token,late_after_minutes,course_id,courses(code,name)").eq("id", id).single()); if (d) sess = d; paintLeft(); const l = $("#left", root); if (l) l.dataset.st = sum?.status || effStatus(sess); }
  async function full() { await data_(); await reload(); paintLeft(); paintRight(); }

  function tickPaint() {
    const st = sum?.status || effStatus(sess);
    const t = $("#bigT", root); const rem = remaining();
    if (t) { t.textContent = mmss(rem); t.classList.toggle("low", rem <= 60 && rem > 20); t.classList.toggle("crit", rem <= 20 && rem > 0); }
    if (proj) { const p = $("#pT", proj); if (p) p.textContent = mmss(rem); }
    if (st === "open" && rem <= 0 && !expiring) { expiring = true; setTimeout(async () => { try { await full(); } finally { expiring = false; } }, 1200); }
  }

  function showProjector() {
    if (proj) return;
    proj = document.createElement("div"); proj.className = "proj";
    proj.innerHTML = `<div><h2>${esc(sess.courses?.code)} · ${esc(sess.title)}</h2><p class="muted" style="font-size:1.2rem">Scan to mark attendance</p><img src="${qrUrl}" alt="QR code">
      ${sess.join_code ? `<div class="muted" style="margin-top:14px">CLASS CODE: open Atendar, tap Mark Attendance, type</div><div class="big-code">${esc(sess.join_code)}</div>` : ""}
      ${sess.attendance_code ? `<div class="muted" style="margin-top:14px">ATTENDANCE CODE</div><div class="big-code">${esc(sess.attendance_code)}</div>` : ""}
      <div class="big-timer" id="pT" style="font-size:clamp(2rem,6vw,4rem)">${mmss(remaining())}</div><button class="btn" id="pClose">✕ Close</button></div>`;
    document.body.appendChild(proj);
    const close = () => { proj?.remove(); proj = null; document.removeEventListener("keydown", onKey); };
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    $("#pClose", proj).addEventListener("click", close);
  }

  // realtime + fallbacks
  channel = sb.channel(`att-${id}`).on("postgres_changes", { event: "*", schema: "public", table: "attendance_records", filter: `session_id=eq.${id}` }, () => { clearTimeout(refreshT); refreshT = setTimeout(data_, 250); })
    .subscribe((status) => { const t = $("#liveTag", root); if (t) t.innerHTML = status === "SUBSCRIBED" ? '<span class="badge good">⚡ live</span>' : '<span class="badge warn">refreshing every few seconds</span>'; });
  tickT = setInterval(tickPaint, 250);
  pollT = setInterval(() => { if (!document.hidden) data_(); }, 8000); // safety net if realtime drops
  const vis = () => { if (!document.hidden) data_(); };
  document.addEventListener("visibilitychange", vis);

  await data_(); paintLeft(); const l0 = $("#left", root); if (l0) l0.dataset.st = sum?.status || effStatus(sess); paintRight();

  return { unmount() { dead = true; clearInterval(tickT); clearInterval(pollT); clearTimeout(refreshT); document.removeEventListener("visibilitychange", vis); proj?.remove(); if (channel) sb.removeChannel(channel); } };
}
