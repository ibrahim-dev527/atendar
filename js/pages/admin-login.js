import { initChrome, renderFooter, setBusy, toast, $ } from "/js/ui.js";
import { isConfigured, staffClient } from "/js/supabase.js";
import { call } from "/js/api.js";

initChrome();
renderFooter($("#app"));
if (!isConfigured) $("#cfgWarn").classList.remove("hidden");
const sb = isConfigured ? staffClient() : null;

// already signed in? go straight to the dashboard
sb?.auth.getSession().then(async ({ data }) => { if (data?.session) { const { data: role } = await sb.rpc("staff_role"); if (role) location.replace("/admin/index.html"); } });

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#err"); err.textContent = "";
  if (!sb) { err.textContent = "The site isn't connected to the database yet."; return; }
  const email = $("#email").value.trim(), password = $("#pw").value;
  if (!email || !password) { err.textContent = "Enter your email and password."; return; }
  setBusy($("#btn"), true, "Signing in…");
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { err.textContent = /network|fetch/i.test(error.message) ? "Can't reach the server. Check your connection." : "Incorrect email or password."; return; }
    const { data: role } = await sb.rpc("staff_role");
    if (!role) {
      await sb.auth.signOut();
      err.textContent = "Your account doesn't have staff access yet. Ask a Super Administrator to assign you a role.";
      return;
    }
    toast("Welcome back!", "good", 1500);
    location.replace("/admin/index.html");
  } catch { err.textContent = "Something went wrong. Please try again."; }
  finally { setBusy($("#btn"), false); }
});
