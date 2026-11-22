import { initChrome, renderFooter, openModal, esc, toast, setBusy, $ } from "/js/ui.js";
import { isConfigured, studentClient } from "/js/supabase.js";
import { call } from "/js/api.js";

initChrome();
renderFooter($("#app"));
const sb = isConfigured ? studentClient() : null;
if (!isConfigured) $("#cfgWarn").classList.remove("hidden");

// typewriter
const words = ["ten seconds", "one tap", "zero paper", "real time"];
const el = $("#typed");
let w = 0, i = words[0].length, del = true, pause = 20;
setInterval(() => {
  if (pause > 0) { pause--; return; }
  const word = words[w];
  if (!del) { i++; if (i >= word.length) { i = word.length; del = true; pause = 18; } }
  else { i--; if (i <= 0) { i = 0; del = false; w = (w + 1) % words.length; pause = 4; } }
  el.textContent = words[w].slice(0, i);
}, 95);

// admin contact comes from the database so it can change without redeploying
if (isConfigured) {
  call(studentClient(), "get_public_config").then((c) => {
    if (c?.admin_contact) $("#helpText").textContent =
      `If you have lost access to your account or need assistance with registration, please contact the system administrator on ${c.admin_contact}.`;
  });
}

// "Mark Attendance": students normally arrive via the QR/link; this lets them paste it
$("#markBtn").addEventListener("click", () => {
  const m = openModal(`
    <h3>📲 Mark attendance</h3>
    <p class="muted">Scan the QR code your lecturer or course rep is showing with your phone camera, <b>or</b> type the 6-character class code they mention, <b>or</b> paste the attendance link.</p>
    <div class="field"><label for="lnk">Class code or attendance link</label><input id="lnk" class="input" placeholder="e.g. K7M2QX  or  https://…/attend.html?s=…" autocomplete="off" autocapitalize="characters" spellcheck="false"><div class="err" id="lnkErr"></div></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go"><span class="lbl">Continue</span></button></div>`);
  const go = async () => {
    const v = $("#lnk", m.el).value.trim();
    const err = $("#lnkErr", m.el); err.textContent = "";
    const codeOnly = v.replace(/[\s-]/g, "");
    if (/^[A-Za-z0-9]{6}$/.test(codeOnly) && !/^[a-f0-9]{48}$/i.test(v)) {
      if (!sb) { err.textContent = "The site isn't connected to the database yet."; return; }
      setBusy($("#go", m.el), true, "Checking…");
      const r = await call(sb, "resolve_join_code", { p_code: codeOnly });
      setBusy($("#go", m.el), false);
      if (!r.ok) { err.textContent = r.message; return; }
      location.href = `/attend.html?s=${encodeURIComponent(r.token)}`;
      return;
    }
    let token = null;
    try { token = new URL(v).searchParams.get("s"); } catch { if (/^[a-f0-9]{48}$/i.test(v)) token = v; }
    if (!token || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) { $("#lnkErr", m.el).textContent = "That doesn't look like a class code or attendance link. Ask your lecturer or course rep for the code again."; return; }
    location.href = `/attend.html?s=${encodeURIComponent(token)}`;
  };
  $("#go", m.el).addEventListener("click", go);
  $("#lnk", m.el).addEventListener("keydown", (e) => e.key === "Enter" && go());
});
