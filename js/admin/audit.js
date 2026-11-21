import { esc, fmtDateTime, debounce, emptyState, skeletonRows, initReveal, $, $$ } from "/js/ui.js";
import { q } from "/js/api.js";

export async function mount(ctx, root) {
  const { sb } = ctx;
  let rows = [], needle = "";
  root.innerHTML = `<div class="page-head reveal"><div><h1>Audit log</h1><p>Every administrative change: who, when, what and why. This log cannot be edited or deleted.</p></div></div>
    <div class="toolbar reveal"><div class="search"><input id="s" class="input" placeholder="Filter by action, reason or ID…" autocomplete="off"></div></div>
    <div class="card reveal" style="padding:14px"><div id="table">${skeletonRows(6)}</div></div>`;
  initReveal();
  const { data, error } = await q(sb.from("audit_logs").select("id,actor_id,actor_role,action,entity_type,entity_id,reason,details,created_at").order("created_at", { ascending: false }).limit(500));
  if (error) { $("#table", root).innerHTML = `<div class="notice bad">${esc(error)}</div>`; return {}; }
  rows = data || [];
  const draw = () => {
    const n = needle.toLowerCase();
    const list = rows.filter((r) => !n || `${r.action} ${r.reason || ""} ${r.entity_id || ""} ${r.actor_role || ""} ${JSON.stringify(r.details)}`.toLowerCase().includes(n));
    $("#table", root).innerHTML = list.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Action</th><th>By</th><th>Reason</th><th>Details</th></tr></thead><tbody>
      ${list.map((r, i) => `<tr style="--i:${Math.min(i, 20)}"><td>${esc(fmtDateTime(r.created_at))}</td><td><span class="badge info">${esc(r.action)}</span></td><td>${esc(r.actor_role || "system / student")}</td><td>${esc(r.reason || "")}</td>
        <td><details><summary class="muted" style="cursor:pointer">view</summary><pre style="white-space:pre-wrap;max-width:420px;font-size:.75rem;margin:6px 0 0">${esc(JSON.stringify(r.details, null, 2))}</pre></details></td></tr>`).join("")}</tbody></table></div>
      <p class="hint">Showing the latest ${rows.length} entries.</p>` : emptyState("🧾", "Nothing to show", "");
  };
  $("#s", root).addEventListener("input", debounce((e) => { needle = e.target.value.trim(); draw(); }, 250));
  draw();
  return {};
}
