import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEMO_SESSIONS } from '../../src/domain/demo.ts';
import { FIXTURES, startServer } from '../helpers.ts';

/**
 * The DOGFOOD rules, one test each: "the five things" that are required, the documents, the
 * `.dogfood.toml` contract and the three first-hour tips from the kickoff message. The seven
 * checks themselves are in checker.test.ts; the network-off run is scripts/offline-check.sh (CI).
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const KICKOFF = '2026-09-26T18:00:00Z';

/** The subset of TOML that .dogfood.toml uses: [sections], key = "string" and key = ["a", "b"]. */
function parseToml(text: string): Record<string, Record<string, string | string[]>> {
  const out: Record<string, Record<string, string | string[]>> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([a-z_]+)\]$/.exec(line);
    if (header) { section = header[1] as string; out[section] = {}; continue; }
    const pair = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    assert.ok(pair && section, `unparsed line: ${line}`);
    const value = pair[2] as string;
    (out[section] as Record<string, string | string[]>)[pair[1] as string] = value.startsWith('[') ? (JSON.parse(value) as string[]) : (JSON.parse(value) as string);
  }
  return out;
}

const toml = parseToml(read('.dogfood.toml'));
const report = read('acceptance-report.txt');
const fixture = JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as { event: { id: string; submissions_close: string }; projects: unknown[]; scores: unknown[] };

describe('required 1: docker compose up brings up a working, seeded portal with the network off', () => {
  test('docker-compose.yml at the root builds this repository, seeds the fixtures and publishes the base_url port', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /^\s+build: \.$/m);
    assert.doesNotMatch(compose, /^\s+image:/m, 'nothing pulled from a registry but the Dockerfile base image');
    assert.match(compose, /FORGEBOARD_SEED_FIXTURES: "1"/);
    assert.match(compose, /FORGEBOARD_DEMO: "1"/);
    const port = new URL(toml.portal?.base_url as string).port;
    assert.match(compose, new RegExp(`"${port}:8080"`));
  });

  test('one service only: no hosted or sidecar database, queue or mail server', () => {
    const services = read('docker-compose.yml').split('\nvolumes:')[0]?.match(/^ {2}[a-z0-9_-]+:$/gm) ?? [];
    assert.deepEqual(services.map((s) => s.trim()), ['forgeboard:']);
  });

  test('the image needs no package download: Node 24 on Alpine, no npm install, no apk add', () => {
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /^FROM node:24-alpine$/m);
    const run = dockerfile.split('\n').filter((line) => /^RUN /.test(line));
    for (const line of run) assert.doesNotMatch(line, /npm (install|ci)|yarn|pnpm|apk add|pip install|curl |wget /, line);
    assert.match(dockerfile, /HEALTHCHECK[^\n]*\\\n[^\n]*http:\/\/127\.0\.0\.1:8080\/healthz/, 'the health check stays inside the container');
    assert.match(dockerfile, /COPY package\.json fixtures\.json/);
  });

  test('zero runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  test('nothing the portal serves loads anything from the network (no CDN, fonts or external scripts)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|js|css|svg|html)$/.test(entry.name)) {
          for (const m of fs.readFileSync(path.join(ROOT, rel), 'utf8').matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
            if (!/^https?:\/\/(localhost|127\.0\.0\.1|www\.w3\.org|example\.(org|com))/.test(m[0])) offenders.push(`${rel}: ${m[0]}`);
          }
        }
      }
    };
    walk('src');
    walk('static');
    assert.deepEqual(offenders, []);
  });

  test('a fresh start seeds itself from fixtures.json: the event, every project and every score', async () => {
    const server = await startServer();
    try {
      const store = server.booted.store;
      assert.equal(store.get<{ n: number }>('SELECT count(*) AS n FROM events')?.n, 1);
      assert.equal(store.get<{ n: number }>('SELECT count(*) AS n FROM projects')?.n, fixture.projects.length);
      assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM reviews WHERE status = 'submitted'")?.n, fixture.scores.length);
    } finally {
      await server.close();
    }
  });
});

describe('required 2: an OSI-approved licence', () => {
  test('LICENSE is the MIT licence, and package.json says so', () => {
    assert.match(read('LICENSE'), /^MIT License\n/);
    assert.match(read('LICENSE'), /Permission is hereby granted, free of charge/);
    assert.equal((JSON.parse(read('package.json')) as { license: string }).license, 'MIT');
  });
});

describe('required 3: code written during the event window', () => {
  test('every commit in the history is dated after kickoff (26 Sep 2026, 18:00 UTC)', (t) => {
    const log = spawnSync('git', ['-C', ROOT, 'log', '--format=%aI %cI'], { encoding: 'utf8' });
    const lines = log.status === 0 ? log.stdout.trim().split('\n').filter(Boolean) : [];
    if (lines.length < 2) return t.skip('no full git history here (a shallow CI checkout or a copy without .git)');
    const early = lines.filter((line) => line.split(' ').some((d) => new Date(d) < new Date(KICKOFF)));
    assert.deepEqual(early, []);
  });
});

describe('required 4: .dogfood.toml at the root, with honest tier claims', () => {
  test('it has the four sections run.py reads', () => {
    assert.deepEqual(Object.keys(toml).sort(), ['auth', 'portal', 'routes', 'tiers']);
    assert.match(toml.portal?.base_url as string, /^http:\/\/localhost:\d+$/);
    assert.ok((toml.tiers?.pitch as string).length > 20, 'a one-line pitch');
  });

  test('[auth] gives a working header for each of the four roles, the ones the seed creates', () => {
    for (const role of ['organizer', 'judge_a', 'judge_b', 'participant'] as const) {
      assert.equal(toml.auth?.[role], `Cookie: session=${DEMO_SESSIONS[role]}`);
    }
  });

  test('[routes] names all five routes the checker visits, and peer_scores asks for judge A', () => {
    assert.deepEqual(Object.keys(toml.routes ?? {}).sort(), ['csv_export', 'gallery', 'judge_scores', 'peer_scores', 'submit']);
    assert.match(toml.routes?.peer_scores as string, /judge=jdg_24$/, "jdg_24 is judge_a's account");
  });

  test('the claim is exactly what the committed report verified: no inflated tier', () => {
    const verified = /claimed (.+), verified (.+)$/m.exec(report);
    assert.ok(verified);
    assert.deepEqual(toml.tiers?.claimed, ['T1', 'T2']);
    assert.equal(verified[1], (toml.tiers?.claimed as string[]).join(' '));
    assert.equal(verified[2], verified[1]);
    assert.doesNotMatch(report, /claimed but not verified/);
  });
});

describe('required 5: acceptance-report.txt committed', () => {
  test('it is run.py output for this portal: seven checks, all PASS', () => {
    assert.match(report, /^DOGFOOD 2026 acceptance report\n/);
    assert.match(report, new RegExp(`^portal: ${toml.portal?.base_url}$`, 'm'));
    assert.match(report, /^fixtures: fixtures\.json$/m);
    assert.equal(report.match(/ PASS$/gm)?.length, 7);
    assert.doesNotMatch(report, /FAIL/);
  });

  test('run.py and fixtures.json are the organizers’ files, unmodified', () => {
    // sha256 prefixes of the files published at dogfoodhack.com/spec (checked on 23 and 27 Sep).
    const sha = (file: string) => spawnSync(process.execPath, ['-e', `process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(${JSON.stringify(path.join(ROOT, file))})).digest('hex'))`], { encoding: 'utf8' }).stdout;
    assert.ok(sha('run.py').startsWith('aa989638'), 'run.py');
    assert.ok(sha('fixtures.json').startsWith('252896bc'), 'fixtures.json');
  });
});

describe('the documents', () => {
  const doc = (file: string, min: number) => {
    const text = read(file);
    assert.ok(text.split(/\s+/).length >= min, `${file} has at least ${min} words`);
    return text;
  };

  test('README.md: what it does, how to run it, and what it does not do yet', () => {
    const readme = doc('README.md', 2000);
    assert.match(readme, /docker compose up/);
    assert.match(readme, /python3 run\.py \.dogfood\.toml/);
    assert.match(readme, /^## \d+\. Honest limitations$/m);
  });

  test('ARCHITECTURE.md: the shape of the system and why', () => {
    doc('ARCHITECTURE.md', 800);
  });

  test('DATA-MODEL.md: the schema, and the ways in and out', () => {
    const text = doc('DATA-MODEL.md', 800);
    assert.match(text, /import/i);
    assert.match(text, /export/i);
    assert.match(text, /CREATE TABLE|`[a-z_]+` \|/);
  });

  test('JUDGING.md: assignment, scoring maths and the normalization method, defended on the fixture', () => {
    const text = doc('JUDGING.md', 2000);
    for (const topic of [/assign/i, /weight/i, /normali[sz]/i, /jdg_07/, /prj_41|duplicate/i, /λ|lambda/i]) assert.match(text, topic);
  });

  test('THREAT-MODEL.md (bonus): the attacks stopped and the ones not stopped', () => {
    const text = doc('THREAT-MODEL.md', 800);
    assert.match(text, /sybil|ballot|collu/i);
  });
});

describe('the kickoff message: three things worth doing in the first hour', () => {
  test("1. the event is seeded with the fixture's own submissions_close, so the closed-event check holds", async () => {
    const server = await startServer();
    try {
      const close = server.booted.store.get<{ c: string }>('SELECT submissions_close_at AS c FROM events WHERE id = ?', [fixture.event.id])?.c;
      assert.equal(new Date(close as string).toISOString(), new Date(fixture.event.submissions_close).toISOString());
    } finally {
      await server.close();
    }
  });

  describe('2. the seed prints the four auth headers at startup, exactly as .dogfood.toml has them', () => {
    let output = '';
    let dir = '';
    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-banner-'));
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'server.ts')], {
        env: { ...process.env, FORGEBOARD_DB_PATH: path.join(dir, 'b.db'), FORGEBOARD_FIXTURES: FIXTURES, FORGEBOARD_DEMO: '1', FORGEBOARD_SEED_FIXTURES: '1', FORGEBOARD_PORT: '0', FORGEBOARD_HOST: '127.0.0.1', FORGEBOARD_QUIET: '' },
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no banner: ${output}`)), 20_000);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('DEMO MODE')) { clearTimeout(timer); resolve(); }
        });
      });
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const role of ['organizer', 'judge_a', 'judge_b', 'participant']) {
      test(`${role}`, () => {
        assert.ok(output.includes(toml.auth?.[role] as string), `${role}'s header in:\n${output}`);
      });
    }
  });

  test('3. the checker was run and its report committed whatever it said (and CI reruns it on every push)', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'acceptance-report.txt')));
    assert.match(read('.github/workflows/ci.yml'), /python3 run\.py \.dogfood\.toml > report\.txt[\s\S]*diff -u acceptance-report\.txt report\.txt/);
  });
});
