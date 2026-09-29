"use client";

import { useEffect, useState } from "react";

function parts(iso: string, timeZone: string, zoneLabel?: string) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  const zone = zoneLabel ?? new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${day} at ${time}${zone ? ` ${zone}` : ""}`;
}

/**
 * A deadline the way a person reads one: "Sep 28 at 3:56 PM".
 *
 * The server renders UTC, because it cannot know where the reader is; once
 * mounted, the same instant is re-rendered in the reader's own timezone, with
 * the UTC form kept in the tooltip. Both renders start identical, so hydration
 * has nothing to disagree about.
 */
export function LocalTime({ iso, className = "" }: { iso: string | null; className?: string }) {
  const utc = iso ? parts(iso, "UTC", "UTC") : "";
  const [text, setText] = useState(utc);
  const [title, setTitle] = useState(iso ?? "");

  useEffect(() => {
    if (!iso) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      setText(parts(iso, zone));
      setTitle(`${parts(iso, "UTC", "UTC")} · ${iso}`);
    } catch { /* an exotic zone: the UTC text already on screen stands */ }
  }, [iso]);

  if (!iso) return <span className={`text-muted-soft ${className}`}>—</span>;
  return <time dateTime={iso} title={title} className={className}>{text}</time>;
}
