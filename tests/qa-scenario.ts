import { Client, isoIn } from './helpers.ts';

/** Everyone the whole-portal tests act as, with the password each one signs in with. */
export interface Cast {
  roles: Record<string, Client>;
  passwords: Record<string, string>;
  joinLink: string;
}

/**
 * Seeds the states the fixture alone does not reach: an event still open for submissions,
 * a team with a draft, an invited judge who has claimed the account, and a signed-up person
 * with no team. With `stage`, it also moves the fixture event on: 'judging' auto-assigns (so
 * judges have unfinished work) and submits the draft; 'published' also publishes the results.
 */
export async function seedScenario(base: string, stage: 'open' | 'judging' | 'published' = 'open'): Promise<Cast> {
  const admin = new Client(base);
  await admin.signIn('admin@forgeboard.local');
  await admin.postForm('/events/new', { name: 'QA Open', submissions_close_at: isoIn(180), tracks: 'Alpha\nBeta', max_team_size: '3', reviews_per_project: '2' });
  await admin.postForm('/organize/qa-open/prizes', { name: 'Best Alpha', description: 'A prize' });
  const tracks = (await admin.getJson('/api/events/qa-open')).json<{ tracks: { id: string }[] }>().tracks.map((t) => t.id);

  const alice = new Client(base);
  await alice.postForm('/signup', { name: 'QA Alice', email: 'qa-alice@example.com', password: 'alice-password' }, { tokenFrom: '/signup' });
  const team = await alice.postForm('/events/qa-open/team', { name: 'QA Team' });
  const joinLink = /value="https?:\/\/[^"]*(\/join\/[\w-]+)"/.exec(team.text)?.[1] ?? '';
  const draft = await alice.postForm('/projects/new?event=qa-open', { title: 'QA Draft', summary: 'Testing', track_id: tracks[0] ?? '', repo_url: 'https://example.org/qa', intent: 'draft' });
  const draftId = /\/projects\/(prj_\w+)/.exec(draft.headers.get('location') ?? '')?.[1] ?? '';

  const invite = await admin.postForm('/organize/qa-open/judges', { name: 'QA Judge', email: 'qa-judge@example.com', track_ids: [tracks[0] ?? ''] });
  const judgeLink = /value="https?:\/\/[^"]*(\/judge-invite\/[\w-]+)"/.exec(invite.text)?.[1] ?? '';
  const qaJudge = new Client(base);
  await qaJudge.postForm(judgeLink, { password: 'judge-password' }, { tokenFrom: judgeLink });

  const bob = new Client(base);
  await bob.postForm('/signup', { name: 'QA Bob', email: 'qa-bob@example.com', password: 'bob-password' }, { tokenFrom: '/signup' });

  const organizer = Client.as(base, 'organizer');
  if (stage !== 'open') {
    await organizer.postForm('/organize/sample-hack-2026/assignments/auto', {});
    await alice.postForm(`/projects/${draftId}/edit`, { version: '1', title: 'QA Draft', summary: 'Testing', track_id: tracks[0] ?? '', repo_url: 'https://example.org/qa', intent: 'submit' });
  }
  if (stage === 'published') await organizer.postForm('/organize/sample-hack-2026/results/publish', {});

  return {
    roles: {
      anon: new Client(base),
      participant: Client.as(base, 'participant'),
      judge_a: Client.as(base, 'judge_a'),
      judge_b: Client.as(base, 'judge_b'),
      organizer,
      admin,
      alice,
      bob,
      qaJudge,
    },
    passwords: { participant: 'forgeboard-demo', judge_a: 'forgeboard-demo', judge_b: 'forgeboard-demo', organizer: 'forgeboard-demo', admin: 'forgeboard-demo', alice: 'alice-password', bob: 'bob-password', qaJudge: 'judge-password' },
    joinLink,
  };
}

/** Same-site links on a page, in document order, with &amp; decoded. */
export function linksOf(html: string): string[] {
  return [...html.matchAll(/href="(\/[^"#]*)"/g)]
    .map((m) => (m[1] ?? '').replaceAll('&amp;', '&'))
    .filter((href) => !href.startsWith('//') && !href.startsWith('/static/'));
}
