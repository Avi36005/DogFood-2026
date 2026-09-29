import { redirect } from "next/navigation";
import { Cell, Panel, PanelHeader, Row, Table, When } from "@/components/app/ui";
import { AccountControls } from "@/components/app/admin";
import { currentActor } from "@/lib/auth/session.ts";
import * as accounts from "@/lib/domain/accounts.ts";
import { get } from "@/lib/db/client.ts";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function Admin({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect("/signin?next=/admin");
  if (actor.globalRole !== "admin") redirect("/dashboard");

  const { q } = await searchParams;
  const users = q?.trim() ? accounts.search(q, 100) : accounts.listAll(100);
  const totals = {
    users: get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)!.n,
    admins: get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE global_role = 'admin'`)!.n,
    events: get<{ n: number }>(`SELECT COUNT(*) AS n FROM events`)!.n,
    sessions: get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?`, new Date().toISOString())!.n,
  };

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <h1 className="text-[32px]">Instance administration</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          Accounts and instance state. Event-level powers are granted per event by its organizers.
        </p>

        <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-border bg-border lg:grid-cols-4">
          {[
            { v: totals.users, l: "accounts" },
            { v: totals.admins, l: "administrators" },
            { v: totals.events, l: "events" },
            { v: totals.sessions, l: "active sessions" },
          ].map((s) => (
            <div key={s.l} className="bg-card px-5 py-5">
              <div className="font-mono tabular-nums text-[26px] leading-none text-foreground">{s.v}</div>
              <div className="mt-2 text-[13px] text-muted-foreground">{s.l}</div>
            </div>
          ))}
        </div>

        <Panel className="mt-6">
          <PanelHeader title="Accounts" sub={`Showing ${users.length}. Use search to narrow the list.`} />
          <form method="get" className="border-b border-border px-5 py-4">
            <input
              name="q" defaultValue={q ?? ""} placeholder="Search name or email" aria-label="Search accounts"
              className="min-h-[44px] w-full max-w-sm rounded-[10px] border border-control-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-soft focus:border-primary focus:outline-none"
            />
          </form>
          <Table head={["Name", "Email", "Role", "Created", "Actions"]}>
            {users.map((u) => (
              <Row key={u.id}>
                <Cell>
                  <span className={u.disabled_at ? "text-muted-soft line-through" : "text-foreground"}>{u.display_name}</span>
                </Cell>
                <Cell className="font-mono text-[12px] text-muted-foreground">{u.email}</Cell>
                <Cell className={u.global_role === "admin" ? "text-primary" : "text-muted-foreground"}>{u.global_role}</Cell>
                <Cell><When iso={u.created_at} /></Cell>
                <Cell>
                  <AccountControls
                    userId={u.id}
                    role={u.global_role}
                    disabled={!!u.disabled_at}
                    isSelf={u.id === actor.id}
                  />
                </Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      </main>
    </>
  );
}
