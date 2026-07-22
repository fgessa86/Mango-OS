import { useRef, useState, useEffect, useCallback, useContext, createContext, Fragment } from "react";
import { parseMentionSegments, mentionChipHtml, mentionToken } from "./mentions";

// Provides the @ mention search + create handlers to every editor in the tree,
// so no surface has to prop-drill them. App supplies the value.
export const MentionContext = createContext(null);

const escHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Renders a stored token string as text plus clickable mention chips. The chips
// carry the same data-* attributes as editor chips, so the app-level delegated
// click handler navigates them; no per-call wiring needed.
export function MentionText({ text }) {
  const segs = parseMentionSegments(text || "");
  return (
    <>
      {segs.map((seg, i) => (seg.kind === "text"
        ? <Fragment key={i}>{seg.text}</Fragment>
        : <span key={i} className={`mention mention-${seg.type}`} data-mkind={seg.type} data-mid={seg.id} data-mname={seg.name} role="link" tabIndex={0}>@{seg.name}</span>
      ))}
    </>
  );
}

// value (token string) -> contentEditable HTML (text + chip spans).
function valueToEditorHtml(value) {
  return parseMentionSegments(value || "")
    .map((seg) => (seg.kind === "mention" ? mentionChipHtml(seg) : escHtml(seg.text).replace(/\n/g, "<br>")))
    .join("");
}

// contentEditable DOM -> token string. Chips become tokens, blocks and <br>
// become newlines, everything else is its text.
function serializeEditor(root) {
  let out = "";
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { out += child.textContent; return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (child.classList && child.classList.contains("mention")) {
        out += mentionToken({ name: child.getAttribute("data-mname"), type: child.getAttribute("data-mkind"), id: child.getAttribute("data-mid") });
      } else if (child.tagName === "BR") {
        out += "\n";
      } else if (/^(DIV|P|H1|H2|H3|LI|BLOCKQUOTE)$/.test(child.tagName)) {
        if (out && !out.endsWith("\n")) out += "\n";
        walk(child);
      } else {
        walk(child);
      }
    });
  };
  walk(root);
  return out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/g, "");
}

// The @ autocomplete engine, shared by MentionEditor (plain fields) and the
// rich text editor. Watches the caret in a contentEditable, offers matches,
// and inserts a chip. onAfterInsert lets the host re-serialize/emit.
export function useMentionAutocomplete({ editorRef, search, onCreatePerson, onCreateInstitution, onAfterInsert }) {
  const [state, setState] = useState({ open: false, query: "", items: [], active: 0, rect: null });
  const busyRef = useRef(false);

  const close = useCallback(() => setState((s) => (s.open ? { ...s, open: false, items: [] } : s)), []);

  const buildItems = useCallback((query) => {
    const results = (search ? search(query) : []).slice(0, 6);
    const items = results.map((r) => ({ ...r, kind: "entity" }));
    if (query.trim().length >= 2) {
      if (onCreatePerson) items.push({ kind: "create-person", name: query.trim() });
      if (onCreateInstitution) items.push({ kind: "create-institution", name: query.trim() });
    }
    return items;
  }, [search, onCreatePerson, onCreateInstitution]);

  // Finds an "@query" ending at the caret and opens the menu for it.
  const scan = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editorRef.current) return close();
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !editorRef.current.contains(range.startContainer)) return close();
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return close();
    const before = node.textContent.slice(0, range.startOffset);
    const at = before.lastIndexOf("@");
    if (at === -1) return close();
    const prev = at === 0 ? "" : before[at - 1];
    if (at !== 0 && !/[\s([]/.test(prev)) return close();
    const query = before.slice(at + 1);
    if (query.length > 30 || /[\n@]/.test(query)) return close();
    const rect = range.getBoundingClientRect();
    const fallback = editorRef.current.getBoundingClientRect();
    setState({ open: true, query, items: buildItems(query), active: 0, rect: (rect && (rect.top || rect.left)) ? rect : fallback });
  }, [editorRef, buildItems, close]);

  // Replaces the "@query" before the caret with a chip and a trailing space.
  const insertMention = useCallback((mention) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      const at = node.textContent.slice(0, range.startOffset).lastIndexOf("@");
      if (at !== -1) { range.setStart(node, at); sel.removeAllRanges(); sel.addRange(range); }
    }
    document.execCommand("insertHTML", false, `${mentionChipHtml(mention)}&nbsp;`);
    close();
    if (onAfterInsert) onAfterInsert();
  }, [editorRef, close, onAfterInsert]);

  const selectItem = useCallback(async (item) => {
    if (!item || busyRef.current) return;
    try {
      if (item.kind === "create-person") {
        busyRef.current = true;
        const created = await onCreatePerson(item.name);
        if (created && created.id) insertMention({ name: created.name || item.name, type: "person", id: created.id });
      } else if (item.kind === "create-institution") {
        busyRef.current = true;
        const created = await onCreateInstitution(item.name);
        if (created && created.id) insertMention({ name: created.name || item.name, type: created.type, id: created.id });
      } else {
        insertMention({ name: item.name, type: item.type, id: item.id });
      }
    } finally { busyRef.current = false; }
  }, [insertMention, onCreatePerson, onCreateInstitution]);

  // Returns true when it consumed the key, so the host skips its own handling.
  const onEditorKeyDown = useCallback((e) => {
    if (!state.open || !state.items.length) {
      if (state.open && e.key === "Escape") { close(); return true; }
      return false;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setState((s) => ({ ...s, active: Math.min(s.active + 1, s.items.length - 1) })); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setState((s) => ({ ...s, active: Math.max(s.active - 1, 0) })); return true; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectItem(state.items[state.active]); return true; }
    if (e.key === "Escape") { e.preventDefault(); close(); return true; }
    return false;
  }, [state, selectItem, close]);

  const dropdown = state.open && state.items.length
    ? <MentionDropdown items={state.items} active={state.active} rect={state.rect} onHover={(i) => setState((s) => ({ ...s, active: i }))} onPick={selectItem} />
    : null;

  return { dropdown, scan, onEditorKeyDown };
}

const KIND_LABEL = { person: "Person", deal: "Target", enabler: "Enabler", organization: "Institution" };

function MentionDropdown({ items, active, rect, onHover, onPick }) {
  if (!rect) return null;
  // Position under the caret, flipping above when near the bottom of the
  // viewport so the on-screen keyboard cannot cover it.
  const MAXH = 264;
  const below = rect.bottom + 6;
  const flip = below + MAXH > window.innerHeight - 8;
  const style = {
    position: "fixed",
    left: Math.min(Math.max(8, rect.left), window.innerWidth - 268),
    maxHeight: MAXH,
    zIndex: 9000,
    ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: below }),
  };
  return (
    <div className="mention-menu" style={style} onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        const createKind = it.kind === "create-person" ? "person" : it.kind === "create-institution" ? "organization" : it.type;
        const isCreate = it.kind !== "entity";
        return (
          <button
            type="button"
            key={`${it.kind}-${it.id || it.name}-${i}`}
            className={`mention-menu-item ${i === active ? "active" : ""}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(it)}
          >
            <span className={`mention-dot mention-dot-${createKind}`} />
            <span className="mention-menu-main">
              <span className="mention-menu-name">{isCreate ? `Create ${createKind === "person" ? "person" : "institution"} "${it.name}"` : it.name}</span>
              {!isCreate && it.sub && <span className="mention-menu-sub">{it.sub}</span>}
            </span>
            <span className="mention-menu-kind">{isCreate ? "New" : KIND_LABEL[it.type] || ""}</span>
          </button>
        );
      })}
    </div>
  );
}

// A contentEditable field for plain-text values that carry @ mentions. Serializes
// to the @[Name](type:id) token format the rest of the app stores, so the raw
// token is never shown: chips render live while editing. Use for descriptions,
// titles, comments, and prep/outcome notes.
export default function MentionEditor({ value, onChange, onBlur, placeholder = "", multiline = true, mentionSource, autoFocus = false, className = "", onSubmit }) {
  const ctxSource = useContext(MentionContext);
  const source = mentionSource || ctxSource;
  const ref = useRef(null);
  const lastRef = useRef(null);

  useEffect(() => {
    const html = valueToEditorHtml(value);
    if (html === lastRef.current) return;
    lastRef.current = html;
    if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html;
  }, [value]);

  useEffect(() => { if (autoFocus && ref.current) ref.current.focus(); }, [autoFocus]);

  const emit = useCallback(() => {
    if (!ref.current) return;
    const tok = serializeEditor(ref.current);
    lastRef.current = valueToEditorHtml(tok);
    if (onChange) onChange(tok);
  }, [onChange]);

  const mentions = useMentionAutocomplete({
    editorRef: ref,
    search: source?.search,
    onCreatePerson: source?.createPerson,
    onCreateInstitution: source?.createInstitution,
    onAfterInsert: emit,
  });

  const onKeyDown = (e) => {
    if (mentions.onEditorKeyDown(e)) return;
    if (!multiline && e.key === "Enter") { e.preventDefault(); if (onSubmit) onSubmit(); else ref.current && ref.current.blur(); }
  };

  return (
    <>
      <div
        ref={ref}
        className={`mention-input input ${multiline ? "" : "mention-input-single"} ${className}`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={() => { emit(); mentions.scan(); }}
        onKeyUp={mentions.scan}
        onClick={mentions.scan}
        onKeyDown={onKeyDown}
        onBlur={() => { emit(); if (onBlur) onBlur(); }}
      />
      {mentions.dropdown}
    </>
  );
}
