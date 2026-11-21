import { esc, countUp, ringHtml, animateRings, fmtDate, statusBadge, emptyState, initReveal, $, $$ } from "/js/ui.js";
import { call, q } from "/js/api.js";
import { effStatus } from "/js/admin/common.js";

export async function mount(ctx, root) {
  const { sb } = ctx;
  root.innerHTML = `
    <div class="page-head reveal"><div><h1>Dashboard</h1><p>Live overview of attendance across your courses.</p></div>
      <a class="btn primary" href="#/sessions"><span class="lbl">➕ New attendance session</span></a></div>
    <div class="grid-cards" id="cards">${Array.from({ length: 6 }, () => '<div class="card stat"><div class="skeleton" style="height:70px"></div></div>').join("")}</div>
    <div class="split">
      <div class="card reveal"><h3>Recent sessions: attendance rate</h3><div id="bars"><div class="skeleton" style="height:190px"></div></div></div>
      <div class="card reveal" style="--i:1"><h3>Live now</h3><div id="live"><div class="skeleton" style="height:90px"></div></div></div>
    </div>`;
  initReveal();

  const stats = await call(sb, "dashboard_stats");
  const cards = $("#cards", root);
  if (!stats.ok) { cards.innerHTML = `<div class="notice bad" style="grid-column:1/-1">${esc(stats.message)}</div>`; }
  else {
    const items = [
      ctx.isAdmin ? ["🎓", "Registered students", stats.students] : null,
      ["📚", "Courses", stats.courses],
      ["🗓️", "Attendance sessions", stats.sessions],
      ["✅", "Attendance submissions", stats.submissions],
      ["📡", "Active sessions", stats.active_sessions],
    ].filter(Boolean);
    cards.innerHTML = items.map(([ic, label, n], i) => `<div class="card stat reveal in" style="--i:${i}"><span class="ic">${ic}</span><small>${esc(label)}</small><b data-n="${n}">0</b></div>`).join("") +
      `<div class="card stat reveal in" style="--i:5"><small>Overall attendance</small><div style="display:flex;justify-content:center;margin-top:6px">${ringHtml(stats.overall_rate, { size: 96, label: "overall" })}</div></div>`;
    $$("[data-n]", cards).forEach((b) => countUp(b, Number(b.dataset.n)));
    animateRings(cards);
  }

  const { data: sessions } = await q(sb.from("attendance_sessions")
    .select("id,title,session_date,status,closes_at,course_id,courses(code,name)").neq("status", "scheduled")
    .order("created_at", { ascending: false }).limit(10));
  const list = sessions || [];

  // live list
  const live = list.filter((s) => effStatus(s) === "open");
  $("#live", root).innerHTML = live.length ? live.map((s) => `<a class="feed-row" href="#/sessions/${esc(s.id)}" style="color:inherit"><span><span class="live-dot"></span> <b>${esc(s.courses?.code)}</b> · ${esc(s.title)}</span><span class="btn small">Monitor →</span></a>`).join("")
    : emptyState("😴", "No active sessions", "Start one from the Sessions page.");

  // bars
  const finished = list.filter((s) => effStatus(s) !== "open").slice(0, 8).reverse();
  if (!finished.length) { $("#bars", root).innerHTML = emptyState("📊", "No finished sessions yet", "Charts appear after your first class."); return {}; }
  const sums = await Promise.all(finished.map((s) => call(sb, "session_summary", { p_session: s.id })));
  $("#bars", root).innerHTML = `<div class="bars">${finished.map((s, i) => {
    const r = sums[i].ok ? sums[i].attendance_rate : null;
    return `<div class="bar-col" title="${esc(s.courses?.code)} · ${esc(s.title)} · ${esc(fmtDate(s.session_date))}"><div class="bar" style="--i:${i};height:${Math.max(4, r ?? 0)}%"><span>${r == null ? "–" : Math.round(r) + "%"}</span></div><small>${esc(s.courses?.code)}</small></div>`;
  }).join("")}</div>`;
  return {};
}
