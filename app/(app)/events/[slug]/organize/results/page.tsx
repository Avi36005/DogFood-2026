import { notFound } from "next/navigation";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Cell, LinkButton, Notice, Panel, PanelHeader, Row, Status, Table, When } from "@/components/app/ui";
import { ComputeResults } from "@/components/app/organizer";
import { PublishResults } from "@/components/app/publish";
import { ExportLinks } from "@/components/app/exports";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as results from "@/lib/domain/results.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Results");

export const dynamic = "force-dynamic";

function Delta({ value }: { value: number | null }) {
  if (!value) return <span className="inline-flex items-center gap-1 text-muted-soft"><Minus size={11} />0</span>;
  const up = value > 0;
  return (
    <span className={`inline-flex items-center gap-1 ${up ? "text-success" : "text-warning"}`}>
      {up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(value)}
    </span>
  );
}

export default async function OrganizerResults({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug)!;
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const latest = results.latestSnapshot(event.id);
  const rows = latest ? results.rows(latest.id) : [];
  const report = results.normalizationReport(cap);

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title="Scoring"
          sub="Computing a snapshot changes nothing public. Publishing is a separate, deliberate step."
        />
        <div className="flex flex-wrap items-center gap-4 px-5 py-5">
          <ComputeResults slug={slug} />
          {latest ? (
            <>
              <PublishResults slug={slug} snapshotId={latest.id} published={latest.status === "published"} />
              <span className="text-[12px] text-muted-foreground">
                Last computed <When iso={latest.computed_at} /> · <Status value={latest.status} />
              </span>
            </>
          ) : null}
        </div>
      </Panel>

      {!report ? (
        <Notice tone="info">No submitted reviews yet, so there is nothing to score.</Notice>
      ) : (
        <>
          <Panel>
            <PanelHeader
              title="Judge calibration"
              sub={`${report.method} v${report.methodVersion} · panel mean ${report.globalMean.toFixed(2)}, spread ${report.globalSd.toFixed(2)} · bias is distance from the panel centre in panel standard deviations.`}
            />
            <Table head={["Judge", "Reviews", "Raw mean", "Spread", "Bias", "In standardization"]}>
              {[...report.judges].sort((a, b) => a.rawMean - b.rawMean).map((j) => (
                <Row key={j.judgeId}>
                  <Cell className="font-medium">{j.displayName}</Cell>
                  <Cell className="font-mono tabular-nums text-muted-foreground">{j.n}</Cell>
                  <Cell className="font-mono tabular-nums text-muted-foreground">{j.rawMean.toFixed(2)}</Cell>
                  <Cell className={`font-mono tabular-nums ${j.rawSd === 0 ? "text-warning" : "text-muted-foreground"}`}>
                    {j.rawSd.toFixed(2)}
                  </Cell>
                  <Cell className={`font-mono tabular-nums ${Math.abs(j.biasInSigma) > 0.75 ? "text-warning" : "text-muted-foreground"}`}>
                    {j.biasInSigma > 0 ? "+" : ""}{j.biasInSigma.toFixed(2)}
                  </Cell>
                  <Cell className={j.usable ? "text-success" : "text-warning"}>
                    {j.usable ? "included" : j.excludedBecause === "no_variation"
                      ? "excluded — no variation"
                      : "excluded — too few reviews"}
                  </Cell>
                </Row>
              ))}
            </Table>
          </Panel>

          {report.mode === "raw_fallback" ? (
            <Notice tone="warn">
              No judge could be standardized, so these are <strong>raw scores shown as a labelled
              fallback</strong>, not normalized results. Publishing this is a deliberate choice.
            </Notice>
          ) : null}

          {report.excludedJudges.length || report.insufficientProjects.length ? (
            <Panel>
              <PanelHeader title="Coverage warnings" sub="Carried onto the snapshot and shown here before you publish." />
              <ul className="divide-y divide-border/60 text-[13px]">
                {report.excludedJudges.map((e) => {
                  const name = report.judges.find((j) => j.judgeId === e.judgeId)?.displayName ?? e.judgeId;
                  return (
                    <li key={e.judgeId} className="px-5 py-3 text-muted-foreground">
                      <span className="text-warning">Excluded:</span> {name} —{" "}
                      {e.reason === "no_variation"
                        ? `gave the same score to all ${e.n} reviews; raw scores kept, standardized contribution dropped`
                        : `only ${e.n} review(s), below the threshold for estimating spread`}
                    </li>
                  );
                })}
                {report.insufficientProjects.length ? (
                  <li className="px-5 py-3 text-muted-foreground">
                    <span className="text-warning">Insufficient comparable reviews:</span>{" "}
                    {report.insufficientProjects.length} project(s) are listed without a rank.
                  </li>
                ) : null}
              </ul>
            </Panel>
          ) : null}

          {rows.length ? (
            <Panel>
              <PanelHeader
                title="Standings (snapshot)"
                sub="Not visible to anyone else until published."
              />
              <Table head={["#", "Project", "Team", "Normalized", "Raw", "Raw /100", "Raw rank", "Movement", "Usable / done"]}>
                {rows.map((r) => (
                  <Row key={r.id}>
                    <Cell className="font-mono tabular-nums text-muted-foreground">{r.rank ?? "—"}</Cell>
                    <Cell className="font-medium">{r.project_name}</Cell>
                    <Cell className="text-muted-foreground">{r.team_name}</Cell>
                    <Cell className="font-mono tabular-nums text-primary">
                      {r.sufficient ? r.normalized_mean?.toFixed(2)
                        : <span className="text-warning">insufficient comparable reviews</span>}
                    </Cell>
                    <Cell className="font-mono tabular-nums text-muted-foreground">{r.raw_mean?.toFixed(2)}</Cell>
                    <Cell className="font-mono tabular-nums text-muted-foreground">{r.raw_mean_100?.toFixed(1)}</Cell>
                    <Cell className="font-mono tabular-nums text-muted-foreground">{r.raw_rank}</Cell>
                    <Cell className="font-mono tabular-nums"><Delta value={r.rank_delta} /></Cell>
                    <Cell className={`font-mono tabular-nums ${r.usable_reviews < event.reviews_per_project ? "text-warning" : "text-muted-foreground"}`}>
                      {r.usable_reviews} / {r.reviews_counted}
                    </Cell>
                  </Row>
                ))}
              </Table>
            </Panel>
          ) : (
            <Notice tone="info">No snapshot yet. Compute one to see the standings.</Notice>
          )}
        </>
      )}

      <ExportLinks slug={slug} only={["reviews", "criterion-scores", "results"]} />
    </div>
  );
}
