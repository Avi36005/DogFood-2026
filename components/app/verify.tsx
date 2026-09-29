"use client";

import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button, Panel, PanelHeader, Textarea } from "./ui";
import { verifyArtifactAction } from "@/lib/actions/records.ts";

export function VerifyForm() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ valid: boolean; reason?: string; payload?: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Panel>
      <PanelHeader title="Paste a record" sub="The whole JSON artifact, including its signature." />
      <div className="space-y-4 px-5 py-5">
        <Textarea
          rows={8} value={text} onChange={(e) => setText(e.currentTarget.value)}
          aria-label="Signed record JSON"
          placeholder='{ "payload": { … }, "signature": "…", "key_id": "…" }'
          className="font-mono text-[12px]"
        />
        <Button
          type="button" disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            setResult(await verifyArtifactAction(text));
            setBusy(false);
          }}
        >
          {busy ? "Checking…" : "Verify"}
        </Button>

        {result ? (
          <div
            role="status"
            className={`rounded-[10px] border px-4 py-3 text-[13px] ${
              result.valid ? "border-success/50 bg-success/10" : "border-destructive/50 bg-destructive/10"
            }`}
          >
            <p className="flex items-center gap-2 font-medium text-foreground">
              {result.valid
                ? <><CheckCircle2 size={16} className="text-success" aria-hidden />Signature is valid</>
                : <><XCircle size={16} className="text-destructive" aria-hidden />Not valid</>}
            </p>
            {result.reason ? <p className="mt-1 text-muted-foreground">{result.reason}</p> : null}
            {result.valid && result.payload ? (
              <pre className="mt-3 overflow-x-auto rounded-[8px] border border-border bg-background px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
                <code>{JSON.stringify(result.payload, null, 2)}</code>
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
