// Gold verification: queue, review, flags and progress over the Supabase schema
// in ../supabase/schema.sql. Plain ES modules, no build step.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import config from "./config.js";
import { Preview, escapeHtml as esc } from "./preview.js";
import { buildTracker } from "./export.js";

const VERDICTS = {
  confirmed: { label: "Confirmed", key: "1" },
  wrong_value: { label: "Wrong value", key: "2" },
  wrong_period: { label: "Wrong period", key: "3" },
  wrong_scope: { label: "Wrong scope", key: "4" },
  source_missing: { label: "Not in source", key: "5" },
  cannot_access: { label: "Can't open source", key: "6" },
};
const FLAG_KEYS = Object.fromEntries(Object.entries(VERDICTS).filter(([v]) => v !== "confirmed").map(([v, d]) => [d.key, v]));
const OUTCOMES = {
  gold_correct: "Gold is correct",
  gold_needs_fix: "Gold needs a fix",
  cannot_decide: "Can't decide",
};
const PAGE = 1000; // PostgREST's default row cap per request

// ------------------------------------------------------------------ setup

// No sign-in: the key reaches everything, and each person picks their name.
const db = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
const functionsUrl = config.functionsUrl || `${config.supabaseUrl}/functions/v1`;

const state = { me: null, team: [], view: null, cleanup: [], route: 0 };
// Each page render keeps the route number it started under; after any await it
// stops if the reader has moved on, so a slow page never draws over a newer one.
const current = () => { const mine = state.route; return () => mine === state.route; };
const $app = document.getElementById("app");

async function functionHeaders() {
  return { apikey: config.supabaseKey };
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(`gv-${key}`) ?? "null");
    localStorage.setItem(`gv-${key}`, JSON.stringify(value));
  } catch { return null; }
  return value;
}

async function must(promise) {
  const { data, error, count } = await promise;
  if (error) throw new Error(error.message);
  return count !== undefined && count !== null && data === null ? count : data;
}

/** Every row of a query, a page at a time. */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const page = await must(build().range(from, from + PAGE - 1));
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

// ------------------------------------------------------------------ helpers

const fmt = (v, dp) => v === null || v === undefined || v === "" ? "—"
  : Number(v).toLocaleString("en-US", { maximumFractionDigits: dp ?? 3 });
const nameOf = (email) => state.team.find((m) => m.email === email)?.display_name || email || "—";
const initials = (name) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
const host = (url) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };
const tierChip = (t, dot = true) => `<span class="chip ${t.toLowerCase()}${dot ? " dot" : ""}">${t}</span>`;
const pct = (n, d) => d ? `${Math.round((100 * n) / d)}%` : "0%";
function bar(ok, flagged, total) {
  return `<div class="bar"><span class="ok" style="width:${pct(ok - flagged, total)}"></span><span class="fl" style="width:${pct(flagged, total)}"></span></div>`;
}

let toastTimer;
function toast(html, { undo, error } = {}) {
  const el = document.getElementById("toast");
  el.innerHTML = `${error ? '<span class="chip flag">Error</span>' : '<span class="chip ok">Saved</span>'}<span class="small">${html}</span>`
    + (undo ? '<button class="btn ghost small" data-undo>Undo</button>' : "");
  el.hidden = false;
  if (undo) el.querySelector("[data-undo]").onclick = () => { el.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 8000 : 5000);
}
const fail = (err) => { console.error(err); toast(esc(err.message || err), { error: true }); };

function topbar(active) {
  const me = state.me;
  const link = (hash, label, extra = "") => `<a href="#/${hash}" ${active === hash ? 'aria-current="page"' : ""}>${label}${extra}</a>`;
  return `<header class="topbar">
    <div class="brand">Gold verification</div>
    <nav class="nav row">${link("queue", "Queue")}${link("flags", "Flags", ' <span class="chip flag" id="flagcount" style="padding:0 7px" hidden></span>')}${link("progress", "Progress")}</nav>
    <div class="spacer"></div>
    <button class="btn small" id="exportxlsx" title="Download the tracker workbook with every verdict so far">Export Excel</button>
    <button class="btn ghost small" id="theme" title="Switch light / dark">Theme</button>
    <div class="who"><span class="small muted">${esc(me.name)}</span><div class="avatar" title="${esc(me.email)}">${esc(initials(me.name))}</div></div>
    <button class="btn ghost small" id="switch" title="Not you? Pick another name">Switch</button>
  </header>`;
}

function wireTopbar() {
  document.getElementById("theme").onclick = () => {
    const r = document.documentElement;
    const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    r.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("gv-theme", r.dataset.theme); } catch { /* private window */ }
  };
  document.getElementById("switch").onclick = () => { store("me", null); renderPicker(); };
  document.getElementById("exportxlsx").onclick = exportExcel;
  db.from("row_status").select("gold_id", { count: "exact", head: true }).eq("status", "flagged")
    .then(({ count }) => {
      const el = document.getElementById("flagcount");
      if (el && count) { el.textContent = count; el.hidden = false; }
    });
}

// ------------------------------------------------------------------ who are you

function renderPicker() {
  state.cleanup.forEach((f) => f()); state.cleanup = [];
  $app.innerHTML = `<div class="card signin">
    <h1>Gold verification</h1>
    <p class="muted">Who are you? Your verdicts are saved under this name; this browser remembers it.</p>
    <div class="picker">${state.team.map((m) =>
      `<button class="btn" data-email="${esc(m.email)}">${esc(m.display_name)}</button>`).join("")}</div></div>`;
  $app.querySelectorAll("[data-email]").forEach((b) => b.onclick = () => {
    store("me", b.dataset.email);
    state.me = { email: b.dataset.email, name: nameOf(b.dataset.email) };
    route();
  });
}

// ------------------------------------------------------------------ queue

async function renderQueue() {
  $app.innerHTML = `${topbar("queue")}<section class="page"><div class="empty"><span class="spinner"></span>Loading batches…</div></section>`;
  wireTopbar();
  const live = current();
  const [tiers, batches] = await Promise.all([
    must(db.from("tier_progress").select("*").order("tier")),
    fetchAll(() => db.from("batch_progress").select("*").order("tier").order("issuer").order("id")),
  ]);
  if (!live()) return;
  const f = Object.assign({ tier: "P1", show: "open", q: "" }, store("queue-filter") || {});
  let limit = 60;
  const selected = new Set();

  const section = $app.querySelector("section.page");
  const draw = () => {
    store("queue-filter", f);
    const q = f.q.trim().toLowerCase();
    const list = batches.filter((b) => (f.tier === "all" || b.tier === f.tier)
      && (f.show !== "mine" || b.assignee === state.me.email)
      && (f.show !== "unassigned" || !b.assignee)
      && (f.show !== "open" || b.verified_rows < b.row_count)
      && (f.show !== "flagged" || b.flagged_rows > 0)
      && (!q || `${b.title} ${b.issuer}`.toLowerCase().includes(q)));
    const tierCard = (t) => {
      const desc = { P1: "Peaks, benchmarks, derived quarters, failed checks", P2: "Series ends, prose, issuer sites, exclusions", P3: "Table rows that passed the automated check; companion series" }[t.tier];
      return `<button class="card tier ${f.tier === t.tier ? "on" : ""}" data-tier="${t.tier}">
        ${tierChip(t.tier)}${t.tier === "P1" ? ' <span class="small muted">check first</span>' : ""}
        <div class="n">${fmt(t.verified_rows)} <span class="muted small" style="font-weight:400">of ${fmt(t.rows)} reviewed</span></div>
        ${bar(t.verified_rows, t.flagged_rows, t.rows)}
        <div class="muted small" style="margin-top:8px">${desc}${t.flagged_rows ? ` · <span style="color:var(--flag)">${t.flagged_rows} flagged</span>` : ""}</div></button>`;
    };
    const options = (b) => `<option value="">Unassigned</option>` + state.team.map((m) =>
      `<option value="${esc(m.email)}" ${b.assignee === m.email ? "selected" : ""}>${esc(m.display_name)}</option>`).join("");
    const row = (b) => {
      const done = b.verified_rows >= b.row_count;
      const status = done ? (b.flagged_rows ? `Done · ${b.flagged_rows} flagged` : "Done")
        : b.verified_rows ? `${b.verified_rows} of ${b.row_count}${b.flagged_rows ? ` · ${b.flagged_rows} flagged` : ""}` : "Not started";
      return `<div class="batch" data-batch="${esc(b.id)}">
        <input type="checkbox" class="pick" data-pick="${esc(b.id)}" ${selected.has(b.id) ? "checked" : ""} aria-label="Select ${esc(b.title)}">
        ${tierChip(b.tier, false)}
        <div style="min-width:0"><div class="title" title="${esc(b.title)}">${esc(b.title)}</div>
          <div class="muted small">${b.row_count} rows · ${b.document_count} document${b.document_count === 1 ? "" : "s"}</div></div>
        <div>${bar(b.verified_rows, b.flagged_rows, b.row_count)}<div class="muted small" style="margin-top:4px">${status}</div></div>
        <div class="assign">${b.assignee ? "" : `<button class="btn small" data-claim="${esc(b.id)}">Claim</button>`}
          <select class="input" data-assign="${esc(b.id)}" aria-label="Assignee">${options(b)}</select></div>
        <a class="btn" href="#/batch/${encodeURIComponent(b.id)}">Open</a></div>`;
    };
    const showBtn = (v, label) => `<button class="btn small ${f.show === v ? "on" : ""}" data-show="${v}">${label}</button>`;
    section.innerHTML = `
      <div class="tiers">${tiers.map(tierCard).join("")}</div>
      <div class="filters">
        <button class="btn small ${f.tier === "all" ? "on" : ""}" data-tier="all">All tiers</button>
        ${showBtn("open", "Not finished")}${showBtn("mine", "Mine")}${showBtn("unassigned", "Unassigned")}${showBtn("flagged", "Has flags")}${showBtn("all", "Everything")}
        <span class="spacer"></span>
        <input class="input" id="q" placeholder="Search product or issuer" value="${esc(f.q)}">
      </div>
      <div class="bulk">
        <label class="small"><input type="checkbox" id="pickall" ${list.length && list.every((b) => selected.has(b.id)) ? "checked" : ""}> Select all ${fmt(list.length)} shown</label>
        ${selected.size ? `<span class="small"><b>${fmt(selected.size)}</b> selected</span>
          <button class="btn small primary" id="bulkclaim">Claim selected</button>
          <select class="input" id="bulkto" aria-label="Assign selected to"><option value="" disabled selected>Assign selected to…</option>
            ${state.team.map((m) => `<option value="${esc(m.email)}">${esc(m.display_name)}</option>`).join("")}
            <option value="__none">Unassigned</option></select>
          <button class="btn ghost small" id="bulkclear">Clear</button>` : ""}
      </div>
      <div class="card batches">${list.length ? list.slice(0, limit).map(row).join("") : '<div class="empty">No batches match.</div>'}
        ${list.length > limit ? `<div class="more"><button class="btn small" id="more">Show ${Math.min(60, list.length - limit)} more of ${list.length - limit}</button></div>` : ""}</div>`;
    section.querySelectorAll("[data-tier]").forEach((el) => el.onclick = () => { f.tier = el.dataset.tier; limit = 60; draw(); });
    section.querySelectorAll("[data-show]").forEach((el) => el.onclick = () => { f.show = el.dataset.show; limit = 60; draw(); });
    const q2 = section.querySelector("#q");
    q2.oninput = () => { f.q = q2.value; const pos = q2.selectionStart; draw(); const n = section.querySelector("#q"); n.focus(); n.setSelectionRange(pos, pos); };
    const more = section.querySelector("#more");
    if (more) more.onclick = () => { limit += 60; draw(); };
    const assign = async (b, email) => {
      try {
        await must(db.from("batches").update({ assignee: email || null }).eq("id", b.id));
        b.assignee = email || null;
        toast(`${esc(b.title)} → ${esc(email ? nameOf(email) : "unassigned")}`);
      } catch (err) { fail(err); }
      draw();
    };
    section.querySelectorAll("[data-assign]").forEach((sel) => sel.onchange = () =>
      assign(batches.find((x) => x.id === sel.dataset.assign), sel.value));
    section.querySelectorAll("[data-claim]").forEach((btn) => btn.onclick = () =>
      assign(batches.find((x) => x.id === btn.dataset.claim), state.me.email));
    section.querySelectorAll("[data-pick]").forEach((box) => box.onchange = () => {
      if (box.checked) selected.add(box.dataset.pick); else selected.delete(box.dataset.pick);
      draw();
    });
    section.querySelector("#pickall").onchange = (e) => {
      for (const b of list) if (e.target.checked) selected.add(b.id); else selected.delete(b.id);
      draw();
    };
    const assignMany = async (email) => {
      const ids = [...selected];
      try {
        for (let i = 0; i < ids.length; i += 100) {
          await must(db.from("batches").update({ assignee: email || null }).in("id", ids.slice(i, i + 100)));
        }
        for (const b of batches) if (selected.has(b.id)) b.assignee = email || null;
        toast(`${fmt(ids.length)} batches → ${esc(email ? nameOf(email) : "unassigned")}`);
        selected.clear();
      } catch (err) { fail(err); }
      draw();
    };
    if (selected.size) {
      section.querySelector("#bulkclaim").onclick = () => assignMany(state.me.email);
      section.querySelector("#bulkto").onchange = (e) => assignMany(e.target.value === "__none" ? null : e.target.value);
      section.querySelector("#bulkclear").onclick = () => { selected.clear(); draw(); };
    }
  };
  draw();
}

// ------------------------------------------------------------------ review

async function renderBatch(batchId, wanted) {
  $app.innerHTML = `${topbar("queue")}<section class="page"><div class="empty"><span class="spinner"></span>Loading batch…</div></section>`;
  wireTopbar();
  const live = current();
  const [batch] = await must(db.from("batch_progress").select("*").eq("id", batchId));
  if (!live()) return;
  if (!batch) { $app.querySelector("section").innerHTML = '<div class="empty">That batch is not in the current gold build.</div>'; return; }
  const rows = await must(db.from("rows").select("*").eq("batch_id", batchId).eq("in_current_gold", true)
    .order("source_url").order("drug_name").order("period"));
  const verdicts = new Map(); // gold_id -> [verdict]
  const loadVerdicts = async () => {
    const list = await must(db.from("verdicts").select("*").in("gold_id", rows.map((r) => r.gold_id)));
    verdicts.clear();
    for (const v of list) (verdicts.get(v.gold_id) || verdicts.set(v.gold_id, []).get(v.gold_id)).push(v);
  };
  await loadVerdicts();
  if (!live()) return;
  const mine = (r) => (verdicts.get(r.gold_id) || []).find((v) => v.reviewer === state.me.email);

  let index = rows.findIndex((r) => r.gold_id === wanted);
  if (index < 0) index = Math.max(0, rows.findIndex((r) => !mine(r)));
  let pending = null; // flag reason chosen but not saved
  // A derived total is printed in no document, so the preview shows one of its
  // inputs instead: first the one the row's own document prints.
  let shown = 0;
  const firstInput = (r) => Math.max(0, (r.inputs || []).findIndex((i) => i.source_url === r.source_url));
  const previewRow = (r) => {
    const input = (r.inputs || [])[shown];
    return input ? { ...r, source_url: input.source_url, value_reported: input.value,
      source_value_reported: input.value, source_unit: "millions", source_quote: "" } : r;
  };

  const section = $app.querySelector("section.page");
  section.innerHTML = `<div class="review"><div class="card rowcard" id="card"></div>
    <div class="card preview"><div class="pv-bar">
      <span class="status" id="pvstatus">Loading source…</span>
      <input class="input" id="pvfind" placeholder="Find in document  /">
      <button class="btn ghost small" id="pvnext" title="Next match">↓</button>
      <a class="btn small" id="pvopen" target="gv-source" rel="noopener">Open ↗</a>
    </div><div class="pv-body" id="pv"></div></div></div>`;

  const statusEl = section.querySelector("#pvstatus");
  const preview = new Preview(section.querySelector("#pv"), {
    functionsUrl, headers: functionHeaders,
    onStatus: (s) => {
      const text = {
        loading: "Loading source…",
        searching: `Looking for the figure… page ${s.page} of ${s.of}`,
        found: `Figure found${s.page ? ` on page ${s.page}` : ""} and highlighted`,
        beneath: "Figure found on an unlabelled line under the product's lines and highlighted; check it is the product's total",
        line: `Product line found${s.page ? ` on page ${s.page}` : ""}; the exact figure was not matched, so check the column`,
        quote: `Quoted passage found${s.page ? ` on page ${s.page}` : ""} and highlighted`,
        "label-only": `The figure was not found; ${s.count} mentions of the product are highlighted`,
        "not-found": "Figure not found automatically. Use Find (/) or the quote",
        failed: "Could not load here. Use Open ↗",
      }[s.state];
      statusEl.textContent = text;
      statusEl.className = `status ${["found", "quote"].includes(s.state) ? "ok" : ["beneath", "line", "label-only", "not-found", "failed"].includes(s.state) ? "warn" : ""}`;
    },
  });
  const find = section.querySelector("#pvfind");
  const runFind = async (step = 1) => {
    const r = await preview.find(find.value, step);
    statusEl.textContent = r.count ? `${r.index} of ${r.count}${r.unit ? ` ${r.unit}` : ""} for “${find.value}”` : `No match for “${find.value}”`;
    statusEl.className = "status";
  };
  find.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); } if (e.key === "Escape") find.blur(); };
  section.querySelector("#pvnext").onclick = () => runFind(1);

  const openUrl = (r) => {
    // A text fragment makes the browser scroll to the product's line in an HTML page.
    if (/\.pdf($|\?)/i.test(r.source_url)) return r.source_url;
    return `${r.source_url}#:~:text=${encodeURIComponent(r.line_label || r.drug_name)}`;
  };

  const go = (i) => {
    if (i < 0 || i >= rows.length) return;
    index = i; pending = null;
    history.replaceState(null, "", `#/batch/${encodeURIComponent(batchId)}/${encodeURIComponent(rows[i].gold_id)}`);
    draw(true);
  };

  async function save(verdict, { valueSeen = null, note = "" } = {}) {
    const row = rows[index];
    const before = mine(row);
    const payload = { gold_id: row.gold_id, reviewer: state.me.email, verdict, value_seen: valueSeen, note,
      gold_value_seen: row.value_reported };
    try {
      await must(db.from("verdicts").upsert(payload, { onConflict: "gold_id,reviewer" }));
    } catch (err) { fail(err); return false; }
    await loadVerdicts();
    const label = `${esc(row.drug_name)} ${esc(row.period)} · ${VERDICTS[verdict].label.toLowerCase()}`;
    toast(label, {
      undo: async () => {
        try {
          if (before) await must(db.from("verdicts").upsert({ ...before }, { onConflict: "gold_id,reviewer" }));
          else await must(db.from("verdicts").delete().eq("gold_id", row.gold_id).eq("reviewer", state.me.email));
          await loadVerdicts();
          go(rows.indexOf(row));
        } catch (err) { fail(err); }
      },
    });
    return true;
  }

  async function saveFlag() {
    const card = section.querySelector("#card");
    const raw = card.querySelector("#seen")?.value.replace(/[, \u00a0]/g, "") || "";
    const valueSeen = raw === "" ? null : Number(raw);
    if (raw !== "" && !Number.isFinite(valueSeen)) { toast("The value you read must be a number", { error: true }); return; }
    if (pending === "wrong_value" && valueSeen === null) { card.querySelector("#seen").focus(); toast("Enter the value you read", { error: true }); return; }
    if (await save(pending, { valueSeen, note: card.querySelector("#note").value.trim() })) go(index + 1 < rows.length ? index + 1 : index);
  }

  function draw(rowChanged = false) {
    const r = rows[index];
    if (rowChanged) shown = firstInput(r);
    const own = mine(r);
    const others = (verdicts.get(r.gold_id) || []).filter((v) => v.reviewer !== state.me.email);
    const exclusion = r.kind === "exclusion";
    const statusMark = (x) => { const m = mine(x); return m ? (m.verdict === "confirmed" ? "✓" : "⚑") : "○"; };
    const reviewed = rows.filter(mine).length;
    const flagMode = pending || (own && own.verdict !== "confirmed" ? own.verdict : null);
    const card = section.querySelector("#card");
    card.dataset.goldId = r.gold_id;
    card.innerHTML = `
      <div class="crumbs"><a href="#/queue">← Queue</a><span class="muted">/</span>
        <select class="input" id="jump" aria-label="Row">${rows.map((x, i) =>
          `<option value="${i}" ${i === index ? "selected" : ""}>${statusMark(x)} ${esc(x.drug_name)} ${esc(x.period)}${x.value_reported === null ? "" : ` · ${fmt(x.value_reported)}`}</option>`).join("")}</select>
        <span class="muted small">${reviewed} of ${rows.length} done by you</span></div>
      <div class="head"><div style="min-width:0">
          <div class="drug">${esc(r.drug_name)}</div>
          <div class="meta">${[r.generic_name, r.issuer, r.period || null, r.scope].filter(Boolean).map(esc).join(" · ")}</div></div></div>
      <div class="chips">${tierChip(r.tier)}${r.reasons.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>
      ${exclusion ? `<div class="figure"><span class="num" style="font-size:24px">No figures in gold</span>
          <span class="usd">Excluded: ${esc(r.derivation.replace(/_/g, " "))}</span></div>`
        : `<div class="figure"><span class="num">${fmt(r.value_reported)}</span><span class="unit">${esc(r.currency)} millions</span>
          <span class="usd">${r.source_unit && r.source_unit !== "millions" ? `Printed as ${fmt(r.source_value_reported)} ${esc(r.source_unit)} · ` : ""}${r.derivation.startsWith("direct") ? esc(r.derivation.replace(/_/g, " ")) : `Derived: ${esc(r.derivation.replace(/_/g, " "))}`}${r.currency !== "USD" && r.value_usd_millions !== null ? ` · ≈ ${fmt(r.value_usd_millions, 1)} USD m` : ""}</span></div>`}
      <div class="quote">${esc(r.source_quote)}</div>
      ${(r.inputs || []).length ? `<div class="inputs"><span class="muted small">Not printed: ${r.inputs.map((i) => fmt(i.value)).join(" + ")} = ${fmt(r.value_reported)}. Check each part:</span>
        ${r.inputs.map((i, n) => `<button class="btn ghost small ${n === shown ? "on" : ""}" data-input="${n}">${fmt(i.value)} · ${esc(i.label)} · ${esc(host(i.source_url))}</button>`).join("")}</div>` : ""}
      <div class="srcrow"><a class="btn small" href="${esc(openUrl(previewRow(r)))}" target="gv-source" rel="noopener">Open source ↗ <kbd>O</kbd></a>
        <button class="btn ghost small" id="copyq">Copy quote</button>
        <span class="host">${esc(host(r.source_url))}</span><span class="spacer"></span>
        ${r.automated_check === "pass" ? '<span class="chip ok">automated check passed</span>' : r.automated_check === "fail" ? '<span class="chip flag">automated check failed</span>' : ""}</div>
      ${exclusion ? "" : `<dl class="facts"><div><dt>Reported</dt><dd>${fmt(r.source_value_reported ?? r.value_reported)}</dd></div>
        <div><dt>Unit</dt><dd>${esc(r.source_unit || "—")}</dd></div><div><dt>Currency</dt><dd>${esc(r.currency || "—")}</dd></div>
        <div><dt>Scope</dt><dd>${esc(r.scope || "—")}</dd></div></dl>`}
      ${r.claude_note || r.claude_suggestion ? `<div class="note"><div class="label">Claude's note</div>
        ${r.claude_note ? `<p>${esc(r.claude_note)}</p>` : ""}${r.claude_suggestion ? `<p>${esc(r.claude_suggestion)}</p>` : ""}</div>` : ""}
      ${own ? `<div class="mine"><span class="muted">Your verdict:</span><span class="chip ${own.verdict === "confirmed" ? "ok" : "flag"}">${VERDICTS[own.verdict].label}${own.value_seen !== null ? ` · read ${fmt(own.value_seen)}` : ""}</span>
        ${own.gold_value_seen !== r.value_reported && !(own.gold_value_seen === null && r.value_reported === null) ? `<span class="small stale">given when gold said ${fmt(own.gold_value_seen)}; check again</span>` : ""}</div>` : ""}
      <div class="actions">
        <button class="btn primary" id="confirm">${exclusion ? "Confirm exclusion" : "Confirm"} <kbd>1</kbd></button>
        <button class="btn flagbtn" id="flag">Flag… <kbd>F</kbd></button>
        <span class="spacer"></span>
        <button class="btn ghost" id="prev" ${index === 0 ? "disabled" : ""}>Prev <kbd>K</kbd></button>
        <button class="btn ghost" id="next" ${index === rows.length - 1 ? "disabled" : ""}>Next <kbd>J</kbd></button>
      </div>
      <div id="flagbox" ${flagMode ? "" : "hidden"}>
        <div class="reasons"><span class="muted small">Why is it wrong?</span>
          ${Object.entries(VERDICTS).filter(([v]) => v !== "confirmed").map(([v, d]) =>
            `<button class="btn ${flagMode === v ? "on" : ""}" data-reason="${v}">${d.label} <kbd>${d.key}</kbd></button>`).join("")}</div>
        <div class="flagform">
          <input class="input" id="seen" inputmode="decimal" placeholder="Value you read" value="${own?.value_seen ?? ""}">
          <input class="input" id="note" placeholder="Note: what you saw and where" value="${esc(own?.note || "")}">
        </div>
        <div class="actions" style="border:0;padding-top:0;margin-top:10px"><button class="btn" id="saveflag" ${flagMode ? "" : "disabled"}>Save flag <kbd>Enter</kbd></button>
          <button class="btn ghost small" id="cancelflag">Cancel <kbd>Esc</kbd></button></div>
      </div>
      ${others.length ? `<div class="others"><span class="muted">Others:</span>${others.map((v) =>
        `<span class="chip ${v.verdict === "confirmed" ? "ok" : "flag"}" title="${esc(v.note)}">${esc(nameOf(v.reviewer))} · ${VERDICTS[v.verdict].label.toLowerCase()}${v.value_seen !== null ? ` ${fmt(v.value_seen)}` : ""}</span>`).join("")}</div>` : ""}
      <div class="keys"><span><kbd>1</kbd> confirm</span><span><kbd>F</kbd> then <kbd>2</kbd>–<kbd>6</kbd> flag</span>
        <span><kbd>J</kbd>/<kbd>K</kbd> next / prev</span><span><kbd>O</kbd> open source</span><span><kbd>/</kbd> find in document</span></div>`;

    card.querySelector("#jump").onchange = (e) => go(Number(e.target.value));
    card.querySelector("#copyq").onclick = () => navigator.clipboard.writeText(r.source_quote).then(() => toast("Quote copied"));
    card.querySelector("#confirm").onclick = async () => { if (await save("confirmed")) go(index + 1 < rows.length ? index + 1 : index); };
    card.querySelector("#flag").onclick = () => { card.querySelector("#flagbox").hidden = false; };
    card.querySelector("#prev").onclick = () => go(index - 1);
    card.querySelector("#next").onclick = () => go(index + 1);
    card.querySelectorAll("[data-reason]").forEach((b) => b.onclick = () => choose(b.dataset.reason));
    card.querySelector("#saveflag").onclick = saveFlag;
    card.querySelector("#cancelflag").onclick = () => { pending = null; draw(); };
    card.querySelectorAll("[data-input]").forEach((b) => b.onclick = () => {
      shown = Number(b.dataset.input);
      find.value = ""; preview.findQuery = null; preview.show(previewRow(r)); draw();
    });
    section.querySelector("#pvopen").href = openUrl(previewRow(r));
    if (rowChanged) { find.value = ""; preview.findQuery = null; preview.show(previewRow(r)); card.scrollTop = 0; }
  }

  function choose(reason) {
    pending = reason;
    const card = section.querySelector("#card");
    card.querySelector("#flagbox").hidden = false;
    card.querySelectorAll("[data-reason]").forEach((b) => b.classList.toggle("on", b.dataset.reason === reason));
    card.querySelector("#saveflag").disabled = false;
    card.querySelector(reason === "wrong_value" ? "#seen" : "#note").focus();
  }

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    const card = section.querySelector("#card");
    if (typing) {
      if (document.activeElement === find) return;
      if (e.key === "Enter" && pending && card.contains(document.activeElement)) { e.preventDefault(); saveFlag(); }
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "1") { e.preventDefault(); card.querySelector("#confirm").click(); }
    else if (k === "f") { e.preventDefault(); card.querySelector("#flagbox").hidden = false; }
    else if (FLAG_KEYS[k]) { e.preventDefault(); choose(FLAG_KEYS[k]); }
    else if (k === "enter" && pending) { e.preventDefault(); saveFlag(); }
    else if (k === "escape") { pending = null; draw(); }
    else if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); go(index + 1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); go(index - 1); }
    else if (k === "o") { e.preventDefault(); window.open(openUrl(previewRow(rows[index])), "gv-source", "noopener"); }
    else if (k === "/") { e.preventDefault(); find.focus(); find.select(); }
  };
  document.addEventListener("keydown", onKey);
  state.cleanup.push(() => document.removeEventListener("keydown", onKey));
  state.onChange = async (table, record) => {
    if (table === "verdicts" && rows.some((r) => r.gold_id === record?.gold_id)) { await loadVerdicts(); draw(); }
  };
  draw(true);
}

// ------------------------------------------------------------------ flags

async function renderFlags() {
  $app.innerHTML = `${topbar("flags")}<section class="page"><div class="empty"><span class="spinner"></span>Loading flags…</div></section>`;
  wireTopbar();
  const live = current();
  const showResolved = store("flags-resolved") || false;
  const status = await fetchAll(() => db.from("row_status").select("gold_id,status,resolved")
    .gt("flagged_count", 0).order("gold_id"));
  const ids = status.filter((s) => showResolved ? s.resolved : s.status === "flagged").map((s) => s.gold_id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  const rows = (await Promise.all(chunks.map((c) => must(db.from("rows").select("*").in("gold_id", c))))).flat();
  const verdicts = (await Promise.all(chunks.map((c) => must(db.from("verdicts").select("*").in("gold_id", c))))).flat();
  const resolutions = (await Promise.all(chunks.map((c) => must(db.from("resolutions").select("*").in("gold_id", c))))).flat();
  if (!live()) return;
  rows.sort((a, b) => a.tier.localeCompare(b.tier) || a.drug_name.localeCompare(b.drug_name) || a.period.localeCompare(b.period));

  const section = $app.querySelector("section.page");
  const item = (r) => {
    const vs = verdicts.filter((v) => v.gold_id === r.gold_id);
    const res = resolutions.find((x) => x.gold_id === r.gold_id);
    return `<div class="flagitem" data-id="${esc(r.gold_id)}"><div style="min-width:0">
        <div class="row">${tierChip(r.tier)}<b>${esc(r.drug_name)} ${esc(r.period)}</b><span class="muted">${esc(r.issuer)}</span>
          <span class="spacer"></span><a class="small" href="#/batch/${encodeURIComponent(r.batch_id)}/${encodeURIComponent(r.gold_id)}">Review this row →</a></div>
        <div style="margin-top:6px">Gold: <b>${r.value_reported === null ? "excluded" : fmt(r.value_reported)}</b> <span class="muted">${esc(r.currency)} m · ${esc(r.scope || "")}</span></div>
        <div class="quote" style="margin-top:8px">${esc(r.source_quote)}</div>
        <div class="verdicts">${vs.map((v) => `<div class="v"><span class="chip ${v.verdict === "confirmed" ? "ok" : "flag"}">${esc(nameOf(v.reviewer))} · ${VERDICTS[v.verdict].label}${v.value_seen !== null ? ` · read ${fmt(v.value_seen)}` : ""}</span> ${esc(v.note)}</div>`).join("")}</div>
        ${r.claude_note ? `<div class="note"><div class="label">Claude's note</div><p>${esc(r.claude_note)}</p></div>` : ""}
      </div>
      <div class="resolve">${res ? `<div class="small">Resolved by ${esc(nameOf(res.resolved_by))}: <b>${OUTCOMES[res.outcome]}</b>${res.note ? ` · ${esc(res.note)}` : ""}</div>` : ""}
        <textarea class="input" rows="3" placeholder="What did you decide, and why?" data-note>${esc(res?.note || "")}</textarea>
        ${Object.entries(OUTCOMES).map(([o, label]) => `<button class="btn ${res?.outcome === o ? "on" : ""}" data-outcome="${o}">${label}</button>`).join("")}
      </div></div>`;
  };
  section.innerHTML = `<div class="pagehead"><h1>Flags</h1><span class="muted">${ids.length} ${showResolved ? "resolved" : "waiting for a decision"}</span>
      <span class="spacer"></span><button class="btn small" id="toggle">${showResolved ? "Show open flags" : "Show resolved"}</button></div>
    <div class="card">${rows.length ? rows.map(item).join("") : `<div class="empty">${showResolved ? "Nothing resolved yet." : "No open flags."}</div>`}</div>`;
  section.querySelector("#toggle").onclick = () => { store("flags-resolved", !showResolved); renderFlags(); };
  section.querySelectorAll("[data-outcome]").forEach((b) => b.onclick = async () => {
    const box = b.closest(".flagitem");
    try {
      await must(db.from("resolutions").upsert({ gold_id: box.dataset.id, outcome: b.dataset.outcome,
        note: box.querySelector("[data-note]").value.trim(), resolved_by: state.me.email }, { onConflict: "gold_id" }));
      toast(`Resolved: ${OUTCOMES[b.dataset.outcome]}`);
      renderFlags();
    } catch (err) { fail(err); }
  });
}

// ------------------------------------------------------------------ progress

async function renderProgress() {
  $app.innerHTML = `${topbar("progress")}<section class="page"><div class="empty"><span class="spinner"></span>Loading…</div></section>`;
  wireTopbar();
  const live = current();
  const [tiers, people, kinds, currentRows, build] = await Promise.all([
    must(db.from("tier_progress").select("*").order("tier")),
    must(db.from("reviewer_progress").select("*").order("verdicts", { ascending: false })),
    fetchAll(() => db.from("row_status").select("kind,status").order("gold_id")),
    must(db.from("rows").select("gold_id", { count: "exact", head: true }).eq("in_current_gold", true)),
    must(db.from("rows").select("gold_build,loaded_at").eq("in_current_gold", true).order("loaded_at", { ascending: false }).limit(1)),
  ]);
  if (!live()) return;
  const byKind = {};
  for (const k of kinds) {
    const e = byKind[k.kind] ||= { rows: 0, done: 0, flagged: 0 };
    e.rows++; if (k.status !== "unverified") e.done++; if (k.status === "flagged") e.flagged++;
  }
  const total = tiers.reduce((a, t) => a + t.rows, 0);
  const done = tiers.reduce((a, t) => a + t.verified_rows, 0);
  const section = $app.querySelector("section.page");
  section.innerHTML = `<div class="pagehead"><h1>Progress</h1><span class="muted">${fmt(done)} of ${fmt(total)} rows reviewed (${pct(done, total)})</span></div>
    <div class="grid2">
      <div class="card panel"><h3>By tier</h3><table class="plain"><tr><th>Tier</th><th class="n">Rows</th><th class="n">Reviewed</th><th class="n">Flagged</th><th style="width:40%"></th></tr>
        ${tiers.map((t) => `<tr><td>${tierChip(t.tier)}</td><td class="n">${fmt(t.rows)}</td><td class="n">${fmt(t.verified_rows)}</td><td class="n">${fmt(t.flagged_rows)}</td><td>${bar(t.verified_rows, t.flagged_rows, t.rows)}</td></tr>`).join("")}</table></div>
      <div class="card panel"><h3>By kind of row</h3><table class="plain"><tr><th>Kind</th><th class="n">Rows</th><th class="n">Reviewed</th><th class="n">Flagged</th></tr>
        ${Object.entries(byKind).sort().map(([k, e]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(e.rows)}</td><td class="n">${fmt(e.done)}</td><td class="n">${fmt(e.flagged)}</td></tr>`).join("")}</table></div>
      <div class="card panel"><h3>Reviewers</h3><table class="plain"><tr><th>Who</th><th class="n">Verdicts</th><th class="n">Confirmed</th><th class="n">Flagged</th><th>Last active</th></tr>
        ${people.map((p) => `<tr><td>${esc(p.display_name)}</td><td class="n">${fmt(p.verdicts)}</td><td class="n">${fmt(p.confirmed)}</td><td class="n">${fmt(p.flagged)}</td><td class="small muted">${p.last_active ? new Date(p.last_active).toLocaleString() : "—"}</td></tr>`).join("")}</table></div>
      <div class="card panel"><h3>Gold rows</h3><div class="loadbox">
        <div class="small">${fmt(currentRows)} rows in the current build${build[0] ? ` · build ${esc(build[0].gold_build)}, loaded ${new Date(build[0].loaded_at).toLocaleString()}` : ""}.</div>
        <div class="small muted">To load or refresh, choose <code>data/rows.json</code> (made by <code>scripts/build_rows.py</code>). Verdicts are kept; rows whose figure changed show their verdicts as needing a re-check.</div>
        <input type="file" id="goldfile" accept="application/json,.json" class="input">
        <div id="loadmsg" class="small"></div>
        <div><button class="btn small" id="export">Download all verdicts (CSV)</button></div>
      </div></div>
    </div>`;
  section.querySelector("#goldfile").onchange = (e) => loadGold(e.target.files[0], section.querySelector("#loadmsg"));
  section.querySelector("#export").onclick = exportVerdicts;
}

async function loadGold(file, msg) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.rows) || !Array.isArray(data.batches)) throw new Error("not a rows.json file");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    const build = `${data.gold_as_of || "gold"}-${[...digest.slice(0, 5)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    msg.textContent = `Loading ${data.batches.length} batches…`;
    await must(db.rpc("load_gold", { build, batches_in: data.batches, rows_in: [] }));
    const CHUNK = 400;
    for (let i = 0; i < data.rows.length; i += CHUNK) {
      msg.textContent = `Loading rows ${fmt(i + 1)}–${fmt(Math.min(i + CHUNK, data.rows.length))} of ${fmt(data.rows.length)}…`;
      await must(db.rpc("load_gold", { build, rows_in: data.rows.slice(i, i + CHUNK) }));
    }
    await must(db.rpc("load_gold", { build, finish: true }));
    const count = await must(db.from("rows").select("gold_id", { count: "exact", head: true }).eq("in_current_gold", true).eq("gold_build", build));
    msg.innerHTML = count === data.rows.length
      ? `<span class="chip ok">Loaded</span> ${fmt(count)} rows, build ${esc(build)}; the database holds exactly the file's rows.`
      : `<span class="chip flag">Mismatch</span> the file has ${fmt(data.rows.length)} rows but the database holds ${fmt(count)} for this build.`;
  } catch (err) {
    msg.innerHTML = `<span class="chip flag">Failed</span> ${esc(err.message)}`;
  }
}

async function exportExcel() {
  const btn = document.getElementById("exportxlsx");
  btn.disabled = true; btn.textContent = "Exporting…";
  try {
    const [rows, verdicts, resolutions] = await Promise.all([
      fetchAll(() => db.from("rows").select("gold_id,kind,tier,drug_name,generic_name,issuer,period,value_reported,currency,scope,derivation,source_url,source_quote,automated_check")
        .eq("in_current_gold", true).order("gold_id")),
      fetchAll(() => db.from("verdicts").select("*").order("gold_id").order("reviewer")),
      fetchAll(() => db.from("resolutions").select("*").order("gold_id")),
    ]);
    const blob = await buildTracker({ rows, verdicts, resolutions, nameOf });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gold-verification-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    toast(`Exported ${fmt(rows.length)} rows and ${fmt(verdicts.length)} verdicts`);
  } catch (err) { fail(err); }
  btn.disabled = false; btn.textContent = "Export Excel";
}

async function exportVerdicts() {
  const verdicts = await fetchAll(() => db.from("verdicts").select("*").order("gold_id").order("reviewer"));
  const resolutions = new Map((await fetchAll(() => db.from("resolutions").select("*").order("gold_id"))).map((r) => [r.gold_id, r]));
  const cols = ["gold_id", "reviewer", "verdict", "value_seen", "gold_value_seen", "note", "updated_at", "resolution", "resolution_note", "resolved_by"];
  const cell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(",")].concat(verdicts.map((v) => {
    const r = resolutions.get(v.gold_id);
    return [v.gold_id, v.reviewer, v.verdict, v.value_seen, v.gold_value_seen, v.note, v.updated_at, r?.outcome, r?.note, r?.resolved_by].map(cell).join(",");
  }));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `gold-verdicts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ------------------------------------------------------------------ routing

async function route() {
  state.cleanup.forEach((f) => f()); state.cleanup = []; state.onChange = null;
  state.route += 1;
  const [, page, a, b] = (location.hash || "#/queue").split("/").map(decodeURIComponent);
  try {
    if (page === "batch" && a) await renderBatch(a, b);
    else if (page === "flags") await renderFlags();
    else if (page === "progress") await renderProgress();
    else await renderQueue();
  } catch (err) {
    fail(err);
    $app.querySelector("section.page")?.replaceChildren(Object.assign(document.createElement("div"),
      { className: "empty", textContent: `Something went wrong: ${err.message}` }));
  }
}

function subscribe() {
  try {
    let timer;
    const channel = db.channel("gold-verification");
    for (const table of ["verdicts", "batches", "resolutions"]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, (p) => {
        if (state.onChange) return state.onChange(table, p.new || p.old);
        if (location.hash.startsWith("#/batch")) return;
        clearTimeout(timer);
        timer = setTimeout(() => { if (!document.querySelector(":focus")) route(); }, 1500);
      });
    }
    channel.subscribe();
  } catch (err) { console.warn("live updates unavailable", err); }
}

async function main() {
  try {
    state.team = (await must(db.from("team_members").select("*").order("display_name")))
      .map((m) => ({ ...m, email: m.email.toLowerCase() }));
  } catch (err) {
    $app.innerHTML = `<div class="empty">Could not reach the database: ${esc(err.message)}</div>`;
    return;
  }
  window.addEventListener("hashchange", () => { if (state.me) route(); });
  subscribe();
  const saved = store("me");
  if (!saved || !state.team.some((m) => m.email === saved)) return renderPicker();
  state.me = { email: saved, name: nameOf(saved) };
  route();
}

main();
