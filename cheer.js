// Milestones and the confetti that marks them.
//
// What is celebrated is finished work and flags that held up, never speed:
// a batch closed, a round number of your own verdicts, a tier or the whole of
// gold reaching a share, and a flag that led to a gold fix. Each milestone
// fires once per person per browser (remembered under gv-cheer-<email>).

/** Your own verdict counts worth a moment. */
export const PERSONAL_STEPS = [50, 100, 250, 500, 1000, 2000, 4000, 8000];
/** Shares of all of gold, in percent, announced to the whole team. */
export const GOLD_STEPS = [25, 50, 75, 100];

/** The largest step that `before` had not reached and `after` has, else null. */
export function crossed(steps, before, after) {
  let hit = null;
  for (const s of steps) if (before < s && after >= s) hit = s;
  return hit;
}

/**
 * Team milestones reached, from tier_progress rows: every tier at 100%, and
 * each GOLD_STEPS share of all rows. Keys are stable, so each fires once.
 */
export function teamMilestones(tiers) {
  const out = [];
  for (const t of tiers) {
    if (t.rows && t.verified_rows >= t.rows) out.push({ key: `tier:${t.tier}`, text: `${t.tier} is fully reviewed` });
  }
  const rows = tiers.reduce((a, t) => a + t.rows, 0);
  const done = tiers.reduce((a, t) => a + t.verified_rows, 0);
  for (const s of GOLD_STEPS) {
    if (rows && done * 100 >= s * rows) {
      out.push({ key: `gold:${s}`, text: s === 100 ? "All of gold is reviewed" : `${s}% of gold is reviewed` });
    }
  }
  return out;
}

/**
 * For each batch every row of which has a verdict, who closed it: the
 * reviewer whose verdict was the first one on the batch's last row to get one.
 * rows: [{gold_id, batch_id}]; verdicts: [{gold_id, reviewer, created_at}].
 * Returns Map(batch_id -> reviewer).
 */
export function batchFinishers(rows, verdicts) {
  const first = new Map(); // gold_id -> earliest verdict
  for (const v of verdicts) {
    const seen = first.get(v.gold_id);
    if (!seen || v.created_at < seen.created_at) first.set(v.gold_id, v);
  }
  const batches = new Map(); // batch_id -> {open, last}
  for (const r of rows) {
    const b = batches.get(r.batch_id) || batches.set(r.batch_id, { open: false, last: null }).get(r.batch_id);
    const v = first.get(r.gold_id);
    if (!v) b.open = true;
    else if (!b.last || v.created_at > b.last.created_at) b.last = v;
  }
  const out = new Map();
  for (const [id, b] of batches) if (!b.open && b.last) out.set(id, b.last.reviewer);
  return out;
}

/**
 * Flags that held up: rows resolved "gold needs a fix", credited to every
 * reviewer who flagged them. Returns [{gold_id, reviewer}].
 */
export function catches(resolutions, verdicts) {
  const fixed = new Set(resolutions.filter((r) => r.outcome === "gold_needs_fix").map((r) => r.gold_id));
  return verdicts.filter((v) => fixed.has(v.gold_id) && v.verdict !== "confirmed")
    .map((v) => ({ gold_id: v.gold_id, reviewer: v.reviewer }));
}

// ---------------------------------------------------------------- memory

/** The milestones this person has already been shown, or null on a first visit. */
export function shown(email) {
  try { const v = JSON.parse(localStorage.getItem(`gv-cheer-${email}`)); return v && typeof v === "object" ? v : null; }
  catch { return null; }
}

/** Record milestone keys as shown, with the day they fired. */
export function remember(email, keys) {
  const all = shown(email) || {};
  const day = today();
  for (const k of keys) all[k] ??= day;
  try { localStorage.setItem(`gv-cheer-${email}`, JSON.stringify(all)); } catch { /* private window */ }
  return all;
}

/** Local calendar day, YYYY-MM-DD. */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- confetti

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A short burst of confetti from `from` (an element, else the top centre), in
 * the app's own colours. Drawn on a canvas that ignores the pointer and is
 * gone in under two seconds; nothing at all under reduced motion.
 */
export function confetti(from) {
  if (typeof document === "undefined" || reducedMotion()) return;
  const css = getComputedStyle(document.documentElement);
  const colours = ["--ok", "--accent", "--p2", "--claude", "--flag"].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
  const canvas = Object.assign(document.createElement("canvas"), { className: "confetti" });
  const ratio = window.devicePixelRatio || 1;
  canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio;
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const box = from?.getBoundingClientRect?.();
  const x0 = box ? box.left + box.width / 2 : innerWidth / 2;
  const y0 = box ? box.top + box.height / 2 : innerHeight * 0.25;
  const bits = Array.from({ length: 70 }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 5 + Math.random() * 6;
    return { x: x0, y: y0, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      size: 4 + Math.random() * 4, spin: Math.random() * Math.PI, turn: (Math.random() - 0.5) * 0.3,
      colour: colours[i % colours.length] };
  });
  const start = performance.now();
  const LIFE = 1600;
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.globalAlpha = Math.max(0, 1 - t / LIFE);
    for (const b of bits) {
      b.vy += 0.25; b.vx *= 0.985; b.x += b.vx; b.y += b.vy; b.spin += b.turn;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.spin);
      ctx.fillStyle = b.colour; ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
      ctx.restore();
    }
    if (t < LIFE) requestAnimationFrame(frame); else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- the note

let cheerTimer;
/** A celebration toast, above the save toast so it never hides an Undo. */
export function cheer(html, { burst = true, from } = {}) {
  const el = document.getElementById("cheer");
  if (!el) return;
  el.innerHTML = `<span class="small">${html}</span>`;
  el.hidden = false;
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => { el.hidden = true; }, 6000);
  if (burst) confetti(from);
}
