// Supabase clients. Students use a client that never stores a session;
// staff use a persistent one.
import { createClient } from "/vendor/supabase.js";
import { CONFIG } from "/js/config.js";

export const isConfigured =
  (/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)/i.test(CONFIG.SUPABASE_URL) ||
    /^http:\/\/(localhost|127\.0\.0\.1):\d+/.test(CONFIG.SUPABASE_URL)) && // local Supabase CLI

  !CONFIG.SUPABASE_URL.includes("YOUR-PROJECT") &&
  !CONFIG.SUPABASE_ANON_KEY.includes("YOUR-ANON");

let _student, _staff;
export function studentClient() {
  if (!_student) _student = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return _student;
}
export function staffClient() {
  if (!_staff) _staff = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "atu-staff-auth" },
  });
  return _staff;
}
