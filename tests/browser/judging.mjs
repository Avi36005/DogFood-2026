// The judging half of the lifecycle, in a real (headless) Chrome: a judge saves
// a partial draft, survives a reload and a failed save, submits; another judge
// is refused; the organizer computes and publishes; a visitor sees only the
// published projection; publication closes judging; and a recompute does not
// move the published standings until someone publishes again.
//
// Every actor gets their own browser, so no session is ever shared.
//
//   node judging.mjs <base-url> [event-slug]
import { launch, ARTIFACTS } from "./cdp.mjs";
import { mintSessions, runAgainstDb } from "./sessions.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SLUG = process.argv[3] ?? "autumn-build-2026";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql) => JSON.parse(runAgainstDb(
  `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.FORGEBOARD_DB_PATH);
   console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));`).trim().split("\n").pop());

const tokens = mintSessions();
const mintFor = (userId) => runAgainstDb(`
  import { DatabaseSync } from "node:sqlite"; import { randomBytes, createHash } from "node:crypto";
  const db = new DatabaseSync(process.env.FORGEBOARD_DB_PATH);
  const t = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)")
    .run("ses_" + randomBytes(10).toString("hex"), ${JSON.stringify(userId)}, createHash("sha256").update(t).digest("hex"),
         new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  console.log(t);`).trim().split("\n").pop();

// A judge with two assignments not yet submitted: one to judge now, one to
// submit after publication. The seeded demo judge has usually finished, so any
// judge in the event with unfinished work will do.
const unfinished = q(`SELECT a.judge_user_id AS judge, a.id FROM assignments a
    JOIN events e ON e.id = a.event_id LEFT JOIN reviews r ON r.assignment_id = a.id
   WHERE e.slug = '${SLUG}' AND IFNULL(r.status, '') <> 'submitted' ORDER BY a.judge_user_id, a.id`);
const byJudge = Map.groupBy(unfinished, (r) => r.judge);
const judgeId = [...byJudge.keys()].find((j) => byJudge.get(j).length >= 2);
if (!judgeId) throw new Error("no judge in this event has two unsubmitted assignments");
const [first, second] = byJudge.get(judgeId);
const judgeToken = mintFor(judgeId);
// A different judge, with a session of their own, who is not assigned that project.
const [otherJudge] = q(`SELECT DISTINCT a.judge_user_id AS id FROM assignments a
                         WHERE a.event_id = (SELECT event_id FROM assignments WHERE id = '${first.id}')
                           AND a.judge_user_id <> '${judgeId}'
                           AND a.judge_user_id NOT IN (SELECT judge_user_id FROM assignments
                                 WHERE project_id = (SELECT project_id FROM assignments WHERE id = '${first.id}')) LIMIT 1`);
const otherToken = mintFor(otherJudge.id);

const reviewOf = (assignmentId) => q(`SELECT status, raw_weighted FROM reviews WHERE assignment_id = '${assignmentId}'`)[0] ?? null;
const scoresOf = (assignmentId) => q(`SELECT cs.criterion_id, cs.score FROM criterion_scores cs
  JOIN reviews r ON r.id = cs.review_id WHERE r.assignment_id = '${assignmentId}'`);

const log = (...a) => console.log(...a);
let failures = 0;
const browsers = [];
async function actor(token) {
  const b = await launch();
  browsers.push(b);
  await b.viewport(1440, 1000);
  if (token) await b.cookie("forgeboard_session", token, BASE);
  return b;
}
async function step(b, label, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    log(`  ok   ${label}${note ? "  — " + note : ""}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failures++;
    log(`  FAIL ${label}: ${e.message}`);
    try { await b.screenshot(`fail-judging-${label.replace(/\W+/g, "-").slice(0, 50)}.png`); } catch {}
  }
}
const notice = (b) => b.eval(`[...document.querySelectorAll('[role=alert],[role=status]')].map(e => e.textContent.trim()).filter(Boolean).join(" | ")`);
/** Clicks the n-th score option (0-based) of every criterion, or of the first `limit` criteria. */
const score = (b, pick, limit = Infinity) => b.eval(`(() => {
  const sets = [...document.querySelectorAll("fieldset")].filter(f => f.querySelector('input[type=radio][name^="score:"]')).slice(0, ${limit === Infinity ? 999 : limit});
  for (const f of sets) { const r = f.querySelectorAll('input[type=radio]'); r[Math.min(${pick}, r.length - 1)].click(); }
  return sets.length; })()`);

try {
  const jb = await actor(judgeToken);
  const reviewUrl = `${BASE}/events/${SLUG}/judge/${first.id}`;

  await step(jb, "the judge sees only their own queue", async () => {
    await jb.goto(`${BASE}/events/${SLUG}/judge`);
    const links = await jb.eval(`[...document.querySelectorAll('a[href*="/judge/"]')].map(a => a.getAttribute("href").split("/").pop())`);
    const mine = new Set(q(`SELECT id FROM assignments WHERE judge_user_id = '${judgeId}'`).map((r) => r.id));
    const foreign = links.filter((id) => !mine.has(id));
    if (!links.includes(first.id)) throw new Error("the judge's own assignment is missing from the queue");
    if (foreign.length) throw new Error(`queue links to assignments that are not theirs: ${foreign.join(", ")}`);
    await jb.screenshot("judging-01-queue.png");
    return `${links.length} links, all theirs`;
  });

  await step(jb, "a partial draft saves and survives a reload", async () => {
    await jb.goto(reviewUrl);
    const n = await score(jb, 3, 1);
    if (n !== 1) throw new Error("no criterion to score");
    await jb.clickText("button", "Save draft");
    await jb.waitFor(`document.body.innerText.match(/saved/i)`, 8000);
    const r = reviewOf(first.id);
    if (!r || r.status !== "draft") throw new Error(`stored status is ${r?.status}`);
    await jb.goto(reviewUrl);
    // The seed may already hold a partial draft here, so compare with what is stored.
    const stored = scoresOf(first.id);
    const onScreen = await jb.eval(`Object.fromEntries([...document.querySelectorAll('input[type=radio][name^="score:"]:checked')].map(i => [i.name.slice(6), Number(i.value)]))`);
    for (const s of stored) {
      if (onScreen[s.criterion_id] !== s.score) throw new Error(`criterion ${s.criterion_id}: stored ${s.score}, shown ${onScreen[s.criterion_id]}`);
    }
    if (Object.keys(onScreen).length !== stored.length) throw new Error(`${Object.keys(onScreen).length} shown, ${stored.length} stored`);
    const firstCriterion = await jb.eval(`document.querySelector('input[type=radio][name^="score:"]').name.slice(6)`);
    if (onScreen[firstCriterion] !== 4) throw new Error(`the score just saved reads ${onScreen[firstCriterion]}, expected 4`);
    await jb.screenshot("judging-02-draft-reloaded.png");
    return `draft stored; after reload all ${stored.length} stored scores shown, including the one just saved`;
  });

  await step(jb, "a failed save keeps the input and does not advance progress", async () => {
    await jb.goto(reviewUrl);
    await score(jb, 4);
    await jb.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await jb.clickText("button", "Save draft");
    await sleep(2500);
    await jb.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const stillChecked = await jb.eval(`document.querySelectorAll('input[type=radio][name^="score:"]:checked').length`);
    const total = await jb.eval(`document.querySelectorAll("fieldset input[type=radio][name^='score:']").length ? new Set([...document.querySelectorAll("input[type=radio][name^='score:']")].map(i => i.name)).size : 0`);
    if (stillChecked !== total) throw new Error(`only ${stillChecked}/${total} scores still on screen after the failed save`);
    const r = reviewOf(first.id);
    if (r.status !== "draft") throw new Error(`stored status moved to ${r.status} while offline`);
    const shown = await notice(jb);
    jb.errors.length = 0;   // the offline fetch is expected to log an error; it is the point of the step
    await jb.screenshot("judging-03-offline-save.png");
    return `input kept (${stillChecked}/${total}), stored review still a draft; on screen: ${shown ? JSON.stringify(shown.slice(0, 80)) : "no message"}`;
  });

  await step(jb, "submitting locks the review and counts it", async () => {
    await jb.goto(reviewUrl);
    await score(jb, 4);
    await jb.clickText("button", "Submit review");
    await jb.waitFor(`!document.querySelector('button[value=submit]') || document.body.innerText.match(/submitted/i)`, 8000);
    await sleep(800);
    const r = reviewOf(first.id);
    if (r?.status !== "submitted") throw new Error(`stored status is ${r?.status}`);
    const stored = scoresOf(first.id);
    await jb.goto(reviewUrl);
    const disabled = await jb.eval(`[...document.querySelectorAll('input[type=radio][name^="score:"]')].every(i => i.disabled)`);
    if (!disabled) throw new Error("a submitted review is still editable");
    await jb.screenshot("judging-04-submitted.png");
    return `submitted, ${stored.length} scores stored, weighted ${Number(r.raw_weighted).toFixed(2)}, now read-only`;
  });

  const ob = await actor(otherToken);
  await step(ob, "another judge cannot open that review, by page or by API", async () => {
    const page = await fetch(reviewUrl, { headers: { cookie: `forgeboard_session=${otherToken}` }, redirect: "manual" });
    const api = await fetch(`${BASE}/api/v1/events/${SLUG}/reviews`, { headers: { cookie: `forgeboard_session=${otherToken}` } });
    await ob.goto(reviewUrl);
    const body = await ob.eval("document.body.innerText");
    const leaked = scoresOf(first.id).length && /running/.test(body);
    if (page.status !== 404) throw new Error(`page answered ${page.status}`);
    if (api.status !== 403) throw new Error(`API answered ${api.status}`);
    if (leaked) throw new Error("the rubric rendered for the wrong judge");
    return `page 404, API 403, nothing rendered`;
  });

  const org = await actor(tokens.organizer);
  let publishedSnapshot = null;
  await step(org, "the organizer computes and publishes a snapshot", async () => {
    await org.goto(`${BASE}/events/${SLUG}/organize/results`);
    await org.clickText("button", "Recompute snapshot");
    await org.waitFor(`document.body.innerText.match(/Snapshot computed/)`, 10000);
    await org.goto(`${BASE}/events/${SLUG}/organize/results`);
    await org.screenshot("judging-05-organizer-results.png", { full: true });
    await org.clickText("button", "Publish results");
    await org.clickText("button", "Yes, publish");
    await org.waitFor(`location.pathname.endsWith("/results") && !location.pathname.includes("organize")`, 10000);
    publishedSnapshot = q(`SELECT s.id, s.published_at FROM result_snapshots s JOIN events e ON e.id = s.event_id
                            WHERE e.slug = '${SLUG}' AND s.status = 'published' ORDER BY s.published_at DESC LIMIT 1`)[0];
    if (!publishedSnapshot) throw new Error("no published snapshot stored");
    return `published ${publishedSnapshot.id}`;
  });

  const anon = await actor(null);
  let publicBefore = "";
  await step(anon, "a visitor sees the published standings and nothing private", async () => {
    await anon.goto(`${BASE}/events/${SLUG}/results`);
    publicBefore = await anon.eval(`document.querySelector("main")?.innerText ?? ""`);
    const html = await anon.eval("document.documentElement.outerHTML");
    if (/not published yet/i.test(publicBefore)) throw new Error("results page still says unpublished");
    const judgeNames = q(`SELECT DISTINCT u.display_name AS n, u.email AS e FROM users u JOIN assignments a ON a.judge_user_id = u.id`);
    const leakedName = judgeNames.find((j) => html.includes(j.e));
    if (leakedName) throw new Error(`judge email ${leakedName.e} is in the public HTML`);
    if (/raw_weighted|criterion_scores|"z":/.test(html)) throw new Error("raw scoring fields are in the public HTML");
    await anon.screenshot("judging-06-public-results.png", { full: true });
    return `standings shown; no judge emails or raw ballot fields in HTML or hydration`;
  });

  await step(jb, "after publication a judge submission is refused and nothing moves", async () => {
    await jb.goto(`${BASE}/events/${SLUG}/judge/${second.id}`);
    const body = await jb.eval("document.body.innerText");
    if (!/judging window is closed/i.test(body)) throw new Error("no closed-window notice");
    if (/closes in/i.test(body)) throw new Error("the header still counts down to a close that has already happened");
    if (await jb.eval(`!!document.querySelector('button[value=submit]')`)) throw new Error("a submit button is offered");
    await jb.screenshot("judging-07-closed-after-publish.png");
    // The same refusal through the server action, not just the missing button:
    // re-enable the review form's own controls, pick scores and submit it.
    const before = reviewOf(second.id);
    const sent = await jb.eval(`(() => {
      const f = document.querySelector('input[name="assignmentId"]')?.closest("form");
      if (!f) return false;
      f.querySelectorAll("input, textarea").forEach((el) => { el.disabled = false; });
      f.querySelectorAll("fieldset").forEach((fs) => fs.querySelector('input[type=radio]')?.click());
      const i = document.createElement("input"); i.type = "hidden"; i.name = "intent"; i.value = "submit"; f.append(i);
      f.requestSubmit(); return true; })()`);
    if (!sent) throw new Error("could not find the review form");
    await jb.waitFor(`document.body.innerText.match(/judging window .*closed/i)`, 8000);
    const after = reviewOf(second.id);
    if (after?.status === "submitted") throw new Error("the server accepted a submission after publication");
    if (!(await jb.eval(`location.pathname.includes("/judge/")`))) throw new Error("left the review page");
    await jb.screenshot("judging-08-forced-submit-refused.png");
    return `closed notice, no countdown, no submit; forced POST refused, stored status ${before?.status ?? "none"} → ${after?.status ?? "none"}`;
  });

  await step(org, "recomputing after publication does not change what the public sees", async () => {
    await org.goto(`${BASE}/events/${SLUG}/organize/results`);
    await org.clickText("button", "Recompute snapshot");
    await org.waitFor(`document.body.innerText.match(/Snapshot computed/)`, 10000);
    await anon.goto(`${BASE}/events/${SLUG}/results`);
    const publicAfter = await anon.eval(`document.querySelector("main")?.innerText ?? ""`);
    const stillPublished = q(`SELECT s.id FROM result_snapshots s JOIN events e ON e.id = s.event_id
                               WHERE e.slug = '${SLUG}' AND s.status = 'published' ORDER BY s.published_at DESC LIMIT 1`)[0];
    if (stillPublished?.id !== publishedSnapshot?.id) throw new Error("the published snapshot changed without a publish");
    if (publicAfter !== publicBefore) throw new Error("the public standings changed without a publish");
    return "a new draft snapshot exists; the published one and the public page are unchanged";
  });
} finally {
  const errs = browsers.flatMap((b) => b.errors).filter((e) => !e.includes("favicon") && !e.includes("404"));
  log("\nconsole errors / exceptions:", errs.length ? "\n  " + errs.join("\n  ") : "none");
  log(failures === 0 ? "\nAll judging checks passed." : `\n${failures} judging check(s) failed.`);
  for (const b of browsers) await b.close();
  process.exit(failures === 0 && errs.length === 0 ? 0 : 1);
}
void ARTIFACTS;
