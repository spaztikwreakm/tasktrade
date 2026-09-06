// TaskTrade AU — runtime configuration
//
// Fill these in after you create your Supabase project (see README).
// The anon key is meant to be public — it can only do what your Row Level
// Security policies in supabase/schema.sql allow. Never put a Stripe secret
// key or the Supabase service_role key in this file or anywhere in the
// frontend; those only ever live in edge function secrets.

window.TASKTRADE_CONFIG = {
  SUPABASE_URL: "https://shwgwavsbqbjdwnxfsns.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_f-9upw7kNpgctfG2WKCvNQ_MpIWMWGK",

  // Base URL of your edge functions, e.g. https://shwgwavsbqbjdwnxfsns.functions.supabase.co
  FUNCTIONS_URL: "https://shwgwavsbqbjdwnxfsns.functions.supabase.co",

  // Optional: Sentry DSN for error monitoring (leave blank to disable)
  SENTRY_DSN: "",
};
