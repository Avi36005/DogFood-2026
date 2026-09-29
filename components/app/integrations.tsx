"use client";

import { useState } from "react";
import { Copy, Download, KeyRound, Trash2 } from "lucide-react";
import {
  issueKeyAction, revokeKeyAction, addWebhookAction, removeWebhookAction, importBundleAction,
} from "@/lib/actions/integrations.ts";
import { issueRecordAction } from "@/lib/actions/records.ts";
import { Button, Cell, Notice, Row, Select, Table, When } from "./ui";
import { useFormAction } from "./form";

export function ApiKeys({ slug, keys }: {
  slug: string;
  keys: { id: string; label: string; scopes: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
}) {
  const [issued, issue, issuing, keep] = useFormAction(issueKeyAction);
  const [revoked, revoke] = useFormAction(revokeKeyAction);
  const token = issued.ok?.startsWith("fbk_") ? issued.ok : null;

  return (
    <div>
      <form action={issue} {...keep} className="flex flex-wrap items-end gap-3 px-5 py-5">
        <input type="hidden" name="slug" value={slug} />
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-foreground">Label</span>
          <input name="label" required placeholder="CI pipeline" className="min-h-[44px] w-56 rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground" />
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" name="write" className="h-4 w-4 accent-primary" />
          Allow writes
        </label>
        <Button type="submit" disabled={issuing}><KeyRound size={15} />{issuing ? "Issuing…" : "Issue key"}</Button>
      </form>

      {issued.error ? <div className="px-5 pb-4"><Notice tone="danger">{issued.error}</Notice></div> : null}
      {revoked.error ? <div className="px-5 pb-4"><Notice tone="danger">{revoked.error}</Notice></div> : null}
      {token ? (
        <div className="px-5 pb-4">
          <Notice tone="success">
            <p className="mb-2">Copy this now. It is not stored and cannot be shown again.</p>
            <code className="block break-all rounded-[8px] border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-primary">{token}</code>
          </Notice>
        </div>
      ) : null}

      {keys.length ? (
        <Table head={["Label", "Scopes", "Created", "Last used", ""]}>
          {keys.map((k) => (
            <Row key={k.id}>
              <Cell className={k.revoked_at ? "text-muted-soft line-through" : ""}>{k.label}</Cell>
              <Cell className="font-mono text-[12px] text-muted-foreground">{k.scopes}</Cell>
              <Cell><When iso={k.created_at} /></Cell>
              <Cell><When iso={k.last_used_at} /></Cell>
              <Cell>
                {!k.revoked_at ? (
                  <form action={revoke}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="keyId" value={k.id} />
                    <button type="submit" className="text-[12px] text-muted-foreground hover:text-destructive">Revoke</button>
                  </form>
                ) : <span className="text-[12px] text-muted-soft">revoked</span>}
              </Cell>
            </Row>
          ))}
        </Table>
      ) : null}
    </div>
  );
}

export function Webhooks({ slug, topics, hooks }: {
  slug: string; topics: readonly string[];
  hooks: { id: string; url: string; topics: string; last_status: string; failures: number }[];
}) {
  const [state, add, adding, keep] = useFormAction(addWebhookAction);
  const [removed, remove] = useFormAction(removeWebhookAction);

  return (
    <div>
      <form action={add} {...keep} className="space-y-4 px-5 py-5">
        <input type="hidden" name="slug" value={slug} />
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {removed.error ? <Notice tone="danger">{removed.error}</Notice> : null}
        {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-foreground">Endpoint URL</span>
          <input
            name="url" type="url" required placeholder="https://example.org/forgeboard-hook"
            className="min-h-[44px] w-full max-w-lg rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground"
          />
          <span className="mt-1 block text-[12px] text-muted-foreground">
            Addresses that resolve to loopback, private or reserved ranges are refused.
          </span>
        </label>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-foreground">Topics <span className="font-normal text-muted-foreground">(none selected = all)</span></legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {topics.map((t) => (
              <label key={t} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <input type="checkbox" name="topic" value={t} className="h-4 w-4 accent-primary" />
                <span className="font-mono">{t}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={adding}>{adding ? "Registering…" : "Register webhook"}</Button>
      </form>

      {hooks.length ? (
        <Table head={["Endpoint", "Topics", "Last status", "Failures", ""]}>
          {hooks.map((h) => (
            <Row key={h.id}>
              <Cell className="max-w-[260px] truncate font-mono text-[12px]">{h.url}</Cell>
              <Cell className="font-mono text-[11px] text-muted-foreground">{h.topics}</Cell>
              <Cell className="text-muted-foreground">{h.last_status || "—"}</Cell>
              <Cell className={`font-mono tabular-nums ${h.failures ? "text-warning" : "text-muted-foreground"}`}>{h.failures}</Cell>
              <Cell>
                <form action={remove}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="webhookId" value={h.id} />
                  <button type="submit" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-destructive">
                    <Trash2 size={12} aria-hidden />Remove
                  </button>
                </form>
              </Cell>
            </Row>
          ))}
        </Table>
      ) : null}
    </div>
  );
}

export function BundleTools({ slug }: { slug: string }) {
  const [state, action, pending, keep] = useFormAction(importBundleAction);
  return (
    <div className="space-y-5 px-5 py-5">
      <a
        href={`/api/v1/events/${slug}/export`}
        download={`${slug}-bundle.json`}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-[10px] border border-control-border px-4 text-[14px] text-foreground hover:bg-secondary"
      >
        <Download size={15} aria-hidden />Export this event
      </a>

      <form action={action} {...keep} className="space-y-3 border-t border-border pt-5">
        <input type="hidden" name="slug" value={slug} />
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {state.ok ? <Notice tone="success">{state.ok}</Notice> : null}
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-foreground">Import a bundle</span>
          <input
            type="file" name="bundle" accept="application/json,.json"
            className="text-[12px] text-muted-foreground file:mr-3 file:min-h-[40px] file:rounded-[8px] file:border-0 file:bg-secondary file:px-3 file:text-[12px] file:text-foreground"
          />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" name="dryRun" defaultChecked className="h-4 w-4 accent-primary" />
          Dry run — validate and report, write nothing
        </label>
        <Button type="submit" tone="secondary" disabled={pending}>{pending ? "Working…" : "Import"}</Button>
        <p className="text-[12px] text-muted-soft">
          Imports land as a new draft event. The source event is never modified, and a half-valid file is
          rejected whole rather than half-applied.
        </p>
      </form>
    </div>
  );
}

export function IssueRecord({ slug, judges }: {
  slug: string; judges: { id: string; name: string; submitted: number }[];
}) {
  const [state, action, pending, keep] = useFormAction(issueRecordAction);
  return (
    <form action={action} {...keep} className="flex flex-wrap items-end gap-3 px-5 py-5">
      <input type="hidden" name="slug" value={slug} />
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-foreground">Judge</span>
        <Select name="judgeUserId" className="w-72">
          {judges.length === 0 ? <option value="">No judge has submitted a review yet</option> : null}
          {judges.map((j) => (
            <option key={j.id} value={j.id}>{j.name} — {j.submitted} review(s)</option>
          ))}
        </Select>
      </label>
      <Button type="submit" disabled={pending || judges.length === 0}>
        {pending ? "Signing…" : "Issue signed record"}
      </Button>
      {state.error ? <span className="text-[12px] text-destructive">{state.error}</span> : null}
      {state.ok ? <span className="text-[12px] text-success">{state.ok}</span> : null}
    </form>
  );
}
