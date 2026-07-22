import { useRef, useEffect, useCallback, useContext, useState } from "react";
import { sanitizeHtml, toDisplayHtml, isContentEmpty } from "./richtext";
import { useMentionAutocomplete, MentionContext } from "./MentionEditor";

const FULL_TOOLBAR = [
  { cmd: "bold", label: "B", title: "Bold (Cmd+B)", style: { fontWeight: 800 } },
  { cmd: "italic", label: "I", title: "Italic (Cmd+I)", style: { fontStyle: "italic" } },
  { cmd: "underline", label: "U", title: "Underline (Cmd+U)", style: { textDecoration: "underline" } },
  { sep: true },
  { block: "H1", label: "H1", title: "Heading 1" },
  { block: "H2", label: "H2", title: "Heading 2" },
  { block: "H3", label: "H3", title: "Heading 3" },
  { sep: true },
  { cmd: "insertUnorderedList", label: "•", title: "Bulleted list" },
  { cmd: "insertOrderedList", label: "1.", title: "Numbered list" },
  { custom: "checklist", label: "☑", title: "Checklist" },
  { sep: true },
  { custom: "link", label: "🔗", title: "Link" },
  { block: "BLOCKQUOTE", label: "“", title: "Quote" },
];
const MINI_TOOLBAR = [
  { cmd: "bold", label: "B", title: "Bold (Cmd+B)", style: { fontWeight: 800 } },
  { cmd: "insertUnorderedList", label: "•", title: "Bulleted list" },
];

// A checklist item is a plain checkbox marked contenteditable="false" so
// clicking it toggles the control instead of placing a text cursor; the
// checked ATTRIBUTE (not just the live property) is kept in sync on every
// toggle since that attribute is what actually gets serialized into the
// HTML we save.
const CHECK_ITEM_HTML = '<div class="rt-check"><input type="checkbox" contenteditable="false"> </div>';

// Lightweight contentEditable rich text editor. No dependency: formatting
// commands ride on execCommand, which despite being long "deprecated" is
// still implemented by every current desktop and mobile browser for exactly
// this set of basic operations (bold/italic/lists/headings/links). Content is
// read back as sanitized HTML and handed to the caller on every change, which
// owns debouncing/saving (same contract the old plain textarea had).
export default function RichTextEditor({ value, onChange, onBlur, placeholder = "Start writing...", mini = false, autoFocus = false, mentionSource = null }) {
  const ctxSource = useContext(MentionContext);
  const source = mentionSource || ctxSource;
  const ref = useRef(null);
  const lastValueRef = useRef(null);

  // Only push `value` into the DOM when it changed for a reason OTHER than
  // our own typing (e.g. switching to a different note), so the caret never
  // jumps mid-edit.
  useEffect(() => {
    const html = toDisplayHtml(value);
    if (html === lastValueRef.current) return;
    lastValueRef.current = html;
    if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html;
  }, [value]);

  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  const emitChange = useCallback(() => {
    if (!ref.current) return;
    const html = sanitizeHtml(ref.current.innerHTML);
    lastValueRef.current = html;
    onChange && onChange(html);
  }, [onChange]);

  const focusEditor = () => ref.current && ref.current.focus();

  const runCommand = (cmd, arg) => {
    focusEditor();
    document.execCommand(cmd, false, arg);
    emitChange();
  };
  const runBlock = (tag) => {
    focusEditor();
    document.execCommand("formatBlock", false, tag);
    emitChange();
  };
  const insertChecklist = () => {
    focusEditor();
    document.execCommand("insertHTML", false, CHECK_ITEM_HTML);
    emitChange();
  };
  const insertLink = () => {
    const url = window.prompt("Link URL");
    if (!url) return;
    focusEditor();
    document.execCommand("createLink", false, url);
    emitChange();
  };

  const onToolbarAction = (btn) => () => {
    if (btn.custom === "checklist") return insertChecklist();
    if (btn.custom === "link") return insertLink();
    if (btn.block) return runBlock(btn.block);
    return runCommand(btn.cmd);
  };

  const mentions = useMentionAutocomplete({
    editorRef: ref,
    search: source?.search,
    onCreatePerson: source?.createPerson,
    onCreateInstitution: source?.createInstitution,
    onAfterInsert: emitChange,
  });

  const onKeyDown = (e) => {
    if (source && mentions.onEditorKeyDown(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key.toLowerCase() === "b") { e.preventDefault(); runCommand("bold"); }
    else if (e.key.toLowerCase() === "i") { e.preventDefault(); runCommand("italic"); }
    else if (e.key.toLowerCase() === "u") { e.preventDefault(); runCommand("underline"); }
  };
  const onInput = () => { emitChange(); if (source) mentions.scan(); };

  // A checkbox click toggles its own `checked` property but leaves the HTML
  // attribute untouched; sync the attribute so the saved HTML reflects it.
  const onClickChecklist = (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "checkbox") {
      if (e.target.checked) e.target.setAttribute("checked", "");
      else e.target.removeAttribute("checked");
      emitChange();
    }
  };

  const toolbar = mini ? MINI_TOOLBAR : FULL_TOOLBAR;

  return (
    <div className={`rte ${mini ? "rte-mini" : ""}`}>
      <div className="rte-toolbar">
        {toolbar.map((btn, i) => (btn.sep
          ? <span key={i} className="rte-toolbar-sep" />
          : <button key={i} type="button" className="rte-toolbar-btn" style={btn.style} title={btn.title} onMouseDown={(e) => e.preventDefault()} onClick={onToolbarAction(btn)}>{btn.label}</button>
        ))}
      </div>
      <div
        ref={ref}
        className={mini ? "note-content rte-body input notes-editor" : "note-content rte-body note-content-input"}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyUp={source ? mentions.scan : undefined}
        onBlur={() => { emitChange(); onBlur && onBlur(); }}
        onKeyDown={onKeyDown}
        onClick={(e) => { onClickChecklist(e); if (source) mentions.scan(); }}
      />
      {source ? mentions.dropdown : null}
    </div>
  );
}

// Read-only render of stored note HTML (Boss View, linked-notes previews).
// Checkboxes render disabled since there is no edit surface backing them here.
export function RichTextView({ value, className = "" }) {
  const html = toDisplayHtml(value);
  if (!html) return null;
  return <div className={`rte-body rte-view ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Read render for the read/edit toggle: like RichTextView but INTERACTIVE where
// it should be. @ mention chips are clickable (they navigate via the app's
// delegated handler, since this is not a contentEditable surface), links are
// clickable, and checklist checkboxes are tickable (a state change, not text
// editing) with the toggle saved back through onChange. onClick fires for any
// other click, which the field uses to enter edit mode on desktop.
export function RichTextRead({ value, className = "", onChange, onClick }) {
  const ref = useRef(null);
  const html = toDisplayHtml(value);
  const handleClick = (e) => {
    const t = e.target;
    if (t.tagName === "INPUT" && t.type === "checkbox") {
      if (t.checked) t.setAttribute("checked", ""); else t.removeAttribute("checked");
      if (onChange && ref.current) onChange(sanitizeHtml(ref.current.innerHTML));
      return;
    }
    // A chip or link handles itself (navigation); do not also enter edit mode.
    if (t.closest && t.closest(".mention, a")) return;
    if (onClick) onClick(e);
  };
  if (!html) return null;
  return <div ref={ref} className={`note-content rte-body rte-view rtf-read-body ${className}`} onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Rich text with two modes. Default is READ: formatted content where mention
// chips and links are clickable and checkboxes tick. An explicit Edit control
// (or, on desktop, clicking into the body) switches to the contentEditable
// editor with the toolbar; Done, or clicking outside, saves and returns to
// read. Boss View is always read. This is what makes a chip inside a note
// clickable, which a permanently-contentEditable body prevents.
export function RichTextField({ value, onChange, onBlur, mini = false, placeholder = "", className = "", readOnly = false, isMobile = false, editExtras = null, autoFocusOnEdit = true }) {
  const [editing, setEditing] = useState(false);
  const wrapRef = useRef(null);

  const exit = useCallback(() => { setEditing(false); if (onBlur) onBlur(); }, [onBlur]);

  // Leave edit mode when the user presses down anywhere outside the field (a
  // click elsewhere). More reliable than focusout with a contentEditable. The
  // toolbar, voice, and Done all sit inside the wrapper, so they never trigger
  // it (Done exits explicitly).
  useEffect(() => {
    if (!editing) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) exit(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing, exit]);

  if (readOnly) {
    return isContentEmpty(value)
      ? <div className={`rtf-empty ${className}`}>Empty</div>
      : <RichTextRead value={value} className={className} />;
  }

  if (!editing) {
    const empty = isContentEmpty(value);
    return (
      <div className="rtf rtf-read" ref={wrapRef}>
        {empty
          ? <div className={`rtf-empty ${className}`} onClick={() => setEditing(true)}>{placeholder || "Click to add"}</div>
          : <RichTextRead value={value} onChange={onChange} className={className} onClick={isMobile ? undefined : () => setEditing(true)} />}
        <button type="button" className="rtf-edit-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(true)} title="Edit">✎ Edit</button>
      </div>
    );
  }

  return (
    <div className="rtf rtf-editing" ref={wrapRef}>
      <RichTextEditor value={value} onChange={onChange} mini={mini} placeholder={placeholder} autoFocus={autoFocusOnEdit} />
      <div className="rtf-foot">
        <span className="rtf-mode">Editing</span>
        {editExtras}
        <button type="button" className="rtf-done" onMouseDown={(e) => e.preventDefault()} onClick={exit}>Done</button>
      </div>
    </div>
  );
}
