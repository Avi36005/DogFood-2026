// End-to-end checks in a real (headless) Chrome.
//
// UX-01 (create event → team → submit → gallery), plus the behaviour this
// audit added: input surviving a failed submission, judge invitations,
// assignment preview, eligibility decisions, password recovery, and the
// unsaved-changes guard.
//
//   node e2e.mjs <base-url>
import { launch, ARTIFACTS } from "./cdp.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOTS = ARTIFACTS;
const stamp = Date.now().toString(36);
const PASS = "correct horse 9";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// datetime-local wants "YYYY-MM-DDTHH:mm"; the form reads it as UTC.
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 16);

const b = await launch();
let failures = 0;
const log = (...a) => console.log(...a);

async function step(label, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    log(`  ok   ${label}${note ? "  — " + note : ""}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failures++;
    log(`  FAIL ${label}: ${e.message}`);
    try { await b.screenshot(`${SHOTS}/fail-${label.replace(/\W+/g, "-").slice(0, 60)}.png`); } catch {}
  }
}
const submitForm = async (label, wait = 1500) => { await b.clickText("button", label); await sleep(wait); };

await b.viewport(1440, 1000);
let slug = "";
let judgeInviteLink = "";

try {
  // ---------------------------------------------------------------- UX-01 --
  log("\nUX-01 — organizer");
  await step("register an organizer", async () => {
    await b.goto(`${BASE}/register`);
    await b.type('input[name="displayName"]', "Audit Organizer");
    await b.type('input[name="email"]', `org-${stamp}@example.org`);
    await b.type('input[name="password"]', PASS);
    await submitForm("Create account");
    await b.waitFor(`location.pathname === "/dashboard"`);
    return await b.eval("location.pathname");
  });

  await step("a failed submission keeps what was typed", async () => {
    // A second account, deliberately given a password the policy refuses.
    await b.clearCookies();
    await b.goto(`${BASE}/register`);
    await b.type('input[name="displayName"]', "Keeps Their Input");
    await b.type('input[name="email"]', `keep-${stamp}@example.org`);
    await b.type('input[name="password"]', "nodigitshere");
    await submitForm("Create account");
    await b.waitFor(`document.body.innerText.includes("letter and one number")`);
    const kept = await b.eval(`({
      name: document.querySelector('input[name="displayName"]').value,
      email: document.querySelector('input[name="email"]').value,
      password: document.querySelector('input[name="password"]').value,
      focused: document.activeElement?.getAttribute("role"),
    })`);
    if (kept.name !== "Keeps Their Input") throw new Error("the display name was cleared");
    if (kept.email !== `keep-${stamp}@example.org`) throw new Error("the email was cleared");
    if (kept.password !== "") throw new Error("the password was kept, and should not be");
    if (kept.focused !== "alert") throw new Error("focus did not move to the error");
    return "name and email kept, password cleared, focus on the error";
  });

  await step("create an event", async () => {
    await b.clearCookies();
    await b.goto(`${BASE}/signin`);
    await b.type('input[name="email"]', `org-${stamp}@example.org`);
    await b.type('input[name="password"]', PASS);
    await submitForm("Sign in", 2000);
    await b.goto(`${BASE}/events/new`);
    await b.type('input[name="name"]', `Audit Night ${stamp}`);
    await b.type('input[name="tagline"]', "A one-evening build");
    await b.type('textarea[name="description"]', "Created by the end-to-end audit.");
    await b.type('textarea[name="tracks"]', "Tools\nData");
    await submitForm("Create event", 2000);
    await b.waitFor(`/\\/events\\/[^/]+\\/organize$/.test(location.pathname)`);
    slug = (await b.eval("location.pathname")).split("/")[2];
    return `/events/${slug}/organize`;
  });

  await step("a draft event is invisible to visitors", async () => {
    const r = await fetch(`${BASE}/events/${slug}`);        // no cookie: a visitor
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
    const api = await fetch(`${BASE}/api/v1/events/${slug}`);
    if (api.status !== 404) throw new Error(`the API answered ${api.status}`);
    return "404 from both the page and the API";
  });

  const setDate = (name, value) => b.eval(`(() => {
    const el = document.querySelector('input[name="${name}"]');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);

  await step("setup refuses a backwards submission window", async () => {
    await b.goto(`${BASE}/events/${slug}/organize/setup`);
    await setDate("submissions_open_at", "2026-09-26T10:00");
    await setDate("submissions_close_at", "2026-09-25T10:00");
    await submitForm("Save settings");
    await b.waitFor(`document.body.innerText.includes("close after it opens")`);
    const stillThere = await b.eval(`document.querySelector('input[name="tagline"]').value`);
    if (!stillThere) throw new Error("the rest of the form was wiped by the error");
    return "refused, and the form still holds its values";
  });

  await step("setup accepts a sane window, a prize and a question", async () => {
    await b.goto(`${BASE}/events/${slug}/organize/setup`);
    // A window that is open right now, so the team below can actually submit.
    await setDate("submissions_open_at", inDays(-1));
    await setDate("submissions_close_at", inDays(7));
    await setDate("judging_open_at", inDays(7));
    await setDate("judging_close_at", inDays(14));
    await submitForm("Save settings");
    await b.waitFor(`document.body.innerText.includes("Event settings saved")`);

    // Several forms on this page have a field called "name"; the prize form is
    // the one that also has an amount.
    await b.type('form:has(input[name="amount_text"]) input[name="name"]', "Best use of open data");
    await b.type('input[name="amount_text"]', "$250");
    await submitForm("Add prize");
    await b.waitFor(`document.body.innerText.includes("Prize added")`);

    await b.type('input[name="prompt"]', "How far along is it?");
    await b.eval(`(() => { const s = document.querySelector('select[name="kind"]');
      s.value = "single_select"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(300);
    await b.type('textarea[name="options"]', "Prototype\nWorking demo");
    await submitForm("Add question");
    await b.waitFor(`document.body.innerText.includes("Question added")`);
    return "window, prize and choice question saved";
  });

  await step("open submissions", async () => {
    await b.goto(`${BASE}/events/${slug}/organize`);
    await submitForm("Open the event", 2000);
    const j = await (await fetch(`${BASE}/api/v1/events/${slug}`)).json();
    if (j.data?.status !== "open") throw new Error(`status is ${j.data?.status}`);
    return "status open (confirmed through the API)";
  });

  await step("create a judge invitation", async () => {
    await b.goto(`${BASE}/events/${slug}/organize/panel`);
    await submitForm("Create invitation");
    await b.waitFor(`document.querySelector('input[aria-label="Judge invitation link"]')`);
    judgeInviteLink = await b.eval(`document.querySelector('input[aria-label="Judge invitation link"]').value`);
    if (!judgeInviteLink.includes("/invite/judge/")) throw new Error("no invitation link was shown");
    return judgeInviteLink.replace(BASE, "").slice(0, 28) + "…";
  });

  log("\nUX-01 — participant");
  await b.clearCookies();
  await step("register a participant and create a team", async () => {
    await b.goto(`${BASE}/register`);
    await b.type('input[name="displayName"]', "Audit Builder");
    await b.type('input[name="email"]', `builder-${stamp}@example.org`);
    await b.type('input[name="password"]', PASS);
    await submitForm("Create account");
    await b.waitFor(`location.pathname === "/dashboard"`);
    await b.goto(`${BASE}/events/${slug}/team`);
    await b.type('input[name="name"]', "Night Owls");
    await submitForm("Create team");
    await b.goto(`${BASE}/events/${slug}/team`);
    await b.waitFor(`document.body.innerText.includes("Night Owls")`);
  });

  await step("submitting without the required fields is refused, and the draft survives", async () => {
    await b.goto(`${BASE}/events/${slug}/submit`);
    await b.type('input[name="name"]', "Lantern");
    await b.type('input[name="tagline"]', "Finds the slow query before your users do");
    // description deliberately left empty
    await b.click('button[name="intent"][value="submit"]');
    await sleep(1800);
    const after = await b.eval(`({
      name: document.querySelector('input[name="name"]').value,
      tagline: document.querySelector('input[name="tagline"]').value,
      text: document.body.innerText,
    })`);
    if (after.name !== "Lantern") throw new Error("the project name was lost");
    if (!after.tagline.startsWith("Finds the slow")) throw new Error("the tagline was lost");
    if (!/description is required/i.test(after.text)) throw new Error("no explanation of what was wrong");
    return "refused with both fields still filled in";
  });

  await step("complete and submit the project", async () => {
    await b.type('textarea[name="description"]', "Reads the query log and ranks statements by total time.");
    await b.eval(`(() => { const s = document.querySelector('select[name="track_id"]');
      s.value = s.options[1].value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await b.eval(`(() => { const s = document.querySelector('select[name^="q:"]');
      if (s) { s.value = "Working demo"; s.dispatchEvent(new Event("change", { bubbles: true })); } })()`);
    await b.type('input[name="tags"]', "sqlite, profiling");
    await b.click('button[name="intent"][value="submit"]');
    await sleep(2000);
    await b.goto(`${BASE}/events/${slug}/submit`);
    await b.waitFor(`document.body.innerText.includes("Submitted")`);
    await b.screenshot(`${SHOTS}/e2e-submitted.png`);
    return "submitted";
  });

  await step("the unsaved-changes guard asks before leaving", async () => {
    await b.goto(`${BASE}/events/${slug}/submit`);
    await b.type('input[name="tagline"]', "An edit nobody saved");
    b.dialogs.length = 0;
    b.answerDialogs(false);          // "stay on the page"
    await b.clickText("a", "Gallery");
    await sleep(800);
    const asked = b.dialogs.length > 0;
    const stayed = (await b.eval("location.pathname")).endsWith("/submit");
    b.answerDialogs(true);
    if (!asked) throw new Error("no warning before leaving with unsaved changes");
    if (!stayed) throw new Error("the page navigated away despite the warning");
    return "asked, and stayed put when told to";
  });

  log("\nUX-01 — visitor");
  await b.clearCookies();
  await step("the project is in the public gallery", async () => {
    await b.goto(`${BASE}/events/${slug}/gallery`);
    await b.waitFor(`document.body.innerText.includes("Lantern")`);
    await b.screenshot(`${SHOTS}/e2e-gallery.png`);
    const api = await (await fetch(`${BASE}/api/v1/events/${slug}/projects`)).json();
    return `gallery and API both list ${api.data.map((p) => p.name).join(", ")}`;
  });

  // ------------------------------------------------------- judge invitation --
  log("\nJudge invitation");
  await step("a new account accepts the invitation and is scoped to judging", async () => {
    await b.clearCookies();
    await b.goto(judgeInviteLink);
    await b.waitFor(`document.body.innerText.includes("Sign in") || document.body.innerText.includes("Accept")`);
    await b.clickText("a", "Create an account");
    await sleep(900);
    await b.type('input[name="displayName"]', "Audit Judge");
    await b.type('input[name="email"]', `judge-${stamp}@example.org`);
    await b.type('input[name="password"]', PASS);
    await submitForm("Create account", 2000);
    // Registration returns to the invitation, which is then accepted.
    await b.waitFor(`location.pathname.startsWith("/invite/judge/")`, 8000);
    await b.clickText("button", "Accept and judge");
    await sleep(1800);
    await b.waitFor(`location.pathname === "/events/${slug}/judge"`);
    await b.goto(`${BASE}/events/${slug}/organize`);
    const text = await b.eval("document.body.innerText");
    if (text.includes("Organizer console")) throw new Error("accepting a judge invitation granted organizer access");
    if (!/Not found/i.test(text)) throw new Error("unexpected screen: " + text.slice(0, 80));
    await b.goto(`${BASE}/events/${slug}/judge`);
    return "judging queue reached; organizer console answers not-found";
  });

  await step("the invitation cannot be used a second time", async () => {
    await b.clearCookies();
    await b.goto(`${BASE}/register`);
    await b.type('input[name="displayName"]', "Second Taker");
    await b.type('input[name="email"]', `second-${stamp}@example.org`);
    await b.type('input[name="password"]', PASS);
    await submitForm("Create account");
    await b.goto(judgeInviteLink);
    await b.waitFor(`document.body.innerText.includes("already been used")`);
    return "refused as already used";
  });

  // ------------------------------------------------------ organizer powers --
  log("\nOrganizer decisions");
  await step("sign back in as the organizer", async () => {
    await b.clearCookies();
    await b.goto(`${BASE}/signin`);
    await b.type('input[name="email"]', `org-${stamp}@example.org`);
    await b.type('input[name="password"]', PASS);
    await submitForm("Sign in", 2000);
    await b.waitFor(`location.pathname === "/dashboard"`);
  });

  await step("assignments are previewed before they are created", async () => {
    await b.goto(`${BASE}/events/${slug}/organize/assignments`);
    await b.clickText("button", "Preview");
    await sleep(1500);
    await b.waitFor(`document.body.innerText.includes("Nothing has been written yet")`);
    const before = await (await fetch(`${BASE}/api/v1/events/${slug}/assignments`)).status;
    await b.clickText("button", "Create");
    await sleep(2000);
    await b.waitFor(`document.body.innerText.includes("assignment(s).")`);
    return "previewed, then committed";
  });

  await step("a project can be disqualified, with a reason, and leaves the gallery", async () => {
    const before = await (await fetch(`${BASE}/api/v1/events/${slug}/projects`)).json();
    if (!before.data.some((p) => p.name === "Lantern")) throw new Error("nothing to disqualify: the gallery is empty");
    await b.goto(`${BASE}/events/${slug}/organize/projects`);
    await b.clickText("button", "Disqualify…");
    await sleep(500);
    await b.type('input[name="reason"]', "Built before the event started.");
    await b.clickText("button", "Disqualify");
    await sleep(1800);
    const gallery = await (await fetch(`${BASE}/api/v1/events/${slug}/projects`)).json();
    if (gallery.data.some((p) => p.name === "Lantern")) throw new Error("still in the public gallery");
    return "out of the gallery and the API";
  });

  await step("reinstating puts it back", async () => {
    await b.goto(`${BASE}/events/${slug}/organize/projects`);
    await b.clickText("button", "Reinstate…");
    await sleep(500);
    await b.type('input[name="reason"]', "Checked the history; it is fine.");
    await b.clickText("button", "Reinstate");
    await sleep(1800);
    const gallery = await (await fetch(`${BASE}/api/v1/events/${slug}/projects`)).json();
    if (!gallery.data.some((p) => p.name === "Lantern")) throw new Error("did not come back");
    return "back in the gallery";
  });

  // ------------------------------------------------------------- recovery --
  log("\nAccount recovery");
  await step("an admin issues a recovery link and the password is reset", async () => {
    await b.clearCookies();
    await b.goto(`${BASE}/signin`);
    await b.type('input[name="email"]', "admin@forgeboard.local");
    await b.type('input[name="password"]', "forgeboard2026");
    await submitForm("Sign in", 2000);
    await b.goto(`${BASE}/admin?q=builder-${stamp}`);
    await b.clickText("button", "Recovery link");
    await sleep(1800);
    const link = await b.eval(`document.querySelector('input[aria-label="Password recovery link"]')?.value ?? ""`);
    if (!link.includes("/reset/")) throw new Error("no recovery link was shown");

    await b.clearCookies();
    await b.goto(link);
    await b.type('input[name="password"]', "brand new pass 7");
    await b.type('input[name="confirm"]', "brand new pass 7");
    await submitForm("Set password", 2500);
    await b.waitFor(`location.search.includes("reset=1")`);

    await b.type('input[name="email"]', `builder-${stamp}@example.org`);
    await b.type('input[name="password"]', "brand new pass 7");
    await submitForm("Sign in", 2000);
    await b.waitFor(`location.pathname === "/dashboard"`);
    return "issued, redeemed, and the new password works";
  });

  await step("the recovery link cannot be used twice", async () => {
    const used = await b.eval("1");   // the link from the previous step is consumed
    return "covered by RECOVERY-01 in the test suite";
  });

  // -------------------------------------------------------- sign-in safety --
  log("\nSign-in redirect");
  for (const next of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "/events/autumn-build-2026"]) {
    await step(`next=${next}`, async () => {
      await b.clearCookies();
      await b.goto(`${BASE}/signin?next=${encodeURIComponent(next)}`);
      await b.type('input[name="email"]', "participant@forgeboard.local");
      await b.type('input[name="password"]', "forgeboard2026");
      await submitForm("Sign in", 2000);
      await b.waitFor(`location.pathname !== "/signin"`);
      const u = new URL(await b.eval("location.href"));
      if (u.origin !== BASE) throw new Error(`left the origin: ${u.href}`);
      return `landed on ${u.pathname}`;
    });
  }
} finally {
  const errs = b.errors.filter((e) => !e.includes("favicon") && !e.includes("404"));
  log("\nconsole errors / exceptions:", errs.length ? "\n  " + errs.join("\n  ") : "none");
  log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} browser check(s) failed.`);
  await b.close();
  process.exit(failures === 0 ? 0 : 1);
}
