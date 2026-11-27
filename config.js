// Public Supabase settings for the page.
// The publishable (anon) key is meant to be shipped to browsers: it gives no
// data by itself. Data is protected by RLS: only signed-in users whose email
// is in mart.allowed_users can read the mart tables. Never put the
// service_role / secret key here.
export const SUPABASE_URL = "https://jqckyxfircuhijpcuveh.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fuDGgyALnSwv6aqkItM16Q_ip240jQu"; // Supabase -> Project Settings -> API Keys -> publishable (or anon)
