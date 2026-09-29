import { Navigation } from "@/components/landing/navigation";
import { HeroSection } from "@/components/landing/hero-section";
import { FeaturesSection } from "@/components/landing/features-section";
import { HowItWorksSection } from "@/components/landing/how-it-works-section";
import { InfrastructureSection } from "@/components/landing/infrastructure-section";
import { MetricsSection } from "@/components/landing/metrics-section";
import { IntegrationsSection } from "@/components/landing/integrations-section";
import { SecuritySection } from "@/components/landing/security-section";
import { DevelopersSection } from "@/components/landing/developers-section";
import { CtaSection } from "@/components/landing/cta-section";
import { FooterSection } from "@/components/landing/footer-section";
import { currentActor } from "@/lib/auth/session.ts";
import { all, get } from "@/lib/db/client.ts";

// Read on every request: these numbers are this instance's, not illustrations.
export const dynamic = "force-dynamic";

const n = (sql: string) => {
  try { return get<{ n: number }>(sql)?.n ?? 0; } catch { return 0; }
};

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default async function Home() {
  const actor = await currentActor();

  const events = n(`SELECT COUNT(*) AS n FROM events WHERE status != 'draft'`);
  const submitted = n(`SELECT COUNT(*) AS n FROM projects WHERE status = 'submitted'`);
  const drafts = n(`SELECT COUNT(*) AS n FROM projects WHERE status = 'draft'`);
  const reviewsDone = n(`SELECT COUNT(*) AS n FROM reviews WHERE status = 'submitted'`);
  const reviewsAssigned = n(`SELECT COUNT(*) AS n FROM assignments WHERE status != 'revoked'`);
  const judges = n(`SELECT COUNT(DISTINCT user_id) AS n FROM event_roles WHERE role = 'judge'`);
  const organizers = n(`SELECT COUNT(DISTINCT user_id) AS n FROM event_roles WHERE role = 'organizer'`);
  const participants = n(`SELECT COUNT(DISTINCT user_id) AS n FROM event_roles WHERE role = 'participant'`);
  const tracks = n(`SELECT COUNT(*) AS n FROM tracks`);
  const seeded = n(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'seed.load'`) > 0;
  const healthy = (() => { try { get(`SELECT 1`); return true; } catch { return false; } })();

  // Public activity only: submissions are already visible in the gallery, so
  // listing the latest ones leaks nothing. No judge activity, no scores.
  let activity: { time: string; event: string; region: string; status: string; latency: string }[] = [];
  try {
    activity = all<{ name: string; submitted_at: string; track: string | null }>(
      `SELECT p.name, p.submitted_at, t.name AS track
         FROM projects p
         JOIN events e ON e.id = p.event_id AND e.status != 'draft'
         LEFT JOIN tracks t ON t.id = p.track_id
        WHERE p.status = 'submitted'
        ORDER BY p.submitted_at DESC LIMIT 4`,
    ).map((r) => ({
      time: ago(r.submitted_at),
      event: "project.submitted",
      region: r.name,
      status: "ok",
      latency: r.track ?? "",
    }));
  } catch { /* an empty feed is an honest feed */ }

  return (
    <main className="relative min-h-screen overflow-x-hidden">
      <Navigation signedIn={!!actor} displayName={actor?.displayName} />
      <HeroSection stats={{ events, projects: submitted, judges, reviews: reviewsDone, seeded }} />
      <FeaturesSection />
      <HowItWorksSection />
      <InfrastructureSection counts={{ judges, organizers, participants }} />
      <MetricsSection
        data={{ submitted, drafts, reviewsDone, reviewsAssigned, judges, tracks, healthy, activity }}
      />
      <IntegrationsSection />
      <SecuritySection />
      <DevelopersSection />
      <CtaSection />
      <FooterSection />
    </main>
  );
}
