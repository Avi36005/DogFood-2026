# Verification log

Everything below was executed against the image built from
this revision. This is **our own verification**, not the official DOGFOOD
acceptance suite, and no tier claim here is receipted by it. [`TESTING.md`](TESTING.md) explains what each layer can and
cannot prove.

Host: macOS 24.6.0, arm64 · Docker 29.4.3 / Compose v5.1.4 · Node 26.7.0
locally, Node 24 in the image · Chrome 141 headless, driven over the DevTools
Protocol.

## 1. One command to running

```
$ docker compose down -v          # fresh volume, nothing cached
$ docker compose up -d
```

```
[forgeboard] applying schema…
[forgeboard] schema applied to /data/forgeboard.db
[forgeboard] seeding demo data (set FORGEBOARD_SEED=0 to skip)…
[forgeboard] seeding demo event…
[forgeboard] seeded /data/forgeboard.db
  event            autumn-build-2026 (judging in progress)
  users            117  (21 judges)
  projects         40 (37 submitted, 1 left unassigned on purpose)
  reviews          99 submitted, 3 still in draft
  demo password    forgeboard2026
  sign in as       admin@forgeboard.local | organizer@forgeboard.local | judge@forgeboard.local | participant@forgeboard.local
[forgeboard] listening on http://localhost:3000
   ▲ Next.js 16.0.10
 ✓ Ready in 85ms
```

**Cold start to a passing healthcheck: 1.2–1.6 seconds** across four runs from
an empty volume. One service, one volume, no database container, and no
warnings in the log.

## 2. It runs with the network off

A container started with `--network none` — no IP address at all:

```
outbound network: blocked (TimeoutError)          # https://registry.npmjs.org
 200  /api/health
 200  /
 200  /events/autumn-build-2026
 200  /events/autumn-build-2026/gallery
 200  /events/autumn-build-2026/results
 200  /docs
 200  /signin
 200  /api/v1/openapi.json
 200  /embed/autumn-build-2026
google/gstatic font references: 0
locally served .woff2 files: 5
seeded offline: 117 users, 1 event(s), database reachable
```

## 3. Restart preserves data and does not re-seed

```
before restart — users: 121 events: 2 teams: 42
after restart  — users: 121 events: 2 teams: 42
probe row survived: true
times the demo event was seeded: 1
[forgeboard] seed already present (autumn-build-2026); nothing to do.
```

(121 users and 2 events because the browser suite in §6 had already registered
accounts and created an event on this instance.)

## 4. Authorization, over real HTTP with real session cookies

`npm run test:http`. Sessions are minted with the same SQL `issueSession()`
uses, then every route is requested from the host as each role:

| path | anon | participant | judge | organizer | admin |
|---|---|---|---|---|---|
| `/dashboard` | 307 → /signin | 200 | 200 | 200 | 200 |
| `/admin` | 307 → /signin | 307 → /dashboard | 307 → /dashboard | 307 → /dashboard | 200 |
| `/events/:slug/organize` | 307 → /signin | 404 | 404 | 200 | 200 |
| `/events/:slug/organize/setup` | 307 → /signin | 404 | 404 | 200 | 200 |
| `/events/:slug/organize/results` | 307 → /signin | 404 | 404 | 200 | 200 |
| `/events/:slug/organize/audit` | 307 → /signin | 404 | 404 | 200 | 200 |
| `/events/:slug/organize/integrations` | 307 → /signin | 404 | 404 | 200 | 200 |
| `/events/:slug/organize/projects` | 307 → /signin | 404 | 404 | 200 | 200 |
| `/events/:slug/judge` | 307 → /signin | 404 | 200 | 404 | 404 |
| `/events/:slug/judge/:own-assignment` | 307 → /signin | 404 | 200 | 404 | 404 |
| `/events/:slug/judge/:another-judges-assignment` | 307 → /signin | 404 | **404** | 404 | 404 |
| `/api/events/:slug/export/reviews` | 403 | 403 | 403 | 200 | 200 |
| `/api/events/:slug/export/audit` | 403 | 403 | 403 | 200 | 200 |
| `/api/v1/events/:slug/reviews` | 403 | 403 | 403 | 200 | 200 |
| `/api/v1/events/:slug/judges` | 403 | 403 | 403 | 200 | 200 |
| `/api/v1/events/:slug/export` | 403 | 403 | 403 | 200 | 200 |
| `/api/v1/events/:slug/progress` | 403 | 403 | 403 | 200 | 200 |
| `/api/v1/events/:slug/results` (unpublished) | 404 | 404 | 404 | 404 | 404 |

The judge's attempt on another judge's assignment is written to the event's
audit trail:

```
Sam Ortiz <judge@forgeboard.local> review.open :other-judge's-assignment {"reason":"not the assigned judge"}
```

The admin column is an instance admin who holds **no role in this event**. Each
of those reads is recorded in the event's own trail:

```
16:11:59 Instance Admin <admin@forgeboard.local> → api:progress
16:11:59 Instance Admin <admin@forgeboard.local> → api:results
16:11:59 Instance Admin <admin@forgeboard.local> → api:export
16:11:59 Instance Admin <admin@forgeboard.local> → api:judges
16:11:58 Instance Admin <admin@forgeboard.local> → api:reviews
event roles held by the admin account: 0
```

## 5. Cross-site request forgery

`POST /api/v1/events` with a deliberately invalid body, so a request that passes
the guard stops at validation and writes nothing:

```
organizer cookie, Origin http://localhost:8080 : 403
organizer cookie, Origin http://evil.example   : 403
organizer cookie, no Origin header             : 403
organizer cookie, Origin http://localhost:3000 : 422   ← passed the guard, failed validation
organizer API key, no Origin                   : 422   ← no ambient credential, unaffected
anonymous                                      : 401
API key GET reviews (organizer's key)          : 200
bogus API key GET reviews                      : 403
```

## 6. The whole lifecycle, in a real browser

`npm run test:browser` — headless Chrome against the container, driven by
`tests/browser/` in this repository, so the run below is reproducible from a
clean clone. Every step is a real interaction: typed input, real clicks, real
form submissions.

```
UX-01 — organizer
  ok   register an organizer  — /dashboard
  ok   a failed submission keeps what was typed  — name and email kept, password cleared, focus on the error
  ok   create an event  — /events/audit-night-…/organize
  ok   a draft event is invisible to visitors  — 404 from both the page and the API
  ok   setup refuses a backwards submission window  — refused, and the form still holds its values
  ok   setup accepts a sane window, a prize and a question  — window, prize and choice question saved
  ok   open submissions  — status open (confirmed through the API)
  ok   create a judge invitation  — /invite/judge/…

UX-01 — participant
  ok   register a participant and create a team
  ok   submitting without the required fields is refused, and the draft survives  — refused with both fields still filled in
  ok   complete and submit the project  — submitted
  ok   the unsaved-changes guard asks before leaving  — asked, and stayed put when told to

UX-01 — visitor
  ok   the project is in the public gallery  — gallery and API both list Lantern

Judge invitation
  ok   a new account accepts the invitation and is scoped to judging  — judging queue reached; organizer console answers not-found
  ok   the invitation cannot be used a second time  — refused as already used

Organizer decisions
  ok   sign back in as the organizer
  ok   assignments are previewed before they are created  — previewed, then committed
  ok   a project can be disqualified, with a reason, and leaves the gallery  — out of the gallery and the API
  ok   reinstating puts it back  — back in the gallery

Account recovery
  ok   an admin issues a recovery link and the password is reset  — issued, redeemed, and the new password works

Sign-in redirect
  ok   next=//evil.example/x  — landed on /dashboard
  ok   next=/\evil.example  — landed on /dashboard
  ok   next=https://evil.example/  — landed on /dashboard
  ok   next=/events/autumn-build-2026  — landed on /events/autumn-build-2026

console errors / exceptions: none
All browser checks passed.
```

## 7. Accessibility

axe-core (WCAG 2.0/2.1/2.2 A and AA rule sets) across fifteen screens, each in
the role that reaches it — landing, sign in, register, event, gallery, published
results, dashboard, organizer overview, setup, panel, projects, scoring audit,
judge queue, submission form, team:

```
serious or critical violations across 15 screens: 0
```

The scan that started this work reported 11 serious violations, all contrast:
text dimmed with opacity (`text-muted-foreground/70`) fell below 4.5:1. It is
now a real token — `#6B706D` in the workspace, 5.04:1 on white and 4.61:1 on the
page; `oklch(0.58 0.03 240)` on the dark landing, 4.88:1 on the page.

Keyboard, which a scanner cannot check:

```
ok   focus is visibly marked as it moves  — <A> "Create event" has an outline
ok   tab order reaches the main actions in order  — Forgeboard → Dashboard → Events → Create event → …
ok   the mobile drawer traps focus and gives it back  — trapped, closed on Escape, focus returned
ok   a judge can score with the keyboard alone  — 20 score options: focusable, arrow keys select
```

No screen reader was used. Nothing here is a conformance claim.

## 8. Layout

Ten screens at each width; fails on horizontal page overflow or visible text
wider than its box:

```
· 320                    no horizontal overflow, nothing clipped
· 390                    no horizontal overflow, nothing clipped
· 720 (=1440 at 200%)    no horizontal overflow, nothing clipped
· 1024                   no horizontal overflow, nothing clipped
· 1440                   no horizontal overflow, nothing clipped
```

## 9. The embed, from a different origin

`examples/embed-host.html` served from `http://localhost:8099`, framing
`http://localhost:3000`:

```
host page origin: http://localhost:8099
iframe src: http://localhost:3000/embed/autumn-build-2026?limit=12
framing refusals: none
```

Headers:

```
/embed/:slug          X-Frame-Options:           Content-Security-Policy: frame-ancestors *
                      Referrer-Policy: no-referrer
/events/:slug/gallery X-Frame-Options: DENY      Referrer-Policy: same-origin
```

The payload carries nothing private — searching 52 KB of embed HTML for
`raw_weighted`, `normalized`, `score`, `vote`, `judge`, `draft` and `email`
returns **0** occurrences of each.

## 10. Latency

Twenty requests per route, container on this laptop, 40 projects and 108
assignments:

| Route | Median | p95 |
|---|---|---|
| `/api/health` | 3 ms | 6 ms |
| `/` | 6 ms | 9 ms |
| `/events/:slug/gallery` | 8 ms | 10 ms |
| `/api/v1/events/:slug/projects?limit=20` | 2 ms | 3 ms |
| `/events/:slug/results` | 4 ms | 5 ms |
| `/events/:slug/organize` (redirect for a visitor) | 4 ms | 6 ms |

## 11. Tests and build

> Superseded by §13: the suite is now 131 tests.

```
$ npm test
ℹ tests 127
ℹ pass 127
ℹ fail 0

$ npm run build
✓ Compiled successfully
```

127 tests: 20 scoring/maths (`MATH-01…07`, including the hand-checks 4.05 /
76.25 and ±1.224744871), 21 backend behaviour, 27 community (`VOTE-01…09`,
`COMMENT-01…02`, `COMMUNITY-01`), 25 stretch (signing, tamper rejection,
portability round trip, webhook SSRF), 34 governance (`SETUP-01…02`,
`JUDGE-INVITE`, `JUDGE-REMOVE`, `CONFLICT-01`, `ELIGIBILITY-01`,
`ASSIGN-PREVIEW`, `ADMIN-01`, `RECOVERY-01`).

## 12. Still not verified

- **The official checker passes 7 of 7** against `docker compose up` (`acceptance-report.txt`).
- **No screen-reader testing.** Automated checks plus manual keyboard work are
  not the same thing.
- **No load testing.** The figures in §10 are single-user medians.
- **Docker image layers were pulled from the network during build.** The
  *runtime* is offline, proven in §2; the initial `docker build` needs network
  to fetch `node:24-alpine` and the npm packages, as any build does. A judge
  cloning this on a disconnected laptop would need the image cached first.
- **No demo video has been recorded.** [`DEMO-SCRIPT.md`](DEMO-SCRIPT.md) is the
  script; the recording is an owner action.

## 13. Release audit and QA follow-up

Our own verification again, not the official suite. Revision: there is no
Git repository, so there is no commit to cite; logs for every command below are
in `test-artifacts/logs/`. Host as above; Chrome 153 headless.

### Defects found by the audit and fixed

| Defect | Evidence before | Fix | Regression test |
|---|---|---|---|
| Bundle import stored out-of-range scores, and trusted the file's pre-computed weighted score, so a tampered file could fake a ranking in the imported event | probe: a review imported with `raw_weighted = 999` and a criterion score of `-40` | Import validates every criterion (finite weight, max above min) and every score (on its criterion's scale, in its review's rubric) before writing, then recomputes weighted scores from criterion scores as a judge's save does | `stretch.test.ts` ×3 |
| An `Infinity` rubric weight was accepted, which makes every weighted score NaN; NaN weights and bad scales were refused only by SQLite with raw constraint text | probe: `createRubricVersion` accepted `Infinity` | Finite weight, named criterion and max-above-min are checked with readable messages | `governance.test.ts` `RUBRIC-VALID` |
| After results were published the review page refused submissions but its header still said "closes in 7 days" | screenshot during the audit | Header says "Judging closed" whenever the window is not accepting reviews | `judging.mjs` |
| A draft event's name reached the `<title>` of the 404 page shown to people who may not see the event | metadata is rendered even when the page is refused | `lib/page-title.ts`: the name appears only when this viewer could see the event | checked by hand, below |
| `authz.mjs` printed its matrix but asserted nothing, so it could not fail | read the script | Every cell and CSRF case is compared with the intended policy; exit 1 on any mismatch | 109/109 |
| The HTTP/browser suites mint sessions in the container named `forgeboard` by default — the owner's instance — whatever base URL they are given | read `sessions.mjs` | Not changed; documented in TESTING.md. Set `FORGEBOARD_DB_PATH` or `FORGEBOARD_CONTAINER` for any other target | — |

### QA follow-up (prompt 06)

- **Landing mobile menu**: the closed panel is `inert` and `aria-hidden`; opening moves focus to its first link; Escape and choosing a link close it and return focus to the toggle; the transition respects reduced motion. New check in `keyboard.mjs`.
- **Dashboard**: *Waiting on you* holds open work only, or "You're all caught up."; finished work sits in a separate, quieter *Recently completed* list of at most three rows. The panel title is now a real heading. New `dashboard.mjs`.
- **Release proof**: the landing page reads the test count from `lib/release-facts.ts` (131), matching README, TESTING.md and `.dogfood.toml`.
- **Module warning**: `tests/package.json` declares `"type": "module"`, the same pattern `lib/` and `scripts/` already use. `MODULE_TYPELESS_PACKAGE_JSON` no longer appears.
- **Copy**: "on Sunday night"; "Your data leaves" → "Portable by design"; "about six seconds from cold" → "healthy in about two seconds" once the image is built (measured 1.9–2.0 s).
- **Titles**: every event page now carries `<task> · <event> · Forgeboard`.

### The gate, run in the order prompt 06 lists

```
$ npm ci --dry-run --offline --ignore-scripts   → exit 0
$ npm test                                      → exit 0   131 tests · 131 pass · 0 fail · 0 skipped · no module-type warning
$ npx tsc --noEmit                              → exit 0   (the first run failed on stale .next/dev/types left by a
                                                            dev server; source was clean without them;
                                                            the cache was removed and the unmodified command passes)
$ npm run build                                 → exit 0
$ FORGEBOARD_DB_PATH=/tmp/forgeboard-follow-up.db npm run db:migrate   → exit 0
$ FORGEBOARD_DB_PATH=/tmp/forgeboard-follow-up.db npm run db:seed      → exit 0
$ FORGEBOARD_DB_PATH=/tmp/forgeboard-follow-up.db npm run db:migrate   → exit 0
$ FORGEBOARD_DB_PATH=/tmp/forgeboard-follow-up.db npm run db:seed      → exit 0   "seed already present; nothing to do"

next start -p 3300 against that database, then each suite with the URL passed explicitly:
$ node tests/browser/authz.mjs      http://localhost:3300  → exit 0   109/109 checks match the policy
$ node tests/browser/e2e.mjs        http://localhost:3300  → exit 0   25 steps, no console errors
$ node tests/browser/a11y.mjs       http://localhost:3300  → exit 0   0 serious/critical across 15 screens
$ node tests/browser/keyboard.mjs   http://localhost:3300  → exit 0   5 checks incl. the landing menu
$ node tests/browser/responsive.mjs http://localhost:3300  → exit 0   0 layout problems
$ node tests/browser/dashboard.mjs  http://localhost:3300  → exit 0   organizer 3 open; judge and participant caught up
$ node tests/browser/judging.mjs    http://localhost:3300  → exit 0   9 steps (below)
server log: 0 errors
```

`judging.mjs` runs last because it publishes results, which closes judging;
run earlier, it changes what the keyboard and dashboard suites see. An earlier
run in that order produced exactly those two failures, which is why the final
gate was rerun on a freshly seeded database.

`judging.mjs`, each actor in its own browser: the judge's queue shows only
their assignments; a partial draft saves and reloads; with the network cut, a
save fails visibly ("The server could not be reached, so nothing was saved…"),
input stays and the stored review stays a draft; submitting stores the scores
and makes the form read-only; another judge gets 404 on the page and 403 from
the API; the organizer recomputes and publishes; a visitor sees the standings
with no judge emails or raw ballot fields in the HTML; after publication the
page offers no submit and a forced POST through the review form is refused;
recomputing afterwards leaves the published snapshot and the public page
byte-identical.

### Checked by hand

- Titles: `Projects · Autumn Build 2026 · Forgeboard`, `Judging panel · …`, `Your team · …`, `Submit project · …`, `Gallery · …`.
- A draft event: anonymous visitors get 404 with the generic title, not the event's name.
- Landing counters settle at the database's values: 38 submitted projects, 100 submitted reviews, 22 judges, 1 visible event.

### Container, restart, backup and offline (isolated project `forgeboard-audit2`, port 3200)

- Fresh volume: seeded and healthy in 1.9–2.0 s after `up -d`.
- `docker restart`: healthy in 0.8 s; every table count identical; the seed step logs "nothing to do".
- Volume backed up with `tar` while stopped, restored into a new volume, and served by a container with `--network none` (only `lo`): 11 public routes answered 200 with no external `src`/`href`; an outbound fetch timed out; restored counts identical.
- This is an **offline runtime** test. The image and packages were already cached; it is not a cold offline install.

### Still not verified

Everything in §12 still stands, and: no screen reader; no load test. The official checker now
passes 7 of 7 (`acceptance-report.txt`).
