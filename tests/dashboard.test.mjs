// Headless test of the key-gated dashboard against a mock Apps Script.
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const PAGE_PORT = 8811, API_PORT = 8812;
const html = fs.readFileSync(process.argv[2], "utf8")
  .replace(/const API_URL = "[^"]+";/, `const API_URL = "http://127.0.0.1:${API_PORT}/exec";`)
  .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4\.4\.0\/chart\.umd\.min\.js/, "/chart.js");
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

ok(pageErrors.length === 0, "no uncaught page errors" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
await browser.close(); api.close(); site.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
