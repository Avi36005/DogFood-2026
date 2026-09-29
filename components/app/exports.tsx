import { Download } from "lucide-react";
import { Panel, PanelHeader } from "./ui";
import { EXPORTS, type ExportName } from "@/lib/domain/exports.ts";

/** CSV download links. Every stage of the event is exportable, by design. */
export function ExportLinks({ slug, only }: { slug: string; only?: ExportName[] }) {
  const items = only ? EXPORTS.filter((e) => only.includes(e.name)) : EXPORTS;
  return (
    <Panel>
      <PanelHeader title="Export" sub="CSV, RFC 4180, safe to open in a spreadsheet." />
      <ul className="divide-y divide-border/60">
        {items.map((e) => (
          <li key={e.name}>
            <a
              href={`/api/events/${slug}/export/${e.name}`}
              className="flex items-center gap-3 px-5 py-3 hover:bg-secondary"
              download
            >
              <Download size={15} className="text-primary" aria-hidden />
              <span className="flex-1">
                <span className="block text-[14px] text-foreground">{e.label}</span>
                <span className="block text-[12px] text-muted-foreground">{e.description}</span>
              </span>
              <span className="font-mono text-[11px] text-muted-soft">{e.name}.csv</span>
            </a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
