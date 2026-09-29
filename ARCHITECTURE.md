# Architecture

Forgeboard is one Node process and one SQLite file. It renders HTML on the server, answers JSON
on the same routes' domain functions, and needs nothing from the network.

```
            docker compose up
┌──────────────────────────────────────────────────────────────────────────┐
│ container: node:24-alpine, runs as user "node"                           │
│                                                                          │
│   node:http ──► http/app.ts ──► routes/*.ts ──► domain/*.ts ──► db/store  │
│                 security headers   parse, render   rules + authorization  │
│                 session lookup     pick HTML/JSON  one transaction each   │
│                 CSRF check                                                │
│                 error boundary ◄── HttpError / AccessDenied (audited)     │
│                                                                          │
│   volume /data ── forgeboard.db (SQLite, WAL) ── the only state there is  │
└──────────────────────────────────────────────────────────────────────────┘
        no egress, no second service, no API key, no npm install
```

## The request path

1. **`http/app.ts`** sets the security headers, then builds a `Ctx`. The `Ctx` holds the parsed
   URL, the cookies, the CSRF cookie and the server's clock reading for this request.
2. **Static files** (`/static/*`) are served from memory with a content hash in the URL, so a
   release is never hidden behind a cached stylesheet.
3. **The session cookie** is hashed and looked up. An unknown or expired token is simply no user.
4. **The router** matches method and path (`http/router.ts`, about 60 lines). For `POST`,
   **`ctx.verifyCsrf()`** runs *before* any handler, so no route can forget it.
5. **A route handler** (`routes/*.ts`) parses input and calls **one domain function**. It then
   renders a page (`views/*.ts`) or answers JSON, and redirects after a successful form post.
6. **The domain function** (`domain/*.ts`) takes an `Actor` (user, IP, server time). It checks
   authorization, then does its reads and writes in **one transaction**.
7. **Errors** become responses in one place, `fail()`:
   - `HttpError` keeps its status.
   - `ValidationError` re-renders the form with every field's message.
   - A database constraint violation becomes a 409 instead of a crash.
   - An `AccessDenied` is written to the audit trail *after* the transaction has rolled back,
     so a refused attempt is never lost with the work it tried to do.

## Layers

| Directory | Owns | May use |
|---|---|---|
| `src/http/` | HTTP: context, router, CSRF, rate limits, static files, the error boundary | domain errors |
| `src/routes/` | One module per area: public, auth, teams, judge, organize, admin, api | domain, views |
| `src/domain/` | The rules. Authorization, deadlines, assignment, normalization, results, audit | db, util |
| `src/views/` | HTML as escaped template literals. No logic beyond presentation | util |
| `src/db/` | `Store` (prepared statements, transactions), migrations | node:sqlite |
| `src/util/` | Errors, form reading, CSV, time, tokens. No I/O | node:crypto |

Dependencies point one way: `http → routes → domain → db`. The domain never sees a request, so
the same function serves the HTML form, the JSON API and the tests.

**Authorization lives in the domain, not the routes.** Every write function starts with the
check it needs:
- `requireRole(store, actor, event, ['organizer'], 'publish the results of …')`
- `assertSubmissionsOpen(event, actor.now)`
- a team-membership test

A route that forgot a check could not leak: the function it calls refuses the caller. The
queries themselves are scoped where it matters. A judge's queue is `WHERE a.judge_id = <the
caller>`, and there is no parameter to ask for someone else's. Three pure modules have no database
access at all and are tested alone: `domain/normalization.ts` (the model fit),
`domain/uncertainty.ts` (rank intervals, leave-one-judge-out, the prize line),
`domain/pairwise.ts` (Bradley–Terry, implied comparisons, the pair picker) and
`domain/assignment.ts` (the planner).

Evidence is built from the standard library too: `domain/audit.ts` chains entries with SHA-256,
`domain/commitment.ts` fingerprints the method when scoring starts, `domain/signing.ts` holds the
Ed25519 key (`node:crypto`), `domain/evidence.ts` builds, parses and verifies the signed results
document, and `views/capsule.ts` renders the self-verifying results file, whose inline checker
restates the fit in 30 lines so it can run with no server.

The public tier follows the same shape: `domain/voting.ts` (settings, codes, ballots, the
per-voter shuffle, tallies, clusters) and `domain/comments.ts` hold every rule, and
`routes/community.ts` only parses and renders. The tally's visibility is decided in the domain,
so the page, the JSON API and the CSV cannot disagree about who may see it.

## Decisions worth defending

| Decision | Why | Cost we accepted |
|---|---|---|
| **Zero runtime dependencies**: `node:http`, `node:sqlite`, `node:crypto` | `docker compose up` cannot break on a registry outage or a yanked package, the image builds with the network off, and there is no supply chain to audit | A router, request context, form reader and template helper written here, about 500 lines together |
| **SQLite in WAL mode, one file** | No second container, no health-check race, backup is one file. The whole fixture imports in about 50 ms | One writer at a time; no horizontal scaling. Right for a hackathon, wrong for a SaaS |
| **TypeScript run directly by Node** (type stripping, erasable syntax only) | Types without a build step. `tsc` is a development check, not part of shipping | No enums or parameter properties; `.ts` extensions in imports |
| **Server-rendered HTML, no client framework** | Pages work without JavaScript. The gallery's fixture titles are in the response body, so curl sees them. Authorization is never duplicated in a client | About 70 lines of progressive-enhancement JS: the menu, copy buttons, the live refresh |
| **Escaping by default** (`views/html.ts`) | Every interpolated value is escaped unless it is already `SafeHtml`. There is no way to print user text raw by accident | Templates are strings, not components |
| **Strict CSP**: `script-src 'self'; style-src 'self'`, no inline anything | An injected `<script>` would not run even if escaping failed | No inline styles, so progress bars use native `<progress>` |
| **The phase is computed, never stored** | "Open", "judging" and "published" are derived from the dates, so the label can never disagree with the rule that enforces it | A few date comparisons per request |
| **The deadline is checked first, inside the write's transaction** (`BEGIN IMMEDIATE`) | A late request is refused for being late, whatever else is wrong with it, and no write can slip in between the check and the commit | Writers queue on SQLite's lock, which is microseconds here |
| **403 means "not yours", decided before looking** | Refusals are decided from the caller's roles *before* the target is fetched, so a 403 is not an oracle for which judges or reviews exist | Organizers and judges hit different refusal messages; both are logged |
| **Fixture ids kept as primary keys** | `prj_07` in the database is `prj_07` in the file, so every exported number traces back to the input | Ids are opaque strings with mixed origins (`prj_07`, `prj_k3v9x2m1qa7d`) |
| **Raw scores stored, derived values recomputed** | Weights can change without rewriting reviews. Normalized results live only in immutable, published snapshots | Standings are recomputed on each preview (about 10 ms on the fixture) |
| **One-time links instead of email** | No SMTP server, no hosted mail provider, fully offline | People pass links on by hand; stated in the UI and the README |

## Security in one place

- **Sessions:** 256-bit random tokens. The cookie is `HttpOnly; SameSite=Lax` (`Secure` behind
  HTTPS), and the database stores only SHA-256 hashes. Sessions last 14 days, sign-out deletes
  the row, and a password change ends every other session.
- **CSRF, in three layers:**
  1. The cookie is `SameSite=Lax`.
  2. A browser's `Origin` header must be ours.
  3. Form bodies must carry an HMAC token bound to a per-browser cookie.

  JSON bodies need no token: a cross-site page cannot send `application/json` without a CORS
  preflight, which this server never approves. A `text/plain` body is refused with 415.
- **Passwords:** scrypt (N = 16384, r = 8, p = 1) with a per-password salt. The parameters are
  stored in the hash so they can be raised later. A sign-in for an unknown email still spends
  the scrypt time.
- **Input:** a 1 MB body limit, every field length-checked, and URLs restricted to `http(s)`.
  SQL is parameterized everywhere.
- **Output:** HTML escaped by default. CSV cells starting with `= + - @` are prefixed.
  Security headers go on every response.

The full analysis is in [THREAT-MODEL.md](THREAT-MODEL.md).

## Operability

- **Boot** (`boot.ts`) is idempotent and safe on every start:
  1. Migrate.
  2. Generate a signing secret once.
  3. Import the fixtures if asked (skipped if the event exists).
  4. Seed demo mode, or print a first-administrator link.

  The first start takes about 0.1 s after the image is built.
- **Health:** `GET /healthz` runs a query. The container health check uses it.
- **Operator CLI:** `src/cli.ts` covers `backup` (a consistent `VACUUM INTO` copy while running),
  `import`, `password-link` and `make-admin`.
- **Logs:** the boot summary goes to stdout, and unexpected errors go to stderr with method and
  path. Refusals and changes go to the audit table, not the log.
- **Shutdown:** SIGTERM and SIGINT close the server and the database cleanly.

## Testing

`npm test` runs Node’s built-in test runner over `tests/`: 145 tests in about 11 seconds, including a crawl of every link and a press of every button as every role.

- **Unit tests** cover the model, the planner, deadlines, CSV, escaping and passwords.
- **Data tests** run against an in-memory database and cover the importer and schema constraints.
- **HTTP tests** start real servers on random ports with throwaway databases. They drive the real
  forms with a cookie-and-CSRF-aware client, and include the full lifecycle, the authorization
  matrix and the checker's seven behaviours.

Tests never touch `./data` or a running instance.

## What is deliberately not here

No background worker, queue, cache, or ORM. No client-side routing, no CSS framework, no web
fonts. The system fonts are fine, and a font download would break the offline rule. Each would
add a moving part without adding a requirement met.
