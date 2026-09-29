import { currentActor } from "../../../../../lib/auth/session.ts";
import { AccessDenied, capabilityFor } from "../../../../../lib/authz.ts";
import { get } from "../../../../../lib/db/client.ts";
import * as events from "../../../../../lib/domain/events.ts";
import * as projects from "../../../../../lib/domain/projects.ts";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/**
 * POST /api/events/<slug>/projects: start (or return) your team's project draft, the same step as
 * the Submit page. Refused for visitors (401), people without a team in the event (403), and
 * once the event's submission window has closed (409), checked on the server's clock.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const actor = await currentActor();
  if (!actor) return json({ error: "Sign in first.", status: 401 }, 401);
  const event = events.bySlug(slug);
  if (!event) return json({ error: "No such event.", status: 404 }, 404);
  const cap = capabilityFor(actor, event.id);
  if (!cap.isParticipant) return json({ error: "Only a participant in this event can submit.", status: 403 }, 403);
  if (!events.submissionsOpen(event)) {
    return json({ error: `Submissions for ${event.name} are closed (they closed at ${event.submissions_close_at ?? "the deadline"}).`, status: 409 }, 409);
  }
  const team = get<{ id: string }>(
    `SELECT t.id FROM teams t JOIN team_members m ON m.team_id = t.id WHERE t.event_id = ? AND m.user_id = ?`, event.id, actor.id);
  if (!team) return json({ error: "Join or start a team first.", status: 409 }, 409);
  try {
    const project = projects.ensureDraft(cap, actor, team.id);
    return json({ project: { id: project.id, status: project.status } }, 201);
  } catch (err) {
    if (err instanceof AccessDenied) return json({ error: err.reason, status: 403 }, 403);
    return json({ error: err instanceof Error ? err.message : "Could not start the project.", status: 422 }, 422);
  }
}
