// Sales page: shows ready mart data, no metric logic beyond summing
// days of the chosen period and comparing with the previous period.
import { loadSales, NeedLogin, signIn, signOut, currentEmail, usesSupabase, savePlans } from "./data-source.js";

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (v) => `${nf.format(Math.round(v))} ₽`;
const num = (v) => nf.format(Math.round(v));
// escape text from external sources (captions, tags) before putting it into HTML
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// compact money for chart labels: 25,9 млн / 850 тыс / 3 133
function compact(v) {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  if (Math.abs(v) >= 1e4) return `${nf.format(v / 1e3)} тыс`;
  return nf.format(v);
}

let DATA = null;

// --------------------------------------------------------------- theme
// "auto" follows the OS; light/dark is saved in this browser only.
function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  try { choice === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", choice); } catch (e) { /* storage blocked: theme still applies for this visit */ }
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice)));
}
function initTheme() {
  let saved = "auto";
  try { saved = localStorage.getItem("theme") || "auto"; } catch (e) { /* ignore */ }
  applyTheme(saved);
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeChoice)));
}

// ---------------------------------------------------------------- tabs
// The tab lives in the address (#sales / #customers / #marketing), so a link
// opens the right tab; the last one is also remembered in this browser.
// Charts in a hidden tab have no size; they draw themselves when shown
// (ResizeObserver in makeChart).
const TABS = { sales: "Продажи", customers: "Покупатели", marketing: "Маркетинг" };
// sub-tabs: address #sales/funnel, #marketing/channels, ... The first one is the default.
const SUBS = {
  sales: { summary: "Продажи", pulse: "Рука на пульсе", funnel: "Воронка сайта" },
  marketing: { reels: "Воронка Reels", channels: "Каналы", posts: "Публикации" },
};

function parseHash(hash) {
  const [tab, sub] = hash.replace(/^#/, "").split("/");
  const t = TABS[tab] ? tab : null;
  return { tab: t, sub: t && SUBS[t]?.[sub] ? sub : null };
}

function showTab(name, sub) {
  if (!TABS[name]) name = "sales";
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  document.querySelectorAll("[data-tab]").forEach((a) => a.setAttribute("aria-selected", String(a.dataset.tab === name)));
  $("tab-title").textContent = TABS[name];
  document.title = `${TABS[name]} · Sky Wool`;
  const subs = SUBS[name];
  if (subs) {
    let saved = null;
    try { saved = localStorage.getItem(`sub_${name}`); } catch (e) { /* ignore */ }
    sub = subs[sub] ? sub : subs[saved] ? saved : Object.keys(subs)[0];
    const panel = $(`tab-${name}`);
    panel.querySelectorAll("[data-subpanel]").forEach((p) => { p.hidden = p.dataset.subpanel !== sub; });
    panel.querySelectorAll("[data-sub]").forEach((a) => a.setAttribute("aria-selected", String(a.dataset.sub === sub)));
    document.title = `${subs[sub]} · Sky Wool`;
    try { localStorage.setItem(`sub_${name}`, sub); } catch (e) { /* ignore */ }
  }
  // the address always names what is shown, without adding a history step
  const hash = subs ? `#${name}/${sub}` : `#${name}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
  try { localStorage.setItem("tab", name); } catch (e) { /* storage blocked: tab still switches */ }
}
function initTabs() {
  let saved = null;
  try { saved = localStorage.getItem("tab"); } catch (e) { /* ignore */ }
  const h = parseHash(location.hash);
  showTab(h.tab || (TABS[saved] ? saved : "sales"), h.sub);
  window.addEventListener("hashchange", () => { const x = parseHash(location.hash); showTab(x.tab || "sales", x.sub); });
}

// --------------------------------------------------------------- dates
// Dates are ISO strings "YYYY-MM-DD" (Ufa calendar days from the mart, stg.local_tz()).
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addDays(s, n) {
  const { y, m, d } = parse(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
function shiftMonth(y, m, delta) {
  const t = (y * 12 + (m - 1)) + delta;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}
const monthLabel = (s) => { const { y, m } = parse(s); return `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`; };
const monthTitle = (s) => { const { y, m } = parse(s); const n = MONTHS_SHORT[m - 1]; return `${n[0].toUpperCase()}${n.slice(1)} ${y}`; };
const dayTitle = (s) => { const { y, m, d } = parse(s); return `${d} ${MONTHS_GEN[m - 1]} ${y}`; };
const dayShort = (s) => { const { m, d } = parse(s); return `${d} ${MONTHS_SHORT[m - 1]}`; };
function rangeText(from, to) {
  const a = parse(from), b = parse(to);
  if (from === to) return `${a.d} ${MONTHS_GEN[a.m - 1]}${a.y !== parse(lastDate()).y ? " " + a.y : ""}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS_GEN[a.m - 1]}${a.y !== parse(lastDate()).y ? " " + a.y : ""}`;
  const ya = a.y !== b.y ? ` ${a.y}` : "";
  const yb = a.y !== b.y || b.y !== parse(lastDate()).y ? ` ${b.y}` : "";
  return `${a.d} ${MONTHS_GEN[a.m - 1]}${ya} – ${b.d} ${MONTHS_GEN[b.m - 1]}${yb}`;
}
const firstDate = () => DATA.sales_daily[0].date;
const lastDate = () => DATA.sales_daily.at(-1).date;

// ------------------------------------------------------------- periods
// Each period: label, current range [from, to], previous range to compare.
function presetRanges(kind) {
  const last = lastDate();
  const L = parse(last);
  if (kind === "mtd") {
    const p = shiftMonth(L.y, L.m, -1);
    const pd = Math.min(L.d, daysInMonth(p.y, p.m));
    return { label: `в ${MONTHS_PREP[L.m - 1]} (1–${L.d})`, cur: [iso(L.y, L.m, 1), last], prev: [iso(p.y, p.m, 1), iso(p.y, p.m, pd)] };
  }
  if (kind === "prev_month") {
    const a = shiftMonth(L.y, L.m, -1), b = shiftMonth(L.y, L.m, -2);
    return {
      label: `в ${MONTHS_PREP[a.m - 1]}`,
      cur: [iso(a.y, a.m, 1), iso(a.y, a.m, daysInMonth(a.y, a.m))],
      prev: [iso(b.y, b.m, 1), iso(b.y, b.m, daysInMonth(b.y, b.m))],
    };
  }
  if (kind === "last30") {
    return { label: "за 30 дней", cur: [addDays(last, -29), last], prev: [addDays(last, -59), addDays(last, -30)] };
  }
  // ytd: same days of the previous year
  const pd = Math.min(L.d, daysInMonth(L.y - 1, L.m));
  return { label: `с начала ${L.y} года`, cur: [iso(L.y, 1, 1), last], prev: [iso(L.y - 1, 1, 1), iso(L.y - 1, L.m, pd)] };
}
function customRanges(from, to) {
  const len = daysBetween(from, to) + 1;
  return { label: `за ${rangeText(from, to)}`, cur: [from, to], prev: [addDays(from, -len), addDays(from, -1)] };
}

function sumRange([from, to]) {
  // shipped_revenue = shipments - returns (main revenue); paid = paid amount of sales by order date
  const s = { orders: 0, paid: 0, returns: 0, returns_sum: 0, shipped_revenue: 0 };
  for (const r of DATA.sales_daily) {
    if (r.date < from || r.date > to) continue;
    s.orders += r.orders; s.paid += r.revenue; s.returns += r.returns;
    s.returns_sum += r.returns_sum; s.shipped_revenue += r.shipped_revenue;
  }
  s.avg = s.orders ? s.paid / s.orders : null;
  return s;
}

function deltaHtml(cur, prev, upIsGood, prevText) {
  if (prev == null || cur == null || prev === 0) return `<span>нет сравнения</span>`;
  const pct = (cur - prev) / Math.abs(prev) * 100;
  const rounded = Math.round(pct);
  if (rounded === 0) return `<span>≈ без изменений</span>`;
  const up = pct > 0;
  const cls = up === upIsGood ? "good" : "bad";
  const tail = prevText ? ` к ${prevText}` : "";
  return `<span class="${cls}">${up ? "▲" : "▼"} ${Math.abs(rounded)}%</span>${tail}`;
}

function renderPeriod(P) {
  const c = sumRange(P.cur), p = sumRange(P.prev);
  const comparable = P.prev[0] >= firstDate(); // previous range fully covered by data
  const pv = (v) => (comparable ? v : null);

  $("period-label").textContent = P.label;
  // main revenue (decided 25.11.2026): paid amount of orders by order date
  $("kpi-revenue").textContent = rub(c.paid);
  $("kpi-revenue-delta").innerHTML = deltaHtml(c.paid, pv(p.paid), true, rangeText(P.prev[0], P.prev[1]));
  $("kpi-orders").textContent = num(c.orders);
  $("kpi-orders-delta").innerHTML = deltaHtml(c.orders, pv(p.orders), true, "");
  $("kpi-avg").textContent = c.avg == null ? "—" : rub(c.avg);
  $("kpi-avg-delta").innerHTML = deltaHtml(c.avg, pv(p.avg), true, "");
  $("kpi-returns").textContent = rub(c.returns_sum);
  $("kpi-returns-delta").innerHTML = `${num(c.returns)} шт. · ` + deltaHtml(c.returns_sum, pv(p.returns_sum), false, "");
  // financial revenue: shipments - returns by document date (MoySklad "Прибыльность")
  $("kpi-paid").textContent = rub(c.shipped_revenue);
  $("kpi-paid-delta").innerHTML = deltaHtml(c.shipped_revenue, pv(p.shipped_revenue), true, "");

  renderCustomerKpis(P, comparable);
  renderSiteFunnel(P);
  renderPulse(P);
  // channels exist only since the Metrika counter; earlier days are "До счетчика Метрики"
  renderChannels(P, comparable && P.prev[0] >= METRIKA_START);
  renderReels(P);
  renderPublications(P);

  renderDaily(P);

  // days where payments are not posted yet (MoySklad posts them in batches)
  const { isPartial } = pendingInfo();
  // under the revenue: money of the period that is ordered but not yet paid in MoySklad
  const pend = (DATA.sales_pending || []).filter((r) => r.date >= P.cur[0] && r.date <= P.cur[1]
    && isPartial(DATA.sales_daily.find((d) => d.date === r.date) || { orders: 0, date: r.date }));
  const pendOrders = pend.reduce((a, r) => a + r.pending_orders, 0), pendSum = pend.reduce((a, r) => a + r.pending_sum, 0);
  $("kpi-pending").hidden = !pendOrders;
  $("kpi-pending").textContent = pendOrders
    ? `Еще ждут проведения оплаты: ${num(pendOrders)} заказов на ${rub(pendSum)} (${pend.map((r) => dayShort(r.date)).join(", ")}) — выручка вырастет`
    : "";
}

// ------------------------------------------------------- site funnel
// visits -> carts (leads) -> checkouts -> paid
// C1 = carts / visits, C2 = paid / carts, payment step = paid / checkouts
function siteFunnel([from, to]) {
  const r = (DATA.site_funnel_daily || []).filter((x) => x.date >= from && x.date <= to);
  const s = (k) => r.reduce((a, x) => a + (x[k] || 0), 0);
  const visits = s("visits"), carts = s("carts"), checkouts = s("checkouts"), paid = s("paid_orders");
  return { visits, carts, checkouts, paid, revenue: s("paid_revenue"),
    c1: visits && carts ? carts / visits : null,
    c2: carts ? paid / carts : null,
    pay: checkouts ? paid / checkouts : null,
    total: visits ? paid / visits : null };
}
// change of a conversion in percentage points
function ppDelta(cur, prev) {
  if (cur == null || prev == null) return `<span>нет сравнения</span>`;
  const d = Math.round((cur - prev) * 10000) / 100;
  if (Math.abs(d) < 0.005) return `<span>≈ без изменений</span>`;
  const shown = Math.abs(d).toLocaleString("ru-RU", { maximumFractionDigits: Math.abs(d) >= 1 ? 1 : 2 });
  return `<span class="${d > 0 ? "good" : "bad"}">${d > 0 ? "▲" : "▼"} ${shown} п. п.</span>`;
}
function renderSiteFunnel(P) {
  if (!DATA.site_funnel_daily?.length) return;
  const c = siteFunnel(P.cur);
  const comparable = P.prev[0] >= METRIKA_START;
  const p = comparable ? siteFunnel(P.prev) : {};
  const until = DATA.site_funnel_daily.filter((x) => x.visits > 0).at(-1)?.date;
  const tail = until && P.cur[1] > until ? ` · Метрика по ${dayTitle(until)}` : "";
  $("site-funnel-period").textContent = P.label;
  $("site-funnel-sub").textContent = `Только заказы с сайта, которые видит Яндекс Метрика${tail}`;
  const pc = (x, d) => (x == null ? "—" : `${(x * 100).toLocaleString("ru-RU", { maximumFractionDigits: d })}%`);
  const pp = (cur, prev) => (comparable ? ppDelta(cur, prev) : "");
  const share = (v) => (c.visits ? `${pc(v / c.visits, 1)} визитов` : "");
  const steps = [
    ["Визиты на сайт", num(c.visits), comparable ? deltaHtml(c.visits, p.visits, true, "") : ""],
    ["Добавили в корзину", num(c.carts), `лиды · ${share(c.carts)}`],
    ["Оформили заказ", num(c.checkouts), share(c.checkouts)],
    ["Оплатили", num(c.paid), rub(c.revenue)],
  ];
  const checkoutRate = c.carts ? c.checkouts / c.carts : null, prevCheckout = p.carts ? p.checkouts / p.carts : null;
  const arrows = [
    [pc(c.c1, 1), pp(c.c1, p.c1), "Визит → корзина (C1)"],
    [pc(checkoutRate, 0), pp(checkoutRate, prevCheckout), "Корзина → оформили"],
    [pc(c.pay, 0), pp(c.pay, p.pay), "Оформили → оплатили"],
  ];
  $("site-funnel-flow").innerHTML = steps.map(([label, value, note], i) => `
    <div class="flow-step${i === steps.length - 1 ? " last" : ""}">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="note">${note}</div>
    </div>` + (i < arrows.length ? `
    <div class="flow-arrow" title="${arrows[i][2]}">
      <span class="pct">${arrows[i][0]}</span>
      <span class="line" aria-hidden="true"></span>
      <span class="chg">${arrows[i][1]}</span>
    </div>` : "")).join("");
  const kpi = (label, value, delta, title) => `
    <div class="flow-kpi" title="${title}"><div class="label">${label}</div><div class="value">${value}</div><div class="chg">${delta}</div></div>`;
  $("site-funnel-summary").innerHTML =
    kpi("C1 · визит → лид", pc(c.c1, 1), pp(c.c1, p.c1), "Визиты с корзиной / все визиты") +
    kpi("C2 · лид → продажа", pc(c.c2, 1), pp(c.c2, p.c2), "Оплаченные заказы / визиты с корзиной") +
    kpi("Визит → оплата", pc(c.total, 2), pp(c.total, p.total), "Оплаченные заказы / все визиты");

  renderSiteWeeks();
  renderSiteChannels(P, c);
}

// weekly conversions, Monday weeks, last 26 full or current weeks
const SITE_RELIABLE_FROM = "2026-08-03"; // first Monday of August 2026
function mondayOf(d) {
  const t = new Date(Date.parse(d + "T00:00:00Z"));
  return addDays(d, -((t.getUTCDay() + 6) % 7));
}
function renderSiteWeeks() {
  const weeks = new Map();
  for (const r of DATA.site_funnel_daily) {
    if (r.visits === 0) continue; // days without Metrika data yet
    if (r.date < SITE_RELIABLE_FROM) continue; // purchases in Metrika are reliable since August 2026
    const w = mondayOf(r.date);
    if (!weeks.has(w)) weeks.set(w, { visits: 0, carts: 0, checkouts: 0, paid: 0, days: 0 });
    const x = weeks.get(w);
    x.visits += r.visits; x.carts += r.carts || 0; x.checkouts += r.checkouts; x.paid += r.paid_orders; x.days += 1;
  }
  const list = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-26);
  const pct1 = (v) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
  const mk = (key, f) => list.filter(([, x]) => f(x) != null).map(([w, x]) => ({
    label: dayShort(w),
    value: f(x) * 100,
    partial: x.days < 7,
    title: `Неделя с ${dayTitle(w)}${x.days < 7 ? ` (${x.days} дн.)` : ""}`,
    rows: [["Визиты", num(x.visits)], ["Корзины", num(x.carts)], ["Оформили", num(x.checkouts)], ["Оплатили", num(x.paid)],
      [key, pct1(f(x) * 100)]],
  }));
  c1Chart.update(mk("C1", (x) => (x.visits && x.carts ? x.carts / x.visits : null)));
  c2Chart.update(mk("C2", (x) => (x.carts ? x.paid / x.carts : null)));
  payChart.update(mk("Оплата оформленных", (x) => (x.checkouts ? x.paid / x.checkouts : null)));
  $("site-weeks-sub").textContent = "С августа 2026 (раньше данные Метрики неполные), неделя с понедельника · у каждой конверсии своя шкала · пустая точка — неделя неполная";
}

// funnel by channel for the period; conversions colored against the whole site
function renderSiteChannels(P, total) {
  const by = new Map();
  for (const r of DATA.site_funnel_channel_daily || []) {
    if (r.date < P.cur[0] || r.date > P.cur[1]) continue;
    if (!by.has(r.channel)) by.set(r.channel, { channel: r.channel, visits: 0, carts: 0, checkouts: 0, paid: 0, revenue: 0 });
    const x = by.get(r.channel);
    x.visits += r.visits; x.carts += r.carts; x.checkouts += r.checkouts; x.paid += r.paid_orders; x.revenue += r.paid_revenue;
  }
  // channels with under 100 visits go into one row: their conversions are noise
  const big = [...by.values()].filter((x) => x.visits >= 100).sort((a, b) => b.visits - a.visits);
  const small = [...by.values()].filter((x) => x.visits < 100);
  if (small.length) {
    const o = { channel: `Мелкие каналы (${small.length})`, visits: 0, carts: 0, checkouts: 0, paid: 0, revenue: 0 };
    for (const x of small) for (const k of ["visits", "carts", "checkouts", "paid", "revenue"]) o[k] += x[k];
    big.push(o);
  }
  const rows = big;
  const pc = (x, d) => (x == null ? "—" : `${(x * 100).toLocaleString("ru-RU", { maximumFractionDigits: d })}%`);
  // a conversion is marked only with enough data (50+ in its base) and a 20%+ difference from the site
  const mark = (v, base, n) => (v == null || base == null || n < 50 ? "" : v > base * 1.2 ? " good" : v < base * 0.8 ? " bad" : "");
  $("site-ch-period").textContent = P.label;
  $("site-ch-table").querySelector("tbody").innerHTML = rows.map((x) => {
    const c1 = x.visits && x.carts ? x.carts / x.visits : null;
    const c2 = x.carts ? x.paid / x.carts : null;
    const pay = x.checkouts ? x.paid / x.checkouts : null;
    return `<tr>
      <td>${x.channel}</td>
      <td>${num(x.visits)}</td>
      <td>${num(x.carts)}</td>
      <td>${num(x.checkouts)}</td>
      <td>${num(x.paid)}</td>
      <td>${num(x.revenue)}</td>
      <td class="cv${mark(c1, total.c1, x.visits)}">${pc(c1, 1)}</td>
      <td class="cv${mark(c2, total.c2, x.carts)}">${pc(c2, 1)}</td>
      <td class="cv${mark(pay, total.pay, x.checkouts)}">${pc(pay, 0)}</td>
    </tr>`;
  }).join("") + `<tr class="total-row">
      <td>Весь сайт</td><td>${num(total.visits)}</td><td>${num(total.carts)}</td><td>${num(total.checkouts)}</td>
      <td>${num(total.paid)}</td><td>${num(total.revenue)}</td>
      <td class="cv">${pc(total.c1, 1)}</td><td class="cv">${pc(total.c2, 1)}</td><td class="cv">${pc(total.pay, 0)}</td>
    </tr>`;
}

// ----------------------------------------------------------- customers
// Distinct buyers of a period from mart.customer_days: a buyer counts once, on
// the first purchase day inside the period (previous purchase before it or none).
const CUSTOMER_DAYS_FROM = "2025-01-01"; // mart.customer_days starts here
function sumCustomers([from, to]) {
  const s = { new_customers: 0, revenue_new: 0, revenue_repeat: 0, buyers: null };
  for (const r of DATA.customers_daily) {
    if (r.date < from || r.date > to) continue;
    s.new_customers += r.new_customers; s.revenue_new += r.revenue_new; s.revenue_repeat += r.revenue_repeat;
  }
  if (from >= CUSTOMER_DAYS_FROM && DATA.customer_days) {
    s.buyers = 0;
    for (const r of DATA.customer_days) {
      if (r.date >= from && r.date <= to && (r.prev_date == null || r.prev_date < from)) s.buyers += r.customers;
    }
  }
  s.repeat = s.buyers == null ? null : s.buyers - s.new_customers;
  s.new_share = s.buyers ? s.new_customers / s.buyers : null;
  s.revenue = s.revenue_new + s.revenue_repeat;
  s.revenue_new_share = s.revenue ? s.revenue_new / s.revenue : null;
  return s;
}
const pct = (v) => `${(v * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;

function renderCustomerKpis(P, comparable) {
  const c = sumCustomers(P.cur), p = sumCustomers(P.prev);
  const pv = (v) => (comparable ? v : null);
  const share = (v) => (v == null ? "" : `${pct(v)} от всех · `);
  $("cust-period").textContent = P.label;
  $("kpi-buyers").textContent = c.buyers == null ? "—" : num(c.buyers);
  $("kpi-buyers-delta").innerHTML = c.buyers == null ? "<span>считаем с 2025 года</span>" : deltaHtml(c.buyers, pv(p.buyers), true, "");
  $("kpi-new").textContent = num(c.new_customers);
  $("kpi-new-delta").innerHTML = share(c.new_share) + deltaHtml(c.new_customers, pv(p.new_customers), true, "");
  $("kpi-repeat").textContent = c.repeat == null ? "—" : num(c.repeat);
  $("kpi-repeat-delta").innerHTML = c.repeat == null ? "" : share(c.new_share == null ? null : 1 - c.new_share) + deltaHtml(c.repeat, pv(p.repeat), true, "");
  // revenue split: new vs repeat buyers (paid amount, by order date)
  $("kpi-rev-split").innerHTML = c.revenue
    ? `<div class="split-row"><span><i class="dot dot-new"></i>Новые</span><b>${rub(c.revenue_new)}</b><span class="muted">${pct(c.revenue_new_share)}</span></div>
       <div class="split-row"><span><i class="dot dot-repeat"></i>Повторные</span><b>${rub(c.revenue_repeat)}</b><span class="muted">${pct(1 - c.revenue_new_share)}</span></div>
       <div class="split-bar"><i style="width:${(c.revenue_new_share * 100).toFixed(1)}%"></i></div>`
    : "—";
}

// ------------------------------------------------------------ channels
// Channels that are not site traffic: no visits, no conversion.
const METRIKA_START = "2026-05-21"; // counter created; channel comparisons start here
const NO_TRAFFIC = new Set(["Менеджер (вручную)", "Не определен", "До счетчика Метрики"]);
const metrikaUntil = () => DATA.traffic_daily.at(-1)?.date ?? null;

function sumChannels([from, to]) {
  const by = new Map();
  const get = (ch) => {
    if (!by.has(ch)) by.set(ch, { channel: ch, orders: 0, revenue: 0, new_customers: 0, orders_conv: 0, visits: 0 });
    return by.get(ch);
  };
  const until = metrikaUntil();
  for (const r of DATA.channel_daily) {
    if (r.date < from || r.date > to) continue;
    const s = get(r.channel);
    s.orders += r.orders; s.revenue += r.revenue; s.new_customers += r.new_customers;
    // conversion only over days that already have Metrika visits
    if (until && r.date <= until) s.orders_conv += r.orders;
  }
  for (const r of DATA.traffic_daily) {
    if (r.date < from || r.date > to) continue;
    get(r.channel).visits += r.visits;
  }
  return by;
}

function renderChannels(P, comparable) {
  const cur = sumChannels(P.cur), prev = sumChannels(P.prev);
  const total = [...cur.values()].reduce((s, r) => s + r.revenue, 0);
  const rows = [...cur.values()].filter((r) => r.orders > 0).sort((a, b) => b.revenue - a.revenue);
  const maxShare = rows.length ? rows[0].revenue / total : 1;
  $("ch-period").textContent = P.label;
  const until = metrikaUntil();
  $("ch-sub").textContent = until && P.cur[1] > until
    ? `Оплаченные заказы МоегоСклада, канал по Яндекс Метрике · визиты по ${dayTitle(until)}`
    : "Оплаченные заказы МоегоСклада, канал по Яндекс Метрике (последний значимый переход)";

  $("channel-table").querySelector("tbody").innerHTML = rows.map((r) => {
    const share = total ? r.revenue / total : 0;
    const p = prev.get(r.channel);
    const traffic = !NO_TRAFFIC.has(r.channel);
    const conv = traffic && r.visits ? r.orders_conv / r.visits : null;
    const newShare = r.orders ? r.new_customers / r.orders : null;
    return `
    <tr${traffic ? "" : ' class="muted-row"'}>
      <td>${r.channel}</td>
      <td class="share-col"><span class="share-bar"><span class="track"><span class="fill" style="width:${(share / maxShare) * 100}%"></span></span><span class="pct">${pct(share)}</span></span></td>
      <td>${num(r.revenue)}</td>
      <td class="delta">${deltaHtml(r.revenue, comparable && p ? p.revenue : null, true, "")}</td>
      <td>${num(r.orders)}</td>
      <td title="Доля заказов, которые стали первой покупкой человека">${num(r.new_customers)}${newShare == null ? "" : ` <span class="muted small">${pct(newShare)}</span>`}</td>
      <td>${traffic ? num(r.visits) : "—"}</td>
      <td>${conv == null ? "—" : pct(conv)}</td>
    </tr>`;
  }).join("") + `
    <tr class="total-row">
      <td>Всего</td><td></td><td>${num(total)}</td><td></td>
      <td>${num(rows.reduce((s, r) => s + r.orders, 0))}</td>
      <td>${num(rows.reduce((s, r) => s + r.new_customers, 0))}</td>
      <td>${num(rows.reduce((s, r) => s + r.visits, 0))}</td><td></td>
    </tr>`;
}

// -------------------------------------------------------- publications
// Publications whose label date falls into the chosen period (undated labels skipped).
let pubShowAll = false;
let pubPeriod = null;
const PUB_TOP = 20;

function renderPublications(P) {
  pubPeriod = P;
  const rows = (DATA.pub_results || []).filter((r) => r.pub_date && r.pub_date >= P.cur[0] && r.pub_date <= P.cur[1]);
  $("pub-period").textContent = P.label;

  // by channel
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.channel)) by.set(r.channel, { channel: r.channel, n: 0, visits: 0, orders: 0, revenue: 0, new_customers: 0 });
    const c = by.get(r.channel);
    c.n += 1; c.visits += r.visits; c.orders += r.orders; c.revenue += r.revenue; c.new_customers += r.new_customers;
  }
  const ch = [...by.values()].sort((a, b) => b.revenue - a.revenue);
  const maxCh = Math.max(1, ...ch.map((c) => c.revenue));
  $("pub-channels").querySelector("tbody").innerHTML = ch.map((c) => `
    <tr>
      <td>${esc(c.channel)}</td>
      <td>${num(c.n)}</td>
      <td>${num(c.visits)}</td>
      <td>${num(c.orders)}</td>
      <td class="share-col"><span class="share-bar rev"><span class="track"><span class="fill" style="width:${(c.revenue / maxCh) * 100}%"></span></span><span class="pct">${num(c.revenue)}</span></span></td>
      <td>${num(c.revenue / c.n)}</td>
      <td>${num(c.new_customers)}</td>
    </tr>`).join("") + pubUndatedRows(P) || `<tr><td colspan="7" class="empty">За этот период публикаций нет</td></tr>`;

  // top publications
  const top = [...rows].sort((a, b) => b.revenue - a.revenue || b.visits - a.visits);
  const list = pubShowAll ? top : top.slice(0, PUB_TOP);
  const maxRev = Math.max(1, ...top.map((r) => r.revenue));
  $("pub-table").querySelector("tbody").innerHTML = list.map((r) => `
    <tr>
      <td data-sort="${r.pub_date}">${dayShort(r.pub_date)}</td>
      <td>${esc(r.channel)}</td>
      <td title="${esc(r.content)}">${esc(r.pub_type)}</td>
      <td class="name-col" title="${esc(r.content)}">${esc(r.campaigns || "—")}</td>
      <td>${num(r.visits)}</td>
      <td>${num(r.orders)}</td>
      <td>${r.visits ? pct(r.orders / r.visits) : "—"}</td>
      <td class="share-col"><span class="share-bar rev"><span class="track"><span class="fill" style="width:${(r.revenue / maxRev) * 100}%"></span></span><span class="pct">${num(r.revenue)}</span></span></td>
      <td>${num(r.new_customers)}</td>
    </tr>`).join("") || `<tr><td colspan="9" class="empty">За этот период публикаций нет</td></tr>`;
  $("pub-toggle").hidden = top.length <= PUB_TOP;
  $("pub-toggle").textContent = pubShowAll ? `Только топ-${PUB_TOP}` : `Показать все (${top.length})`;
}

// links without a dated label, summed over the period: one "Без даты" row and
// one "Мастер-классы (mk)" row under the channel table
function pubUndatedRows(P) {
  const rows = { "Мастер-классы": null, "Без даты": null };
  for (const r of DATA.pub_undated_daily || []) {
    if (r.date < P.cur[0] || r.date > P.cur[1]) continue;
    const x = rows[r.kind] || (rows[r.kind] = { visits: 0, orders: 0, revenue: 0, new_customers: 0 });
    x.visits += r.visits; x.orders += r.orders; x.revenue += r.revenue; x.new_customers += r.new_customers;
  }
  return [["Без даты", rows["Без даты"]], ["Мастер-классы (mk)", rows["Мастер-классы"]]]
    .filter(([, x]) => x && (x.visits || x.orders))
    .map(([label, x]) => `
    <tr class="total-row undated-row">
      <td>${label}</td>
      <td>—</td>
      <td>${num(x.visits)}</td>
      <td>${num(x.orders)}</td>
      <td>${num(x.revenue)}</td>
      <td>—</td>
      <td>${num(x.new_customers)}</td>
    </tr>`).join("");
}

// --------------------------------------------------------------- reels
// Reels whose date falls into the chosen period. No previous-period
// comparison: a reel's orders keep growing for weeks after it is posted.
// Conversions of the reels funnel. Each one uses only reels that have both
// steps (e.g. view -> code word only where comments were loaded).
function reelConversions(rows) {
  const sum = (k, list) => list.reduce((s, r) => s + (r[k] || 0), 0);
  const withViews = rows.filter((r) => r.ig_views > 0);
  const withCode = withViews.filter((r) => r.ig_code_commenters != null);
  const withBot = rows.filter((r) => r.bot_subscribers > 0);
  const ratio = (num_, den) => ({ num: num_, den, v: den ? num_ / den : null });
  return {
    viewCode: ratio(sum("ig_code_commenters", withCode), sum("ig_views", withCode)),
    viewBot: ratio(sum("bot_subscribers", withViews), sum("ig_views", withViews)),
    botSite: ratio(sum("visits", withBot), sum("bot_subscribers", withBot)),
    siteOrder: ratio(sum("orders", rows), sum("visits", rows)),
    botOrder: ratio(sum("orders", withBot), sum("bot_subscribers", withBot)),
    viewOrder: ratio(sum("orders", withViews), sum("ig_views", withViews)),
    revPer1000: ratio(sum("revenue", withViews) * 1000, sum("ig_views", withViews)),
  };
}

function renderReels(P) {
  const inRange = ([a, b]) => (DATA.reel_funnel || []).filter((r) => r.reel_date >= a && r.reel_date <= b);
  const rows = inRange(P.cur), prevRows = inRange(P.prev);
  const sum = (k, list = rows) => list.reduce((s, r) => s + (r[k] || 0), 0);
  const pctOf = (a, b, digits = 1) => (b ? `${(a / b * 100).toLocaleString("ru-RU", { maximumFractionDigits: digits })}%` : "—");
  const views = sum("ig_views");
  const codeRows = rows.filter((r) => r.ig_code_commenters != null);

  // one funnel card: steps in a row, the conversion sits on the arrow between them
  $("reel-period").textContent = P.label;
  const c = reelConversions(rows), p = reelConversions(prevRows);
  const pct = (x, d) => (x == null ? "—" : `${(x * 100).toLocaleString("ru-RU", { maximumFractionDigits: d })}%`);
  const pp = (cur, prev) => {
    if (cur == null || prev == null) return "";
    const d = Math.round((cur - prev) * 10000) / 100;
    if (Math.abs(d) < 0.005) return `<span class="flat">≈</span>`;
    const shown = Math.abs(d).toLocaleString("ru-RU", { maximumFractionDigits: Math.abs(d) >= 1 ? 1 : 2 });
    return `<span class="${d > 0 ? "good" : "bad"}">${d > 0 ? "▲" : "▼"} ${shown} п. п.</span>`;
  };
  const codeNote = codeRows.length
    ? `написали кодовое слово: ${num(sum("ig_code_commenters", codeRows))} (${pct(c.viewCode.v, 2)})` : "";
  const steps = [
    ["Просмотры", views ? num(views) : "—", `${num(sum("ig_reels"))} роликов${codeNote ? " · " + codeNote : ""}`],
    ["Пришли в бота", num(sum("bot_subscribers")), `новых в боте ${num(sum("bot_new_subscribers"))}`],
    ["Визиты на сайт", num(sum("visits")), "по ссылке из бота"],
    ["Оплаченные заказы", num(sum("orders")), `новых покупателей ${num(sum("new_customers"))}`],
    ["Выручка", rub(sum("revenue")), "МойСклад"],
  ];
  const arrows = [
    [pct(c.viewBot.v, 2), pp(c.viewBot.v, p.viewBot.v), "Просмотр → бот (C1)"],
    [pct(c.botSite.v, 0), pp(c.botSite.v, p.botSite.v), "Бот → сайт"],
    [pct(c.siteOrder.v, 1), pp(c.siteOrder.v, p.siteOrder.v), "Сайт → заказ"],
    ["", "", ""],
  ];
  $("reel-flow").innerHTML = steps.map(([label, value, note], i) => `
    <div class="flow-step${i === steps.length - 1 ? " last" : ""}">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="note">${note}</div>
    </div>` + (i < arrows.length ? `
    <div class="flow-arrow${arrows[i][0] ? "" : " plain"}" title="${arrows[i][2]}">
      <span class="pct">${arrows[i][0]}</span>
      <span class="line" aria-hidden="true"></span>
      <span class="chg">${arrows[i][1]}</span>
    </div>` : "")).join("");
  const sumItem = (label, value, delta, title) => `
    <div class="flow-kpi" title="${title}"><div class="label">${label}</div><div class="value">${value}</div><div class="chg">${delta}</div></div>`;
  const per1000 = (x) => (x == null ? "—" : rub(x));
  $("reel-summary").innerHTML =
    sumItem("C1 · просмотр → бот", pct(c.viewBot.v, 2), pp(c.viewBot.v, p.viewBot.v), "Пришли в бота / просмотры") +
    sumItem("C2 · бот → оплата", pct(c.botOrder.v, 1), pp(c.botOrder.v, p.botOrder.v), "Оплаченные заказы / пришли в бота") +
    sumItem("На 1 000 просмотров", per1000(c.revPer1000.v), "", "Выручка / просмотры × 1 000");
  // first touch: the person first came to the site from a reel's bot, bought later by any link
  $("kpi-reel-orders-first").textContent = `${num(sum("orders_first"))} заказов · ${rub(sum("revenue_first"))}`;

  // table: steps, then conversion columns
  const cv = (v, title = "") => (v === "—" ? `<td class="cv empty-cv" title="${title}">—</td>` : `<td class="cv" title="${title}">${v}</td>`);
  const maxRev = Math.max(1, ...rows.map((r) => r.revenue));
  const body = [...rows].reverse().map((r) => {
    const name = r.code_words || r.products || r.campaigns || "—";
    // first reel of the day links to Instagram (only instagram.com links are used)
    const link = r.permalinks && r.permalinks.startsWith("https://www.instagram.com/") ? r.permalinks.split(" ")[0] : null;
    const hint = [r.ig_reels > 1 && `Роликов в этот день: ${r.ig_reels}`, r.products && `Тег BotHelp: ${r.products}`, r.campaigns && `Ссылка в боте: ${r.campaigns}`,
      r.first_visit && `Визиты: ${dayShort(r.first_visit)} – ${dayShort(r.last_visit)}`,
      r.orders_first && `Первый переход: ${num(r.orders_first)} заказов на ${rub(r.revenue_first)}`].filter(Boolean).join(" · ");
    const hasCode = r.ig_code_commenters != null;
    return `
    <tr>
      <td data-sort="${r.reel_date}">${dayShort(r.reel_date)}</td>
      <td class="name-col" title="${esc(hint)}">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name)}</td>
      <td title="Охват: ${r.ig_reach ? num(r.ig_reach) : "—"}">${r.ig_views ? num(r.ig_views) : "—"}</td>
      <td title="Всего комментариев: ${r.ig_comments != null ? num(r.ig_comments) : "—"}">${hasCode ? num(r.ig_code_commenters) : "—"}</td>
      <td title="Из них новых в боте: ${num(r.bot_new_subscribers)}">${r.bot_subscribers ? num(r.bot_subscribers) : "—"}</td>
      <td>${num(r.visits)}</td>
      <td>${num(r.orders)}</td>
      <td class="share-col"><span class="share-bar rev"><span class="track"><span class="fill" style="width:${(r.revenue / maxRev) * 100}%"></span></span><span class="pct">${num(r.revenue)}</span></span></td>
      ${cv(r.ig_views && r.bot_subscribers ? pctOf(r.bot_subscribers, r.ig_views, 2) : "—",
        `Просмотр → написали слово: ${hasCode && r.ig_views ? pctOf(r.ig_code_commenters, r.ig_views, 2) : "—"}`)}
      ${cv(r.bot_subscribers ? pctOf(r.orders, r.bot_subscribers, 1) : "—",
        `Бот → сайт: ${r.bot_subscribers ? pctOf(r.visits, r.bot_subscribers, 0) : "—"} · Сайт → заказ: ${r.visits ? pctOf(r.orders, r.visits, 1) : "—"}`)}
      ${cv(r.ig_views ? num(r.revenue / r.ig_views * 1000) : "—")}
    </tr>`;
  }).join("");
  $("reel-table").querySelector("tbody").innerHTML = body ||
    `<tr><td colspan="11" class="empty">За этот период роликов нет</td></tr>`;
}

// channel mix heatmap: channels x months since the counter started
function renderChannelMonths() {
  const FIRST = "2026-06-01";
  const curMonth = lastDate().slice(0, 7) + "-01";
  const cells = new Map(); // month -> channel -> revenue
  for (const r of DATA.channel_daily) {
    if (r.date < FIRST) continue;
    const m = r.date.slice(0, 7) + "-01";
    if (!cells.has(m)) cells.set(m, new Map());
    const mm = cells.get(m);
    mm.set(r.channel, (mm.get(r.channel) || 0) + r.revenue);
  }
  const months = [...cells.keys()].sort();
  const totals = new Map(months.map((m) => [m, [...cells.get(m).values()].reduce((a, b) => a + b, 0)]));
  // channels ordered by revenue over the whole span
  const byChannel = new Map();
  for (const mm of cells.values()) for (const [ch, v] of mm) byChannel.set(ch, (byChannel.get(ch) || 0) + v);
  const channels = [...byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([ch]) => ch);

  let html = "<thead><tr><th>Канал</th>";
  for (const m of months) html += `<th>${monthLabel(m)}${m === curMonth ? "*" : ""}</th>`;
  html += "</tr></thead><tbody>";
  for (const ch of channels) {
    html += `<tr><td>${ch}</td>`;
    for (const m of months) {
      const v = cells.get(m).get(ch) || 0;
      const share = totals.get(m) ? v / totals.get(m) : 0;
      // 0..40% maps to light..full brand color
      const mix = Math.round(Math.min(1, share / 0.4) * 85) + 6;
      const ink = mix > 55 ? "#ffffff" : "var(--text)";
      html += `<td class="cell" style="background: color-mix(in srgb, var(--brand) ${mix}%, var(--surface)); color: ${ink}"
        title="${ch}, ${monthTitle(m)}${m === curMonth ? " (неполный)" : ""}: ${rub(v)}">${share >= 0.0005 ? pct(share) : "—"}</td>`;
    }
    html += "</tr>";
  }
  html += `<tr class="total-row"><td>Выручка, млн ₽</td>${months.map((m) => `<td>${(totals.get(m) / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}</td>`).join("")}</tr>`;
  $("channel-months").innerHTML = html + "</tbody>";
}

// cohort heatmap: last 12 cohorts x months 0..12, brand hue shaded by share
function renderCohorts() {
  const MAX_OFFSET = 12;
  const byCohort = new Map();
  for (const r of DATA.cohort_retention) {
    if (!byCohort.has(r.cohort_month)) byCohort.set(r.cohort_month, { size: r.cohort_size, cells: {} });
    byCohort.get(r.cohort_month).cells[r.month_offset] = r;
  }
  const lastMonth = lastDate().slice(0, 7) + "-01";
  const cohorts = [...byCohort.keys()].sort().slice(-12);
  const monthsBetween = (a, b) => { const x = parse(a), y = parse(b); return (y.y - x.y) * 12 + y.m - x.m; };
  let html = "<thead><tr><th>Когорта</th><th>Новых</th>";
  for (let k = 1; k <= MAX_OFFSET; k++) html += `<th>+${k}</th>`;
  html += "</tr></thead><tbody>";
  for (const cm of cohorts) {
    const { size, cells } = byCohort.get(cm);
    html += `<tr><td>${monthLabel(cm)}</td><td class="size">${num(size)}</td>`;
    const available = monthsBetween(cm, lastMonth); // offsets that already happened
    for (let k = 1; k <= MAX_OFFSET; k++) {
      if (k > available) { html += "<td></td>"; continue; }
      const r = cells[k];
      const share = r ? r.customers / size : 0;
      // 0..50% maps to light..full brand color; above 50% stays full
      const mix = Math.round(Math.min(1, share / 0.5) * 85) + 6;
      const ink = mix > 55 ? "#ffffff" : "var(--text)";
      const partial = k === available ? " (неполный месяц)" : "";
      html += `<td class="cell" style="background: color-mix(in srgb, var(--brand) ${mix}%, var(--surface)); color: ${ink}"
        title="${monthTitle(cm)}, через ${k} мес.${partial}: ${r ? num(r.customers) : 0} из ${num(size)} · ${r ? rub(r.revenue) : "0 ₽"}">${Math.round(share * 100)}%</td>`;
    }
    html += "</tr>";
  }
  $("cohort-table").innerHTML = html + "</tbody>";
}

// LTV: cumulative revenue per customer of a cohort (mart.cohort_ltv).
// Tiles: averages weighted by cohort size, cohorts since 2025, finished months only.
// The table switches between LTV per buyer and the cohort's cumulative revenue.
let ltvMode = "per";
try { if (localStorage.getItem("ltvMode") === "total") ltvMode = "total"; } catch (e) { /* ignore */ }
function initLtvSwitch() {
  document.querySelectorAll("[data-ltv]").forEach((b) => b.addEventListener("click", () => {
    ltvMode = b.dataset.ltv === "total" ? "total" : "per";
    try { localStorage.setItem("ltvMode", ltvMode); } catch (e) { /* ignore */ }
    renderLtv();
  }));
}
function renderLtv() {
  const rows = DATA.cohort_ltv || [];
  if (!rows.length) return;
  const HORIZONS = [0, 1, 2, 3, 6, 9, 12];
  const avg = (k) => {
    const r = rows.filter((x) => x.month_offset === k && x.complete && x.cohort_month >= "2025-01-01");
    const n = r.reduce((s, x) => s + x.cohort_size, 0);
    return { ltv: n ? r.reduce((s, x) => s + x.cum_revenue, 0) / n : null, cohorts: r.length, customers: n };
  };
  const base = avg(0);
  const times = (v) => (base.ltv && v ? ` · ×${(v / base.ltv).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} к первому месяцу` : "");
  const tiles = [
    [0, "Первый месяц", "месяц первой покупки"],
    [3, "За 3 месяца", ""],
    [6, "За полгода", ""],
    [12, "За год", ""],
  ];
  $("ltv-tiles").innerHTML = tiles.map(([k, label, note]) => {
    const a = avg(k);
    return `<div class="tile card"><div class="label">${label}</div><div class="value">${a.ltv == null ? "—" : rub(a.ltv)}</div>
      <div class="delta">${note || `${num(a.cohorts)} когорт, ${num(a.customers)} покупателей`}${k ? times(a.ltv) : ""}</div></div>`;
  }).join("");

  // table: last 12 cohorts x horizons
  const byCohort = new Map();
  for (const r of rows) {
    if (!byCohort.has(r.cohort_month)) byCohort.set(r.cohort_month, { size: r.cohort_size, cells: {} });
    byCohort.get(r.cohort_month).cells[r.month_offset] = r;
  }
  const cohorts = [...byCohort.keys()].sort().slice(-12);
  const shown = cohorts.flatMap((c) => HORIZONS.map((k) => byCohort.get(c).cells[k]).filter(Boolean));
  const total = ltvMode === "total";
  const val = (r) => (total ? r.cum_revenue : r.ltv);
  const max = Math.max(1, ...shown.map(val));
  document.querySelectorAll("[data-ltv]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.ltv === ltvMode)));
  let html = "<thead><tr><th>Когорта</th><th>Новых</th>" + HORIZONS.map((k) => `<th>${k === 0 ? "1-й мес" : `+${k} мес`}</th>`).join("") + "</tr></thead><tbody>";
  for (const c of cohorts) {
    const { size, cells } = byCohort.get(c);
    html += `<tr><td>${monthLabel(c)}</td><td class="size">${num(size)}</td>`;
    for (const k of HORIZONS) {
      const r = cells[k];
      if (!r) { html += "<td></td>"; continue; }
      const mix = Math.round(Math.min(1, val(r) / max) * 80) + 8;
      const ink = mix > 55 ? "#ffffff" : "var(--text)";
      html += `<td class="cell${r.complete ? "" : " partial"}" style="background: color-mix(in srgb, var(--brand) ${mix}%, var(--surface)); color: ${ink}"
        title="${monthTitle(c)}, ${k === 0 ? "месяц первой покупки" : `через ${k} мес.`}${r.complete ? "" : " (месяц еще идет)"}: ${rub(r.cum_revenue)} на ${num(size)} покупателей · ${rub(r.ltv)} на одного">${total ? compact(r.cum_revenue) : num(r.ltv)}</td>`;
    }
    html += "</tr>";
  }
  $("ltv-table").innerHTML = html + "</tbody>";
  $("ltv-sub").textContent = (total
    ? "Накопленная выручка всей когорты с первой покупки, ₽."
    : "Накопленная выручка на одного покупателя когорты, ₽.") + " Светлее с пунктиром — месяц еще идет.";
}

function renderSecondOrderGap() {
  const rows = DATA.second_order_gap;
  const max = Math.max(...rows.map((r) => r.share));
  const total = rows.reduce((s, r) => s + r.customers, 0);
  $("gap-sub").textContent = `${num(total)} покупателей, впервые купивших 1–2 года назад`;
  $("gap-bars").innerHTML = rows.map((r) => `
    <div class="gap-row${r.bucket === "не вернулись" ? " muted-row" : ""}" title="${num(r.customers)} покупателей">
      <span class="name">${r.bucket}</span>
      <span class="track"><span class="fill" style="display:block; width:${(r.share / max) * 100}%"></span></span>
      <span class="pct">${pct(r.share)}</span>
    </div>`).join("");
}

// -------------------------------------------------------------- charts
const SVG_NS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

const tip = $("tooltip");
function showTip(evt, title, rows) {
  tip.innerHTML = `<b>${title}</b>` + rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join("");
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

// Shared frame: clean y ticks with hairline grid; headroom on top for labels.
function frame(svg, W, H, maxVal, fmt) {
  const m = { top: 22, right: 12, bottom: 24, left: 52 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const step = niceStep((maxVal || 1) / 4);
  const top = Math.ceil((maxVal || 1) / step) * step;
  const y = (v) => m.top + ih - (v / top) * ih;
  for (let v = 0; v <= top + 1e-9; v += step) {
    el("line", { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), class: v === 0 ? "baseline" : "gridline" }, svg);
    el("text", { x: m.left - 8, y: y(v) + 4, "text-anchor": "end", class: "axis-text" }, svg).textContent = fmt(v);
  }
  return { m, iw, ih, y };
}
function xLabels(svg, items, xCenter, m, H, iw) {
  const every = Math.max(1, Math.ceil(items.length / Math.max(1, Math.floor(iw / 56))));
  items.forEach((it, i) => {
    if ((items.length - 1 - i) % every !== 0) return; // always label the latest
    el("text", { x: xCenter(i), y: H - m.bottom + 16, "text-anchor": "middle", class: "axis-text" }, svg).textContent = it.label;
  });
}
const argMax = (items) => items.reduce((best, d, i) => (d.value > items[best].value ? i : best), 0);

// A chart keeps its items and redraws on resize or update().
function makeChart(container, drawFn) {
  let items = [];
  const draw = () => {
    container.innerHTML = "";
    // skip while the container has no real size yet (page still laying out)
    if (items.length && container.clientWidth > 120 && container.clientHeight > 60) drawFn(container, items);
  };
  new ResizeObserver(draw).observe(container);
  return { update(next) { items = next; draw(); } };
}

function drawColumns(container, items) {
  const W = container.clientWidth, H = container.clientHeight;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": container.dataset.label || "" }, container);
  const { m, iw, ih, y } = frame(svg, W, H, Math.max(...items.map((d) => d.value)), compact);
  const band = iw / items.length;
  const bw = Math.min(24, Math.max(2, band - 2));
  const xc = (i) => m.left + band * i + band / 2;
  const base = m.top + ih;
  // label every bar when there is room, otherwise only the max and the latest.
  // Millions are printed short ("2,6"), the unit is in the chart subtitle.
  const short = (v) => (v / 1e6).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const labelAll = band >= 26;
  const iMax = argMax(items);
  items.forEach((d, i) => {
    const h = Math.max(0, base - y(d.value));
    const x = xc(i) - bw / 2;
    const r = Math.min(4, bw / 2, h);
    // rounded data end, square at the baseline
    const path = h <= 0 ? "" :
      `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bw - r} Q${x + bw},${base - h} ${x + bw},${base - h + r} V${base} Z`;
    const bar = el("path", { d: path, class: `bar${d.partial ? " partial" : ""}` }, svg);
    if (labelAll || i === iMax || i === items.length - 1) {
      const t = el("text", { x: xc(i), y: base - h - 6, "text-anchor": "middle", class: `value-label${i === iMax ? " strong" : ""}` }, svg);
      t.textContent = short(d.value);
      // measured: if the label sticks out past the right edge, right-align it inside
      const b = t.getBBox();
      if (b.x + b.width > W) { t.setAttribute("text-anchor", "end"); t.setAttribute("x", W); }
    }
    const hit = el("rect", { x: m.left + band * i, y: m.top - 16, width: band, height: ih + 16, class: "hit" }, svg);
    hit.addEventListener("mousemove", (e) => { svg.querySelectorAll(".bar").forEach((b) => b.classList.toggle("dim", b !== bar)); showTip(e, d.title, d.rows); });
    hit.addEventListener("mouseleave", () => { svg.querySelectorAll(".bar").forEach((b) => b.classList.remove("dim")); hideTip(); });
  });
  xLabels(svg, items, xc, m, H, iw);
}

function drawLine(container, items, labelFmt, axisFmt = compact) {
  const W = container.clientWidth, H = container.clientHeight;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": container.dataset.label || "" }, container);
  const { m, iw, ih, y } = frame(svg, W, H, Math.max(...items.map((d) => d.value)), axisFmt);
  const n = items.length;
  const x = (i) => m.left + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const pts = items.map((d, i) => `${x(i)},${y(d.value)}`);
  el("path", { d: `M${x(0)},${m.top + ih} L${pts.join(" L")} L${x(n - 1)},${m.top + ih} Z`, class: "area" }, svg);
  el("path", { d: `M${pts.join(" L")}`, class: "line" }, svg);

  // direct labels: the maximum and the latest point only
  const iMax = argMax(items), iLast = n - 1;
  // incomplete days (payments not posted yet): hollow dots
  items.forEach((d, i) => { if (d.partial) el("circle", { cx: x(i), cy: y(d.value), r: 4, class: "dot partial" }, svg); });

  for (const i of new Set([iMax, iLast])) {
    el("circle", { cx: x(i), cy: y(items[i].value), r: 4, class: `dot${items[i].partial ? " partial" : ""}` }, svg);
    const anchor = x(i) > W - 60 ? "end" : x(i) < m.left + 40 ? "start" : "middle";
    el("text", { x: x(i), y: y(items[i].value) - 9, "text-anchor": anchor, class: `value-label${i === iMax ? " strong" : ""}` }, svg)
      .textContent = labelFmt(items[i].value);
  }

  const cross = el("line", { y1: m.top, y2: m.top + ih, class: "crosshair", visibility: "hidden" }, svg);
  const hover = el("circle", { r: 4, class: "dot", visibility: "hidden" }, svg);
  const hit = el("rect", { x: m.left, y: m.top - 16, width: iw, height: ih + 16, class: "hit" }, svg);
  hit.addEventListener("mousemove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) * (W / box.width);
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.left) / iw) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    hover.setAttribute("cx", x(i)); hover.setAttribute("cy", y(items[i].value)); hover.setAttribute("visibility", "visible");
    showTip(e, items[i].title, items[i].rows);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hover.setAttribute("visibility", "hidden"); hideTip(); });
  xLabels(svg, items, x, m, H, iw);
}

// Stacked columns: segment 1 (bottom, brand) + segment 2 (top, series-2),
// 2px surface gap between segments, rounded top only.
function drawStacked(container, items) {
  const W = container.clientWidth, H = container.clientHeight;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Покупатели по месяцам" }, container);
  const totals = items.map((d) => d.a + d.b);
  const { m, iw, ih, y } = frame(svg, W, H, Math.max(...totals), compact);
  const band = iw / items.length;
  const bw = Math.min(24, Math.max(2, band - 2));
  const xc = (i) => m.left + band * i + band / 2;
  const base = m.top + ih;
  const iMax = totals.indexOf(Math.max(...totals));
  const rect = (x, yTop, h, rTop, cls) => {
    if (h <= 0) return el("g", {}, svg);
    const r = Math.min(rTop, bw / 2, h);
    return el("path", { d: `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bw - r} Q${x + bw},${yTop} ${x + bw},${yTop + r} V${yTop + h} Z`, class: cls }, svg);
  };
  items.forEach((d, i) => {
    const x = xc(i) - bw / 2;
    const hA = base - y(d.a), hB = base - y(d.a + d.b) - hA;
    const gap = hA > 0 && hB > 0 ? 2 : 0;
    const segA = rect(x, base - hA, hA, hB > 0 ? 0 : 4, "bar");
    const segB = rect(x, base - hA - hB, Math.max(0, hB - gap), 4, "bar s2");
    if (i === iMax || i === items.length - 1) {
      const t = el("text", { x: xc(i), y: base - hA - hB - 6, "text-anchor": "middle", class: `value-label${i === iMax ? " strong" : ""}` }, svg);
      t.textContent = num(d.a + d.b);
      const b = t.getBBox();
      if (b.x + b.width > W) { t.setAttribute("text-anchor", "end"); t.setAttribute("x", W); }
    }
    const hit = el("rect", { x: m.left + band * i, y: m.top - 16, width: band, height: ih + 16, class: "hit" }, svg);
    hit.addEventListener("mousemove", (e) => {
      svg.querySelectorAll(".bar").forEach((b) => b.classList.toggle("dim", b !== segA && b !== segB));
      showTip(e, d.title, d.rows);
    });
    hit.addEventListener("mouseleave", () => { svg.querySelectorAll(".bar").forEach((b) => b.classList.remove("dim")); hideTip(); });
  });
  xLabels(svg, items, xc, m, H, iw);
}

const customersChart = makeChart($("chart-customers"), drawStacked);
const monthlyChart = makeChart($("chart-monthly"), drawColumns);
const dailyChart = makeChart($("chart-daily"), (c, items) => drawLine(c, items, compact));
const avgChart = makeChart($("chart-avg"), (c, items) => drawLine(c, items, rub));
// site funnel: three small charts, each with its own scale (values are percents)
const pctLabel = (v) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
const pctAxisFmt = (v) => `${Math.round(v)}%`;
const c1Chart = makeChart($("chart-c1"), (c, items) => drawLine(c, items, pctLabel, pctAxisFmt));
const c2Chart = makeChart($("chart-c2"), (c, items) => drawLine(c, items, pctLabel, pctAxisFmt));
const payChart = makeChart($("chart-pay"), (c, items) => drawLine(c, items, pctLabel, pctAxisFmt));

// ---------------------------------------------------------- daily chart
// Two views of the same days: "shipped" = revenue (shipments - returns, by shipment
// date), "paid" = paid orders by order date (shows demand and promo spikes at once).
let dailyMode = "paid";
let lastPeriod = null;
try { if (localStorage.getItem("dailyMode2") === "shipped") dailyMode = "shipped"; } catch (e) { /* ignore */ }

// a day is incomplete for "Оплачено" while many of its payments are not posted yet
function pendingInfo() {
  const pending = new Map((DATA.sales_pending || []).map((r) => [r.date, r]));
  const isPartial = (r) => { const p = pending.get(r.date); return !!p && p.pending_orders >= 0.1 * (r.orders + p.pending_orders); };
  return { pending, isPartial };
}

function renderDaily(P) {
  lastPeriod = P;
  // follows the period (at least 14 days, so a short pick still has context)
  let from = P.cur[0];
  if (daysBetween(from, P.cur[1]) < 13) from = addDays(P.cur[1], -13);
  if (from < firstDate()) from = firstDate();
  const days = DATA.sales_daily.filter((r) => r.date >= from && r.date <= P.cur[1]);
  const { pending, isPartial } = pendingInfo();
  const paid = dailyMode === "paid";
  const hasPartial = paid && days.some(isPartial);
  $("daily-title").textContent = paid ? "Выручка по дням" : "Финансовая выручка по дням";
  $("daily-sub").textContent = rangeText(from, P.cur[1])
    + (paid ? " · по дню заказа" : " · по дню отгрузки")
    + (hasPartial ? " · пустая точка — оплаты за день еще проводятся" : "");
  document.querySelectorAll("[data-daily]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.daily === dailyMode)));
  dailyChart.update(days.map((r) => {
    const p = pending.get(r.date);
    const part = paid && isPartial(r);
    return {
      label: dayShort(r.date),
      value: paid ? r.revenue : r.shipped_revenue,
      partial: part,
      title: dayTitle(r.date) + (part ? " (неполный)" : ""),
      rows: [["Выручка", rub(r.revenue)], ["Заказы", num(r.orders)], ["Отгрузки − возвраты", rub(r.shipped_revenue)],
        ...(p && isPartial(r) ? [["Ждут оплаты", `${num(p.pending_orders)} · ${rub(p.pending_sum)}`]] : [])],
    };
  }));
}
function initDailySwitch() {
  document.querySelectorAll("[data-daily]").forEach((b) => b.addEventListener("click", () => {
    dailyMode = b.dataset.daily === "shipped" ? "shipped" : "paid";
    try { localStorage.setItem("dailyMode2", dailyMode); } catch (e) { /* ignore */ }
    if (lastPeriod) renderDaily(lastPeriod);
  }));
}

// ------------------------------------------------------- рука на пульсе
// Tanya's spec, first stage. Data: mart.pulse_daily (per day x owner),
// mart.pulse_orders (open and recent orders), mart.pulse_plans (entered on the page),
// mart.work_calendar. "Today" is the Ufa calendar day.
let pulsePeriod = null;
const ufaNow = () => new Date(Date.now() + 5 * 3600e3); // Ufa = UTC+5, read with getUTC*
const ufaToday = () => ufaNow().toISOString().slice(0, 10);
const tsShort = (t) => { if (!t) return "—"; const d = t.slice(0, 10); return `${dayShort(d)} ${t.slice(11, 16)}`; };
const msLink = (id) => `https://online.moysklad.ru/app/#customerorder/edit?id=${encodeURIComponent(id)}`;
function hoursSince(t) {
  if (!t) return null;
  const [d, hm] = [t.slice(0, 10), t.slice(11, 16) || "00:00"];
  const then = Date.parse(`${d}T${hm}:00Z`); // both in Ufa clock, compared as UTC
  return (ufaNow().getTime() - then) / 3600e3;
}
const waitText = (h) => (h == null ? "—" : h < 24 ? `${Math.max(0, Math.round(h))} ч` : `${Math.floor(h / 24)} дн.`);
const empName = (key) => (DATA.pulse_employees || []).find((e) => e.owner_key === key)?.name || "—";

function workdays(monthStart, today) {
  const ym = monthStart.slice(0, 7);
  const days = (DATA.work_calendar || []).filter((d) => d.date.slice(0, 7) === ym && d.is_workday).map((d) => d.date);
  return {
    total: days.length,
    passedInclToday: days.filter((d) => d <= today).length,
    completed: days.filter((d) => d < today).length,
    leftInclToday: days.filter((d) => d >= today).length,
  };
}
function planOf(month, key) {
  const r = (DATA.pulse_plans || []).find((x) => x.month === month && x.owner_key === key);
  return r ? Number(r.plan) : null;
}

function renderPulse(P) {
  pulsePeriod = P;
  if (!DATA.pulse_daily) return;
  const today = ufaToday();
  const month = today.slice(0, 7) + "-01";
  const { y, m } = parse(today);
  const rows = DATA.pulse_daily;
  const sumBy = (k, f) => rows.reduce((a, r) => a + (f(r) ? Number(r[k]) : 0), 0);
  const inMonth = (r) => r.date >= month && r.date <= today;
  const fresh = DATA.data_freshness.find((r) => r.source === "moysklad");
  // refreshed_at is a UTC timestamp; show it in Ufa time
  const freshUfa = fresh ? new Date(Date.parse(fresh.refreshed_at) + 5 * 3600e3).toISOString().slice(0, 16) : null;
  const SRC = { moysklad: "МойСклад", metrika: "Метрика", bothelp: "BotHelp", instagram: "Instagram" };
  const fUfa = (t) => new Date(Date.parse(t) + 5 * 3600e3).toISOString().slice(0, 16);
  $("pulse-fresh").textContent = (freshUfa ? `Данные МоегоСклада на ${tsShort(freshUfa)} по Уфе · в будни обновляется каждый час с 9 до 19` : "")
    + " · последняя загрузка: " + DATA.data_freshness.map((r) => `${SRC[r.source] || r.source} ${tsShort(fUfa(r.refreshed_at))}`).join(", ");

  // ---- plan vs fact
  $("pulse-plan-title").textContent = `План-факт · ${MONTHS_SHORT[m - 1]} ${y}`;
  const plan = planOf(month, "total");
  const fact = sumBy("paid_sum", inMonth);
  const factToYesterday = sumBy("paid_sum", (r) => r.date >= month && r.date < today);
  const shippedOfOrders = sumBy("shipped_of_orders", inMonth);
  const moneyIn = sumBy("payments_in", inMonth);
  const potential = (DATA.pulse_orders || []).filter((o) => o.waits_payment).reduce((a, o) => a + (o.sum_rub - o.paid_rub), 0);
  const wd = workdays(month, today);
  const pct = (v) => `${(v * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
  let html;
  if (!plan) {
    html = `<p class="muted">План на этот месяц не задан — внесите его в блоке «Планы» внизу.</p>`;
  } else {
    const planToDate = wd.total ? plan * wd.passedInclToday / wd.total : 0;
    const forecast = wd.completed ? factToYesterday / wd.completed * wd.total : null;
    const need = wd.leftInclToday ? Math.max(0, plan - fact) / wd.leftInclToday : null;
    const gap = fact - planToDate;
    const done = fact / plan;
    html = `
      <div class="pulse-hero">
        <div><div class="label">Факт</div><div class="hero-value">${rub(fact)}</div>
          <div class="delta">из ${rub(plan)} · <b>${pct(done)}</b> плана</div></div>
        <div class="pulse-bar" title="Отметка — план на сегодня">
          <span class="fill" style="width:${Math.min(100, done * 100).toFixed(1)}%"></span>
          <span class="mark" style="left:${Math.min(100, planToDate / plan * 100).toFixed(1)}%"></span>
        </div>
      </div>
      <div class="tiles pulse-plan-tiles">
        <div class="tile"><div class="label">План на сегодня</div><div class="value">${rub(planToDate)}</div>
          <div class="delta"><span class="plan-accent">${gap >= 0 ? "опережаем на" : "отстаем на"} ${rub(Math.abs(gap))}</span></div></div>
        <div class="tile"><div class="label">Прогноз месяца</div><div class="value">${forecast == null ? "—" : rub(forecast)}</div>
          <div class="delta">${forecast == null ? "нет завершенных рабочих дней" : `${pct(forecast / plan)} плана при текущем темпе`}</div></div>
        <div class="tile"><div class="label">Нужно в рабочий день</div><div class="value plan-accent">${need == null ? "—" : rub(need)}</div>
          <div class="delta">остаток ${rub(Math.max(0, plan - fact))}</div></div>
        <div class="tile"><div class="label">Рабочие дни</div><div class="value">${wd.passedInclToday} из ${wd.total}</div>
          <div class="delta">осталось ${wd.leftInclToday}, включая сегодня</div></div>
      </div>`;
  }
  html += `
      <div class="pulse-sub">
        <span title="Отгрузки по заказам, созданным в этом месяце (показатель G из таблицы Тани)">Отгружено по заказам месяца: <b>${rub(shippedOfOrders)}</b></span>
        <span title="Все входящие платежи по дате платежа">Поступило денег за месяц: <b>${rub(moneyIn)}</b></span>
        <span title="Остаток к оплате по заказам последних 30 дней без полной оплаты">Ждут оплаты: <b>${rub(potential)}</b></span>
      </div>`;
  // returns, sales after returns, margin, average checks (month to date)
  const sd = (DATA.sales_daily || []).filter((r) => r.date >= month && r.date <= today);
  const retN = sd.reduce((a, r) => a + r.returns, 0), retSum = sd.reduce((a, r) => a + r.returns_sum, 0);
  const afterReturns = sd.reduce((a, r) => a + r.shipped_revenue, 0);
  const mm = (DATA.pulse_margin_month || []).find((r) => r.month === month);
  const createdN = sumBy("created", inMonth), createdSum = sumBy("created_sum", inMonth);
  const paidN = sumBy("paid_orders", inMonth), shippedN = sumBy("shipped_orders", inMonth);
  const avg = (sum, n) => (n ? rub(sum / n) : "—");
  html += `
      <div class="pulse-sub">
        <span title="Возвраты по дате документа возврата">Возвраты за месяц: <b>${num(retN)} шт. · ${rub(retSum)}</b></span>
        <span title="Отгрузки за месяц минус возвраты, по дате документа (финансовая выручка)">Продажи после возвратов: <b>${rub(afterReturns)}</b></span>
        ${mm ? `<span title="Отчет «Прибыльность»: (продажи − себестоимость) / продажи. Ошибочные строки себестоимости исключены. Себестоимость известна у ${pct(mm.known_cost_share || 0)} продаж">Валовая прибыль: <b>${rub(mm.gross_profit)}</b> · маржа <b>${mm.margin == null ? "—" : pct(mm.margin)}</b></span>` : ""}
      </div>
      <div class="pulse-sub">
        <span>Средний чек за месяц —</span>
        <span title="Сумма созданных заказов / их число">созданных: <b>${avg(createdSum, createdN)}</b></span>
        <span title="Оплаченная сумма / число заказов с оплатой">оплаченных: <b>${avg(fact, paidN)}</b></span>
        <span title="Отгружено по заказам месяца / число заказов с отгрузкой">отгруженных: <b>${avg(shippedOfOrders, shippedN)}</b></span>
      </div>`;
  $("pulse-plan").innerHTML = html;

  // ---- today
  $("pulse-today-label").textContent = dayTitle(today);
  const isToday = (r) => r.date === today;
  const tiles = [
    ["created", "Создано заказов", num(sumBy("created", isToday)), rub(sumBy("created_sum", isToday))],
    ["paid", "Оплачено полностью", num(sumBy("fully_paid", isToday)), rub(sumBy("fully_paid_sum", isToday))],
    [null, "Поступило денег", rub(sumBy("payments_in", isToday)), "все платежи за день"],
    [null, "Отгружено", rub(sumBy("shipped_on_day", isToday)), "по дате отгрузки"],
  ];
  $("pulse-today").innerHTML = tiles.map(([k, label, value, note]) => `
    <div class="tile card${k ? " clickable" : ""}" ${k ? `data-detail="today-${k}" role="button" tabindex="0"` : ""}>
      <div class="label">${label}</div><div class="value">${value}</div><div class="delta">${note}</div></div>`).join("");

  // ---- managers
  const [pf, pt] = P.cur;
  $("pulse-mgr-period").textContent = `Период: ${rangeText(pf, pt)}`;
  const emps = (DATA.pulse_employees || []).filter((e) => e.active || rows.some((r) => r.owner_key === e.owner_key && inMonth(r) && (r.created || r.paid_sum)));
  const mgr = emps.map((e) => {
    const own = (f) => (r) => r.owner_key === e.owner_key && f(r);
    const inP = (r) => r.date >= pf && r.date <= pt;
    const pOrders = sumBy("paid_orders", own(inP)), pRev = sumBy("paid_sum", own(inP));
    const mRev = sumBy("paid_sum", own(inMonth));
    const mPlan = planOf(month, e.owner_key);
    return {
      name: e.name, site: e.owner_key === "site",
      tCreated: sumBy("created", own(isToday)), tPaid: sumBy("fully_paid_sum", own(isToday)),
      pOrders, pRev, pAvg: pOrders ? pRev / pOrders : null,
      mRev, mPlan, mPct: mPlan ? mRev / mPlan : null, perDay: wd.passedInclToday ? mRev / wd.passedInclToday : null,
    };
  }).filter((x) => x.tCreated || x.pOrders || x.mRev || x.mPlan).sort((a, b) => (a.site - b.site) || b.mRev - a.mRev);
  const tot = mgr.reduce((a, x) => ({ tCreated: a.tCreated + x.tCreated, tPaid: a.tPaid + x.tPaid, pOrders: a.pOrders + x.pOrders, pRev: a.pRev + x.pRev, mRev: a.mRev + x.mRev }),
    { tCreated: 0, tPaid: 0, pOrders: 0, pRev: 0, mRev: 0 });
  const dash = (v, f) => (v == null ? "—" : f(v));
  $("pulse-mgr").querySelector("tbody").innerHTML = mgr.map((x) => `
    <tr${x.site ? ' class="muted-row"' : ""}>
      <td>${esc(x.name)}</td>
      <td class="grp-start">${num(x.tCreated)}</td><td>${num(x.tPaid)}</td>
      <td class="grp-start">${num(x.pOrders)}</td><td>${num(x.pRev)}</td><td>${dash(x.pAvg, num)}</td>
      <td class="grp-start">${num(x.mRev)}</td><td>${dash(x.mPlan, num)}</td><td>${dash(x.mPct, pct)}</td><td>${dash(x.perDay, num)}</td>
    </tr>`).join("") + `
    <tr class="total-row">
      <td>Итого</td><td class="grp-start">${num(tot.tCreated)}</td><td>${num(tot.tPaid)}</td>
      <td class="grp-start">${num(tot.pOrders)}</td><td>${num(tot.pRev)}</td><td>${tot.pOrders ? num(tot.pRev / tot.pOrders) : "—"}</td>
      <td class="grp-start">${num(tot.mRev)}</td><td>${dash(plan, num)}</td><td>${plan ? pct(tot.mRev / plan) : "—"}</td>
      <td>${wd.passedInclToday ? num(tot.mRev / wd.passedInclToday) : "—"}</td>
    </tr>`;

  // ---- shipment queue
  const orders = DATA.pulse_orders || [];
  const queue = orders.filter((o) => o.in_queue);
  const ORDER = ["Новый", "Оплачено", "Согласование заказа", "Подтвержден", "Связаться с клиентом", "Сборка заказа", "Готов к отправке", "Сборка Сдэк", "Привезти в офис"];
  const byState = ORDER.map((st) => {
    const list = queue.filter((o) => o.state === st);
    const waits = list.map((o) => hoursSince(o.fully_paid_ts));
    return { st, n: list.length, sum: list.reduce((a, o) => a + o.sum_rub, 0), late: waits.filter((h) => h > 48).length, oldest: waits.length ? Math.max(...waits) : null };
  }).filter((x) => x.n);
  const qLate = queue.filter((o) => hoursSince(o.fully_paid_ts) > 48);
  $("pulse-queue").querySelector("tbody").innerHTML = byState.map((x) => `
    <tr class="clickable" data-detail="queue:${esc(x.st)}" tabindex="0">
      <td>${esc(x.st)}</td><td>${num(x.n)}</td><td>${num(x.sum)}</td>
      <td class="${x.late ? "bad-text" : ""}">${num(x.late)}</td><td>${waitText(x.oldest)}</td>
    </tr>`).join("") + (queue.length ? `
    <tr class="total-row clickable" data-detail="queue:all" tabindex="0"><td>Всего</td><td>${num(queue.length)}</td>
      <td>${num(queue.reduce((a, o) => a + o.sum_rub, 0))}</td><td>${num(qLate.length)}</td>
      <td>${waitText(Math.max(...queue.map((o) => hoursSince(o.fully_paid_ts) || 0)))}</td></tr>` : `<tr><td colspan="5" class="empty">Очереди нет</td></tr>`);

  // ---- needs attention
  const unpaid = orders.filter((o) => o.waits_payment && o.paid_rub === 0);
  const partial = orders.filter((o) => o.waits_payment && o.paid_rub > 0);
  const att = [
    ["unpaid", "Ждут оплаты", unpaid, (l) => `${num(l.length)} · ${rub(l.reduce((a, o) => a + o.sum_rub, 0))}`, (l) => l.map((o) => hoursSince(o.created_ts))],
    ["partial", "Оплачены частично", partial, (l) => `${num(l.length)} · не хватает ${rub(l.reduce((a, o) => a + o.sum_rub - o.paid_rub, 0))}`, (l) => l.map((o) => hoursSince(o.created_ts))],
    ["late", "Оплачены, не отправлены дольше 2 дней", qLate, (l) => `${num(l.length)} · ${rub(l.reduce((a, o) => a + o.sum_rub, 0))}`, (l) => l.map((o) => hoursSince(o.fully_paid_ts))],
  ];
  // negative: below zero on the shelf, or below zero once reserves are taken out
  const neg = negativeColors();
  const negShelf = neg.filter((c) => c.stock < 0).length;
  const anomalies = (DATA.pulse_cost_anomalies || []).filter((r) => r.month === month);
  const waiting = awaitingRequests();
  const noAnswer = waiting.filter((x) => !x.handled);
  const attRow = (k, label, n, val, note) => `<div class="att-row${n ? " clickable" : ""}" ${n ? `data-detail="att:${k}" role="button" tabindex="0"` : ""}>
      <span class="att-dot ${n ? "warn" : "ok"}" aria-hidden="true"></span>
      <span class="att-label">${label}</span><span class="att-val">${n ? val : "нет"}</span>
      <span class="muted small">${n ? note : ""}</span></div>`;
  $("pulse-attention").closest(".card").classList.toggle("has-issues", att.some(([, , l]) => l.length) || neg.length > 0 || anomalies.length > 0);
  $("pulse-attention").innerHTML = att.map(([k, label, list, val, waits]) => {
    const w = waits(list);
    return `<div class="att-row${list.length ? " clickable" : ""}" ${list.length ? `data-detail="att:${k}" role="button" tabindex="0"` : ""}>
      <span class="att-dot ${list.length ? "warn" : "ok"}" aria-hidden="true"></span>
      <span class="att-label">${label}</span><span class="att-val">${list.length ? val(list) : "нет"}</span>
      <span class="muted small">${list.length ? `самый старый ${waitText(Math.max(...w))}` : ""}</span></div>`;
  }).join("") + `
    ${attRow("req", "Обращения без ответа", noAnswer.length, `${num(noAnswer.length)} · дольше часа ${num(noAnswer.filter((x) => hoursSince(x.last_in_ts) > 1).length)}`,
      `за 48 часов; еще ${num(waiting.length - noAnswer.length)} бесед, где менеджер отвечал, а клиент написал последним`)}
    ${attRow("neg", "Минусовые остатки", neg.length, `${num(neg.length)} цветов`, `«Основной склад»: ${num(negShelf)} в минусе по остатку, ${num(neg.length - negShelf)} — с учетом резерва`)}
    ${attRow("cost", "Ошибки себестоимости", anomalies.length, `${num(anomalies.length)} строк`, anomalies.length ? `себестоимость ${rub(anomalies.reduce((a, r) => a + r.cost_sum, 0))} исключена из маржи` : "")}`;

  renderRequests(P);
  renderMoves(P);
  renderTopProducts(today);
  renderColors();
  renderPlansForm();
}

// ---- logistics: who moved orders to which status (MoySklad audit log)
const MOVE_STATES = ["Подтвержден", "Связаться с клиентом", "Сборка заказа", "Готов к отправке", "Сборка Сдэк", "В пути к клиенту"];
function renderMoves(P) {
  const rows = DATA.pulse_moves_daily || [];
  if (!rows.length) { $("pulse-moves").querySelector("tbody").innerHTML = `<tr><td class="empty">Журнал еще не загружен</td></tr>`; return; }
  const today = ufaToday(), yesterday = addDays(today, -1);
  const [pf, pt] = P.cur;
  const first = rows.reduce((a, r) => (r.date < a ? r.date : a), today);
  const actors = [...new Set(rows.map((r) => r.actor))];
  const s = (actor, f, st = "*") => rows.reduce((a, r) => a + (r.actor === actor && r.new_state === st && f(r.date) ? r.orders : 0), 0);
  const list = actors.map((a) => ({
    actor: a, manual: rows.some((r) => r.actor === a && r.is_manual),
    t: s(a, (d) => d === today), y: s(a, (d) => d === yesterday), p: s(a, (d) => d >= pf && d <= pt),
    st: MOVE_STATES.map((st) => s(a, (d) => d >= pf && d <= pt, st)),
  })).filter((x) => x.t || x.y || x.p).sort((a, b) => (b.manual - a.manual) || b.p - a.p);
  $("pulse-moves").querySelector("thead").innerHTML = `<tr><th scope="col">Кто</th><th scope="col">Сегодня</th><th scope="col">Вчера</th>
    <th scope="col" title="Сумма по дням: заказ, переведенный в разные дни, считается в каждом">Период</th>
    ${MOVE_STATES.map((st) => `<th scope="col" class="${st === MOVE_STATES[0] ? "grp-start" : ""}" title="Перевели в статус за период">→ ${esc(st)}</th>`).join("")}</tr>`;
  $("pulse-moves").querySelector("tbody").innerHTML = list.map((x) => `
    <tr${x.manual ? "" : ' class="muted-row"'}><td>${esc(x.actor)}</td><td>${num(x.t)}</td><td>${num(x.y)}</td><td>${num(x.p)}</td>
      ${x.st.map((v, i) => `<td class="${i === 0 ? "grp-start" : ""}">${v ? num(v) : "—"}</td>`).join("")}</tr>`).join("")
    || `<tr><td colspan="${4 + MOVE_STATES.length}" class="empty">За эти дни смен статусов нет</td></tr>`;
  $("pulse-moves-sub").textContent = `Смены статусов из журнала МоегоСклада (история с ${dayTitle(first)}). Число — заказы, которые переведены в статус. Серым — интеграции и изменения через API.`;
  // handoff to the carrier
  const h = (DATA.pulse_handoff_daily || []).filter((r) => r.date >= pf && r.date <= pt);
  const n = h.reduce((a, r) => a + r.orders, 0), ok = h.reduce((a, r) => a + r.within_48h, 0);
  const med = h.length ? [...h].sort((a, b) => a.hours_median - b.hours_median)[Math.floor(h.length / 2)].hours_median : null;
  $("pulse-handoff").innerHTML = n ? `<span>Передано перевозчику за период: <b>${num(n)}</b></span>
    <span title="Медиана дневных медиан, от полной оплаты до «В пути к клиенту»">От оплаты до передачи: <b>~${num(med)} ч</b></span>
    <span>В течение 48 часов: <b>${(ok / n * 100).toLocaleString("ru-RU", { maximumFractionDigits: 0 })}%</b></span>` : "";
}

// ---- top-3 products: today, 7 days, month; by quantity and by sum
function renderTopProducts(today) {
  const rows = DATA.pulse_products_daily || [];
  const month = today.slice(0, 7) + "-01";
  const spans = [["Сегодня", today], ["7 дней", addDays(today, -6)], ["Месяц", month]];
  const top = (from, key) => {
    const by = new Map();
    for (const r of rows) {
      if (r.date < from || r.date > today || /доставк/i.test(r.product)) continue;
      const x = by.get(r.product_id) || { name: r.product, orders: 0, sum: 0 };
      x.orders += r.orders; x.sum += r.sum_rub; by.set(r.product_id, x);
    }
    return [...by.values()].sort((a, b) => b[key] - a[key]).slice(0, 3);
  };
  const short = (n) => esc(String(n).replace(/^Пряжа\s+(Sky\s?Wool|Luxury Selection By Ri\.Go)\s+арт\.\s*/i, ""));
  $("pulse-top").innerHTML = ["orders", "sum"].map((key) => spans.map(([label, from]) => {
    const t = top(from, key);
    return `<div class="top-list"><div class="label">${key === "orders" ? "По числу заказов" : "По сумме"} · ${label}</div>
      <ol>${t.map((x) => `<li title="${esc(x.name)}"><span>${short(x.name)}</span><b>${key === "orders" ? num(x.orders) + " зак." : rub(x.sum)}</b></li>`).join("") || '<li class="muted">нет заказов</li>'}</ol></div>`;
  }).join("")).join("");
}

// ---- colors: negative stock, running out, best sellers of 30 days
let colorsMode = "neg";
function renderColors() {
  const all = DATA.pulse_colors || [];
  let list;
  if (colorsMode === "neg") list = negativeColors();
  // running out: still available, but less than two weeks of sales left
  else if (colorsMode === "low") list = all.filter((c) => c.available > 0 && c.days_left != null && c.days_left <= 14 && c.qty_30d > 0).sort((a, b) => a.days_left - b.days_left);
  else list = [...all].sort((a, b) => b.sum_30d - a.sum_30d).slice(0, 30);
  document.querySelectorAll("[data-colors]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.colors === colorsMode)));
  const n = (v, d = 0) => (v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: d }));
  $("pulse-colors").querySelector("tbody").innerHTML = list.map((c) => `
    <tr><td>${esc(c.product)}</td><td>${esc(c.color)}</td><td>${n(c.qty_30d)}</td><td>${n(c.sum_30d)}</td>
      <td class="${c.stock < 0 ? "bad-text" : ""}">${n(c.stock)}</td><td>${n(c.reserve)}</td>
      <td class="${c.available < 0 ? "bad-text" : ""}">${n(c.available)}</td><td>${n(c.days_left, 1)}</td></tr>`).join("")
    || `<tr><td colspan="8" class="empty">Таких цветов нет</td></tr>`;
}

// drill-down list for a clicked tile / row
function pulseDetail(key) {
  const today = ufaToday();
  const orders = DATA.pulse_orders || [];
  let list = [], title = "", sub = "";
  if (key === "today-created") { list = orders.filter((o) => o.created_ts.slice(0, 10) === today); title = "Создано сегодня"; }
  else if (key === "today-paid") { list = orders.filter((o) => o.fully_paid_ts && o.fully_paid_ts.slice(0, 10) === today); title = "Оплачено полностью сегодня"; }
  else if (key.startsWith("queue:")) {
    const st = key.slice(6);
    list = orders.filter((o) => o.in_queue && (st === "all" || o.state === st));
    title = st === "all" ? "Очередь отгрузок" : `Очередь отгрузок · ${st}`;
    sub = "Сортировка: дольше всех ждут сверху";
  }
  else if (key === "att:unpaid") { list = orders.filter((o) => o.waits_payment && o.paid_rub === 0); title = "Ждут оплаты"; }
  else if (key === "att:partial") { list = orders.filter((o) => o.waits_payment && o.paid_rub > 0); title = "Оплачены частично"; }
  else if (key === "att:neg") { pulseNegDetail(); return; }
  else if (key === "att:req") { pulseReqDetail(); return; }
  else if (key === "att:cost") { pulseCostDetail(); return; }
  else if (key === "att:late") { list = orders.filter((o) => o.in_queue && hoursSince(o.fully_paid_ts) > 48); title = "Оплачены, не отправлены дольше 2 дней"; }
  const since = (o) => (o.in_queue ? hoursSince(o.fully_paid_ts) : hoursSince(o.created_ts));
  list = [...list].sort((a, b) => (since(b) || 0) - (since(a) || 0));
  $("pulse-detail-head").innerHTML = `<tr><th scope="col">Заказ</th><th scope="col">Создан</th><th scope="col">Ответственный</th><th scope="col">Статус</th><th scope="col">Сумма, ₽</th><th scope="col">Оплачено, ₽</th><th scope="col">Полная оплата</th><th scope="col">Ждет</th></tr>`;
  $("pulse-detail-title").textContent = title;
  $("pulse-detail-sub").textContent = `${num(list.length)} заказов на ${rub(list.reduce((a, o) => a + o.sum_rub, 0))}${sub ? " · " + sub : ""}. Номер заказа открывает его в МоемСкладе.`;
  $("pulse-detail").querySelector("tbody").innerHTML = list.map((o) => `
    <tr>
      <td><a href="${msLink(o.order_id)}" target="_blank" rel="noopener">${esc(o.order_number)}</a></td>
      <td data-sort="${o.created_ts}">${tsShort(o.created_ts)}</td>
      <td>${esc(empName(o.owner_key))}</td>
      <td>${esc(o.state || "—")}</td>
      <td>${num(o.sum_rub)}</td><td>${num(o.paid_rub)}</td>
      <td data-sort="${o.fully_paid_ts || ""}">${tsShort(o.fully_paid_ts)}</td>
      <td>${waitText(since(o))}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="empty">Заказов нет</td></tr>`;
  $("pulse-detail-card").hidden = false;
  $("pulse-detail-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- manager funnel from amoCRM requests (mart.pulse_sessions)
// waiting: the client wrote last within 7 days and nobody answered yet
function awaitingRequests() {
  return (DATA.pulse_sessions || []).filter((x) => x.awaiting && x.last_in_ts && hoursSince(x.last_in_ts) <= 48)
    .sort((a, b) => a.last_in_ts.localeCompare(b.last_in_ts));
}
function median(list) {
  if (!list.length) return null;
  const v = [...list].sort((a, b) => a - b), k = Math.floor(v.length / 2);
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
}
function renderRequests(P) {
  const all = DATA.pulse_sessions || [];
  if (!all.length) { $("pulse-req").querySelector("tbody").innerHTML = `<tr><td colspan="10" class="empty">Переписка еще не загружена</td></tr>`; return; }
  const [pf, pt] = P.cur;
  const rows = all.filter((x) => x.date >= pf && x.date <= pt);
  const pc = (a, b) => (b ? `${(a / b * 100).toLocaleString("ru-RU", { maximumFractionDigits: 0 })}%` : "—");
  const agg = (list) => {
    const h = list.filter((x) => x.handled);
    const withOrder = h.filter((x) => x.orders > 0), withPaid = h.filter((x) => x.orders_paid > 0);
    return { n: h.length, reply: median(h.map((x) => Number(x.reply_min))), withOrder: withOrder.length,
      withNew: h.filter((x) => x.new_orders > 0).length, withPaid: withPaid.length, paid: h.reduce((a, x) => a + Number(x.paid_sum), 0) };
  };
  const by = new Map();
  for (const x of rows.filter((r) => r.handled)) { if (!by.has(x.responder)) by.set(x.responder, []); by.get(x.responder).push(x); }
  const list = [...by.entries()].map(([name, l]) => ({ name, ...agg(l) })).sort((a, b) => b.n - a.n);
  const tot = agg(rows);
  const line = (x, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><td>${esc(x.name)}</td><td>${num(x.n)}</td>
    <td>${x.reply == null ? "—" : num(x.reply)}</td><td>${num(x.withOrder)}</td><td>${num(x.withNew)}</td>
    <td>${num(x.withPaid)}</td><td>${num(x.paid)}</td>
    <td class="grp-start">${pc(x.withOrder, x.n)}</td><td>${pc(x.withPaid, x.withOrder)}</td><td>${pc(x.withPaid, x.n)}</td></tr>`;
  const unanswered = rows.filter((x) => !x.handled).length;
  $("pulse-req").querySelector("tbody").innerHTML = list.map((x) => line(x)).join("") + line({ name: "Итого", ...tot }, "total-row");
  $("pulse-req-period").textContent = P.label;
  const inMsgs = rows.reduce((a, x) => a + x.in_msgs, 0), ans = rows.reduce((a, x) => a + x.answered_msgs, 0);
  const unlinked = rows.filter((x) => x.handled && x.entity_type !== "lead").length;
  $("pulse-req-strip").innerHTML = `<span>Обращений: <b>${num(rows.length)}</b>, без ответа человека: <b>${num(unanswered)}</b></span>
    <span>Сообщений клиентов: <b>${num(inMsgs)}</b>, с ответом: <b>${pc(ans, inMsgs)}</b></span>
    <span title="Обращения из карточек покупателей amo без сделки: связать с заказом нельзя">Без связи со сделкой: <b>${num(unlinked)}</b></span>`;
}
function pulseReqDetail() {
  const rows = awaitingRequests().sort((a, b) => (a.handled - b.handled) || a.last_in_ts.localeCompare(b.last_in_ts));
  $("pulse-detail-title").textContent = "Обращения без ответа";
  $("pulse-detail-sub").textContent = "Клиент написал последним, сотрудник после этого не ответил (автоответы не считаются). За 48 часов: сначала обращения без единого ответа, затем беседы, где менеджер уже отвечал.";
  $("pulse-detail-head").innerHTML = `<tr><th scope="col">Канал</th><th scope="col">Обращение с</th><th scope="col">Последнее сообщение</th><th scope="col">Ждет</th><th scope="col">Сообщений</th><th scope="col">Отвечали раньше</th><th scope="col">Сделка amo</th></tr>`;
  $("pulse-detail").querySelector("tbody").innerHTML = rows.map((x) => `<tr><td>${esc(x.channel)}</td><td>${tsShort(x.started_ts)}</td>
    <td>${tsShort(x.last_in_ts)}</td><td class="${hoursSince(x.last_in_ts) > 1 ? "bad-text" : ""}">${waitText(hoursSince(x.last_in_ts))}</td>
    <td>${num(x.in_msgs)}</td><td>${x.handled ? "да" : "<b>нет</b>"}</td><td>${x.entity_type === "lead" ? `№ ${esc(x.entity_id)}` : "карточка покупателя"}</td></tr>`).join("")
    || `<tr><td colspan="7" class="empty">Все обращения отвечены</td></tr>`;
  $("pulse-detail-card").hidden = false;
  $("pulse-detail-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function negativeColors() {
  return (DATA.pulse_colors || []).filter((c) => (c.stock != null && c.stock < 0) || (c.available != null && c.available < 0))
    .sort((a, b) => a.available - b.available);
}
function pulseNegDetail() {
  const rows = negativeColors();
  const n = (v) => (v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 0 }));
  $("pulse-detail-title").textContent = "Минусовые остатки";
  $("pulse-detail-sub").textContent = "«Основной склад». Доступно = остаток − резерв. Сначала самые большие минусы.";
  $("pulse-detail-head").innerHTML = `<tr><th scope="col">Товар</th><th scope="col">Цвет</th><th scope="col">Остаток</th><th scope="col">Резерв</th><th scope="col">Доступно</th><th scope="col">Продано за 30 дней</th></tr>`;
  $("pulse-detail").querySelector("tbody").innerHTML = rows.map((c) => `<tr><td>${esc(c.product)}</td><td>${esc(c.color)}</td>
    <td class="${c.stock < 0 ? "bad-text" : ""}">${n(c.stock)}</td><td>${n(c.reserve)}</td>
    <td class="${c.available < 0 ? "bad-text" : ""}">${n(c.available)}</td><td>${n(c.qty_30d)}</td></tr>`).join("");
  $("pulse-detail-card").hidden = false;
  $("pulse-detail-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function pulseCostDetail() {
  const month = ufaToday().slice(0, 7) + "-01";
  const rows = (DATA.pulse_cost_anomalies || []).filter((r) => r.month === month).sort((a, b) => b.cost_sum - a.cost_sum);
  $("pulse-detail-title").textContent = "Ошибки себестоимости";
  $("pulse-detail-sub").textContent = "Строки отчета «Прибыльность», где себестоимость больше выручки в 3 раза и больше. Часто это пересорт или продажа не в тех единицах (граммы вместо мотков). Из маржи исключены.";
  $("pulse-detail-head").innerHTML = `<tr><th scope="col">Товар</th><th scope="col">Продано, шт.</th><th scope="col">Выручка, ₽</th><th scope="col">Себестоимость, ₽</th><th scope="col">Цена за шт.</th><th scope="col">Себестоимость за шт.</th></tr>`;
  $("pulse-detail").querySelector("tbody").innerHTML = rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${num(r.quantity)}</td><td>${num(r.sell_sum)}</td>
    <td class="bad-text">${num(r.cost_sum)}</td><td>${r.unit_price == null ? "—" : rub(r.unit_price)}</td><td>${r.unit_cost == null ? "—" : rub(r.unit_cost)}</td></tr>`).join("");
  $("pulse-detail-card").hidden = false;
  $("pulse-detail-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

// plans: company plan + one per manager, saved to mart.pulse_plans
function renderPlansForm() {
  const sel = $("pulse-plans-month");
  const today = ufaToday();
  const { y, m } = parse(today);
  // previous month (to fix a forgotten plan), the current one and 5 ahead (half a year)
  const months = Array.from({ length: 7 }, (_, i) => { const n = shiftMonth(y, m, i - 1); return iso(n.y, n.m, 1); });
  if (!sel.options.length) {
    sel.innerHTML = months.map((mm) => `<option value="${mm}"${mm === iso(y, m, 1) ? " selected" : ""}>${monthTitle(mm)}</option>`).join("");
    sel.addEventListener("change", renderPlansForm);
  }
  const month = sel.value || months[0];
  const emps = (DATA.pulse_employees || []).filter((e) => e.active && e.owner_key !== "site");
  const val = (key) => planOf(month, key);
  const last = (DATA.pulse_plans || []).filter((r) => r.month === month).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  $("pulse-plans-sub").textContent = "План компании и планы менеджеров на месяц. Сохраняются для всех."
    + (last ? ` Последнее изменение: ${String(last.updated_at).slice(0, 10)}${last.updated_by ? ", " + last.updated_by : ""}.` : "");
  const field = (key, label) => `
    <label class="plan-field"><span>${esc(label)}</span>
      <input type="text" inputmode="numeric" name="${esc(key)}" value="${val(key) == null ? "" : nf.format(val(key))}" placeholder="не задан"></label>`;
  $("pulse-plans-form").innerHTML = field("total", "План компании, ₽") + emps.map((e) => field(e.owner_key, `${e.name}, ₽`)).join("") + `
    <div class="plan-actions"><button type="submit" class="btn">Сохранить</button><span class="muted small" id="pulse-plans-msg" role="status"></span></div>`;
}

async function onPlansSubmit(e) {
  e.preventDefault();
  const month = $("pulse-plans-month").value;
  const msg = $("pulse-plans-msg");
  const rows = [];
  for (const input of e.target.querySelectorAll("input[name]")) {
    const raw = input.value.replace(/[\s ₽]/g, "").replace(",", ".");
    if (raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) { msg.textContent = `Не число: «${input.value}»`; input.focus(); return; }
    rows.push({ month, owner_key: input.name, plan: Math.round(v) });
  }
  if (!rows.length) { msg.textContent = "Нечего сохранять"; return; }
  msg.textContent = "Сохраняю…";
  try {
    DATA.pulse_plans = await savePlans(rows);
    msg.textContent = "Сохранено";
    if (pulsePeriod) renderPulse(pulsePeriod);
    $("pulse-plans-msg").textContent = "Сохранено";
  } catch (err) {
    msg.textContent = err.message || "Не удалось сохранить";
  }
}

function initPulse() {
  const open = (e) => {
    const el = e.target.closest("[data-detail]");
    if (!el || (e.type === "keydown" && e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    pulseDetail(el.dataset.detail);
  };
  for (const id of ["pulse-today", "pulse-queue", "pulse-attention"]) {
    $(id).addEventListener("click", open);
    $(id).addEventListener("keydown", open);
  }
  $("pulse-detail-close").addEventListener("click", () => { $("pulse-detail-card").hidden = true; });
  $("pulse-plans-form").addEventListener("submit", onPlansSubmit);
  document.querySelectorAll("[data-colors]").forEach((b) => b.addEventListener("click", () => { colorsMode = b.dataset.colors; renderColors(); }));
}

// ------------------------------------------------------ sortable tables
// Click a column header to sort by it (again to flip the order). The choice is
// kept while the table is redrawn (period change). Cells may carry data-sort
// (dates); otherwise numbers are read from the text, "—" goes last.
// Total and "empty" rows stay at the bottom.
const SORTABLE = ["pulse-req", "pulse-moves", "pulse-colors", "pulse-mgr", "monthly-table", "site-ch-table", "reel-table", "channel-table", "pub-channels", "pub-table"];
const sortState = {}; // table id -> { col, dir }
function cellValue(td) {
  if (!td) return null;
  if (td.dataset.sort != null) return td.dataset.sort;
  const t = td.textContent.trim();
  if (!t || t === "—") return null;
  const m = t.replace(/[\s\u00a0]/g, "").match(/^[▲▼]?(-?\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : t.toLowerCase();
}
function sortTable(table) {
  const st = sortState[table.id];
  const tbody = table.tBodies[0];
  if (!st || !tbody) return;
  const rows = [...tbody.rows];
  const fixed = rows.filter((r) => r.classList.contains("total-row") || r.querySelector("td.empty"));
  const data = rows.filter((r) => !fixed.includes(r));
  data.sort((a, b) => {
    const x = cellValue(a.cells[st.col]), y = cellValue(b.cells[st.col]);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return st.dir * c;
  });
  table._sorting = true;
  tbody.append(...data, ...fixed);
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  [...(head?.cells || [])].forEach((th, i) => {
    th.classList.toggle("sorted", i === st.col);
    th.setAttribute("aria-sort", i === st.col ? (st.dir > 0 ? "ascending" : "descending") : "none");
  });
}
function initSortableTables() {
  for (const id of SORTABLE) {
    const table = $(id);
    if (!table) continue;
    table.classList.add("sortable");
    table.addEventListener("click", (e) => {
      const th = e.target.closest("th");
      const head = table.tHead?.rows[table.tHead.rows.length - 1];
      if (!th || !head || th.parentElement !== head) return;
      const col = [...head.cells].indexOf(th);
      const prev = sortState[id];
      // numbers start from the largest, text from A
      const firstVal = cellValue([...table.tBodies[0].rows].map((r) => r.cells[col]).find((td) => cellValue(td) != null));
      const dir = prev && prev.col === col ? -prev.dir : (typeof firstVal === "number" ? -1 : 1);
      sortState[id] = { col, dir };
      sortTable(table);
    });
    // re-apply the sort after the table is redrawn
    new MutationObserver(() => {
      if (table._sorting) { table._sorting = false; return; }
      sortTable(table);
    }).observe(table, { childList: true, subtree: true });
  }
}

// --------------------------------------------------------------- table
function renderTable(showAll) {
  const rows = [...DATA.sales_monthly].reverse();
  const list = showAll ? rows : rows.slice(0, 24);
  $("monthly-table").querySelector("tbody").innerHTML = list.map((r) => `
    <tr>
      <td data-sort="${r.month}">${monthTitle(r.month)}</td>
      <td>${num(r.revenue)}</td>
      <td>${num(r.orders)}</td>
      <td>${r.avg_check == null ? "—" : num(r.avg_check)}</td>
      <td>${num(r.services)}</td>
      <td class="grp-start">${num(r.shipped_revenue)}</td>
      <td>${num(r.shipped)}</td>
      <td>${num(r.returns)}</td>
      <td>${num(r.returns_sum)}</td>
      <td class="grp-start">${num(r.payments)}</td>
    </tr>`).join("");
}

// ------------------------------------------------------------- filters
function selectPreset(kind) {
  document.querySelectorAll(".periods button").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.period === kind)));
  document.querySelector(".range").classList.remove("active");
  const P = presetRanges(kind);
  $("date-from").value = P.cur[0];
  $("date-to").value = P.cur[1];
  renderPeriod(P);
}
function onCustomDates() {
  let from = $("date-from").value, to = $("date-to").value;
  if (!from || !to) return; // still typing
  if (from > to) [from, to] = [to, from];
  if (from < firstDate()) from = firstDate();
  if (to > lastDate()) to = lastDate();
  $("date-from").value = from; $("date-to").value = to;
  document.querySelectorAll(".periods button").forEach((x) => x.setAttribute("aria-checked", "false"));
  document.querySelector(".range").classList.add("active");
  renderPeriod(customRanges(from, to));
}

// ---------------------------------------------------------------- main
function renderFreshness() {
  const f = DATA.data_freshness.find((r) => r.source === "moysklad");
  if (!f) return;
  const t = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Yekaterinburg", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",  // Ufa, UTC+5: the team works there
  }).format(new Date(f.refreshed_at));
  const until = metrikaUntil();
  $("freshness").textContent = `Данные МоегоСклада · обновлено ${t} по Уфе` + (until ? ` · Метрика по ${dayTitle(until)}` : "");
}

// ---------------------------------------------------------------- login
// Only when reading Supabase: the page is locked until the user signs in.
function showLogin() {
  document.body.classList.add("locked");
  document.title = "Вход · Sky Wool";
  $("login").hidden = false;
  $("freshness").textContent = "";
  $("login-email").focus();
}
function initLogin() {
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value, password = $("login-password").value;
    if (!email || !password) return;
    $("login-submit").disabled = true;
    $("login-error").hidden = true;
    try {
      await signIn(email, password);
      location.reload(); // simplest: start the page again with a session
    } catch (err) {
      $("login-error").textContent = err.message;
      $("login-error").hidden = false;
      $("login-submit").disabled = false;
    }
  });
  $("logout").addEventListener("click", async () => {
    try { await signOut(); } finally { location.reload(); }
  });
}

async function main() {
  initTheme();
  initTabs();
  initDailySwitch();
  initLtvSwitch();
  initSortableTables();
  initPulse();
  initLogin();
  $("pub-toggle").addEventListener("click", () => { pubShowAll = !pubShowAll; if (pubPeriod) renderPublications(pubPeriod); });
  try {
    DATA = await loadSales();
    if (!DATA.sales_daily?.length) {
      // signed in, but RLS returned nothing: the email is not in the whitelist
      throw new Error(usesSupabase ? "NO_ACCESS" : "витрина пустая");
    }
  } catch (e) {
    if (e instanceof NeedLogin) { showLogin(); return; }
    // nothing to show: hide the empty dashboard, keep only the message
    if (usesSupabase) document.body.classList.add("locked");
    $("error").textContent = e.message === "NO_ACCESS"
      ? "Для этого аккаунта доступ к данным не открыт. Обратитесь к администратору аналитики."
      : `Не удалось загрузить данные: ${e.message}`;
    $("error").hidden = false;
    $("freshness").textContent = "";
    if (usesSupabase) $("logout").hidden = false;
    return;
  }
  if (usesSupabase) {
    $("logout").hidden = false;
    $("logout").title = (await currentEmail()) || "";
  }
  renderFreshness();

  for (const id of ["date-from", "date-to"]) {
    $(id).min = firstDate(); $(id).max = lastDate();
    $(id).addEventListener("change", onCustomDates);
  }
  document.querySelectorAll(".periods button").forEach((b) => b.addEventListener("click", () => selectPreset(b.dataset.period)));

  const curMonth = lastDate().slice(0, 7) + "-01";
  const months = DATA.sales_monthly.slice(-24);
  monthlyChart.update(months.map((r) => ({
    label: monthLabel(r.month),
    value: r.revenue,
    partial: r.month === curMonth,
    title: monthTitle(r.month) + (r.month === curMonth ? " (неполный)" : ""),
    rows: [["Выручка", rub(r.revenue)], ["Заказы", num(r.orders)], ["Средний чек", r.avg_check == null ? "—" : rub(r.avg_check)],
      ["Отгрузки − возвраты", rub(r.shipped_revenue)], ["Возвраты", rub(r.returns_sum)]],
  })));
  avgChart.update(months.filter((r) => r.avg_check != null).map((r) => ({
    label: monthLabel(r.month),
    value: r.avg_check,
    title: monthTitle(r.month),
    rows: [["Средний чек", rub(r.avg_check)], ["Заказы", num(r.orders)]],
  })));

  const curMonthLabel = (m) => (m === curMonth ? " (неполный)" : "");
  customersChart.update(DATA.customers_monthly.slice(-24).map((r) => ({
    label: monthLabel(r.month),
    a: r.returning_customers,
    b: r.new_customers,
    title: monthTitle(r.month) + curMonthLabel(r.month),
    rows: [
      ["Всего покупателей", num(r.active_customers)],
      ["Вернувшиеся", num(r.returning_customers)],
      ["Новые", num(r.new_customers)],
      ["Доля выручки повторных", r.repeat_revenue_share == null ? "—" : pct(r.repeat_revenue_share)],
    ],
  })));
  renderCohorts();
  renderSecondOrderGap();
  renderLtv();
  renderChannelMonths();

  selectPreset("mtd");

  let showAll = false;
  renderTable(showAll);
  $("toggle-all").addEventListener("click", () => {
    showAll = !showAll;
    renderTable(showAll);
    $("toggle-all").textContent = showAll ? "Последние 24 месяца" : "Показать все месяцы";
  });
}

main();
