# Dashboard smoke test

Runs `index.html` in headless Chromium against a mock Apps Script with synthetic data
(no real portfolio data). Covers: locked screen, wrong key, unlock, reload, key rotation,
failed POST keeps the key, bad payload never cached, no uncaught errors.

```
cd tests && npm i playwright@1 chart.js@4.4.0
CHROME_PATH=/path/to/chrome node dashboard.test.mjs ../index.html
```
