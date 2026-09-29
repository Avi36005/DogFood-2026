import Link from "next/link";
import { Panel, SectionLabel } from "@/components/app/ui";

export const metadata = { title: "Documentation" };

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-14 scroll-mt-24 text-[26px] first:mt-0">
      {children}
    </h2>
  );
}

export default function Docs() {
  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 max-w-3xl py-12">
        <SectionLabel>// DOCUMENTATION</SectionLabel>
        <h1 className="text-[34px]">Running Forgeboard</h1>
        <p className="mt-3 text-[15px] text-muted-foreground">
          The short version. The repository carries the full <code className="font-mono text-primary">ARCHITECTURE.md</code>,{" "}
          <code className="font-mono text-primary">DATA-MODEL.md</code> and <code className="font-mono text-primary">JUDGING.md</code>.
        </p>

        <H id="start">Starting it</H>
        <Panel className="mt-4 p-5">
          <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed text-muted-foreground">
            <code>{`docker compose up`}</code>
          </pre>
        </Panel>
        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          That applies the schema, seeds a demo event and serves the portal on{" "}
          <code className="font-mono text-primary">http://localhost:3000</code>. There is no cloud account,
          managed database, auth provider or API key involved, and no outbound request is made at runtime,
          so it comes up with the network off.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          To run it without Docker: <code className="font-mono text-primary">npm install</code>,{" "}
          <code className="font-mono text-primary">npm run db:migrate</code>,{" "}
          <code className="font-mono text-primary">npm run db:seed</code>, then{" "}
          <code className="font-mono text-primary">npm run dev</code>. Node 22.5 or newer is required, because
          the database driver is the standard library&rsquo;s.
        </p>

        <H id="roles">Roles</H>
        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          Roles are granted per event, not globally. A person can be an organizer of one event, a judge in
          another and a participant in a third. The only instance-wide role is administrator, which manages
          accounts and nothing else.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          Every check runs in the data layer. A judge&rsquo;s queue is selected by assignment ownership, so
          there is no address to visit or parameter to change that returns another judge&rsquo;s ballot.
          Refused attempts are written to the event&rsquo;s audit trail.
        </p>

        <H id="judging">How scoring works</H>
        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          Judges score a weighted rubric the organizer configures. A review&rsquo;s raw score is the weighted
          mean of its criteria. Raw scores are not comparable across judges, because judges differ: some run
          a whole point low, some use only the middle of the scale.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          Forgeboard corrects for this with shrunk z-score normalization. Each judge&rsquo;s centre and
          spread are measured, then pulled toward the panel&rsquo;s in proportion to how few reviews they
          filed, so a judge with two reviews is barely adjusted and a judge with thirty is trusted. Each
          review is then re-expressed on the panel&rsquo;s scale.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          The organizer console shows every judge&rsquo;s bias, the raw ranking, the normalized ranking and
          the movement between them, so the adjustment is inspectable rather than asserted. A judge who marks
          everything the same gets a usable spread from the prior instead of a division by zero, and a panel
          that agreed exactly is reported as such rather than given invented separation.
        </p>

        <H id="data">Getting your data out</H>
        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          Every stage exports to CSV from the organizer console: projects, teams, the panel, assignments,
          reviews, per-criterion scores, results and the audit log. The files are RFC 4180 and values that a
          spreadsheet would try to evaluate as a formula are neutralised.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          The database is a single SQLite file under <code className="font-mono text-primary">data/</code>.
          Backing up the instance is copying that file and the uploads directory beside it.
        </p>

        <H id="community">Community voting and comments</H>
        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          Both are off until an organizer turns them on. Voting supports three access modes, and each
          one&rsquo;s real strength is stated on the ballot rather than implied: an open link is a
          browser cookie, email-gating proves control of one address, and authenticated voting proves
          one account on this instance. None of them proves one human.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          Ballots are ordered differently for every voter, so position bias does not accumulate on the
          same projects. Totals are visible to nobody but the organizer until voting closes
          <em> and</em> they publish them. Community results are reported separately from judge results
          and are never mixed into them.
        </p>

        <H id="api">API, webhooks and records</H>
        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          There is a REST API at <code className="font-mono text-primary">/api/v1</code> with a published
          spec at <code className="font-mono text-primary">/api/v1/openapi.json</code>. Keys are issued
          from the organizer console and grant exactly what their owner can do — the API and the
          interface share one authorization path, so a key is not a way around anything.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          Honest scope: the API covers events, the public gallery, judging progress, assignment
          generation, scoring, publication and whole-event bundles. It does <strong>not</strong> yet
          cover team management, submissions, voting or moderation, which is why this build does not
          claim T4.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          Webhooks are signed with HMAC-SHA256 and delivered at least once with bounded retries, so
          consumers must deduplicate on the delivery id. Callback URLs resolving to private or reserved
          addresses are refused. Participation records are signed with Ed25519 and can be checked at{" "}
          <Link href="/verify" className="text-primary hover:underline">/verify</Link> by anyone, without
          an account.
        </p>

        <H id="limits">What it does not do yet</H>
        <ul className="mt-4 space-y-2 text-[14px] leading-relaxed text-muted-foreground">
          <li>— No email at all. Invites and voting links are passed along by you; password recovery is an admin action.</li>
          <li>— The API does not mirror every action the interface can take.</li>
          <li>— Certificates are printable pages, not PDFs.</li>
          <li>— Webhook retries are in-process, so queued retries are lost across a restart.</li>
          <li>— No pairwise judging mode.</li>
          <li>— Uploaded images are checked by content but not re-encoded.</li>
        </ul>

        <p className="mt-10 text-[13px] text-muted-soft">
          <Link href="/events" className="text-primary hover:underline">Back to events</Link>
        </p>
      </main>
    </>
  );
}
