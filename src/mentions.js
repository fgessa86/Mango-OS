// @ mention plumbing, shared by every free-text surface (rich note editor,
// plain-text activity/task/comment fields, exec blocks). A mention keeps the
// display name AND a stable reference to the entity, so it renders as a
// clickable chip and can be indexed onto that entity.
//
// Two durable representations, one meaning:
//   - Plain-text fields store a TOKEN: @[Name](type:id)
//   - HTML fields (the rich editor) store a chip SPAN with data-* attributes.
// The token type is one of: person | deal | enabler | organization.
// Both are parsed by extractMentionRefs, so mentioning someone anywhere links.

export const MENTION_TYPES = ["person", "deal", "enabler", "organization"];

// @[Name](type:id). Name excludes "]" so the token stays unambiguous; id is a
// uuid. Global + case-insensitive so a body can hold several.
export const MENTION_TOKEN_RE = /@\[([^\]]+)\]\((person|deal|enabler|organization):([0-9a-fA-F-]{6,})\)/g;

const escHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => escHtml(s).replace(/"/g, "&quot;");

export const mentionToken = ({ name, type, id }) => `@[${String(name).replace(/[[\]]/g, "")}](${type}:${id})`;

// The chip element used both live in a contentEditable and in stored HTML.
// contenteditable="false" so a click toggles navigation rather than dropping a
// caret inside it, and so it deletes as one unit.
export const mentionChipHtml = ({ name, type, id }) =>
  `<span class="mention mention-${type}" data-mkind="${escAttr(type)}" data-mid="${escAttr(id)}" data-mname="${escAttr(name)}" contenteditable="false">@${escHtml(name)}</span>`;

// Splits a plain-text (token) string into ordered segments for rendering:
// { kind: "text", text } and { kind: "mention", name, type, id }.
export function parseMentionSegments(str) {
  const s = str || "";
  const out = [];
  let last = 0;
  MENTION_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_TOKEN_RE.exec(s)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: s.slice(last, m.index) });
    out.push({ kind: "mention", name: m[1], type: m[2].toLowerCase(), id: m[3] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: "text", text: s.slice(last) });
  return out;
}

// True when a string carries any mention (token form or chip span). Cheap gate.
export function hasMentions(str) {
  const s = str || "";
  MENTION_TOKEN_RE.lastIndex = 0;
  return MENTION_TOKEN_RE.test(s) || /data-mkind=/.test(s);
}

// All mentions in a value, whether it is token text or chip HTML. Order is not
// guaranteed to be document order across the two forms, which does not matter
// for indexing (we only take the first of each type).
export function collectMentions(value) {
  const s = value || "";
  const list = [];
  MENTION_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_TOKEN_RE.exec(s)) !== null) list.push({ name: m[1], type: m[2].toLowerCase(), id: m[3] });
  if (/data-mkind=/.test(s)) {
    try {
      const doc = new DOMParser().parseFromString(s, "text/html");
      doc.querySelectorAll(".mention[data-mkind][data-mid]").forEach((el) => {
        list.push({ name: el.getAttribute("data-mname") || "", type: (el.getAttribute("data-mkind") || "").toLowerCase(), id: el.getAttribute("data-mid") });
      });
    } catch { /* ignore malformed html */ }
  }
  return list;
}

// The entity FK patch implied by a value's mentions: the FIRST mention of each
// type. person maps to contact_id. Used to index content onto the entities it
// mentions (supplementing, never overwriting, links the user set explicitly).
export function extractMentionRefs(value) {
  const refs = { contact_id: null, deal_id: null, enabler_id: null, organization_id: null };
  const col = { person: "contact_id", deal: "deal_id", enabler: "enabler_id", organization: "organization_id" };
  collectMentions(value).forEach((mn) => {
    const c = col[mn.type];
    if (c && !refs[c]) refs[c] = mn.id;
  });
  return refs;
}

// Replaces mention tokens with just the bare name, for plain-text contexts
// (exports, reports, AI prompts, one-line previews) where a chip cannot render
// and the raw token must never show.
export function mentionsToPlainText(str) {
  return String(str || "").replace(MENTION_TOKEN_RE, (_m, name) => name);
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Scans note HTML for FULL-name matches only (2+ words, case-insensitive, whole
// word) against the candidate entities, and returns the HTML with those matches
// converted to mention chips plus the list of what was found. Never touches
// text inside an existing chip or link, and never matches a single first name.
// The caller shows `matches` for confirmation before saving `html`.
export function detectFullNameMentions(html, candidates) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstChild;
  const cands = (candidates || [])
    .filter((c) => c.name && c.id && String(c.name).trim().split(/\s+/).length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
  if (!cands.length) return { html: html || "", matches: [] };
  const alt = cands.map((c) => escapeRegExp(c.name.trim())).join("|");
  const byLower = new Map(cands.map((c) => [c.name.trim().toLowerCase(), c]));
  const matches = new Map();

  const replaceInText = (textNode) => {
    const text = textNode.textContent;
    if (!text.trim()) return;
    const re = new RegExp(`(?<![\\w])(${alt})(?![\\w])`, "gi");
    if (!re.test(text)) return;
    re.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      const cand = byLower.get(m[1].toLowerCase());
      if (!cand) continue;
      // A name typed or pasted with a literal "@" prefix (e.g. "@Mohsen
      // Alzahrani") should convert cleanly: eat the "@" so the chip (which
      // already shows its own "@") does not end up doubled.
      const start = (m.index > 0 && text[m.index - 1] === "@") ? m.index - 1 : m.index;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const holder = doc.createElement("span");
      holder.innerHTML = mentionChipHtml(cand);
      frag.appendChild(holder.firstChild);
      last = m.index + m[1].length;
      const prev = matches.get(cand.id);
      matches.set(cand.id, { name: cand.name, type: cand.type, id: cand.id, count: (prev?.count || 0) + 1 });
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    if (last > 0) textNode.parentNode.replaceChild(frag, textNode);
  };

  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { replaceInText(child); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (child.tagName === "A") return;
      if (child.classList && child.classList.contains("mention")) return;
      walk(child);
    });
  };
  walk(root);
  return { html: root.innerHTML, matches: [...matches.values()] };
}

// Renders token text as chip HTML, for a plain-text value shown read-only in an
// HTML context. (React surfaces use the MentionText component instead.)
export function tokensToChipHtml(str) {
  return parseMentionSegments(str)
    .map((seg) => (seg.kind === "text" ? escHtml(seg.text) : mentionChipHtml(seg)))
    .join("");
}

// --- Literal "@Name" resolution ----------------------------------------------
// Some mentions were typed literally (e.g. "@Dr. Shouki Bazarbashi") instead of
// picked from the dropdown, so they were never turned into a real token/chip and
// render as plain text next to their properly-picked neighbours. These helpers
// match a literal "@Name" run against the known entities so it can render as a
// blue clickable chip everywhere (render time) and be upgraded to a durable
// token/chip on save.

// A flat candidate list [{name,type,id}] -> Map(lowercased full name -> matches).
export function buildMentionIndex(candidates) {
  const map = new Map();
  (candidates || []).forEach((c) => {
    if (!c || !c.name || !c.id || !c.type) return;
    const key = String(c.name).trim().toLowerCase();
    if (key.length < 2) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ name: String(c.name).trim(), type: c.type, id: c.id });
  });
  return map;
}

// A char just before an "@" that still allows it to open a mention. Excludes
// word characters so an email address (fahed@gmail.com) is never treated as one.
const AT_PREFIX_OK = /[\s([<"'>|]/;
const TRAIL_PUNCT_RE = /[.,;:!?)"'\]]+$/;

// Given the text immediately AFTER an "@", find the longest known entity name
// that starts there. Returns { name, type, id, consumed } on a confident single
// match, { ambiguous:true, raw, consumed } when several entities share the exact
// name, or null. `consumed` is how many chars of `rest` the matched name spans
// (excluding any trailing punctuation, which stays as text).
function matchLiteralAt(rest, index) {
  const line = String(rest).split("\n")[0];
  const toks = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line)) !== null && toks.length < 6) toks.push({ w: m[0], start: m.index });
  for (let k = toks.length; k >= 1; k--) {
    const words = toks.slice(0, k).map((t) => t.w);
    const lastStripped = words[k - 1].replace(TRAIL_PUNCT_RE, "");
    if (!lastStripped) continue;
    words[k - 1] = lastStripped;
    const guess = words.join(" ").trim();
    if (guess.length < 2) continue;
    const hits = index.get(guess.toLowerCase());
    if (!hits || !hits.length) continue;
    // Never resolve a lone first name to a person; an institution may be one
    // distinctive word (an acronym), so only guard the person-only case.
    if (k < 2 && hits.every((h) => h.type === "person")) continue;
    const consumed = toks[k - 1].start + lastStripped.length;
    if (hits.length === 1) return { ...hits[0], consumed };
    return { ambiguous: true, raw: guess, consumed };
  }
  return null;
}

// Splits plain text into render segments, upgrading any literal "@Name" run that
// resolves confidently to { kind:"mention" }. An @Name that matches several
// same-named entities becomes { kind:"unresolved" } (styled subtly, never
// force-linked); anything else stays { kind:"text" }.
export function scanLiteralMentions(text, index) {
  const s = String(text == null ? "" : text);
  if (!index || !index.size || s.indexOf("@") === -1) return [{ kind: "text", text: s }];
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ kind: "text", text: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "@" && (i === 0 || AT_PREFIX_OK.test(s[i - 1]))) {
      const hit = matchLiteralAt(s.slice(i + 1), index);
      if (hit && hit.type) {
        flush();
        out.push({ kind: "mention", name: hit.name, type: hit.type, id: hit.id });
        i += 1 + hit.consumed;
        continue;
      }
      if (hit && hit.ambiguous) {
        flush();
        out.push({ kind: "unresolved", text: `@${hit.raw}` });
        i += 1 + hit.consumed;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// True when a value contains at least one literal "@Name" that resolves, so the
// caller can cheaply skip the DOM work when there is nothing to upgrade.
export function hasLiteralMentions(value, index) {
  if (!index || !index.size) return false;
  const s = String(value == null ? "" : value);
  if (s.indexOf("@") === -1) return false;
  return scanLiteralMentions(s.replace(/<[^>]+>/g, " "), index).some((seg) => seg.kind === "mention");
}

// HTML in -> HTML out, with literal "@Name" runs inside text nodes (never inside
// an existing chip or link) upgraded to real chip spans. Used both at render
// time (display) and on save (durability). Only confident matches are chipped;
// ambiguous / unmatched text is left exactly as it was.
export function resolveLiteralMentionsHtml(html, index) {
  const s = html == null ? "" : String(html);
  if (!index || !index.size || s.indexOf("@") === -1) return s;
  let doc;
  try { doc = new DOMParser().parseFromString(`<div>${s}</div>`, "text/html"); }
  catch { return s; }
  const root = doc.body.firstChild;
  if (!root) return s;
  let changed = false;
  const processText = (node) => {
    const segs = scanLiteralMentions(node.textContent, index);
    if (!segs.some((seg) => seg.kind === "mention")) return;
    const frag = doc.createDocumentFragment();
    segs.forEach((seg) => {
      if (seg.kind === "mention") {
        const holder = doc.createElement("span");
        holder.innerHTML = mentionChipHtml(seg);
        if (holder.firstChild) { frag.appendChild(holder.firstChild); changed = true; }
      } else {
        frag.appendChild(doc.createTextNode(seg.text));
      }
    });
    if (changed) node.parentNode.replaceChild(frag, node);
  };
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { if (child.textContent.indexOf("@") !== -1) processText(child); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (child.tagName === "A") return;
      if (child.classList && child.classList.contains("mention")) return;
      walk(child);
    });
  };
  walk(root);
  return changed ? root.innerHTML : s;
}

// Token text in -> token text out, with literal "@Name" runs OUTSIDE existing
// tokens upgraded to @[Name](type:id) tokens. For plain-text mention fields
// (activity descriptions, task titles, comments).
export function resolveLiteralMentionsTokens(text, index) {
  const s = text == null ? "" : String(text);
  if (!index || !index.size || s.indexOf("@") === -1) return s;
  return parseMentionSegments(s)
    .map((seg) => (seg.kind === "mention"
      ? mentionToken(seg)
      : scanLiteralMentions(seg.text, index).map((sub) => (sub.kind === "mention" ? mentionToken(sub) : sub.text)).join("")))
    .join("");
}
