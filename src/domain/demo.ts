import type { Store } from '../db/store.ts';
import { iso } from '../util/time.ts';
import { grantRole } from './access.ts';
import { ensureUser } from './accounts.ts';
import { record } from './audit.ts';
import { hashPassword } from './passwords.ts';
import { createSession } from './sessions.ts';
import type { Actor, UserRow } from './types.ts';

/**
 * Demo mode (FORGEBOARD_DEMO=1, set by docker-compose.yml) creates five known accounts and four
 * fixed session tokens so the DOGFOOD checker and a first-time visitor can act as each role.
 *
 * These tokens are published in the repository. They are a demo credential, like a default
 * password on a router: never enable demo mode on an instance that holds real data.
 */
export const DEMO_PASSWORD = 'forgeboard-demo';

export const DEMO_SESSIONS = {
  organizer: 'org_demo_7f2a9c41d8e3b6a5',
  judge_a: 'jdg_a_demo_91bc5e0f27d4a8c3',
  judge_b: 'jdg_b_demo_44de83a1c9f06b72',
  participant: 'prt_demo_2e88b7d14c6f3a19',
} as const;

export type DemoRole = keyof typeof DEMO_SESSIONS | 'admin';

export interface DemoAccount {
  role: DemoRole;
  user: UserRow;
  token: string | null;
}

/**
 * Picks judge A as the judge with the most submitted reviews, and judge B as the busiest judge
 * who shares no project with A, so "B reads A's scores" is a genuine cross-judge probe.
 * On the official fixtures this is jdg_24 (11 reviews) and jdg_29 (9 reviews).
 */
function pickJudges(store: Store, eventId: string): { a: UserRow; b: UserRow } | null {
  const judges = store.all<UserRow & { reviews: number }>(
    `SELECT u.*, count(v.assignment_id) AS reviews FROM event_roles r JOIN users u ON u.id = r.user_id
     LEFT JOIN assignments a ON a.judge_id = u.id AND a.event_id = r.event_id
     LEFT JOIN reviews v ON v.assignment_id = a.id AND v.status = 'submitted'
     WHERE r.event_id = ? AND r.role = 'judge' GROUP BY u.id ORDER BY reviews DESC, u.id`,
    [eventId],
  );
  const a = judges[0];
  if (!a) return null;
  const projectsOf = (judgeId: string) =>
    new Set(store.all<{ project_id: string }>('SELECT project_id FROM assignments WHERE event_id = ? AND judge_id = ?', [eventId, judgeId]).map((r) => r.project_id));
  const aProjects = projectsOf(a.id);
  const b = judges.slice(1).find((j) => [...projectsOf(j.id)].every((p) => !aProjects.has(p))) ?? judges[1];
  if (!b) return null;
  const { reviews: _a, ...judgeA } = a;
  const { reviews: _b, ...judgeB } = b;
  return { a: judgeA, b: judgeB };
}

/** The captain of the team behind the first project in the event (on the fixtures: priya1@example.org of NorthKiln). */
function pickParticipant(store: Store, eventId: string): UserRow | undefined {
  return store.get<UserRow>(
    `SELECT u.* FROM projects p JOIN team_members m ON m.team_id = p.team_id JOIN users u ON u.id = m.user_id
     WHERE p.event_id = ? ORDER BY p.id, m.is_captain DESC, m.joined_at LIMIT 1`,
    [eventId],
  );
}

export async function seedDemo(store: Store, actor: Actor, eventId: string): Promise<DemoAccount[]> {
  if (!store.get('SELECT 1 FROM events WHERE id = ?', [eventId])) return [];
  const judges = pickJudges(store, eventId);
  const participant = pickParticipant(store, eventId);
  if (!judges || !participant) return [];
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  return store.tx(() => {
    const now = iso(actor.now);
    const admin = ensureUser(store, 'admin@forgeboard.local', 'Demo Admin', actor.now, 'usr_demo_admin');
    store.run('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
    const organizer = ensureUser(store, 'organizer@forgeboard.local', 'Demo Organizer', actor.now, 'usr_demo_organizer');
    grantRole(store, eventId, organizer.id, 'organizer', admin.id, now);

    const accounts: DemoAccount[] = [
      { role: 'admin', user: admin, token: null },
      { role: 'organizer', user: organizer, token: DEMO_SESSIONS.organizer },
      { role: 'judge_a', user: judges.a, token: DEMO_SESSIONS.judge_a },
      { role: 'judge_b', user: judges.b, token: DEMO_SESSIONS.judge_b },
      { role: 'participant', user: participant, token: DEMO_SESSIONS.participant },
    ];
    for (const account of accounts) {
      store.run('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL', [passwordHash, account.user.id]);
      if (account.token) createSession(store, account.user.id, actor.now, { token: account.token, days: 365, demo: true });
    }
    // A community vote that is open for two weeks from the first boot, so T3 can be tried at once.
    if (!store.get('SELECT 1 FROM vote_settings WHERE event_id = ?', [eventId])) {
      store.run(
        "INSERT INTO vote_settings (event_id, opens_at, closes_at, access, max_picks, updated_at) VALUES (?, ?, ?, 'accounts', 3, ?)",
        [eventId, now, iso(new Date(actor.now.getTime() + 14 * 86_400_000)), now],
      );
      record(store, actor, { eventId, action: 'vote.configured', subjectType: 'event', subjectId: eventId, summary: 'Demo mode opened a community vote for signed-in accounts for two weeks, up to 3 approvals per ballot.' });
    }
    if (!store.get("SELECT 1 FROM audit_log WHERE action = 'demo.seeded'")) {
      record(store, actor, {
        eventId,
        action: 'demo.seeded',
        summary: `Demo mode created sign-ins for ${accounts.map((a) => `${a.role} (${a.user.email})`).join(', ')}.`,
      });
    }
    return accounts;
  });
}
