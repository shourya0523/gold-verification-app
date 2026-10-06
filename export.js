// Builds the tracker workbook in the browser from what the database holds now:
// a checklist per product, every gold row with its verdicts, and every verdict.
// The roll-up rules match scripts/sourcing/build_verification_tracker.py, which
// builds the fuller tracker (with Claude's verification columns) from git.

const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";

function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = EXCELJS;
    tag.onload = () => resolve(window.ExcelJS);
    tag.onerror = () => reject(new Error("could not load the spreadsheet library"));
    document.head.append(tag);
  });
}

const HEADER = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const REVIEW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };

function sheet(book, name, columns, reviewCols = []) {
  const ws = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map(([header, width]) => ({ header, width }));
  ws.getRow(1).eachCell((cell) => {
    const review = reviewCols.includes(cell.value);
    cell.fill = review ? REVIEW : HEADER;
    cell.font = { bold: true, color: { argb: review ? "FF000000" : "FFFFFFFF" } };
    cell.alignment = { wrapText: true, vertical: "top" };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

/**
 * rows, verdicts, resolutions: the tables as the app reads them.
 * nameOf: email -> display name. Returns a Blob.
 */
export async function buildTracker({ rows, verdicts, resolutions, nameOf }) {
  const ExcelJS = await loadExcelJS();
  const byRow = new Map();
  for (const v of verdicts) (byRow.get(v.gold_id) || byRow.set(v.gold_id, []).get(v.gold_id)).push(v);
  const resolution = new Map(resolutions.map((r) => [r.gold_id, r]));
  const goldValue = new Map(rows.map((r) => [r.gold_id, r.value_reported]));

  const stale = (v) => {
    const now = goldValue.get(v.gold_id);
    if (now === null || now === undefined || v.gold_value_seen === null) return (now ?? null) !== v.gold_value_seen;
    return Math.abs(Number(now) - Number(v.gold_value_seen)) > 1e-9;
  };
  const status = (id) => {
    const vs = byRow.get(id) || [];
    if (!vs.length) return "unverified";
    return vs.some((v) => v.verdict !== "confirmed") && !resolution.has(id) ? "flagged" : "verified";
  };
  const verdictText = (id) => (byRow.get(id) || []).map((v) =>
    `${nameOf(v.reviewer)}: ${v.verdict.replace(/_/g, " ")}`
    + (v.value_seen !== null ? ` (read ${v.value_seen})` : "")
    + (stale(v) ? " [gold since changed]" : "")
    + (v.note ? ` - ${v.note}` : "")).join("; ");
  const resolutionText = (id) => {
    const r = resolution.get(id);
    return r ? `${r.outcome.replace(/_/g, " ")} (${nameOf(r.resolved_by)})${r.note ? `: ${r.note}` : ""}` : "";
  };

  const book = new ExcelJS.Workbook();
  book.created = new Date();

  // Read Me
  const readme = book.addWorksheet("Read Me");
  readme.columns = [{ width: 22 }, { width: 120 }];
  [
    ["Gold Verification Tracker"],
    ["Exported", new Date().toLocaleString()],
    [],
    ["Drug Checklist", "One row per product. Manually Verified is Yes when every gold row of the product has a verdict and none is an open flag or a resolved 'gold needs a fix'; No when one is; blank while review is in progress."],
    ["Rows", "Every gold row in the current build, with its source, its verdicts and how any flag was settled."],
    ["Human Verdicts", "Every verdict, with whether the gold figure has changed since it was given."],
  ].forEach((line) => readme.addRow(line));
  readme.getCell("A1").font = { bold: true, size: 14 };

  // Drug Checklist
  const byDrug = new Map();
  for (const r of rows) (byDrug.get(r.drug_name) || byDrug.set(r.drug_name, []).get(r.drug_name)).push(r);
  const review = ["Manually Verified", "Verified By", "Date Verified", "Reviewer Notes"];
  const drugs = sheet(book, "Drug Checklist", [
    ["Brand Name", 20], ["Generic / INN", 24], ["Issuer", 26], ["Kinds of Row", 22], ["Gold Rows", 10],
    ["Rows Reviewed", 10], ["Open Flags", 10], ["Manually Verified", 12], ["Verified By", 22],
    ["Date Verified", 13], ["Reviewer Notes", 80],
  ], review);
  for (const [drug, list] of [...byDrug].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ids = list.map((r) => r.gold_id);
    const reviewed = ids.filter((id) => status(id) !== "unverified");
    const flagged = ids.filter((id) => status(id) === "flagged");
    const needsFix = ids.filter((id) => resolution.get(id)?.outcome === "gold_needs_fix");
    const vs = ids.flatMap((id) => byRow.get(id) || []);
    const period = (id) => list.find((r) => r.gold_id === id).period || id;
    const notes = [
      ...flagged.map((id) => `open flag ${period(id)}: ${verdictText(id)}`),
      ...needsFix.map((id) => `gold needs a fix ${period(id)}: ${resolutionText(id)}`),
    ];
    const staleCount = vs.filter(stale).length;
    if (staleCount) notes.push(`${staleCount} verdicts given before the gold figure changed`);
    drugs.addRow([
      drug, list[0].generic_name || "", [...new Set(list.map((r) => r.issuer))].join(" -> "),
      [...new Set(list.map((r) => r.kind))].sort().join(", "), ids.length, reviewed.length, flagged.length,
      !vs.length ? "" : (flagged.length || needsFix.length) ? "No" : reviewed.length === ids.length ? "Yes" : "",
      [...new Set(vs.map((v) => nameOf(v.reviewer)))].sort().join(", "),
      vs.reduce((m, v) => (v.updated_at > m ? v.updated_at : m), "").slice(0, 10),
      notes.join("; "),
    ]);
  }

  // Rows
  const rowSheet = sheet(book, "Rows", [
    ["Gold ID", 40], ["Tier", 6], ["Kind", 11], ["Drug", 18], ["Issuer", 22], ["Period", 9],
    ["Value Reported (millions)", 12], ["Currency", 8], ["Scope", 16], ["Derivation", 24], ["Source", 50],
    ["Source Quote", 70], ["Automated Check", 10], ["Status", 11], ["Reviewer Verdicts", 50], ["Resolution", 40],
  ], ["Status", "Reviewer Verdicts", "Resolution"]);
  const sorted = [...rows].sort((a, b) => a.drug_name.localeCompare(b.drug_name) || a.period.localeCompare(b.period));
  for (const r of sorted) {
    const added = rowSheet.addRow([
      r.gold_id, r.tier, r.kind, r.drug_name, r.issuer, r.period, r.value_reported === null ? "" : Number(r.value_reported),
      r.currency, r.scope || "", r.derivation, { text: r.source_url, hyperlink: r.source_url }, r.source_quote,
      r.automated_check, status(r.gold_id), verdictText(r.gold_id), resolutionText(r.gold_id),
    ]);
    added.getCell(11).font = { color: { argb: "FF0563C1" }, underline: true };
  }

  // Human Verdicts
  const vSheet = sheet(book, "Human Verdicts", [
    ["Gold ID", 40], ["Drug", 18], ["Period", 9], ["Gold Value Now", 12], ["Reviewer", 16], ["Verdict", 14],
    ["Value Read", 11], ["Gold Value When Reviewed", 12], ["Gold Changed Since", 10], ["Note", 50],
    ["Reviewed At", 18], ["Row Status", 11], ["Resolution", 40],
  ]);
  const rowById = new Map(rows.map((r) => [r.gold_id, r]));
  for (const v of [...verdicts].sort((a, b) => a.gold_id.localeCompare(b.gold_id) || a.reviewer.localeCompare(b.reviewer))) {
    const r = rowById.get(v.gold_id) || {};
    vSheet.addRow([
      v.gold_id, r.drug_name || "(not in current gold)", r.period || "", r.value_reported ?? "",
      nameOf(v.reviewer), v.verdict.replace(/_/g, " "), v.value_seen ?? "", v.gold_value_seen ?? "",
      stale(v) ? "yes" : "", v.note || "", (v.updated_at || "").slice(0, 19).replace("T", " "),
      status(v.gold_id), resolutionText(v.gold_id),
    ]);
  }

  const buffer = await book.xlsx.writeBuffer();
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
