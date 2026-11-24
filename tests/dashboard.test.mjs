// Headless test of the key-gated dashboard against a mock Apps Script.
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const PAGE_PORT = 8811, API_PORT = 8812;
const html = fs.readFileSync(process.argv[2], "utf8")
  .replace(/const API_URL = "[^"]+";/, `const API_URL = "http://127.0.0.1:${API_PORT}/exec";`)
  // Serve Chart.js locally (the CDN is unreachable in CI); drop the CDN tag's integrity pin, which only matches the CDN file.
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"]+"[^>]*><\/script>/, '<script src="/chart.js"></script>');
if (!html.includes('<script src="/chart.js">')) { console.log("FAIL could not swap the Chart.js tag"); process.exit(1); }
const chartJs = fs.readFileSync("node_modules/chart.js/dist/chart.umd.js");

// ---- Synthetic payload mirroring the real sheet schema (after the new script's filtering) ----
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 5)).toISOString();
const hist = [];
for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const filled = (y < 2026) || m <= 10;
  hist.push({ DATE: iso(y, m, last), BRL: 0.18, TAXM: filled ? 50 : "", BIL: filled ? 91.5 : "", QQQ: filled ? 400 + (y - 2024) * 80 + m * 5 : "", SCHD: filled ? 26 + m * 0.3 : "",
    BTC: filled ? 60000 : "", ETH: filled ? 2500 : "", VFIFX: filled ? 60 : "", TRRNX: filled ? 50 : "", "SP500TR ": filled ? 6000 + m * 40 : "", LFTB11: filled ? 20 : "" });
}
const ledger = (t, rows) => rows.map(([d, type, q, p]) => ({ Date: d, Type: type, Ticker: t, QTD: q, Currency: "USD", Price: p, Total: q * p }));
const PAYLOAD = {
  QQQ: ledger("QQQ", [["08/02/2021", "BUY", 300, 350], ["01/03/2026", "BUY", 10, 600]]),
  SCHD: ledger("SCHD", [["30/04/2020", "BUY", 10000, 20], ["29/06/2026", "BUY", 100, 30]]),
  TAXM: ledger("TAXM", [["26/02/2026", "BUY", 1000, 51], ["20/11/2026", "SELL", 100, 48]]),
  BIL: ledger("BIL", [["11/03/2024", "BUY", 500, 91.5], ["26/02/2026", "SELL", 500, 91.6]]),
  LFTB11: ledger("LFTB11", [["28/03/2025", "BUY", 15000, 18]]),
  BTC: [{ "Date USA": iso(2024, 1, 10), QTD: 0.5, "Price USD": 45000, "TOTAL USD": 22500 }],
  ETH: [{ "Date USA": iso(2024, 1, 10), QTD: 10, "Price USD": 2500, "TOTAL USD": 25000 }],
  "401K Fernando": [{ Date: iso(2025, 1, 13), Symbol: "VFIFX", Type: "Plan Contribution", Quantity: 1000, Price: 50, "Commissions and Fees": "—", Amount: 50000 }],
  "401k Bruna": [{ Date: iso(2025, 1, 13), "Activity Type": "Contribution", Amount: 100000, Shares: 3000, Price: 33, Symbol: "TRRNX" }],
  "REAL TIME PRICE": [["BRL", 0.17], ["TAXM", 48.5], ["QQQ", 640], ["SCHD", 35], ["BTC", 60000], ["ETH", 1700], ["VFIFX", 62], ["BIL", 91.6], ["TRRNX", 52.5], ["SP500TR ", 7200], ["LFTB11", 21.8]]
    .map(([t, p]) => ({ TICKER: t, TYPE: "x", PRICE: p })),
  "HISTORIC PRICES": hist,
  REAL_STATE: [{ "Purchase Date": iso(2026, 6, 12), "Purchase Price": 540000, "Closing Cost": 19106, "Down Payment": 137500, "Remodeling Cost": 55000, "Original Loan": 412500, "Interest Rate": 5.625, "Current Market Price": 600000, "Loan Term": "30 Years" }]
};

// ---- Mock API. mode "new": doPost checks key; doGet always unauthorized.
//      mode "old": no doPost (POST answers without CORS headers → browser TypeError); GET open.
//      mode "flaky-new": POST fails at network level, GET unauthorized (new script + bad network).
let MODE = "new", GOOD_KEY = "GOOD-KEY-1", hits = [];
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    hits.push(req.method);
    const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const json = o => { res.writeHead(200, cors); res.end(JSON.stringify(o)); };
    if (req.method === "POST") {
      if (MODE === "old" || MODE === "flaky-new") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>Script function not found: doPost</html>"); return; }
      let k = ""; try { k = JSON.parse(body).k; } catch {}
      return json(k === GOOD_KEY ? PAYLOAD : { error: "unauthorized" });
    }
    if (MODE === "old") return json(PAYLOAD);
    return json({ error: "unauthorized" });
  });
});
const site = http.createServer((req, res) => {
  if (req.url.startsWith("/chart.js")) { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(chartJs); }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(html);
});
await new Promise(r => api.listen(API_PORT, r));
await new Promise(r => site.listen(PAGE_PORT, r));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e)));

let fails = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const visible = async id => page.evaluate(i => !document.getElementById(i).classList.contains("hidden"), id);
const ls = async k => page.evaluate(k => localStorage.getItem(k), k);
const waitFor = async (id, ms = 8000) => { await page.waitForFunction(i => !document.getElementById(i).classList.contains("hidden"), id, { timeout: ms }); };
const text = async () => page.evaluate(() => document.body.innerText);
const unlock = async key => { await page.fill("#keyInput", key); await page.click(".key-form button"); };
const URL = `http://127.0.0.1:${PAGE_PORT}/`;

// Pretend this phone already had the old open-API payload cached.
await page.goto(URL); await page.evaluate(p => { localStorage.setItem("portfolio_raw_v2", JSON.stringify(p)); localStorage.setItem("portfolio_raw_ts_v2", Date.now()); }, PAYLOAD);

// 1. New script, no key → locked, old cached data wiped, nothing fetched.
MODE = "new"; hits = [];
await page.reload(); await waitFor("keyState");
ok(!(await visible("content")), "1. no key: dashboard hidden, key card shown");
ok((await ls("portfolio_raw_v2")) === null, "1. no key: previously cached portfolio wiped");
ok(hits.length === 0, "1. no key: no API call made");
await page.screenshot({ path: "/tmp/pwtest/locked.png" });

// 2. Wrong key → stays locked, message, key not kept.
await unlock("nope"); await page.waitForFunction(() => document.getElementById("keyMsg").classList.contains("bad"), null, { timeout: 8000 });
ok(await visible("keyState") && !(await visible("content")), "2. wrong key: still locked");
ok((await ls("portfolio_key_v1")) === null && (await ls("portfolio_raw_v2")) === null, "2. wrong key: neither key nor data stored");

// 3. Right key → renders, stored, no NaN.
await unlock(GOOD_KEY); await waitFor("content");
const t3 = await text();
ok(/\$\d{1,3}(,\d{3})+/.test(t3) && !/NaN|undefined|Infinity/.test(t3), "3. right key: dashboard renders, no NaN/undefined");
ok((await ls("portfolio_key_v1")) === GOOD_KEY && (await ls("portfolio_raw_v2")) !== null, "3. right key: key + payload cached on device");
ok((await page.textContent("#live-time")) === "Just now", "3. live badge says Just now");
const total3 = await page.textContent("#totalValue");
await page.screenshot({ path: "/tmp/pwtest/unlocked.png" });

// 4. Reload → cached render + fresh fetch, same total.
await page.reload(); await waitFor("content");
await page.waitForFunction(() => document.getElementById("live-time").textContent === "Just now", null, { timeout: 8000 });
ok((await page.textContent("#totalValue")) === total3, "4. reload: same total " + total3);

// 5. Key changed on the server → device locks itself and wipes data.
GOOD_KEY = "ROTATED-2";
await page.reload(); await waitFor("keyState");
ok(!(await visible("content")) && (await ls("portfolio_raw_v2")) === null && (await ls("portfolio_key_v1")) === null, "5. key rotated: device locked, key + data wiped");
ok(await page.evaluate(() => document.getElementById("keyMsg").textContent.includes("didn't work")), "5. key rotated: says the key didn't work");

// 6. The page never falls back to an open GET any more: POST failing → error, no GET sent, key kept.
MODE = "old"; hits = [];
await unlock("anything"); await waitFor("errorState");
ok(!hits.includes("GET") && (await ls("portfolio_key_v1")) === "anything", "6. no open-GET fallback; key kept after a failed POST");
MODE = "new"; GOOD_KEY = "anything";
await page.click("#errorState .btn-primary"); await waitFor("content");
ok((await page.textContent("#totalValue")) === total3, "6. Retry with a working API renders the same total");

// 7. New script + POST failing at network level → error, but key is NOT wiped.
MODE = "flaky-new";
await page.click("#refreshBtn"); await page.waitForFunction(() => document.getElementById("live-time").textContent === "Failed", null, { timeout: 8000 });
ok((await ls("portfolio_key_v1")) === "anything" && await visible("content"), "7. flaky network: key kept, cached dashboard still shown");

// 8. Garbage payload is never cached or rendered.
const before = await ls("portfolio_raw_v2");
MODE = "new"; GOOD_KEY = "anything";
const origPayload = { ...PAYLOAD };
for (const k of Object.keys(PAYLOAD)) delete PAYLOAD[k];   // server now returns {}
await page.click("#refreshBtn"); await page.waitForFunction(() => document.getElementById("live-time").textContent === "Failed", null, { timeout: 8000 });
ok((await ls("portfolio_raw_v2")) === before, "8. empty/unexpected payload: cache untouched");
Object.assign(PAYLOAD, origPayload);

// 9. No "Open API URL" link anywhere, and the key never appears in the page HTML.
ok(!(await page.content()).includes("Open API URL") && !(await page.content()).includes("anything\""), "9. no API link; key not rendered into the page");

// ---------------- Layout & interaction (state: unlocked with key "anything", MODE "new") ----------------
await page.reload(); await waitFor("content");
await page.waitForFunction(() => document.getElementById("live-time").textContent === "Just now", null, { timeout: 8000 });

// 10. Per-asset card section is gone; Quick Overview rows are tappable, all closed.
ok(await page.evaluate(() => !document.getElementById("groups") && document.querySelectorAll(".quick-row.tap").length === 7
  && [...document.querySelectorAll(".qdetail")].every(p => p.classList.contains("hidden"))), "10. asset cards removed; 7 tappable rows, all closed");

// 10b. All-time gain is gone (hero + Quick Overview column); panels keep cost basis and unrealized.
const at = await page.evaluate(() => ({
  heroAllTime: /all-time/i.test(document.querySelector(".card.hero").innerText),
  head: [...document.querySelectorAll(".quick-grid-head > div")].map(d => d.textContent.trim()),
  cells: [...document.querySelectorAll(".quick-row")].map(r => r.children.length) }));
ok(!at.heroAllTime && at.head.join("|") === "Asset|Value|YTD" && at.cells.every(n => n === 3),
  `10b. no all-time figures; Quick Overview is ${at.head.join(" · ")} (${at.cells.length} rows × 3)`);

// 11. Tap opens one panel at a time; tap again closes.
const openState = () => page.evaluate(() => ({
  rows: [...document.querySelectorAll(".quick-row.tap")].filter(r => r.getAttribute("aria-expanded") === "true").map(r => r.dataset.k),
  panels: [...document.querySelectorAll(".qdetail")].filter(p => !p.classList.contains("hidden")).map(p => p.dataset.k) }));
await page.click('.quick-row.tap[data-k="QQQ"]');
let st = await openState();
ok(st.rows.join() === "QQQ" && st.panels.join() === "QQQ", "11. tap Growth opens only its panel");
await page.click('.quick-row.tap[data-k="Cash"]');
st = await openState();
ok(st.rows.join() === "Cash" && st.panels.join() === "Cash", "11. tap Cash closes Growth, opens Cash");
const cashTxt = await page.textContent('.qdetail[data-k="Cash"]');
ok(/BRL exposure/.test(cashTxt) && /TAXM/.test(cashTxt) && /LFTB11/.test(cashTxt), "11. Cash panel shows BRL exposure and TAXM/LFTB11 split");
ok(/Cost basis/i.test(cashTxt) && /Unrealized/i.test(cashTxt), "11. panels still show cost basis and unrealized");
ok(/\$\d+K in BRL/.test(await page.textContent('.quick-row.tap[data-k="Cash"]')), "11. Cash row itself shows the BRL-fund amount");
await page.keyboard.press("Tab"); // keyboard: Enter on a focused row toggles too
await page.focus('.quick-row.tap[data-k="Real Estate"]'); await page.keyboard.press("Enter");
st = await openState();
ok(st.panels.join() === "Real Estate" && /LTV/.test(await page.textContent('.qdetail[data-k="Real Estate"]')), "11. Enter on Real Estate opens its panel (mortgage/LTV inside)");
await page.click('.quick-row.tap[data-k="Real Estate"]');
st = await openState();
ok(st.panels.length === 0, "11. tapping the open row closes it");

// 12. Open row and chosen timeframe both survive a data refresh.
await page.click('.quick-row.tap[data-k="401(k)"]');
await page.click('.tf-btn[data-tf="1Y"]');
ok(await page.evaluate(() => document.getElementById("cl-split").classList.contains("hidden")), "12. YTD split hidden on 1Y");
const hitsBefore = hits.length;
await page.click("#refreshBtn"); await page.waitForFunction(() => document.getElementById("live-time").textContent === "Just now", null, { timeout: 8000 });
st = await openState();
const tfAfter = await page.evaluate(() => ({ active: document.querySelector(".tf-btn.active").dataset.tf, n: Chart.getChart(document.getElementById("perfChart")).data.labels.length }));
ok(hits.length > hitsBefore && st.panels.join() === "401(k)" && tfAfter.active === "1Y" && tfAfter.n === 13, `12. after refresh: 401(k) still open, 1Y still drawn (${tfAfter.n} points)`);

// 13. "Change this year" in the hero = new money + growth; matches an independent calculation and the chart line.
await page.click('.tf-btn[data-tf="YTD"]');
const split = await page.evaluate(() => {
  const num = s => (s.trim().startsWith("−") ? -1 : 1) * parseFloat(s.replace(/[^\d.]/g, ""));
  const b = document.querySelectorAll("#cl-split b");
  const D = compute(JSON.parse(localStorage.getItem("portfolio_raw_v2")));
  return { heroVisible: !document.getElementById("ytdSplit").classList.contains("hidden"),
    total: num(document.getElementById("ysTotal").textContent), nm: num(document.getElementById("ysNew").textContent),
    gr: num(document.getElementById("ysGrowth").textContent),
    chartNm: num(b[0].textContent), chartGr: num(b[1].textContent),
    chartChange: num(document.getElementById("cl-port-change").childNodes[0].textContent),
    noYtdDollar: !document.querySelector("#ytdChange .sub"),
    principal: D.real_estate.principal_paid, totalValue: D.total_value, e25: D.end_2025_value };
});
// Fixture's 2026 flows: QQQ +6,000; SCHD +3,000; TAXM +51,000 −4,800; BIL −45,800; house cash 211,606 + principal.
const expectedNm = 6000 + 3000 + 51000 - 4800 - 45800 + 211606 + split.principal;
ok(split.heroVisible && Math.abs(split.nm + split.gr - split.total) <= 1 && Math.abs(split.total - (split.totalValue - split.e25)) <= 1,
  `13. hero: new money ${split.nm} + growth ${split.gr} = change ${split.total}`);
ok(Math.abs(split.nm - expectedNm) <= 1, `13. new money matches independent calc (${Math.round(expectedNm)})`);
ok(Math.abs(split.chartNm - split.nm) <= 1 && Math.abs(split.chartGr - split.gr) <= 1 && Math.abs(split.chartChange - split.total) <= 1,
  "13. chart line shows the same new money / growth as the hero");
ok(split.noYtdDollar, "13. YTD Return shows % only (no second growth figure)");
// 13b. Top-card YTD Return = growth ÷ average money invested (Modified Dietz), checked independently.
const mwr = await page.evaluate(() => {
  const num = s => (s.trim().startsWith("−") ? -1 : 1) * parseFloat(s.replace(/[^\d.]/g, ""));
  const D = compute(JSON.parse(localStorage.getItem("portfolio_raw_v2")));
  const y0 = new Date(2026, 0, 1), now = new Date(), span = now - y0;
  const w = d => Math.min(1, Math.max(0, (now - d) / span));
  // Fixture flows (dates as the sheet has them): QQQ 1 Mar +6,000 · SCHD 29 Jun +3,000 · TAXM 26 Feb +51,000
  // · TAXM 20 Nov −4,800 · BIL 26 Feb −45,800 · house 12 Jun +211,606 · principal on the 1st from Aug.
  const flows = [[new Date(2026,2,1), 6000], [new Date(2026,5,29), 3000], [new Date(2026,1,26), 51000],
    [new Date(2026,10,20), -4800], [new Date(2026,1,26), -45800], [new Date(2026,5,12,12), 211606]];
  const L = 412500, r = 5.625 / 1200, n = 360, P = L * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  const bal = k => L * Math.pow(1 + r, k) - P * ((Math.pow(1 + r, k) - 1) / r);
  for (let k = 1; ; k++) { const d = new Date(2026, 6 + k, 1); if (d > now) break; flows.push([d, bal(k - 1) - bal(k)]); }
  const avg = D.end_2025_value + flows.filter(([d]) => d <= now).reduce((a, [d, x]) => a + x * w(d), 0);
  return { shown: num(document.getElementById("ytdChange").textContent), expectedPct: D.ytd_flows.growth / avg * 100,
    avgPage: D.ytd_flows.avg_capital, avgIndep: avg,
    panelHasAvg: /Average invested/.test(document.getElementById("ysParts").textContent) };
});
ok(Math.abs(mwr.avgPage - mwr.avgIndep) <= 1 && Math.abs(mwr.shown - mwr.expectedPct) <= 0.01,
  `13b. YTD Return ${mwr.shown}% = growth ÷ avg invested ($${Math.round(mwr.avgIndep)}, independent calc)`);
ok(mwr.panelHasAvg, "13b. sources panel shows the average money invested");
// 13c. Growth by asset: independent per-asset check, adds up to total growth, shown sorted, Quick Overview $ agree.
const ga = await page.evaluate(() => {
  const num = s => (s.trim().startsWith("−") ? -1 : 1) * parseFloat(s.replace(/[^\d.]/g, ""));
  const D = compute(JSON.parse(localStorage.getItem("portfolio_raw_v2")));
  const G = D.ytd_flows.growth_by_group, A = D.allocation, E = D.end_2025_by_group;
  const rows = [...document.querySelectorAll("#ysParts .ys-g")].map(s => ({ name: s.textContent.trim(), v: num(s.nextElementSibling.textContent) }));
  const qoRE = document.querySelector('.quick-row.tap[data-k="Real Estate"] .quick-pct .qp-sub');
  const qoK = el => num(el.textContent) * 1000;
  return {
    sum: Object.values(G).reduce((a, b) => a + b, 0), growth: D.ytd_flows.growth,
    nonZero: Object.values(G).filter(v => Math.abs(v) >= 0.5).length,
    qqqOk: Math.abs(G.QQQ - (A.QQQ - E.QQQ - 6000)) < 0.02,
    cashOk: Math.abs(G.Cash - (A.Cash - E.Cash - (51000 - 4800 - 45800))) < 0.02,
    reOk: Math.abs(G["Real Estate"] - (D.real_estate.equity - 211606 - D.real_estate.principal_paid)) < 0.05,
    rows, sorted: rows.every((r, i) => i === 0 || rows[i - 1].v >= r.v), rowSum: rows.reduce((a, r) => a + r.v, 0),
    qoREsub: qoRE ? qoRE.textContent : null,
    qoMatch: [...document.querySelectorAll(".quick-row.tap")].every(r => {
      const sub = r.querySelector(".quick-pct .qp-sub"); const g = G[r.dataset.k];
      return sub && Math.abs(qoK(sub) - g) <= 500 + 1e-6;   // shown in $K, so within $500
    }),
    note: document.querySelector(".card.quick .card-action").textContent };
});
ok(Math.abs(ga.sum - ga.growth) <= 1 && ga.qqqOk && ga.cashOk && ga.reOk, "13c. growth by asset matches independent calc and adds up to total growth");
ok(ga.rows.length === ga.nonZero && ga.sorted && Math.abs(ga.rowSum - ga.growth) <= 7, `13c. top card lists every asset with growth, largest first (${ga.rows.map(r => r.name).join(", ")})`);
ok(ga.qoMatch && ga.qoREsub && ga.note === "YTD: % return · $ growth", `13c. Quick Overview $ = the same growth numbers (Real Estate ${ga.qoREsub})`);
await page.click("#ytdSplit");
const parts = await page.evaluate(() => {
  const num = s => (s.trim().startsWith("−") ? -1 : 1) * parseFloat(s.replace(/[^\d.]/g, ""));
  const el = document.getElementById("ysParts");
  const src = ["401(k) contributions", "Brokerage buys − sales", "Crypto buys", "House: cash in + principal"];
  const spans = [...el.querySelectorAll("span")], bs = [...el.querySelectorAll("b")];
  return { visible: !el.classList.contains("hidden"),
    sum: spans.reduce((a, s, i) => src.includes(s.textContent) ? a + num(bs[i].textContent) : a, 0),
    labels: spans.map(s => s.textContent).filter(l => src.includes(l)) };
});
ok(parts.visible && Math.abs(parts.sum - split.nm) <= 2 && parts.labels.includes("Brokerage buys − sales"),
  `13. tapping shows the sources (${parts.labels.join(", ")}), summing to new money`);
await page.click("#ytdSplit");
ok(await page.evaluate(() => document.getElementById("ysParts").classList.contains("hidden")), "13. tapping again hides the sources");

// 14. No truncated names or numbers in Quick Overview at common iPhone widths.
for (const w of [375, 393, 402, 430]) {
  await page.setViewportSize({ width: w, height: 852 }); await page.waitForTimeout(150);
  const bad = await page.evaluate(() => [...document.querySelectorAll(".qn-t, .qn-sub, .quick-name > span:not(.swatch-q):not(.qn):not(.chev), .quick-val, .quick-pct")]
    .filter(el => el.scrollWidth > el.clientWidth + 0.5).map(el => el.textContent.trim().slice(0, 14)));
  ok(bad.length === 0, `14. ${w}px: nothing truncated` + (bad.length ? " — " + bad.join(", ") : ""));
  if (w === 375) await page.screenshot({ path: "/tmp/pwtest/quick-375.png", fullPage: true });
}
await page.setViewportSize({ width: 393, height: 852 });

// 15. Allocation legend uses the same names as Quick Overview; home-screen icon declared.
const legend = await page.textContent("#legend");
ok(/Growth/.test(legend) && /Dividends/.test(legend) && !/\bQQQ\b|\bSCHD\b/.test(legend), "15. allocation legend uses Growth/Dividends names");
ok(await page.evaluate(() => !!document.querySelector('link[rel="apple-touch-icon"]')), "15. apple-touch-icon declared");

// 16. Live badge shows the real age and turns amber after an hour.
await page.evaluate(() => { localStorage.setItem("portfolio_raw_ts_v2", Date.now() - 5 * 60000); tickLiveLabel(); });
ok((await page.textContent("#live-time")) === "5m ago", "16. badge shows 5m ago");
await page.evaluate(() => { localStorage.setItem("portfolio_raw_ts_v2", Date.now() - 125 * 60000); tickLiveLabel(); });
ok((await page.textContent("#live-time")) === "2h ago" && await page.evaluate(() => document.getElementById("liveDot").classList.contains("stale")), "16. badge shows 2h ago in amber");

// 17. Reopening the app refreshes stale data, but not fresh data.
let h0 = hits.length;
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForFunction(() => document.getElementById("live-time").textContent === "Just now", null, { timeout: 8000 });
ok(hits.length === h0 + 1, "17. resume with 2h-old data → one refresh");
h0 = hits.length;
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForTimeout(500);
ok(hits.length === h0, "17. resume with fresh data → no extra request");

// 18. If Chart.js fails to load, the numbers still render.
const p2 = await ctx.newPage();
const p2Errors = []; p2.on("pageerror", e => p2Errors.push(String(e)));
await p2.route("**/chart.js", r => r.abort());
await p2.goto(URL); await p2.waitForFunction(() => !document.getElementById("content").classList.contains("hidden"), null, { timeout: 8000 });
await p2.waitForFunction(() => document.getElementById("live-time").textContent === "Just now", null, { timeout: 8000 });
const t18 = await p2.evaluate(() => document.body.innerText);
ok(/Chart unavailable/.test(t18) && /\$\d/.test(await p2.textContent("#totalValue")) && p2Errors.length === 0, "18. no chart library → numbers still shown, no errors");
await p2.close();

ok(pageErrors.length === 0, "no uncaught page errors" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
await browser.close(); api.close(); site.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
