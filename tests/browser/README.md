# Browser and HTTP checks

These drive a **running** Forgeboard. They are deliberately outside `npm test`,
which must stay fast, offline and serverless.

```bash
docker compose up -d
npm run test:http      # authz.mjs
npm run test:browser   # e2e, a11y, keyboard, responsive
```

| File | What it proves |
|---|---|
| `cdp.mjs` | The driver: headless Chrome over the DevTools Protocol, using Node's built-in WebSocket. No Playwright or Puppeteer. |
| `sessions.mjs` | Mints real sessions for the demo accounts, writing exactly the row `issueSession()` writes. Finds the database in `FORGEBOARD_DB_PATH`, the running container, or `./data`. |
| `authz.mjs` | Every protected route requested as each role; CSRF on cookie-authenticated writes; API keys. |
| `e2e.mjs` | The lifecycle, including the failure states: refused submissions, a backwards date window, a reused invitation, a spent recovery link, leaving a page with unsaved changes. |
| `a11y.mjs` | axe-core over fifteen screens in the role that reaches each. |
| `keyboard.mjs` | Focus visibility, tab order, the drawer's focus trap, keyboard scoring. |
| `responsive.mjs` | 320 / 390 / 720 (1440 at 200% zoom) / 1024 / 1440: no horizontal overflow, no clipped text. |

Requirements: a Chrome on the machine (`CHROME=/path/to/chrome` to override) and
`axe-core`, which is a devDependency.

Screenshots and other output land in `.artifacts/`, which is ignored by git.
