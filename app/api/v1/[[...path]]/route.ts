import { currentActor, type Actor } from "../../../../lib/auth/session.ts";
import { capabilityFor, AccessDenied } from "../../../../lib/authz.ts";
import * as keys from "../../../../lib/api/keys.ts";
import * as accounts from "../../../../lib/domain/accounts.ts";
import * as events from "../../../../lib/domain/events.ts";
import * as projects from "../../../../lib/domain/projects.ts";
import * as judging from "../../../../lib/domain/judging.ts";
import * as results from "../../../../lib/domain/results.ts";
import * as portability from "../../../../lib/domain/portability.ts";
import * as audit from "../../../../lib/domain/audit.ts";

export const dynamic = "force-dynamic";

/**
 * REST API v1.
 *
 * Every handler goes through the same `capabilityFor` + domain services the
 * pages use. There is no integration bypass: an API key grants exactly what its
 * owner could do in the interface, and no more.
 *
 * Authentication: `Authorization: Bearer fbk_…`, or an ordinary session cookie.
 */
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}
const problem = (status: number, title: string, detail?: string) =>
  json({ error: { status, title, detail } }, status);

async function authenticate(req: Request): Promise<{ actor: Actor | null; scopes: string[]; viaCookie: boolean }> {
  const viaKey = keys.resolve(req.headers.get("authorization"));
  if (viaKey) {
    const user = accounts.byId(viaKey.userId);
    return { actor: user ? accounts.toActor(user) : null, scopes: viaKey.scopes, viaCookie: false };
  }
  const actor = await currentActor();
  return { actor, scopes: ["read", "write"], viaCookie: !!actor };
}

/**
 * CSRF guard for writes authenticated by the session cookie. SameSite=Lax does
 * not help here: every port on localhost is the same "site", so a page on
 * localhost:8080 could otherwise POST here with the visitor's cookie. The
 * browser always sends Origin on a cross-origin POST, and it must match.
 * API-key requests carry no ambient credential, so they are not affected.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try { return new URL(origin).host === host; } catch { return false; }
}

function page(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  return { limit, offset, url };
}

export async function GET(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const { actor, scopes } = await authenticate(req);
  const { limit, offset, url } = page(req);

  try {
    // GET /api/v1
    if (path.length === 0) {
      return json({
        name: "Forgeboard API", version: "1.0.0",
        openapi: "/api/v1/openapi.json",
        authenticated_as: actor ? { id: actor.id, name: actor.displayName } : null,
        scopes,
      });
    }

    // GET /api/v1/events
    if (path[0] === "events" && path.length === 1) {
      const list = actor ? events.listForActor(actor) : events.listPublic();
      return json({
        data: list.slice(offset, offset + limit).map(publicEvent),
        pagination: { total: list.length, limit, offset },
      });
    }

    if (path[0] === "events" && path.length >= 2) {
      const event = events.bySlug(path[1]);
      if (!event) return problem(404, "Event not found");
      const cap = capabilityFor(actor, event.id);
      if (event.status === "draft" && !cap.isOrganizer) return problem(404, "Event not found");
      const sub = path[2];

      if (!sub) {
        return json({
          data: {
            ...publicEvent(event),
            tracks: events.tracks(event.id).map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
            prizes: events.prizes(event.id).map((p) => ({ id: p.id, name: p.name, amount: p.amount_text })),
          },
        });
      }

      if (sub === "projects") {
        const items = projects.gallery(event.id, {
          q: url.searchParams.get("q") ?? undefined,
          trackId: url.searchParams.get("track") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          limit, offset,
        });
        return json({
          data: items.map(publicProject),
          pagination: { total: projects.galleryCount(event.id), limit, offset },
        });
      }

      // Organizer-only from here. The domain functions enforce it; these are
      // not separate rules, they are the same ones.
      audit.adminAccess(cap, `api:${sub}`);
      // The organizer console polls this one. It is counts only: no project
      // names, no judge identities, no scores.
      if (sub === "progress")    return json({ data: judging.progressCounts(cap) });
      if (sub === "judges")      return json({ data: judging.judgeProgress(cap) });
      if (sub === "assignments") return json({ data: judging.coverageGaps(cap) });
      if (sub === "reviews")     return json({ data: judging.allSubmittedReviews(cap) });
      if (sub === "results") {
        const snap = results.latestSnapshot(event.id, "published");
        if (!snap) {
          if (!cap.isOrganizer) return problem(404, "No published results");
          const latest = results.latestSnapshot(event.id);
          if (!latest) return problem(404, "No snapshot computed");
          return json({ data: { snapshot: latest, rows: results.rows(latest.id) } });
        }
        return json({ data: { snapshot: snap, rows: results.rows(snap.id) } });
      }
      if (sub === "export")      return json({ data: portability.exportBundle(cap) });
      return problem(404, "Unknown collection", `No such sub-resource: ${sub}`);
    }

    return problem(404, "Unknown route");
  } catch (err) {
    if (err instanceof AccessDenied) return problem(403, "Forbidden", err.reason);
    return problem(500, "Internal error", err instanceof Error ? err.message : undefined);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const { actor, scopes, viaCookie } = await authenticate(req);
  if (!actor) return problem(401, "Authentication required");
  if (viaCookie && !sameOrigin(req)) {
    return problem(403, "Cross-origin request refused", "Send an API key, or call this from the same origin.");
  }
  if (!scopes.includes("write")) return problem(403, "Forbidden", "This key is read-only.");

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return problem(400, "Invalid JSON body"); }

  try {
    // POST /api/v1/events
    if (path[0] === "events" && path.length === 1) {
      if (typeof body.name !== "string" || body.name.trim().length < 2) {
        return problem(422, "Validation failed", "`name` is required and must be at least 2 characters.");
      }
      const event = events.createEvent(actor, {
        name: body.name, tagline: String(body.tagline ?? ""), description: String(body.description ?? ""),
      });
      return json({ data: publicEvent(event) }, 201);
    }

    if (path[0] === "events" && path.length >= 3) {
      const event = events.bySlug(path[1]);
      if (!event) return problem(404, "Event not found");
      const cap = capabilityFor(actor, event.id);

      if (path[2] === "tracks")      return json({ data: events.addTrack(cap, String(body.name ?? "")) }, 201);
      if (path[2] === "status")      return json({ data: publicEvent(events.setStatus(cap, String(body.status) as never)) });
      if (path[2] === "assignments") return json({ data: judging.generateAssignments(cap, { reviewsPerProject: Number(body.reviews_per_project) || undefined }) }, 201);
      if (path[2] === "results")     return json({ data: results.computeSnapshot(cap) }, 201);
      if (path[2] === "publish") {
        const snap = results.latestSnapshot(event.id);
        if (!snap) return problem(409, "Nothing to publish", "Compute a snapshot first.");
        return json({ data: results.publish(cap, snap.id) });
      }
      if (path[2] === "import") {
        const report = portability.importBundle(actor, body.bundle, { dryRun: body.dry_run === true });
        return json({ data: report }, report.ok ? 200 : 422);
      }
      return problem(404, "Unknown action", `No such action: ${path[2]}`);
    }
    return problem(404, "Unknown route");
  } catch (err) {
    if (err instanceof AccessDenied) return problem(403, "Forbidden", err.reason);
    return problem(422, "Request failed", err instanceof Error ? err.message : undefined);
  }
}

function publicEvent(e: ReturnType<typeof events.bySlug> & object) {
  return {
    id: e.id, slug: e.slug, name: e.name, tagline: e.tagline, status: e.status,
    timezone: e.timezone,
    submissions_open_at: e.submissions_open_at, submissions_close_at: e.submissions_close_at,
    judging_open_at: e.judging_open_at, judging_close_at: e.judging_close_at,
    results_published_at: e.results_published_at,
  };
}

function publicProject(p: { id: string; name: string; tagline: string; track_name: string | null; team_name: string; tags: string; submitted_at: string | null; repo_url: string; live_url: string; demo_video_url: string }) {
  return {
    id: p.id, name: p.name, tagline: p.tagline, track: p.track_name, team: p.team_name,
    tags: p.tags ? p.tags.split(",") : [],
    submitted_at: p.submitted_at,
    links: { repository: p.repo_url || null, live: p.live_url || null, demo_video: p.demo_video_url || null },
  };
}
