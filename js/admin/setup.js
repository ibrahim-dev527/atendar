import { esc, toast, setBusy, statusBadge, emptyState, fmtDate, initReveal, $, $$ } from "/js/ui.js";
import { q } from "/js/api.js";
import { loadLookups, options, nameOf } from "/js/admin/common.js";

export async function mount(ctx, root) {
  const { sb, role } = ctx;
  const isSuper = role === "super_admin";
  let L = await loadLookups(sb), tab = "programmes", settings = [];
  const TABS = [["programmes", "Programmes"], ["groups", "Classes"], ["levels", "Academic levels"], ["periods", "Academic periods"], ["settings", "Settings"]];

  root.innerHTML = `<div class="page-head reveal"><div><h1>Setup</h1><p>The building blocks the whole system grows from: programmes, the classes under each programme, levels and periods.</p></div></div>
    <div class="tabs reveal" id="tabs">${TABS.map(([k, l]) => `<button class="tab" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="card reveal" id="panel"></div>`;
  initReveal();
  $$("#tabs .tab", root).forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; draw(); }));

  async function reloadAll() { L = await loadLookups(sb); }
  const save = async (builder, ok) => { const { error } = await q(builder); if (error) { toast(error, "bad"); return false; } toast(ok, "good"); await reloadAll(); draw(); return true; };
  const val = (id) => $("#" + id, root).value.trim();
  const toggle = (table, id, on) => save(sb.from(table).update({ is_active: on }).eq("id", id), on ? "Activated." : "Deactivated.");

  function draw() {
    $$("#tabs .tab", root).forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const p = $("#panel", root);
    if (tab === "groups") {
      p.innerHTML = `<h3>Classes</h3><p class="muted">A programme can have many classes (for example BTech, HND and Diploma, each at Level 100 to 400). Students choose their class when they register, and courses and attendance belong to a class. Give each class its full name, e.g. <i>BTech Accounting and Finance Analytics Lvl 100</i>.</p>
        <form class="toolbar" id="addf"><select id="g_p" class="input">${options(L.programmes, { placeholder: "Programme" })}</select><select id="g_l" class="input">${options(L.levels, { placeholder: "Level of this class" })}</select><input id="g_n" class="input" placeholder="Full class name" maxlength="120" style="flex:2 1 280px"><button class="btn primary">Add class</button></form>
        ${table(["Programme", "Class", "Level", "Status", ""], L.groups.map((g) => [esc(nameOf(L.programmes, g.programme_id)), `<b>${esc(g.name)}</b>`, esc(nameOf(L.levels, g.level_id)), statusBadge(g.is_active ? "active" : "inactive"), `<div class="actions-cell"><button class="btn small" data-ren="class_groups" data-id="${esc(g.id)}" data-name="${esc(g.name)}">✏️ Rename</button>${tog("class_groups", g)}</div>`]))}`;
      $("#addf", root).addEventListener("submit", (e) => { e.preventDefault(); const row = { programme_id: val("g_p"), level_id: val("g_l"), name: val("g_n") }; if (!row.programme_id || !row.level_id || row.name.length < 2) return toast("Choose the programme and level, and type the full class name.", "bad"); save(sb.from("class_groups").insert(row), "Class added."); });
    } else if (tab === "programmes") {
      p.innerHTML = `<h3>Programmes</h3><form class="toolbar" id="addf"><input id="p_c" class="input" placeholder="Code, e.g. ACC" maxlength="12" style="text-transform:uppercase"><input id="p_n" class="input" placeholder="Programme name, e.g. Accounting and Finance Analytics" maxlength="80" style="flex:2 1 280px"><input id="p_d" class="input" placeholder="Department (optional)" maxlength="80"><button class="btn primary">Add programme</button></form>
        ${table(["Code", "Programme", "Department", "Status", ""], L.programmes.map((x) => [`<b>${esc(x.code)}</b>`, esc(x.name), esc(x.department || ""), statusBadge(x.is_active ? "active" : "inactive"), `<div class="actions-cell"><button class="btn small" data-ren="programmes" data-id="${esc(x.id)}" data-name="${esc(x.name)}">✏️ Rename</button>${tog("programmes", x)}</div>`]))}`;
      $("#addf", root).addEventListener("submit", (e) => { e.preventDefault(); const row = { code: val("p_c").toUpperCase(), name: val("p_n"), department: val("p_d") || null }; if (!row.code || !row.name) return toast("Enter a code and a name.", "bad"); save(sb.from("programmes").insert(row), "Programme added."); });
    } else if (tab === "levels") {
      p.innerHTML = `<h3>Academic levels</h3><form class="toolbar" id="addf"><input id="l_n" type="number" min="100" max="900" step="100" class="input" placeholder="Number, e.g. 500"><input id="l_t" class="input" placeholder="Name, e.g. Level 500" maxlength="40"><button class="btn primary">Add level</button></form>
        ${table(["Level", "Name", "Status", ""], L.levels.map((x) => [x.level_number, `<b>${esc(x.name)}</b>`, statusBadge(x.is_active ? "active" : "inactive"), tog("academic_levels", x)]))}`;
      $("#addf", root).addEventListener("submit", (e) => { e.preventDefault(); const n = Number(val("l_n")); if (!Number.isInteger(n) || n < 100 || n > 900 || !val("l_t")) return toast("Enter a level number (100 to 900) and a name.", "bad"); save(sb.from("academic_levels").insert({ level_number: n, name: val("l_t") }), "Level added."); });
    } else if (tab === "periods") {
      p.innerHTML = `<h3>Academic periods</h3><p class="muted">Semesters or academic years. Only one can be "current". New students are auto-enrolled only in courses of the current period (or courses with no period).</p>
        <form class="toolbar" id="addf"><input id="a_n" class="input" placeholder="e.g. 2026/2027 Semester 1" maxlength="60"><input id="a_s" type="date" class="input"><input id="a_e" type="date" class="input"><button class="btn primary">Add period</button></form>
        ${table(["Period", "Starts", "Ends", "Current", ""], L.periods.map((x) => [`<b>${esc(x.name)}</b>`, esc(fmtDate(x.starts_on)), esc(fmtDate(x.ends_on)), x.is_current ? '<span class="badge good">current</span>' : "", x.is_current ? "" : `<button class="btn small" data-cur="${esc(x.id)}">Make current</button>`]))}`;
      $("#addf", root).addEventListener("submit", (e) => { e.preventDefault(); const row = { name: val("a_n"), starts_on: val("a_s"), ends_on: val("a_e") }; if (!row.name || !row.starts_on || !row.ends_on) return toast("Fill in the name and both dates.", "bad"); if (row.ends_on <= row.starts_on) return toast("The end date must be after the start date.", "bad"); save(sb.from("academic_periods").insert(row), "Period added."); });
      $$("[data-cur]", root).forEach((b) => b.addEventListener("click", async () => { const a = await q(sb.from("academic_periods").update({ is_current: false }).eq("is_current", true)); if (a.error) return toast(a.error, "bad"); save(sb.from("academic_periods").update({ is_current: true }).eq("id", b.dataset.cur), "Current period updated."); }));
    } else {
      renderSettings(p); return;
    }
    $$("[data-ren]", root).forEach((b) => b.addEventListener("click", () => {
      const nn = (window.prompt("New name:", b.dataset.name) || "").trim();
      if (nn.length < 2 || nn === b.dataset.name) return;
      save(sb.from(b.dataset.ren).update({ name: nn }).eq("id", b.dataset.id), "Renamed.");
    }));
    $$("[data-tog]", root).forEach((b) => b.addEventListener("click", () => toggle(b.dataset.table, b.dataset.tog, b.dataset.on === "1")));
  }

  const tog = (t, x) => `<button class="btn small" data-table="${t}" data-tog="${esc(x.id)}" data-on="${x.is_active ? 0 : 1}">${x.is_active ? "Deactivate" : "Activate"}</button>`;
  const table = (heads, rows) => rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r, i) => `<tr style="--i:${i}">${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : emptyState("🧩", "Nothing here yet", "Add the first one above.");

  async function renderSettings(p) {
    p.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    const { data, error } = await q(sb.from("app_settings").select("key,value").order("key"));
    if (error) { p.innerHTML = `<div class="notice bad">${esc(error)}</div>`; return; }
    settings = data || [];
    const LABEL = { admin_contact: "Administrator contact number (shown to students)", auto_enroll: "Auto-enrol new students in matching courses", rl_register_max: "Max registrations per IP per hour", rl_lookup_max: "Max Student ID lookups per IP per 5 min", rl_submit_max: "Max attendance submissions per IP per 5 min", rl_session_info_max: "Max attendance-page loads per IP per 5 min", rl_login_max: "Max student sign-ins per IP per 15 min" };
    p.innerHTML = `<h3>Settings</h3>${isSuper ? "" : '<div class="notice warn"><span>🔒</span><span>Only a Super Administrator can change settings.</span></div>'}
      <p class="muted">Rate limits are per internet address. Many students share campus Wi-Fi, so keep them generous.</p>
      <form id="sf">${settings.map((s) => `<div class="field"><label for="s_${esc(s.key)}">${esc(LABEL[s.key] || s.key)}</label>${s.key === "auto_enroll" ? `<select id="s_${esc(s.key)}" class="input" data-k="${esc(s.key)}" ${isSuper ? "" : "disabled"}><option value="true"${s.value === "true" ? " selected" : ""}>Yes</option><option value="false"${s.value === "false" ? " selected" : ""}>No</option></select>` : `<input id="s_${esc(s.key)}" class="input" data-k="${esc(s.key)}" value="${esc(s.value)}" maxlength="40" ${isSuper ? "" : "disabled"}>`}</div>`).join("")}
        ${isSuper ? '<button class="btn primary" id="sSave"><span class="lbl">Save settings</span></button>' : ""}</form>`;
    $("#sf", root).addEventListener("submit", async (e) => {
      e.preventDefault(); if (!isSuper) return;
      const upd = [...$$("[data-k]", root)].map((i) => ({ k: i.dataset.k, v: i.value.trim() }));
      for (const { k, v } of upd) {
        if (k.startsWith("rl_") && !/^\d{1,6}$/.test(v)) return toast("Rate limits must be whole numbers.", "bad");
        if (k === "admin_contact" && !/^[0-9+ ]{7,20}$/.test(v)) return toast("Enter a valid contact number.", "bad");
      }
      setBusy($("#sSave", root), true);
      for (const { k, v } of upd) { const { error: er } = await q(sb.from("app_settings").update({ value: v, updated_at: new Date().toISOString() }).eq("key", k)); if (er) { setBusy($("#sSave", root), false); return toast(er, "bad"); } }
      setBusy($("#sSave", root), false); toast("Settings saved.", "good");
    });
  }

  draw();
  return {};
}
