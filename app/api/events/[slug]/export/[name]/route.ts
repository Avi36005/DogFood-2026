import { currentActor } from "../../../../../../lib/auth/session.ts";
import { capabilityFor, AccessDenied } from "../../../../../../lib/authz.ts";
import * as events from "../../../../../../lib/domain/events.ts";
import { exportCsv, EXPORTS, type ExportName } from "../../../../../../lib/domain/exports.ts";
import * as audit from "../../../../../../lib/domain/audit.ts";

export const dynamic = "force-dynamic";

/**
 * CSV export. Authorization runs through the same capability check the pages
 * use, so a direct curl is refused exactly as the interface would be.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; name: string }> }) {
  const { slug, name } = await params;
  if (!EXPORTS.some((e) => e.name === name)) {
    return new Response("Unknown export", { status: 404 });
  }
  const event = events.bySlug(slug);
  if (!event) return new Response("Event not found", { status: 404 });

  const actor = await currentActor();
  const cap = capabilityFor(actor, event.id);
  try {
    audit.adminAccess(cap, `export:${name}`);
    const csv = exportCsv(cap, name as ExportName);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}-${name}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AccessDenied) {
      return new Response("Organizer role required for this event.", { status: 403 });
    }
    throw err;
  }
}
