// Vercel build step.
//  1. Writes js/config.js from the SUPABASE_URL / SUPABASE_ANON_KEY environment variables
//     (if they are set; otherwise keeps whatever is in js/config.js).
//  2. REFUSES to build if the key looks like a service-role / secret key.
//  3. Copies only the public site files into ./dist so SQL, docs and scripts are not published.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = join(root, "js", "config.js");
const url = (process.env.SUPABASE_URL || "").trim();
const key = (process.env.SUPABASE_ANON_KEY || "").trim();
const fail = (m) => { console.error("\n❌ " + m + "\n"); process.exit(1); };

function looksSecret(k) {
  if (/^sb_secret_/i.test(k)) return true;
  const parts = k.split(".");
  if (parts.length === 3) {
    try { const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); if (p.role && p.role !== "anon") return true; } catch {}
  }
  return false;
}

if (url || key) {
  if (!url || !key) fail("Set BOTH SUPABASE_URL and SUPABASE_ANON_KEY (or neither).");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url)) fail("SUPABASE_URL should look like https://YOUR-PROJECT-REF.supabase.co");
  if (looksSecret(key)) fail("SUPABASE_ANON_KEY looks like a SECRET / service-role key. Use the public 'anon' (or publishable) key. Never put the service-role key in the frontend.");
  writeFileSync(cfgPath, `// Generated at build time from environment variables. Do not edit.\nexport const CONFIG = {\n  SUPABASE_URL: ${JSON.stringify(url.replace(/\/$/, ""))},\n  SUPABASE_ANON_KEY: ${JSON.stringify(key)},\n};\n`);
  console.log("✔ js/config.js written from environment variables");
} else {
  const cur = readFileSync(cfgPath, "utf8");
  if (/YOUR-PROJECT-REF|YOUR-ANON/.test(cur)) console.warn("⚠ SUPABASE_URL / SUPABASE_ANON_KEY not set and js/config.js still has placeholders. The site will show a 'not connected' notice.");
}

const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["index.html", "register.html", "attend.html", "my-attendance.html"]) cpSync(join(root, f), join(out, f));
for (const d of ["admin", "css", "js", "vendor", "assets"]) if (existsSync(join(root, d))) cpSync(join(root, d), join(out, d), { recursive: true });
console.log("✔ site copied to ./dist");
