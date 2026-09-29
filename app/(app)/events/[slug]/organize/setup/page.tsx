import { notFound } from "next/navigation";
import { EventSettings, Prizes, Questions, SetupChecklist, Tracks } from "@/components/app/setup";
import { currentActor } from "@/lib/auth/session.ts";
import { capabilityFor } from "@/lib/authz.ts";
import * as events from "@/lib/domain/events.ts";
import { all, get } from "@/lib/db/client.ts";
import { eventPageTitle } from "@/lib/page-title.ts";

export const generateMetadata = eventPageTitle("Event setup");

export const dynamic = "force-dynamic";

// A short list rather than every IANA zone: these cover the common cases and
// the field accepts whatever the event already has.
const TIMEZONES = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
  "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Europe/Madrid", "Europe/Kyiv",
  "Africa/Lagos", "Africa/Nairobi", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

export default async function SetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = events.bySlug(slug);
  if (!event) notFound();
  const cap = capabilityFor(await currentActor(), event.id);
  if (!cap.isOrganizer) notFound();

  const tracks = events.tracks(event.id).map((t) => ({
    id: t.id, name: t.name, description: t.description,
    projects: get<{ n: number }>(`SELECT COUNT(*) AS n FROM projects WHERE track_id = ?`, t.id)!.n,
  }));
  const questions = all<{
    id: string; prompt: string; help_text: string; kind: string;
    required: number; is_public: number; options_json: string; answered: number;
  }>(
    `SELECT q.id, q.prompt, q.help_text, q.kind, q.required, q.is_public, q.options_json,
            (SELECT COUNT(*) FROM custom_answers a
              WHERE a.question_id = q.id AND TRIM(a.value_text) != '') AS answered
       FROM custom_questions q WHERE q.event_id = ? ORDER BY q.sort_order`,
    event.id,
  );
  const zones = TIMEZONES.includes(event.timezone) ? TIMEZONES : [event.timezone, ...TIMEZONES];

  // Rows from node:sqlite have a null prototype, which cannot cross into a
  // client component: every one of these is copied into a plain object first.
  return (
    <div className="space-y-6">
      <SetupChecklist items={events.setupChecklist(cap, slug).map((i) => ({ ...i }))} />
      <EventSettings
        slug={slug}
        timezones={zones}
        event={{
          name: event.name, tagline: event.tagline, description: event.description,
          timezone: event.timezone, version: event.version,
          submissions_open_at: event.submissions_open_at, submissions_close_at: event.submissions_close_at,
          judging_open_at: event.judging_open_at, judging_close_at: event.judging_close_at,
          max_team_size: event.max_team_size, reviews_per_project: event.reviews_per_project,
        }}
      />
      <Tracks slug={slug} tracks={tracks} />
      <Prizes
        slug={slug}
        tracks={tracks}
        prizes={events.prizes(event.id).map((p) => ({
          id: p.id, name: p.name, amount_text: p.amount_text, description: p.description, track_id: p.track_id,
        }))}
      />
      <Questions
        slug={slug}
        questions={questions.map((q) => ({
          id: q.id, prompt: q.prompt, help_text: q.help_text, kind: q.kind,
          required: q.required, is_public: q.is_public, options_json: q.options_json, answered: q.answered,
        }))}
      />
    </div>
  );
}
