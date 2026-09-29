import { currentActor } from "../../../../lib/auth/session.ts";
import { capabilityFor } from "../../../../lib/authz.ts";
import { all, get } from "../../../../lib/db/client.ts";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/**
 * GET /api/judge/scores[?judge=<user id>][&event=<slug>]
 *
 * A judge reads their own scores. Another judge's scores need the organizer role in an event
 * where that person judges (or instance admin). The decision is made from the caller's own roles
 * before the target is looked up, so a refusal says nothing about whether the other judge exists.
 */
export async function GET(req: Request) {
  const actor = await currentActor();
  if (!actor) return json({ error: "Sign in first.", status: 401 }, 401);
  const url = new URL(req.url);
  const target = url.searchParams.get("judge")?.trim() || actor.id;
  const onlyEvent = url.searchParams.get("event");
  const eventIds = all<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM events`)
    .filter((e) => !onlyEvent || e.slug === onlyEvent || e.id === onlyEvent);

  let allowed: typeof eventIds;
  if (target === actor.id) {
    allowed = eventIds.filter((e) => capabilityFor(actor, e.id).isJudge);
    if (!allowed.length) return json({ error: "Only judges have scores to read.", status: 403 }, 403);
  } else {
    const oversee = eventIds.filter((e) => { const c = capabilityFor(actor, e.id); return c.isOrganizer || c.isAdmin; });
    if (!oversee.length) return json({ error: "You can read only your own scores. Another judge's scores are visible to organizers only.", status: 403 }, 403);
    allowed = oversee.filter((e) => get(`SELECT 1 AS x FROM event_roles WHERE event_id = ? AND user_id = ? AND role = 'judge'`, e.id, target));
    if (!allowed.length) return json({ error: "That person does not judge any event you organize.", status: 403 }, 403);
  }

  const judge = get<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id = ?`, target);
  const scores = allowed.flatMap((e) =>
    all<{ assignment_id: string; project_id: string; project_title: string; status: string | null; comment: string | null; weighted: number | null; submitted_at: string | null; review_id: string | null }>(
      `SELECT a.id AS assignment_id, p.id AS project_id, p.name AS project_title, r.status, r.overall_comment AS comment,
              r.raw_weighted AS weighted, r.submitted_at, r.id AS review_id
         FROM assignments a JOIN projects p ON p.id = a.project_id LEFT JOIN reviews r ON r.assignment_id = a.id
        WHERE a.event_id = ? AND a.judge_user_id = ? AND a.revoked_at IS NULL ORDER BY p.id`,
      e.id, target,
    ).map((row) => ({
      event: e.slug,
      assignment_id: row.assignment_id,
      project_id: row.project_id,
      project_title: row.project_title,
      status: row.status ?? "not_started",
      criteria: Object.fromEntries(
        row.review_id
          ? all<{ name: string; score: number }>(`SELECT c.name, s.score FROM criterion_scores s JOIN criteria c ON c.id = s.criterion_id WHERE s.review_id = ? ORDER BY c.sort_order`, row.review_id).map((s) => [s.name.toLowerCase(), s.score])
          : [],
      ),
      weighted: row.weighted,
      comment: row.comment ?? "",
      submitted_at: row.submitted_at,
    })),
  );
  return json({ judge: { id: judge?.id ?? target, name: judge?.display_name ?? "" }, events: allowed.map((e) => ({ slug: e.slug, name: e.name })), scores });
}
