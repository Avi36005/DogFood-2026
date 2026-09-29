import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Search } from "lucide-react";
import { Empty, Panel, Tag } from "@/components/app/ui";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as projects from "@/lib/domain/projects.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const dynamic = "force-dynamic";

export const generateMetadata = eventPageTitle("Gallery");

export default async function Gallery({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; track?: string; tag?: string }>;
}) {
  const { slug } = await params;
  const { q, track, tag } = await searchParams;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const cap = capabilityFor(await currentActor(), event.id);
  if (event.status === "draft" && !cap.isOrganizer) notFound();

  const tracks = events.tracks(event.id);
  const tags = projects.allTags(event.id);
  const total = projects.galleryCount(event.id);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <Link href={`/events/${slug}`} className="text-[13px] text-muted-foreground hover:text-foreground">&larr; {event.name}</Link>
        <h1 className="mt-3 text-[32px]">Project gallery</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          {total} submitted {total === 1 ? "project" : "projects"}. Drafts and withdrawn entries are never listed here.
        </p>

        {/* A plain GET form: search and filters survive a reload and are linkable. */}
        <form className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]" method="get">
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-soft" aria-hidden />
            <input
              name="q" defaultValue={q ?? ""} placeholder="Search names, taglines, descriptions and tags"
              aria-label="Search projects"
              className="min-h-[44px] w-full rounded-[10px] border border-control-border bg-background py-2.5 pl-10 pr-3 text-[14px] text-foreground placeholder:text-muted-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
          <select
            name="track" defaultValue={track ?? ""} aria-label="Filter by track"
            className="min-h-[44px] rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground focus:border-primary focus:outline-none"
          >
            <option value="">All tracks</option>
            {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="submit" className="min-h-[44px] rounded-[10px] bg-primary px-5 text-[14px] font-medium text-primary-foreground hover:bg-primary/80 hover:text-foreground">
            Filter
          </button>
        </form>

        {tags.length ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-soft">Tags:</span>
            {tags.slice(0, 14).map((t) => (
              <Link
                key={t.tag}
                href={`/events/${slug}/gallery?tag=${encodeURIComponent(t.tag)}`}
                className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  tag === t.tag ? "border-primary text-primary" : "border-border text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {t.tag} <span className="text-muted-soft">{t.n}</span>
              </Link>
            ))}
            {tag || q || track ? (
              <Link href={`/events/${slug}/gallery`} className="text-[12px] text-primary hover:underline">clear</Link>
            ) : null}
          </div>
        ) : null}

        {/*
          The results stream inside their own boundary, so a slow query shows a
          skeleton instead of a blank page. It is deliberately not a route-level
          loading file: that would flush the shell before this page decides
          whether the event exists, and a missing event would answer 200.
        */}
        <div className="mt-8">
          <Suspense key={`${q ?? ""}|${track ?? ""}|${tag ?? ""}`} fallback={<GallerySkeleton />}>
            <Results slug={slug} eventId={event.id} q={q} track={track} tag={tag} total={total} />
          </Suspense>
        </div>
      </main>
    </>
  );
}

async function Results({ slug, eventId, q, track, tag, total }: {
  slug: string; eventId: string; q?: string; track?: string; tag?: string; total: number;
}) {
  const items = projects.gallery(eventId, { q, trackId: track, tag, limit: 120 });

  if (items.length === 0) {
    return (
      <Panel>
        {total === 0
          ? <Empty title="No projects yet" body="Submitted projects appear here as teams finish them." />
          : <Empty title="Nothing matches that" body="Try a broader search, or clear the filters." />}
      </Panel>
    );
  }

  return (
    <>
      <p className="sr-only" aria-live="polite">{items.length} of {total} projects shown.</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((p) => (
          <Panel key={p.id} className="flex flex-col transition-colors hover:border-border">
            <Link href={`/events/${slug}/projects/${p.id}`} className="flex flex-1 flex-col">
              {p.thumbnail_asset_id ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`/api/media/${p.thumbnail_asset_id}`}
                  alt=""
                  className="h-40 w-full rounded-t-[12px] border-b border-border object-cover"
                />
              ) : null}
              <div className="flex flex-1 flex-col p-5">
                <h2 className="text-[16px] font-semibold text-foreground">{p.name}</h2>
                <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-muted-foreground">{p.tagline}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {p.track_name ? <Tag>{p.track_name}</Tag> : null}
                  {p.tags ? p.tags.split(",").slice(0, 3).map((t) => <Tag key={t}>{t}</Tag>) : null}
                </div>
                <p className="mt-3 text-[12px] text-muted-soft">{p.team_name}</p>
              </div>
            </Link>
          </Panel>
        ))}
      </div>
    </>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
      <span className="sr-only">Loading projects…</span>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="fb-pulse h-56 rounded-2xl border border-border bg-card"
          style={{ animationDelay: `${i * 70}ms` }}
        />
      ))}
    </div>
  );
}
