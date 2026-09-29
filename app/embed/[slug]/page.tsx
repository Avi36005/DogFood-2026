import { notFound } from "next/navigation";
import * as events from "../../../lib/domain/events.ts";
import * as projects from "../../../lib/domain/projects.ts";
import "../../globals.css";

export const dynamic = "force-dynamic";

/**
 * Read-only embeddable gallery.
 *
 * Reuses the same gallery query as the public page, so it can only ever show
 * submitted projects from a non-draft event. No scores, no drafts, no vote
 * totals, no private answers. Links open in a new tab because the page is
 * inside somebody else's frame.
 */
export default async function Embed({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ limit?: string; track?: string }>;
}) {
  const { slug } = await params;
  const { limit, track } = await searchParams;
  const event = events.bySlug(slug);
  if (!event || event.status === "draft") notFound();

  const n = Math.min(Math.max(Number(limit) || 12, 1), 48);
  const items = projects.gallery(event.id, { trackId: track, limit: n });
  const origin = process.env.FORGEBOARD_PUBLIC_ORIGIN ?? "";

  return (
    <div className="bg-background p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">{event.name}</p>
        <a
          href={`${origin}/events/${slug}/gallery`}
          target="_blank" rel="noopener noreferrer"
          className="text-[12px] text-primary hover:underline"
        >
          View all
        </a>
      </div>

      {items.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-soft">No submitted projects yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <li key={p.id} className="rounded-[10px] border border-border bg-card">
              <a
                href={`${origin}/events/${slug}/projects/${p.id}`}
                target="_blank" rel="noopener noreferrer"
                className="block p-4 hover:border-border"
              >
                {p.thumbnail_asset_id ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={`${origin}/api/media/${p.thumbnail_asset_id}`} alt="" className="mb-3 h-24 w-full rounded-[6px] object-cover" />
                ) : null}
                <p className="text-[14px] font-medium text-foreground">{p.name}</p>
                <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">{p.tagline}</p>
                {p.track_name ? <p className="mt-2 font-mono text-[11px] text-muted-soft">{p.track_name}</p> : null}
              </a>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-right font-mono text-[10px] text-muted-soft">Powered by Forgeboard</p>
    </div>
  );
}
