# Five-minute demo

A walkthrough of this exact build against the seeded demo event. Every mutation
below really happens; the only thing prepared in advance is the seed data, which
the script says out loud.

**Before you start**

```bash
docker compose down -v && docker compose up -d
```

Wait for the healthcheck (about two seconds), then open
<http://localhost:3000>. Every demo account uses the password
`forgeboard2026`. Have two browser profiles ready — an organizer in one, a judge
in the other — so isolation can be shown rather than asserted.

---

## 0:00 – 0:30 · What this is, and that it is running

- The landing page. Forgeboard, **from first commit to final verdict**.
- Scroll to *Live event progress*: those numbers are read from this instance's
  database on render. Say so — they are not decoration.
- Show the terminal: one command, no database container, no cloud account.
  Cold start to healthy in about a second and a half.

## 0:30 – 1:15 · An organizer sets an event up

Sign in as `organizer@forgeboard.local`.

- **Dashboard** — what is waiting on them, then review progress, then the event.
- **Organizer console → Setup.** The checklist is computed from stored data, not
  a stored progress field. Add a prize, and add a question of the *Choose one*
  kind with two options — it appears on the submission form immediately.
- Try a backwards window: set submissions to close before they open, save, and
  read the refusal. Note the form still holds everything else you typed.

## 1:15 – 2:00 · A team submits

Sign in as `participant@forgeboard.local` (or register a new account).

- **Submission.** Clear the description and press *Submit project*: the server
  refuses and says which field is missing, and every other field is still there.
- Put the description back, choose a track, answer the new question, submit.
- Note *Saved at …* and the deadline with its countdown, in the reader's own
  timezone.
- Open the **gallery** in a signed-out window: the project is there. Drafts and
  private answers are not.

## 2:00 – 3:00 · A judge reviews, and cannot see anyone else's work

Sign in as `judge@forgeboard.local` in the second profile.

- **Review queue** — only their assignments; the rail filters by not started, in
  progress and submitted.
- Open a project. Score it with the keyboard: the running weighted total updates
  as scores go in. Save a draft, reload, and show the draft came back.
- Now the part that matters: copy another judge's assignment URL from the
  organizer's audit trail and open it as this judge. **404** — and in the
  organizer console's **Audit** tab, that refusal is on the record with the
  actor and the reason.

## 3:00 – 4:00 · The organizer inspects the scoring

Back to the organizer.

- **Panel** — create a judge invitation scoped to one track. The link is shown
  once; explain that the scope lives on the invitation, so accepting it cannot
  widen the grant.
- **Assignments** — press *Preview*. Workload per judge, coverage per project,
  and the projects that cannot be filled with the reason. Nothing has been
  written yet; *Create* commits it.
- **Results** — raw against normalized, rank movement, the constant judge
  excluded by name, the judge with too few reviews excluded by name, and
  projects marked *insufficient comparable reviews* rather than given a
  confident rank. Point at `JUDGING.md` for the method and its limits.
- **Projects** — disqualify one entry with a reason. It leaves the gallery, the
  assignment pool and the results; the submission itself is untouched and the
  decision is on the record. Reinstate it.

## 4:00 – 4:40 · Publish, and own your data

- **Results → Publish**, with the confirmation that says what becomes public.
- Open `/events/autumn-build-2026/results` signed out: the published snapshot,
  no private ballots.
- **Exports** — take the reviews CSV, and the whole-event JSON bundle. Mention
  that a formula-looking cell is neutralised on export and the stored value is
  untouched.
- Optional, if the room is technical: `/verify`, and an Ed25519-signed judge
  participation record checked without an account.

## 4:40 – 5:00 · What is done, and what is not

Say plainly:

- T1, T2 and T3 are complete, with the one documented T3 gap: email-gated voting
  issues a real one-use token, but there is no mail server, so the operator
  delivers it.
- T4 is complete: REST API, webhooks, certificates, verifiable judge records, the
  embeddable gallery and bulk import and export. `tests/t4-live.sh` checks them live, 10 of 10.
- **The official checker passes 7 of 7** (`python3 run.py .dogfood.toml`).
  131 of our own tests pass, the full lifecycle was driven in a real browser,
  and `TESTING.md` says exactly what that does and does not prove.

---

## If something goes wrong on camera

- **Nobody can sign in.** `docker compose exec forgeboard node scripts/reset-password.ts admin@forgeboard.local`
  prints a one-use recovery link.
- **The data looks wrong.** `docker compose down -v && docker compose up -d`
  gives a fresh seeded instance in seconds.
- **A port is taken.** Change the published port in `docker-compose.yml`; nothing
  in the application assumes 3000.
