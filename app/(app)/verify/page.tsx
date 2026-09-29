import Link from "next/link";
import { Panel, PanelHeader } from "@/components/app/ui";
import { VerifyForm } from "@/components/app/verify";
import { publicKeyPem, keyIdFor } from "@/lib/domain/records.ts";

export const metadata = { title: "Verify a record" };
export const dynamic = "force-dynamic";

export default function Verify() {
  const pem = publicKeyPem();
  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 max-w-3xl py-12">
        <h1 className="text-[32px]">Verify a record</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          Paste a signed Forgeboard record below. Verification runs against this instance&rsquo;s published
          public key and needs no account.
        </p>

        <div className="mt-8"><VerifyForm /></div>

        <Panel className="mt-6">
          <PanelHeader title="This instance's public key" sub={`Key id ${keyIdFor(pem)} · Ed25519`} />
          <pre className="overflow-x-auto px-5 py-4 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            <code>{pem.trim()}</code>
          </pre>
          <p className="border-t border-border px-5 py-3 text-[12px] text-muted-foreground">
            Also served as plain text at{" "}
            <Link href="/api/verify-key" className="text-primary hover:underline">/api/verify-key</Link>.
          </p>
        </Panel>

        <Panel className="mt-6">
          <PanelHeader title="What a valid signature does and does not prove" />
          <div className="space-y-3 px-5 py-5 text-[13px] leading-relaxed text-muted-foreground">
            <p>
              <strong className="text-foreground">It proves</strong> the record was issued by the holder of this
              instance&rsquo;s private key and has not been altered by so much as a character since.
            </p>
            <p>
              <strong className="text-foreground">It does not prove</strong> the statement inside is true. Signing
              a false claim produces a validly signed false claim. Authenticity and factual correctness are
              different things, and only the first is cryptographic.
            </p>
            <p>
              <strong className="text-foreground">Key rotation.</strong> Records carry the key id they were signed
              with. After a rotation, older records will not verify against the new key; keep the retired
              public key to verify them. If a private key is compromised, rotate it, publish the new key,
              and treat every record signed with the old one as unverified until reissued.
            </p>
            <p>
              <strong className="text-foreground">Publicly verifiable</strong> means anyone holding the artifact and
              the public key can check it. On a laptop this page is reachable only on localhost; it becomes
              genuinely public when the instance is hosted somewhere public.
            </p>
          </div>
        </Panel>
      </main>
    </>
  );
}
