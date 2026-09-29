# Threat model

Scope: a self-hosted Forgeboard instance running one hackathon. Assets worth
attacking are **the ranking**, **unpublished scores**, and **submissions**.

The useful list is the honest one, so the "not stopped" section is longer than
the "stopped" section.

## Who attacks this

| Actor | Wants | Has |
|---|---|---|
| Competing participant | A better placing; a look at rivals' work before submitting | An account, a team, a submission |
| Curious judge | To see how peers scored, or to coordinate | A judge account and a queue |
| Outsider | Scraped submissions; a defaced gallery | Network access to the instance |
| Bulk registrant | Many accounts, for whatever a future voting feature enables | An email pattern and a script |
| Careless organizer | Nothing — but has every power and will click things | Full event authority |

---

## Stopped, with the mechanism named

*(Every item below has a test in `tests/`; the HTTP checks are reproduced in `README.md`.)*

### Horizontal privilege escalation between judges
A judge changing `assignmentId` in the URL to reach a peer's ballot.
**Stopped:** `openReview()` refuses unless `assignment.judge_user_id` equals the
actor. Queue rows are selected *by* ownership, not filtered after the fact.
**Verified:** judge → own assignment `200`; judge → another judge's `404`;
the refusal appears in the audit trail with actor and reason.

### Vertical privilege escalation
A judge or participant reaching the organizer console or the score exports.
**Stopped:** `requireOrganizer(cap)` in every organizer-facing domain function;
route handlers call the same functions as the pages.
**Verified over HTTP:** organizer console `200/404/404` for
organizer/judge/participant; `export/reviews` `200/403/403`; anonymous `403`.

### Track leakage
A track-restricted judge reaching another track's projects, including via an
assignment an organizer created by mistake.
**Stopped:** `capabilityFor()` resolves `judgeTrackIds`; `openReview()`
re-checks the project's track against the grant even when an assignment exists.
**Verified:** a deliberately forged cross-track assignment is refused.

### Judging your own team
**Stopped:** `hasConflict()` excludes team members at assignment time *and* at
review-open time, because membership can change after a batch is issued.
**Verified:** a test asserts zero assignments where the judge is on the
project's team.

### Deadline gaming
Submitting after close by replaying the form, holding a tab open, or moving the
client clock.
**Stopped:** `assertEditable()` evaluates `submissionsOpen()` against the
**server** clock on every write. The hidden form is cosmetic.
**Verified:** a test submits past the deadline and is refused.

### Score tampering by rubric edit
Changing a weight after reviews land, to move the ranking.
**Stopped:** rubrics are versioned; reviews keep `rubric_version_id`;
`raw_weighted` is cached at submit time. A new rubric supersedes, never rewrites.

### Early results disclosure
**Stopped:** `publicResults()` returns nothing unless the event is
`results_published` **and** a snapshot is `published`. Computing is a separate
action from publishing, and publishing asks for confirmation.
**Verified:** a test asserts results are `null` before publish and after
unpublish.

### Session theft from a database leak
**Stopped:** only SHA-256 of the session token is stored, so database contents
yield no usable cookie. Passwords are scrypt with per-user salts. Disabling an
account revokes live sessions on the next request.

### Credential stuffing
**Stopped (blunted):** ten failed attempts per address in fifteen minutes and
the form refuses. Failures are audit rows, so the evidence is readable. Sign-in
returns one message whether the address exists or not; an unknown address still
pays for a hash comparison, so timing does not reveal membership.

### SQL injection
**Stopped:** every query is a prepared statement with bound parameters. The
only interpolated SQL fragments are column names built from fixed allowlists
inside the module that owns the table.

### CSV formula injection
A project description of `=IMPORTXML(...)` executing when an organizer opens an
export.
**Stopped:** values beginning `=`, `+`, `-`, `@`, tab or CR are prefixed with a
single quote. **Verified** by test.

### Server-side request forgery via submitted URLs
**Stopped:** the server never fetches a participant-supplied URL. They are
stored and rendered as links with `rel="noopener noreferrer nofollow"`.

### Cross-site scripting
**Stopped (by default):** React escapes interpolated content and the codebase
contains no `dangerouslySetInnerHTML`. Descriptions render as text.

### Clickjacking / MIME sniffing
**Stopped:** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin` on every response.

---

## Reduced, with the residual risk named

These are not wide open and they are not closed. Each one says what the
control actually does and what it leaves standing.

### Comment abuse
**Stopped:** posting requires an account, is rate limited to 5 per minute per author, is length-capped
at 2000 characters, and the author is always the authenticated actor — there is no author field in the
payload to forge. Removal hides the text from every response while retaining the author's original
words in the row, and moderation of someone else's comment requires an organizer role *and* a recorded
reason. Rendered as text by React, so stored markup is inert. **Not stopped:** a determined person with
several accounts can still post repeatedly.

### Vote and comment leakage into judging
**Stopped:** community votes and comments are separate tables read by separate services. The comment
reader joins only to `users`; the tally is organizer-only; the webhook payload for `vote.cast` carries
no totals. A test asserts that voting and commenting leave every `reviews` row byte-identical.

### Webhook callbacks as an SSRF primitive
**Stopped:** an operator-supplied callback URL is resolved, and any host resolving to loopback,
private, link-local (including cloud metadata at 169.254.169.254), CGNAT or reserved space is refused —
before the first request and again on every retry, because DNS can change between them. Redirects are
not followed. Credentials in the URL and non-HTTP schemes are refused. A narrow
`FORGEBOARD_WEBHOOK_ALLOW_LOCAL=1` exists for local testing and does not disable the other checks.

### Forged webhook payloads at the consumer
**Stopped:** every delivery carries `X-Forgeboard-Signature`, an HMAC-SHA256 over
`deliveryId.timestamp.body`, verified in constant time. Delivery is at-least-once with a stable
delivery id; consumers must deduplicate. We do not claim exactly-once.

### Record forgery
**Stopped:** participation records are Ed25519-signed over a canonical JSON serialisation, so key order
cannot change a signature and a single altered character invalidates it. The private key is written
0600 on the data volume and never leaves it. Verification needs only the published public key and no
account. **Explicitly not stopped:** a valid signature proves authenticity, not truth — signing a false
statement yields a validly signed false statement, and `/verify` says so in those words.

### Cross-site request forgery
**Stopped:** three layers, two of which are in this repository. Server Actions
carry Next's own origin check; session cookies are `SameSite=Lax`; and every
cookie-authenticated write through the REST API is refused unless the `Origin`
header matches the host it was sent to (`sameOrigin()` in
`app/api/v1/[[...path]]/route.ts`). That last one matters because SameSite
treats every port on `localhost` as the same site, so a page served from
`localhost:8080` could otherwise post to the API with a visitor's cookie. A
request carrying an API key has no ambient credential and is unaffected.
`authz.mjs` exercises all four cases: cross-origin, foreign-origin, no origin,
and same origin.

**Explicitly not stopped:** there is still no per-form CSRF token. The defence
is origin-based, which fails if a browser ever lies about `Origin`.

### An instance admin quietly reading an event they do not run
**Not "stopped" — allowed, and recorded.** Instance administration means being
able to open any event; a platform where that is impossible cannot be operated.
What is guaranteed is that it is never invisible: a capability held only through
the global role is marked `viaAdmin`, and the first such access to a console, an
export or an organizer API route in any five-minute window writes an
`admin.access` row into **that event's own** audit trail, which its organizers
read. **Explicitly not stopped:** an admin with database access can edit the
trail directly. Append-only here means "the application never updates or deletes
these rows", not tamper-proof storage.

### A revoked judge keeping access
**Stopped:** capabilities are resolved from `event_roles` on every request, so
removing a judge takes effect on the next one — no session, open page or
in-flight download keeps the old powers. Their unfinished assignments are
released for reassignment; their submitted reviews stay exactly as they were,
because the record of who judged what has to survive the removal.

### A judge escaping a conflict of interest by leaving the team
**Stopped:** `team_member_history` records departures, and the conflict check
consults current membership *or* that history. Leaving the team the day after
assignments go out does not make a judge eligible to review their own project.

### An invitation link being replayed, widened or shared
**Stopped:** role invitations store only a SHA-256 of the token, expire in seven
days, work exactly once, and can be revoked. The role and track scope are read
from the stored row at acceptance, so the browser cannot widen a single-track
grant. An invitation addressed to an email can only be accepted by the account
holding it, and a mismatch is written to the audit trail as a refusal.
**Not stopped:** an unaddressed link is a bearer token — whoever holds it can
accept it. Address the invitation when that matters.

### A stolen or guessed recovery link
**Stopped:** recovery links are one-use, expire in an hour, store only a hash,
invalidate every other outstanding link for that account when redeemed, and sign
the account out of every existing session. The raw link never enters the audit
trail; only the fact that one was issued, and by whom. **Not stopped:** anyone
who can run a command on the server can issue one — but they already hold the
database, so this grants nothing new. It is the recorded path rather than a
silent one.

### Secret leakage through data export
**Stopped:** the portability bundle strips password hashes, salts, session hashes, raw tokens and IP
hashes; a test asserts their absence. Imported accounts arrive with an empty password and
`disabled_at` set, so an import cannot mint usable logins.

### Uploaded file handling — partly mitigated
Upload is now built. Stopped: the accepted type is decided by **magic bytes**, not by the filename or
the browser's Content-Type; SVG is refused outright because it can carry script; the path on disk is
generated from the asset id so a crafted name cannot traverse; a 5 MB cap and an 8-image limit apply;
and served files carry `nosniff`, a sandboxing CSP and their recorded type.

Not stopped: images are **not re-encoded**, so a file that is a valid image *and* something else
remains intact on disk. Nothing executes it, but it is stored. There is no malware scanning and no
per-user upload quota beyond the per-project limit.

## Not stopped, and why

### Sybil voting
**This is the largest unmitigated risk in the product, and community voting is now built.**

What is in place: one live vote per voter per project enforced by a partial unique index; a per-event
budget checked inside the same transaction as the insert; three access modes with their real strength
stated on the ballot page; organizer review signals for shared networks, rapid voting and repeated
verification requests; and audited invalidation that removes votes from the count while preserving
history.

What none of that achieves is proof of one human, one vote:

| Mode | What it proves | How it is defeated |
|---|---|---|
| Open link | This browser has not already voted | Clear cookies, open a private window, use another device |
| Email-gated | Control of one address, once | Own several addresses |
| Authenticated | One account on this instance | Register several accounts |

Registration is unrestricted and unverified, because there is no mail server. So an attacker willing
to spend a few minutes can vote several times in any mode. The honest mitigations are operational, not
technical: keep the prize small, publish results only after review, and read the signals view before
believing the numbers. That is the same advice the incumbent platforms give, and we have not beaten it.

A real fix needs an identity signal we do not have — an invite list of known addresses, SSO against the
organizer's own directory, or moderation of every voter. The audit trail exists so that abuse is
*reconstructible after the fact*, which is what we can actually offer.

### Gallery scraping
The public gallery is public. There is no rate limit on reads. An organizer who
needs submissions private before judging should keep the event in
`submissions_closed` rather than `open`. Not fixed because read limits on a
self-hosted instance mostly inconvenience legitimate users.

### Judge collusion
Two judges agreeing out of band on scores. Forgeboard cannot detect this and
does not claim to. The calibration table makes a judge whose distribution is
wildly unlike the panel's *visible*, which is detection of the crude case only.
Genuine defence is panel composition, which is a human process.

### A malicious or careless organizer
An organizer can edit a submission after the deadline, revoke assignments,
recompute and republish. This is by design — someone must be able to correct a
record — and the control is the audit trail, not prevention. Every such action
is logged with actor, subject and time. There is no separation of duties: a
single organizer can do all of it unobserved except by the log.

### Brute force across many accounts
The throttle is per email address. An attacker trying one password against a
thousand addresses is not slowed. Fixing it properly needs per-IP accounting,
which needs a trustworthy client address, which needs knowing the proxy
topology of a deployment I cannot see.

### Denial of service
No request rate limiting, no body size limits beyond framework defaults, no
query cost control. SQLite serialises writers, so a write flood degrades the
whole instance. Appropriate defence is a reverse proxy in front, which is a
deployment concern and is not shipped here.

### Timing side channels beyond login
Page latency differs measurably between "not found" and "not allowed" in some
paths, so a determined attacker could infer that an event or assignment exists.
Both return 404, so the disclosure is timing-only and small.

### Physical and host security
Anyone with the volume has the database. There is no encryption at rest, and
the demo seed ships a published password. **Change `FORGEBOARD_SEED=0` or reset
the database before running a real event on this instance.**

---

## If you run this for real

1. Put it behind a TLS-terminating reverse proxy and drop
   `FORGEBOARD_INSECURE_COOKIES`, so session cookies are `Secure`.
2. Start with `FORGEBOARD_SEED=0`. The demo accounts have a published password.
3. Add rate limiting at the proxy, where the real client address is known.
4. Back up `/data` on a schedule, with `.backup`, not `cp`.
5. Read the audit log after the event. It is the only record of organizer action.
