// ============================================================
// PORTFOLIO DASHBOARD API — key-protected (replaces the old doGet)
// The key lives in Project Settings → Script Properties → DASHBOARD_KEY.
// It is never written in code, so nothing public can unlock the data.
// ============================================================

// Only these tabs are sent. DIVIDENDS, FUTURE and any new tab stay private
// unless added here.
const DASH_TABS = [
  "QQQ", "SCHD", "TAXM", "BIL", "LFTB11", "BTC", "ETH",
  "401K Fernando", "401k Bruna",
  "REAL TIME PRICE", "HISTORIC PRICES",
  "REAL_STATE", "REAL ESTATE", "REAL_ESTATE", "REAL STATE"
];

// Columns the dashboard never uses and that identify you (property ID,
// employer/account names) or just add weight (BRL columns of the crypto tabs).
const DASH_DROP_COLS = [
  "zpid", "account", "name", "investment", "source", "description",
  "date brazil", "usd/brl", "price brl", "total brl"
];

// The dashboard calls this with the key in the request body (never in the URL).
function doPost(e) {
  let key = "";
  try { key = String(JSON.parse(e.postData.contents).k || ""); } catch (err) {}
  return dashResponse_(key);
}

// Plain GET (the old way, and what anyone with the URL would try) gets nothing.
function doGet(e) {
  return dashJson_({ error: "unauthorized" });
}

function dashResponse_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty("DASHBOARD_KEY");
  if (!expected || !key || key !== expected) return dashJson_({ error: "unauthorized" });

  const wanted = DASH_TABS.map(n => n.trim().toLowerCase());
  const out = {};
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(sheet => {
    const name = sheet.getName();
    if (wanted.indexOf(name.trim().toLowerCase()) === -1) return;
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) { out[name] = []; return; }
    const headers = data[0];
    const keep = headers.map(h => DASH_DROP_COLS.indexOf(String(h).trim().toLowerCase()) === -1);
    out[name] = data.slice(1)
      .filter(row => row.some(v => v !== "" && v !== null))   // skip fully blank rows
      .map(row => {
        const o = {};
        headers.forEach((h, i) => { if (keep[i]) o[h] = row[i]; });
        return o;
      });
  });
  return dashJson_(out);
}

function dashJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
