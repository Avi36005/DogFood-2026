import Link from "next/link";
import { redirect } from "next/navigation";
import { Field, Input, Notice, Panel, PanelHeader, Select, Textarea } from "@/components/app/ui";
import { ActionForm } from "@/components/app/form";
import { createEventAction } from "@/lib/actions/events.ts";
import { currentActor } from "@/lib/auth/session.ts";
import { mayCreateEvent } from "@/lib/domain/instance.ts";

export const metadata = { title: "Create an event" };
export const dynamic = "force-dynamic";

export default async function NewEvent() {
  const actor = await currentActor();
  if (!actor) redirect("/signin?next=/events/new");
  const gate = mayCreateEvent(actor);

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 max-w-2xl py-12">
        <Link href="/events" className="text-[13px] text-muted-foreground hover:text-foreground">&larr; Events</Link>
        <h1 className="mt-3 text-[32px]">Create an event</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          You become the organizer of this event. That is scoped to this event alone and grants no
          powers anywhere else on the instance.
        </p>

        {!gate.allowed ? (
          <div className="mt-8"><Notice tone="warn">{gate.reason}</Notice></div>
        ) : (
          <Panel className="mt-8">
            <PanelHeader title="Details" sub="Everything here can be changed afterwards. The event starts as a draft and is not public until you open it." />
            <div className="px-5 py-5">
              <ActionForm action={createEventAction} submitLabel="Create event">
                <div className="space-y-5">
                  <Field label="Event name" required>
                    <Input name="name" required autoFocus maxLength={120} placeholder="Autumn Build 2026" />
                  </Field>
                  <Field label="Tagline" hint="One line, shown in listings and on the event page.">
                    <Input name="tagline" maxLength={200} />
                  </Field>
                  <Field label="Description">
                    <Textarea name="description" rows={5} />
                  </Field>
                  <Field label="Display timezone" hint="Times are stored in UTC. This only changes how they are labelled.">
                    <Select name="timezone" defaultValue="UTC">
                      {["UTC","Europe/London","Europe/Berlin","America/New_York","America/Los_Angeles","Asia/Kolkata","Asia/Tokyo","Australia/Sydney"]
                        .map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                    </Select>
                  </Field>

                  <fieldset className="rounded-[10px] border border-border p-4">
                    <legend className="px-1 text-[13px] font-medium text-foreground">Schedule</legend>
                    <p className="mb-4 text-[12px] text-muted-foreground">
                      Entered and stored as UTC. Leave blank to decide later.
                    </p>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Submissions open"><Input type="datetime-local" name="submissions_open_at" /></Field>
                      <Field label="Submissions close"><Input type="datetime-local" name="submissions_close_at" /></Field>
                      <Field label="Judging opens"><Input type="datetime-local" name="judging_open_at" /></Field>
                      <Field label="Judging closes"><Input type="datetime-local" name="judging_close_at" /></Field>
                    </div>
                  </fieldset>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Maximum team size" hint="1 to 50.">
                      <Input type="number" name="max_team_size" min={1} max={50} defaultValue={4} className="font-mono tabular-nums" />
                    </Field>
                    <Field label="Reviews per project" hint="The assignment target.">
                      <Input type="number" name="reviews_per_project" min={1} max={20} defaultValue={3} className="font-mono tabular-nums" />
                    </Field>
                  </div>

                  <Field label="Tracks" hint="One per line. You can add more later.">
                    <Textarea name="tracks" rows={4} placeholder={"Developer tooling\nData and analytics\nCivic technology"} />
                  </Field>
                </div>
              </ActionForm>
            </div>
          </Panel>
        )}

        <p className="mt-6 text-[12px] text-muted-soft">
          The rubric is configured after creation, from the organizer console.
        </p>
      </main>
    </>
  );
}
