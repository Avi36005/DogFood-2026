import Link from "next/link";
import { notFound } from "next/navigation";
import { Cell, Empty, Panel, PanelHeader, Row, Select, Status, Table, When } from "@/components/app/ui";
import { ExportLinks } from "@/components/app/exports";
import { EligibilityControl } from "@/components/app/organizer";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as projects from "@/lib/domain/projects.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Projects");

export const dynamic = "force-dynamic";

type Search = { q?: string; track?: string; status?: string; eligibility?: string };

export default async function OrganizerProjects({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const { slug } = await params;
  const filters = await searchParams;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const tracks = events.tracks(event.id);
  const all = projects.listForOrganizer(cap);
  const q = (filters.q ?? "").trim().toLowerCase();

  // Filters are in the URL, so a filtered view can be handed to a colleague.
  const rows = all.filter((p) => {
    if (filters.track && p.track_id !== filters.track) return false;
    if (filters.status && p.status !== filters.status) return false;
    if (filters.eligibility === "disqualified" && !p.disqualified_at) return false;
    if (filters.eligibility === "eligible" && p.disqualified_at) return false;
    if (q && !(`${p.name} ${p.tagline} ${p.team_name}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const active = [filters.q, filters.track, filters.status, filters.eligibility].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title="All projects"
          sub={`${all.length} in this event, including drafts and withdrawn entries.`}
        />

        <form method="get" className="grid grid-cols-1 gap-3 border-b border-border px-5 py-4 sm:grid-cols-[1fr_auto_auto_auto_auto]">
          <input
            name="q" defaultValue={filters.q ?? ""} placeholder="Search name, tagline or team"
            aria-label="Search projects"
            className="min-h-[44px] rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-soft"
          />
          <Select name="track" defaultValue={filters.track ?? ""} aria-label="Track" className="sm:w-44">
            <option value="">Every track</option>
            {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select name="status" defaultValue={filters.status ?? ""} aria-label="Status" className="sm:w-40">
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="withdrawn">Withdrawn</option>
          </Select>
          <Select name="eligibility" defaultValue={filters.eligibility ?? ""} aria-label="Eligibility" className="sm:w-44">
            <option value="">Any eligibility</option>
            <option value="eligible">Eligible</option>
            <option value="disqualified">Disqualified</option>
          </Select>
          <div className="flex items-center gap-3">
            <button type="submit" className="min-h-[44px] rounded-full bg-foreground px-5 text-sm font-medium text-background hover:bg-foreground/85">
              Filter
            </button>
            {active ? (
              <Link href={`/events/${slug}/organize/projects`} className="text-[13px] text-muted-foreground hover:text-foreground">
                Clear {active} filter{active > 1 ? "s" : ""}
              </Link>
            ) : null}
          </div>
        </form>

        {rows.length === 0 ? (
          <div className="px-5 py-8">
            <Empty
              title={all.length === 0 ? "No projects yet" : "Nothing matches those filters"}
              body={all.length === 0
                ? "Projects appear here as soon as a team starts a draft."
                : "Try a broader search, or clear the filters."}
            />
          </div>
        ) : (
          <Table
            head={["Project", "Team", "Track", "Status", "Reviews", "Submitted", "Eligibility"]}
            caption="Every project in this event, with its review coverage and eligibility"
          >
            {rows.map((p) => (
              <Row key={p.id}>
                <Cell>
                  <Link href={`/events/${slug}/projects/${p.id}`} className="font-medium text-foreground hover:text-primary">
                    {p.name || "Untitled"}
                  </Link>
                  <div className="text-[12px] text-muted-foreground">{p.tagline}</div>
                </Cell>
                <Cell className="text-muted-foreground">{p.team_name}</Cell>
                <Cell className="text-muted-foreground">{p.track_name ?? "—"}</Cell>
                <Cell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Status value={p.status} />
                    {p.disqualified_at ? <Status value="disqualified" /> : null}
                  </div>
                </Cell>
                <Cell className="font-mono tabular-nums text-muted-foreground">{p.reviewed}/{p.assigned}</Cell>
                <Cell><When iso={p.submitted_at} tz={event.timezone} /></Cell>
                <Cell>
                  <EligibilityControl
                    slug={slug}
                    projectId={p.id}
                    projectName={p.name || "this project"}
                    disqualified={!!p.disqualified_at}
                  />
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
      <ExportLinks slug={slug} only={["projects", "teams"]} />
    </div>
  );
}
