import { esc, toast, setBusy, debounce, fmtDate, fmtDateTime, statusBadge, emptyState, skeletonRows, initReveal, countUp, ringHtml, animateRings, $, $$ } from "/js/ui.js";
import { loadLookups, options, nameOf, fetchAll, chunk, isFinished, menuHtml, wireMenus } from "/js/admin/common.js";
import { exportTable } from "/js/admin/export.js";

const PAGE = 50;
const FMT = [{ act: "pdf", label: "PDF" }, { act: "xlsx", label: "Excel (.xlsx)" }, { act: "docx", label: "Word (.docx)" }];

export async function mount(ctx, root) {
  const { sb } = ctx;
  const L = await loadLookups(sb);
  const { data: courseList } = await sb.from("courses").select("id,code,name").order("code");
  const F = { course: "", programme: "", level: "", group: "", period: "", from: "", to: "", student: "", status: "" };
  let sessions = [], rows = [], page = 0, reqId = 0;

  root.innerHTML = `
    <div class="page-head reveal"><div><h1>Records &amp; reports</h1><p>Attendance history across courses, dates and students. Exports follow your filters.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${menuHtml("⬇️ Export summary", FMT.map((f) => ({ act: "sum:" + f.act, label: f.label })))}${menuHtml("⬇️ Export all records", FMT.map((f) => ({ act: "det:" + f.act, label: f.label })))}</div></div>
    <div class="card reveal" style="padding:16px;margin-bottom:16px">
      <div class="toolbar" style="margin:0">
        <select id="fCourse" class="input"><option value="">All courses</option>${(courseList || []).map((c) => `<option value="${esc(c.id)}">${esc(c.code)} · ${esc(c.name)}</option>`).join("")}</select>
        <select id="fProg" class="input">${options(L.programmes, { placeholder: "All programmes" })}</select>
        <select id="fGroup" class="input">${options(L.groups, { placeholder: "All classes" })}</select>
        <select id="fPeriod" class="input">${options(L.periods, { placeholder: "Any academic period" })}</select>
        <label class="muted" style="display:flex;gap:6px;align-items:center">From <input id="fFrom" type="date" class="input"></label>
        <label class="muted" style="display:flex;gap:6px;align-items:center">To <input id="fTo" type="date" class="input"></label>
        <div class="search" style="flex:1 1 220px"><input id="fStudent" class="input" placeholder="Student name or ID…" autocomplete="off"></div>
        <select id="fStatus" class="input"><option value="">Any status</option><option value="present">Present</option><option value="late">Late</option><option value="excused">Excused</option><option value="absent">Absent</option></select>
        <button class="btn small ghost" id="clear">Clear filters</button></div></div>
    <div id="summary" class="grid-cards"></div>
    <div class="card reveal" style="padding:14px;margin-bottom:16px"><h3>Sessions</h3><div id="sessTable">${skeletonRows(3)}</div></div>
    <div class="card reveal" style="padding:14px"><h3>Individual records</h3><div id="detTable"></div><div class="pager" id="pager"></div></div>`;
  initReveal();
  wireMenus(root, (act) => { const [kind, fmt] = act.split(":"); if (kind === "sum") exportSummary(fmt); else exportDetail(fmt); });

  const rate = (p, l, e, n) => (n - e > 0 ? Math.round((1000 * (p + l)) / (n - e)) / 10 : null);

  async function build() {
    const my = ++reqId;
    $("#sessTable", root).innerHTML = skeletonRows(3);
    try {
      const ss = await fetchAll(() => {
        let qb = sb.from("attendance_sessions").select("id,title,session_date,status,closes_at,course_id,courses!inner(code,name,programme_id,level_id,class_group_id,academic_period_id)").neq("status", "scheduled").order("session_date", { ascending: false }).order("id");
        if (F.course) qb = qb.eq("course_id", F.course);
        if (F.programme) qb = qb.eq("courses.programme_id", F.programme);
        if (F.level) qb = qb.eq("courses.level_id", F.level);
        if (F.group) qb = qb.eq("courses.class_group_id", F.group);
        if (F.period) qb = qb.eq("courses.academic_period_id", F.period);
        if (F.from) qb = qb.gte("session_date", F.from);
        if (F.to) qb = qb.lte("session_date", F.to);
        return qb;
      });
      const ids = ss.map((s) => s.id);
      const roster = [], recs = [];
      for (const part of chunk(ids, 40)) {
        roster.push(...await fetchAll(() => sb.from("session_roster").select("session_id,student_id,students(student_id,full_name)").in("session_id", part).order("session_id").order("student_id")));
        recs.push(...await fetchAll(() => sb.from("attendance_records").select("id,session_id,student_id,status,submitted_at").in("session_id", part).order("id")));
      }
      if (my !== reqId) return;
      const rec = new Map(recs.map((r) => [r.session_id + "|" + r.student_id, r]));
      const sMap = new Map(ss.map((s) => [s.id, s]));
      const out = [];
      roster.forEach((r) => {
        const s = sMap.get(r.session_id), x = rec.get(r.session_id + "|" + r.student_id), fin = isFinished(s);
        const status = x ? x.status : fin ? "absent" : "pending";
        out.push({ sid: s.id, date: s.session_date, code: s.courses.code, course: s.courses.name, title: s.title, student_id: r.students?.student_id || "", name: r.students?.full_name || "", status, time: x?.submitted_at || null, finished: fin });
      });
      // records for students not on the roster (should be rare)
      recs.forEach((x) => { if (!roster.some((r) => r.session_id === x.session_id && r.student_id === x.student_id)) { const s = sMap.get(x.session_id); out.push({ sid: s.id, date: s.session_date, code: s.courses.code, course: s.courses.name, title: s.title, student_id: "?", name: "(not on roster)", status: x.status, time: x.submitted_at, finished: isFinished(s) }); } });
      sessions = ss; rows = out; page = 0; render();
    } catch (e) { console.error(e); if (my === reqId) $("#sessTable", root).innerHTML = '<div class="notice bad">Could not load records. Please check your connection and try again.</div>'; }
  }

  function filtered() {
    const n = F.student.toLowerCase();
    return rows.filter((r) => r.status !== "pending" || F.status === "" ).filter((r) => (!n || r.name.toLowerCase().includes(n) || r.student_id.toLowerCase().includes(n)) && (!F.status || r.status === F.status));
  }
  function perSession(list) {
    const m = new Map();
    list.forEach((r) => {
      const s = m.get(r.sid) || { sid: r.sid, date: r.date, code: r.code, course: r.course, title: r.title, n: 0, present: 0, late: 0, excused: 0, absent: 0, pending: 0, finished: r.finished };
      s.n++; if (s[r.status] != null) s[r.status]++; m.set(r.sid, s);
    });
    return [...m.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).map((s) => ({ ...s, rate: s.finished ? rate(s.present, s.late, s.excused, s.n) : null }));
  }
  const describe = () => [F.course && (courseList || []).find((c) => c.id === F.course)?.code, F.programme && nameOf(L.programmes, F.programme), F.level && nameOf(L.levels, F.level), F.group && nameOf(L.groups, F.group), F.period && nameOf(L.periods, F.period), F.from && `from ${fmtDate(F.from)}`, F.to && `to ${fmtDate(F.to)}`, F.student && `student “${F.student}”`, F.status && `status ${F.status}`].filter(Boolean).join(" · ") || "All sessions";

  function render() {
    const list = filtered(), ps = perSession(list);
    const tot = list.reduce((a, r) => { a.n++; if (r.finished || r.status !== "absent") a[r.status] = (a[r.status] || 0) + 1; return a; }, { n: 0 });
    const done = list.filter((r) => r.finished);
    const present = done.filter((r) => r.status === "present" || r.status === "late").length, exc = done.filter((r) => r.status === "excused").length;
    const overall = done.length - exc > 0 ? Math.round((1000 * present) / (done.length - exc)) / 10 : null;
    $("#summary", root).innerHTML = [["🗓️", "Sessions", ps.length], ["👥", "Student slots", done.length], ["✅", "Present / late", present], ["❌", "Absent", done.filter((r) => r.status === "absent").length]].map(([ic, l, n], i) => `<div class="card stat" style="--i:${i}"><span class="ic">${ic}</span><small>${l}</small><b data-n="${n}">0</b></div>`).join("") +
      `<div class="card stat"><small>Attendance rate</small><div style="display:flex;justify-content:center;margin-top:6px">${ringHtml(overall, { size: 96, label: "overall" })}</div></div>`;
    $$("[data-n]", $("#summary", root)).forEach((b) => countUp(b, Number(b.dataset.n), { duration: 800 })); animateRings($("#summary", root));

    $("#sessTable", root).innerHTML = ps.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Course</th><th>Session</th><th>Enrolled</th><th>Present</th><th>Late</th><th>Excused</th><th>Absent</th><th>Rate</th><th></th></tr></thead><tbody>
      ${ps.map((s, i) => `<tr style="--i:${i}"><td>${esc(fmtDate(s.date))}</td><td><b>${esc(s.code)}</b> <span class="muted">${esc(s.course)}</span></td><td>${esc(s.title)}</td><td>${s.n}</td><td>${s.present}</td><td>${s.late}</td><td>${s.excused}</td><td>${s.finished ? s.absent : "–"}</td><td>${s.rate == null ? "–" : s.rate + "%"}</td><td><span data-sid="${esc(s.sid)}">${menuHtml("⬇️", FMT)}</span></td></tr>`).join("")}</tbody></table></div>`
      : emptyState("🗂️", "No sessions match these filters", "Try widening the date range or clearing a filter.");
    wireMenus($("#sessTable", root), (fmt, m) => exportSession(m.closest("[data-sid]").dataset.sid, fmt));
    drawDetail(list);
  }

  function drawDetail(list) {
    const box = $("#detTable", root), total = list.length;
    if (!total) { box.innerHTML = emptyState("🔎", "No individual records", ""); $("#pager", root).innerHTML = ""; return; }
    const slice = list.slice(page * PAGE, page * PAGE + PAGE);
    box.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Course</th><th>Session</th><th>Student</th><th>Student ID</th><th>Status</th><th>Time</th></tr></thead><tbody>
      ${slice.map((r, i) => `<tr style="--i:${i}"><td>${esc(fmtDate(r.date))}</td><td>${esc(r.code)}</td><td>${esc(r.title)}</td><td><b>${esc(r.name)}</b></td><td>${esc(r.student_id)}</td><td>${statusBadge(r.status)}</td><td>${r.time ? esc(fmtDateTime(r.time)) : "–"}</td></tr>`).join("")}</tbody></table></div>`;
    const to = Math.min(total, page * PAGE + PAGE);
    $("#pager", root).innerHTML = `<span>Showing ${page * PAGE + 1}–${to} of ${total}</span><div class="btns"><button class="btn small" id="pp" ${page === 0 ? "disabled" : ""}>← Prev</button><button class="btn small" id="pn" ${to >= total ? "disabled" : ""}>Next →</button></div>`;
    $("#pp", root)?.addEventListener("click", () => { page--; drawDetail(list); });
    $("#pn", root)?.addEventListener("click", () => { page++; drawDetail(list); });
  }

  // ------------------------------------------------------------------ exports
  const sumCols = [{ key: "date", label: "Date" }, { key: "code", label: "Code" }, { key: "course", label: "Course" }, { key: "title", label: "Session" }, { key: "n", label: "Enrolled" }, { key: "present", label: "Present" }, { key: "late", label: "Late" }, { key: "excused", label: "Excused" }, { key: "absent", label: "Absent" }, { key: "rate", label: "Rate" }];
  const detCols = [{ key: "date", label: "Date" }, { key: "code", label: "Code" }, { key: "title", label: "Session" }, { key: "student_id", label: "Student ID" }, { key: "name", label: "Student" }, { key: "status", label: "Status" }, { key: "time", label: "Time" }];
  const guard = async (fn) => { try { await fn(); } catch (e) { console.error(e); toast("Export failed. Please try again.", "bad"); } };
  const sumRows = (ps) => ps.map((s) => ({ ...s, date: fmtDate(s.date), absent: s.finished ? s.absent : "open", rate: s.rate == null ? "–" : s.rate + "%" }));
  const detRows = (l) => l.map((r) => ({ ...r, date: fmtDate(r.date), time: r.time ? fmtDateTime(r.time) : "" }));
  function totals(ps) { const t = ps.reduce((a, s) => ({ n: a.n + s.n, p: a.p + s.present + s.late, e: a.e + s.excused, f: a.f + (s.finished ? s.n : 0) }), { n: 0, p: 0, e: 0, f: 0 }); return [["Sessions", ps.length], ["Student slots", t.n], ["Present / late", t.p], ["Overall rate", t.f - t.e > 0 ? Math.round((1000 * t.p) / (t.f - t.e)) / 10 + "%" : "–"]]; }

  const exportSummary = (fmt) => guard(async () => { const ps = perSession(filtered()); await exportTable({ format: fmt, title: "Attendance summary", subtitle: describe(), summary: totals(ps), columns: sumCols, rows: sumRows(ps), filename: `attendance_summary_${new Date().toISOString().slice(0, 10)}` }); });
  const exportDetail = (fmt) => guard(async () => { const l = filtered(), ps = perSession(l); await exportTable({ format: fmt, title: "Attendance records", subtitle: describe(), summary: totals(ps), columns: detCols, rows: detRows(l), filename: `attendance_records_${new Date().toISOString().slice(0, 10)}` }); });
  const exportSession = (sid, fmt) => guard(async () => { const l = filtered().filter((r) => r.sid === sid), ps = perSession(l), s = ps[0]; if (!s) return; await exportTable({ format: fmt, title: `${s.code} · ${s.title}`, subtitle: `${s.course} · ${fmtDate(s.date)}`, summary: [["Enrolled", s.n], ["Present", s.present], ["Late", s.late], ["Excused", s.excused], ["Absent", s.finished ? s.absent : "open"], ["Rate", s.rate == null ? "–" : s.rate + "%"]], columns: detCols, rows: detRows(l), filename: `session_${s.code}_${s.date}` }); });

  // ------------------------------------------------------------------ filter wiring
  const map = { fCourse: "course", fProg: "programme", fGroup: "group", fPeriod: "period", fFrom: "from", fTo: "to", fStatus: "status" };
  Object.entries(map).forEach(([id, k]) => $("#" + id, root).addEventListener("change", (e) => { F[k] = e.target.value; (k === "status" ? (page = 0, render) : build)(); }));
  $("#fStudent", root).addEventListener("input", debounce((e) => { F.student = e.target.value.trim(); page = 0; render(); }, 250));
  $("#clear", root).addEventListener("click", () => { Object.keys(F).forEach((k) => (F[k] = "")); $$("select.input,input.input", root).forEach((i) => (i.value = "")); build(); });

  await build();
  return {};
}
