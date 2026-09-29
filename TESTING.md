# Testing

What is tested, how to run it, what each layer actually proves, and what is
still unproven. [`VERIFICATION.md`](VERIFICATION.md) holds the transcripts from
the last full run; this file is the map.

**The official checker passes: 7 of 7** (`python3 run.py .dogfood.toml` against `docker compose up`; `acceptance-report.txt` is its output). It has checks for T1 and T2 only.

## The short version

```bash
npm test            # 131 tests, no network, no server needed
npm run build       # production build and type check

docker compose up -d
npm run test:http   # the authorization matrix and CSRF, over real HTTP
npm run test:browser # the whole lifecycle, accessibility, keyboard and layout, in Chrome
./tests/t4-live.sh   # the T4 features, live: API, OpenAPI, bundle export and import, embed, verify
```

`test:http` and `test:browser` drive a **running** instance. They need a Chrome
on the machine (set `CHROME` to point at a different binary) and they find the
database automatically: `FORGEBOARD_DB_PATH` if set, otherwise the running
`forgeboard` container, otherwise `./data/forgeboard.db`.

> **Point them at the right database.** Without `FORGEBOARD_DB_PATH` or
> `FORGEBOARD_CONTAINER`, the suites mint sessions and an API key in the
> container named `forgeboard` — even when the base URL is another server. When
> testing anything other than your own compose instance, set one of them:
>
> ```bash
> FORGEBOARD_DB_PATH=/tmp/forgeboard-follow-up.db node tests/browser/e2e.mjs http://localhost:3300
> FORGEBOARD_CONTAINER=forgeboard-audit2        node tests/browser/e2e.mjs http://localhost:3200
> ```
>
> Run `judging.mjs` last: it publishes results, which closes judging.

## Layers

| Layer | Where | What it can prove | What it cannot |
|---|---|---|---|
| Unit — scoring | `tests/scoring.test.ts` | The maths, against values worked out by hand independently of the implementation | Nothing about authorization or the interface |
| Backend behaviour | `tests/integration.test.ts` | Rules hold in the domain layer the pages and API both call: isolation, deadlines, concurrency, exports | Nothing about what the browser renders |
| Community | `tests/community.test.ts` | Voting windows, budgets, duplicates, ballot order, moderation | — |
| Stretch | `tests/stretch.test.ts` | Signing, tamper rejection, portability round trip, webhook SSRF | — |
| Governance | `tests/governance.test.ts` | Event windows, question options, judge invitations and removal, conflict history, eligibility decisions, assignment preview, audited admin override, password recovery | — |
| HTTP | `tests/browser/authz.mjs` | Status codes and bodies for each role over real HTTP with real cookies | Nothing about rendering |
| Browser | `tests/browser/{e2e,a11y,keyboard,responsive}.mjs` | That a person can actually complete the work, in Chrome | Screen-reader behaviour; load under concurrency |
| Container | `docker compose` + `--network none` | One-command startup, offline runtime, restart persistence | That a *cold* machine can fetch the base image offline |

Every suite seeds its own database in a temporary directory
(`FORGEBOARD_DB_PATH`), so tests never touch `data/forgeboard.db` and never
touch each other.

## Running the unit and integration suites

```bash
npm test                              # everything
node --test tests/scoring.test.ts     # one file
node --test --test-name-pattern "normaliz" tests/scoring.test.ts
```

They need no running server and no network. Each file shells out to
`scripts/seed.ts` first, so the fixture is the same demo event you see in the
interface — including its deliberate awkward cases: a constant judge, a judge
with too few reviews, a project with no assignments, drafts, and a withdrawal.

Internal test IDs (`MATH-01`, `ISOLATE-02`, `VOTE-07`, `SETUP-01`, …) are ours.
They are not official acceptance identifiers and are not claimed as such.

## Running the browser and HTTP checks

These drive the running application. They are **not** part of `npm test`,
because they need a server and a Chrome on the machine:

```bash
docker compose up -d                              # or npm run dev

node tests/browser/authz.mjs                      # role × route matrix, CSRF, API keys
node tests/browser/e2e.mjs                        # the whole lifecycle, in Chrome
node tests/browser/a11y.mjs                       # axe-core over 15 screens
node tests/browser/keyboard.mjs                   # focus, drawer, keyboard scoring
node tests/browser/responsive.mjs                 # 320 → 1440, and 200% zoom
node tests/browser/dashboard.mjs                  # what each role sees under Waiting on you
node tests/browser/judging.mjs                    # judge → publish → public view; run last

node tests/browser/e2e.mjs http://localhost:3001  # any base URL works
```

Each exits non-zero on failure and writes screenshots of anything that failed to
`tests/browser/.artifacts/`. The driver is about 150 lines of DevTools Protocol
over Node's built-in WebSocket (`tests/browser/cdp.mjs`) — no Playwright, no
Puppeteer, nothing to install beyond a Chrome. `VERIFICATION.md` records what
each one printed on the last full run.

### What the browser run covers

Register → a refused submission that keeps what was typed → create an event →
configure its window, a prize and a choice question → open it → invite a judge →
form a team → fail a submission on a missing field → fix and submit → confirm
the project in the public gallery → accept the judge invitation on a new account
and confirm it grants judging and nothing more → preview assignments, then
commit them → disqualify a project and watch it leave the gallery → reinstate it
→ issue a recovery link as an admin, redeem it, sign in with the new password →
four sign-in redirect attempts that must not leave the origin.

Failure states are exercised on purpose: an invalid password policy, a missing
required field, a backwards date window, a reused invitation, a second attempt
at a spent recovery link, and leaving a page with unsaved changes.

## Accessibility

`a11y.mjs` runs axe-core (WCAG 2.0/2.1/2.2 A and AA rule sets) over fifteen
screens in the role that reaches each one. The last run reported **0 serious or
critical violations**.

`keyboard.mjs` covers what axe cannot: focus is visibly marked as it moves, the
tab order reaches the primary action, the mobile drawer traps focus and returns
it to the button that opened it on Escape, and a judge can score with the
keyboard alone — the score inputs are visually hidden, so the label carries the
focus ring.

This is not a conformance claim. No screen reader was used.

## Layout

`responsive.mjs` loads ten screens at 320, 390, 720 (a 1440 viewport at 200%
zoom), 1024 and 1440 CSS pixels, and fails on any horizontal page overflow or
any visible text wider than the box holding it. Deliberate clipping — a
scroller, an ellipsis, screen-reader-only text — is excluded.

## Performance

Single-user medians on one laptop, container running, 40 projects and 108
assignments:

| Route | Median | p95 |
|---|---|---|
| `/api/health` | 3 ms | 6 ms |
| `/` (landing, real counts) | 6 ms | 9 ms |
| `/events/:slug/gallery` | 8 ms | 10 ms |
| `/api/v1/events/:slug/projects?limit=20` | 2 ms | 3 ms |
| `/events/:slug/results` | 4 ms | 5 ms |

Cold `docker compose up` to a passing healthcheck: **1.2–1.6 s** across four
runs from an empty volume. These are not load tests; nothing here has been
measured under concurrency.

## Known unverified

- **Screen readers.** Not tested.
- **Concurrency at scale.** The concurrency tests cover the specific races that
  matter (last team seat, duplicate vote, stale submission edit, repeated
  assignment runs); they are not a load test.
- **Cold-machine offline install.** The *runtime* is proven offline. Building
  the image still needs the network to fetch `node:24-alpine` and the npm
  packages, as any build does.
- **Long-running webhook delivery.** Retries are in-process and are lost on
  restart; that behaviour is documented, not tested over hours.
