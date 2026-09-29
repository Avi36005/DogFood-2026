import Link from "next/link";
import { notFound } from "next/navigation";
import { artifactById } from "../../../lib/domain/records.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Participation record" };

/**
 * Printable record. Deliberately plain: it renders well on paper, uses the
 * packaged fonts, and carries its own verification instructions.
 */
export default async function RecordPage({ params }: { params: Promise<{ recordId: string }> }) {
  const { recordId } = await params;
  const artifact = artifactById(recordId);
  if (!artifact) notFound();

  const p = artifact.payload as {
    record_id: string; event: { name: string }; subject: { name: string };
    facts: { reviews_submitted: number; reviews_assigned: number; last_review_at: string | null };
    issued_at: string; issuer: { instance: string; key_id: string };
  };

  return (
    <main className="app-light min-h-screen"><div className="mx-auto max-w-[760px] px-6 py-12 print:py-0">
      <article className="rounded-[16px] border border-border bg-card p-10 print:border-0 print:bg-white print:p-0 print:text-black">
        <p className="font-mono text-[12px] uppercase tracking-widest text-primary print:text-black">
          Certificate of judging participation
        </p>
        <h1 className="mt-6 text-[34px] leading-tight">{p.subject.name}</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground print:text-black">
          served on the judging panel for <strong className="text-foreground print:text-black">{p.event.name}</strong>,
          completing <strong className="text-foreground print:text-black">{p.facts.reviews_submitted}</strong> of{" "}
          {p.facts.reviews_assigned} assigned reviews.
        </p>

        <dl className="mt-8 grid grid-cols-2 gap-4 border-t border-border pt-6 text-[13px] print:border-black/20">
          <div><dt className="text-muted-foreground print:text-black">Record id</dt><dd className="font-mono tabular-nums text-foreground print:text-black">{p.record_id}</dd></div>
          <div><dt className="text-muted-foreground print:text-black">Issued</dt><dd className="font-mono tabular-nums text-foreground print:text-black">{p.issued_at.slice(0, 10)}</dd></div>
          <div><dt className="text-muted-foreground print:text-black">Issuer</dt><dd className="text-foreground print:text-black">{p.issuer.instance}</dd></div>
          <div><dt className="text-muted-foreground print:text-black">Signing key</dt><dd className="font-mono tabular-nums text-foreground print:text-black">{p.issuer.key_id}</dd></div>
        </dl>

        <p className="mt-8 text-[12px] leading-relaxed text-muted-soft print:text-black">
          This record is signed with Ed25519. Verify it at <strong>/verify</strong> by pasting the artifact
          below. A valid signature proves the record was issued by this instance and has not been altered;
          it does not by itself prove the underlying facts.
        </p>
      </article>

      <details className="mt-6 print:hidden">
        <summary className="cursor-pointer text-[13px] text-primary">Signed artifact (copy this to verify)</summary>
        <pre className="mt-3 overflow-x-auto rounded-[10px] border border-border bg-card px-4 py-3 font-mono text-[11.5px] text-muted-foreground">
          <code>{JSON.stringify(artifact, null, 2)}</code>
        </pre>
      </details>

      <p className="mt-6 text-[13px] print:hidden">
        <Link href="/verify" className="text-primary hover:underline">Verify this record</Link>
      </p>
    </div>
    </main>
  );
}
