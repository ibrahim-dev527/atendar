// Shared UI toolkit: motion, toasts, modals, helpers. Vanilla JS, no framework.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape text before putting it into innerHTML templates. ALWAYS use for dynamic data. */
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ page chrome
export function initChrome({ curtain = true } = {}) {
  if (!$(".bg")) {
    const bg = document.createElement("div");
    bg.className = "bg";
    bg.setAttribute("aria-hidden", "true");
    bg.innerHTML = '<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="grid"></div>';
    for (let i = 0; i < 14; i++) {
      const s = document.createElement("i");
      s.className = "spark";
      s.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;animation-delay:${(Math.random() * 6).toFixed(2)}s;animation-duration:${(4 + Math.random() * 5).toFixed(1)}s`;
      bg.appendChild(s);
    }
    document.body.prepend(bg);
  }
  if (curtain && !reduceMotion() && !sessionStorage.getItem("atendar_seen_curtain")) {
    const c = document.createElement("div");
    c.className = "curtain";
    c.setAttribute("aria-hidden", "true");
    c.innerHTML = '<img src="/assets/logo-192.png" alt="" width="96" height="96"><span>Atendar</span>';
    document.body.appendChild(c);
    sessionStorage.setItem("atendar_seen_curtain", "1");
    setTimeout(() => c.remove(), 1300);
  }
  if (!$(".toasts")) {
    const t = document.createElement("div");
    t.className = "toasts";
    t.setAttribute("aria-live", "polite");
    document.body.appendChild(t);
  }
  initReveal();
  document.addEventListener("pointerdown", rippleHandler);
}

export function renderFooter(container = document.body) {
  if ($(".site-footer")) return;
  const f = document.createElement("footer");
  f.className = "site-footer reveal";
  f.innerHTML = `
    <div class="dev">
      <img class="dev-photo" src="/assets/developer.jpg" alt="Photo of the developer" width="72" height="72" loading="lazy">
      <span>Powered by <a href="https://ibratechh.com" target="_blank" rel="noopener noreferrer">Ibratechh</a></span>
    </div>
    <span>&middot; Atendar &copy; ${new Date().getFullYear()}</span>`;
  container.appendChild(f);
  initReveal();
}

export function brandHeader(rightHtml = "") {
  return `<header class="topbar reveal">
    <a class="brand" href="/"><img class="logo" src="/assets/logo-192.png" alt="Atendar logo" width="44" height="44"><span>Atendar<small>Smart classroom attendance</small></span></a>
    <div>${rightHtml}</div></header>`;
}

// ------------------------------------------------------------------ scroll reveal
let observer;
export function initReveal() {
  const els = $$(".reveal:not(.in)");
  if (reduceMotion() || !("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  observer ??= new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); observer.unobserve(en.target); } });
  }, { threshold: 0.08 });
  els.forEach((e) => observer.observe(e));
}

function rippleHandler(e) {
  const btn = e.target.closest?.(".btn");
  if (!btn || reduceMotion()) return;
  const r = btn.getBoundingClientRect(), size = Math.max(r.width, r.height);
  const s = document.createElement("span");
  s.className = "ripple";
  s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  btn.appendChild(s);
  setTimeout(() => s.remove(), 650);
}

// ------------------------------------------------------------------ numbers
export function countUp(el, to, { duration = 1200, decimals = 0, suffix = "" } = {}) {
  if (to == null || Number.isNaN(Number(to))) { el.textContent = "–"; return; }
  to = Number(to);
  if (reduceMotion()) { el.textContent = to.toFixed(decimals) + suffix; return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / duration), e = 1 - Math.pow(1 - p, 4);
    el.textContent = (to * e).toFixed(decimals) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export const fmtPct = (n) => (n == null ? "–" : `${Number(n).toFixed(Number(n) % 1 === 0 ? 0 : 1)}%`);

/** Animated circular progress ring. Returns HTML; call animateRings(root) afterwards. */
export function ringHtml(percent, { size = 180, label = "Attendance rate" } = {}) {
  const id = "g" + Math.random().toString(36).slice(2, 7);
  return `<div class="ring" style="--size:${size}px" data-pct="${percent ?? ""}">
    <svg viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
      <circle class="track" cx="60" cy="60" r="50"/><circle class="bar" cx="60" cy="60" r="50" style="stroke:url(#${id})"/></svg>
    <div class="center"><b data-count>${percent == null ? "–" : "0%"}</b><span>${esc(label)}</span></div></div>`;
}
export function animateRings(root = document) {
  $$(".ring", root).forEach((r) => {
    const raw = r.dataset.pct;
    if (raw === "" || raw == null) return;
    const pct = Math.max(0, Math.min(100, Number(raw)));
    const bar = $(".bar", r), C = 2 * Math.PI * 50;
    bar.style.strokeDasharray = C;
    bar.style.strokeDashoffset = C;
    const color = pct >= 75 ? null : pct >= 50 ? "#fbbf24" : "#fb7185";
    if (color) bar.style.stroke = color;
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.strokeDashoffset = C * (1 - pct / 100); }));
    countUp($("[data-count]", r), pct, { decimals: pct % 1 === 0 ? 0 : 1, suffix: "%", duration: 1500 });
  });
}

// ------------------------------------------------------------------ toast
export function toast(message, type = "info", ms = 4500) {
  let host = $(".toasts");
  if (!host) { initChrome({ curtain: false }); host = $(".toasts"); }
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  const icon = { good: "✅", bad: "⚠️", info: "ℹ️" }[type] || "ℹ️";
  t.innerHTML = `<span aria-hidden="true">${icon}</span><span>${esc(message)}</span>`;
  host.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 380); }, ms);
}

// ------------------------------------------------------------------ buttons
export function setBusy(btn, busy, label) {
  if (!btn) return;
  btn.classList.toggle("is-busy", busy);
  btn.disabled = busy;
  if (!btn.querySelector(".spin")) btn.insertAdjacentHTML("afterbegin", '<span class="spin"></span>');
  const l = btn.querySelector(".lbl");
  if (l) { if (busy && label) { l.dataset.orig ??= l.textContent; l.textContent = label; } else if (!busy && l.dataset.orig) { l.textContent = l.dataset.orig; delete l.dataset.orig; } }
}

// ------------------------------------------------------------------ modal
/**
 * Opens a modal. Returns {el, close}. `html` must already be escaped.
 * Pass onClose to run cleanup when the modal is dismissed.
 */
export function openModal(html, { wide = false, onClose, dismissible = true } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(ov);
  const prevFocus = document.activeElement;
  const close = () => { document.removeEventListener("keydown", onKey); ov.remove(); onClose?.(); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape" && dismissible) close(); };
  document.addEventListener("keydown", onKey);
  if (dismissible) ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });
  $$("[data-close]", ov).forEach((b) => b.addEventListener("click", close));
  const first = $("input,select,textarea,button", ov);
  setTimeout(() => first?.focus?.(), 60);
  return { el: ov.firstElementChild, overlay: ov, close };
}

/** Confirmation dialog. `reason:true` forces a written reason (for audited actions). */
export function confirmDialog({ title, body = "", confirmText = "Confirm", danger = false, reason = false, reasonLabel = "Reason (recorded in the audit log)" }) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>${esc(title)}</h3><p class="muted">${esc(body)}</p>
      ${reason ? `<div class="field"><label for="cr">${esc(reasonLabel)}</label><textarea id="cr" class="input" rows="3" maxlength="300" placeholder="Explain why…"></textarea><div class="err" id="cre"></div></div>` : ""}
      <div class="actions"><button class="btn" data-no>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-yes><span class="lbl">${esc(confirmText)}</span></button></div>`,
      { onClose: () => resolve(null) });
    let done = false;
    $("[data-no]", m.el).addEventListener("click", () => m.close());
    $("[data-yes]", m.el).addEventListener("click", () => {
      let val = true;
      if (reason) {
        val = $("#cr", m.el).value.trim();
        if (val.length < 3) { $("#cre", m.el).textContent = "Please give a reason (at least 3 characters)."; $("#cr", m.el).classList.add("invalid"); return; }
      }
      done = true; resolve(val); m.close();
    });
    const orig = m.close;
    m.close = () => { orig(); if (!done) resolve(null); };
  });
}

// ------------------------------------------------------------------ confetti (canvas)
export function confetti(duration = 2600) {
  if (reduceMotion()) return;
  const c = document.createElement("canvas");
  c.className = "confetti";
  document.body.appendChild(c);
  const ctx = c.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = (c.width = innerWidth * dpr), H = (c.height = innerHeight * dpr);
  const colors = ["#7c5cff", "#22d3ee", "#34d399", "#fbbf24", "#ff5c8a", "#ffffff"];
  const parts = Array.from({ length: 150 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.45, r: (4 + Math.random() * 6) * dpr,
    vx: (Math.random() - 0.5) * 16 * dpr, vy: (-8 - Math.random() * 13) * dpr, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0], shape: Math.random() < 0.5,
  }));
  const t0 = performance.now();
  (function frame(t) {
    const el = t - t0;
    ctx.clearRect(0, 0, W, H);
    parts.forEach((p) => {
      p.vy += 0.42 * dpr; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.995;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0, 1 - el / duration);
      ctx.fillStyle = p.c;
      if (p.shape) ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); else { ctx.beginPath(); ctx.arc(0, 0, p.r / 2, 0, 7); ctx.fill(); }
      ctx.restore();
    });
    if (el < duration) requestAnimationFrame(frame); else c.remove();
  })(t0);
}

// ------------------------------------------------------------------ misc helpers
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "–");
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
export const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–");
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export function mmss(total) { const s = Math.max(0, Math.floor(total)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
export function skeletonRows(n = 4) { return Array.from({ length: n }, () => '<div class="skeleton" style="height:46px;margin-bottom:10px"></div>').join(""); }
export function emptyState(icon, title, text = "") { return `<div class="empty"><span class="big">${icon}</span><b>${esc(title)}</b><p>${esc(text)}</p></div>`; }
export function statusBadge(status) {
  const map = { present: "good", late: "warn", excused: "info", absent: "bad", active: "good", inactive: "bad", open: "good", scheduled: "info", closed: "warn", expired: "bad" };
  return `<span class="badge ${map[status] || ""}">${esc(status)}</span>`;
}
