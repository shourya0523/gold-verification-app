// Drives the app in a browser against the local stack that run_e2e.sh starts.
//   node e2e.mjs <base-url> <rows.json> <out-dir> <tokens.json> [chromium-path]
// Writes <out-dir>/e2e_result.json and screenshots; exits non-zero on failure.
import { createRequire } from "node:module";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// require() honours NODE_PATH, so playwright can live outside this repo.
const { chromium } = createRequire(import.meta.url)("playwright");
const [base, rowsFile, out, tokensFile, exe] = process.argv.slice(2);
const tokens = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
const data = JSON.parse(fs.readFileSync(rowsFile, "utf8"));
const result = { checks: [], preview: [] };
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const TEAM = { asha: "asha@team.test", ben: "ben@team.test" };
// A browser for one reviewer: the app's key (no sign-in), then their name
// picked on the first screen. who = null leaves the picker showing.
async function as(who, { width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  await ctx.route("**/config.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `export default { supabaseUrl: "${base}", supabaseKey: "${tokens.anon}" };`,
  }));
  // Anything off this machine (CDN scripts, fonts, images in source pages) is
  // fetched with curl, which knows the sandbox's outbound proxy.
  await ctx.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), async (route) => {
    try {
      const tmp = `${out}/.fetch-${process.pid}`;
      const type = execFileSync("curl", ["-sSL", "-m", "60", "-A", "Mozilla/5.0 Chrome/140", "-o", tmp,
        "-w", "%{content_type}", route.request().url()]).toString().trim();
      await route.fulfill({ body: fs.readFileSync(tmp), contentType: type || "application/octet-stream" });
    } catch { await route.abort(); }
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${who}] page error: ${e.message}`));
  await page.goto(`${base}/`);
  await page.waitForSelector("[data-email]");
  if (who) {
    await page.click(`[data-email="${TEAM[who]}"]`);
    await page.waitForSelector(".topbar");
  }
  return page;
}

try {
  // 1. Load gold through the app's own button.
  const a = await as("asha");
  await a.goto(`${base}/#/progress`);
  await a.waitForSelector("#goldfile");
  const t0 = Date.now();
  await a.setInputFiles("#goldfile", rowsFile);
  await a.waitForFunction(() => /Loaded|Mismatch|Failed/.test(document.querySelector("#loadmsg")?.textContent || ""), null, { timeout: 600_000 });
  const loadMsg = await a.textContent("#loadmsg");
  check("load gold through the app", /^Loaded/.test(loadMsg.trim()), `${loadMsg.trim()} in ${Math.round((Date.now() - t0) / 1000)}s`);

  // 2. The queue accounts for every row.
  await a.goto(`${base}/#/queue`);
  await a.waitForSelector(".tier .n");
  const totals = await a.$$eval(".tier .n", (els) => els.map((e) => Number(/of ([\d,]+)/.exec(e.textContent)[1].replace(/,/g, ""))));
  const sum = totals.reduce((x, y) => x + y, 0);
  check("tier totals add up to every gold row", sum === data.rows.length, `${totals.join(" + ")} = ${sum}; file has ${data.rows.length}`);
  await a.click('[data-tier="all"]');
  await a.click('[data-show="all"]');
  await a.waitForTimeout(300);
  const shownBatches = await a.$$eval(".batch", (els) => els.length);
  check("queue lists batches", shownBatches > 0, `${shownBatches} shown before "show more"`);
  await a.screenshot({ path: `${out}/queue.png`, fullPage: false });

  // 3. Assign a batch.
  const firstP1 = data.batches.find((b) => b.tier === "P1");
  await a.click('[data-tier="P1"]');
  await a.waitForSelector(`[data-assign="${firstP1.id}"]`);
  await a.selectOption(`[data-assign="${firstP1.id}"]`, "asha@team.test");
  await a.waitForSelector("#toast:not([hidden])");
  check("assign a batch", (await a.textContent("#toast")).includes("Asha"));

  // 4. Review: confirm, flag with a value, undo.
  const batchRows = data.rows.filter((r) => r.batch_id === firstP1.id);
  await a.goto(`${base}/#/batch/${encodeURIComponent(firstP1.id)}`);
  await a.waitForSelector("#card .drug");
  await a.waitForFunction(() => !/Loading|Looking/.test(document.querySelector("#pvstatus").textContent), null, { timeout: 120_000 });
  const firstStatus = await a.textContent("#pvstatus");
  await a.screenshot({ path: `${out}/review.png` });
  check("preview loads for the first row", !/Could not load/.test(firstStatus), firstStatus);
  const current = () => a.getAttribute("#card", "data-gold-id");
  const firstId = await current();
  await a.keyboard.press("1");
  await a.waitForFunction(() => / · confirmed/.test(document.querySelector("#toast")?.textContent || ""));
  check("confirm with the 1 key", true, firstId);
  await a.waitForFunction((id) => document.querySelector("#card")?.dataset.goldId !== id, firstId);
  const secondId = await current();
  await a.keyboard.press("f");
  await a.keyboard.press("2");
  await a.fill("#seen", "1,234.5");
  await a.fill("#note", "e2e: read a different figure");
  await a.keyboard.press("Enter");
  await a.waitForFunction(() => /wrong value/.test(document.querySelector("#toast")?.textContent || ""));
  check("flag wrong value with a number typed as printed", true, secondId);
  // Undo the flag: the verdict is removed again.
  await a.click("#toast [data-undo]");
  await a.waitForTimeout(800);
  result.undone = secondId;
  // Flag it for real so the flags page has something.
  await a.goto(`${base}/#/batch/${encodeURIComponent(firstP1.id)}/${encodeURIComponent(secondId)}`);
  await a.waitForSelector("#card .drug");
  await a.keyboard.press("3");
  await a.fill("#note", "e2e: quarter column looks shifted");
  await a.keyboard.press("Enter");
  await a.waitForFunction(() => /wrong period/.test(document.querySelector("#toast")?.textContent || ""));
  result.flagged = secondId;
  result.confirmed = firstId;

  // 5. A second reviewer sees it, and resolves the flag.
  const b = await as("ben");
  await b.goto(`${base}/#/batch/${encodeURIComponent(firstP1.id)}/${encodeURIComponent(firstId)}`);
  await b.waitForSelector("#card .drug");
  const others = await b.textContent("#card");
  check("second reviewer sees the first one's verdict", /Asha · confirmed/.test(others));
  await b.goto(`${base}/#/flags`);
  await b.waitForSelector(".pagehead");
  const flagItems = await b.$$eval(".flagitem", (els) => els.map((e) => e.dataset.id));
  check("flags page lists the flagged row", flagItems.includes(secondId), flagItems.join(", "));
  await b.screenshot({ path: `${out}/flags.png` });
  await b.fill(`.flagitem[data-id="${secondId}"] [data-note]`, "e2e: checked, gold is right");
  await b.click(`.flagitem[data-id="${secondId}"] [data-outcome="gold_correct"]`);
  await b.waitForFunction(() => /Resolved/.test(document.querySelector("#toast")?.textContent || ""));
  check("resolve a flag", true);

  // 6. A new browser asks who you are, listing exactly the team.
  const o = await as(null);
  const names = await o.$$eval("[data-email]", (els) => els.map((e) => e.textContent.trim()).sort());
  check("first visit asks who you are", names.join(",") === "Asha,Ben", names.join(", "));

  // 6b. Claiming an unassigned batch takes one click.
  await b.goto(`${base}/#/queue`);
  await b.waitForSelector(".tier .n");
  await b.click('[data-tier="all"]');
  await b.click('[data-show="unassigned"]');
  const claimId = await b.getAttribute("[data-claim]", "data-claim");
  await b.click(`[data-claim="${claimId}"]`);
  await b.waitForFunction(() => /Ben/.test(document.querySelector("#toast")?.textContent || ""));
  check("claim a batch", true, claimId);
  result.claimed = claimId;

  // 6b'. Bulk: select every unassigned P2 batch and give them all to Asha.
  await b.click('[data-tier="P2"]');
  await b.click('[data-show="unassigned"]');
  await b.waitForSelector("#pickall");
  const shown = await b.$$eval("[data-pick]", (els) => els.length);
  const totalUnassignedP2 = Number(/Select all ([\d,]+)/.exec(await b.textContent(".bulk label"))[1].replace(/,/g, ""));
  await b.check("#pickall");
  await b.waitForSelector("#bulkto");
  await b.selectOption("#bulkto", "asha@team.test");
  await b.waitForFunction(() => /batches → Asha/.test(document.querySelector("#toast")?.textContent || ""));
  const toastText = await b.textContent("#toast");
  check("bulk assign every selected batch", toastText.includes(`${totalUnassignedP2} batches`), `${toastText.trim()} (${shown} rows on screen, ${totalUnassignedP2} unassigned P2)`);
  result.bulk = totalUnassignedP2;

  // 6c. Export Excel downloads the workbook (contents checked by check_db.py).
  const [download] = await Promise.all([b.waitForEvent("download", { timeout: 120_000 }), b.click("#exportxlsx")]);
  await download.saveAs(`${out}/export.xlsx`);
  check("export Excel downloads a workbook", fs.statSync(`${out}/export.xlsx`).size > 0, download.suggestedFilename());

  // 7. Progress reflects it all.
  await a.goto(`${base}/#/progress`);
  await a.waitForSelector(".pagehead");
  const head = await a.textContent(".pagehead");
  check("progress counts the reviewed rows", /2 of 8,475|2 of/.test(head), head.trim());
  await a.screenshot({ path: `${out}/progress.png`, fullPage: true });

  // 7b. Milestones: Ben closes the smallest batch nobody has touched, with the
  // 1 key. The last verdict fires the batch note and the confetti; the queue's
  // Today line and the Progress team strip then count the batch for him.
  const touched = new Set([result.confirmed, result.flagged, result.undone].filter(Boolean));
  const small = data.batches.filter((x) => !data.rows.some((r) => r.batch_id === x.id && touched.has(r.gold_id)))
    .sort((x, y) => x.row_count - y.row_count)[0];
  const ben = await as("ben");
  await ben.goto(`${base}/#/batch/${encodeURIComponent(small.id)}`);
  await ben.waitForSelector("#ring");
  const sawConfetti = ben.waitForSelector("canvas.confetti", { state: "attached", timeout: 60_000 }).then(() => true, () => false);
  for (let n = 1; n <= small.row_count; n++) {
    await ben.keyboard.press("1");
    await ben.waitForFunction((n) => (document.querySelector("#ring")?.textContent || "").includes(`${n} of`), n, { timeout: 30_000 });
  }
  result.finished = { batch: small.id, rows: data.rows.filter((r) => r.batch_id === small.id).map((r) => r.gold_id) };
  check("closing a batch fires confetti", await sawConfetti, `${small.id}, ${small.row_count} rows`);
  await ben.waitForSelector("#cheer:not([hidden])");
  const note = (await ben.textContent("#cheer")).trim();
  check("closing a batch shows the batch note", /Batch done/.test(note), note);
  await ben.screenshot({ path: `${out}/milestone.png` });
  await ben.goto(`${base}/#/queue`);
  await ben.waitForSelector(".session");
  const session = (await ben.textContent(".session")).trim();
  check("the Today line counts the rows and the batch", session.includes(`${small.row_count} row`) && /1 batch done/.test(session), session);
  await ben.goto(`${base}/#/progress`);
  await ben.waitForSelector(".team");
  const strip = (await ben.textContent(".team")).replace(/\s+/g, " ").trim();
  check("the team strip credits the batch to its closer", /Ben 1 batch finished/.test(strip), strip);
  const again = await ben.evaluate(() => JSON.parse(localStorage.getItem("gv-cheer-ben@team.test") || "{}"));
  check("the batch milestone is remembered, so it fires once", Object.keys(again).some((k) => k === `batch:${small.id}`), JSON.stringify(again));

  // 8. Preview: one row per source host, read from the real documents.
  const byHost = new Map();
  for (const r of data.rows) {
    const h = new URL(r.source_url).host;
    if (!byHost.has(h)) byHost.set(h, r);
  }
  // Plus a fixed-seed random sample, so the measure is not only first rows.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const sample = new Map([...byHost].map(([h, r]) => [`host:${h}`, r]));
  while (sample.size < byHost.size + 40) {
    const r = data.rows[Math.floor(rand() * data.rows.length)];
    sample.set(`random:${r.gold_id}`, r);
  }
  for (const [label, r] of sample) {
    const h = label;
    await a.goto(`${base}/#/batch/${encodeURIComponent(r.batch_id)}/${encodeURIComponent(r.gold_id)}`);
    await a.waitForSelector("#pvstatus");
    try {
      await a.waitForFunction(() => !/Loading|Looking/.test(document.querySelector("#pvstatus").textContent), null, { timeout: 90_000 });
    } catch { /* recorded below as still loading */ }
    const status = (await a.textContent("#pvstatus")).trim();
    result.preview.push({ sample: h.split(":")[0], host: new URL(r.source_url).host, gold_id: r.gold_id, kind: r.kind, status });
    console.log(`preview ${h.slice(0, 60).padEnd(60)} ${status}`);
    if (h.startsWith("host:") && /found/i.test(status) && !/not found/i.test(status)) await a.screenshot({ path: `${out}/preview-${h.replace(/[^a-z0-9]+/gi, "_")}.png` });
  }

  // 8b. A highlighted figure is on screen, even inside a section the page
  // collapses (a "read more" wrapper the removed scripts would have opened).
  const hidden = await a.evaluate(() => {
    const d = document.querySelector("#pv iframe")?.contentDocument;
    return d ? [...d.querySelectorAll(".gv-fig")].filter((m) => !m.getClientRects().length).length : 0;
  });
  check("the last highlighted figure is visible", hidden === 0, `${hidden} hidden`);
  const collapsed = data.rows.find((r) => r.source_url.includes("finance.yahoo.com") && r.value_reported !== null);
  if (collapsed) {
    await a.goto(`${base}/#/batch/${encodeURIComponent(collapsed.batch_id)}/${encodeURIComponent(collapsed.gold_id)}`);
    await a.waitForFunction(() => !/Loading|Looking/.test(document.querySelector("#pvstatus")?.textContent || "Loading"), null, { timeout: 90_000 });
    const seen = await a.evaluate(() => {
      const d = document.querySelector("#pv iframe")?.contentDocument;
      const m = d && (d.querySelector(".gv-fig") || d.querySelector(".gv-row"));
      return m ? { visible: m.getClientRects().length > 0, text: m.textContent.slice(0, 80) } : null;
    });
    check("a figure in a collapsed section is revealed", !!seen?.visible, `${collapsed.gold_id}: ${JSON.stringify(seen)} · ${(await a.textContent("#pvstatus")).trim()}`);
  }

  // 8c. A derived total is printed nowhere: each term is shown with its own
  // document, the sum says it adds up, and [ ] step through the terms. Bridge
  // parts must be found; for a sample of subtracted quarters (one per kind of
  // derivation, plus a 3-term one) how each term fared is recorded.
  const bridges = data.rows.filter((x) => x.derivation === "acquisition_bridge_sum");
  const kinds = new Map();
  for (const x of data.rows) if (x.inputs.length && x.derivation !== "acquisition_bridge_sum") {
    const k = x.inputs.length > 2 ? "3+" : x.derivation;
    if (!kinds.has(k)) kinds.set(k, x);
  }
  result.derived = [];
  for (const r of [...bridges, ...kinds.values()]) {
    await a.goto(`${base}/#/batch/${encodeURIComponent(r.batch_id)}/${encodeURIComponent(r.gold_id)}`);
    await a.waitForSelector(".sum");
    const sum = (await a.textContent(".sum .check")).trim();
    check(`the worked sum for ${r.gold_id} adds up`, /adds up/.test(sum), sum);
    for (let n = 0; n < r.inputs.length; n++) {
      if (n === 0) await a.click('[data-input="0"]'); else await a.keyboard.press("]");
      await a.waitForFunction((n) => (document.querySelector('.sum .term.on')?.dataset.input === String(n)
        && /^Term/.test(document.querySelector("#pvstatus").textContent)
        && !/Loading|Looking/.test(document.querySelector("#pvstatus").textContent)), n, { timeout: 90_000 });
      const status = (await a.textContent("#pvstatus")).trim();
      const found = /found/i.test(status) && !/not found/i.test(status);
      result.derived.push({ gold_id: r.gold_id, term: n, value: r.inputs[n].value, where: r.inputs[n].where, status });
      if (r.derivation === "acquisition_bridge_sum") check(`bridge part ${r.inputs[n].value} of ${r.gold_id} is found`, found, status);
      else console.log(`term   ${r.gold_id} ${n + 1}/${r.inputs.length} ${r.inputs[n].value} (${r.inputs[n].where}): ${status}`);
    }
    if (r === [...kinds.values()][0]) await a.screenshot({ path: `${out}/derived.png` });
  }

  // Phone width: the review page must not scroll sideways.
  const p = await as("asha", { width: 390, height: 844 });
  await p.goto(`${base}/#/queue`);
  await p.goto(`${base}/#/batch/${encodeURIComponent(firstP1.id)}/${encodeURIComponent(firstId)}`);
  await p.waitForSelector("#card .drug");
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  check("review page fits a phone", sw <= 390, `scrollWidth ${sw}`);
  await p.screenshot({ path: `${out}/phone.png` });
} catch (err) {
  check("e2e run completed", false, err.message);
} finally {
  fs.writeFileSync(`${out}/e2e_result.json`, JSON.stringify(result, null, 1));
  await browser.close();
  process.exit(result.checks.every((c) => c.ok) ? 0 : 1);
}
