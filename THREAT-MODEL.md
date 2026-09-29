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
| **An organizer, after seeing who is ahead** | Retune the method or the weights so a favourite wins | The method, λ, scale and weights are **fingerprinted into the audit chain when the first score arrives**. Publishing compares, and the public results page and the signed document say "method unchanged" or "method changed" | `commitment.ts`; *method commitment* |
| **Whoever holds the database file** | Rewrite history: edit or delete an audit entry around the triggers | Every audit entry stores the SHA-256 of the one before it and of its own fields. An edit breaks its own hash; a deletion breaks the next entry's link. `cli.ts verify-audit` and the Audit page name the first entry that fails | `audit.ts` `verifyChain`; *an edit made around the triggers is caught* |
| **Anyone after publication** | Change a published score or rank, or the reviews behind it | Results are **signed with Ed25519** and the signed document quotes the audit chain's head and a fingerprint of the inputs. The results capsule checks the signature, the fingerprint and a refit in any browser, offline | `evidence.ts`, `views/capsule.ts`; `tests/http/evidence.test.ts` |
| **A ballot stuffer** | Vote many times | **One ballot per account and per voter code**, enforced by unique indexes in the same transaction that checks the window against the server clock; picks are final (triggers). Judges and organizers cannot vote at all, and nobody can approve their own team's project | `voting.ts` `castBallot`; `tests/http/community.test.ts` |
| **A code guesser** | Find a valid voter code | Codes are 12 characters from a 31-letter alphabet (about 59 bits), stored only as SHA-256 hashes. Wrong codes are limited to 20 per address per 10 minutes; only failures count, so a venue behind one address is never throttled. A wrong code and a spent code get the same answer | `voting.ts` `resolveVoter`; *guessing codes is rate limited* |
| **A venue full of sock puppets** | Cast ballots from many accounts on one network | Ballots store keyed hashes (HMAC) of the address and browser. Three or more valid ballots from one address are **grouped for the organizer**, flagged rather than refused because a venue shares an address, and can be **voided with a reason** before publication. Every void is audited and in the `votes` CSV | `ballotClusters`, `voidBallot` |
| **A bandwagon** | Steer late voters with an early lead | The tally is hidden from everyone but organizers, in the backend and the API, until voting has closed and an organizer publishes it | `visibleTally`; *the tally is hidden* |
| **Position bias** | Win by being first on the list | Each voter's ballot is shuffled with a seed derived from an HMAC of the event and the voter: stable for them, different for everyone else. Over 4,000 simulated ballots each of 8 projects leads about equally often | `ballotChoices`, `shuffle`; *every voter sees their own order* |
| **A judge gaming compare mode** | Push a favourite through many pairwise choices | A judge compares only their own assigned projects, each pair once (a unique index), and choices are final and audited. The pairwise ranking is a second opinion shown beside the rubric ranking and never changes it | `compare.ts`; *compare mode* tests |
| **A comment troll** | Spam, abuse or script injection in comments | Signed-in accounts only, 10 comments per 10 minutes per account, escaped everywhere. Organizers hide with a written reason; the comment stays on record, marked, and the take-down is audited. Only the author or an organizer can take a comment down, and other attempts are audited | `comments.ts`; *comments* tests |
| **Someone signing up as an invited judge** | Take over a judge's seat by registering their email first | Sign-up refuses any email that already exists, including invited and imported people who have not set a password. They can only claim the account with their one-time link | `signUp`; `security.test.ts` |
| **A credential stuffer** | Guess passwords | scrypt hashing, and 10 attempts per IP and email per 10 minutes (then 429). A failed sign-in for an unknown email takes as long as one for a known email | `signIn`, `http/rate-limit.ts` |
| **A cross-site page** | Make a signed-in organizer's browser publish results or change settings | `SameSite=Lax` cookies, an `Origin` check, and an HMAC token on every form. JSON is accepted only as `application/json`, which needs a CORS preflight that is never granted | `Ctx.verifyCsrf`; `security.test.ts` |
| **An injected script** | Run JavaScript in an organizer's browser via a project title or a comment | HTML is escaped by default, and a strict CSP allows no inline script or style | `views/html.ts`; *user text is escaped wherever it is shown* |
| **A malicious spreadsheet cell** | Run a formula when an organizer opens the CSV | Cells beginning with `= + - @`, a tab or a CR are prefixed with `'` | `util/csv.ts` |
| **A session thief** | Replay a stolen cookie or a copied database | Cookies are `HttpOnly` (and `Secure` behind HTTPS). The database holds only token *hashes*, so a copy of it grants no sessions. Sign-out deletes the session, and a password change ends every other session | `sessions.ts` |
| **A link leaker** | Reuse a forwarded invite or reset link | Links are hashed at rest and expire. Password and judge links work once. A team invite dies when the captain creates a new one | `accounts.ts`, `teams.ts`, `judging.ts` |
| **A resource exhauster** | Tie up the server | A 1 MB body limit, request and header timeouts, and bounded list sizes. Nothing the server does reaches out to the network, so there is no SSRF surface | `http/context.ts`, `server.ts` |

## Demo mode, stated as a risk

`FORGEBOARD_DEMO=1` creates five accounts with a password published in the README, and four
fixed session tokens published in `.dogfood.toml`, so the acceptance checker and evaluators can
act as each role. On a real event that is a master key. It is off unless enabled, the banner on
every page says when it is on, the boot log warns in capitals, and the README's production
steps start with turning it off.

## What this does not defend against

- **An administrator with shell access to the server, before results leave it.** They can edit
  the SQLite file and recompute every later audit hash, since the chain has no secret in it, and
  they hold the signing key, which lives in the database. The chain and the signature make a
  rewrite *detectable once something has left the server*: a downloaded capsule, a saved
  `results.json`, an off-host backup. They cannot stop a dishonest operator from publishing a
  dishonest result in the first place.
- **Cutting off the newest audit entries.** A truncated tail still verifies. Each published
  document anchors the chain's head at that moment, so anything before the last publication is
  covered; entries after it are not until the next one.
- **Judges colluding outside the system**, or a judge scoring dishonestly within their own
  assignments. Forgeboard makes both visible, but it cannot make them impossible.
- **Distributed guessing from many IPs.** The rate limit is per IP and email, in memory, and
  resets on restart. A reverse proxy's limits are the next layer.
- **Sybil accounts in accounts-mode voting.** Sign-up is open, so one person can make several
  accounts and cast several ballots. Address clusters make it visible and an organizer can void
  ballots, but a determined voter on several networks gets through. Voter codes are the remedy:
  a code is a physical token, one per attendee.
- **Handed-on codes.** A code given to someone else is a ballot given to someone else. Nothing
  in software tells the two apart.
- **Coordinated honest-looking votes** (a team asking friends to vote). That is campaigning, not
  fraud; approval voting with a budget limits what any bloc can do per ballot, and the tally is
  published only after an organizer has looked at it.
