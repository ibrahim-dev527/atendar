// Helpers shared by admin pages.
import { esc } from "/js/ui.js";

/** Session status as the DATABASE will see it right now (open + past closes_at = expired). */
export const effStatus = (s) => (s.status === "open" && s.closes_at && new Date(s.closes_at) <= new Date() ? "expired" : s.status);
export const isFinished = (s) => ["closed", "expired"].includes(effStatus(s));

/** Page through a PostgREST query (default limit is 1000 rows). makeQuery must return a fresh builder each call. */
export async function fetchAll(makeQuery, page = 1000) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + page - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < page) break;
    from += page;
  }
  return all;
}
export const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export const STUDENT_COLS = "id,student_id,full_name,programme_id,level_id,class_group_id,status,registration_source,created_at";

export async function loadLookups(sb) {
  const [p, l, g, per] = await Promise.all([
    sb.from("programmes").select("id,code,name,is_active").order("name"),
    sb.from("academic_levels").select("id,name,level_number,is_active").order("level_number"),
    sb.from("class_groups").select("id,name,programme_id,level_id,is_active").order("name"),
    sb.from("academic_periods").select("id,name,is_current,starts_on,ends_on").order("starts_on", { ascending: false }),
  ]);
  return { programmes: p.data || [], levels: l.data || [], groups: g.data || [], periods: per.data || [] };
}
export function options(items, { placeholder = null, selected = null, label = "name" } = {}) {
  return (placeholder != null ? `<option value="">${esc(placeholder)}</option>` : "") +
    items.map((i) => `<option value="${esc(i.id)}"${i.id === selected ? " selected" : ""}>${esc(typeof label === "function" ? label(i) : i[label])}</option>`).join("");
}
export const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? "";

export function sessionLink(token) { return `${location.origin}/attend.html?s=${encodeURIComponent(token)}`; }

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {} t.remove(); return ok; }
}
export async function qrDataUrl(text, width = 360) {
  const { toDataURL } = await import("/vendor/qrcode.js");
  return toDataURL(text, { width, margin: 1, errorCorrectionLevel: "M" });
}
/** Dropdown menu helper: returns html for a button + popup; wire with wireMenus(root). */
export function menuHtml(label, items) {
  return `<div class="menu"><button class="btn" data-menu>${label} ▾</button><div class="menu-pop hidden">${items.map((i) => `<button data-act="${esc(i.act)}">${esc(i.label)}</button>`).join("")}</div></div>`;
}
export function wireMenus(root, onAct) {
  root.querySelectorAll(".menu").forEach((m) => {
    const pop = m.querySelector(".menu-pop");
    m.querySelector("[data-menu]").addEventListener("click", (e) => { e.stopPropagation(); pop.classList.toggle("hidden"); });
    pop.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => { pop.classList.add("hidden"); onAct(b.dataset.act, m); }));
  });
  const closeAll = () => root.querySelectorAll(".menu-pop").forEach((p) => p.classList.add("hidden"));
  if (root._menuClose) document.removeEventListener("click", root._menuClose);
  root._menuClose = closeAll;
  document.addEventListener("click", closeAll);
}
