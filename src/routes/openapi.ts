/**
 * The API as an OpenAPI 3.1 document, served at GET /api/openapi.json.
 *
 * API first: every form in the UI posts to a route that also takes JSON, runs the same domain
 * function, and answers a JSON caller with JSON (`{ ok, location, message }`) instead of a
 * redirect. So every action a person can take in the UI is an API call, and all of them are
 * described here. tests/http/openapi.test.ts holds this document to the router: every route that
 * accepts a POST is documented, nothing documented is missing from the router, and every form the
 * UI renders, as every role, posts only fields that its operation describes.
 */

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json, description: string) => ({ description, content: { 'application/json': { schema } } });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [String(code), { $ref: `#/components/responses/E${code}` }]));
const path = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
const query = (name: string, description: string, schema: Json = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
const body = (properties: Json, required: string[] = []) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties, required } } },
});
const csrfNote = 'Send it as JSON (`Content-Type: application/json`): a cross-site page cannot, so JSON requests need no form token.';

export function openApiDocument(): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Forgeboard API',
      version: '1.0.0',
      summary: 'Self-hosted hackathon submissions, judging, community vote and signed results.',
      description:
        'Sign in with `POST /login` (JSON) and send the `session` cookie it sets. Every rule the pages enforce applies here: ' +
        'judges read only their own scores, drafts stay private, deadlines are checked in the write transaction, and every refusal is audited. ' +
        'Errors are JSON `{ "error": "…", "status": 403 }` when the request asks for JSON.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/', description: 'This Forgeboard instance' }],
    tags: [
      { name: 'account', description: 'Signing in, accounts and who you are' },
      { name: 'teams', description: 'Forming a team' },
      { name: 'organize', description: 'Running an event: settings, tracks, prizes, rubric, judges, assignments, publishing' },
      { name: 'admin', description: 'Instance administration' },
      { name: 'events', description: 'Events, rubric, progress and results' },
      { name: 'projects', description: 'Submissions and the public gallery' },
      { name: 'judging', description: 'Scores and pairwise comparisons' },
      { name: 'community', description: 'The community vote and comments (T3)' },
      { name: 'exports', description: 'Data out, for organizers' },
    ],
    security: [{ session: [] }, {}],
    paths: {
      '/login': {
        post: {
          tags: ['account'], operationId: 'signIn', summary: 'Sign in and receive the session cookie', security: [],
          requestBody: body({ email: { type: 'string', format: 'email' }, password: { type: 'string' } }, ['email', 'password']),
          responses: { 200: json({ type: 'object', properties: { user: ref('User') } }, 'Signed in; the response sets the `session` cookie'), ...errors(401, 429) },
        },
      },
      '/api': {
        get: { tags: ['account'], operationId: 'apiIndex', summary: 'A short index of the API, pointing here', security: [], responses: { 200: json({ type: 'object' }, 'The index') } },
      },
      '/api/me': {
        get: {
          tags: ['account'], operationId: 'me', summary: 'You, and your roles per event',
          responses: { 200: json({ type: 'object', properties: { user: ref('User'), events: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' }, roles: { type: 'array', items: { enum: ['organizer', 'judge', 'participant'] } } } } } } }, 'Your account'), ...errors(401) },
        },
      },
      '/api/events': {
        get: { tags: ['events'], operationId: 'listEvents', summary: 'All events', security: [], responses: { 200: json({ type: 'object', properties: { events: { type: 'array', items: ref('Event') } } }, 'Every event, with counts') } },
      },
      '/api/events/{id}': {
        get: {
          tags: ['events'], operationId: 'getEvent', summary: 'One event with its tracks, prizes and rubric', security: [],
          parameters: [path('id', 'Event id, e.g. evt_01')],
          responses: { 200: json({ type: 'object', properties: { event: ref('Event'), tracks: { type: 'array', items: { type: 'object' } }, prizes: { type: 'array', items: { type: 'object' } }, rubric: { type: 'array', items: ref('Criterion') } } }, 'The event'), ...errors(404) },
        },
      },
      '/api/events/{id}/results': {
        get: {
          tags: ['events'], operationId: 'getResults', summary: 'Published results (hidden until the organizers publish)', security: [],
          parameters: [path('id', 'Event id')],
          responses: { 200: json({ type: 'object', properties: { published: { type: 'boolean' }, message: { type: 'string' }, snapshot: { type: 'object' }, rows: { type: 'array', items: { type: 'object' } } }, required: ['published'] }, 'Results, or `published: false`'), ...errors(404) },
        },
      },
      '/events/{slug}/results.json': {
        get: {
          tags: ['events'], operationId: 'getSignedResults', security: [],
          summary: 'The signed results document: Ed25519 signature, public key, ranking with 90% rank intervals, method commitment and audit anchor',
          parameters: [path('slug', 'Event slug, e.g. sample-hack-2026')],
          responses: { 200: json(ref('SignedResults'), 'Verify offline with `node src/cli.ts verify-results <file>`'), ...errors(404) },
        },
      },
      '/organize/{slug}/results/capsule.html': {
        get: {
          tags: ['events'], operationId: 'getResultsCapsule', summary: 'A self-verifying results file with the pseudonymized inputs (organizers)',
          parameters: [path('slug', 'Event slug')],
          responses: { 200: { description: 'One HTML file that checks its signature and refits the ranking in any browser, offline', content: { 'text/html': { schema: { type: 'string' } } } }, ...errors(401, 403, 404, 409) },
        },
      },
      '/api/events/{id}/progress': {
        get: {
          tags: ['events'], operationId: 'getProgress', summary: 'Judging progress: reviews done, gaps and stragglers (organizers)',
          parameters: [path('id', 'Event id')],
          responses: { 200: json({ type: 'object' }, 'Progress per project and judge'), ...errors(401, 403, 404) },
        },
      },
      '/api/projects': {
        get: {
          tags: ['projects'], operationId: 'listProjects', summary: 'The public gallery', security: [],
          parameters: [
            query('q', 'Search title, summary, team and track'),
            query('event', 'Event id or slug'),
            query('track', 'Track id'),
            query('sort', 'Order', { enum: ['oldest', 'newest', 'title'] }),
            query('page', 'Page, from 1', { type: 'integer', minimum: 1 }),
          ],
          responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: ref('ProjectCard') }, total: { type: 'integer' }, page: { type: 'integer' } } }, 'One page of submitted projects') },
        },
      },
      '/api/projects/{id}': {
        get: {
          tags: ['projects'], operationId: 'getProject', summary: 'One project, if you may see it (drafts only to their team and organizers)', security: [],
          parameters: [path('id', 'Project id, e.g. prj_01')],
          responses: { 200: json({ type: 'object', properties: { project: { type: 'object' }, team: { type: 'object' }, track: { type: ['string', 'null'] }, event: { type: 'string' } } }, 'The project'), ...errors(404) },
        },
      },
      '/projects/new': {
        post: {
          tags: ['projects'], operationId: 'createProject', summary: 'Create a project for your team (before the deadline)', description: csrfNote,
          parameters: [{ ...query('event', 'Event id'), required: true }],
          requestBody: body({ ...projectFields(), intent: { enum: ['draft', 'submit'] } }, ['title']),
          responses: { 200: json({ type: 'object' }, 'Created'), 201: json({ type: 'object' }, 'Created'), ...errors(400, 401, 403, 409, 422) },
        },
      },
      '/projects/{id}/edit': {
        post: {
          tags: ['projects'], operationId: 'updateProject', summary: 'Update your project (before the deadline; `version` detects a teammate’s concurrent edit)', description: csrfNote,
          parameters: [path('id', 'Project id')],
          requestBody: body({ ...projectFields(), version: { type: 'integer' }, intent: { enum: ['draft', 'submit'] } }),
          responses: { 200: json({ type: 'object' }, 'Saved'), ...errors(400, 401, 403, 404, 409, 422) },
        },
      },
      '/api/judge/scores': {
        get: {
          tags: ['judging'], operationId: 'judgeScores',
          summary: 'Your own scores as a judge; another judge’s only as an organizer of their event',
          description: 'A judge asking for another judge’s scores gets 403, decided before the target is looked up, and the refusal is written to the audit trail.',
          parameters: [query('judge', 'Another judge’s id (organizers only)'), query('event', 'Limit to one event')],
          responses: { 200: json(ref('JudgeScores'), 'The scores'), ...errors(401, 403, 404) },
        },
      },
      '/judge/{slug}/compare': {
        post: {
          tags: ['judging'], operationId: 'compare', summary: 'Compare mode: which of two of your assigned projects is better (once per pair)', description: csrfNote,
          parameters: [path('slug', 'Event slug')],
          requestBody: body({ winner: { type: 'string' }, loser: { type: 'string' } }, ['winner', 'loser']),
          responses: { 200: json({ type: 'object' }, 'Recorded'), ...errors(400, 401, 403, 409) },
        },
      },
      '/api/events/{id}/vote': {
        get: {
          tags: ['community'], operationId: 'getVote', summary: 'The community vote: window and phase; the tally for organizers, and for everyone once published', security: [],
          parameters: [path('id', 'Event id')],
          responses: { 200: json({ type: 'object' }, 'The vote'), ...errors(404) },
        },
      },
      '/events/{slug}/vote': {
        post: {
          tags: ['community'], operationId: 'castBallot', summary: 'Cast a ballot: approve up to the event’s limit. One per account, or per voter code', description: csrfNote, security: [{ session: [] }, {}],
          parameters: [path('slug', 'Event slug')],
          requestBody: body({ pick: { type: 'array', items: { type: 'string' } }, code: { type: 'string', description: 'Voter code, when the vote uses codes' } }, ['pick']),
          responses: { 200: json({ type: 'object' }, 'Ballot cast'), ...errors(400, 401, 403, 409, 429) },
        },
      },
      '/projects/{id}/comments': {
        post: {
          tags: ['community'], operationId: 'comment', summary: 'Comment on a public project (signed in; rate limited)', description: csrfNote,
          parameters: [path('id', 'Project id')],
          requestBody: body({ body: { type: 'string', maxLength: 2000 } }, ['body']),
          responses: { 200: json({ type: 'object' }, 'Posted'), 201: json({ type: 'object' }, 'Posted'), ...errors(400, 401, 403, 404, 429) },
        },
      },
      '/comments/{id}/hide': {
        post: {
          tags: ['community'], operationId: 'hideComment', summary: 'Withdraw your comment, or hide one as an organizer (with a reason)', description: csrfNote,
          parameters: [path('id', 'Comment id')],
          requestBody: body({ reason: { type: 'string' } }),
          responses: { 200: json({ type: 'object' }, 'Hidden'), ...errors(401, 403, 404) },
        },
      },
      '/api/export.csv': {
        get: {
          tags: ['exports'], operationId: 'exportCsv', summary: 'CSV exports (organizers). Without `event`, the one event you organize',
          parameters: [query('event', 'Event id'), query('kind', 'What to export', { enum: ['results', 'reviews', 'projects', 'judges', 'assignments', 'votes', 'audit'], default: 'results' })],
          responses: { 200: { description: 'RFC 4180 CSV; cells that a spreadsheet would run as a formula are neutralized', content: { 'text/csv': { schema: { type: 'string' } } } }, ...errors(400, 401, 403, 404) },
        },
      },
      '/api/openapi.json': {
        get: { tags: ['account'], operationId: 'openApi', summary: 'This document', security: [], responses: { 200: json({ type: 'object' }, 'OpenAPI 3.1') } },
      },
      ...actionPaths(),
    },
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'session', description: 'Set by POST /login. HttpOnly, SameSite=Lax.' },
      },
      responses: Object.fromEntries(
        [
          [400, 'The request is malformed'],
          [401, 'Not signed in'],
          [403, 'Signed in, but your role does not allow this; the refusal is audited'],
          [404, 'Not found, or not visible to you'],
          [409, 'Conflicts with the event’s state, such as a closed deadline, or with existing data'],
          [410, 'The one-time link has expired or was already used'],
          [422, 'Validation failed; `fields` names each problem'],
          [429, 'Too many attempts; try again later'],
        ].map(([code, description]) => [`E${code}`, json(ref('Error'), description as string)]),
      ),
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' }, status: { type: 'integer' }, fields: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['error', 'status'] },
        User: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, admin: { type: 'boolean' } } },
        Event: {
          type: 'object',
          properties: {
            id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, tagline: { type: ['string', 'null'] }, description: { type: ['string', 'null'] },
            phase: { type: 'string' }, submissions_open_at: { type: ['string', 'null'] }, submissions_close_at: { type: 'string' }, judging_close_at: { type: ['string', 'null'] },
            results_published_at: { type: ['string', 'null'] }, max_team_size: { type: 'integer' }, score_scale: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          },
        },
        Criterion: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' }, description: { type: ['string', 'null'] }, weight: { type: 'number' } } },
        ProjectCard: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, team: { type: 'string' }, track: { type: ['string', 'null'] }, event: { type: 'string' },
            repo_url: { type: ['string', 'null'] }, demo_url: { type: ['string', 'null'] }, video_url: { type: ['string', 'null'] }, submitted_at: { type: ['string', 'null'] }, rank: { type: ['integer', 'null'] },
          },
        },
        JudgeScores: {
          type: 'object',
          properties: {
            judge: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
            events: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
            scores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  event_id: { type: 'string' }, assignment_id: { type: 'string' }, project_id: { type: 'string' }, project_title: { type: 'string' },
                  status: { enum: ['draft', 'submitted'] }, criteria: { type: 'object', additionalProperties: { type: 'number' } }, weighted: { type: ['number', 'null'] },
                  comment: { type: 'string' }, submitted_at: { type: ['string', 'null'] }, updated_at: { type: 'string' },
                },
              },
            },
          },
        },
        ActionResult: {
          type: 'object',
          description: 'What a form action returns to a JSON caller: whether it succeeded, the message the page would have shown, and where the page would go next.',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' }, location: { type: 'string' } },
          required: ['ok', 'location'],
        },
        SignedResults: {
          type: 'object',
          properties: {
            document_text: { type: 'string', description: 'The signed JSON, exactly as signed (UTF-8)' },
            signature: { type: 'string', description: 'Ed25519 signature, base64' },
            public_key: { type: 'string', description: 'The instance’s Ed25519 public key' },
            how_to_verify: { type: 'string' },
          },
          required: ['document_text', 'signature', 'public_key'],
        },
      },
    },
  };
}

function projectFields(): Json {
  return {
    title: { type: 'string', maxLength: 120 },
    summary: { type: 'string' },
    description: { type: 'string' },
    track_id: { type: 'string' },
    repo_url: { type: 'string', format: 'uri' },
    demo_url: { type: 'string', format: 'uri' },
    video_url: { type: 'string', format: 'uri' },
  };
}

// Every other form action in the UI. Each takes the form's fields as JSON under the same names.

interface Action {
  tag: string;
  summary: string;
  who: string;
  fields?: Json;
  patterns?: Json;
  errors?: number[];
  security?: 'none';
}

const str = (description?: string): Json => (description ? { type: 'string', description } : { type: 'string' });
const when = (description: string): Json => ({ type: 'string', format: 'date-time', description });
const ids = (description: string): Json => ({ type: 'array', items: { type: 'string' }, description });
const eventFields = (): Json => ({
  name: str(), tagline: str(), description: str(),
  submissions_open_at: when('UTC, e.g. 2026-09-26T18:00'), submissions_close_at: when('UTC'), judging_close_at: when('UTC'),
  max_team_size: { type: 'integer', minimum: 1 }, reviews_per_project: { type: 'integer', minimum: 1 },
});

const ACTIONS: Record<string, Action> = {
  'POST /logout': { tag: 'account', summary: 'Sign out (ends this session)', who: 'signed in', errors: [] },
  'POST /signup': { tag: 'account', summary: 'Create an account and sign in', who: 'anyone', security: 'none', fields: { name: str(), email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } }, errors: [409, 422, 429] },
  'POST /account/password': { tag: 'account', summary: 'Change your password (signs out your other sessions)', who: 'signed in', fields: { current_password: str(), new_password: str(), username: str('Ignored; lets password managers file the change') }, errors: [401, 422] },
  'POST /password/{token}': { tag: 'account', summary: 'Set a password with a one-time link (claiming an imported or invited account, or a reset)', who: 'holder of the link', security: 'none', fields: { password: str() }, errors: [404, 410, 422] },
  'POST /judge-invite/{token}': { tag: 'judging', summary: 'Accept a judge invitation (and set a password if the account is new)', who: 'holder of the link', security: 'none', fields: { password: str('Only for an account without one') }, errors: [404, 409, 410, 422] },
  'POST /judge/reviews/{id}': { tag: 'judging', summary: 'Save or submit your review of an assigned project', who: 'the judge it is assigned to (403 for everyone else, organizers included)', fields: { intent: { enum: ['draft', 'submit'] }, comment: str() }, patterns: { '^score_[a-z0-9_]+$': { type: 'integer', description: 'One per rubric criterion, on the event scale' } }, errors: [401, 403, 409, 422] },
  'POST /events/{slug}/team': { tag: 'teams', summary: 'Start a team in the event', who: 'signed in, not a judge or organizer of the event', fields: { name: str() }, errors: [401, 403, 409, 422] },
  'POST /events/{slug}/team/invite': { tag: 'teams', summary: 'Make a new invite link for your team (the old one stops working)', who: 'the team captain', errors: [401, 403, 409] },
  'POST /events/{slug}/team/leave': { tag: 'teams', summary: 'Leave your team', who: 'a team member', errors: [401, 403, 409] },
  'POST /join/{token}': { tag: 'teams', summary: 'Join a team with its invite link', who: 'signed in, holder of the link', errors: [401, 403, 404, 409] },
  'POST /projects/{id}/withdraw': { tag: 'projects', summary: 'Withdraw your project', who: 'a member of its team', errors: [401, 403, 404, 409] },
  'POST /events/{slug}/vote/code': { tag: 'community', summary: 'Check a voter code before voting with it', who: 'anyone (rate limited)', security: 'none', fields: { code: str() }, errors: [404, 409, 429] },
  'POST /events/new': { tag: 'admin', summary: 'Create an event (with its first tracks, one per line)', who: 'an administrator', fields: { ...eventFields(), tracks: str('One track name per line') }, errors: [401, 403, 422] },
  'POST /admin/organizers': { tag: 'admin', summary: 'Appoint an organizer of an event (audited in that event)', who: 'an administrator', fields: { event_id: str(), email: { type: 'string', format: 'email' } }, errors: [401, 403, 404, 422] },
  'POST /admin/users/{id}/admin': { tag: 'admin', summary: 'Grant or remove administrator rights', who: 'an administrator', fields: { admin: { enum: ['1', '0'] } }, errors: [401, 403, 404, 409] },
  'POST /admin/users/{id}/link': { tag: 'admin', summary: 'Make a one-time password link for an account (there is no mail server)', who: 'an administrator', errors: [401, 403, 404] },
  'POST /organize/{slug}/settings': { tag: 'organize', summary: 'Edit the event: name, text, dates, team size, reviews per project', who: 'an organizer', fields: eventFields(), errors: [401, 403, 409, 422] },
  'POST /organize/{slug}/tracks': { tag: 'organize', summary: 'Add a track', who: 'an organizer', fields: { name: str() }, errors: [401, 403, 409, 422] },
  'POST /organize/{slug}/tracks/{id}/remove': { tag: 'organize', summary: 'Remove a track that no project uses', who: 'an organizer', errors: [401, 403, 404, 409] },
  'POST /organize/{slug}/prizes': { tag: 'organize', summary: 'Add a prize, overall or for one track', who: 'an organizer', fields: { name: str(), description: str(), track_id: str('Empty for an overall prize') }, errors: [401, 403, 422] },
  'POST /organize/{slug}/prizes/{id}/remove': { tag: 'organize', summary: 'Remove a prize', who: 'an organizer', errors: [401, 403, 404] },
  'POST /organize/{slug}/organizers': { tag: 'organize', summary: 'Add a co-organizer (not someone who judges the event: organizers read every score)', who: 'an organizer', fields: { email: { type: 'string', format: 'email' } }, errors: [401, 403, 404, 422] },
  'POST /organize/{slug}/rubric': { tag: 'organize', summary: 'Edit the rubric: scale, criteria, weights, and add or remove a criterion (every change audited; the method commitment records it)', who: 'an organizer', fields: { score_min: { type: 'integer' }, score_max: { type: 'integer' }, new_name: str(), new_description: str(), new_weight: { type: 'number' } }, patterns: { '^(name|description)_crt_[A-Za-z0-9_]+$': { type: 'string' }, '^weight_crt_[A-Za-z0-9_]+$': { type: 'number' }, '^remove_crt_[A-Za-z0-9_]+$': { type: 'string', description: 'Present to remove that criterion' } }, errors: [401, 403, 409, 422] },
  'POST /organize/{slug}/judges': { tag: 'organize', summary: 'Invite a judge and choose their tracks; returns the one-time invite link', who: 'an organizer', fields: { name: str(), email: { type: 'string', format: 'email' }, track_ids: ids('Tracks this judge covers') }, errors: [401, 403, 422] },
  'POST /organize/{slug}/judges/{id}/tracks': { tag: 'organize', summary: "Change a judge's tracks", who: 'an organizer', fields: { track_ids: ids('Tracks this judge covers') }, errors: [401, 403, 404] },
  'POST /organize/{slug}/judges/{id}/remove': { tag: 'organize', summary: 'Remove a judge (only one with no submitted review)', who: 'an organizer', errors: [401, 403, 404, 409] },
  'POST /organize/{slug}/assignments': { tag: 'organize', summary: 'Assign a judge to a project by hand (conflicts of interest refused)', who: 'an organizer', fields: { judge_id: str(), project_id: str() }, errors: [401, 403, 409, 422] },
  'POST /organize/{slug}/assignments/auto': { tag: 'organize', summary: 'Fill every project up to its review target: track-aware, conflict-free, balanced; reports what it could not fill', who: 'an organizer', errors: [401, 403, 409] },
  'POST /organize/{slug}/assignments/{id}/remove': { tag: 'organize', summary: 'Remove an assignment that has no submitted review', who: 'an organizer', errors: [401, 403, 404, 409] },
  'POST /organize/{slug}/close-submissions': { tag: 'organize', summary: 'Close submissions now', who: 'an organizer', errors: [401, 403, 409] },
  'POST /organize/{slug}/projects/{id}/count': { tag: 'organize', summary: 'Reverse a duplicate decision: make this project the one that counts for its team (audited)', who: 'an organizer', errors: [401, 403, 404, 409] },
  'POST /organize/{slug}/results/publish': { tag: 'organize', summary: 'Publish results: freezes the method, weights and λ, closes judging, signs the snapshot with Ed25519', who: 'an organizer', errors: [401, 403, 409] },
  'POST /organize/{slug}/results/unpublish': { tag: 'organize', summary: 'Take published results down (the signed snapshot is kept, marked superseded)', who: 'an organizer', errors: [401, 403, 409] },
  'POST /organize/{slug}/voting': { tag: 'community', summary: 'Set up the community vote: window, how many picks, accounts or voter codes', who: 'an organizer', fields: { opens_at: when('UTC'), closes_at: when('UTC'), max_picks: { type: 'integer', minimum: 1 }, access: { enum: ['accounts', 'codes'] } }, errors: [401, 403, 409, 422] },
  'POST /organize/{slug}/voting/codes': { tag: 'community', summary: 'Print a batch of one-time voter codes (only their hashes are stored)', who: 'an organizer', fields: { count: { type: 'integer', minimum: 1, maximum: 500 } }, errors: [401, 403, 422] },
  'POST /organize/{slug}/voting/ballots/{id}/void': { tag: 'community', summary: 'Void a ballot, with a written reason (audited)', who: 'an organizer', fields: { reason: str() }, errors: [401, 403, 404, 422] },
  'POST /organize/{slug}/voting/publish': { tag: 'community', summary: 'Publish the vote tally', who: 'an organizer', errors: [401, 403, 409] },
};

function actionPaths(): Record<string, Json> {
  const paths: Record<string, Json> = {};
  for (const [key, action] of Object.entries(ACTIONS)) {
    const [method, route] = key.split(' ') as [string, string];
    const params = [...route.matchAll(/\{([a-z]+)\}/g)].map((m) => path(m[1] as string, m[1] === 'slug' ? 'Event slug' : m[1] === 'token' ? 'The one-time token from the link' : 'Id'));
    const hasBody = action.fields || action.patterns;
    const operation: Json = {
      tags: [action.tag],
      operationId: operationId(method, route),
      summary: action.summary,
      description: `Who: ${action.who}. ${csrfNote}`,
      ...(params.length ? { parameters: params } : {}),
      ...(hasBody
        ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: action.fields ?? {}, ...(action.patterns ? { patternProperties: action.patterns } : {}) } } } } }
        : {}),
      responses: { 200: json(ref('ActionResult'), 'Done (or `ok: false` with the message the page would show)'), ...errors(...(action.errors ?? [401, 403])) },
      ...(action.security === 'none' ? { security: [] } : {}),
    };
    paths[route] = { ...(paths[route] ?? {}), [method.toLowerCase()]: operation };
  }
  return paths;
}

function operationId(method: string, route: string): string {
  const words = route.split('/').filter((w) => w && !w.startsWith('{')).flatMap((w) => w.split(/[-.]/));
  return method.toLowerCase() + words.map((w) => (w[0] ?? '').toUpperCase() + w.slice(1)).join('');
}
