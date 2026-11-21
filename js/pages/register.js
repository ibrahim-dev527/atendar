import { initChrome, renderFooter, esc, toast, setBusy, confetti, $, $$ } from "/js/ui.js";
import { isConfigured, studentClient } from "/js/supabase.js";
import { call } from "/js/api.js";
import { normalizeGhPhone, normalizeName, normalizeStudentId, validName, validStudentId } from "/js/validators.js";

initChrome();
renderFooter($("#app"));
const sb = isConfigured ? studentClient() : null;
let cfg = { programmes: [], levels: [], class_groups: [] };
let submitting = false;

const fields = ["fullName", "studentId", "whatsapp", "programme", "level", "group"];
const setErr = (f, msg) => { const e = $(`[data-for="${f}"]`); if (e) e.textContent = msg || ""; $("#" + f)?.classList.toggle("invalid", !!msg); };
fields.forEach((f) => $("#" + f).addEventListener("input", () => setErr(f, "")));

function fillSelect(sel, items, placeholder) {
  sel.innerHTML = `<option value="">${esc(placeholder)}</option>` + items.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("");
}
function refreshGroups() {
  const p = $("#programme").value, l = $("#level").value, g = $("#group"), hint = $("#groupHint");
  hint.textContent = "";
  if (!p || !l) { g.disabled = true; g.innerHTML = '<option value="">Choose programme and level first</option>'; return; }
  const list = cfg.class_groups.filter((x) => x.programme_id === p && x.level_id === l);
  if (!list.length) {
    g.disabled = true; g.innerHTML = '<option value="">No class groups available</option>';
    hint.textContent = "No class group has been set up for this programme and level yet. Please contact the system administrator.";
    return;
  }
  g.disabled = false; fillSelect(g, list, "Select your class / group");
  if (list.length === 1) g.value = list[0].id;
}
$("#programme").addEventListener("change", refreshGroups);
$("#level").addEventListener("change", refreshGroups);

async function load() {
  if (!sb) { $("#cfgWarn").classList.remove("hidden"); fillSelect($("#programme"), [], "Not connected"); fillSelect($("#level"), [], "Not connected"); return; }
  const c = await call(sb, "get_public_config");
  if (c?.programmes) {
    cfg = c;
    fillSelect($("#programme"), c.programmes, "Select programme");
    fillSelect($("#level"), c.levels, "Select level");
    if (c.programmes.length === 1) $("#programme").value = c.programmes[0].id;
    $$(".recover").forEach((e) => (e.textContent = `If you have lost access to your account or need assistance with registration, please contact the system administrator on ${c.admin_contact}.`));
    refreshGroups();
  } else {
    fillSelect($("#programme"), [], "Unavailable"); fillSelect($("#level"), [], "Unavailable");
    $("#formErr").textContent = c?.message || "Could not load the form. Please refresh.";
  }
}

function validate() {
  let ok = true;
  const bad = (f, m) => { setErr(f, m); ok = false; };
  if (!validName($("#fullName").value)) bad("fullName", "Enter your full name (letters only, at least 2 characters).");
  if (!validStudentId($("#studentId").value)) bad("studentId", "Enter a valid Student ID, e.g. 01244542B.");
  if (!normalizeGhPhone($("#whatsapp").value)) bad("whatsapp", "Enter a valid Ghana number, e.g. 0244123456.");
  if (!$("#programme").value) bad("programme", "Select your programme.");
  if (!$("#level").value) bad("level", "Select your level.");
  if (!$("#group").value) bad("group", "Select your class / group.");
  return ok;
}

$("#regForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitting) return;
  $("#formErr").textContent = "";
  if (!sb) { $("#formErr").textContent = "The site isn't connected to the database yet."; return; }
  if (!validate()) { toast("Please fix the highlighted fields.", "bad"); return; }
  submitting = true; setBusy($("#submit"), true, "Creating account…");
  const r = await call(sb, "register_student", {
    p_full_name: normalizeName($("#fullName").value),
    p_student_id: normalizeStudentId($("#studentId").value),
    p_whatsapp: $("#whatsapp").value,
    p_programme: $("#programme").value, p_level: $("#level").value, p_class_group: $("#group").value,
  });
  submitting = false; setBusy($("#submit"), false);
  if (r.ok) {
    $("#doneMsg").textContent = `Welcome, ${r.full_name}. Student ID ${r.student_id} is now active.`;
    $("#formCard").classList.add("hidden");
    const d = $("#doneCard"); d.classList.remove("hidden"); d.classList.add("in", "reveal");
    window.scrollTo({ top: 0, behavior: "smooth" });
    confetti();
    return;
  }
  const map = { STUDENT_ID_EXISTS: "studentId", INVALID_STUDENT_ID: "studentId", INVALID_PHONE: "whatsapp", INVALID_NAME: "fullName", INVALID_PLACEMENT: "group" };
  if (map[r.code]) setErr(map[r.code], r.message); else $("#formErr").textContent = r.message;
  toast(r.message, "bad");
});

load();
