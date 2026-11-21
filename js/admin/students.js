import { esc, openModal, confirmDialog, toast, setBusy, debounce, fmtDate, statusBadge, emptyState, ringHtml, animateRings, countUp, skeletonRows, initReveal, $, $$ } from "/js/ui.js";
import { call, q } from "/js/api.js";
import { normalizeGhPhone, normalizeName, normalizeStudentId, validName, validStudentId } from "/js/validators.js";
import { loadLookups, options, nameOf, STUDENT_COLS, menuHtml, wireMenus } from "/js/admin/common.js";
import { exportTable } from "/js/admin/export.js";

const PAGE = 25;

export async function mount(ctx, root) {
  const { sb, isAdmin } = ctx;
  const L = await loadLookups(sb);
  const S = { q: "", programme: "", level: "", group: "", status: "", page: 0, total: 0, rows: [] };
  let reqId = 0;

  root.innerHTML = `
    <div class="page-head reveal"><div><h1>Students</h1><p>${isAdmin ? "Search, manage and review every registered student." : "Students enrolled in your courses."}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${isAdmin ? menuHtml("⬇️ Export list", [{ act: "pdf", label: "PDF" }, { act: "xlsx", label: "Excel (.xlsx)" }, { act: "docx", label: "Word (.docx)" }]) : ""}
        ${isAdmin ? '<button class="btn primary" id="addBtn"><span class="lbl">➕ Add student</span></button>' : ""}
      </div></div>
    <div class="toolbar reveal">
      <div class="search"><input id="search" class="input" placeholder="Search by name, Student ID${isAdmin ? " or WhatsApp number" : ""}…" autocomplete="off"></div>
      <select id="fProg" class="input">${options(L.programmes, { placeholder: "All programmes" })}</select>
      <select id="fLevel" class="input">${options(L.levels, { placeholder: "All levels" })}</select>
      <select id="fGroup" class="input">${options(L.groups, { placeholder: "All groups" })}</select>
      <select id="fStatus" class="input"><option value="">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
    </div>
    <div class="card reveal" style="padding:14px"><div id="table">${skeletonRows(6)}</div><div class="pager" id="pager"></div></div>`;
  initReveal();
  wireMenus(root, (act) => exportList(act));

  // ---------------------------------------------------------------- list
  async function load() {
    const my = ++reqId;
    $("#table", root).innerHTML = skeletonRows(5);
    let rows = [], total = 0, err = null;
    if (isAdmin) {
      const r = await call(sb, "admin_list_students", {
        p_query: S.q || null, p_programme: S.programme || null, p_level: S.level || null,
        p_class_group: S.group || null, p_status: S.status || null, p_limit: PAGE, p_offset: S.page * PAGE,
      });
      if (!r.ok) err = r.message; else { rows = r.rows; total = r.total; }
    } else {
      const clean = S.q.replace(/[%,()*\\]/g, " ").trim();
      let qb = sb.from("students").select(STUDENT_COLS, { count: "exact" }).order("full_name").range(S.page * PAGE, S.page * PAGE + PAGE - 1);
      if (S.programme) qb = qb.eq("programme_id", S.programme);
      if (S.level) qb = qb.eq("level_id", S.level);
      if (S.group) qb = qb.eq("class_group_id", S.group);
      if (S.status) qb = qb.eq("status", S.status);
      if (clean) qb = qb.or(`full_name.ilike.%${clean}%,student_id.ilike.%${clean.replace(/\s+/g, "").toUpperCase()}%`);
      const { data, error, count } = await qb;
      if (error) err = "Could not load students."; else { rows = data; total = count ?? data.length; }
    }
    if (my !== reqId) return;
    S.rows = rows; S.total = total;
    if (err) { $("#table", root).innerHTML = `<div class="notice bad">${esc(err)}</div>`; return; }
    renderTable();
  }

  function renderTable() {
    const box = $("#table", root);
    if (!S.rows.length) {
      box.innerHTML = emptyState("🔎", S.q || S.programme || S.level || S.group || S.status ? "No students match your search" : "No students registered yet",
        isAdmin ? "Try different words, or add the student manually if they haven't registered." : "");
      $("#pager", root).innerHTML = ""; return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Student</th><th>Student ID</th>${isAdmin ? "<th>WhatsApp</th>" : ""}<th>Programme</th><th>Level</th><th>Group</th><th>Registered</th><th>Status</th><th></th></tr></thead><tbody>
      ${S.rows.map((s, i) => `<tr class="clickable" data-i="${i}" style="--i:${i}"><td><b>${esc(s.full_name)}</b></td><td>${esc(s.student_id)}</td>
        ${isAdmin ? `<td>${esc(s.whatsapp_number)}</td>` : ""}
        <td>${esc(s.programme ?? nameOf(L.programmes, s.programme_id))}</td><td>${esc(s.level ?? nameOf(L.levels, s.level_id))}</td><td>${esc(s.class_group ?? nameOf(L.groups, s.class_group_id))}</td>
        <td>${esc(fmtDate(s.created_at))}</td><td>${statusBadge(s.status)}</td>
        <td><div class="actions-cell"><button class="btn small" data-view="${i}">📊 View</button>${isAdmin ? `<button class="btn small" data-edit="${i}">✏️</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>`;
    const from = S.page * PAGE + 1, to = S.page * PAGE + S.rows.length;
    $("#pager", root).innerHTML = `<span>Showing ${from}–${to} of ${S.total}</span><div class="btns"><button class="btn small" id="prev" ${S.page === 0 ? "disabled" : ""}>← Prev</button><button class="btn small" id="next" ${to >= S.total ? "disabled" : ""}>Next →</button></div>`;
    $("#prev", root)?.addEventListener("click", () => { S.page--; load(); });
    $("#next", root)?.addEventListener("click", () => { S.page++; load(); });
    $$("tr[data-i]", box).forEach((tr) => tr.addEventListener("click", (e) => {
      const edit = e.target.closest("[data-edit]");
      const s = S.rows[Number(tr.dataset.i)];
      edit ? openForm(s) : openProfile(s);
    }));
  }

  const reset = () => { S.page = 0; load(); };
  $("#search", root).addEventListener("input", debounce((e) => { S.q = e.target.value.trim(); reset(); }, 350));
  [["fProg", "programme"], ["fLevel", "level"], ["fGroup", "group"], ["fStatus", "status"]].forEach(([id, k]) => $("#" + id, root).addEventListener("change", (e) => { S[k] = e.target.value; reset(); }));
  $("#addBtn", root)?.addEventListener("click", () => openForm(null));

  // ---------------------------------------------------------------- profile + analytics
  async function openProfile(s) {
    const m = openModal(`<div id="pbody">${skeletonRows(3)}</div>`, { wide: true });
    const r = await call(sb, "student_analytics", { p_student: s.id });
    const body = $("#pbody", m.el);
    if (!r.ok) { body.innerHTML = `<div class="notice bad">${esc(r.message)}</div><div class="actions"><button class="btn" data-close>Close</button></div>`; $("[data-close]", m.el).addEventListener("click", m.close); return; }
    const st = r.student, a = r.stats, wa = st.whatsapp_number ? st.whatsapp_number.replace("+", "") : null;
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
        <div><h3 style="margin-bottom:4px">${esc(st.full_name)}</h3><div class="muted">Student ID <b style="color:var(--text)">${esc(st.student_id)}</b> ${statusBadge(st.status)}</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${menuHtml("⬇️ Export history", [{ act: "pdf", label: "PDF" }, { act: "xlsx", label: "Excel (.xlsx)" }, { act: "docx", label: "Word (.docx)" }])}
          ${isAdmin ? '<button class="btn" id="pEdit">✏️ Edit</button>' : ""}
          ${isAdmin ? `<button class="btn ${st.status === "active" ? "danger" : "primary"}" id="pToggle">${st.status === "active" ? "Deactivate" : "Activate"}</button>` : ""}
        </div></div>
      <div class="chips" style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0"><span class="badge">${esc(st.programme)}</span><span class="badge">${esc(st.level)}</span><span class="badge">${esc(st.class_group)}</span>
        ${wa ? `<a class="badge good" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener noreferrer">💬 ${esc(st.whatsapp_number)}</a>` : ""}</div>
      <div class="card" style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin:14px 0">
        ${ringHtml(a.rate, { size: 150 })}
        <div style="flex:1;min-width:200px">
          <div style="font:800 2rem var(--font-head)">${a.summary ? `Attendance: ${esc(a.summary)}` : "No attendance history yet"}</div>
          <div style="font:700 1.2rem var(--font-head);margin:4px 0 14px" class="gradient-text">${a.rate == null ? "Attendance Rate: –" : `Attendance Rate: ${Number(a.rate) % 1 === 0 ? Number(a.rate) : Number(a.rate).toFixed(1)}%`}</div>
          <div class="counts"><div class="tile"><b>${a.eligible}</b><span>Eligible</span></div><div class="tile"><b style="color:var(--green)">${a.attended}</b><span>Attended</span></div><div class="tile"><b style="color:var(--red)">${a.missed}</b><span>Missed</span></div><div class="tile"><b style="color:var(--amber)">${a.excused}</b><span>Excused</span></div></div>
        </div></div>
      <h4>Sessions</h4>
      ${a.sessions.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Course</th><th>Session</th><th>Date</th><th>Status</th></tr></thead><tbody>
        ${a.sessions.map((x, i) => `<tr style="--i:${i}"><td><b>${esc(x.course_code)}</b> <span class="muted">${esc(x.course_name)}</span></td><td>${esc(x.title)}</td><td>${esc(fmtDate(x.session_date))}</td><td>${statusBadge(x.status)}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState("🗓️", "No attendance history yet", "This student has not been expected at any finished session.")}
      <div class="actions"><button class="btn" data-close>Close</button></div>`;
    animateRings(body);
    $("[data-close]", m.el).addEventListener("click", m.close);
    wireMenus(body, (fmt) => exportHistory(fmt, st, a));
    $("#pEdit", m.el)?.addEventListener("click", () => { m.close(); openForm({ id: st.id, student_id: st.student_id, full_name: st.full_name, whatsapp_number: st.whatsapp_number, status: st.status }, true); });
    $("#pToggle", m.el)?.addEventListener("click", async () => {
      const to = st.status === "active" ? "inactive" : "active";
      const reason = await confirmDialog({ title: `${to === "inactive" ? "Deactivate" : "Activate"} ${st.full_name}?`, body: to === "inactive" ? "An inactive student cannot mark attendance." : "The student will be able to mark attendance again.", confirmText: to === "inactive" ? "Deactivate" : "Activate", danger: to === "inactive", reason: true });
      if (!reason) return;
      const u = await call(sb, "admin_update_student", { p_id: st.id, p_changes: { status: to }, p_reason: reason });
      if (!u.ok) return toast(u.message, "bad");
      toast(`Student ${to === "active" ? "activated" : "deactivated"}.`, "good"); m.close(); load();
    });
  }

  async function exportHistory(fmt, st, a) {
    try {
      await exportTable({
        format: fmt, title: `Attendance history: ${st.full_name}`, subtitle: `${st.student_id} · ${st.programme} · ${st.level} · ${st.class_group}`,
        summary: [["Attendance", a.summary || "–"], ["Rate", a.rate == null ? "–" : `${a.rate}%`], ["Eligible", a.eligible], ["Attended", a.attended], ["Missed", a.missed], ["Excused", a.excused]],
        columns: [{ key: "code", label: "Course code" }, { key: "course", label: "Course" }, { key: "title", label: "Session" }, { key: "date", label: "Date" }, { key: "status", label: "Status" }],
        rows: a.sessions.map((x) => ({ code: x.course_code, course: x.course_name, title: x.title, date: fmtDate(x.session_date), status: x.status })),
        filename: `attendance_${st.student_id}`,
      });
    } catch (e) { console.error(e); toast("Export failed. Please try again.", "bad"); }
  }

  // ---------------------------------------------------------------- add / edit
  function openForm(s, fromProfile = false) {
    const editing = !!s?.id;
    const m = openModal(`
      <h3>${editing ? "Edit student" : "➕ Add student manually"}</h3>
      <p class="muted">${editing ? "Changes are recorded in the audit log." : "Adds the student to the same central register as self-registration. The record is active immediately."}</p>
      <form id="sf" novalidate>
        <div class="field"><label for="f_name">Full name</label><input id="f_name" class="input" maxlength="120" value="${esc(s?.full_name ?? "")}"></div>
        <div class="row">
          <div class="field"><label for="f_sid">Student ID</label><input id="f_sid" class="input" maxlength="12" value="${esc(s?.student_id ?? "")}" autocapitalize="characters"><div class="err" id="dup"></div></div>
          <div class="field"><label for="f_wa">WhatsApp number</label><input id="f_wa" class="input" inputmode="tel" value="${esc(s?.whatsapp_number ?? "")}" placeholder="0244123456"></div>
        </div>
        <div class="row">
          <div class="field"><label for="f_prog">Programme</label><select id="f_prog" class="input">${options(L.programmes, { placeholder: "Select…", selected: s?.programme_id })}</select></div>
          <div class="field"><label for="f_level">Level</label><select id="f_level" class="input">${options(L.levels, { placeholder: "Select…", selected: s?.level_id })}</select></div>
        </div>
        <div class="field"><label for="f_group">Class / group</label><select id="f_group" class="input"></select></div>
        ${editing ? `<div class="field"><label for="f_status">Status</label><select id="f_status" class="input"><option value="active"${s.status === "active" ? " selected" : ""}>Active</option><option value="inactive"${s.status === "inactive" ? " selected" : ""}>Inactive</option></select></div>` : ""}
        <div class="field"><label for="f_reason">Reason (recorded in the audit log)</label><input id="f_reason" class="input" maxlength="300" placeholder="${editing ? "e.g. Corrected spelling of name" : "e.g. Student could not register on their phone"}"></div>
        <div class="err" id="ferr" role="alert"></div>
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="fsave"><span class="lbl">${editing ? "Save changes" : "Add student"}</span></button></div>
      </form>`);
    const el = m.el;
    const fill = (keep) => {
      const p = $("#f_prog", el).value, l = $("#f_level", el).value;
      const list = L.groups.filter((g) => g.programme_id === p && g.level_id === l);
      $("#f_group", el).innerHTML = options(list, { placeholder: list.length ? "Select…" : "No groups for this programme/level", selected: keep });
      if (!keep && list.length === 1) $("#f_group", el).value = list[0].id;
    };
    const cur = editing ? L.groups.find((g) => g.id === s.class_group_id) : null;
    if (editing && !s.programme_id) { // from profile (ids not in analytics payload): look up
      q(sb.from("students").select("programme_id,level_id,class_group_id").eq("id", s.id).single()).then(({ data }) => {
        if (data) { $("#f_prog", el).value = data.programme_id; $("#f_level", el).value = data.level_id; fill(data.class_group_id); }
      });
    }
    fill(cur?.id);
    $("#f_prog", el).addEventListener("change", () => fill()); $("#f_level", el).addEventListener("change", () => fill());
    $("[data-close]", el).addEventListener("click", m.close);

    // duplicate check (manual add AND edit): "is this student already registered?"
    const dupCheck = debounce(async () => {
      const sid = normalizeStudentId($("#f_sid", el).value), out = $("#dup", el);
      out.textContent = ""; out.style.color = "";
      if (sid.length < 4 || (editing && sid === s.student_id)) return;
      const r = await call(sb, "admin_list_students", { p_query: sid, p_limit: 5 });
      const hit = r.ok && r.rows.find((x) => x.student_id === sid);
      if (hit) { out.style.color = "var(--amber)"; out.textContent = `Already registered: ${hit.full_name} (${hit.status}). Use their existing record instead.`; }
    }, 400);
    $("#f_sid", el).addEventListener("input", dupCheck);

    $("#sf", el).addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#ferr", el); err.textContent = "";
      const name = normalizeName($("#f_name", el).value), sid = normalizeStudentId($("#f_sid", el).value), wa = $("#f_wa", el).value;
      const prog = $("#f_prog", el).value, lvl = $("#f_level", el).value, grp = $("#f_group", el).value, reason = $("#f_reason", el).value.trim();
      if (!validName(name)) return (err.textContent = "Enter the student's full name.");
      if (!validStudentId(sid)) return (err.textContent = "Enter a valid Student ID, e.g. 01244542B.");
      if (!normalizeGhPhone(wa)) return (err.textContent = "Enter a valid Ghana WhatsApp number.");
      if (!prog || !lvl || !grp) return (err.textContent = "Choose the programme, level and class/group.");
      if (reason.length < 3) return (err.textContent = "Please give a reason for this change.");
      setBusy($("#fsave", el), true, "Saving…");
      const r = editing
        ? await call(sb, "admin_update_student", { p_id: s.id, p_reason: reason, p_changes: { full_name: name, student_id: sid, whatsapp_number: wa, programme_id: prog, level_id: lvl, class_group_id: grp, status: $("#f_status", el).value } })
        : await call(sb, "admin_create_student", { p_full_name: name, p_student_id: sid, p_whatsapp: wa, p_programme: prog, p_level: lvl, p_class_group: grp, p_reason: reason });
      setBusy($("#fsave", el), false);
      if (!r.ok) { err.textContent = r.message; return; }
      toast(editing ? "Student updated." : `${name} added and activated.`, "good");
      m.close(); load();
    });
  }

  // ---------------------------------------------------------------- export list (admin only)
  async function exportList(fmt) {
    toast("Preparing export…", "info", 1800);
    const r = await call(sb, "admin_list_students", { p_query: S.q || null, p_programme: S.programme || null, p_level: S.level || null, p_class_group: S.group || null, p_status: S.status || null, p_limit: 5000, p_offset: 0 });
    if (!r.ok) return toast(r.message, "bad");
    const filters = [S.q && `search “${S.q}”`, S.programme && nameOf(L.programmes, S.programme), S.level && nameOf(L.levels, S.level), S.group && nameOf(L.groups, S.group), S.status].filter(Boolean);
    try {
      await exportTable({
        format: fmt, title: "Registered students", subtitle: filters.length ? `Filters: ${filters.join(" · ")}` : "All registered students",
        summary: [["Total", r.total], ["Exported", r.rows.length]],
        columns: [{ key: "n", label: "Name" }, { key: "id", label: "Student ID" }, { key: "wa", label: "WhatsApp" }, { key: "p", label: "Programme" }, { key: "l", label: "Level" }, { key: "g", label: "Group" }, { key: "d", label: "Registered" }, { key: "s", label: "Status" }],
        rows: r.rows.map((x) => ({ n: x.full_name, id: x.student_id, wa: x.whatsapp_number, p: x.programme, l: x.level, g: x.class_group, d: fmtDate(x.created_at), s: x.status })),
        filename: "registered_students",
      });
      if (r.total > r.rows.length) toast(`Exported the first ${r.rows.length} of ${r.total}. Narrow your filters for the rest.`, "info", 7000);
    } catch (e) { console.error(e); toast("Export failed. Please try again.", "bad"); }
  }

  await load();
  return {};
}
