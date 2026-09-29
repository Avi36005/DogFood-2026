# Architecture

## Shape of the system

One Next.js application, one SQLite file, one container.

```
                      ┌──────────────────────────────────────────┐
  browser  ──HTTP──▶  │  Next.js (App Router, React 19)          │
                      │                                          │
                      │   pages / route handlers    ← no rules   │
                      │            │                  live here  │
                      │            ▼                             │
                      │   ┌──────────────────────┐               │
                      │   │  capabilityFor()     │  ← the only   │
                      │   │  (lib/authz.ts)      │    door       │
                      │   └──────────┬───────────┘               │
                      │              ▼                           │
                      │   domain services (lib/domain/*)         │
                      │   events · teams · projects · judging    │
                      │   scoring · results · exports · audit    │
                      │              │                           │
                      │              ▼                           │
                      │   lib/db/client.ts  (node:sqlite)        │
                      └──────────────┬───────────────────────────┘
                                     ▼
                         /data/forgeboard.db  +  /data/uploads
```

There is no second process. No queue, no cache server, no database container,
no sidecar. This is a deliberate choice: the thing being optimised is whether a
stranger can run it, and every additional moving part is a way for that to fail
on someone else's laptop.

## Trust boundaries

There are three, and only one of them matters.

1. **Browser → server.** Everything from the browser is hostile input: form
   fields, URL segments, query strings, cookies. Nothing from the client is
   trusted to describe who the user is or what they may do.
2. **Server → database.** Every query is a prepared statement with bound
   parameters. String concatenation into SQL appears nowhere; the only
   interpolated fragments are column names built from a fixed allowlist inside
   the module that owns the table.
3. **Server → outside world.** There isn't one at runtime. Forgeboard makes no
   outbound requests. URLs that participants submit are stored and rendered as
   links with `rel="noopener noreferrer nofollow"`; the server never fetches
   them, so a submitted URL cannot be used to make the server talk to anything.

## Authorization

This is the part the whole product stands on, so it gets its own section.

**Rules live in the data layer, not in the pages.** A React component deciding
whether to render a button is a courtesy to the user, never a control. The real
decision happens in `lib/authz.ts` and the domain services that require its
output.

The unit of authority is a **capability**: what one actor may do inside one
event.

```ts
type Capability = {
  actor: Actor | null;
  eventId: string;
  isAdmin: boolean;
  isOrganizer: boolean;
  viaAdmin: boolean;      // organizer here only because they administer the instance
  isJudge: boolean;
  isParticipant: boolean;
  judgeTrackIds: string[] | null;   // null = every track
};
```

It is built by reading `event_roles` from the database on every request.
It is never cached across requests, never serialised to the client, and never
derived from anything the browser sent except the session cookie.

Domain functions refuse to run without the right capability:

```ts
export function judgeProgress(cap: Capability): JudgeProgress[] {
  requireOrganizer(cap);      // throws AccessDenied
  return all(/* ... */);
}
```

Roles are **per event**. A person can organize one event, judge a second and
compete in a third. The only instance-wide role is `admin`, which manages
accounts and does not confer event powers automatically — it grants organizer
rights only where explicitly recorded in `event_roles`.

### Isolation is a query shape, not a filter

The strong version of "a judge cannot see another judge's scores" is that no
code path exists which would return one. A judge's queue is not "all
assignments, filtered by mine" — it is selected *by* ownership:

```sql
SELECT ... FROM assignments a
 WHERE a.event_id = ? AND a.judge_user_id = ?   -- the actor's own id
```

Opening a single review re-runs every check rather than trusting that the
caller came from the queue: assignment belongs to this event, assignment belongs
to *this actor*, the project is inside the judge's track grant, and the judge is
not on the project's own team. `saveReview` calls `openReview` first, so the
write path cannot be reached without passing the read path's checks.

A refused attempt is recorded in `audit_events` with `outcome = 'denied'`, the
actor and the reason. An organizer can read who tried what without a database
client.

Route handlers (`/api/.../export/...`) call the *same* domain functions as the
pages, so a `curl` is refused exactly as the interface is. That symmetry is the
point: there is no "API path" with its own, weaker rules.

### Failure mode: 404, not 403

When an actor lacks a role, pages return **404**, not 403. A judge poking at
`/events/x/organize` learns nothing about whether that console exists. The CSV
endpoints return 403 because they are an explicit machine-facing surface where
a clear refusal is more useful than a lie.

## Request lifecycle

1. Request arrives. `currentActor()` reads the session cookie, hashes it, and
   looks up a live, unrevoked, unexpired session joined to a non-disabled user.
   No cookie, or no match → `null` (a visitor).
2. The page resolves the event and calls `capabilityFor(actor, event.id)`.
3. The page calls domain services, passing the capability. Services enforce.
4. Services write `audit_events` for every state change and every refusal.
5. React renders. Field-level visibility is decided by what the service
   *returned*, never by CSS: data an actor may not see is not in the payload.

## Why these choices

**SQLite via `node:sqlite`, not Postgres.** The rule that matters is "runs on a
laptop with the network off, from one command". A second container is the most
common way that promise breaks: healthcheck races, volume permissions, a port
already bound. `node:sqlite` is in the Node standard library, so there is no
native build step, no driver to install and nothing to start. At the scale of a
hackathon — tens of projects, tens of judges, thousands of scores — the write
concurrency ceiling is far away. `DATA-MODEL.md` documents the migration path
if you outgrow it.
*Cost:* one writer at a time, and no network-accessible database for external
tooling.

**No ORM.** The schema is the product's most-read artifact, so it is plain SQL
in `lib/db/schema.sql` where a reviewer can read it in one pass. Queries are
prepared statements in the module that owns the table.
*Cost:* hand-written row types, and no compile-time link between them and the
DDL. The integration tests are what catch a drift.

**`scrypt` and server-side sessions, not JWT.** Sessions are database rows;
the cookie carries an opaque 256-bit token and only its SHA-256 is stored.
A database leak yields no usable sessions, and revocation is immediate — a
disabled account's sessions die on the next request, which is not true of a
self-contained signed token.
*Cost:* a database read per request. At this scale it is a single indexed
lookup.

**Server Actions over a REST API.** T2 does not require a public API, and
building one properly (versioning, auth tokens, OpenAPI) is T4 work. Server
Actions let forms post directly to typed server functions that call the same
domain layer. When the API arrives it should be another adapter over those
services, not a parallel implementation.
*Cost:* no programmatic access today beyond CSV export and `/api/health`.

**Fonts vendored, analytics removed.** The source design used
`next/font/google` and `@vercel/analytics`. Both reach the network. Geist Sans,
Geist Mono and Geist Pixel Line ship inside the `geist` npm package, so the
identity survives and the offline requirement holds.

## Concurrency and correctness

- Writes that must not interleave run in `BEGIN IMMEDIATE` transactions
  (`tx()` in `lib/db/client.ts`): accepting an invite, submitting a review,
  computing a snapshot, publishing a rubric.
- Accepting an invite checks the seat count, inserts the membership and
  increments the use counter inside one transaction, so two people racing for
  the last seat cannot both win.
- `events`, `projects` and `reviews` carry a `version` column. The submission
  form posts the version it was rendered with; a mismatch is refused with a
  message naming the cause rather than silently overwriting a teammate.
- Uniqueness is enforced by indexes, not by checking first: one project per
  team, one review per assignment, one assignment per judge-project pair, one
  score per criterion per review.

## The admin override, and why it is noisy

An instance admin can open any event. That is what instance administration
means, and pretending otherwise would make the role useless. What it must not
be is *quiet*: `viaAdmin` marks a capability that exists only because of the
global role, and `audit.adminAccess()` writes an `admin.access` row into **the
event's own** audit trail the first time such an actor touches the console, an
export or an organizer API route in a five-minute window. The organizers of
that event see it in their own audit tab.

Repeats inside the window collapse into the first record, so paging around the
console leaves one line rather than forty.

## Streaming, and why the shell is not flushed early

Next renders these pages dynamically. A route-level `loading.tsx` would wrap
each page in a Suspense boundary and flush the shell immediately — and once a
byte is on the wire, `redirect()` and `notFound()` can no longer set a status
code, so an unauthorized page would answer **200** with a client-side redirect
inside it. Status codes are part of the authorization story here, so there is
no route-level loading file.

Where a loading state is genuinely useful — the gallery's result grid — the
Suspense boundary sits *inside* the page, after the event has been resolved and
the access decision made. The skeleton streams; the status code stays honest.

## Time

Every instant is stored as a UTC ISO-8601 string. `events.timezone` is a
display preference only. Deadlines are evaluated with the **server** clock in
`submissionsOpen()` and `judgingOpen()`; the client's clock is never consulted
and never trusted. The submission form hides itself after the deadline, but the
check that decides is the one in `assertEditable()`.

## Layout

```
app/                     routes; pages resolve capability, then render
  page.tsx               the landing page (dark, the reference's sections)
  (app)/                 every other page; its layout adds the light sidebar shell
  api/health             liveness plus a real database read
  api/events/[slug]/export/[name]   CSV, same authz as the pages
lib/
  db/client.ts           connection, migrate() + additive column upgrades, tx()
  db/schema.sql          the whole schema, plain SQL
  auth/password.ts       scrypt hash and verify
  auth/session.ts        cookie ↔ session row ↔ Actor
  authz.ts               Capability, requireX(), conflict-of-interest (current and past)
  domain/                one module per area; all rules live here
  actions/               "use server" adapters: FormData → domain calls
components/
  ui/                    the reference project's shadcn library, unmodified
  landing/               the reference project's landing sections, copy changed
  app/                   app screens composed from components/ui
scripts/                 migrate, seed, reset, reset-password (operator recovery)
tests/                   scoring, backend behaviour, community, stretch, governance
```

The dependency rule is one-directional: `components` → `actions` → `domain` → `db`.
Nothing in `domain` imports from `ui` or `actions`, which is what lets the test
suite exercise the real rules without a browser.
