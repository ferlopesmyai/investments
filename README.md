# Portfolio Dashboard

Mobile-first dashboard for the household investment portfolio, served by GitHub Pages at
https://ferlopesmyai.github.io/investments/

- `index.html` — the whole dashboard (all calculations run in the browser).
- `apps-script/dashboard-api.gs` — the `doGet`/`doPost` block pasted into the INVESTIMENTS sheet's Apps Script.

The data API is private: it only answers a POST carrying the access key stored in the script's
**Script Properties → `DASHBOARD_KEY`**. Each device asks for the key once and keeps it locally.
Changing the property locks every device until the new key is entered. No key or data lives in this repo.
