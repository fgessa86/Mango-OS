// Shared helpers for the rich text notes editor. Content is stored as
// sanitized HTML in the existing `notes.content` / `contacts.notes` /
// `organizations.notes` / `organizations.description` text columns (no
// migration needed): simpler to render than round-tripping markdown, and a
// contentEditable surface naturally produces HTML.

const ALLOWED_TAGS = new Set([
  "P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "H1", "H2", "H3",
  "UL", "OL", "LI", "BLOCKQUOTE", "A", "SPAN", "INPUT",
]);
const ALLOWED_ATTRS = {
  A: ["href", "target", "rel"],
  INPUT: ["type", "checked", "contenteditable"],
  // SPAN carries @ mention chips: the class plus the entity reference and the
  // contenteditable="false" that makes a chip behave as one atomic unit.
  SPAN: ["class", "data-mkind", "data-mid", "data-mname", "contenteditable"],
  LI: ["class"],
  DIV: ["class"],
};

function sanitizeNode(node) {
  // Walk children back-to-front since we may remove nodes as we go.
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE || !ALLOWED_TAGS.has(child.tagName)) {
      // Unwrap rather than delete, so pasted content (e.g. a <table> or a
      // Google Docs <font>) keeps its text instead of vanishing.
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      node.removeChild(child);
      continue;
    }
    const allowed = ALLOWED_ATTRS[child.tagName] || [];
    [...child.attributes].forEach((attr) => {
      if (!allowed.includes(attr.name)) { child.removeAttribute(attr.name); return; }
      if (attr.name === "href" && /^\s*javascript:/i.test(attr.value)) child.removeAttribute("href");
    });
    if (child.tagName === "A") { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
    // Checkboxes stay interactive here; RichTextView (the read-only render)
    // makes them inert with CSS (pointer-events) instead of the disabled
    // attribute, since disabled would also freeze them inside the editor.
    if (child.tagName === "INPUT" && child.getAttribute("type") !== "checkbox") child.remove();
    sanitizeNode(child);
  }
}

// Strips any tag/attribute not on the allowlist (script, style, event
// handlers, iframes, etc). Runs on every save, since a paste can carry along
// arbitrary markup from the clipboard.
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstChild;
  sanitizeNode(root);
  return root.innerHTML;
}

// True when the string contains an HTML tag; used to tell already-rich notes
// apart from legacy plain-text ones written before this editor existed.
export function looksLikeHtml(str) {
  return /<[a-z][\s\S]*>/i.test(str || "");
}

// Migrates a legacy plain-text value (line breaks, no markup) into the HTML
// the editor expects, escaping any characters that would otherwise be
// mis-read as tags.
export function plainTextToHtml(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = (text || "").split("\n");
  return lines.map((l) => `<div>${l ? esc(l) : "<br>"}</div>`).join("");
}

const BLOCK_TAGS = new Set(["DIV", "P", "H1", "H2", "H3", "BLOCKQUOTE"]);
// A block that carries nothing to show: no text, and no meaningful child
// (an image, checkbox, or list). A lone <br> still counts as blank.
function isBlankBlock(el) {
  if (!BLOCK_TAGS.has(el.tagName)) return false;
  if ((el.textContent || "").trim()) return false;
  return !el.querySelector("img, input, ul, ol, li");
}
// Collapses the phantom vertical gaps a paste can leave behind (runs of empty
// blocks, and empty blocks at the very start or end), so the read view and the
// editor render with the same tight spacing. A single intentional blank line
// is preserved; only consecutive and edge blanks are removed. Runs on the
// shared display path, so both modes get the identical cleaned HTML.
function tidyBlocks(root) {
  const blocks = [...root.children];
  let prevBlank = false;
  blocks.forEach((el) => {
    const blank = isBlankBlock(el);
    if (blank && prevBlank) { el.remove(); return; }
    prevBlank = blank;
  });
  while (root.firstElementChild && isBlankBlock(root.firstElementChild)) root.firstElementChild.remove();
  while (root.lastElementChild && isBlankBlock(root.lastElementChild)) root.lastElementChild.remove();
}

// Renders whatever is stored (rich HTML, or legacy plain text) as safe HTML
// for both the editor and the read-only view, tidied so the two render
// identically.
export function toDisplayHtml(value) {
  const v = value || "";
  if (!v) return "";
  const clean = looksLikeHtml(v) ? sanitizeHtml(v) : plainTextToHtml(v);
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
  const root = doc.body.firstChild;
  tidyBlocks(root);
  return root.innerHTML;
}

// Plain-text extraction for list previews and linked-entity snippets, where
// formatting should not show through.
export function stripHtmlToText(value) {
  const v = value || "";
  if (!v) return "";
  const html = looksLikeHtml(v) ? v : plainTextToHtml(v);
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("li").forEach((li) => { li.textContent = `${li.textContent} `; });
  doc.querySelectorAll("div, p, br, h1, h2, h3, blockquote").forEach((el) => el.insertAdjacentText("afterend", " "));
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

export function isContentEmpty(value) {
  return stripHtmlToText(value).length === 0;
}
