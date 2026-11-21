// Zero-dependency local server that mimics production (same security headers as vercel.json).
//   npm start            -> http://localhost:3000
//   PORT=8080 npm start
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 3000);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
let headers = {};
try { for (const h of JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).headers?.[0]?.headers || []) headers[h.key] = h.value; } catch {}
if (process.env.EXTRA_CONNECT) headers["Content-Security-Policy"] = headers["Content-Security-Policy"]?.replace("connect-src 'self'", `connect-src 'self' ${process.env.EXTRA_CONNECT}`);

createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end("Forbidden"); }
  // never serve server-side material
  if (/^\/(supabase|docs|scripts|node_modules|dist)(\/|$)/.test(p) || /\/\.(env|git)/.test(p)) { res.writeHead(404); return res.end("Not found"); }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store", ...headers });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Atendar running at http://localhost:${port}`));
