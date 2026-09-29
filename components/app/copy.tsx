"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui";

/**
 * A link that is shown once and meant to be handed to someone. The absolute
 * URL is assembled in the browser, because the server has no reliable idea
 * what address this instance is reached on.
 */
export function CopyLink({ path, label = "Link" }: { path: string; label?: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const url = origin ? `${origin}${path}` : path;

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        readOnly
        value={url}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="min-h-[44px] flex-1 rounded-[10px] border border-control-border bg-background px-3 font-mono text-[12px] text-foreground"
      />
      <Button
        type="button"
        tone="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch { /* clipboard blocked; the field is selectable instead */ }
        }}
      >
        {copied ? <><Check size={15} aria-hidden />Copied</> : <><Copy size={15} aria-hidden />Copy</>}
      </Button>
    </div>
  );
}
