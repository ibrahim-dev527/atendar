// ============================================================================
// PUBLIC configuration. Safe to ship to browsers: access is protected by
// Row Level Security and the database functions, not by hiding these values.
//
// >>> Atendar's Supabase project (publishable key only; never the secret key) <<<
// On Vercel you can instead set SUPABASE_URL / SUPABASE_ANON_KEY as
// environment variables and `node scripts/build.js` (the Vercel build command) will overwrite
// this file at deploy time.
//
// NEVER put the service_role key here or anywhere in the frontend.
// ============================================================================
export const CONFIG = {
  SUPABASE_URL: "https://tfeoefywskldsigpgbvv.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_kIX43P7Cjh_ZA6SW1cQlHQ_IbFgBKjT",
};
