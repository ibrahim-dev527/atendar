import { esc, openModal, confirmDialog, toast, setBusy, debounce, fmtDate, statusBadge, emptyState, skeletonRows, initReveal, $, $$ } from "/js/ui.js";
import { call, q } from "/js/api.js";
import { loadLookups, options, nameOf, fetchAll, chunk } from "/js/admin/common.js";

export async function mount(ctx, root) {
  const { sb, isAdmin } = ctx;
  const L = await loadLookups(sb);
  let courses = [], counts = new Map(), showArchived = false;

  root.innerHTML = `
    <div class="page-head reveal"><div><h1>Courses</h1><p>${isAdmin ? "Courses, assigned staff and enrolments. Enrolments decide who is expected at each session." : "Courses assigned to you."}</p></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="muted" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="arch"> Show archived</label>
        ${isAdmin ? '<button class="btn primary" id="addBtn"><span class="lbl">➕ Add course</span></button>' : ""}</div></div>
    <div class="card reveal" style="padding:14px"><div id="table">${skeletonRows(5)}</div></div>`;
  initReveal();
  $("#arch", root).addEventListener("change", (e) => { showArchived = e.target.checked; draw(); });
  $("#addBtn", root)?.addEventListener("click", () => openCourseForm(null));

  async function load() {
    try {
      courses = await fetchAll(() => sb.from("courses").select("id,code,name,programme_id,level_id,class_group_id,academic_period_id,is_archived,course_assignments(id,user_id,assignment_role,can_create_sessions,profiles(full_name,email))").order("code"));
      const en = await fetchAll(() => sb.from("course_enrollments").select("course_id,student_id").eq("status", "active").order("course_id").order("student_id"));
      counts = new Map(); en.forEach((e) => counts.set(e.course_id, (counts.get(e.course_id) || 0) + 1));
    } catch (e) { console.error(e); $("#table", root).innerHTML = '<div class="notice bad">Could not load courses. Please refresh.</div>'; return; }
    draw();
  }

  function draw() {
    const list = courses.filter((c) => showArchived || !c.is_archived);
    const box = $("#table", root);
    if (!list.length) { box.innerHTML = emptyState("📚", isAdmin ? "No courses yet" : "No courses assigned to you yet", isAdmin ? "Add your first course to start taking attendance." : "Ask an administrator to assign you to a course."); return; }
    box.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Course</th><th>Class</th><th>Staff</th><th>Enrolled</th><th>Status</th>${isAdmin ? "<th></th>" : ""}</tr></thead><tbody>
      ${list.map((c, i) => `<tr style="--i:${i}"><td><b>${esc(c.code)}</b></td><td>${esc(c.name)}</td>
        <td><span class="muted">${esc(nameOf(L.programmes, c.programme_id))} · ${esc(nameOf(L.levels, c.level_id))} · ${esc(c.class_group_id ? nameOf(L.groups, c.class_group_id) : "All groups")}</span>${c.academic_period_id ? `<br><small class="muted">${esc(nameOf(L.periods, c.academic_period_id))}</small>` : ""}</td>
        <td>${c.course_assignments.length ? c.course_assignments.map((a) => `<span class="badge ${a.assignment_role === "lecturer" ? "info" : "warn"}" title="${esc(a.profiles?.email)}">${a.assignment_role === "lecturer" ? "👨‍🏫" : "🧑‍🎓"} ${esc(a.profiles?.full_name || a.profiles?.email || "Staff")}</span>`).join(" ") : '<span class="muted">None</span>'}</td>
        <td><b>${counts.get(c.id) || 0}</b></td><td>${c.is_archived ? '<span class="badge warn">archived</span>' : statusBadge("active")}</td>
        ${isAdmin ? `<td><div class="actions-cell"><button class="btn small" data-a="enrol" data-id="${esc(c.id)}">👥 Enrolments</button><button class="btn small" data-a="staff" data-id="${esc(c.id)}">🧑‍🏫 Staff</button><button class="btn small" data-a="edit" data-id="${esc(c.id)}">✏️</button><button class="btn small" data-a="arch" data-id="${esc(c.id)}">${c.is_archived ? "♻️ Restore" : "📦 Archive"}</button><button class="btn small danger" data-a="del" data-id="${esc(c.id)}">🗑️</button></div></td>` : ""}</tr>`).join("")}
      </tbody></table></div>`;
    $$("[data-a]", box).forEach((b) => b.addEventListener("click", () => act(b.dataset.a, courses.find((c) => c.id === b.dataset.id))));
  }

  async function act(a, c) {
    if (!c) return;
    if (a === "edit") return openCourseForm(c);
    if (a === "staff") return openStaff(c);
    if (a === "enrol") return openEnrol(c);
    if (a === "arch") {
      const { error } = await q(sb.from("courses").update({ is_archived: !c.is_archived }).eq("id", c.id));
      if (error) return toast(error, "bad");
      toast(c.is_archived ? "Course restored." : "Course archived. It can no longer start sessions.", "good"); return load();
    }
    if (a === "del") {
      const ok = await confirmDialog({ title: `Delete ${c.code}?`, body: "This permanently removes the course and its enrolments. Courses that already have attendance sessions can't be deleted. Archive them instead.", confirmText: "Delete course", danger: true });
      if (!ok) return;
      const { error } = await q(sb.from("courses").delete().eq("id", c.id));
      if (error) return toast(error, "bad");
      toast("Course deleted.", "good"); load();
    }
  }

  // ------------------------------------------------------------ add / edit course
  function openCourseForm(c) {
    const m = openModal(`<h3>${c ? "Edit course" : "➕ Add course"}</h3>
      <form id="cf" novalidate>
        <div class="row"><div class="field"><label for="c_code">Course code</label><input id="c_code" class="input" maxlength="20" placeholder="ACC101" value="${esc(c?.code ?? "")}" style="text-transform:uppercase"></div>
          <div class="field"><label for="c_name">Course name</label><input id="c_name" class="input" maxlength="120" placeholder="Financial Accounting I" value="${esc(c?.name ?? "")}"></div></div>
        <div class="row"><div class="field"><label for="c_prog">Programme</label><select id="c_prog" class="input">${options(L.programmes, { placeholder: "Select…", selected: c?.programme_id })}</select></div>
          <div class="field"><label for="c_level">Academic level</label><select id="c_level" class="input">${options(L.levels, { placeholder: "Select…", selected: c?.level_id })}</select></div></div>
        <div class="row"><div class="field"><label for="c_group">Class / group</label><select id="c_group" class="input"></select></div>
          <div class="field"><label for="c_period">Academic period</label><select id="c_period" class="input">${options(L.periods, { placeholder: "None", selected: c?.academic_period_id })}</select></div></div>
        <div class="err" id="cerr" role="alert"></div>
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="csave"><span class="lbl">${c ? "Save changes" : "Add course"}</span></button></div></form>`);
    const el = m.el;
    const fill = (keep) => {
      const p = $("#c_prog", el).value, l = $("#c_level", el).value;
      const list = L.groups.filter((g) => g.programme_id === p && g.level_id === l);
      $("#c_group", el).innerHTML = `<option value="">All groups</option>` + options(list, { selected: keep });
    };
    fill(c?.class_group_id);
    $("#c_prog", el).addEventListener("change", () => fill()); $("#c_level", el).addEventListener("change", () => fill());
    $("[data-close]", el).addEventListener("click", m.close);
    $("#cf", el).addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#cerr", el); err.textContent = "";
      const row = { code: $("#c_code", el).value.trim().toUpperCase().replace(/\s+/g, ""), name: $("#c_name", el).value.trim(),
        programme_id: $("#c_prog", el).value, level_id: $("#c_level", el).value, class_group_id: $("#c_group", el).value || null, academic_period_id: $("#c_period", el).value || null };
      if (!/^[A-Z0-9\-]{2,20}$/.test(row.code)) return (err.textContent = "Enter a course code (letters and numbers, e.g. ACC101).");
      if (row.name.length < 2) return (err.textContent = "Enter the course name.");
      if (!row.programme_id || !row.level_id) return (err.textContent = "Choose a programme and a level.");
      setBusy($("#csave", el), true, "Saving…");
      const { error } = await q(c ? sb.from("courses").update(row).eq("id", c.id) : sb.from("courses").insert(row));
      setBusy($("#csave", el), false);
      if (error) { err.textContent = error === "That already exists." ? "A course with this code already exists for that academic period." : error; return; }
      toast(c ? "Course updated." : "Course added.", "good"); m.close(); load();
    });
  }

  // ------------------------------------------------------------ staff assignment
  async function openStaff(c) {
    const { data: staff } = await q(sb.from("user_roles").select("user_id,role,profiles!user_roles_user_id_fkey(full_name,email)").in("role", ["lecturer", "course_rep"]));
    const m = openModal(`<h3>Staff for ${esc(c.code)}</h3><p class="muted">Lecturers and course representatives can start sessions and view attendance for this course only.</p><div id="sl"></div>
      <h4 style="margin-top:18px">Assign someone</h4>
      ${(staff || []).length ? `<div class="row"><div class="field"><label for="s_user">Staff member</label><select id="s_user" class="input">${(staff || []).map((s) => `<option value="${esc(s.user_id)}" data-role="${esc(s.role)}">${esc(s.profiles?.full_name || s.profiles?.email)} (${s.role === "lecturer" ? "Lecturer" : "Course rep"})</option>`).join("")}</select></div>
        <div class="field"><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" id="s_can" checked> Can create sessions</label></div></div>
        <button class="btn primary" id="s_add"><span class="lbl">Assign to course</span></button>`
        : '<div class="notice warn">No lecturers or course representatives exist yet. A Super Administrator can invite them from <b>Staff &amp; Roles</b>.</div>'}
      <div class="actions"><button class="btn" data-close>Done</button></div>`, { wide: false, onClose: load });
    const el = m.el;
    const cur = () => courses.find((x) => x.id === c.id)?.course_assignments || [];
    const drawList = () => {
      const a = cur();
      $("#sl", el).innerHTML = a.length ? a.map((x) => `<div class="feed-row"><span>${x.assignment_role === "lecturer" ? "👨‍🏫" : "🧑‍🎓"} <b>${esc(x.profiles?.full_name || x.profiles?.email)}</b> <span class="muted">· ${x.assignment_role === "lecturer" ? "Lecturer" : "Course rep"}${x.can_create_sessions ? "" : " · view only"}</span></span><button class="btn small danger" data-rm="${esc(x.id)}">Remove</button></div>`).join("") : '<div class="muted">No staff assigned yet.</div>';
      $$("[data-rm]", el).forEach((b) => b.addEventListener("click", async () => { const { error } = await q(sb.from("course_assignments").delete().eq("id", b.dataset.rm)); if (error) return toast(error, "bad"); await refresh(); }));
    };
    const refresh = async () => { await load(); drawList(); };
    drawList();
    $("[data-close]", el).addEventListener("click", m.close);
    $("#s_add", el)?.addEventListener("click", async () => {
      const sel = $("#s_user", el), opt = sel.selectedOptions[0];
      const { error } = await q(sb.from("course_assignments").insert({ course_id: c.id, user_id: sel.value, assignment_role: opt.dataset.role, can_create_sessions: $("#s_can", el).checked }));
      if (error) return toast(error === "That already exists." ? "That person is already assigned." : error, "bad");
      toast("Staff assigned.", "good"); refresh();
    });
  }

  // ------------------------------------------------------------ enrolments
  async function openEnrol(c) {
    const m = openModal(`<h3>Enrolments: ${esc(c.code)} ${esc(c.name)}</h3>
      <div class="notice"><span>ℹ️</span><span>Only students <b>enrolled when a session starts</b> are expected at it. Adding students later never counts earlier sessions against them.</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0"><div class="search toolbar" style="margin:0;flex:1 1 240px;position:relative"><input id="e_q" class="input" style="width:100%;padding-left:40px" placeholder="Find a student to enrol…" autocomplete="off"></div>
        <button class="btn" id="e_all">⚡ Enrol all matching students</button></div>
      <div id="e_res"></div><h4>Enrolled (<span id="e_n">0</span>)</h4><div id="e_list">${skeletonRows(3)}</div><div class="actions"><button class="btn" data-close>Done</button></div>`, { wide: true, onClose: load });
    const el = m.el; let enrolled = [];
    $("[data-close]", el).addEventListener("click", m.close);
    async function refresh() {
      try { enrolled = await fetchAll(() => sb.from("course_enrollments").select("student_id,enrolled_at,students(student_id,full_name)").eq("course_id", c.id).eq("status", "active").order("student_id")); }
      catch { $("#e_list", el).innerHTML = '<div class="notice bad">Could not load enrolments.</div>'; return; }
      $("#e_n", el).textContent = enrolled.length;
      $("#e_list", el).innerHTML = enrolled.length ? `<div style="max-height:300px;overflow:auto">${enrolled.map((e) => `<div class="feed-row"><span><b>${esc(e.students?.full_name)}</b> <span class="muted">${esc(e.students?.student_id)} · since ${esc(fmtDate(e.enrolled_at))}</span></span><button class="btn small danger" data-rm="${esc(e.student_id)}">Remove</button></div>`).join("")}</div>` : '<div class="muted">No students enrolled yet.</div>';
      $$("[data-rm]", el).forEach((b) => b.addEventListener("click", async () => {
        const { error } = await q(sb.from("course_enrollments").update({ status: "dropped" }).eq("course_id", c.id).eq("student_id", b.dataset.rm));
        if (error) return toast(error, "bad"); refresh();
      }));
    }
    const enrolIds = async (ids) => {
      const have = new Set(enrolled.map((e) => e.student_id)), now = new Date().toISOString();
      const todo = ids.filter((id) => !have.has(id)).map((student_id) => ({ course_id: c.id, student_id, status: "active", enrolled_at: now }));
      for (const part of chunk(todo, 200)) { const { error } = await q(sb.from("course_enrollments").upsert(part, { onConflict: "course_id,student_id" })); if (error) { toast(error, "bad"); return -1; } }
      return todo.length;
    };
    $("#e_q", el).addEventListener("input", debounce(async (ev) => {
      const v = ev.target.value.trim(), out = $("#e_res", el);
      if (v.length < 2) { out.innerHTML = ""; return; }
      const r = await call(sb, "admin_list_students", { p_query: v, p_status: "active", p_limit: 8 });
      if (!r.ok) { out.innerHTML = `<div class="notice bad">${esc(r.message)}</div>`; return; }
      const have = new Set(enrolled.map((e) => e.student_id));
      out.innerHTML = r.rows.length ? r.rows.map((s) => `<div class="feed-row"><span><b>${esc(s.full_name)}</b> <span class="muted">${esc(s.student_id)} · ${esc(s.programme)} ${esc(s.level)} ${esc(s.class_group)}</span></span>${have.has(s.id) ? '<span class="badge good">enrolled</span>' : `<button class="btn small primary" data-add="${esc(s.id)}">Enrol</button>`}</div>`).join("") : '<div class="muted">No active student found.</div>';
      $$("[data-add]", out).forEach((b) => b.addEventListener("click", async () => { const n = await enrolIds([b.dataset.add]); if (n >= 0) { toast("Student enrolled.", "good"); await refresh(); ev.target.dispatchEvent(new Event("input")); } }));
    }, 350));
    $("#e_all", el).addEventListener("click", async (ev) => {
      const ok = await confirmDialog({ title: "Enrol all matching students?", body: `Enrols every active ${nameOf(L.programmes, c.programme_id)} ${nameOf(L.levels, c.level_id)} student${c.class_group_id ? ` in ${nameOf(L.groups, c.class_group_id)}` : ""} who isn't enrolled yet.`, confirmText: "Enrol them all" });
      if (!ok) return;
      setBusy(ev.currentTarget, true);
      const r = await call(sb, "admin_list_students", { p_programme: c.programme_id, p_level: c.level_id, p_class_group: c.class_group_id, p_status: "active", p_limit: 5000 });
      if (!r.ok) { setBusy(ev.currentTarget, false); return toast(r.message, "bad"); }
      const n = await enrolIds(r.rows.map((s) => s.id));
      setBusy(ev.currentTarget, false);
      if (n >= 0) { toast(n ? `${n} student${n === 1 ? "" : "s"} enrolled.` : "Everyone matching is already enrolled.", "good"); refresh(); }
    });
    await refresh();
  }

  await load();
  return {};
}
