import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CheckCircle2, ChevronRight, FileUp, Gavel, Images, Settings2, Users,
  CalendarClock, ClipboardList, UserCheck, Trophy,
} from "lucide-react";
import { Empty, LinkButton, Panel, PanelHeader, Status } from "@/components/app/ui";
import { LocalTime } from "@/components/app/time";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import * as teams from "@/lib/domain/teams.ts";
import * as projects from "@/lib/domain/projects.ts";
import { all, get } from "@/lib/db/client.ts";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type Metric = {
  label: string;
  value: string;
  detail: React.ReactNode;
  href: string;
  action: string;
  icon: typeof Gavel;
  /** A real ratio, drawn as a bar. Null means there is nothing to fill. */
  bar?: { done: number; total: number } | null;
  tone?: "brand" | "warn" | "plain";
};

type Task = { href: string; title: string; meta: string; done: boolean; icon: typeof Gavel };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect("/signin?next=/dashboard");
  const { q } = await searchParams;

  const mine = events.listForActor(actor).filter((e) => {
    const cap = capabilityFor(actor, e.id);
    return cap.isOrganizer || cap.isJudge || cap.isParticipant || !!teams.teamForUser(e.id, actor.id);
  });
  const needle = (q ?? "").trim().toLowerCase();
  const shown = needle ? mine.filter((e) => e.name.toLowerCase().includes(needle)) : mine;

  const metrics: Metric[] = [];
  const tasks: Task[] = [];
  const n = (sql: string, ...params: unknown[]) => get<{ n: number }>(sql, ...params)!.n;

  for (const e of shown) {
    const cap = capabilityFor(actor, e.id);
    const team = teams.teamForUser(e.id, actor.id);

    if (cap.isOrganizer) {
      const submitted = n(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'submitted' AND disqualified_at IS NULL`, e.id);
      const assigned = n(`SELECT COUNT(*) AS n FROM assignments WHERE event_id = ? AND status != 'revoked'`, e.id);
      const done = n(
        `SELECT COUNT(*) AS n FROM reviews r JOIN assignments a ON a.id = r.assignment_id
          WHERE a.event_id = ? AND r.status = 'submitted'`, e.id);
      const remaining = Math.max(0, assigned - done);

      metrics.push({
        label: "Review progress",
        value: assigned ? `${Math.round((100 * done) / assigned)}%` : "—",
        detail: assigned
          ? `${done} of ${assigned} reviews completed · ${remaining} remaining`
          : "No reviews assigned yet",
        href: `/events/${e.slug}/organize/assignments`,
        action: remaining ? "View incomplete reviews" : "View coverage",
        icon: ClipboardList,
        bar: assigned ? { done, total: assigned } : null,
        tone: remaining === 0 && assigned > 0 ? "brand" : "plain",
      });

      metrics.push({
        label: "Projects submitted",
        value: String(submitted),
        detail: `${n(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'draft'`, e.id)} still drafting`,
        href: `/events/${e.slug}/organize/projects`,
        action: "View projects",
        icon: FileUp,
      });

      const judgeRows = all<{ user_id: string; done: number; assigned: number }>(
        `SELECT er.user_id,
                SUM(CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END) AS done,
                COUNT(a.id) AS assigned
           FROM event_roles er
           LEFT JOIN assignments a ON a.judge_user_id = er.user_id AND a.event_id = er.event_id AND a.status != 'revoked'
           LEFT JOIN reviews r ON r.assignment_id = a.id
          WHERE er.event_id = ? AND er.role = 'judge'
          GROUP BY er.user_id`, e.id);
      const idle = judgeRows.filter((j) => j.assigned > 0 && (j.done ?? 0) === 0).length;
      metrics.push({
        label: "Judges on the panel",
        value: String(judgeRows.length),
        detail: idle ? `${idle} not started` : "Every assigned judge has started",
        href: `/events/${e.slug}/organize/panel`,
        action: "View panel",
        icon: UserCheck,
        tone: idle ? "warn" : "plain",
      });

      const closes = e.status === "judging" ? e.judging_close_at : e.submissions_close_at;
      const days = closes ? Math.ceil((Date.parse(closes) - Date.now()) / 864e5) : null;
      metrics.push({
        label: e.status === "judging" ? "Judging closes" : "Submissions close",
        value: days === null ? "—" : days > 0 ? `${days} day${days === 1 ? "" : "s"}` : "Closed",
        detail: closes ? <LocalTime iso={closes} /> : "No close time set",
        href: `/events/${e.slug}/organize/setup`,
        action: "Edit the schedule",
        icon: CalendarClock,
        tone: days !== null && days <= 1 ? "warn" : "plain",
      });

      const unassigned = n(
        `SELECT COUNT(*) AS n FROM projects p
          WHERE p.event_id = ? AND p.status = 'submitted' AND p.disqualified_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = p.id AND a.status != 'revoked')`, e.id);
      tasks.push({
        href: `/events/${e.slug}/organize/assignments`,
        title: unassigned
          ? `Assign a judge to ${unassigned} unassigned project${unassigned === 1 ? "" : "s"}`
          : "Every project has a judge",
        meta: e.name, done: unassigned === 0, icon: ClipboardList,
      });
      tasks.push({
        href: `/events/${e.slug}/organize`,
        title: idle
          ? `Follow up with ${idle} judge${idle === 1 ? " who has" : "s who have"} not started`
          : "All judges have started",
        meta: e.name, done: idle === 0, icon: UserCheck,
      });
      const published = e.status === "results_published";
      tasks.push({
        href: `/events/${e.slug}/organize/results`,
        title: published ? "Results are published" : "Review and publish results",
        meta: e.name, done: published, icon: Trophy,
      });
    }

    if (cap.isJudge) {
      const queue = get<{ total: number; done: number }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END) AS done
           FROM assignments a LEFT JOIN reviews r ON r.assignment_id = a.id
          WHERE a.event_id = ? AND a.judge_user_id = ? AND a.status != 'revoked'`, e.id, actor.id)!;
      const doneCount = queue.done ?? 0;
      const left = queue.total - doneCount;
      metrics.push({
        label: left > 0 ? "Reviews remaining" : "Your review queue",
        value: String(left),
        detail: !queue.total
          ? "Nothing assigned to you yet"
          : left > 0
            ? `${doneCount} of ${queue.total} reviews completed · ${left} remaining`
            : `All ${queue.total} reviews submitted`,
        href: `/events/${e.slug}/judge`,
        action: left ? "Open the next review" : "View your queue",
        icon: Gavel,
        bar: queue.total ? { done: doneCount, total: queue.total } : null,
        tone: left === 0 && queue.total > 0 ? "brand" : "plain",
      });
      for (const item of all<{ assignment_id: string; project_name: string; review_status: string | null }>(
        `SELECT a.id AS assignment_id, p.name AS project_name, r.status AS review_status
           FROM assignments a JOIN projects p ON p.id = a.project_id LEFT JOIN reviews r ON r.assignment_id = a.id
          WHERE a.event_id = ? AND a.judge_user_id = ? AND a.status != 'revoked'
          ORDER BY CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END, p.name LIMIT 4`, e.id, actor.id)) {
        tasks.push({
          href: `/events/${e.slug}/judge/${item.assignment_id}`,
          title: `Review ${item.project_name}`,
          meta: e.name,
          done: item.review_status === "submitted",
          icon: Gavel,
        });
      }
    }

    if (team) {
      const project = projects.forTeam(team.id);
      const status = project?.status ?? "draft";
      metrics.push({
        label: "Your submission",
        value: project?.name || "Not started",
        detail: `${team.name} · ${status === "submitted" ? "submitted" : "draft"}`,
        href: `/events/${e.slug}/submit`,
        action: status === "submitted" ? "View your submission" : "Finish your submission",
        icon: FileUp,
        tone: status === "submitted" ? "brand" : "warn",
      });
      tasks.push({
        href: `/events/${e.slug}/submit`,
        title: status === "submitted" ? "Submission is in" : "Finish and submit your project",
        meta: e.name, done: status === "submitted", icon: FileUp,
      });
    }
  }

  const first = actor.displayName.split(" ")[0];
  const open = tasks.filter((t) => !t.done);
  const completed = tasks.filter((t) => t.done);
  const headline = metrics.filter((m) => m.bar !== undefined && m.bar !== null).slice(0, 1);
  const rest = metrics.filter((m) => !headline.includes(m)).slice(0, 3);

  return (
    <main className="relative mx-auto max-w-7xl px-6 py-8 lg:px-8 lg:py-10">
      {/* The landing page's grid, at a fraction of its strength. */}
      <div className="grid-pattern pointer-events-none absolute inset-x-0 top-0 h-56 opacity-70" aria-hidden />

      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-brand-ink">// Workspace</p>
          <h1 className="mt-1.5 text-[34px] tracking-tight">Welcome back, {first}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mine.length === 0
              ? "You are not part of an event yet."
              : `${mine.length} event${mine.length === 1 ? "" : "s"} · ${open.length} task${open.length === 1 ? "" : "s"} waiting on you`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mine.length > 3 ? (
            <form method="get" className="flex items-center gap-2">
              <input
                name="q" defaultValue={q ?? ""} placeholder="Find an event" aria-label="Find one of your events"
                className="h-11 w-48 rounded-full border border-control-border bg-card px-4 text-sm text-foreground placeholder:text-muted-soft"
              />
            </form>
          ) : null}
          <LinkButton href="/events/new" tone="pale">Create an event</LinkButton>
        </div>
      </div>

      {mine.length === 0 ? (
        <Panel className="relative mt-8">
          <Empty
            title="You are not part of an event yet"
            body="Browse what is running on this instance, or open a team invite link someone sent you."
            action={<LinkButton href="/events">Browse events</LinkButton>}
          />
        </Panel>
      ) : (
        <div className="relative mt-8 space-y-6">
          {/* 1. What is waiting on this person: open work only, in priority order. */}
          <Panel>
            <PanelHeader
              title={<h2 className="text-[15px] tracking-tight">Waiting on you</h2>}
              sub={open.length ? `${open.length} open` : undefined}
            />
            {open.length === 0 ? (
              <p className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-brand-ink" aria-hidden />
                You&rsquo;re all caught up.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {open.map((t) => <TaskRow key={t.href + t.title} task={t} />)}
              </ul>
            )}
          </Panel>

          {/* 1b. Finished work, kept apart and quieter so it never reads as pending. */}
          {completed.length ? (
            <section aria-labelledby="recently-completed">
              <h2 id="recently-completed" className="px-1 text-[13px] font-medium text-muted-foreground">
                Recently completed
              </h2>
              <ul className="mt-2 divide-y divide-border rounded-2xl border border-border">
                {completed.slice(0, 3).map((t) => <TaskRow key={t.href + t.title} task={t} />)}
              </ul>
            </section>
          ) : null}

          {/* 2. Progress, with the bar carrying the number. */}
          {headline.map((m) => (
            <MetricCard key={m.label + m.detail} metric={m} wide />
          ))}

          {/* 3. The rest of the numbers. */}
          {rest.length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {rest.map((m) => <MetricCard key={m.label + m.detail} metric={m} />)}
            </div>
          ) : null}

          {/* 4. The event itself, compactly. */}
          <Panel>
            <PanelHeader
              title={mine.length === 1 ? "Active event" : "Active events"}
              sub={needle ? `${shown.length} matching “${q}”` : undefined}
            />
            <ul className="divide-y divide-border">
              {shown.map((e) => {
                const cap = capabilityFor(actor, e.id);
                const team = teams.teamForUser(e.id, actor.id);
                const roles = [cap.isOrganizer && "Organizer", cap.isJudge && "Judge", (team || cap.isParticipant) && "Participant"].filter(Boolean);
                const closes = e.status === "judging" ? e.judging_close_at : e.submissions_close_at;
                return (
                  <li key={e.id} className="px-6 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/events/${e.slug}`} className="text-[17px] font-semibold tracking-tight hover:underline">{e.name}</Link>
                          <Status value={e.status} />
                        </div>
                        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                          {roles.join(" · ")}
                          {closes ? <> · {e.status === "judging" ? "judging closes" : "submissions close"} <LocalTime iso={closes} /></> : null}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {cap.isOrganizer ? <LinkButton href={`/events/${e.slug}/organize`} tone="secondary"><Settings2 className="h-4 w-4" />Console</LinkButton> : null}
                        {cap.isJudge ? <LinkButton href={`/events/${e.slug}/judge`} tone="secondary"><Gavel className="h-4 w-4" />Queue</LinkButton> : null}
                        {team ? <LinkButton href={`/events/${e.slug}/submit`} tone="secondary"><FileUp className="h-4 w-4" />Submission</LinkButton> : null}
                        {team ? <LinkButton href={`/events/${e.slug}/team`} tone="secondary"><Users className="h-4 w-4" />Team</LinkButton> : null}
                        <LinkButton href={`/events/${e.slug}/gallery`} tone="secondary"><Images className="h-4 w-4" />Gallery</LinkButton>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      )}
    </main>
  );
}

/** One number, what it means, and where it goes. The whole card is the link. */
function MetricCard({ metric, wide = false }: { metric: Metric; wide?: boolean }) {
  const { label, value, detail, href, action, icon: Icon, bar, tone = "plain" } = metric;
  const pct = bar && bar.total > 0 ? Math.round((100 * bar.done) / bar.total) : null;

  return (
    <Link
      href={href}
      className="group flex flex-col gap-4 rounded-3xl border border-border bg-card p-6 transition-colors hover:border-brand/60 active:bg-foreground active:text-background"
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${tone === "brand" ? "text-brand-ink" : tone === "warn" ? "text-warning" : "text-muted-foreground"}`} aria-hidden />
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      </div>

      <p className={`truncate font-semibold tracking-tight tabular-nums ${wide ? "text-5xl" : "text-4xl"}`}>{value}</p>

      {pct !== null ? (
        <div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="presentation">
            <div
              className={`h-full rounded-full ${tone === "warn" ? "bg-warning" : "bg-brand"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : null}

      {detail ? <p className="text-sm text-muted-foreground group-active:text-background/70">{detail}</p> : null}

      <span className="mt-auto inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.12em] text-brand-ink group-active:text-background">
        {action}
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
    </Link>
  );
}

function TaskRow({ task: t }: { task: Task }) {
  const Icon = t.done ? CheckCircle2 : t.icon;
  return (
    <li>
      <Link
        href={t.href}
        className={`group flex items-center gap-3 px-6 transition-colors hover:bg-secondary/60 active:bg-foreground active:text-background ${t.done ? "py-3" : "py-4"}`}
      >
        <span
          aria-hidden
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            t.done ? "bg-brand-soft text-brand-ink" : "bg-secondary text-foreground group-hover:bg-brand-soft group-hover:text-brand-ink"
          }`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-medium line-clamp-2 sm:truncate ${t.done ? "text-muted-foreground" : ""}`}>{t.title}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">{t.meta}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-soft transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}
