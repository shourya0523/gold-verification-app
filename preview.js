// Shows a row's source document inside the app and points at the figure.
//
// The document comes through the `source` Edge Function (see
// supabase/functions/source), so a host's framing rules do not matter and the
// app can reach into the page. HTML is shown in a script-less sandboxed
// iframe; PDFs are drawn with pdf.js. Either way the row is located from what
// the row itself says: its line label, and the figure as the source printed it.

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const cache = new Map(); // source_url -> Promise<{type, text|bytes, finalUrl}>

// ---------------------------------------------------------------- matching

const norm = (s) => (s || "").replace(/[®™*†‡]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ways a document may print a number: 1234.5 -> 1,234.5 / 1234.5 / 1 234.5 / 1.234,5. */
export function figureVariants(value) {
  if (value === null || value === undefined || value === "") return [];
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n)) return [];
  const out = new Set();
  for (const dp of [0, 1, 2, 3]) {
    const scaled = n * 10 ** dp;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) continue;
    const [int, frac] = n.toFixed(dp).split(".");
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    for (const body of [int, grouped, grouped.replace(/,/g, " "), grouped.replace(/,/g, "\u00a0")]) {
      out.add(frac ? `${body}.${frac}` : body);
    }
    // Continental style: 1.234,5
    out.add(frac ? `${grouped.replace(/,/g, ".")},${frac}` : grouped.replace(/,/g, "."));
  }
  return [...out].filter(Boolean);
}

/** Numbers printed in the row's quote, for derived rows whose result is not in the document. */
function quoteNumbers(quote) {
  return (quote.match(/\d[\d,.\u00a0 ]*\d|\d/g) || [])
    .map((t) => t.trim())
    .filter((t) => !/^(19|20)\d\d$/.test(t) && t.length > 0);
}

/** A regex matching any of the figure strings as a whole number. */
function figureRegex(strings) {
  const parts = [...new Set(strings)].sort((a, b) => b.length - a.length).map(escapeRe);
  if (!parts.length) return null;
  return new RegExp(`(?<![\\d.,])(?:${parts.join("|")})(?![\\d]|[.,]\\d)`, "g");
}

/** Names a document may print the product under: its line label, brand, generic
 * name, and the brand's first word (Calderon for "Calderon XR"). */
function namesFor(row) {
  const first = (row.drug_name || "").split(/[\s/]+/)[0];
  return [...new Set([row.line_label, row.drug_name, row.generic_name, first.length >= 5 ? first : null]
    .map(norm).filter((n) => n && n.length >= 3))];
}

/** Verbatim-looking pieces of the quote (between pipes), long enough to be distinctive. */
function quotePieces(quote) {
  return (quote || "").split("|").map((p) => p.trim()).filter((p) => p.length >= 12 && p.length <= 160);
}

export function targetsFor(row) {
  const printed = row.source_value_reported ?? row.value_reported;
  const primary = figureVariants(printed);
  const fromQuote = quoteNumbers(row.source_quote || "");
  const names = namesFor(row);
  return {
    names,
    hasName: (text) => names.some((n) => text.includes(n)),
    primary: figureRegex(primary),
    secondary: figureRegex([...primary, ...fromQuote]),
    pieces: quotePieces(row.source_quote).map(norm),
  };
}

// ---------------------------------------------------------------- fetching

export function fetchSource(url, { functionsUrl, headers }) {
  if (!cache.has(url)) {
    const p = (async () => {
      const res = await fetch(`${functionsUrl}/source?url=${encodeURIComponent(url)}`, { headers });
      if (!res.ok) {
        let reason = `${res.status}`;
        try { reason = (await res.json()).error || reason; } catch { /* not json */ }
        throw new Error(reason);
      }
      // The function platform relabels HTML as text/plain, so the function
      // passes the source's own type alongside.
      const type = (res.headers.get("x-source-content-type") || res.headers.get("content-type") || "").toLowerCase();
      const finalUrl = res.headers.get("x-final-url") || url;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const isPdf = type.includes("pdf") || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
      if (isPdf) return { type: "pdf", bytes, finalUrl };
      const charset = /charset=([\w-]+)/.exec(type)?.[1] || "utf-8";
      let text;
      try { text = new TextDecoder(charset).decode(bytes); } catch { text = new TextDecoder().decode(bytes); }
      const looksHtml = /^\s*(<!doctype html|<html|<\?xml[^>]*>\s*<!doctype html)/i.test(text.slice(0, 2000))
        || /<(body|table|div)[\s>]/i.test(text.slice(0, 20000));
      return { type: type.includes("text/plain") && !looksHtml ? "text" : "html", text, finalUrl };
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return cache.get(url);
}

// ---------------------------------------------------------------- HTML

const HIGHLIGHT_CSS = `
  mark.gv-fig { background: #ffd54a; color: #000; outline: 2px solid #d39e00; border-radius: 2px; }
  mark.gv-label { background: #cfe0f5; color: #000; border-radius: 2px; }
  mark.gv-find { background: #ffe9a8; color: #000; }
  mark.gv-find.gv-current { background: #ff9f43; }
  .gv-row { outline: 3px solid #2d5a87 !important; outline-offset: 1px; background: #eef4fb !important; }
`;

function markText(root, regex, cls, limit = 50) {
  if (!regex) return [];
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  for (const node of nodes) {
    if (marks.length >= limit) break;
    const text = node.nodeValue;
    regex.lastIndex = 0;
    let m; let last = 0; const frag = doc.createDocumentFragment(); let hit = false;
    while ((m = regex.exec(text)) && marks.length < limit) {
      if (m[0] === "") { regex.lastIndex++; continue; }
      hit = true;
      frag.append(text.slice(last, m.index));
      const mark = doc.createElement("mark");
      mark.className = cls; mark.textContent = m[0];
      frag.append(mark); marks.push(mark);
      last = m.index + m[0].length;
    }
    if (hit) { frag.append(text.slice(last)); node.replaceWith(frag); }
  }
  return marks;
}

function namesRegex(names) {
  if (!names.length) return null;
  const one = (n) => n.split(" ").map(escapeRe).join("[\\s\\u00a0]*[®™*]?[\\s\\u00a0]*");
  return new RegExp(names.map(one).join("|"), "gi");
}

// Whitespace-free lower case, for a cheap first test before spacedText().
const squash = (s) => norm(s).replace(/\s+/g, "");

/** The smallest element whose text contains one of the quote's pieces. */
function locateQuoteInHtml(doc, t) {
  const elements = [...doc.querySelectorAll("p, li, td, tr, h1, h2, h3, h4, div, span")];
  for (const piece of t.pieces) {
    const squashed = piece.replace(/\s+/g, "");
    let best = null;
    for (const el of elements) {
      const raw = el.textContent;
      if (raw.length > 20000 || (best && raw.length >= best.textContent.length)) continue;
      if (!squash(raw).includes(squashed)) continue;
      if (norm(spacedText(el)).includes(piece)) best = el;
    }
    if (best) return best;
  }
  return null;
}

/** An element's text with its text nodes joined by spaces: table cells sit
 * side by side with no whitespace between them, so textContent of a row
 * "Calderon | 240 | 8 | 248" reads "Calderon2408248" and no figure matches. */
function spacedText(el) {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(" ").replace(/\u00a0/g, " ");
}

/** Find the element (table row first, then a text block) carrying the label and the figure. */
function locateInHtml(doc, t) {
  const squashedNames = t.names.map((n) => n.replace(/\s+/g, ""));
  const named = (el) => {
    const raw = el.textContent;
    return raw.length <= 4000 && squashedNames.some((n) => squash(raw).includes(n));
  };
  const has = (el, rx) => { rx.lastIndex = 0; return rx.test(spacedText(el)); };
  const rowsOf = (selector) => [...doc.querySelectorAll(selector)].filter(named);
  const tableRows = rowsOf("tr");
  const blocks = rowsOf("p, li, td, div:not(:has(div,p,table))");
  for (const rx of [t.primary, t.secondary]) {
    if (!rx) continue;
    const hit = tableRows.find((el) => has(el, rx)) || blocks.find((el) => has(el, rx));
    if (hit) return { el: hit, exact: rx === t.primary };
  }
  // A product printed as regional lines ("Calderon - U.S.", "Europe", ...)
  // often has its total on an unlabelled line just beneath them.
  if (t.primary) {
    for (const el of tableRows) {
      let next = el.nextElementSibling;
      for (let step = 0; next && step < 5; step += 1, next = next.nextElementSibling) {
        if (next.tagName === "TR" && has(next, t.primary)) return { el: next, exact: true, beneath: el };
      }
    }
  }
  return null;
}

function stripActive(html, baseUrl) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, noscript, iframe, object, embed, meta[http-equiv]").forEach((n) => n.remove());
  parsed.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  });
  const base = parsed.createElement("base");
  base.href = baseUrl; base.target = "_blank";
  parsed.head.prepend(base);
  const style = parsed.createElement("style");
  style.textContent = HIGHLIGHT_CSS;
  parsed.head.append(style);
  return "<!doctype html>" + parsed.documentElement.outerHTML;
}

/**
 * Undo whatever keeps el out of sight in a source page: a collapsed "read
 * more" section, a closed <details>, a hidden attribute. The page's own button
 * for it needs the scripts the preview removes.
 */
export function reveal(el) {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  for (let node = el; node; node = node.parentElement) {
    if (node instanceof win.HTMLDetailsElement) node.open = true;
    node.removeAttribute("hidden");
    const style = win.getComputedStyle(node);
    if (style.display === "none") node.style.setProperty("display", "block", "important");
    if (style.visibility === "hidden") node.style.setProperty("visibility", "visible", "important");
  }
}

/** Scroll only the document pane (never the app page) so el sits mid-view. */
function centerIn(el) {
  reveal(el);
  const doc = el.ownerDocument;
  const r = el.getBoundingClientRect();
  if (doc !== document) {
    const win = doc.defaultView;
    // Sideways only when the figure would be off screen, so the row's label
    // stays in view where it fits.
    const left = r.right + win.scrollX <= win.innerWidth ? 0 : Math.max(0, win.scrollX + r.left - 40);
    win.scrollTo({ top: win.scrollY + r.top - win.innerHeight / 2 + r.height / 2, left });
    return;
  }
  const pane = el.closest(".pv-body");
  if (!pane) return;
  const p = pane.getBoundingClientRect();
  pane.scrollTop += r.top - p.top - pane.clientHeight / 2 + r.height / 2;
}

// ---------------------------------------------------------------- PDF

let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfjsPromise;
}

/** Text items of one page grouped into visual lines. */
export async function pageLines(page) {
  const content = await page.getTextContent();
  const lines = new Map();
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const key = Math.round(item.transform[5] / 3);
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(item);
  }
  return [...lines.values()].map((items) => {
    items.sort((a, b) => a.transform[4] - b.transform[4]);
    return { items, text: items.map((i) => i.str).join(" ") };
  });
}

/** For each line naming the product, the items printed level with it: a table
 * row whose label and numbers sit at slightly different heights. A name printed
 * as a heading, with no numbers of its own, is followed by its lines beneath
 * (US / Intl / WW) down to the next line without numbers, the next heading. */
export function rowBands(lines, t) {
  const items = lines.flatMap((l) => l.items);
  const bandAt = (line) => {
    const y = line.items[0].transform[5];
    const tol = Math.max(3, (line.items[0].height || 8) * 0.6);
    const level = items.filter((i) => Math.abs(i.transform[5] - y) <= tol).sort((a, b) => a.transform[4] - b.transform[4]);
    return { items: level, text: level.map((i) => i.str).join(" ") };
  };
  const ordered = [...lines].sort((a, b) => b.items[0].transform[5] - a.items[0].transform[5]);
  const bands = [];
  ordered.forEach((line, n) => {
    if (!t.hasName(norm(line.text))) return;
    const own = bandAt(line);
    bands.push(own);
    if (/\d/.test(own.text)) return;
    for (const below of ordered.slice(n + 1)) {
      if (!/\d/.test(below.text) || t.hasName(norm(below.text))) break;
      bands.push({ ...bandAt(below), heading: own.items });
    }
  });
  return bands;
}

// ---------------------------------------------------------------- the pane

export class Preview {
  constructor(host, { functionsUrl, headers, onStatus }) {
    this.host = host;
    this.functionsUrl = functionsUrl;
    this.headers = headers;
    this.onStatus = onStatus || (() => {});
    this.token = 0;
    this.findMarks = [];
    this.findIndex = -1;
  }

  async show(row) {
    const token = ++this.token;
    this.row = row;
    this.mode = null;
    this.host.innerHTML = `<div class="pv-empty"><span class="spinner"></span>Loading source…</div>`;
    this.onStatus({ state: "loading" });
    let doc;
    try {
      doc = await fetchSource(row.source_url, { functionsUrl: this.functionsUrl, headers: await this.headers() });
    } catch (err) {
      if (token !== this.token) return;
      this.host.innerHTML = `<div class="pv-empty"><p>This source could not be loaded here (${escapeHtml(err.message)}).</p>
        <p><a class="btn" href="${escapeAttr(row.source_url)}" target="gv-source" rel="noopener">Open it in a new tab ↗</a></p></div>`;
      this.onStatus({ state: "failed", message: err.message });
      return;
    }
    if (token !== this.token) return;
    if (doc.type === "pdf") return this.showPdf(doc, row, token);
    return this.showHtml(doc, row, token);
  }

  // ---- HTML
  showHtml(doc, row, token) {
    this.mode = "html";
    const iframe = document.createElement("iframe");
    iframe.className = "pv-frame";
    iframe.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.title = "Source document";
    const html = doc.type === "text"
      ? `<pre style="white-space:pre-wrap;font:13px/1.5 monospace">${escapeHtml(doc.text)}</pre>`
      : doc.text;
    iframe.srcdoc = stripActive(html, doc.finalUrl);
    this.host.replaceChildren(iframe);
    this.frame = iframe;
    iframe.addEventListener("load", () => {
      if (token !== this.token) return;
      const d = iframe.contentDocument;
      if (!d) return;
      const t = targetsFor(row);
      const found = locateInHtml(d, t);
      const quoted = found ? null : locateQuoteInHtml(d, t);
      if (found) {
        found.el.classList.add("gv-row");
        markText(found.beneath || found.el, namesRegex(t.names), "gv-label", 3);
        const figs = markText(found.el, found.exact ? t.primary : t.secondary, "gv-fig", 8);
        centerIn(figs[0] || found.el);
        this.onStatus({ state: found.beneath ? "beneath" : found.exact ? "found" : "line", exact: found.exact });
      } else if (quoted) {
        quoted.classList.add("gv-row");
        markText(quoted, namesRegex(t.names), "gv-label", 5);
        centerIn(quoted);
        this.onStatus({ state: "quote" });
      } else {
        const labels = markText(d.body, namesRegex(t.names), "gv-label", 200);
        if (labels[0]) centerIn(labels[0]);
        this.onStatus({ state: labels.length ? "label-only" : "not-found", count: labels.length });
      }
    }, { once: true });
  }

  // ---- PDF
  async showPdf(doc, row, token) {
    this.mode = "pdf";
    this.host.innerHTML = `<div class="pv-pdf">
        <div class="pv-pdfbar"><button class="btn ghost small" data-pv="prev">‹ Page</button>
        <span class="pv-pageno small muted"></span>
        <button class="btn ghost small" data-pv="next">Page ›</button></div>
        <div class="pv-pages"></div></div>`;
    this.host.querySelector('[data-pv="prev"]').onclick = () => this.goPage(this.page - 1);
    this.host.querySelector('[data-pv="next"]').onclick = () => this.goPage(this.page + 1);
    const lib = await pdfjs();
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    this.pdf = await lib.getDocument({ data: doc.bytes.slice(), isEvalSupported: false }).promise;
    if (token !== this.token) return;
    this.pdfToken = token;
    this.lines = new Map();
    const t = targetsFor(row);
    // Pass 1 looks for the exact figure on any page; pass 2 for any number the
    // quote prints; pass 3 for a verbatim piece of the quote.
    const passes = [[t.primary, "found"], [t.secondary, "line"]].filter(([rx]) => rx);
    let best = null;
    for (const [rx, state] of passes) {
      for (let n = 1; n <= this.pdf.numPages && !best; n++) {
        if (token !== this.token) return;
        this.onStatus({ state: "searching", page: n, of: this.pdf.numPages });
        const band = rowBands(await this.linesOf(n), t).find((b) => { rx.lastIndex = 0; return rx.test(b.text); });
        if (band) best = { page: n, line: band, rx, state };
      }
      if (best) break;
    }
    for (let n = 1; n <= this.pdf.numPages && !best && t.pieces.length; n++) {
      const lines = await this.linesOf(n);
      const line = lines.find((l) => t.pieces.some((p) => norm(l.text).includes(p.slice(0, 40))));
      if (line) best = { page: n, line, rx: null, state: "quote" };
    }
    if (token !== this.token) return;
    if (best) {
      await this.goPage(best.page, { line: best.line, rx: best.rx, t });
      this.onStatus({ state: best.state, page: best.page });
    } else {
      await this.goPage(1);
      this.onStatus({ state: "not-found" });
    }
  }

  async linesOf(n) {
    if (!this.lines.has(n)) this.lines.set(n, pageLines(await this.pdf.getPage(n)));
    return this.lines.get(n);
  }

  async goPage(n, focus = null) {
    if (!this.pdf || n < 1 || n > this.pdf.numPages) return;
    this.page = n;
    const host = this.host.querySelector(".pv-pages");
    const page = await this.pdf.getPage(n);
    const width = Math.max(320, host.clientWidth - 24);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const ratio = window.devicePixelRatio || 1;
    const wrap = document.createElement("div");
    wrap.className = "pv-page";
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrap.append(canvas);
    host.replaceChildren(wrap);
    this.host.querySelector(".pv-pageno").textContent = `${n} of ${this.pdf.numPages}`;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;

    const box = (item, cls) => {
      const [, , , , x, y] = item.transform;
      const h = item.height || Math.hypot(item.transform[2], item.transform[3]);
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([x, y, x + item.width, y + h]);
      const el = document.createElement("div");
      el.className = `pv-hl ${cls}`;
      Object.assign(el.style, { left: `${Math.min(x1, x2) - 2}px`, top: `${Math.min(y1, y2) - 2}px`,
        width: `${Math.abs(x2 - x1) + 4}px`, height: `${Math.abs(y2 - y1) + 4}px` });
      wrap.append(el);
      return el;
    };
    if (focus) {
      const { line, rx, t } = focus;
      let first = null;
      for (const item of line.items) {
        if (rx) rx.lastIndex = 0;
        if (rx && rx.test(item.str)) first = first || box(item, "fig");
        else if (t.hasName(norm(item.str))) box(item, "label");
      }
      for (const item of line.heading || []) if (t.hasName(norm(item.str))) box(item, "label");
      const rowBox = line.items.reduce((acc, item) => {
        const [, , , , x, y] = item.transform;
        return { minX: Math.min(acc.minX, x), maxX: Math.max(acc.maxX, x + item.width),
          y, h: Math.max(acc.h, item.height || 8) };
      }, { minX: Infinity, maxX: -Infinity, y: 0, h: 0 });
      box({ transform: [1, 0, 0, 1, rowBox.minX, rowBox.y], width: rowBox.maxX - rowBox.minX, height: rowBox.h }, "row");
      centerIn(first || wrap);
    }
    if (this.findQuery) this.highlightFindOnPage(wrap, viewport);
  }

  // ---- find inside the document
  async find(query, step = 1) {
    query = (query || "").trim();
    if (!query) return { count: 0 };
    if (this.mode === "html" && this.frame?.contentDocument) {
      const d = this.frame.contentDocument;
      if (query !== this.findQuery) {
        d.querySelectorAll("mark.gv-find").forEach((m) => m.replaceWith(m.textContent));
        this.findMarks = markText(d.body, new RegExp(escapeRe(query), "gi"), "gv-find", 500);
        this.findIndex = -1;
        this.findQuery = query;
      }
      if (!this.findMarks.length) return { count: 0 };
      this.findMarks[this.findIndex]?.classList.remove("gv-current");
      this.findIndex = (this.findIndex + step + this.findMarks.length) % this.findMarks.length;
      const m = this.findMarks[this.findIndex];
      m.classList.add("gv-current");
      centerIn(m);
      return { count: this.findMarks.length, index: this.findIndex + 1 };
    }
    if (this.mode === "pdf" && this.pdf) {
      if (query !== this.findQuery) {
        this.findQuery = query;
        this.findHits = [];
        for (let n = 1; n <= this.pdf.numPages; n++) {
          const lines = await this.linesOf(n);
          if (lines.some((l) => norm(l.text).includes(norm(query)))) this.findHits.push(n);
        }
        this.findIndex = -1;
      }
      if (!this.findHits.length) return { count: 0 };
      this.findIndex = (this.findIndex + step + this.findHits.length) % this.findHits.length;
      await this.goPage(this.findHits[this.findIndex]);
      return { count: this.findHits.length, index: this.findIndex + 1, unit: "pages" };
    }
    return { count: 0 };
  }

  async highlightFindOnPage(wrap, viewport) {
    const lines = await this.linesOf(this.page);
    const q = norm(this.findQuery);
    for (const line of lines) for (const item of line.items) {
      if (!norm(item.str).includes(q)) continue;
      const [, , , , x, y] = item.transform;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([x, y, x + item.width, y + (item.height || 8)]);
      const el = document.createElement("div");
      el.className = "pv-hl find";
      Object.assign(el.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`,
        width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
      wrap.append(el);
    }
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;
