import Link from "next/link";
import { Empty, Panel, Status, When } from "@/components/app/ui";
import { currentActor } from "@/lib/auth/session.ts";
import * as events from "@/lib/domain/events.ts";
import { get } from "@/lib/db/client.ts";

export const metadata = { title: "Events" };
export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const actor = await currentActor();
  const list = actor ? events.listForActor(actor) : events.listPublic();

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-14">
        <h1 className="text-[32px]">Events</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">Everything running on this instance that you are allowed to see.</p>

        <div className="mt-8 space-y-3">
          {list.length === 0 ? (
            <Panel><Empty title="No events yet" body="An organizer has not created one, or none are public." /></Panel>
          ) : list.map((e) => {
            const submitted = get<{ n: number }>(
              `SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'submitted'`, e.id)?.n ?? 0;
            const trackCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE event_id = ?`, e.id)?.n ?? 0;
            return (
              <Panel key={e.id} className="transition-colors hover:border-border">
                <Link href={`/events/${e.slug}`} className="block p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-[18px] font-semibold text-foreground">{e.name}</h2>
                      {e.tagline ? <p className="mt-1 text-[14px] text-muted-foreground">{e.tagline}</p> : null}
                    </div>
                    <Status value={e.status} />
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px] text-muted-foreground">
                    <span className="font-mono tabular-nums">{submitted} submitted</span>
                    <span className="font-mono tabular-nums">{trackCount} tracks</span>
                    {e.submissions_close_at ? (
                      <span>Submissions close <When iso={e.submissions_close_at} tz={e.timezone} /></span>
                    ) : null}
                  </div>
                </Link>
              </Panel>
            );
          })}
        </div>
      </main>
    </>
  );
}
