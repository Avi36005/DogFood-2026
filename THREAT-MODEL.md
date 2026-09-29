# Threat model

A judging portal is attacked by the people it serves more often than by strangers:
- a team that wants one more hour
- a judge who wants to see how the others scored
- a friend who wants a friend to win
- an organizer under pressure

This page lists what is worth protecting, who might try what, and what stops them. It also
lists what does not.

## What is worth protecting

1. **The ranking's integrity.** Scores reach the ranking only from the assigned judge, inside
   the judging window, and the method that turns them into ranks is fixed and recorded.
2. **Judge independence.** No judge sees another judge's scores before, during or after judging.
3. **The deadline.** Nothing about a submission changes after it.
4. **Accounts and roles.** Nobody acts as someone else, or with a role they do not hold.
5. **The record.** What happened, who did it and what was refused can be reconstructed later.

## Who might attack, and how

| Actor | Wants to | What stops it | Where |
|---|---|---|---|
| **A late team** | Edit or submit after the deadline via the page, the API, a stale tab or a scripted POST | The deadline is checked against the **server clock inside the same transaction as every write** to a team or project, API included. The client's clock is never consulted. The boundary is exclusive: at 18:00:00.000 the event is closed | `domain/events.ts` `assertSubmissionsOpen`; `tests/unit/deadline.test.ts`; lifecycle test *after that every write is refused* |
| **A team fighting over one project** | Overwrite a teammate's edit | Optimistic versioning: an edit made against an old version gets 409 instead of silently winning | `updateProject`; *a stale edit is refused* |
| **A curious judge** | Read another judge's scores or reviews by editing a URL or calling the API | Authorization in the backend. A judge's queries are keyed on their own id. `?judge=<other>` and another judge's review page return **403**, decided before the target is looked up (no existence oracle), and **logged** | `judgeScores`, `reviewPage`; `tests/http/matrix.test.ts` |
| **A judge on a team** | Score their own team | A judge cannot hold the judge role in an event where they are on a team, and cannot join a team there. The assignment planner also excludes team members | `inviteJudge`, `createTeam`, `joinTeam`, `assignment.ts` |
| **A judge rigging the result** | Give a friend 5s and rivals 1s | They can only score the projects assigned to them, and every score and revision is audited with its values. Normalization fits their *overall* generosity, so a uniformly generous judge moves nothing. Selective favouritism is not removed by any model: it is made **visible**, since the organizer sees every judge's reviews, offsets and flags | JUDGING.md §3–4 |
| **Colluding judges** | Coordinate scores between them | They cannot see each other's scores inside Forgeboard. Outside it, collusion is a social problem. The mitigations are: several judges per project (the target is 3 by default), one judge's pull limited to their share of a project's reviews, and complete per-judge exports for an after-the-fact review | assignment target; `exports.ts` |
| **An organizer** | Quietly change weights, the deadline or the duplicate decision after seeing a preview | Every such change is audited with its before and after values. A published snapshot freezes the method, λ and weights, and republishing supersedes it without deleting it. The audit log is **append-only in the database** (triggers reject `UPDATE` and `DELETE`) | `rubric.ts`, `updateEvent`, `results.ts`; *the audit log is append-only* |
| **Someone signing up as an invited judge** | Take over a judge's seat by registering their email first | Sign-up refuses any email that already exists, including invited and imported people who have not set a password. They can only claim the account with their one-time link | `signUp`; `security.test.ts` |
| **A credential stuffer** | Guess passwords | scrypt hashing, and 10 attempts per IP and email per 10 minutes (then 429). A failed sign-in for an unknown email takes as long as one for a known email | `signIn`, `http/rate-limit.ts` |
| **A cross-site page** | Make a signed-in organizer's browser publish results or change settings | `SameSite=Lax` cookies, an `Origin` check, and an HMAC token on every form. JSON is accepted only as `application/json`, which needs a CORS preflight that is never granted | `Ctx.verifyCsrf`; `security.test.ts` |
| **An injected script** | Run JavaScript in an organizer's browser via a project title or a comment | HTML is escaped by default, and a strict CSP allows no inline script or style | `views/html.ts`; *user text is escaped wherever it is shown* |
| **A malicious spreadsheet cell** | Run a formula when an organizer opens the CSV | Cells beginning with `= + - @`, a tab or a CR are prefixed with `'` | `util/csv.ts` |
| **A session thief** | Replay a stolen cookie or a copied database | Cookies are `HttpOnly` (and `Secure` behind HTTPS). The database holds only token *hashes*, so a copy of it grants no sessions. Sign-out deletes the session, and a password change ends every other session | `sessions.ts` |
| **A link leaker** | Reuse a forwarded invite or reset link | Links are hashed at rest and expire. Password and judge links work once. A team invite dies when the captain creates a new one | `accounts.ts`, `teams.ts`, `judging.ts` |
| **A resource exhauster** | Tie up the server | A 1 MB body limit, request and header timeouts, and bounded list sizes. Nothing the server does reaches out to the network, so there is no SSRF surface | `http/context.ts`, `server.ts` |

