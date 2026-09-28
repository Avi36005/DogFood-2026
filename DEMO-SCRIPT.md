# Demo script: one event, create to publish, in five minutes

For the DOGFOOD demo video. Start from a clean volume so the timestamps are fresh:

```sh
docker compose down -v && docker compose up
```

Keep the terminal visible for the first 20 seconds: the boot log shows the fixture import and
the demo sign-ins. All passwords are `forgeboard-demo`. Use one browser window per person
(private windows work), or sign out and back in.

| Time | Who | Do | Say |
|---|---|---|---|
| 0:00 | terminal | `docker compose up` | "One command, no network needed. It imports the shared fixtures and prints four test sign-ins." |
| 0:20 | visitor | Open http://localhost:8080, then **Browse projects** | "Public gallery, server-rendered: all 40 fixture projects, with search and filters in the URL." |
| 0:35 | admin `admin@forgeboard.local` | **Events → Create an event**. Name "Demo Night", deadline **10 minutes from now** (UTC), tracks `Tools` and `Games`, 2 reviews per project | "Admins create events. Dates, tracks, team size, a review target." |
| 1:00 | admin | **Event** tab: add a prize "Best tool" for Tools. **Rubric** tab: set Functionality's weight to 2 | "The organizer weights the rubric. Every change is audited." |
| 1:20 | new person | **Create account** as `alice@example.com`, then on Demo Night choose **Join or start a team**, create "Alpha" and copy the invite link | "Teams form by invite link. Only a hash of the link is stored." |
| 1:40 | second person | Open the invite link, create an account, **Join Alpha** | |
| 1:55 | alice | **Start the project**, fill title, summary, track Tools and a repo URL, then **Save draft** | "Drafts are private." Show that a signed-out visitor gets 404 on its URL. |
| 2:10 | alice | **Edit**, then **Submit project** | "Now it is public, and editable until the deadline." |
| 2:25 | admin | **Judges** tab: invite "Jude", `jude@example.com`, covering Tools. Copy the link | "No mail server, so the organizer hands over a one-time link." |
| 2:40 | Jude | Open the link, choose a password: the queue opens | |
| 2:50 | admin | **Overview → Close submissions now**. Then, as alice, open the project's `/edit` URL directly: refused | "The Edit button is gone, and typing the URL doesn't help: the server refuses it, for pages and the API alike." |
| 3:05 | admin | **Assignments → Fill gaps automatically** | "Track-aware, conflict-free, balanced. It says what it could not fill." |
| 3:20 | Jude | Score the project 4, 5, 3, add a comment, **Submit review** | "Radio groups, keyboard-friendly, weights shown." |
| 3:40 | terminal | `curl -H 'Cookie: session=jdg_b_demo_44de83a1c9f06b72' 'localhost:8080/api/judge/scores?judge=jdg_24'` | "On the fixture event, judge B asks for judge A's scores: 403 from the backend." |
| 3:50 | organizer `organizer@forgeboard.local` | Sample Hack 2026 → **Audit trail**, show *Refused access attempts* | "The organizer sees who tried, and what." |
| 4:05 | organizer | Sample Hack 2026 → **Results** | "On the fixture: raw means beside normalized scores, rank moves, judge offsets. `jdg_07`'s 4/4/4 is flagged 'identical scores'." |
| 4:25 | admin | Demo Night → **Results → Publish results** | "Publishing freezes the method, λ and weights into a snapshot and closes judging." |
| 4:40 | visitor, then admin | Demo Night → **Results**. Then, as admin, the **Export** tab | "Results are public now. Organizers can export every stage to CSV." |
| 4:50 | terminal | `python3 run.py .dogfood.toml` | "And the official checker: T1 and T2 verified." |

If time is short, cut the prize and the second teammate. Never cut the 403, the deadline
refusal or the publish.
