// Where the page gets its data. The rest of the page does not care.
//
// Preview (127.0.0.1 / localhost): reads web/data/preview.json,
//   written by scripts/preview_web.py from the same mart tables.
//   Add ?source=supabase to the address to test the real login locally.
// Production: reads mart.* through Supabase with the signed-in user's
//   session. RLS lets a user see rows only if their email is in
//   mart.allowed_users, so the publishable key in config.js is safe to ship.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const isLocal = ["127.0.0.1", "localhost"].includes(location.hostname);
export const usesSupabase = !isLocal || new URLSearchParams(location.search).get("source") === "supabase";

// Same tables and order as scripts/preview_web.py
const TABLES = {
  sales_daily: "date",
  sales_monthly: "month",
  data_freshness: null,
  customers_daily: "date",
  customers_monthly: "month",
  cohort_retention: "cohort_month,month_offset",
  second_order_gap: "bucket_order",
  channel_daily: "date,channel",
  traffic_daily: "date,channel",
  reel_funnel: "reel_date",
  sales_pending: "date",
  pub_results: "channel,content",
  cohort_ltv: "cohort_month,month_offset",
  site_funnel_daily: "date",
  customer_days: "date,prev_date",
  site_funnel_channel_daily: "date,channel",
  pub_undated_daily: "date,channel,kind",
  work_calendar: "date",
  pulse_plans: "month,owner_key",
  pulse_employees: "owner_key",
  pulse_daily: "date,owner_key",
  pulse_orders: "order_id",
  pulse_moves_daily: "date,actor,new_state",
  pulse_handoff_daily: "date",
  pulse_products_daily: "date,product_id",
  pulse_colors: "variant_id",
  pulse_margin_month: "month",
  pulse_cost_anomalies: "month,name",
  pulse_sessions: "talk_id,session_no",
};
const PAGE = 1000; // the API returns at most 1000 rows per request

/** Thrown when nobody is signed in: the page shows the login form. */
export class NeedLogin extends Error {}

// The vendored build is UMD: a classic script that sets window.supabase.
function loadSupabaseLib() {
  if (window.supabase) return Promise.resolve(window.supabase);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("./vendor/supabase.js", import.meta.url).href;
    s.onload = () => (window.supabase ? resolve(window.supabase) : reject(new Error("Библиотека входа не загрузилась")));
    s.onerror = () => reject(new Error("Библиотека входа не загрузилась"));
    document.head.appendChild(s);
  });
}

let client = null;
async function getClient() {
  if (client) return client;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error("Supabase не настроен: заполните web/config.js");
  // supabase-js 2.45.4 is vendored in web/vendor (no third-party CDN: CDNs can be blocked)
  const { createClient } = await loadSupabaseLib();
  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
    db: { schema: "mart" },
  });
  return client;
}

async function fetchAll(sb, table, order) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select("*").range(from, from + PAGE - 1);
    for (const col of (order || "").split(",").filter(Boolean)) q = q.order(col, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

export async function loadSales() {
  if (!usesSupabase) {
    const res = await fetch("data/preview.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`preview.json: HTTP ${res.status}. Run scripts/preview_web.py`);
    return res.json();
  }
  const sb = await getClient();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new NeedLogin();
  const entries = await Promise.all(Object.entries(TABLES).map(async ([t, order]) => [t, await fetchAll(sb, t, order)]));
  return Object.fromEntries(entries);
}

export async function signIn(email, password) {
  const sb = await getClient();
  const { error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) {
    // do not reveal whether the email exists
    throw new Error(error.status === 400 ? "Неверный email или пароль" : `Ошибка входа: ${error.message}`);
  }
}

export async function signOut() {
  const sb = await getClient();
  await sb.auth.signOut();
}

export async function currentEmail() {
  if (!usesSupabase) return null;
  const sb = await getClient();
  const { data: { session } } = await sb.auth.getSession();
  return session?.user?.email ?? null;
}

/**
 * Save month plans (mart.pulse_plans). rows: [{ month: "2026-12-01", owner_key, plan }].
 * Whitelisted users may insert and update plans (RLS). Preview mode cannot save.
 */
export async function savePlans(rows) {
  if (!usesSupabase) throw new Error("В режиме предпросмотра планы не сохраняются");
  const sb = await getClient();
  const clean = rows.map((r) => ({ month: r.month, owner_key: r.owner_key, plan: r.plan, updated_at: new Date().toISOString() }));
  const { error } = await sb.from("pulse_plans").upsert(clean, { onConflict: "month,owner_key" });
  if (error) throw new Error(`Планы не сохранились: ${error.message}`);
  const { data, error: e2 } = await sb.from("pulse_plans").select("*");
  if (e2) throw new Error(`Планы сохранились, но не перечитались: ${e2.message}`);
  return data;
}
