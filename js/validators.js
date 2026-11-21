// Client-side validation is for friendly UX only. The database re-validates everything.
export const normalizeStudentId = (v) => String(v ?? "").replace(/\s+/g, "").toUpperCase();
export const normalizeName = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/** Mirrors normalize_gh_phone() in SQL. Returns E.164 or null. */
export function normalizeGhPhone(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  let nat = null;
  if (d.startsWith("233") && d.length === 12) nat = d.slice(3);
  else if (d.startsWith("0") && d.length === 10) nat = d.slice(1);
  else if (d.length === 9) nat = d;
  return nat && /^[235]\d{8}$/.test(nat) ? "+233" + nat : null;
}
export const validStudentId = (v) => /^[0-9]{6,10}[A-Z]?$/.test(normalizeStudentId(v));
export const validName = (v) => { const n = normalizeName(v); return n.length >= 2 && n.length <= 120 && !/[0-9<>@#$%^&*=+{}\[\]|\\~`]/.test(n); };
