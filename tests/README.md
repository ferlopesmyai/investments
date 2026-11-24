# Dashboard smoke test

Runs `index.html` in headless Chromium against a mock Apps Script with synthetic data
(no real portfolio data). Covers: locked screen, wrong key, unlock, reload, key rotation,
failed POST keeps the key, bad payload never cached, expandable rows, no truncation at 375–430 px,
YTD split adds up, live badge ageing, refresh on reopen, missing chart library, no uncaught errors.

```
cd tests && npm i playwright@1 chart.js@4.4.0
CHROME_PATH=/path/to/chrome node dashboard.test.mjs ../index.html
```
