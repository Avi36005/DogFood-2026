// Dashboard task hierarchy, as each seeded role sees it: "Waiting on you" holds
// open work only, finished work never appears under it, and someone with
// nothing open is told so.
//
//   node dashboard.mjs <base-url>
import { launch } from "./cdp.mjs";
import { mintSessions } from "./sessions.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const tokens = mintSessions();
let fails = 0;
const check = async (label, fn) => {
  try { const note = await fn(); console.log(`  ok   ${label}${note ? "  — " + note : ""}`); }
  catch (e) { fails++; console.log(`  FAIL ${label}: ${e.message}`); }
};

/** What a person reads on their dashboard, gathered from the rendered page. */
async function readDashboard(role) {
  const b = await launch();
  try {
    await b.viewport(1280, 900);
    await b.cookie("forgeboard_session", tokens[role], BASE);
    await b.goto(`${BASE}/dashboard`);
    return await b.eval(`(() => {
      const heading = [...document.querySelectorAll("h1,h2,h3")].find((h) => h.textContent.trim() === "Waiting on you");
      // Climb to the panel that holds both the heading and its list or empty state.
      let panel = heading?.parentElement;
      while (panel && !(panel.querySelector("ul") || /all caught up/i.test(panel.innerText))) panel = panel.parentElement;
      const rows = panel ? [...panel.querySelectorAll("ul > li")].map((li) => li.innerText.split("\\n")[0].trim()) : null;
      const done = document.getElementById("recently-completed")?.closest("section");
      return {
        heading: !!heading,
        panelText: panel?.innerText ?? "",
        rows,
        caughtUp: panel ? /You.re all caught up/.test(panel.innerText) : false,
        summary: document.querySelector("h1")?.nextElementSibling?.innerText ?? "",
        completedLabel: !!done,
        completedRows: done ? done.querySelectorAll("li").length : 0,
        completedInsidePanel: !!(panel && done && panel.contains(done)),
      };
    })()`);
  } finally { await b.close(); }
}

// Three open tasks in the walkthrough event, one in the DOGFOOD fixture event (judging under way).
await check("organizer: four open tasks, listed under Waiting on you", async () => {
  const d = await readDashboard("organizer");
  if (!d.heading) throw new Error("no Waiting on you heading");
  if (d.rows?.length !== 4) throw new Error(`${d.rows?.length} rows under Waiting on you, expected 4`);
  if (!/4 open/.test(d.panelText)) throw new Error("the panel does not report 4 open");
  if (!/4 tasks waiting on you/.test(d.summary)) throw new Error(`summary reads "${d.summary}"`);
  if (d.caughtUp) throw new Error("shows the caught-up state while work is open");
  return d.rows.join(" · ");
});

for (const role of ["judge", "participant"]) {
  await check(`${role}: nothing open, so all caught up, with finished work kept apart`, async () => {
    const d = await readDashboard(role);
    if (!d.heading) throw new Error("no Waiting on you heading");
    if (!d.caughtUp) throw new Error("no all-caught-up message");
    if (d.rows?.length) throw new Error(`${d.rows.length} rows under Waiting on you: ${d.rows.join(", ")}`);
    if (!/0 tasks waiting on you/.test(d.summary)) throw new Error(`summary reads "${d.summary}"`);
    if (d.completedInsidePanel) throw new Error("completed work is inside the Waiting on you panel");
    if (d.completedLabel && d.completedRows > 3) throw new Error(`${d.completedRows} completed rows; expected at most 3`);
    return d.completedLabel ? `caught up; ${d.completedRows} row(s) under Recently completed` : "caught up; no completed section";
  });
}

console.log(fails === 0 ? "\nAll dashboard checks passed." : `\n${fails} dashboard check(s) failed.`);
process.exit(fails ? 1 : 0);
