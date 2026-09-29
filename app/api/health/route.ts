import { get } from "../../../lib/db/client.ts";

export const dynamic = "force-dynamic";

/** Liveness plus a genuine database read, for compose healthchecks. */
export async function GET() {
  try {
    const users = get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)?.n ?? 0;
    const events = get<{ n: number }>(`SELECT COUNT(*) AS n FROM events`)?.n ?? 0;
    return Response.json(
      { status: "ok", database: "reachable", users, events, time: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { status: "error", database: "unreachable", message: err instanceof Error ? err.message : "unknown" },
      { status: 503 },
    );
  }
}
