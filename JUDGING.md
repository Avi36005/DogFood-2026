# Judging

How Forgeboard assigns judges, turns scores into a ranking, corrects for harsh and generous
judges, and handles the awkward cases in the DOGFOOD fixtures. Every number on this page comes
from the code in this repository run on the official `fixtures.json`. The tests named in
brackets reproduce them.

```
judges invited ─► tracks granted ─► projects assigned ─► reviews scored ─► weighted score per review
      ─► judge offsets fitted ─► ranking previewed ─► snapshot published (frozen, reproducible)
```

---

## 1. Who judges what: assignment

Organizers invite judges by email and choose the tracks each judge covers. There is no mail
server, so the invite is a one-time link the organizer passes on (§7 of the README). A judge
covering no tracks covers all of them.

**Auto-assignment** (`src/domain/assignment.ts`) fills every project up to the event's target
(`reviews_per_project`, 3 by default) with these rules, in priority order:

1. **Track coverage.** A judge only gets projects in tracks they cover.
2. **Conflict of interest.** A judge never gets a project from a team they are on. The schema
   also refuses the stronger case: nobody can hold the judge role in an event where they are
   on a team, and an organizer cannot also judge (organizers read every score).
3. **No repeats.** A unique index on `(project, judge)` makes a double assignment impossible,
   so a judge can never be counted twice for one project.
4. **Least-covered first, one slot per round.** Projects with the fewest judges are served
   first, one slot each per pass. A shortage is spread across projects instead of starving
   the ones at the end of the list.
5. **Least-loaded judge wins.** Ties are broken by a hash of (event, project, judge): the
   result is deterministic, but `jdg_01` does not absorb every tie the way alphabetical order would.

It keeps existing assignments, so running it twice adds nothing. Anything it cannot fill is
reported with the reason, for example *"Beta Game: 1 of 2, only 1 judge(s) cover this track"*.
Organizers can also assign and unassign by hand. An assignment with a submitted review cannot
be removed: submitted reviews are evidence.

**On the fixture.** The file lists scores, not assignments, so each of the 126 scores is
imported as an assignment with a submitted review. Coverage is uneven, as the fixture intends:
8 current projects have 2 reviews, 26 have 3, 3 have 4 and 3 have 5. Running auto-assign
tops every project up to 3 within the judges' tracks, and those new slots appear in the judges'
queues. [`tests/http/organizer.test.ts`: *auto-assign tops the fixture up*]

## 2. The rubric and the weighted score

Each event has a rubric of criteria with relative weights and one score scale (1–5 by default).
A review's score is the weighted mean of its criterion scores:

