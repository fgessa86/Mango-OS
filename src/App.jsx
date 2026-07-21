import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import { api } from "./supabase";
import { generateSummary, summarizeImage, researchInstitution, researchKeyPeople, researchClinicalTrials, digestVoiceNote, generateMeetingBrief, generateInternalBrief, generateExecSummary, fetchNewsStories, fetchNewsStoriesNoSearch, newsStoryHref, getApiCallsToday } from "./anthropic";
import { STAGES, ACT_TYPES, TAG_OPTIONS, ENABLER_TYPES, PRIORITIES, ORG_TYPES, INSTITUTION_TYPES, CONNECTION_RELATIONSHIPS, DEAL_ENABLER_RELATIONSHIPS, NETWORK_EDGE_RELATIONSHIPS, PERSON_CONNECTION_RELATIONSHIPS, DEAL_TIERS, STRENGTHS, WARMTH_LEVELS, SAUDI_CITIES, REGIONS } from "./constants";
import { formatDate, formatDateTime, formatFull, formatTime, isSameDay, daysAgo, isToday, isThisWeek, isOverdue, toDateTimeLocal, fromDateTimeLocal, FATHOM_MARKER, isFathomActivity, stripFathomMarker, activityCalendarEventId, cleanActivityText } from "./utils";
import MapTab from "./MapTab";
import VoiceRecorder from "./VoiceRecorder";
import RichTextEditor, { RichTextView } from "./RichTextEditor";
import { stripHtmlToText, isContentEmpty } from "./richtext";
import "./styles.css";

// Boss View (?view=boss) renders the full app in read-only mode: same layout and
// data as Fahed sees, but every edit affordance is disabled or hidden. Components
// read this instead of threading a prop through every level.
const ReadOnlyContext = createContext(false);
const useReadOnly = () => useContext(ReadOnlyContext);

// Initial-based avatars: deterministic color per name (cycles the design palette),
// first+last initials. Replaces emoji/photo avatars everywhere people are shown.
const AVATAR_COLORS = ["#F5A623", "#2A6FDB", "#1F8A5B", "#8B5CF6", "#E5484D", "#0EA5A5"];
const avatarColor = (name) => {
  const s = (name || "?").trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
};
const initialsOf = (name) => {
  const parts = (name || "?").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
};
function Avatar({ name, size = 40, initials }) {
  return (
    <div className="avatar" style={{ width: size, height: size, background: avatarColor(name), fontSize: Math.round(size * 0.36) }}>
      {initials || initialsOf(name)}
    </div>
  );
}

// Lightweight activity glyphs in colored circle badges (replaces emoji icons).
const ACTIVITY_GLYPHS = {
  email: { glyph: "✉", bg: "#E4EDFB", fg: "#2A6FDB" },
  call: { glyph: "☎", bg: "#E6F4EC", fg: "#1F8A5B" },
  meeting: { glyph: "◎", bg: "#E6F4EC", fg: "#1F8A5B" },
  whatsapp: { glyph: "💬", bg: "#25D36622", fg: "#25D366" },
  linkedin: { glyph: "in", bg: "#0A66C222", fg: "#0A66C2" },
  demo: { glyph: "◎", bg: "#EFEAFB", fg: "#8B5CF6" },
  note: { glyph: "✎", bg: "#FDF0DA", fg: "#B5791A" },
  proposal: { glyph: "✎", bg: "#FDF0DA", fg: "#B5791A" },
  transcript: { glyph: "✎", bg: "#FDF0DA", fg: "#B5791A" },
  voice_note: { glyph: "❞", bg: "#FDF0DA", fg: "#B5791A" },
};
// Unknown or legacy activity types (renamed ids, old data) fall back to a
// neutral dot glyph rather than breaking (Section 3: graceful degradation).
function ActivityGlyph({ type }) {
  const g = ACTIVITY_GLYPHS[type] || { glyph: "•", bg: "#F1EADD", fg: "#8A8072" };
  return <span className="timeline-icon" style={{ background: g.bg, color: g.fg }}>{g.glyph}</span>;
}

// Fathom-imported activities (from the Gmail sync) prefix their description with
// this token; the React app strips it, shows a Fathom badge, and renders the
// structured body (FATHOM_MARKER / isFathomActivity / stripFathomMarker now live
// in utils.js so the Map side panel can strip the marker too, see M11).
const firstLine = (s) => { const t = (s || "").trim(); const nl = t.indexOf("\n"); return nl === -1 ? t : t.slice(0, nl); };
// Loose email sanity check (a typo'd address otherwise produces a broken Gmail
// compose link with no feedback, L5). Not RFC-exhaustive; just catches obvious mistakes.
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());

// An @mangosciences.com address is our own team regardless of whether the
// sender has a contacts row yet.
const isInternalEmail = (email) => (email || "").trim().toLowerCase().endsWith("@mangosciences.com");

// True when a calendar event's attendees are ALL internal team: each attendee
// (paired by index across attendee_emails and attendees) is internal either by
// an @mangosciences.com email or by matching a contacts row flagged
// is_internal. Requires at least one attendee to avoid false-positiving a bare
// event with no attendee data at all.
function isInternalMeeting(ev, contacts) {
  const emails = Array.isArray(ev?.attendee_emails) ? ev.attendee_emails.filter(Boolean) : [];
  const names = Array.isArray(ev?.attendees) ? ev.attendees.filter(Boolean) : [];
  const total = Math.max(emails.length, names.length);
  if (total === 0) return false;
  for (let i = 0; i < total; i++) {
    const email = (emails[i] || "").trim().toLowerCase();
    if (isInternalEmail(email)) continue;
    const name = (names[i] || "").trim().toLowerCase();
    const contact = (email && contacts.find((c) => (c.email || "").trim().toLowerCase() === email)) ||
      (name && contacts.find((c) => (c.name || "").trim().toLowerCase() === name));
    if (!contact?.is_internal) return false;
  }
  return true;
}

// Renders an activity description. Fathom notes (and any description that looks
// structured: "Heading:" lines and "- " bullets) get light formatting; a Fathom
// badge marks auto-imported recaps. Email activities additionally get the
// Gmail sync's body_snippet (or, once generated, its one-sentence ai_summary)
// shown below the description, clamped to 2 lines and expandable on click; a
// "Summarize" link appears until a summary exists.
function ActivityDescription({ activity, onSummarizeEmail, summarizingId }) {
  const [expanded, setExpanded] = useState(false);
  const description = activity.description;
  const fathom = isFathomActivity({ description });
  const text = cleanActivityText(description);
  const lines = text.split("\n");
  const structured = fathom
    || lines.some((l) => /^\s*[-•]\s+/.test(l))
    || lines.some((l) => /^[A-Za-z][\w ()/&'-]{0,40}:$/.test(l.trim()));
  const snippet = (activity.body_snippet || "").trim();
  const summary = (activity.ai_summary || "").trim();
  const isEmail = activity.type === "email" && !!snippet;
  const summarizing = summarizingId === activity.id;
  return (
    <div className="act-desc">
      {fathom && <span className="fathom-badge" title="Auto-imported from Fathom"><span className="fathom-badge-dot" />Fathom</span>}
      {structured ? <FormattedActivityBody lines={lines} /> : text}
      {isEmail && (
        <div className={`act-email-snippet ${expanded ? "expanded" : "clamped"}`} onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} title={expanded ? "Click to collapse" : "Click to expand"}>
          {summary && <span className="ai-badge" title="AI-generated summary">AI</span>}
          {summary || snippet}
        </div>
      )}
      {isEmail && !summary && onSummarizeEmail && (
        <button
          type="button"
          className="link-btn act-summarize-btn"
          onClick={(e) => { e.stopPropagation(); onSummarizeEmail(activity); }}
          disabled={summarizing}
        >
          {summarizing ? "Summarizing..." : "Summarize"}
        </button>
      )}
    </div>
  );
}

// Resolves an activity's linked institution (deal/enabler/organization, in that
// priority) to { kind, name } for a colored pill, or null if none is set. New
// activities always have this stored (Section 2, addActivity); for older rows
// that only ever carried a contact_id, fall back to deriving the person's
// CURRENT primary role at display time so the pill still shows (Section 2:
// "if it can only be derived at display time, derive it").
function activityInstitutionInfo(a, { deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles }) {
  if (a.deal_id) { const d = deals.find((x) => x.id === a.deal_id); return d ? { kind: "deal", name: d.company } : null; }
  if (a.enabler_id) { const e = enablers.find((x) => x.id === a.enabler_id); return e ? { kind: "enabler", name: e.name } : null; }
  if (a.organization_id) { const o = organizations.find((x) => x.id === a.organization_id); return o ? { kind: "organization", name: o.name } : null; }
  if (a.contact_id && contacts && contactRoles) {
    const contact = contacts.find((c) => c.id === a.contact_id);
    if (!contact) return null;
    const roles = resolveContactRoles(contact, { deals, enablers, organizations, dealContacts: dealContacts || [], enablerContacts: enablerContacts || [], networkEdges: networkEdges || [], contactRoles });
    const primary = roles.find((r) => r.is_primary) || roles[0];
    if (primary?.entity_type === "deal") { const d = deals.find((x) => x.id === primary.entity_id); return d ? { kind: "deal", name: d.company } : null; }
    if (primary?.entity_type === "enabler") { const e = enablers.find((x) => x.id === primary.entity_id); return e ? { kind: "enabler", name: e.name } : null; }
    if (primary?.entity_type === "organization") { const o = organizations.find((x) => x.id === primary.entity_id); return o ? { kind: "organization", name: o.name } : null; }
  }
  return null;
}
// Resolves an activity's linked person to { id, name } for a neutral pill, or
// null if there is no contact_id or the contact no longer exists.
function activityPersonInfo(a, contacts) {
  if (!a.contact_id) return null;
  const c = contacts.find((x) => x.id === a.contact_id);
  return c ? { id: c.id, name: c.name } : null;
}

// Small clickable pills shown on every activity row: the linked person AND the
// linked institution, when present (Section 1). Either can be suppressed when
// the surrounding timeline already IS that entity, e.g. a person's own timeline
// hides their own name pill but keeps the institution pill, and vice versa.
function ActivityEntityPills({ activity, deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles, onOpenInstitution, onOpenPerson, onOpenCalendarEvent, hidePerson = false, hideInstitution = false }) {
  const inst = hideInstitution ? null : activityInstitutionInfo(activity, { deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles });
  const person = hidePerson ? null : activityPersonInfo(activity, contacts);
  const calEventId = onOpenCalendarEvent ? activityCalendarEventId(activity) : null;
  if (!inst && !person && !calEventId) return null;
  return (
    <div className="act-pills">
      {person && <button type="button" className="act-pill act-pill-person" onClick={() => onOpenPerson(person.id)} title={`Open ${person.name}`}>{person.name}</button>}
      {inst && <button type="button" className={`act-pill act-pill-${inst.kind}`} onClick={() => onOpenInstitution(inst.name)} title={`Open ${inst.name}`}>{inst.name}</button>}
      {calEventId && <button type="button" className="act-pill act-pill-calendar" onClick={() => onOpenCalendarEvent(calEventId)} title="Open this meeting on the calendar">📅 Meeting</button>}
    </div>
  );
}

// The one inline editor behind both "edit this activity" and "+ Add to
// timeline": description, type, date/time (freely editable, so an entry can be
// back-dated to when it actually happened), and the linked person and
// institution. Deliberately inline rather than a modal, matching the
// click-to-edit pattern every other field in the app uses. Escape cancels.
function ActivityEditForm({ initial = {}, linkOptions = {}, customOptions = [], onAddCustomOption = () => {}, onSave, onCancel, submitLabel = "Save", autoFocus = true }) {
  const [description, setDescription] = useState(cleanActivityText(initial.description || ""));
  const [type, setType] = useState(initial.type || "note");
  const [when, setWhen] = useState(toDateTimeLocal(initial.created_at || new Date().toISOString()));
  const [person, setPerson] = useState(initial.contact_id ? `contact:${initial.contact_id}` : "");
  const [institution, setInstitution] = useState(
    initial.deal_id ? `deal:${initial.deal_id}` :
    initial.enabler_id ? `enabler:${initial.enabler_id}` :
    initial.organization_id ? `organization:${initial.organization_id}` : ""
  );
  const [saving, setSaving] = useState(false);
  const textRef = useRef(null);
  useEffect(() => { if (autoFocus) textRef.current?.focus(); }, [autoFocus]);

  const typeOptions = optionsWithCustom(ACT_TYPES.map((t) => ({ id: t.id, label: t.label })), customOptions, "activity_type");

  const submit = async () => {
    const text = description.trim();
    if (!text || saving) return;
    const [instKind, instId] = institution ? institution.split(":") : [null, null];
    setSaving(true);
    try {
      await onSave({
        description: text,
        type,
        created_at: fromDateTimeLocal(when) || new Date().toISOString(),
        contact_id: person ? person.split(":")[1] : null,
        deal_id: instKind === "deal" ? instId : null,
        enabler_id: instKind === "enabler" ? instId : null,
        organization_id: instKind === "organization" ? instId : null,
      });
    } finally { setSaving(false); }
  };

  return (
    <div className="act-edit" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <textarea
        ref={textRef}
        className="input act-edit-text"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What happened?"
      />
      <div className="act-edit-row">
        <label className="act-edit-field">
          <span className="act-edit-label">Type</span>
          <SelectWithCustom
            options={typeOptions}
            value={type}
            onChange={(v) => { setType(v); trackCustom("activity_type", typeOptions, onAddCustomOption)(v); }}
            className="input act-edit-select"
          />
        </label>
        <label className="act-edit-field">
          <span className="act-edit-label">Date and time</span>
          <input type="datetime-local" className="input act-edit-select" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
      </div>
      <div className="act-edit-row">
        <div className="act-edit-field">
          <span className="act-edit-label">Person</span>
          <EntityPicker placeholder="Link a person..." options={linkOptions.people || []} value={person} onChange={setPerson} />
        </div>
        <div className="act-edit-field">
          <span className="act-edit-label">Institution</span>
          <EntityPicker placeholder="Link an institution..." options={linkOptions.institutions || []} value={institution} onChange={setInstitution} />
        </div>
      </div>
      <div className="act-edit-actions">
        <button type="button" className="btn-primary" disabled={saving || !description.trim()} onClick={submit}>{saving ? "Saving..." : submitLabel}</button>
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <span className="act-edit-hint">Esc to cancel</span>
      </div>
    </div>
  );
}

// The three-dot Edit / Delete menu on an activity. Shared by the full
// timeline row and Home's compact recent-activity card so both behave
// identically. Hidden entirely in Boss View (read-only).
function ActivityRowActions({ activity, onEdit, onDeleteActivity }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    if (deleting) return;
    if (!window.confirm("Delete this activity? This cannot be undone.")) return;
    setDeleting(true);
    setMenuOpen(false);
    try { await onDeleteActivity(activity); } finally { setDeleting(false); }
  };
  return (
    <div className="act-row-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="act-menu-btn" onClick={() => setMenuOpen((v) => !v)} title="Activity actions" aria-label="Activity actions">⋯</button>
      {menuOpen && (
        <>
          <div className="act-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="act-menu">
            <button type="button" onClick={() => { setMenuOpen(false); onEdit(); }}>Edit</button>
            <button type="button" className="act-menu-danger" onClick={remove} disabled={deleting}>{deleting ? "Deleting..." : "Delete"}</button>
          </div>
        </>
      )}
    </div>
  );
}

// One activity in any timeline (Home recent activity, Institution Sheet,
// Person Sheet). Read mode shows the glyph, description, pills and timestamp;
// the hover menu swaps it for ActivityEditForm in place. Works the same for
// every activity regardless of origin (manual, Gmail sync, calendar outcome,
// voice note), since edit and delete just act on the row.
function ActivityRow({
  activity, onOpenInstitution, onOpenPerson, onOpenCalendarEvent, onSummarizeEmail, summarizingId,
  onUpdateActivity, onDeleteActivity, linkOptions = {}, customOptions = [], onAddCustomOption = () => {},
  deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles,
  hidePerson = false, hideInstitution = false, className = "timeline-item",
}) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const canEdit = !readOnly && !!onUpdateActivity;

  const save = async (patch) => {
    const ok = await onUpdateActivity(activity, patch);
    if (ok !== false) setEditing(false);
  };

  if (editing) {
    return (
      <div className={`${className} act-row-editing`}>
        <ActivityEditForm
          initial={activity}
          linkOptions={linkOptions}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className={`${className} act-row`}>
      <ActivityGlyph type={activity.type} />
      <div className="act-row-main">
        <ActivityDescription activity={activity} onSummarizeEmail={onSummarizeEmail} summarizingId={summarizingId} />
        <div className="act-date">
          <ActivityEntityPills
            activity={activity} deals={deals} enablers={enablers} organizations={organizations} contacts={contacts}
            dealContacts={dealContacts} enablerContacts={enablerContacts} networkEdges={networkEdges} contactRoles={contactRoles}
            onOpenInstitution={onOpenInstitution} onOpenPerson={onOpenPerson} onOpenCalendarEvent={onOpenCalendarEvent}
            hidePerson={hidePerson} hideInstitution={hideInstitution}
          />
          {formatDateTime(activity.created_at)}
        </div>
      </div>
      {canEdit && <ActivityRowActions activity={activity} onEdit={() => setEditing(true)} onDeleteActivity={onDeleteActivity} />}
    </div>
  );
}

// Home's compact recent-activity card: one line of description plus pills,
// clickable through to the entity, with the same Edit / Delete menu and the
// same inline editor as a full timeline row.
function HomeActivityRow({ activity, entityName, onOpenEntity, onUpdateActivity, onDeleteActivity, linkOptions, customOptions, onAddCustomOption, pillProps }) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const canEdit = !readOnly && !!onUpdateActivity;

  if (editing) {
    return (
      <div className="home-card home-act act-row-editing">
        <ActivityEditForm
          initial={activity}
          linkOptions={linkOptions}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onSave={async (patch) => { const ok = await onUpdateActivity(activity, patch); if (ok !== false) setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="home-card home-act" onClick={() => onOpenEntity(activity)}>
      <ActivityGlyph type={activity.type} />
      <div className="home-act-main">
        <div className="home-act-desc">
          {isFathomActivity(activity) && <span className="fathom-badge sm" title="Auto-imported from Fathom">Fathom</span>}
          {firstLine(cleanActivityText(activity.description))}
        </div>
        <div className="home-act-meta" onClick={(e) => e.stopPropagation()}>
          {entityName(activity) ? <ActivityEntityPills activity={activity} {...pillProps} /> : <span>General</span>}
          <span>{formatDateTime(activity.created_at)}</span>
        </div>
      </div>
      {canEdit && <ActivityRowActions activity={activity} onEdit={() => setEditing(true)} onDeleteActivity={onDeleteActivity} />}
    </div>
  );
}

// "+ Add to timeline" (Section 3): a freeform entry logged straight onto a
// timeline, separate from the structured Quick Add. The date defaults to now
// but is editable, which is the point: it exists for writing up something that
// happened last week with its real date so it sorts correctly.
function TimelineAddEntry({ initial, linkOptions, customOptions, onAddCustomOption, onSave }) {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  if (readOnly) return null;
  if (!open) {
    return (
      <button type="button" className="link-btn timeline-add-btn" onClick={() => setOpen(true)}>+ Add to timeline</button>
    );
  }
  return (
    <div className="timeline-add">
      <ActivityEditForm
        initial={{ ...initial, description: "", created_at: new Date().toISOString() }}
        linkOptions={linkOptions}
        customOptions={customOptions}
        onAddCustomOption={onAddCustomOption}
        submitLabel="Add entry"
        onSave={async (fields) => { const ok = await onSave(fields); if (ok !== false) setOpen(false); }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

// Light Markdown-ish formatting: "Heading:" lines become bold headings, "- "
// lines become bullet lists, "Label: value" lines get a bold label, the rest are
// paragraphs.
function FormattedActivityBody({ lines }) {
  const blocks = [];
  let bullets = [];
  const flush = () => { if (bullets.length) { blocks.push({ type: "ul", items: bullets }); bullets = []; } };
  lines.forEach((raw) => {
    const t = raw.trim();
    if (!t) { flush(); return; }
    const bullet = t.match(/^[-•]\s+(.*)$/);
    if (bullet) { bullets.push(bullet[1]); return; }
    flush();
    if (/^[A-Za-z][\w ()/&'-]{0,40}:$/.test(t)) { blocks.push({ type: "h", text: t.replace(/:$/, "") }); return; }
    const kv = t.match(/^([A-Za-z][\w ()/&'-]{0,30}):\s+(.*)$/);
    if (kv) { blocks.push({ type: "kv", label: kv[1], value: kv[2] }); return; }
    blocks.push({ type: "p", text: t });
  });
  flush();
  return (
    <div className="act-structured">
      {blocks.map((b, i) => {
        if (b.type === "h") return <div key={i} className="act-heading">{b.text}</div>;
        if (b.type === "kv") return <div key={i} className="act-para"><span className="act-kv-label">{b.label}:</span> {b.value}</div>;
        if (b.type === "ul") return <ul key={i} className="act-bullets">{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>;
        return <div key={i} className="act-para">{b.text}</div>;
      })}
    </div>
  );
}

// Executive Update sections, in presentation order. `aiKey` maps a section to
// the key the model returns in its JSON draft; "metrics" has none because
// those numbers are computed locally rather than written by the AI.
const EXEC_SECTIONS = [
  { id: "metrics", label: "Headline Metrics", aiKey: null },
  { id: "pipeline", label: "Pipeline Progress", aiKey: "pipeline" },
  { id: "meetings", label: "Key Meetings", aiKey: "meetings" },
  { id: "relationships", label: "New Relationships", aiKey: "relationships" },
  { id: "wins", label: "Wins", aiKey: "wins" },
  { id: "coming_up", label: "Coming Up", aiKey: "coming_up" },
];
const execSectionLabel = (id) => EXEC_SECTIONS.find((s) => s.id === id)?.label || id || "Other";
const EXEC_BLOCK_TYPES = [
  { id: "item", label: "Item" },
  { id: "commentary", label: "Commentary" },
  { id: "metric", label: "Metric" },
  { id: "header", label: "Section header" },
];

// Materials Library vocabularies (badge colors follow the constants.js pattern).
const MATERIAL_TYPES = [
  { id: "one_pager", label: "One-Pager", color: "#2A6FDB" },
  { id: "deck", label: "Deck", color: "#8B5CF6" },
  { id: "proposal", label: "Proposal", color: "#F59E0B" },
  { id: "white_paper", label: "White Paper", color: "#14B8A6" },
  { id: "contract", label: "Contract", color: "#EF4444" },
  { id: "other", label: "Other", color: "#6B6B7B" },
];
const MATERIAL_AUDIENCES = [
  { id: "payer_government", label: "Payer/Government" },
  { id: "hospital", label: "Hospital" },
  { id: "investor", label: "Investor" },
  { id: "general", label: "General" },
];
const materialTypeMeta = (id) => MATERIAL_TYPES.find((t) => t.id === id) || MATERIAL_TYPES[MATERIAL_TYPES.length - 1];
const materialAudienceLabel = (id) => MATERIAL_AUDIENCES.find((a) => a.id === id)?.label || id || "";
const MAX_MATERIAL_BYTES = 5 * 1024 * 1024;
const formatBytes = (b) => {
  const n = Number(b) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

// Outreach Engine vocabularies. outreach_status lives on contacts (default
// "not_contacted" in the DB); colors follow the spec: gray / yellow / green /
// blue / purple.
const OUTREACH_STATUSES = [
  { id: "not_contacted", label: "Not Contacted", color: "#6B6B7B" },
  { id: "awaiting_reply", label: "Awaiting Reply", color: "#B77400" },
  { id: "replied", label: "Replied", color: "#1F8A5B" },
  { id: "meeting_booked", label: "Meeting Booked", color: "#2A6FDB" },
  { id: "nurture", label: "Nurture", color: "#8B5CF6" },
];
const outreachStatusMeta = (id) => OUTREACH_STATUSES.find((s) => s.id === id) || OUTREACH_STATUSES[0];

// Outreach channels: email, LinkedIn, phone, WhatsApp. Colors/glyphs mirror the
// matching ACTIVITY_GLYPHS entry so a channel badge and its logged activity
// always look the same. "activityType" is what gets logged in `activities`
// (phone outreach logs as a "call").
const OUTREACH_CHANNELS = [
  { id: "email", label: "Email", glyph: "✉", color: "#2A6FDB", activityType: "email" },
  { id: "linkedin", label: "LinkedIn", glyph: "in", color: "#0A66C2", activityType: "linkedin" },
  { id: "phone", label: "Phone", glyph: "☎", color: "#1F8A5B", activityType: "call" },
  { id: "whatsapp", label: "WhatsApp", glyph: "💬", color: "#25D366", activityType: "whatsapp" },
];
const outreachChannelMeta = (id) => OUTREACH_CHANNELS.find((c) => c.id === id) || OUTREACH_CHANNELS[0];
// Best channel to default a contact into: email if we have one, else LinkedIn
// if we have a profile URL, else phone. WhatsApp is never auto-suggested since
// it is just "phone with a template", the user opts into it explicitly.
function suggestChannel(contact) {
  if (!contact) return "email";
  if ((contact.email || "").trim()) return "email";
  if ((contact.linkedin || "").trim()) return "linkedin";
  if ((contact.phone || "").trim()) return "phone";
  return "email";
}
const TEMPLATE_CATEGORIES = [
  { id: "intro_request", label: "Intro Request", color: "#2A6FDB" },
  { id: "direct_intro", label: "Direct Intro", color: "#1F8A5B" },
  { id: "post_meeting", label: "Post-Meeting", color: "#8B5CF6" },
  { id: "materials", label: "Materials Send", color: "#B77400" },
  { id: "reengagement", label: "Re-engagement", color: "#E5484D" },
  { id: "custom", label: "Custom", color: "#6B6B7B" },
];
const templateCategoryMeta = (id) => TEMPLATE_CATEGORIES.find((c) => c.id === id) || TEMPLATE_CATEGORIES[TEMPLATE_CATEGORIES.length - 1];
const MERGE_FIELDS = [
  ["{first_name}", "the contact's first name"],
  ["{full_name}", "their full name"],
  ["{institution}", "their primary institution"],
  ["{role}", "their role title"],
  ["{my_note}", "left in place for you to fill in"],
];
// Days a contact can sit in awaiting_reply before landing in NEEDS NUDGE.
const NUDGE_AFTER_DAYS = 5;

// Seeded into email_templates on first load when the table is empty.
const STARTER_TEMPLATES = [
  { name: "Intro Request", category: "intro_request", channel: "email", subject: "Quick favor: intro to {full_name}?", body: "Hi {first_name},\n\nHope you're doing well. I noticed you're connected to {full_name} at {institution}. We're working on oncology data partnerships in the Kingdom and I think there could be a strong fit.\n\nWould you be open to making a brief introduction? Happy to send a short blurb you can forward.\n\n{my_note}\n\nBest,\nFahed" },
  { name: "Direct Intro", category: "direct_intro", channel: "email", subject: "Mango Sciences x {institution}: oncology data partnership", body: "Dear {first_name},\n\nI'm Fahed Al Essa, VP of Commercial at Mango Sciences. We work with cancer centers across the region on real-world oncology data and value-based financing.\n\n{my_note}\n\nWould you have 20 minutes in the coming weeks for a brief introduction?\n\nBest regards,\nFahed Al Essa" },
  { name: "Post-Meeting Follow-up", category: "post_meeting", channel: "email", subject: "Great speaking today, next steps", body: "Dear {first_name},\n\nThank you for the time today. As discussed, I'm attaching {my_note}.\n\nLooking forward to the next steps we outlined. I'll follow up on the specifics shortly.\n\nBest,\nFahed" },
  { name: "Materials Send", category: "materials", channel: "email", subject: "Mango Sciences overview for {institution}", body: "Dear {first_name},\n\nAs promised, please find attached our overview materials relevant to {institution}.\n\n{my_note}\n\nHappy to walk through any of this in more detail.\n\nBest,\nFahed" },
  { name: "Re-engagement", category: "reengagement", channel: "email", subject: "Following up: Mango Sciences x {institution}", body: "Dear {first_name},\n\nI wanted to circle back on my earlier note. I understand things get busy.\n\n{my_note}\n\nWould it make sense to find 15 minutes in the coming weeks?\n\nBest,\nFahed" },
  { name: "LinkedIn Connection Request", category: "intro_request", channel: "linkedin", subject: "", body: "Hi {first_name}, I lead commercial for Mango Sciences in the Kingdom. We work with cancer centers on real-world oncology data. Would be glad to connect. {my_note}" },
  { name: "LinkedIn Intro Message", category: "direct_intro", channel: "linkedin", subject: "", body: "Hi {first_name}, thanks for connecting. I'm Fahed, VP of Commercial at Mango Sciences. We work with hospitals across KSA on oncology data and value-based financing. {my_note} Would you be open to a short call?" },
  { name: "LinkedIn Follow-up", category: "reengagement", channel: "linkedin", subject: "", body: "Hi {first_name}, following up on my earlier note. {my_note} Happy to share more whenever convenient." },
];

// Replaces merge fields with the contact's data. {my_note} is intentionally
// left in place as an editable placeholder for the sender to fill in.
function fillTemplate(text, contact, roles = []) {
  const primary = roles.find((r) => r.is_primary) || roles[0];
  const first = (contact?.name || "").trim().split(/\s+/)[0] || "";
  return (text || "")
    .replaceAll("{first_name}", first)
    .replaceAll("{full_name}", contact?.name || "")
    .replaceAll("{institution}", (primary && primary.institutionName) || contact?.company || "")
    .replaceAll("{role}", (primary && primary.role_title) || contact?.role || "");
}

// Daily news briefing sections (Feature 3). Prompts are a fixed contract with
// fetchNewsStories in anthropic.js (JSON array only).
const NEWS_SECTIONS = [
  { key: "healthtech", label: "Health Tech and AI", icon: "🩺",
    prompt: `Search for recent news in health technology and AI in healthcare from the past week. Return the 5 most notable developments. For each: headline, one-sentence summary, source name, and url. For the url field, provide the DIRECT link to the specific article, not the publication's homepage. The url must go straight to the individual story. If you cannot find the exact article URL from the web search results, set url to null. Respond in JSON only, no other text: [{headline, summary, source, url}]`,
    fallbackPrompt: `List 5 significant recent developments in health technology and AI in healthcare. Respond in JSON: [{headline, summary, source, url}]` },
  { key: "oncology", label: "Oncology and Immunotherapy", icon: "🧬",
    prompt: `Search for recent news in oncology, cancer treatment, and immunotherapy from the past week. Return the 5 most notable developments. For each: headline, one-sentence summary, source name, and url. For the url field, provide the DIRECT link to the specific article, not the publication's homepage. The url must go straight to the individual story. If you cannot find the exact article URL from the web search results, set url to null. Respond in JSON only, no other text: [{headline, summary, source, url}]`,
    fallbackPrompt: `List 5 significant recent developments in oncology and immunotherapy. Respond in JSON: [{headline, summary, source, url}]` },
  { key: "saudi", label: "Saudi Arabia", icon: "🌍",
    prompt: `Search for recent news in Saudi Arabia focusing on healthcare, business, and Vision 2030 from the past week. Return the 5 most notable developments. For each: headline, one-sentence summary, source name, and url. For the url field, provide the DIRECT link to the specific article, not the publication's homepage. The url must go straight to the individual story. If you cannot find the exact article URL from the web search results, set url to null. Respond in JSON only, no other text: [{headline, summary, source, url}]`,
    fallbackPrompt: `List 5 significant recent developments in Saudi Arabia healthcare, business, and Vision 2030. Respond in JSON: [{headline, summary, source, url}]` },
];

// Minimal geometric nav icons (2px strokes). Active color is handled via CSS.
function NavIcon({ shape }) {
  if (shape === "square") return <span className="nav-icon nav-icon-square" />;
  if (shape === "circle") return <span className="nav-icon nav-icon-circle" />;
  if (shape === "diamond") return <span className="nav-icon nav-icon-diamond" />;
  if (shape === "lines") return <span className="nav-icon nav-icon-lines"><i /><i /><i /></span>;
  if (shape === "chart") return <span className="nav-icon nav-icon-square" style={{ borderRadius: 4 }} />;
  if (shape === "doc") return <span className="nav-icon nav-icon-doc" />;
  if (shape === "note") return (
    <span className="nav-icon nav-icon-note">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="2" width="10" height="12" rx="1.5" /><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" strokeLinecap="round" /></svg>
    </span>
  );
  if (shape === "folder") return (
    <span className="nav-icon nav-icon-folder">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 2h4.5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" /></svg>
    </span>
  );
  if (shape === "send") return (
    <span className="nav-icon nav-icon-send">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M14 2L7.5 8.5M14 2L9.8 13.6a.4.4 0 01-.75.02L7.5 8.5m6.5-6.5L2.4 6.2a.4.4 0 00-.02.75L7.5 8.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
  if (shape === "house") return (
    <span className="nav-icon nav-icon-house">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 7.3L8 2.4l6 4.9M3.2 6.6V13h9.6V6.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
  if (shape === "calendar") return (
    <span className="nav-icon nav-icon-calendar">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" strokeLinecap="round" /></svg>
    </span>
  );
  return null;
}

// Reactive viewport check (mobile = <=768px). Used to switch a few behaviors
// that CSS alone cannot handle (People forced to card view, pipeline stage nav).
function useIsMobile(bp = 768) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(`(max-width:${bp}px)`).matches);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width:${bp}px)`);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [bp]);
  return m;
}

// Best-effort conversion of a natural-language due-date hint ("tomorrow", "next
// Thursday", "end of week") into an ISO date. Returns null when nothing matches,
// in which case the caller keeps the hint text in the task title instead.
// L10: parseFathomDueDate_ in gmail-sync-updated.js is the same logic for the
// Apps Script runtime. The two cannot share a module (browser bundle vs. Google
// Apps Script), so keep them in sync by hand if either changes.
function parseDueHint(hint) {
  const h = (hint || "").toLowerCase().trim();
  if (!h) return null;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const iso = (dt) => dt.toISOString().slice(0, 10);
  if (/\btoday\b/.test(h)) return iso(d);
  if (/\btomorrow\b/.test(h)) { d.setDate(d.getDate() + 1); return iso(d); }
  if (/\bnext week\b/.test(h)) { d.setDate(d.getDate() + 7); return iso(d); }
  if (/end of (the )?week/.test(h)) { const add = ((5 - d.getDay() + 7) % 7) || 5; d.setDate(d.getDate() + add); return iso(d); }
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < 7; i++) {
    if (h.includes(days[i])) { let add = (i - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add); return iso(d); }
  }
  return null;
}

// Fixed bottom tab bar shown only on mobile (CSS hides it on desktop and hides
// the sidebar on mobile). Home is the landing tab; the Network Map is
// desktop-only, and Reports is reachable from the Home screen on mobile.
function MobileTabBar({ view, setView, tasksCount, sheetOrigin = "network", bossMode = false }) {
  const tabs = bossMode ? [
    // Andy's homepage is the Week in Review, so it replaces Home on his tab bar too.
    { id: "reports", label: "Week in Review", shape: "doc" },
    { id: "pipeline", label: "Pipeline", shape: "square" },
    { id: "network", label: "Ecosystem", shape: "circle" },
    { id: "tasks", label: "Tasks", shape: "lines", count: tasksCount },
  ] : [
    { id: "home", label: "Home", shape: "house" },
    { id: "pipeline", label: "Pipeline", shape: "square" },
    { id: "network", label: "Ecosystem", shape: "circle" },
    { id: "tasks", label: "Tasks", shape: "lines", count: tasksCount },
    { id: "outreach", label: "Outreach", shape: "send" },
  ];
  const mapView = view === "institution-sheet" ? sheetOrigin : view === "person-sheet" ? "network" : view;
  return (
    <nav className="mobile-tabbar">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => setView(t.id)} className={`mobile-tab ${mapView === t.id ? "active" : ""}`}>
          <span className="mobile-tab-icon"><NavIcon shape={t.shape} /></span>
          <span className="mobile-tab-label">{t.label}</span>
          {t.count > 0 && <span className="mobile-tab-badge">{t.count}</span>}
        </button>
      ))}
    </nav>
  );
}

// Mobile-only header above the Pipeline kanban: current stage name plus prev/next
// arrows that scroll-snap the columns. Tracks the centered column from scrollLeft.
function MobilePipelineNav({ kanbanRef }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const el = kanbanRef.current;
    if (!el) return;
    const onScroll = () => { const w = el.clientWidth; if (w) setIdx(Math.max(0, Math.min(STAGES.length - 1, Math.round(el.scrollLeft / w)))); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [kanbanRef]);
  const go = (delta) => {
    const el = kanbanRef.current;
    if (!el) return;
    const w = el.clientWidth;
    el.scrollTo({ left: Math.max(0, (idx + delta)) * w, behavior: "smooth" });
  };
  const stage = STAGES[Math.min(idx, STAGES.length - 1)] || STAGES[0];
  return (
    <div className="mobile-stage-nav">
      <button className="mobile-stage-arrow" onClick={() => go(-1)} disabled={idx <= 0} aria-label="Previous stage">‹</button>
      <div className="mobile-stage-label">
        <span className="dot" style={{ background: stage.color }} />
        <span>{stage.label}</span>
        <span className="mobile-stage-count">{idx + 1}/{STAGES.length}</span>
      </div>
      <button className="mobile-stage-arrow" onClick={() => go(1)} disabled={idx >= STAGES.length - 1} aria-label="Next stage">›</button>
    </div>
  );
}

// Left sidebar: wordmark, primary nav (geometric icons), a More section for
// Reports/Boss View, static Saved Views, and a user card pinned to the bottom.
function Sidebar({ view, setView, tasksCount, sheetOrigin = "network", apiCallsToday = 0, bossMode = false, onRefresh, onOpenSearch, lastSynced, reportsUnreadCount = 0 }) {
  // Andy's homepage is the Week in Review: it leads his nav, and the rest of
  // his sidebar narrows to just the tabs he actually needs read-only.
  const nav = bossMode ? [
    { id: "reports", label: "Week in Review", shape: "doc" },
    { id: "pipeline", label: "Pipeline", shape: "square" },
    { id: "network", label: "Ecosystem", shape: "circle" },
    { id: "calendar", label: "Calendar", shape: "calendar" },
    { id: "tasks", label: "Tasks", shape: "lines", count: tasksCount },
  ] : [
    { id: "home", label: "Home", shape: "house" },
    { id: "calendar", label: "Calendar", shape: "calendar" },
    { id: "pipeline", label: "Pipeline", shape: "square" },
    { id: "network", label: "Ecosystem", shape: "circle" },
    { id: "map", label: "Network Map", shape: "diamond" },
    { id: "tasks", label: "Tasks", shape: "lines", count: tasksCount },
    { id: "notes", label: "Notes", shape: "note" },
    { id: "materials", label: "Materials", shape: "folder" },
    { id: "outreach", label: "Outreach", shape: "send" },
  ];
  const more = [
    { id: "reports", label: "Reports", count: reportsUnreadCount },
    { id: "exec", label: "Exec Update" },
  ];
  const mapView = view === "institution-sheet" ? sheetOrigin : view === "person-sheet" ? "network" : view;
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">🥭</span>
        <span className="sidebar-wordmark">Mango OS</span>
      </div>
      {onOpenSearch && (
        <button className="sidebar-search-btn" onClick={onOpenSearch} title="Search everything (Cmd+K)">
          <span className="sidebar-search-icon">🔍</span>
          <span className="nav-label">Search</span>
          <span className="sidebar-search-kbd">⌘K</span>
        </button>
      )}
      <nav className="sidebar-nav">
        {nav.map((n) => (
          <button key={n.id} onClick={() => setView(n.id)} className={`nav-item ${mapView === n.id ? "active" : ""}`}>
            <span className="nav-bar" />
            <NavIcon shape={n.shape} />
            <span className="nav-label">{n.label}</span>
            {n.count > 0 && <span className="nav-count">{n.count}</span>}
          </button>
        ))}
      </nav>

      {!bossMode && (
        <>
          <div className="sidebar-section-label">More</div>
          <div className="sidebar-more">
            {more.map((n) => (
              <button key={n.id} onClick={() => setView(n.id)} className={`nav-item nav-item-sm ${mapView === n.id ? "active" : ""}`}>
                <span className="nav-bar" />
                <span className="nav-label">{n.label}</span>
                {n.count > 0 && <span className="nav-count">{n.count}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {bossMode ? (
        <div className="sidebar-user">
          <Avatar name="Andy Liu" size={34} initials="AL" />
          <div className="sidebar-user-meta">
            <div className="sidebar-user-name">Andy Liu</div>
            <div className="sidebar-user-role">CCO</div>
            <div className="sidebar-readonly-label">Read-only</div>
          </div>
        </div>
      ) : (
        <>
          <div className="sidebar-user">
            <Avatar name="Fahed Al Essa" size={34} initials="FA" />
            <div className="sidebar-user-meta">
              <div className="sidebar-user-name">Fahed Al Essa</div>
              <div className="sidebar-user-role">VP of Commercial</div>
            </div>
          </div>
          <div className="sidebar-api-calls" title="Anthropic API calls made today (resets at midnight)">API calls today: {apiCallsToday}</div>
          {lastSynced && <div className="sidebar-sync" title="Most recent auto-synced email or meeting activity (Gmail Apps Script)">{lastSynced}</div>}
          {onRefresh && <button className="sidebar-refresh" onClick={onRefresh} title="Reload all data from the server">↻ Refresh data</button>}
        </>
      )}
    </aside>
  );
}

// Confidence levels on researched people: green (high) / yellow (medium) / gray (low).
const CONFIDENCE_META = {
  high: { label: "High", color: "#1F8A5B" },
  medium: { label: "Medium", color: "#F5A623" },
  low: { label: "Low", color: "#9B9BA7" },
};

// Structured, labeled profile text stored in a researched contact's notes field.
// Rendered as a "Profile" section on the Person Sheet and kept human-editable.
const RESEARCH_PROFILE_KEYS = ["Department", "Education", "Publications", "Relevance", "Confidence"];
function buildProfileNotes(person) {
  const lines = [];
  if (person.department) lines.push(`Department: ${person.department}`);
  if (person.education) lines.push(`Education: ${person.education}`);
  if (person.publications) lines.push(`Publications: ${person.publications}`);
  if (person.relevance) lines.push(`Relevance: ${person.relevance}`);
  if (person.confidence) lines.push(`Confidence: ${person.confidence}`);
  return lines.join("\n");
}
// Parses "Label: value" lines out of a notes field into { label: value } pairs
// for the known profile keys, so the Profile section can render them.
function parseProfileNotes(notes) {
  const out = {};
  (notes || "").split("\n").forEach((line) => {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]*?):\s*(.+)$/);
    if (m && RESEARCH_PROFILE_KEYS.includes(m[1].trim())) out[m[1].trim()] = m[2].trim();
  });
  return out;
}

// ---- Inline editing primitives ----
// Single-user app: click a value to edit it in place. Enter or blur saves,
// Escape cancels. onSave only fires when the value actually changed.
function InlineText({ value, onSave, placeholder = "Add...", className = "", multiline = false, rows = 2 }) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const ref = useRef(null);
  // Hooks must run unconditionally; the readOnly early return comes after them
  // so a future dynamic readOnly (or the React compiler) stays valid (M5).
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const len = ref.current.value.length;
      ref.current.setSelectionRange(len, len);
    }
  }, [editing]);
  if (readOnly) return <span className={className}>{value || ""}</span>;
  const commit = () => {
    setEditing(false);
    if ((draft || "") !== (value || "")) onSave(draft);
  };
  const cancel = () => { setDraft(value || ""); setEditing(false); };
  if (editing) {
    const common = {
      ref, value: draft, className: `inline-edit ${className}`,
      onChange: (e) => setDraft(e.target.value), onBlur: commit,
    };
    return multiline
      ? <textarea {...common} rows={rows} onKeyDown={(e) => { if (e.key === "Escape") cancel(); }} />
      : <input {...common} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") cancel(); }} />;
  }
  return (
    <span className={`inline-editable ${className} ${!value ? "inline-empty" : ""}`} onClick={(e) => { e.stopPropagation(); setDraft(value || ""); setEditing(true); }} title="Click to edit">
      {value || placeholder}
    </span>
  );
}

// Always-visible scratchpad. Saves on blur, never behind an edit button. A
// "mini" rich editor (Part 2e): line breaks, bold, and a bullet list, plus
// plain-dictation voice input, kept deliberately simpler than the Notes tab.
function NotesEditor({ value, onSave, placeholder = "Add notes...", showToast = () => {} }) {
  const readOnly = useReadOnly();
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value]);
  const commit = () => { if ((draft || "") !== (value || "")) onSave(draft); };
  const onVoiceText = (text) => {
    const clean = (text || "").trim();
    if (!clean) return;
    const esc = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const appended = isContentEmpty(draft) ? `<div>${esc}</div>` : `${draft}<div>${esc}</div>`;
    setDraft(appended);
    onSave(appended);
  };
  if (readOnly) return isContentEmpty(value) ? <div className="notes-readonly empty-small">No notes.</div> : <RichTextView value={value} className="notes-readonly" />;
  return (
    <div className="notes-editor-wrap">
      <RichTextEditor value={draft} onChange={setDraft} onBlur={commit} placeholder={placeholder} mini />
      <VoiceRecorder mode="plain" onPlainText={onVoiceText} showToast={showToast} compact title="Dictate notes" />
    </div>
  );
}

// A colored pill that is a real <select>: click opens the native dropdown, the
// chosen value saves immediately. Used for stage / tier / type / warmth / priority.
function BadgeSelect({ options, value, color = "#9A8F7C", onChange, dot = false, title }) {
  const readOnly = useReadOnly();
  if (readOnly) {
    const label = options.find((o) => o.id === value)?.label || value;
    return <span className="badge" style={{ background: color + "22", color, border: `1px solid ${color}44` }} title={title}>{dot && <span className="warmth-dot" style={{ background: color }} />}{label}</span>;
  }
  return (
    <span className={`badge-select-wrap ${dot ? "has-dot" : ""}`} title={title}>
      {dot && <span className="badge-select-dot" style={{ background: color }} />}
      <select
        className="badge-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ backgroundColor: color + "22", color, borderColor: color + "55" }}
      >
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </span>
  );
}

// Click a rendered value (a badge, a city pin, etc.) to reveal a SelectWithCustom
// dropdown that includes custom options and "+ Add custom"; picking a value saves
// immediately. Used for institution type and city on cards and sheets.
function InlineSelectField({ value, options, onSave, onAddCustomOption = () => {}, fieldName, render, placeholder = "Add..." }) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const wrapRef = useRef(null);
  // Hooks before the readOnly early return, per the rules of hooks (M5).
  useEffect(() => {
    if (!editing || !wrapRef.current) return;
    const el = wrapRef.current.querySelector("select, input");
    if (el) { el.focus(); try { el.showPicker && el.showPicker(); } catch { /* not user-activated, stays focused */ } }
  }, [editing]);
  if (readOnly) return <span>{render ? render(value) : (value || "")}</span>;
  if (editing) {
    return (
      <span ref={wrapRef} className="inline-select-wrap" onClick={(e) => e.stopPropagation()}
        onBlur={(e) => { if (!wrapRef.current || !wrapRef.current.contains(e.relatedTarget)) setEditing(false); }}>
        <SelectWithCustom
          className="input inline-select"
          options={options}
          value={value || ""}
          onChange={(v) => { if (fieldName) trackCustom(fieldName, options, onAddCustomOption)(v); onSave(v); setEditing(false); }}
        />
      </span>
    );
  }
  return (
    <span className={`inline-editable inline-editable-select ${!value ? "inline-empty" : ""}`} onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Click to edit">
      {render ? render(value) : (value || placeholder)}
    </span>
  );
}

// An institution can operate in several cities. The city column stores either a
// plain string (one city, back-compatible) or a JSON array string (many).
const parseCities = (city) => {
  if (!city) return [];
  if (Array.isArray(city)) return city.map((c) => String(c).trim()).filter(Boolean);
  const s = String(city).trim();
  if (s.startsWith("[")) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map((c) => String(c).trim()).filter(Boolean) : []; } catch { return s ? [s] : []; } }
  return s ? [s] : [];
};
const serializeCities = (list) => {
  const clean = Array.from(new Set((list || []).map((c) => String(c).trim()).filter(Boolean)));
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return JSON.stringify(clean);
};

// Displays cities as pin pills. On compact cards, shows the first with a
// "+N more" indicator; on sheets, shows them all.
function CityPills({ city, compact = false }) {
  const cities = parseCities(city);
  if (cities.length === 0) return null;
  if (compact) {
    return <span className="city-pin">📍 {cities[0]}{cities.length > 1 ? <span className="city-more"> +{cities.length - 1} more</span> : null}</span>;
  }
  return (
    <span className="city-pills">
      {cities.map((c) => <span key={c} className="city-pin">📍 {c}</span>)}
    </span>
  );
}

// Editable multi-city control: current cities as removable pills plus an
// "Add city" dropdown (with custom options and "+ Add custom"). Saves the
// serialized value immediately.
function CityEditor({ city, options, onSave, onAddCustomOption = () => {} }) {
  const readOnly = useReadOnly();
  const [adding, setAdding] = useState(false);
  const cities = parseCities(city);
  if (readOnly) return cities.length ? <CityPills city={city} /> : null;
  const remove = (c) => onSave(serializeCities(cities.filter((x) => x !== c)));
  const add = (c) => { if (c && !cities.includes(c)) onSave(serializeCities([...cities, c])); setAdding(false); };
  return (
    <span className="city-editor">
      {cities.map((c) => (
        <span key={c} className="city-pill-edit">📍 {c}<button className="city-pill-x" title="Remove" onClick={(e) => { e.stopPropagation(); remove(c); }}>✕</button></span>
      ))}
      {adding ? (
        <span className="inline-select-wrap" onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setAdding(false); }}>
          <SelectWithCustom className="input inline-select" options={[{ id: "", label: "Select city..." }, ...options.filter((o) => o.id)]} value="" onChange={(v) => { if (!v) { setAdding(false); return; } trackCustom("city", options, onAddCustomOption)(v); add(v); }} />
        </span>
      ) : (
        <button className="city-add-btn" onClick={(e) => { e.stopPropagation(); setAdding(true); }}>{cities.length ? "+ city" : "📍 Add city"}</button>
      )}
    </span>
  );
}

// Compact-by-default city control. Shows pins (first + "N more" on cards); click
// to expand into the multi-city editor. Used on cards; sheets use CityEditor.
function InlineCity({ city, options, onSave, onAddCustomOption = () => {}, compact = false }) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const cities = parseCities(city);
  if (readOnly) return cities.length ? <CityPills city={city} compact={compact} /> : null;
  if (editing) {
    return (
      <span className="inline-city-editing" onClick={(e) => e.stopPropagation()}>
        <CityEditor city={city} options={options} onSave={onSave} onAddCustomOption={onAddCustomOption} />
        <button className="city-done-btn" onClick={(e) => { e.stopPropagation(); setEditing(false); }}>done</button>
      </span>
    );
  }
  return (
    <span className="inline-editable inline-editable-select" title="Click to edit" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
      {cities.length ? <CityPills city={city} compact={compact} /> : <span className="city-pin inline-empty">📍 Add city</span>}
    </span>
  );
}

// SelectWithCustom expects { id, label } options; cities/regions are plain string lists.
const toOptions = (list) => list.map((v) => ({ id: v, label: v }));
const CITY_OPTIONS = toOptions(SAUDI_CITIES);
const REGION_OPTIONS = toOptions(REGIONS);

// custom_options persistence: every dropdown merges its hardcoded defaults with
// whatever the user has previously typed into "+ Add custom" for that field
// (stored in the custom_options table, keyed by field_name). optionsWithCustom
// builds the merged list for a SelectWithCustom's `options` prop; trackCustom
// returns an onChange wrapper that also persists genuinely new values.
const optionsFromCustom = (customOptions, fieldName) => customOptions
  .filter((o) => o.field_name === fieldName)
  .map((o) => ({ id: o.value, label: o.value }));

const optionsWithCustom = (defaults, customOptions, fieldName) => {
  const extra = optionsFromCustom(customOptions, fieldName).filter((o) => !defaults.some((d) => d.id === o.id));
  return [...defaults, ...extra];
};

const trackCustom = (fieldName, mergedOptions, onAddCustomOption) => (value) => {
  if (value && !mergedOptions.some((o) => o.id === value)) onAddCustomOption(fieldName, value);
};

// Legacy enabler.type -> institution type, for enablers that predate having an
// organizations row to read a real type from.
const ENABLER_TYPE_TO_INSTITUTION = { vc: "vc", government: "government", research: "research", strategic_partner: "tech_company", accelerator: "tech_company", connector: "tech_company" };

// Folds the deals, enablers, and organizations tables into one "institution"
// per normalized name. An institution always has a name and may be backed by
// any combination of an organizations row (its type/city/sector/etc.), a deals
// row (making it a pipeline Target), and an enablers row (making it an Enabler).
function buildInstitutions(deals, enablers, organizations) {
  const map = new Map();
  const get = (rawName) => {
    const key = (rawName || "").trim().toLowerCase();
    if (!key) return null;
    if (!map.has(key)) map.set(key, { key, name: (rawName || "").trim(), org: null, deal: null, enabler: null });
    return map.get(key);
  };
  organizations.forEach((o) => { const i = get(o.name); if (i) i.org = o; });
  enablers.forEach((en) => { const i = get(en.name); if (i) i.enabler = en; });
  deals.forEach((d) => { const i = get(d.company); if (i) i.deal = d; });
  return [...map.values()].map(finalizeInstitution);
}

function finalizeInstitution(i) {
  const { org, deal, enabler } = i;
  const times = [org?.last_activity_at, deal?.last_activity_at, enabler?.last_activity_at].filter(Boolean).sort();
  return {
    ...i,
    orgId: org?.id || null,
    dealId: deal?.id || null,
    enablerId: enabler?.id || null,
    isTarget: !!deal,
    isEnabler: !!enabler,
    isInternal: !!org?.is_internal,
    type: org ? normalizeTypeKey(org.type) : enabler ? (ENABLER_TYPE_TO_INSTITUTION[enabler.type] || "") : "",
    city: org?.city || deal?.city || enabler?.city || "",
    region: org?.region || deal?.region || enabler?.region || "",
    sector: org?.sector || "",
    website: org?.website || "",
    description: org?.description || "",
    notes: org?.notes || "",
    researchData: org?.research_data || null,
    stage: deal?.stage || null,
    lastActivity: times.length ? times[times.length - 1] : null,
  };
}

// The primary contact_roles entity for linking a person to an institution: a
// Target links via its deal (so the person also surfaces on the Pipeline deal
// sheet), an Enabler via its enabler, otherwise via its organizations row.
function institutionPrimaryEntity(inst) {
  if (!inst) return null;
  if (inst.dealId) return { type: "deal", id: inst.dealId };
  if (inst.enablerId) return { type: "enabler", id: inst.enablerId };
  if (inst.orgId) return { type: "organization", id: inst.orgId };
  return null;
}

const PHOTO_NOTE_PROMPT = "This is a photo of handwritten meeting notes. Please transcribe and summarize the key points, action items, and any decisions made. Be concise. Do not use em dashes; use commas, periods, colons, or parentheses instead.";

const sortTodos = (list) => list.slice().sort((a, b) => {
  const p = PRIORITIES.findIndex((x) => x.id === a.priority) - PRIORITIES.findIndex((x) => x.id === b.priority);
  if (p !== 0) return p;
  const ad = a.due_date ? new Date(a.due_date).getTime() : Infinity;
  const bd = b.due_date ? new Date(b.due_date).getTime() : Infinity;
  if (ad !== bd) return ad - bd;
  return new Date(a.created_at) - new Date(b.created_at);
});

// Normalizes any browser-decodable image (jpg, png, webp, heic on Safari, etc.) to a JPEG
// base64 payload, since Claude's vision API only accepts jpeg/png/gif/webp.
const fileToJpegBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = reader.result;
  };
  reader.onerror = () => reject(new Error("Could not read file"));
  reader.readAsDataURL(file);
});

const CUSTOM_OPTION_VALUE = "__custom__";

// A drop-in replacement for a plain <select> of predefined options that always
// adds a "+ Add custom" entry at the bottom. Picking it swaps the select for a
// text input; typing a value and pressing Enter or blurring commits it as the
// field's value. Used for every enum-like dropdown in the app (stage, type,
// relationship, strength, priority, warmth, city, region, etc.) per the
// app-wide "custom options everywhere" convention.
function SelectWithCustom({ options, value, onChange, className = "input", placeholder = "Type a custom value...", customLabel = "+ Add custom..." }) {
  const isUnknownValue = value && !options.some((o) => o.id === value);
  const [customMode, setCustomMode] = useState(isUnknownValue);
  const [customText, setCustomText] = useState(isUnknownValue ? value : "");

  const handleSelect = (e) => {
    const v = e.target.value;
    if (v === CUSTOM_OPTION_VALUE) { setCustomMode(true); setCustomText(""); }
    else onChange(v);
  };

  const commitCustom = () => {
    const t = customText.trim();
    if (t) onChange(t);
  };

  if (customMode) {
    return (
      <div className="select-custom-wrap">
        <input
          className={className}
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onBlur={commitCustom}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitCustom(); } }}
          placeholder={placeholder}
          autoFocus
        />
        <button type="button" onClick={() => { setCustomMode(false); onChange(options[0]?.id || ""); }} className="select-custom-back" title="Back to list">✕</button>
      </div>
    );
  }

  return (
    <select className={className} value={isUnknownValue ? CUSTOM_OPTION_VALUE : value} onChange={handleSelect}>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      <option value={CUSTOM_OPTION_VALUE}>{customLabel}</option>
    </select>
  );
}

// Same "predefined options plus custom" idea as SelectWithCustom, but for the
// single-select colored-button pickers used for things like warmth.
function ButtonGroupWithCustom({ options, value, onChange, renderOption }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const isCustom = value && !options.some((o) => o.id === value);

  const commit = () => {
    const t = text.trim();
    if (t) { onChange(t); setAdding(false); setText(""); }
  };

  return (
    <div className="tags-select">
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} className={`tag-btn ${value === o.id ? "active" : ""}`}>
          {renderOption ? renderOption(o) : o.label}
        </button>
      ))}
      {isCustom && <button type="button" className="tag-btn active">{value}</button>}
      {adding ? (
        <input
          className="input custom-tag-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          placeholder="Custom..."
          autoFocus
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="tag-btn">+ Add custom</button>
      )}
    </div>
  );
}

// Multi-select tag picker (like ButtonGroupWithCustom, but toggles membership
// in an array instead of picking one value) with the same "+ Add custom" entry.
function TagPickerWithCustom({ options, value, onToggle }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const extra = value.filter((v) => !options.includes(v));

  const commit = () => {
    const t = text.trim();
    if (t) { onToggle(t); setAdding(false); setText(""); }
  };

  return (
    <div className="tags-select">
      {options.map((t) => <button key={t} type="button" onClick={() => onToggle(t)} className={`tag-btn ${value.includes(t) ? "active" : ""}`}>{t}</button>)}
      {extra.map((t) => <button key={t} type="button" onClick={() => onToggle(t)} className="tag-btn active">{t}</button>)}
      {adding ? (
        <input
          className="input custom-tag-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          placeholder="Custom tag..."
          autoFocus
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="tag-btn">+ Add custom</button>
      )}
    </div>
  );
}

export default function App() {
  // Boss View's homepage is the Week in Review (Andy's default landing page),
  // not Home. Fahed still lands on Home.
  const [view, setView] = useState(() => (new URLSearchParams(window.location.search).get("view") === "boss" ? "reports" : "home"));
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [bossComments, setBossComments] = useState([]);
  const [notes, setNotes] = useState([]);
  const [noteFolders, setNoteFolders] = useState([]);
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [materialLinks, setMaterialLinks] = useState([]);
  const [meetingBriefs, setMeetingBriefs] = useState([]);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [eventInstitutions, setEventInstitutions] = useState([]);
  const [eventContacts, setEventContacts] = useState([]);
  // Executive Update: the curated biweekly deck Fahed presents. Separate from
  // the Week in Review, which is a live auto-dashboard nobody edits.
  const [execPresentations, setExecPresentations] = useState([]);
  const [execBlocks, setExecBlocks] = useState([]);
  const [execOpenId, setExecOpenId] = useState(null);
  const [execPresenting, setExecPresenting] = useState(false);
  const [execGenerating, setExecGenerating] = useState(false);
  // The calendar event whose detail panel is open (a global overlay, so it can
  // be reached from the Calendar tab or from a "📅 Meeting" activity pill
  // anywhere in the app).
  const [eventDetailId, setEventDetailId] = useState(null);
  // Outreach compose modal: { contactId, templateId } or null. templateId
  // preselects a template (Draft Nudge opens the Re-engagement one).
  const [compose, setCompose] = useState(null);
  // Meeting brief viewer / generation state. briefGenerating holds the meeting
  // title while the AI call is in flight (drives a loading modal).
  const [briefViewId, setBriefViewId] = useState(null);
  const [briefGenerating, setBriefGenerating] = useState(null);
  const [showNewBrief, setShowNewBrief] = useState(false);
  const [apiCallsToday, setApiCallsToday] = useState(() => getApiCallsToday());
  const [enablers, setEnablers] = useState([]);
  const [dealContacts, setDealContacts] = useState([]);
  const [enablerContacts, setEnablerContacts] = useState([]);
  const [todos, setTodos] = useState([]);
  const [todoContacts, setTodoContacts] = useState([]);
  const [taskFilter, setTaskFilter] = useState("all");
  const [organizations, setOrganizations] = useState([]);
  const [dealEnablers, setDealEnablers] = useState([]);
  const [networkEdges, setNetworkEdges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [tierFilter, setTierFilter] = useState("all");
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [toast, setToast] = useState(null);
  const [institutionSheetKey, setInstitutionSheetKey] = useState(null);
  const [sheetOrigin, setSheetOrigin] = useState("network");
  const [personSheetId, setPersonSheetId] = useState(null);
  // Sheet navigation history: where each open sheet was navigated from.
  const [navStack, setNavStack] = useState([]);
  // Global search overlay (Cmd+K / Ctrl+K, or the sidebar / Home buttons).
  const [searchOpen, setSearchOpen] = useState(false);
  const [customOptions, setCustomOptions] = useState([]);
  const [contactRoles, setContactRoles] = useState([]);
  const [summarizing, setSummarizing] = useState(false);
  const [summarizingActivityId, setSummarizingActivityId] = useState(null);
  // In-flight guard for an inline activity edit, so a double-submit saves once.
  const [savingActivityId, setSavingActivityId] = useState(null);
  // Outcome logging is a multi-request reconcile; a ref (not state) guards it
  // because it has to block a second call synchronously, before any re-render.
  const loggingOutcomeRef = useRef(false);
  const [researchingInst, setResearchingInst] = useState(null);
  // Institution keys we've already auto-researched this session, so opening a
  // sheet with an empty description does not re-hit the API on every render.
  const autoResearched = useRef(new Set());

  const toastTimer = useRef(null);
  const showToast = (msg, duration = 2500) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), duration);
  };
  // Subtle "Saved" confirmation for inline PATCH edits.
  const savedToast = () => showToast("Saved", 1000);

  const loadData = useCallback(async () => {
    try {
      const [d, c, a, en, dc, ec, td, tdc, orgs, de, ne, co, cr, bc, nt, nf, mat, ml, mb, et, cal, evinst, evcon, xp, xb] = await Promise.all([
        api("deals", "GET", null, "?select=*&order=created_at.desc"),
        api("contacts", "GET", null, "?select=*&order=name.asc"),
        api("activities", "GET", null, "?select=*&order=created_at.desc"),
        api("enablers", "GET", null, "?select=*&order=name.asc"),
        api("deal_contacts", "GET", null, "?select=*,contacts(*)&order=created_at.asc"),
        api("enabler_contacts", "GET", null, "?select=*,contacts(*)&order=created_at.asc"),
        api("todos", "GET", null, "?select=*&order=created_at.desc"),
        api("todo_contacts", "GET", null, "?select=*&order=created_at.asc").catch(() => []),
        api("organizations", "GET", null, "?select=*&order=name.asc"),
        api("deal_enablers", "GET", null, "?select=*,deals(*),enablers(*)&order=created_at.desc"),
        api("network_edges", "GET", null, "?select=*&order=created_at.desc"),
        api("custom_options", "GET", null, "?select=*&order=created_at.asc"),
        api("contact_roles", "GET", null, "?select=*,contacts(*)&order=created_at.asc"),
        api("boss_comments", "GET", null, "?select=*&order=created_at.desc").catch(() => []),
        api("notes", "GET", null, "?select=*&order=updated_at.desc").catch(() => []),
        api("note_folders", "GET", null, "?select=*&order=sort_order.asc,created_at.asc").catch(() => []),
        // Materials are listed WITHOUT file_data: base64 payloads can be ~7MB
        // each, so the file body is only fetched on demand at download time.
        api("materials", "GET", null, "?select=id,name,type,audience,version,file_name,file_size,mime_type,notes,created_at,updated_at&order=created_at.desc").catch(() => []),
        api("material_links", "GET", null, "?select=*&order=created_at.desc").catch(() => []),
        api("meeting_briefs", "GET", null, "?select=*&order=created_at.desc").catch(() => []),
        api("email_templates", "GET", null, "?select=*&order=created_at.asc").catch(() => []),
        api("calendar_events", "GET", null, "?select=*&order=start_time.asc").catch(() => []),
        api("event_institutions", "GET", null, "?select=*&order=created_at.asc").catch(() => []),
        api("event_contacts", "GET", null, "?select=*&order=created_at.asc").catch(() => []),
        api("exec_presentations", "GET", null, "?select=*&order=period_end.desc,created_at.desc").catch(() => []),
        api("exec_blocks", "GET", null, "?select=*&order=sort_order.asc,created_at.asc").catch(() => []),
      ]);
      setDeals(d || []); setContacts(c || []); setActivities(a || []); setEnablers(en || []);
      setDealContacts(dc || []); setEnablerContacts(ec || []); setTodos(td || []); setTodoContacts(tdc || []);
      setOrganizations(orgs || []); setDealEnablers(de || []); setNetworkEdges(ne || []);
      setCustomOptions(co || []); setContactRoles(cr || []); setBossComments(bc || []); setNotes(nt || []); setNoteFolders(nf || []);
      setMaterials(mat || []); setMaterialLinks(ml || []); setMeetingBriefs(mb || []); setEmailTemplates(et || []); setCalendarEvents(cal || []);
      setEventInstitutions(evinst || []); setEventContacts(evcon || []);
      setExecPresentations(xp || []); setExecBlocks(xb || []);
    } catch (e) { showToast("Failed to load data"); }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Manual full reload: writes patch local state (see audit M1), so this is the
  // explicit way to pull changes made elsewhere (Gmail sync, Andy's browser).
  const refreshData = async () => { await loadData(); showToast("Data refreshed", 1500); };

  // Re-reads only calendar_events from Supabase (the actual Google Calendar sync
  // runs hourly via the Apps Script; this just pulls whatever it last wrote).
  const refreshCalendar = async () => {
    try {
      const [rows, evinst, evcon] = await Promise.all([
        api("calendar_events", "GET", null, "?select=*&order=start_time.asc"),
        api("event_institutions", "GET", null, "?select=*&order=created_at.asc").catch(() => []),
        api("event_contacts", "GET", null, "?select=*&order=created_at.asc").catch(() => []),
      ]);
      setCalendarEvents(rows || []);
      setEventInstitutions(evinst || []);
      setEventContacts(evcon || []);
      showToast("Calendar refreshed", 1500);
    } catch { showToast("Could not refresh calendar"); }
  };

  // A calendar event carries matched_* FKs; entityName/openEntity/generateBrief
  // all expect the deal_id/enabler_id/organization_id/contact_id shape, so shim it.
  const eventEntityRow = (ev) => ({ contact_id: ev.matched_contact_id, deal_id: ev.matched_deal_id, enabler_id: ev.matched_enabler_id, organization_id: ev.matched_organization_id });
  const eventIsMatched = (ev) => !!(ev.matched_contact_id || ev.matched_deal_id || ev.matched_enabler_id || ev.matched_organization_id);

  // Cmd+K / Ctrl+K opens global search from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Boss View: ?view=boss loads the FULL app in read-only mode (Andy Liu). Same
  // tabs, sidebar, and data as Fahed; every edit affordance is hidden or disabled.
  const [bossMode] = useState(() => new URLSearchParams(window.location.search).get("view") === "boss");
  const commentAuthor = bossMode ? "Andy Liu" : "Fahed Al Essa";

  // Keep the sidebar API-call counter in sync. bumpApiCalls dispatches this event;
  // also refresh on focus so a day rollover shows the reset count.
  useEffect(() => {
    const sync = () => setApiCallsToday(getApiCallsToday());
    window.addEventListener("mango-api-call", sync);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("mango-api-call", sync); window.removeEventListener("focus", sync); };
  }, []);

  const postBossComment = async ({ author, content, file_name, file_data, deal_id, enabler_id, organization_id }) => {
    const text = (content || "").trim();
    if (!text && !file_data) return;
    try {
      const clean = { author, content: text };
      if (file_name) clean.file_name = file_name;
      if (file_data) clean.file_data = file_data;
      if (deal_id) clean.deal_id = deal_id;
      if (enabler_id) clean.enabler_id = enabler_id;
      if (organization_id) clean.organization_id = organization_id;
      const rows = await api("boss_comments", "POST", clean);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setBossComments((prev) => [row, ...prev]);
    } catch { showToast("Error posting comment"); }
  };

  // Resolves a tagged comment to the institution/deal it references, for the
  // "re: <name>" chip in the floating panel.
  const commentTargetName = (c) => {
    if (c.deal_id) return deals.find((d) => d.id === c.deal_id)?.company || null;
    if (c.enabler_id) return enablers.find((e) => e.id === c.enabler_id)?.name || null;
    if (c.organization_id) return organizations.find((o) => o.id === c.organization_id)?.name || null;
    return null;
  };
  // Fahed's unread badge: comments from Andy newer than the last time Fahed
  // opened the comment panel (stored in localStorage).
  const [commentsSeenAt, setCommentsSeenAt] = useState(() => localStorage.getItem("mango-comments-seen") || "");
  const markCommentsSeen = () => { const now = new Date().toISOString(); localStorage.setItem("mango-comments-seen", now); setCommentsSeenAt(now); };
  const unreadComments = bossMode ? 0 : bossComments.filter((c) => c.author !== "Fahed Al Essa" && (!commentsSeenAt || new Date(c.created_at) > new Date(commentsSeenAt))).length;
  // Command Center "Unread Comments": persisted per-comment is_read flag on
  // boss_comments (distinct from the floating badge's localStorage timestamp).
  // Shows notes from the other person that have not been dismissed yet.
  const unreadBossComments = bossComments.filter((c) => !c.is_read && c.author !== commentAuthor);
  const markCommentRead = async (id) => {
    try {
      await api("boss_comments", "PATCH", { is_read: true }, `?id=eq.${id}`);
      setBossComments((prev) => prev.map((c) => (c.id === id ? { ...c, is_read: true } : c)));
    } catch { showToast("Error updating comment"); }
  };

  // Kick back to the Ecosystem tab if the open person's contact was deleted elsewhere
  useEffect(() => {
    if (view === "person-sheet" && personSheetId && contacts.length > 0 && !contacts.find((c) => c.id === personSheetId)) {
      setView("network"); setPersonSheetId(null);
    }
  }, [contacts, view, personSheetId]);

  // CUSTOM DROPDOWN OPTIONS
  // Persists a user-typed "+ Add custom" value so it shows up in that field's
  // dropdown everywhere, from now on. Skips the write if the value (case
  // insensitively) is already stored for this field.
  const addCustomOption = async (fieldName, value) => {
    const v = (value || "").trim();
    if (!v) return;
    const exists = customOptions.some((o) => o.field_name === fieldName && o.value.toLowerCase() === v.toLowerCase());
    if (exists) return;
    try {
      const rows = await api("custom_options", "POST", { field_name: fieldName, value: v });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setCustomOptions((prev) => [...prev, row]);
    } catch { /* non critical, the typed value still works for this session */ }
  };

  // DEAL CRUD
  const saveDeal = async (form) => {
    try {
      const company = (form.company || "").trim();
      if (!company) { showToast("Company name is required"); return; }
      const clean = {
        company,
        stage: form.stage || "prospecting",
        tier: form.tier || "Untiered",
        last_activity_at: new Date().toISOString(),
      };
      // Only send optional string fields when they have real content
      for (const k of ["contact_id", "contact_name", "contact_role", "notes", "next_action", "city", "region"]) {
        const v = (form[k] || "").trim();
        if (v) clean[k] = v;
      }
      // value is numeric, never send an empty string, only send a valid positive number
      const value = Number(form.value);
      if (form.value !== "" && form.value != null && !Number.isNaN(value) && value > 0) clean.value = value;
      if (form.id) {
        await api("deals", "PATCH", clean, `?id=eq.${form.id}`);
      } else {
        await api("deals", "POST", clean);
      }
      // Keep the unified architecture: every deal has a full institution behind
      // it. Ensure an organizations row exists for this name (a Target is just an
      // institution with a deal row); carry the Type from the form (audit M4).
      const type = (form.type || "").trim();
      const existingOrg = organizations.find((o) => (o.name || "").trim().toLowerCase() === company.toLowerCase());
      if (existingOrg) {
        if (type && (existingOrg.type || "") !== type) await api("organizations", "PATCH", { type }, `?id=eq.${existingOrg.id}`).catch(() => {});
      } else {
        const orgClean = { name: company, country: "Saudi Arabia" };
        if (type) orgClean.type = type;
        for (const k of ["city", "region"]) { const v = (form[k] || "").trim(); if (v) orgClean[k] = v; }
        await api("organizations", "POST", orgClean).catch(() => {});
      }
      await loadData(); setModal(null); showToast(form.id ? "Deal updated" : "Deal added");
    } catch { showToast("Error saving deal"); }
  };


  const moveDeal = async (dealId, newStage) => {
    const now = new Date().toISOString();
    try {
      await api("deals", "PATCH", { stage: newStage, last_activity_at: now }, `?id=eq.${dealId}`);
      const rows = await api("activities", "POST", { deal_id: dealId, type: "note", description: `Moved to ${STAGES.find((s) => s.id === newStage)?.label}` });
      setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stage: newStage, last_activity_at: now } : d)));
      const act = Array.isArray(rows) ? rows[0] : rows;
      if (act) setActivities((prev) => [act, ...prev]);
    } catch { showToast("Error moving deal"); }
  };

  const setDealTier = async (dealId, tier) => {
    try {
      await api("deals", "PATCH", { tier: tier || "Untiered" }, `?id=eq.${dealId}`);
      setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, tier: tier || "Untiered" } : d)));
      savedToast();
    } catch { showToast("Error updating tier"); }
  };

  // ---- Generic inline-edit PATCH helpers (single-field saves from the sheets) ----
  const updateDeal = async (id, patch) => {
    const now = new Date().toISOString();
    try {
      await api("deals", "PATCH", { ...patch, last_activity_at: now }, `?id=eq.${id}`);
      setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch, last_activity_at: now } : d)));
      savedToast();
    } catch { showToast("Error saving"); }
  };
  const updateContact = async (id, patch) => {
    try {
      await api("contacts", "PATCH", patch, `?id=eq.${id}`);
      setContacts((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
      // A renamed contact propagates to the denormalized contact_name copies on
      // any deal/enabler that references them (audit H7).
      if (patch.name !== undefined) {
        const nm = patch.name;
        await api("deals", "PATCH", { contact_name: nm }, `?contact_id=eq.${id}`).catch(() => {});
        await api("enablers", "PATCH", { contact_name: nm }, `?contact_id=eq.${id}`).catch(() => {});
        setDeals((prev) => prev.map((d) => (d.contact_id === id ? { ...d, contact_name: nm } : d)));
        setEnablers((prev) => prev.map((e) => (e.contact_id === id ? { ...e, contact_name: nm } : e)));
      }
      savedToast();
    } catch { showToast("Error saving"); }
  };
  // People-table Role cell: reads and writes the SAME source. If the contact has
  // a real contact_roles entry, its primary role_title is the source of truth
  // (keep the legacy junction copy in sync). Only when there is no contact_roles
  // entry do we fall back to contacts.role for both read and write (audit M7).
  const updateRoleTitle = async (contact, primaryRole, rawValue) => {
    const title = (rawValue || "").trim() || null;
    if (!(primaryRole && primaryRole.removable && primaryRole.id)) {
      await updateContact(contact.id, { role: title });
      return;
    }
    try {
      await api("contact_roles", "PATCH", { role_title: title }, `?id=eq.${primaryRole.id}`);
      if (primaryRole.entity_type === "deal") {
        await api("deal_contacts", "PATCH", { role_in_deal: title }, `?deal_id=eq.${primaryRole.entity_id}&contact_id=eq.${contact.id}`).catch(() => {});
      } else if (primaryRole.entity_type === "enabler") {
        await api("enabler_contacts", "PATCH", { role_in_org: title }, `?enabler_id=eq.${primaryRole.entity_id}&contact_id=eq.${contact.id}`).catch(() => {});
      } else if (primaryRole.entity_type === "organization") {
        await api("network_edges", "PATCH", { notes: title }, `?source_type=eq.contact&source_id=eq.${contact.id}&target_type=eq.organization&target_id=eq.${primaryRole.entity_id}`).catch(() => {});
      }
      setContactRoles((prev) => prev.map((r) => (r.id === primaryRole.id ? { ...r, role_title: title } : r)));
      savedToast();
    } catch { showToast("Error saving"); }
  };
  const updateEnabler = async (id, patch) => {
    try {
      await api("enablers", "PATCH", patch, `?id=eq.${id}`);
      setEnablers((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
      savedToast();
    } catch { showToast("Error saving"); }
  };
  // Institution-level fields live on the organizations row. A Target-only
  // institution (created from the Pipeline) may not have an org row yet, so
  // create one on first edit before patching.
  const ensureOrgId = async (inst) => {
    if (inst.orgId) return inst.orgId;
    const clean = { name: inst.name, type: inst.type || "hospital", country: "Saudi Arabia" };
    if (inst.city) clean.city = inst.city;
    if (inst.region) clean.region = inst.region;
    const created = (await api("organizations", "POST", clean) || [])[0];
    return created?.id || null;
  };
  const updateInstitution = async (inst, patch) => {
    try {
      const hadOrg = !!inst.orgId;
      const orgId = await ensureOrgId(inst);
      if (!orgId) throw new Error("no org");
      await api("organizations", "PATCH", patch, `?id=eq.${orgId}`);
      // Freshly created org rows need a full reload; simple field edits patch locally.
      if (hadOrg) setOrganizations((prev) => prev.map((o) => (o.id === orgId ? { ...o, ...patch } : o)));
      else await loadData();
      savedToast();
    } catch { showToast("Error saving"); }
  };
  // City lives on every backing row, so keep the organization, deal, and enabler
  // in sync when it changes (a Target's deal card reads the deal's city).
  const updateInstitutionCity = async (inst, city) => {
    const c = (city || "").trim() || null;
    try {
      const hadOrg = !!inst.orgId;
      const orgId = await ensureOrgId(inst);
      if (orgId) await api("organizations", "PATCH", { city: c }, `?id=eq.${orgId}`);
      if (inst.dealId) await api("deals", "PATCH", { city: c }, `?id=eq.${inst.dealId}`);
      if (inst.enablerId) await api("enablers", "PATCH", { city: c }, `?id=eq.${inst.enablerId}`);
      if (hadOrg || !orgId) {
        setOrganizations((prev) => prev.map((o) => (o.id === orgId ? { ...o, city: c } : o)));
        setDeals((prev) => prev.map((d) => (d.id === inst.dealId ? { ...d, city: c } : d)));
        setEnablers((prev) => prev.map((e) => (e.id === inst.enablerId ? { ...e, city: c } : e)));
      } else await loadData();
      savedToast();
    } catch { showToast("Error saving"); }
  };
  // Renaming an institution renames every backing row, propagates the new name
  // to the denormalized contacts.company copies (audit H7), and re-keys the
  // open sheet. Only contacts whose company text currently equals the old name
  // are touched, so people who work elsewhere are left alone.
  const renameInstitution = async (inst, rawName) => {
    const name = (rawName || "").trim();
    const oldName = inst.name;
    if (!name || name === oldName) return;
    try {
      if (inst.orgId) await api("organizations", "PATCH", { name }, `?id=eq.${inst.orgId}`);
      if (inst.dealId) await api("deals", "PATCH", { company: name }, `?id=eq.${inst.dealId}`);
      if (inst.enablerId) await api("enablers", "PATCH", { name }, `?id=eq.${inst.enablerId}`);
      if (!inst.orgId && !inst.dealId && !inst.enablerId) return;
      const oldLower = (oldName || "").trim().toLowerCase();
      const affectedContactIds = contacts.filter((c) => (c.company || "").trim().toLowerCase() === oldLower).map((c) => c.id);
      if (affectedContactIds.length > 0) {
        await api("contacts", "PATCH", { company: name }, `?company=ilike.${encodeURIComponent(oldName)}`).catch(() => {});
      }
      setOrganizations((prev) => prev.map((o) => (o.id === inst.orgId ? { ...o, name } : o)));
      setDeals((prev) => prev.map((d) => (d.id === inst.dealId ? { ...d, company: name } : d)));
      setEnablers((prev) => prev.map((e) => (e.id === inst.enablerId ? { ...e, name } : e)));
      if (affectedContactIds.length > 0) {
        const idSet = new Set(affectedContactIds);
        setContacts((prev) => prev.map((c) => (idSet.has(c.id) ? { ...c, company: name } : c)));
      }
      setInstitutionSheetKey(name.toLowerCase()); savedToast();
    } catch { showToast("Error saving"); }
  };

  // AI research: fill description (+ oncology relevance), website, and sector for
  // an institution. Runs on create, on demand via a button, and once automatically
  // when a sheet opens with an empty description. `silent` suppresses toasts for
  // the automatic runs. Accepts a plain { key, name, city, orgId } shape.
  const autoFillInstitution = async (inst, { silent = false } = {}) => {
    if (!inst || !inst.name) return;
    if (inst.key) autoResearched.current.add(inst.key);
    setResearchingInst(inst.key || inst.name);
    try {
      const data = await researchInstitution(inst.name, inst.city);
      if (!data || data.unknown) { if (!silent) showToast("Could not research this institution", 1800); return; }
      const orgId = await ensureOrgId(inst);
      if (!orgId) return;
      const patch = {};
      const desc = (data.description || "").trim();
      const onc = (data.oncology_relevance || "").trim();
      const combined = [desc, onc].filter(Boolean).join(" ");
      if (combined) patch.description = combined;
      if ((data.website || "").trim()) patch.website = data.website.trim();
      if ((data.sector || "").trim()) patch.sector = data.sector.trim();
      if (Object.keys(patch).length > 0) {
        await api("organizations", "PATCH", patch, `?id=eq.${orgId}`);
        await loadData();
        if (!silent) showToast("AI research complete", 1500);
      } else if (!silent) {
        showToast("Nothing to fill in", 1500);
      }
    } catch {
      if (!silent) showToast("AI research failed");
    } finally {
      setResearchingInst(null);
    }
  };

  // ---- "Research Key People" workflow (web search) ----
  const researchKeyPeopleFor = async (inst, onStatus) => researchKeyPeople(inst.name, inst.city, onStatus);
  const researchTrialsFor = async (inst) => researchClinicalTrials(inst.name);

  // Persists a research run to the institution's organizations.research_data so
  // results survive without re-running the (slow, paid) web search.
  const saveInstitutionResearch = async (inst, data) => {
    try {
      const orgId = await ensureOrgId(inst);
      if (!orgId) return;
      await api("organizations", "PATCH", { research_data: JSON.stringify(data) }, `?id=eq.${orgId}`);
      await loadData();
    } catch { /* history save is best-effort */ }
  };

  // Creates a contact from a researched person and links them to this
  // institution. `reload`/`toast` are off during batch "Add All" so we can
  // reload and toast once at the end. Returns the created contact.
  const addResearchedPerson = async (inst, person, { reload = true } = {}) => {
    try {
      const primary = institutionPrimaryEntity(inst);
      const created = await persistContact({
        name: person.name,
        role: person.title || "",
        company: inst.name,
        notes: buildProfileNotes(person),
        warmth: "unknown",
      });
      if (created && primary) {
        await persistPersonRole({ contactId: created.id, entityType: primary.type, entityId: primary.id, roleTitle: person.title || "" });
      }
      if (reload) { await loadData(); showToast(`${person.name} added to ecosystem`); }
      return created;
    } catch {
      if (reload) showToast("Error adding person");
      return null;
    }
  };

  const addResearchedPeople = async (inst, people) => {
    try {
      for (const p of people) {
        // eslint-disable-next-line no-await-in-loop
        await addResearchedPerson(inst, p, { reload: false });
      }
      await loadData();
      showToast(`${people.length} people added to ecosystem`);
    } catch { showToast("Error adding people"); }
  };

  // CONTACT CRUD
  // Core create/update logic with no UI side effects (no loadData/toast/modal-close),
  // so bulk operations can call this in a loop and only reload/toast once at the end.
  // Applies the auto-population rules: marking a contact internal auto-tags them
  // "Internal Team", and a new contact's company name is matched (case-insensitively)
  // against existing deal/enabler names to auto-create the corresponding junction row.
  const persistContact = async (form) => {
    const name = (form.name || "").trim();
    if (!name) throw new Error("Name is required");
    const clean = { name, warmth: form.warmth || "unknown" };
    for (const k of ["role", "company", "email", "phone", "linkedin", "source", "notes"]) {
      const v = (form[k] || "").trim();
      if (v) clean[k] = v;
    }
    // Only touch is_internal when the caller explicitly means to set it, otherwise
    // a plain edit-form save would silently reset every contact back to external.
    if (form.is_internal !== undefined) clean.is_internal = !!form.is_internal;
    let tags = form.tags && form.tags.length > 0 ? [...form.tags] : [];
    if (clean.is_internal && !tags.includes("Internal Team")) tags.push("Internal Team");
    if (tags.length > 0) clean.tags = tags;

    if (form.id) {
      await api("contacts", "PATCH", clean, `?id=eq.${form.id}`);
      return null;
    }
    const created = (await api("contacts", "POST", clean) || [])[0];
    if (created && clean.company) {
      // Auto-link by company name: contact_roles is the source of truth, with a
      // mirror row in the legacy junction table (same dual-write as
      // persistPersonRole, so the two never diverge again).
      const companyLower = clean.company.toLowerCase();
      const roleTitle = (clean.role || "").trim() || null;
      const matchedDeal = deals.find((d) => (d.company || "").toLowerCase() === companyLower);
      if (matchedDeal) {
        await api("contact_roles", "POST", { contact_id: created.id, entity_type: "deal", entity_id: matchedDeal.id, role_title: roleTitle }).catch(() => {});
        await api("deal_contacts", "POST", { deal_id: matchedDeal.id, contact_id: created.id }).catch(() => {});
      }
      const matchedEnabler = enablers.find((en) => (en.name || "").toLowerCase() === companyLower);
      if (matchedEnabler) {
        await api("contact_roles", "POST", { contact_id: created.id, entity_type: "enabler", entity_id: matchedEnabler.id, role_title: roleTitle }).catch(() => {});
        await api("enabler_contacts", "POST", { enabler_id: matchedEnabler.id, contact_id: created.id }).catch(() => {});
      }
    }
    return created;
  };

  // Deleting a contact: pure link rows are deleted; rows that carry history
  // (activities, todos, notes, briefs) keep their content but have the dangling
  // contact reference nulled, and denormalized copies on deals/enablers are
  // stripped. Activities left with no entity reference at all are removed.
  const deleteContact = async (id) => {
    try {
      await api("deal_contacts", "DELETE", null, `?contact_id=eq.${id}`);
      await api("enabler_contacts", "DELETE", null, `?contact_id=eq.${id}`);
      await api("contact_roles", "DELETE", null, `?contact_id=eq.${id}`);
      await api("network_edges", "DELETE", null, `?source_type=eq.contact&source_id=eq.${id}`);
      await api("network_edges", "DELETE", null, `?target_type=eq.contact&target_id=eq.${id}`);
      await api("material_links", "DELETE", null, `?contact_id=eq.${id}`);
      await api("activities", "PATCH", { contact_id: null }, `?contact_id=eq.${id}`).catch(() => {});
      await api("todos", "PATCH", { contact_id: null }, `?contact_id=eq.${id}`).catch(() => {});
      await api("notes", "PATCH", { contact_id: null }, `?contact_id=eq.${id}`).catch(() => {});
      await api("meeting_briefs", "PATCH", { contact_id: null }, `?contact_id=eq.${id}`).catch(() => {});
      await api("calendar_events", "PATCH", { matched_contact_id: null }, `?matched_contact_id=eq.${id}`).catch(() => {});
      await api("deals", "PATCH", { contact_id: null, contact_name: null, contact_role: null }, `?contact_id=eq.${id}`).catch(() => {});
      await api("enablers", "PATCH", { contact_id: null, contact_name: null }, `?contact_id=eq.${id}`).catch(() => {});
      await deleteFullyOrphanedActivities();
      await api("contacts", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Person deleted");
      setView("network"); setPersonSheetId(null);
    } catch { showToast("Error deleting person"); }
  };

  // Removes activities whose every entity reference has been nulled by an
  // archive or delete: they are invisible on all sheets and only clutter Home.
  const deleteFullyOrphanedActivities = () =>
    api("activities", "DELETE", null, "?deal_id=is.null&contact_id=is.null&enabler_id=is.null&organization_id=is.null").catch(() => {});

  // PEOPLE (deal_contacts / enabler_contacts junction tables, plus contact_roles
  // as the newer unified source of truth; addPersonRole/removePersonRole below
  // keep all three in sync no matter which surface the write comes from)
  const addDealContact = async (dealId, contactId, role) => {
    try {
      if (dealContacts.some((dc) => dc.deal_id === dealId && dc.contact_id === contactId)) { showToast("Person already linked"); return; }
      const clean = { deal_id: dealId, contact_id: contactId };
      if ((role || "").trim()) clean.role_in_deal = role.trim();
      await api("deal_contacts", "POST", clean);
      await api("contact_roles", "POST", { contact_id: contactId, entity_type: "deal", entity_id: dealId, role_title: (role || "").trim() || null }).catch(() => {});
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person"); }
  };

  const removeDealContact = async (id) => {
    try {
      const row = dealContacts.find((dc) => dc.id === id);
      await api("deal_contacts", "DELETE", null, `?id=eq.${id}`);
      if (row) await api("contact_roles", "DELETE", null, `?contact_id=eq.${row.contact_id}&entity_type=eq.deal&entity_id=eq.${row.deal_id}`).catch(() => {});
      await loadData(); showToast("Person removed");
    } catch { showToast("Error removing person"); }
  };

  const addEnablerContact = async (enablerId, contactId, role) => {
    try {
      if (enablerContacts.some((ec) => ec.enabler_id === enablerId && ec.contact_id === contactId)) { showToast("Person already linked"); return; }
      const clean = { enabler_id: enablerId, contact_id: contactId };
      if ((role || "").trim()) clean.role_in_org = role.trim();
      await api("enabler_contacts", "POST", clean);
      await api("contact_roles", "POST", { contact_id: contactId, entity_type: "enabler", entity_id: enablerId, role_title: (role || "").trim() || null }).catch(() => {});
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person"); }
  };


  // Adds a contact_roles row for any institution kind (deal/enabler/organization)
  // and fans out to the matching legacy table so every existing sheet's People
  // section (which still reads deal_contacts/enabler_contacts/network_edges)
  // keeps working without changes. No UI side effects, so callers that add
  // several roles in a row (see addPersonWithRoles) can reload/toast once at the end.
  // Matches the DB's unique index on contact_roles (contact_id, entity_type,
  // entity_id, COALESCE(role_title, '')): a null and an empty-string title are
  // the same row for dedupe purposes.
  const roleTitlesMatch = (a, b) => (a || "").trim() === (b || "").trim();

  const persistPersonRole = async ({ contactId, entityType, entityId, roleTitle, isPrimary = false }) => {
    const title = (roleTitle || "").trim() || null;
    // Dedupe against already-loaded state first (the common case), then fall
    // back to treating a 409 from the unique index as the same outcome, in
    // case local state is stale (e.g. a role added on another device).
    const dup = contactRoles.some((r) => r.contact_id === contactId && r.entity_type === entityType && r.entity_id === entityId && roleTitlesMatch(r.role_title, title));
    if (dup) return { duplicate: true };
    try {
      await api("contact_roles", "POST", { contact_id: contactId, entity_type: entityType, entity_id: entityId, role_title: title, is_primary: !!isPrimary });
    } catch (e) {
      if (e?.status === 409) return { duplicate: true };
      throw e;
    }
    if (entityType === "deal") {
      await api("deal_contacts", "POST", { deal_id: entityId, contact_id: contactId, ...(title ? { role_in_deal: title } : {}) }).catch(() => {});
    } else if (entityType === "enabler") {
      await api("enabler_contacts", "POST", { enabler_id: entityId, contact_id: contactId, ...(title ? { role_in_org: title } : {}) }).catch(() => {});
    } else if (entityType === "organization") {
      await api("network_edges", "POST", { source_type: "contact", source_id: contactId, target_type: "organization", target_id: entityId, relationship: "works_at", strength: "unknown", ...(title ? { notes: title } : {}) }).catch(() => {});
    }
    return { duplicate: false };
  };

  // True when the entity being linked belongs to an internal institution, so a
  // person added there should be flagged internal team.
  const entityIsInternal = (entityType, entityId) => {
    if (entityType === "organization") return !!organizations.find((o) => o.id === entityId)?.is_internal;
    const name = entityType === "enabler" ? enablers.find((e) => e.id === entityId)?.name : entityType === "deal" ? deals.find((d) => d.id === entityId)?.company : null;
    if (!name) return false;
    return !!organizations.find((o) => (o.name || "").trim().toLowerCase() === name.trim().toLowerCase())?.is_internal;
  };

  const addPersonRole = async (args) => {
    try {
      const result = await persistPersonRole(args);
      if (result.duplicate) { showToast("Role already exists"); await loadData(); return; }
      // People at an internal institution automatically become internal team.
      if (args.contactId && entityIsInternal(args.entityType, args.entityId)) {
        await api("contacts", "PATCH", { is_internal: true }, `?id=eq.${args.contactId}`).catch(() => {});
      }
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person"); }
  };

  const removePersonRole = async (roleRow) => {
    try {
      await api("contact_roles", "DELETE", null, `?id=eq.${roleRow.id}`);
      if (roleRow.entity_type === "deal") {
        await api("deal_contacts", "DELETE", null, `?deal_id=eq.${roleRow.entity_id}&contact_id=eq.${roleRow.contact_id}`).catch(() => {});
      } else if (roleRow.entity_type === "enabler") {
        await api("enabler_contacts", "DELETE", null, `?enabler_id=eq.${roleRow.entity_id}&contact_id=eq.${roleRow.contact_id}`).catch(() => {});
      } else if (roleRow.entity_type === "organization") {
        await api("network_edges", "DELETE", null, `?source_type=eq.contact&source_id=eq.${roleRow.contact_id}&target_type=eq.organization&target_id=eq.${roleRow.entity_id}`).catch(() => {});
      }
      await loadData(); showToast("Person removed");
    } catch { showToast("Error removing person"); }
  };

  // Creates a contact plus one or more contact_roles in one go, for the Ecosystem
  // tab's "+ Person" form (a primary role plus any "Add another role" rows).
  // Each role's institutionKey is "type:id" (an institution created inline via
  // InstitutionSelect is already a real row by the time this saves). Also
  // writes the optional "connected through" and "can help us reach" edges.
  const addPersonWithRoles = async ({ name, company, role, email, phone, linkedin, warmth, notes, roles, introducedBy, introNotes, canReach, relationship }) => {
    try {
      // company/role, when supplied (e.g. adding a new person from an institution
      // sheet), populate the contact's own company/role fields in the same save.
      const created = await persistContact({ name, company, role, email, phone, linkedin, warmth, notes });
      if (!created) throw new Error("Could not create contact");
      const validRoles = (roles || []).filter((r) => r.institutionKey);
      let primaryAssigned = false;
      for (const r of validRoles) {
        const idx = r.institutionKey.indexOf(":");
        const entityType = r.institutionKey.slice(0, idx);
        const entityId = r.institutionKey.slice(idx + 1);
        await persistPersonRole({ contactId: created.id, entityType, entityId, roleTitle: r.role, isPrimary: !primaryAssigned });
        primaryAssigned = true;
      }
      // "Introduced by / reachable through": the existing person is the
      // connector, so the directional edge runs introducer -> new person (they
      // can introduce us onward to this new contact). Same canonical shape as
      // the Connect form's "can introduce" and the Path Finder narration.
      if (introducedBy) {
        const clean = { source_type: "contact", source_id: introducedBy, target_type: "contact", target_id: created.id, relationship: "can_introduce", strength: "medium", direction: "one_way" };
        if ((introNotes || "").trim()) clean.notes = introNotes.trim();
        await api("network_edges", "POST", clean).catch(() => {});
      }
      if (canReach) {
        const idx = canReach.indexOf(":");
        await api("network_edges", "POST", { source_type: "contact", source_id: created.id, target_type: canReach.slice(0, idx), target_id: canReach.slice(idx + 1), relationship: relationship || "can_introduce", strength: "medium", direction: "one_way" }).catch(() => {});
      }
      const n = validRoles.length;
      await loadData(); showToast(`${created.name} added${n > 0 ? ` with ${n} role${n === 1 ? "" : "s"}` : ""}.`);
      return created;
    } catch { showToast("Error adding person"); return null; }
  };

  // Creates a new person and, in the same step, the directional "can introduce"
  // edge from an existing introducer to that new person. Powers the Person
  // Sheet's "+ Someone they can introduce me to" shortcut (introducerId = the
  // card owner) and the Connect form's inline "add new person" option. Returns
  // the created contact so the caller can select it.
  const addPersonIntroducedBy = async ({ introducerId, name, role, institutionKey, notes }) => {
    try {
      const created = await persistContact({ name });
      if (!created) throw new Error("Could not create contact");
      if (institutionKey) {
        const idx = institutionKey.indexOf(":");
        await persistPersonRole({ contactId: created.id, entityType: institutionKey.slice(0, idx), entityId: institutionKey.slice(idx + 1), roleTitle: role || "", isPrimary: true });
      }
      if (introducerId) {
        const clean = { source_type: "contact", source_id: introducerId, target_type: "contact", target_id: created.id, relationship: "can_introduce", strength: "medium", direction: "one_way" };
        if ((notes || "").trim()) clean.notes = notes.trim();
        await api("network_edges", "POST", clean).catch(() => {});
      }
      await loadData(); showToast(`${created.name} added.`);
      return created;
    } catch { showToast("Error adding person"); return null; }
  };

  // INSTITUTIONS (organizations rows, plus optional linked deal/enabler)
  // Every institution is an organizations row. persistOrganization returns the
  // saved row so callers can link a freshly created org by id.
  const persistOrganization = async (form) => {
    const name = (form.name || "").trim();
    if (!name) throw new Error("Name is required");
    const clean = { name, type: form.type || "hospital", country: (form.country || "").trim() || "Saudi Arabia" };
    for (const k of ["sector", "description", "website", "notes", "city", "region", "address"]) {
      const v = (form[k] || "").trim();
      if (v) clean[k] = v;
    }
    if (form.is_internal !== undefined) clean.is_internal = !!form.is_internal;
    if (form.id) {
      await api("organizations", "PATCH", clean, `?id=eq.${form.id}`);
      return { id: form.id, ...clean };
    }
    return (await api("organizations", "POST", clean) || [])[0];
  };

  const createDealForInstitution = async ({ name, city, region }) => {
    const clean = { company: name, stage: "prospecting", last_activity_at: new Date().toISOString() };
    if ((city || "").trim()) clean.city = city;
    if ((region || "").trim()) clean.region = region;
    return (await api("deals", "POST", clean) || [])[0];
  };

  const createEnablerForInstitution = async ({ name, city, region }) => {
    const clean = { name, type: "strategic_partner", last_activity_at: new Date().toISOString() };
    if ((city || "").trim()) clean.city = city;
    if ((region || "").trim()) clean.region = region;
    return (await api("enablers", "POST", clean) || [])[0];
  };

  // Removes a deal and its deal-specific junctions, but preserves shared history
  // by nulling deal_id on activities/todos rather than deleting them. Used when
  // an institution is un-flagged as a Target ("archived" from the pipeline).
  const purgeDeal = async (id) => {
    await api("activities", "PATCH", { deal_id: null }, `?deal_id=eq.${id}`).catch(() => {});
    await api("todos", "PATCH", { deal_id: null }, `?deal_id=eq.${id}`).catch(() => {});
    await api("notes", "PATCH", { deal_id: null }, `?deal_id=eq.${id}`).catch(() => {});
    await api("meeting_briefs", "PATCH", { deal_id: null }, `?deal_id=eq.${id}`).catch(() => {});
    await api("boss_comments", "PATCH", { deal_id: null }, `?deal_id=eq.${id}`).catch(() => {});
    await api("calendar_events", "PATCH", { matched_deal_id: null }, `?matched_deal_id=eq.${id}`).catch(() => {});
    await api("material_links", "DELETE", null, `?deal_id=eq.${id}`).catch(() => {});
    await api("deal_contacts", "DELETE", null, `?deal_id=eq.${id}`).catch(() => {});
    await api("contact_roles", "DELETE", null, `?entity_type=eq.deal&entity_id=eq.${id}`).catch(() => {});
    await api("deal_enablers", "DELETE", null, `?deal_id=eq.${id}`).catch(() => {});
    await api("network_edges", "DELETE", null, `?source_type=eq.deal&source_id=eq.${id}`).catch(() => {});
    await api("network_edges", "DELETE", null, `?target_type=eq.deal&target_id=eq.${id}`).catch(() => {});
    await api("deals", "DELETE", null, `?id=eq.${id}`);
    await deleteFullyOrphanedActivities();
  };

  const purgeEnabler = async (id) => {
    await api("activities", "PATCH", { enabler_id: null }, `?enabler_id=eq.${id}`).catch(() => {});
    await api("todos", "PATCH", { enabler_id: null }, `?enabler_id=eq.${id}`).catch(() => {});
    await api("notes", "PATCH", { enabler_id: null }, `?enabler_id=eq.${id}`).catch(() => {});
    await api("meeting_briefs", "PATCH", { enabler_id: null }, `?enabler_id=eq.${id}`).catch(() => {});
    await api("boss_comments", "PATCH", { enabler_id: null }, `?enabler_id=eq.${id}`).catch(() => {});
    await api("calendar_events", "PATCH", { matched_enabler_id: null }, `?matched_enabler_id=eq.${id}`).catch(() => {});
    await api("material_links", "DELETE", null, `?enabler_id=eq.${id}`).catch(() => {});
    await api("enabler_contacts", "DELETE", null, `?enabler_id=eq.${id}`).catch(() => {});
    await api("contact_roles", "DELETE", null, `?entity_type=eq.enabler&entity_id=eq.${id}`).catch(() => {});
    await api("deal_enablers", "DELETE", null, `?enabler_id=eq.${id}`).catch(() => {});
    await api("network_edges", "DELETE", null, `?source_type=eq.enabler&source_id=eq.${id}`).catch(() => {});
    await api("network_edges", "DELETE", null, `?target_type=eq.enabler&target_id=eq.${id}`).catch(() => {});
    await api("enablers", "DELETE", null, `?id=eq.${id}`);
    await deleteFullyOrphanedActivities();
  };

  // Ecosystem tab's "+ Institution" form. Always creates an organizations row, and
  // creates a linked deal (Target) and/or enabler (Enabler) when those boxes are
  // checked, keeping the Pipeline in sync.
  const addInstitution = async (form) => {
    const name = (form.name || "").trim();
    if (!name) { showToast("Name is required"); return; }
    try {
      const org = await persistOrganization({ name, type: form.type, city: form.city, region: form.region, sector: form.sector, description: form.description, website: form.website, is_internal: form.isInternal });
      // Internal institutions are our own org, never a pipeline target: skip the
      // deal even if Target was checked. Enabler is still allowed.
      if (form.isTarget && !form.isInternal) await createDealForInstitution({ name, city: form.city, region: form.region });
      if (form.isEnabler) await createEnablerForInstitution({ name, city: form.city, region: form.region });
      await loadData(); showToast(`${name} added. Click to add people.`);
      // Auto-research the new institution unless the user supplied a description.
      if (org?.id && !(form.description || "").trim()) {
        autoFillInstitution({ key: name.toLowerCase(), name, city: form.city, orgId: org.id });
      }
    } catch { showToast("Error adding institution"); }
  };

  // Same creation logic as addInstitution, but for the "+ Add new institution"
  // option inside any institution picker: no navigation, no auto-research, and
  // it returns the created ids (plus a "preferred" type:id ref, following the
  // same deal > enabler > organization precedence as institutionPrimaryEntity)
  // so the picker can select the new institution immediately and continue.
  const createInstitutionInline = async ({ name, type, isTarget, isEnabler }) => {
    const cleanName = (name || "").trim();
    if (!cleanName) { showToast("Name is required"); return null; }
    try {
      const org = await persistOrganization({ name: cleanName, type });
      const deal = isTarget ? await createDealForInstitution({ name: cleanName }) : null;
      const enabler = isEnabler ? await createEnablerForInstitution({ name: cleanName }) : null;
      await loadData();
      showToast("Institution created and selected.");
      const preferred = deal ? { type: "deal", id: deal.id } : enabler ? { type: "enabler", id: enabler.id } : { type: "organization", id: org.id };
      return { orgId: org?.id || null, dealId: deal?.id || null, enablerId: enabler?.id || null, name: cleanName, preferred };
    } catch { showToast("Error creating institution"); return null; }
  };

  // Toggles an institution's Target or Enabler flag directly from the sheet:
  // checking creates the linked deal/enabler, unchecking archives it (history kept).
  const setInstitutionFlag = async (inst, flag, checked) => {
    try {
      if (flag === "target") {
        // An internal institution is never a pipeline target.
        if (checked && inst.isInternal) { showToast("Internal institutions are not pipeline targets"); return; }
        if (checked && !inst.dealId) await createDealForInstitution({ name: inst.name, city: inst.city, region: inst.region });
        else if (!checked && inst.dealId) await purgeDeal(inst.dealId);
        else return;
      } else if (flag === "enabler") {
        if (checked && !inst.enablerId) await createEnablerForInstitution({ name: inst.name, city: inst.city, region: inst.region });
        else if (!checked && inst.enablerId) await purgeEnabler(inst.enablerId);
        else return;
      } else if (flag === "internal") {
        // Marking internal ensures an org row exists, flips is_internal, and
        // archives any pipeline deal (an internal org is not a target).
        let orgId = inst.orgId;
        if (!orgId) { const org = await persistOrganization({ name: inst.name, type: inst.type || "hospital", city: inst.city, region: inst.region }); orgId = org?.id; }
        if (!orgId) throw new Error("no org");
        await api("organizations", "PATCH", { is_internal: !!checked }, `?id=eq.${orgId}`);
        if (checked && inst.dealId) await purgeDeal(inst.dealId);
        if (checked) await markInstitutionPeopleInternal(inst);
      }
      await loadData(); savedToast();
    } catch { showToast("Error updating institution"); }
  };

  // When an institution becomes internal, its people become internal team too.
  const markInstitutionPeopleInternal = async (inst) => {
    const ppl = institutionPeople(inst, { contactRoles, dealContacts, enablerContacts, networkEdges, contacts });
    const ids = ppl.map((p) => p.contact?.id).filter(Boolean);
    if (ids.length === 0) return;
    await api("contacts", "PATCH", { is_internal: true }, `?id=in.(${ids.join(",")})`).catch(() => {});
  };

  const deleteInstitution = async (inst) => {
    try {
      if (inst.dealId) await purgeDeal(inst.dealId);
      if (inst.enablerId) await purgeEnabler(inst.enablerId);
      if (inst.orgId) {
        // Null the org reference on history rows (an activity may also belong to
        // a contact); fully-orphaned activities are swept afterwards.
        await api("activities", "PATCH", { organization_id: null }, `?organization_id=eq.${inst.orgId}`).catch(() => {});
        await api("todos", "PATCH", { organization_id: null }, `?organization_id=eq.${inst.orgId}`).catch(() => {});
        await api("notes", "PATCH", { organization_id: null }, `?organization_id=eq.${inst.orgId}`).catch(() => {});
        await api("meeting_briefs", "PATCH", { organization_id: null }, `?organization_id=eq.${inst.orgId}`).catch(() => {});
        await api("boss_comments", "PATCH", { organization_id: null }, `?organization_id=eq.${inst.orgId}`).catch(() => {});
        await api("calendar_events", "PATCH", { matched_organization_id: null }, `?matched_organization_id=eq.${inst.orgId}`).catch(() => {});
        await api("material_links", "DELETE", null, `?organization_id=eq.${inst.orgId}`).catch(() => {});
        await api("network_edges", "DELETE", null, `?source_type=eq.organization&source_id=eq.${inst.orgId}`);
        await api("network_edges", "DELETE", null, `?target_type=eq.organization&target_id=eq.${inst.orgId}`);
        await api("contact_roles", "DELETE", null, `?entity_type=eq.organization&entity_id=eq.${inst.orgId}`);
        await api("organizations", "DELETE", null, `?id=eq.${inst.orgId}`);
        await deleteFullyOrphanedActivities();
      }
      await loadData(); showToast("Institution deleted");
      setView("network"); setInstitutionSheetKey(null);
    } catch { showToast("Error deleting institution"); }
  };

  const removeNetworkEdge = async (id) => {
    try {
      const edge = networkEdges.find((ne) => ne.id === id);
      await api("network_edges", "DELETE", null, `?id=eq.${id}`);
      if (edge && edge.source_type === "contact" && edge.target_type === "organization") {
        await api("contact_roles", "DELETE", null, `?contact_id=eq.${edge.source_id}&entity_type=eq.organization&entity_id=eq.${edge.target_id}`).catch(() => {});
      }
      await loadData(); showToast("Connection removed");
    } catch { showToast("Error removing connection"); }
  };

  // Flip a directional edge's source and target in place (e.g. a "can introduce"
  // recorded backwards): the same single edge now reads the other way on both
  // people's cards. Patches local state directly (targeted update).
  const swapNetworkEdge = async (id) => {
    try {
      const edge = networkEdges.find((ne) => ne.id === id);
      if (!edge) return;
      const swapped = { source_type: edge.target_type, source_id: edge.target_id, target_type: edge.source_type, target_id: edge.source_id };
      await api("network_edges", "PATCH", swapped, `?id=eq.${id}`);
      setNetworkEdges((prev) => prev.map((ne) => (ne.id === id ? { ...ne, ...swapped } : ne)));
      showToast("Direction swapped");
    } catch { showToast("Error swapping direction"); }
  };

  // DEAL <-> ENABLER CONNECTIONS
  const addDealEnabler = async (form) => {
    try {
      if (dealEnablers.some((de) => de.deal_id === form.deal_id && de.enabler_id === form.enabler_id)) { showToast("Connection already exists"); return; }
      const clean = {
        deal_id: form.deal_id,
        enabler_id: form.enabler_id,
        relationship: form.relationship || "can_introduce",
        strength: form.strength || "medium",
      };
      if ((form.notes || "").trim()) clean.notes = form.notes.trim();
      await api("deal_enablers", "POST", clean);
      await loadData(); showToast("Connection added");
    } catch { showToast("Error adding connection"); }
  };


  // GENERIC POLYMORPHIC EDGES (any entity to any entity, used when the pair
  // isn't a deal/enabler/contact combo with its own dedicated junction table)
  // There is no DB-level unique constraint on network_edges, so this is the
  // only thing stopping a duplicate: the same pair of nodes (in either
  // direction, since most edges are bidirectional) with the same relationship.
  const networkEdgeExists = (e) => networkEdges.some((x) =>
    x.relationship === e.relationship &&
    ((x.source_type === e.source_type && x.source_id === e.source_id && x.target_type === e.target_type && x.target_id === e.target_id) ||
     (x.source_type === e.target_type && x.source_id === e.target_id && x.target_type === e.source_type && x.target_id === e.source_id)));

  const addNetworkEdge = async (form) => {
    try {
      const clean = {
        source_type: form.source_type,
        source_id: form.source_id,
        target_type: form.target_type,
        target_id: form.target_id,
        relationship: form.relationship || "knows",
        strength: form.strength || "unknown",
        direction: form.direction || "bidirectional",
      };
      if ((form.notes || "").trim()) clean.notes = form.notes.trim();
      if (networkEdgeExists(clean)) { showToast("Connection already exists"); return; }
      await api("network_edges", "POST", clean);
      await loadData(); showToast("Connection added");
    } catch { showToast("Error adding connection"); }
  };

  // Routes a generic "entity A <-> entity B" connection to the right table:
  // deal+enabler -> deal_enablers, contact+deal -> deal_contacts,
  // contact+enabler -> enabler_contacts, anything else -> network_edges.
  const addConnection = async ({ aType, aId, bType, bId, relationship, role, strength, notes }) => {
    const pair = [aType, bType].sort().join("-");
    const combinedNotes = (role || "").trim() && (notes || "").trim()
      ? `${role.trim()}. ${notes.trim()}`
      : (role || "").trim() || (notes || "").trim();
    if (pair === "deal-enabler") {
      const dealId = aType === "deal" ? aId : bId;
      const enablerId = aType === "enabler" ? aId : bId;
      const validRel = ["can_introduce", "active", "institutional"];
      await addDealEnabler({
        deal_id: dealId,
        enabler_id: enablerId,
        relationship: validRel.includes(relationship) ? relationship : "can_introduce",
        strength: strength === "unknown" ? "medium" : strength,
        notes: combinedNotes,
      });
    } else if (pair === "contact-deal") {
      const dealId = aType === "deal" ? aId : bId;
      const contactId = aType === "contact" ? aId : bId;
      await addDealContact(dealId, contactId, combinedNotes || NETWORK_EDGE_RELATIONSHIPS.find((r) => r.id === relationship)?.label || "");
    } else if (pair === "contact-enabler") {
      const enablerId = aType === "enabler" ? aId : bId;
      const contactId = aType === "contact" ? aId : bId;
      await addEnablerContact(enablerId, contactId, combinedNotes || NETWORK_EDGE_RELATIONSHIPS.find((r) => r.id === relationship)?.label || "");
    } else if (pair === "contact-organization") {
      const organizationId = aType === "organization" ? aId : bId;
      const contactId = aType === "contact" ? aId : bId;
      await addPersonRole({ contactId, entityType: "organization", entityId: organizationId, roleTitle: combinedNotes || NETWORK_EDGE_RELATIONSHIPS.find((r) => r.id === relationship)?.label || "" });
    } else {
      await addNetworkEdge({ source_type: aType, source_id: aId, target_type: bType, target_id: bId, relationship, strength, notes: combinedNotes });
    }
  };

  const generateDealSummary = async (deal, dealActivities) => {
    setSummarizing(true);
    try {
      const activityText = dealActivities.length > 0
        ? dealActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${cleanActivityText(a.description)}`).join("\n")
        : "No activities logged yet.";
      const prompt = `You are a sales analyst summarizing a deal for a BD pipeline tool.

Deal: ${deal.company} (Stage: ${STAGES.find((s) => s.id === deal.stage)?.label || deal.stage})
${deal.value > 0 ? `Value: $${Number(deal.value).toLocaleString()}\n` : ""}${deal.contact_name ? `Primary contact: ${deal.contact_name}${deal.contact_role ? ` (${deal.contact_role})` : ""}\n` : ""}${deal.next_action ? `Next action: ${deal.next_action}\n` : ""}${deal.notes ? `Notes: ${deal.notes}\n` : ""}
Activity history:
${activityText}

Write a concise status summary covering:
1. Relationship status
2. Key interactions
3. What was discussed
4. Deal stage context
5. Next steps
6. Any risks or blockers

Keep it tight and scannable. No preamble. Do not use em dashes anywhere in the summary; use commas, periods, colons, or parentheses instead.`;
      const summary = await generateSummary(prompt);
      const at = new Date().toISOString();
      await api("deals", "PATCH", { ai_summary: summary, ai_summary_updated_at: at }, `?id=eq.${deal.id}`);
      setDeals((prev) => prev.map((r) => (r.id === deal.id ? { ...r, ai_summary: summary, ai_summary_updated_at: at } : r)));
      showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const generateEnablerSummary = async (enabler, enablerActivities) => {
    setSummarizing(true);
    try {
      const activityText = enablerActivities.length > 0
        ? enablerActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${cleanActivityText(a.description)}`).join("\n")
        : "No activities logged yet.";
      const prompt = `You are a partnerships analyst summarizing the relationship with an enabler (a VC, government body, research institution, strategic partner, accelerator, or connector) for a BD pipeline tool.

Enabler: ${enabler.name} (${ENABLER_TYPES.find((t) => t.id === enabler.type)?.label || enabler.type})
${enabler.contact_name ? `Primary contact: ${enabler.contact_name}\n` : ""}${enabler.notes ? `Notes: ${enabler.notes}\n` : ""}
Activity history:
${activityText}

Write a concise status summary covering:
1. Relationship status
2. Key interactions
3. What was discussed
4. Next steps
5. Any opportunities

Keep it tight and scannable. No preamble. Do not use em dashes anywhere in the summary; use commas, periods, colons, or parentheses instead.`;
      const summary = await generateSummary(prompt);
      const at = new Date().toISOString();
      await api("enablers", "PATCH", { ai_summary: summary, ai_summary_updated_at: at }, `?id=eq.${enabler.id}`);
      setEnablers((prev) => prev.map((r) => (r.id === enabler.id ? { ...r, ai_summary: summary, ai_summary_updated_at: at } : r)));
      showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const generateContactSummary = async (contact, contactActivities) => {
    setSummarizing(true);
    try {
      const activityText = contactActivities.length > 0
        ? contactActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${cleanActivityText(a.description)}`).join("\n")
        : "No activities logged yet.";
      const prompt = `You are a relationship manager summarizing interactions with a contact for a BD pipeline tool.

Contact: ${contact.name}${contact.role ? ` (${contact.role})` : ""}${contact.company ? ` at ${contact.company}` : ""}
${contact.notes ? `Notes: ${contact.notes}\n` : ""}
Activity history:
${activityText}

Write a concise status summary covering:
1. Relationship status
2. Key interactions
3. What was discussed
4. Next steps
5. Any opportunities or risks

Keep it tight and scannable. No preamble. Do not use em dashes anywhere in the summary; use commas, periods, colons, or parentheses instead.`;
      const summary = await generateSummary(prompt);
      const at = new Date().toISOString();
      await api("contacts", "PATCH", { ai_summary: summary, ai_summary_updated_at: at }, `?id=eq.${contact.id}`);
      setContacts((prev) => prev.map((r) => (r.id === contact.id ? { ...r, ai_summary: summary, ai_summary_updated_at: at } : r)));
      showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const saveContactSummary = async (id, text) => {
    try {
      const at = new Date().toISOString();
      await api("contacts", "PATCH", { ai_summary: text, ai_summary_updated_at: at }, `?id=eq.${id}`);
      setContacts((prev) => prev.map((r) => (r.id === id ? { ...r, ai_summary: text, ai_summary_updated_at: at } : r)));
      showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  const generateOrganizationSummary = async (organization, orgActivities, keyPeopleNames) => {
    setSummarizing(true);
    try {
      const activityText = orgActivities.length > 0
        ? orgActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${cleanActivityText(a.description)}`).join("\n")
        : "No activities logged yet.";
      const t = ORG_TYPES.find((x) => x.id === organization.type);
      const prompt = `You are a market intelligence analyst summarizing an organization for a BD pipeline tool.

Organization: ${organization.name} (${t?.label || organization.type})
${organization.sector ? `Sector: ${organization.sector}\n` : ""}${organization.city ? `Location: ${organization.city}${organization.region ? `, ${organization.region}` : ""}\n` : ""}${organization.description ? `Description: ${organization.description}\n` : ""}${organization.notes ? `Notes: ${organization.notes}\n` : ""}${keyPeopleNames && keyPeopleNames.length > 0 ? `Key people: ${keyPeopleNames.join(", ")}\n` : ""}
Activity history:
${activityText}

Write a concise status summary covering:
1. Relationship status
2. Key interactions
3. What was discussed
4. Next steps
5. Any risks or opportunities

Keep it tight and scannable. No preamble. Do not use em dashes anywhere in the summary; use commas, periods, colons, or parentheses instead.`;
      const summary = await generateSummary(prompt);
      const at = new Date().toISOString();
      await api("organizations", "PATCH", { ai_summary: summary, ai_summary_updated_at: at }, `?id=eq.${organization.id}`);
      setOrganizations((prev) => prev.map((r) => (r.id === organization.id ? { ...r, ai_summary: summary, ai_summary_updated_at: at } : r)));
      showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const saveOrganizationSummary = async (id, text) => {
    try {
      const at = new Date().toISOString();
      await api("organizations", "PATCH", { ai_summary: text, ai_summary_updated_at: at }, `?id=eq.${id}`);
      setOrganizations((prev) => prev.map((r) => (r.id === id ? { ...r, ai_summary: text, ai_summary_updated_at: at } : r)));
      showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  const saveDealSummary = async (id, text) => {
    try {
      const at = new Date().toISOString();
      await api("deals", "PATCH", { ai_summary: text, ai_summary_updated_at: at }, `?id=eq.${id}`);
      setDeals((prev) => prev.map((r) => (r.id === id ? { ...r, ai_summary: text, ai_summary_updated_at: at } : r)));
      showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  const saveEnablerSummary = async (id, text) => {
    try {
      const at = new Date().toISOString();
      await api("enablers", "PATCH", { ai_summary: text, ai_summary_updated_at: at }, `?id=eq.${id}`);
      setEnablers((prev) => prev.map((r) => (r.id === id ? { ...r, ai_summary: text, ai_summary_updated_at: at } : r)));
      showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  // TODOS
  // Reconciles todo_contacts against a fresh list of contact ids for a task:
  // adds rows for newly-picked people, removes rows for unpicked ones. Called
  // after every todos write that carries a contact_ids array.
  const syncTodoContacts = async (todoId, contactIds) => {
    const ids = [...new Set((contactIds || []).filter(Boolean))];
    const existing = todoContacts.filter((tc) => tc.todo_id === todoId);
    const toAdd = ids.filter((id) => !existing.some((tc) => tc.contact_id === id));
    const toRemove = existing.filter((tc) => !ids.includes(tc.contact_id));
    const [addedRows] = await Promise.all([
      Promise.all(toAdd.map((contactId) => api("todo_contacts", "POST", { todo_id: todoId, contact_id: contactId }).catch(() => null))),
      Promise.all(toRemove.map((tc) => api("todo_contacts", "DELETE", null, `?id=eq.${tc.id}`).catch(() => {}))),
    ]);
    const added = addedRows.flatMap((r) => (Array.isArray(r) ? r : (r ? [r] : [])));
    const removedIds = new Set(toRemove.map((tc) => tc.id));
    setTodoContacts((prev) => [...prev.filter((tc) => !removedIds.has(tc.id)), ...added]);
  };

  // A task's contactIds come either as an explicit array (the multi-select
  // form) or a single legacy contact_id; todos.contact_id always stays
  // populated with the first pick so older reads keep working.
  const resolveContactIds = (form) => [...new Set((form.contact_ids || (form.contact_id ? [form.contact_id] : [])).filter(Boolean))];

  const saveTodo = async (form) => {
    try {
      const title = (form.title || "").trim();
      if (!title) { showToast("Title is required"); return; }
      const contactIds = resolveContactIds(form);
      const clean = { title, priority: form.priority || "medium", status: "open" };
      if (form.due_date) clean.due_date = form.due_date;
      if (contactIds[0]) clean.contact_id = contactIds[0];
      if (form.deal_id) clean.deal_id = form.deal_id;
      if (form.enabler_id) clean.enabler_id = form.enabler_id;
      if (form.organization_id) clean.organization_id = form.organization_id;
      const rows = await api("todos", "POST", clean);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) {
        setTodos((prev) => [row, ...prev]);
        if (contactIds.length) await syncTodoContacts(row.id, contactIds);
      }
      showToast("To-do added");
    } catch { showToast("Error adding to-do"); }
  };

  const toggleTodo = async (todo) => {
    try {
      const completing = todo.status !== "completed";
      const patch = { status: completing ? "completed" : "open", completed_at: completing ? new Date().toISOString() : null };
      await api("todos", "PATCH", patch, `?id=eq.${todo.id}`);
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, ...patch } : t)));
    } catch { showToast("Error updating to-do"); }
  };

  const updateTodo = async (id, patch) => {
    try {
      const { contact_ids, ...rest } = patch;
      const clean = { ...rest };
      if (contact_ids) clean.contact_id = contact_ids[0] || null;
      await api("todos", "PATCH", clean, `?id=eq.${id}`);
      setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, ...clean } : t)));
      if (contact_ids) await syncTodoContacts(id, contact_ids);
      showToast("To-do updated");
    } catch { showToast("Error updating to-do"); }
  };

  // NOTES. The `notes` table has no updated_at trigger, so every write stamps
  // updated_at manually. Writes patch local state (rather than a full reload) so
  // the editor stays snappy and the cursor never jumps while typing.
  const createNote = async () => {
    try {
      const rows = await api("notes", "POST", { title: "Untitled", content: "" });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) { setNotes((prev) => [row, ...prev]); setSelectedNoteId(row.id); }
      return row;
    } catch { showToast("Error creating note"); }
  };
  const updateNote = async (id, patch) => {
    const now = new Date().toISOString();
    try {
      await api("notes", "PATCH", { ...patch, updated_at: now }, `?id=eq.${id}`);
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch, updated_at: now } : n)));
    } catch { showToast("Error saving note"); }
  };
  const deleteNote = async (id) => {
    try {
      await api("notes", "DELETE", null, `?id=eq.${id}`);
      setNotes((prev) => prev.filter((n) => n.id !== id));
      setSelectedNoteId((cur) => (cur === id ? null : cur));
      showToast("Note deleted");
    } catch { showToast("Error deleting note"); }
  };
  // Single-link model: setting a link clears the other three entity FKs. entity
  // is { type: "deal"|"enabler"|"organization"|"contact", entityId } or null.
  const linkNote = (id, entity) => {
    const patch = { deal_id: null, enabler_id: null, organization_id: null, contact_id: null };
    if (entity) patch[`${entity.type}_id`] = entity.entityId;
    return updateNote(id, patch);
  };
  const openNote = (id) => { setSelectedNoteId(id); navigateTab("notes"); };

  // NOTE FOLDERS. Simple tree via parent_id; local state is patched on write.
  const createFolder = async (name = "New Folder", parent_id = null) => {
    try {
      const clean = { name };
      if (parent_id) clean.parent_id = parent_id;
      const rows = await api("note_folders", "POST", clean);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setNoteFolders((prev) => [...prev, row]);
      return row;
    } catch { showToast("Error creating folder"); }
  };
  const updateFolder = async (id, patch) => {
    try {
      await api("note_folders", "PATCH", patch, `?id=eq.${id}`);
      setNoteFolders((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    } catch { showToast("Error updating folder"); }
  };
  // Delete a folder: move its notes to Unfiled and reparent direct child folders
  // up to this folder's parent, then remove the folder.
  const deleteFolder = async (id) => {
    const folder = noteFolders.find((f) => f.id === id);
    try {
      const childNotes = notes.filter((n) => n.folder_id === id);
      await Promise.all(childNotes.map((n) => api("notes", "PATCH", { folder_id: null }, `?id=eq.${n.id}`)));
      const childFolders = noteFolders.filter((f) => f.parent_id === id);
      await Promise.all(childFolders.map((f) => api("note_folders", "PATCH", { parent_id: folder?.parent_id || null }, `?id=eq.${f.id}`)));
      await api("note_folders", "DELETE", null, `?id=eq.${id}`);
      setNotes((prev) => prev.map((n) => (n.folder_id === id ? { ...n, folder_id: null } : n)));
      setNoteFolders((prev) => prev.filter((f) => f.id !== id).map((f) => (f.parent_id === id ? { ...f, parent_id: folder?.parent_id || null } : f)));
      showToast("Folder deleted, notes moved to Unfiled");
    } catch { showToast("Error deleting folder"); }
  };
  const moveNoteToFolder = (noteId, folderId) => updateNote(noteId, { folder_id: folderId || null });

  // MATERIALS LIBRARY. Rows in local state never carry file_data (too big);
  // uploads strip it from the POST response and downloads fetch it on demand.
  const uploadMaterial = async (form) => {
    try {
      const clean = { name: (form.name || form.file_name || "Untitled").trim(), type: form.type || "other" };
      if (form.audience) clean.audience = form.audience;
      if ((form.version || "").trim()) clean.version = form.version.trim();
      if ((form.notes || "").trim()) clean.notes = form.notes.trim();
      if (form.file_name) clean.file_name = form.file_name;
      if (form.file_data) clean.file_data = form.file_data;
      if (form.file_size) clean.file_size = form.file_size;
      if (form.mime_type) clean.mime_type = form.mime_type;
      const rows = await api("materials", "POST", clean);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) { const { file_data, ...rest } = row; setMaterials((prev) => [rest, ...prev]); }
      showToast("Material uploaded");
      return row;
    } catch { showToast("Error uploading material"); }
  };
  const updateMaterial = async (id, patch) => {
    const now = new Date().toISOString();
    try {
      await api("materials", "PATCH", { ...patch, updated_at: now }, `?id=eq.${id}`);
      setMaterials((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch, updated_at: now } : m)));
      savedToast();
    } catch { showToast("Error updating material"); }
  };
  const deleteMaterial = async (id) => {
    try {
      await api("material_links", "DELETE", null, `?material_id=eq.${id}`);
      await api("materials", "DELETE", null, `?id=eq.${id}`);
      setMaterials((prev) => prev.filter((m) => m.id !== id));
      setMaterialLinks((prev) => prev.filter((l) => l.material_id !== id));
      showToast("Material deleted");
    } catch { showToast("Error deleting material"); }
  };
  // Fetch the stored base64 body on demand and trigger a browser download.
  const downloadMaterial = async (m) => {
    try {
      const rows = await api("materials", "GET", null, `?id=eq.${m.id}&select=file_data,file_name,mime_type`);
      const row = rows && rows[0];
      if (!row || !row.file_data) { showToast("No file stored for this material"); return; }
      const a = document.createElement("a");
      a.href = row.file_data;
      a.download = row.file_name || m.name || "material";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch { showToast("Error downloading material"); }
  };
  // tag is { deal_id } / { enabler_id } / { organization_id } / { contact_id }.
  const attachMaterial = async (materialId, tag) => {
    try {
      const rows = await api("material_links", "POST", { material_id: materialId, ...tag });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setMaterialLinks((prev) => [row, ...prev]);
      showToast("Material attached");
    } catch { showToast("Error attaching material"); }
  };
  const removeMaterialLink = async (linkId) => {
    try {
      await api("material_links", "DELETE", null, `?id=eq.${linkId}`);
      setMaterialLinks((prev) => prev.filter((l) => l.id !== linkId));
    } catch { showToast("Error removing link"); }
  };

  // MEETING PREP BRIEFS. Context is gathered from already-loaded state, sent to
  // the AI (max_tokens 600), and the result saved to meeting_briefs so it can
  // be revisited without regenerating.
  const gatherBriefContext = ({ contact, deal, enabler, org }) => {
    const lines = [];
    const actLine = (a) => `[${formatDate(a.created_at)}] ${a.type}: ${firstLine(cleanActivityText(a.description))}`;
    if (contact) {
      lines.push(`PERSON: ${contact.name}${contact.role ? `, ${contact.role}` : ""}${contact.company ? ` at ${contact.company}` : ""}`);
      lines.push(`Warmth: ${contact.warmth || "unknown"}. Last contacted: ${contact.last_contacted_at ? formatDate(contact.last_contacted_at) : "never logged"}.`);
      const roles = resolveContactRoles(contact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
      if (roles.length) lines.push(`Roles: ${roles.map((r) => `${r.role_title ? `${r.role_title} at ` : ""}${r.institutionName}`).join("; ")}`);
      if (contact.notes) lines.push(`Notes on this person: ${contact.notes}`);
      if (contact.ai_summary) lines.push(`Person summary: ${contact.ai_summary}`);
      const acts = activities.filter((a) => a.contact_id === contact.id).slice(0, 10);
      if (acts.length) lines.push(`Last interactions with ${contact.name}:\n${acts.map(actLine).join("\n")}`);
    }
    const entity = deal || enabler || org;
    if (entity) {
      const eName = deal ? deal.company : entity.name;
      lines.push(`INSTITUTION/DEAL: ${eName}${deal ? ` (pipeline stage: ${deal.stage}${deal.tier ? `, ${deal.tier}` : ""})` : ""}`);
      if (entity.ai_summary) lines.push(`Institution summary: ${entity.ai_summary}`);
      if (entity.notes) lines.push(`Institution notes: ${entity.notes}`);
      const acts = activities.filter((a) => (deal && a.deal_id === deal.id) || (enabler && a.enabler_id === enabler.id) || (org && a.organization_id === org.id)).slice(0, 10);
      if (acts.length) lines.push(`Recent activity on ${eName}:\n${acts.map(actLine).join("\n")}`);
    }
    const openTasks = todos.filter((t) => t.status === "open" && (
      (contact && t.contact_id === contact.id) || (deal && t.deal_id === deal.id) ||
      (enabler && t.enabler_id === enabler.id) || (org && t.organization_id === org.id)));
    if (openTasks.length) lines.push(`Open tasks:\n${openTasks.map((t) => `- ${t.title}${t.due_date ? ` (due ${formatDate(t.due_date)})` : ""} [${t.priority}]`).join("\n")}`);
    const linkIds = new Set(materialLinks
      .filter((l) => (deal && l.deal_id === deal.id) || (enabler && l.enabler_id === enabler.id) || (org && l.organization_id === org.id) || (contact && l.contact_id === contact.id))
      .map((l) => l.material_id));
    const mats = materials.filter((m) => linkIds.has(m.id));
    if (mats.length) lines.push(`Materials on file for them: ${mats.map((m) => `${m.name}${m.version ? ` (${m.version})` : ""}`).join("; ")}`);
    return lines.join("\n\n") || "No history on file yet.";
  };

  // Status roll-up context for an INTERNAL team brief (a sync with our own
  // team, not an external prospect): pipeline movement, key activities, tasks,
  // unresolved comments from Andy, and deals awaiting a decision.
  const gatherInternalBriefContext = () => {
    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
    const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate() - 14);
    const lines = [];

    const movedDeals = deals.filter((d) => d.last_activity_at && new Date(d.last_activity_at) >= weekAgo);
    if (movedDeals.length) lines.push(`DEALS WITH RECENT MOVEMENT (last 7 days):\n${movedDeals.map((d) => `- ${d.company}: ${STAGES.find((s) => s.id === d.stage)?.label || d.stage}${d.value ? `, $${Number(d.value).toLocaleString()}` : ""}`).join("\n")}`);

    const newDeals = deals.filter((d) => d.created_at && new Date(d.created_at) >= weekAgo);
    if (newDeals.length) lines.push(`NEW DEALS ADDED (last 7 days):\n${newDeals.map((d) => `- ${d.company} (${STAGES.find((s) => s.id === d.stage)?.label || d.stage})`).join("\n")}`);

    const staleDealsList = deals.filter((d) => !["won", "lost"].includes(d.stage) && (!d.last_activity_at || new Date(d.last_activity_at) < twoWeeksAgo));
    if (staleDealsList.length) lines.push(`STALE DEALS (no activity 14+ days):\n${staleDealsList.map((d) => `- ${d.company}, last activity ${d.last_activity_at ? formatDate(d.last_activity_at) : "never"}`).join("\n")}`);

    const recentActs = activities.filter((a) => (a.deal_id || a.enabler_id) && new Date(a.created_at) >= weekAgo).slice(0, 20);
    if (recentActs.length) {
      lines.push(`KEY ACTIVITIES (last 7 days):\n${recentActs.map((a) => {
        const d = a.deal_id ? deals.find((x) => x.id === a.deal_id) : null;
        const e = a.enabler_id ? enablers.find((x) => x.id === a.enabler_id) : null;
        const who = d?.company || e?.name || "General";
        return `- [${formatDate(a.created_at)}] ${who}: ${firstLine(cleanActivityText(a.description))}`;
      }).join("\n")}`);
    }

    const highPrio = todos.filter((t) => t.status === "open" && t.priority === "high");
    if (highPrio.length) lines.push(`OPEN HIGH PRIORITY TASKS:\n${highPrio.map((t) => `- ${t.title}${t.due_date ? ` (due ${formatDate(t.due_date)})` : ""}`).join("\n")}`);

    const overdue = todos.filter((t) => t.status === "open" && isOverdue(t.due_date));
    if (overdue.length) lines.push(`OVERDUE TASKS:\n${overdue.map((t) => `- ${t.title} (was due ${formatDate(t.due_date)})`).join("\n")}`);

    const andyComments = bossComments.filter((c) => c.author === "Andy Liu" && !c.is_read);
    if (andyComments.length) lines.push(`UNRESOLVED COMMENTS FROM ANDY:\n${andyComments.map((c) => `- ${c.content}`).join("\n")}`);

    const awaitingDecision = deals.filter((d) => ["negotiation", "proposal"].includes(d.stage));
    if (awaitingDecision.length) lines.push(`DEALS AWAITING A DECISION:\n${awaitingDecision.map((d) => `- ${d.company} (${STAGES.find((s) => s.id === d.stage)?.label || d.stage}${d.value ? `, $${Number(d.value).toLocaleString()}` : ""})`).join("\n")}`);

    return lines.join("\n\n") || "No notable pipeline activity this week.";
  };

  // Auto-detects which brief to generate for a calendar event (Section 3): a
  // match to an external deal/enabler/organization, or to a contact who is not
  // internal, always wins as External; otherwise, if every attendee is internal
  // team, it is an Internal brief. The user can still toggle manually afterward.
  const detectBriefType = (ev) => {
    const contact = ev.matched_contact_id ? contacts.find((c) => c.id === ev.matched_contact_id) : null;
    const org = ev.matched_organization_id ? organizations.find((o) => o.id === ev.matched_organization_id) : null;
    const matchedExternal = !!ev.matched_deal_id || !!ev.matched_enabler_id || (!!org && !org.is_internal) || (!!contact && !contact.is_internal);
    if (matchedExternal) return "external";
    if (isInternalMeeting(ev, contacts)) return "internal";
    return "external";
  };

  const generateBrief = async ({ meeting_title, meeting_date, contact_id, deal_id, enabler_id, organization_id, existingId = null, brief_type = "external" }) => {
    if (briefGenerating) return;
    const contact = contact_id ? contacts.find((c) => c.id === contact_id) : null;
    const deal = deal_id ? deals.find((d) => d.id === deal_id) : null;
    const enabler = enabler_id ? enablers.find((e) => e.id === enabler_id) : null;
    const org = organization_id ? organizations.find((o) => o.id === organization_id) : null;
    setBriefGenerating(meeting_title || "meeting");
    try {
      const content = brief_type === "internal"
        ? await generateInternalBrief(meeting_title || "Meeting", gatherInternalBriefContext())
        : await generateMeetingBrief(gatherBriefContext({ contact, deal, enabler, org }));
      if (existingId) {
        await api("meeting_briefs", "PATCH", { brief_content: content, brief_type }, `?id=eq.${existingId}`);
        setMeetingBriefs((prev) => prev.map((b) => (b.id === existingId ? { ...b, brief_content: content, brief_type } : b)));
        setBriefViewId(existingId);
      } else {
        const clean = { meeting_title: meeting_title || "Meeting", brief_content: content, brief_type };
        if (meeting_date) clean.meeting_date = meeting_date;
        if (contact_id) clean.contact_id = contact_id;
        if (deal_id) clean.deal_id = deal_id;
        if (enabler_id) clean.enabler_id = enabler_id;
        if (organization_id) clean.organization_id = organization_id;
        const rows = await api("meeting_briefs", "POST", clean);
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (row) { setMeetingBriefs((prev) => [row, ...prev]); setBriefViewId(row.id); }
      }
    } catch (e) { showToast(`Error generating brief: ${e.message || "unknown error"}`); }
    setBriefGenerating(null);
  };

  // Manual override (Section 3): regenerate the currently-viewed brief as the
  // other type, in case auto-detection guessed wrong.
  const switchBriefType = (brief) => {
    generateBrief({ meeting_title: brief.meeting_title, meeting_date: brief.meeting_date, contact_id: brief.contact_id, deal_id: brief.deal_id, enabler_id: brief.enabler_id, organization_id: brief.organization_id, existingId: brief.id, brief_type: brief.brief_type === "internal" ? "external" : "internal" });
  };

  // "Prep Brief" from a Today's Agenda meeting: reuse an existing brief for the
  // same title on the same day instead of regenerating.
  const prepBriefForMeeting = (a) => {
    const title = firstLine(cleanActivityText(a.description)) || "Meeting";
    const existing = meetingBriefs.find((b) => b.meeting_title === title && b.meeting_date && new Date(b.meeting_date).toDateString() === new Date(a.created_at).toDateString());
    if (existing) { setBriefViewId(existing.id); return; }
    generateBrief({ meeting_title: title, meeting_date: a.created_at, contact_id: a.contact_id, deal_id: a.deal_id, enabler_id: a.enabler_id, organization_id: a.organization_id });
  };

  // "Prep Brief" from a calendar event: reuse an existing brief with the same
  // title on the same day, else generate one from the event's matched entity
  // (or a status roll-up if detectBriefType decides this is an internal sync).
  const prepBriefForEvent = (ev) => {
    const title = ev.title || "Meeting";
    const day = ev.start_time ? new Date(ev.start_time).toDateString() : null;
    const existing = meetingBriefs.find((b) => b.meeting_title === title && b.meeting_date && new Date(b.meeting_date).toDateString() === day);
    if (existing) { setBriefViewId(existing.id); return; }
    generateBrief({ meeting_title: title, meeting_date: ev.start_time, contact_id: ev.matched_contact_id, deal_id: ev.matched_deal_id, enabler_id: ev.matched_enabler_id, organization_id: ev.matched_organization_id, brief_type: detectBriefType(ev) });
  };

  // Manually associate an unmatched calendar event with a contact or institution.
  // `pick` is { type: "contact"|"deal"|"enabler"|"organization", id }. Clears the
  // other matched_* columns so an event links to exactly one entity at a time.
  const linkCalendarEvent = async (eventId, pick) => {
    const patch = { matched_contact_id: null, matched_deal_id: null, matched_enabler_id: null, matched_organization_id: null };
    if (pick) patch[`matched_${pick.type}_id`] = pick.id;
    try {
      await api("calendar_events", "PATCH", patch, `?id=eq.${eventId}`);
      setCalendarEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, ...patch } : e)));
      savedToast();
    } catch { showToast("Error linking event"); }
  };

  // CALENDAR EVENT WORKING OBJECTS: tagging, prep notes, prep briefs, and
  // outcome logging. event_institutions/event_contacts are annotation tables
  // separate from the synced calendar_events row, so the hourly Google
  // Calendar sync never touches them.
  const openCalendarEventDetail = (id) => setEventDetailId(id);
  const closeCalendarEventDetail = () => setEventDetailId(null);

  // pick: { type: "deal"|"enabler"|"organization", id }. One row per tag, like
  // material_links: exactly one of the three FKs is set.
  const tagEventInstitution = async (eventId, pick) => {
    const already = eventInstitutions.some((r) => r.calendar_event_id === eventId && r[`${pick.type}_id`] === pick.id);
    if (already) return;
    try {
      const clean = { calendar_event_id: eventId, [`${pick.type}_id`]: pick.id };
      const rows = await api("event_institutions", "POST", clean);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setEventInstitutions((prev) => [...prev, row]);
    } catch (e) {
      if (e?.status !== 409) showToast("Error tagging institution");
    }
  };
  const untagEventInstitution = async (id) => {
    try {
      await api("event_institutions", "DELETE", null, `?id=eq.${id}`);
      setEventInstitutions((prev) => prev.filter((r) => r.id !== id));
    } catch { showToast("Error removing tag"); }
  };
  const tagEventPerson = async (eventId, contactId) => {
    if (eventContacts.some((r) => r.calendar_event_id === eventId && r.contact_id === contactId)) return;
    try {
      const rows = await api("event_contacts", "POST", { calendar_event_id: eventId, contact_id: contactId });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setEventContacts((prev) => [...prev, row]);
    } catch (e) {
      if (e?.status !== 409) showToast("Error tagging person");
    }
  };
  const untagEventPerson = async (id) => {
    try {
      await api("event_contacts", "DELETE", null, `?id=eq.${id}`);
      setEventContacts((prev) => prev.filter((r) => r.id !== id));
    } catch { showToast("Error removing tag"); }
  };
  const saveEventPrepNotes = async (eventId, text) => {
    try {
      await api("calendar_events", "PATCH", { prep_notes: text || null }, `?id=eq.${eventId}`);
      setCalendarEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, prep_notes: text || null } : e)));
    } catch { showToast("Error saving prep notes"); }
  };
  const saveEventOutcomeNotes = async (eventId, text) => {
    try {
      await api("calendar_events", "PATCH", { outcome_notes: text || null }, `?id=eq.${eventId}`);
      setCalendarEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, outcome_notes: text || null } : e)));
    } catch { showToast("Error saving outcome notes"); }
  };

  // Brief context built from an event's TAGGED institutions and people (which
  // may differ from the auto-matched attendee), so the brief is accurate even
  // for a meeting about entities not on the calendar invite (Section 5).
  const gatherBriefContextForEntities = (taggedContacts, taggedInstEntities) => {
    const lines = [];
    const actLine = (a) => `[${formatDate(a.created_at)}] ${a.type}: ${firstLine(cleanActivityText(a.description))}`;
    taggedContacts.forEach((contact) => {
      lines.push(`PERSON: ${contact.name}${contact.role ? `, ${contact.role}` : ""}${contact.company ? ` at ${contact.company}` : ""}`);
      lines.push(`Warmth: ${contact.warmth || "unknown"}. Last contacted: ${contact.last_contacted_at ? formatDate(contact.last_contacted_at) : "never logged"}.`);
      const roles = resolveContactRoles(contact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
      if (roles.length) lines.push(`Roles: ${roles.map((r) => `${r.role_title ? `${r.role_title} at ` : ""}${r.institutionName}`).join("; ")}`);
      if (contact.notes) lines.push(`Notes on this person: ${contact.notes}`);
      if (contact.ai_summary) lines.push(`Person summary: ${contact.ai_summary}`);
      const acts = activities.filter((a) => a.contact_id === contact.id).slice(0, 8);
      if (acts.length) lines.push(`Last interactions with ${contact.name}:\n${acts.map(actLine).join("\n")}`);
    });
    taggedInstEntities.forEach(({ deal, enabler, org }) => {
      const entity = deal || enabler || org;
      const eName = deal ? deal.company : entity.name;
      lines.push(`INSTITUTION/DEAL: ${eName}${deal ? ` (pipeline stage: ${deal.stage}${deal.tier ? `, ${deal.tier}` : ""})` : ""}`);
      if (entity.ai_summary) lines.push(`Institution summary: ${entity.ai_summary}`);
      if (entity.notes) lines.push(`Institution notes: ${entity.notes}`);
      const acts = activities.filter((a) => (deal && a.deal_id === deal.id) || (enabler && a.enabler_id === enabler.id) || (org && a.organization_id === org.id)).slice(0, 8);
      if (acts.length) lines.push(`Recent activity on ${eName}:\n${acts.map(actLine).join("\n")}`);
    });
    const openTasks = todos.filter((t) => t.status === "open" && (
      taggedContacts.some((c) => t.contact_id === c.id) ||
      taggedInstEntities.some(({ deal, enabler, org }) => (deal && t.deal_id === deal.id) || (enabler && t.enabler_id === enabler.id) || (org && t.organization_id === org.id))));
    if (openTasks.length) lines.push(`Open tasks:\n${openTasks.map((t) => `- ${t.title}${t.due_date ? ` (due ${formatDate(t.due_date)})` : ""} [${t.priority}]`).join("\n")}`);
    return lines.join("\n\n") || "No history on file yet.";
  };

  // "Generate Prep Brief" from the event detail panel: uses the TAGGED
  // institutions/people, falling back to the auto-matched attendee when
  // nothing has been tagged yet (Section 5).
  const generateEventBrief = (ev) => {
    if (briefGenerating) return;
    const title = ev.title || "Meeting";
    const day = ev.start_time ? new Date(ev.start_time).toDateString() : null;
    const existing = meetingBriefs.find((b) => b.meeting_title === title && b.meeting_date && new Date(b.meeting_date).toDateString() === day);
    if (existing) { setBriefViewId(existing.id); return; }
    const taggedContactIds = eventContacts.filter((r) => r.calendar_event_id === ev.id).map((r) => r.contact_id);
    const taggedInstRows = eventInstitutions.filter((r) => r.calendar_event_id === ev.id);
    if (taggedContactIds.length === 0 && taggedInstRows.length === 0) {
      generateBrief({ meeting_title: title, meeting_date: ev.start_time, contact_id: ev.matched_contact_id, deal_id: ev.matched_deal_id, enabler_id: ev.matched_enabler_id, organization_id: ev.matched_organization_id, brief_type: detectBriefType(ev) });
      return;
    }
    const briefType = detectBriefType(ev);
    setBriefGenerating(title);
    (async () => {
      try {
        let content;
        if (briefType === "internal") {
          content = await generateInternalBrief(title, gatherInternalBriefContext());
        } else {
          const taggedContactObjs = taggedContactIds.map((id) => contacts.find((c) => c.id === id)).filter(Boolean);
          const taggedInstObjs = taggedInstRows.map((r) => ({
            deal: r.deal_id ? deals.find((d) => d.id === r.deal_id) : null,
            enabler: r.enabler_id ? enablers.find((e) => e.id === r.enabler_id) : null,
            org: r.organization_id ? organizations.find((o) => o.id === r.organization_id) : null,
          })).filter((x) => x.deal || x.enabler || x.org);
          content = await generateMeetingBrief(gatherBriefContextForEntities(taggedContactObjs, taggedInstObjs));
        }
        const first = taggedInstRows[0];
        const clean = {
          meeting_title: title, brief_content: content, brief_type: briefType, meeting_date: ev.start_time,
          contact_id: taggedContactIds[0] || ev.matched_contact_id || null,
          deal_id: first?.deal_id || ev.matched_deal_id || null,
          enabler_id: first?.enabler_id || ev.matched_enabler_id || null,
          organization_id: first?.organization_id || ev.matched_organization_id || null,
        };
        const rows = await api("meeting_briefs", "POST", clean);
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (row) { setMeetingBriefs((prev) => [row, ...prev]); setBriefViewId(row.id); }
      } catch (e) { showToast(`Error generating brief: ${e.message || "unknown error"}`); }
      setBriefGenerating(null);
    })();
  };

  // Builds the description for a logged outcome, prefixed with a marker (like
  // the Fathom recap marker) carrying the event id so the timeline can link
  // back to the calendar event (Section 9) without a new activities column.
  // Plain, user-facing text only. The link back to the calendar event lives in
  // the activities.calendar_event_id column, never in the description: an
  // internal marker embedded here leaked into the timeline, and matching on
  // text broke the moment the user edited it.
  const buildOutcomeDescription = (ev, text) => `Meeting:\n${ev.title || "Meeting"}\n\nOutcome:\n${text.trim()}`;

  // Identity of one outcome activity: the person it is logged against (or
  // none, for a direct institution row) plus the institution FK it carries.
  // Re-logging matches existing rows on this key so an edited outcome updates
  // the same rows instead of creating a second set.
  const outcomeRowKey = (r) => `${r.contact_id || "-"}|${r.deal_id || "-"}|${r.enabler_id || "-"}|${r.organization_id || "-"}`;

  // "Log Outcome" (Section 6): one activity per tagged person (with their
  // resolved primary institution, same rule addActivity already uses), plus
  // one direct activity for any tagged institution not already reached through
  // a tagged person. This is what dedupes the same meeting rather than writing
  // one row per (person x institution) pair.
  //
  // Re-logging an EDITED outcome updates in place (Section 1): every row this
  // event has already produced is found by activities.calendar_event_id and
  // reconciled against the currently tagged entities. Rows that still apply
  // are PATCHed to the new text, newly tagged entities get a new row, and rows
  // for entities that have since been untagged are removed. Nothing is ever
  // duplicated, so the user can keep editing the outcome and re-logging.
  const logEventOutcome = async (ev, outcomeText) => {
    const text = (outcomeText || "").trim();
    if (!text) { showToast("Outcome is empty"); return null; }
    if (loggingOutcomeRef.current) return null;
    loggingOutcomeRef.current = true;
    const description = buildOutcomeDescription(ev, text);
    // Re-read this event's rows from the DATABASE rather than trusting React
    // state. Local state can be stale (another tab, a sync, a failed patch, a
    // reload mid-session), and trusting it is what allowed a second set of
    // rows to be inserted. The database is the only reliable answer to "what
    // has this event already produced?".
    let existingRows = [];
    try {
      existingRows = (await api("activities", "GET", null, `?calendar_event_id=eq.${ev.id}&select=*`)) || [];
    } catch {
      loggingOutcomeRef.current = false;
      showToast("Could not check existing outcome. Try again.");
      return null;
    }
    const taggedContacts = eventContacts.filter((r) => r.calendar_event_id === ev.id).map((r) => contacts.find((c) => c.id === r.contact_id)).filter(Boolean);
    const taggedInstRows = eventInstitutions.filter((r) => r.calendar_event_id === ev.id);
    const createdAt = ev.start_time || new Date().toISOString();
    const now = new Date().toISOString();
    const newRows = [];
    const updatedIds = [];
    const touchedDealIds = new Set(), touchedEnablerIds = new Set(), touchedContactIds = new Set();
    const coveredInstKeys = new Set();
    // Existing rows for this event, indexed by identity so each desired row
    // either updates its match or inserts fresh.
    const existingByKey = new Map(existingRows.map((a) => [outcomeRowKey(a), a]));
    const keepKeys = new Set();

    // Writes one desired outcome row: PATCH when this event already produced a
    // row for the same person/institution, POST otherwise. A duplicate is also
    // blocked by uniq_activity_per_calendar_event in the database, so if a POST
    // ever races another writer it comes back 409 and is turned into an update
    // of the row that won. Between the pre-read, the key match and the
    // constraint, there is no path that leaves two rows for the same pairing.
    const upsertOutcomeRow = async (fields) => {
      const key = outcomeRowKey(fields);
      keepKeys.add(key);
      const existing = existingByKey.get(key);
      if (existing) {
        if (existing.description === description && existing.created_at === createdAt) return;
        await api("activities", "PATCH", { description, created_at: createdAt }, `?id=eq.${existing.id}`);
        updatedIds.push(existing.id);
        return;
      }
      try {
        const rows = await api("activities", "POST", { type: "meeting", description, created_at: createdAt, calendar_event_id: ev.id, ...fields });
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (row) newRows.push(row);
      } catch (e) {
        if (e?.status !== 409) throw e;
        // The constraint caught a row we did not know about: update it instead.
        const q = ["contact_id", "deal_id", "enabler_id", "organization_id"]
          .map((c) => `${c}=${fields[c] ? `eq.${fields[c]}` : "is.null"}`).join("&");
        const found = (await api("activities", "GET", null, `?calendar_event_id=eq.${ev.id}&${q}&select=id`)) || [];
        if (found[0]) {
          await api("activities", "PATCH", { description, created_at: createdAt }, `?id=eq.${found[0].id}`);
          updatedIds.push(found[0].id);
        }
      }
    };

    try {
      for (const contact of taggedContacts) {
        const roles = resolveContactRoles(contact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
        const primary = roles.find((r) => r.is_primary) || roles[0];
        const fk = { deal_id: null, enabler_id: null, organization_id: null };
        if (primary?.entity_type === "deal") { fk.deal_id = primary.entity_id; coveredInstKeys.add(`deal:${primary.entity_id}`); }
        else if (primary?.entity_type === "enabler") { fk.enabler_id = primary.entity_id; coveredInstKeys.add(`enabler:${primary.entity_id}`); }
        else if (primary?.entity_type === "organization") { fk.organization_id = primary.entity_id; coveredInstKeys.add(`organization:${primary.entity_id}`); }
        await upsertOutcomeRow({ contact_id: contact.id, ...fk });
        if (fk.deal_id) touchedDealIds.add(fk.deal_id);
        if (fk.enabler_id) touchedEnablerIds.add(fk.enabler_id);
        touchedContactIds.add(contact.id);
      }
      for (const r of taggedInstRows) {
        const key = r.deal_id ? `deal:${r.deal_id}` : r.enabler_id ? `enabler:${r.enabler_id}` : r.organization_id ? `organization:${r.organization_id}` : null;
        if (!key || coveredInstKeys.has(key)) continue;
        const fk = { deal_id: r.deal_id || null, enabler_id: r.enabler_id || null, organization_id: r.organization_id || null };
        await upsertOutcomeRow({ contact_id: null, ...fk });
        if (fk.deal_id) touchedDealIds.add(fk.deal_id);
        if (fk.enabler_id) touchedEnablerIds.add(fk.enabler_id);
      }

      // Entities untagged since the last log: drop their now-orphaned rows so
      // the outcome does not linger on a timeline it no longer belongs to.
      const staleRows = existingRows.filter((a) => !keepKeys.has(outcomeRowKey(a)));
      for (const a of staleRows) await api("activities", "DELETE", null, `?id=eq.${a.id}`);
      const staleIds = new Set(staleRows.map((a) => a.id));

      // Rebuild local state for this event from the definitive set of rows,
      // rather than patching around the edges: drop every row currently held
      // for this event and re-add exactly the ones that now exist. This keeps
      // the UI honest even if local state had drifted before the write.
      const updated = new Set(updatedIds);
      const finalRows = [
        ...newRows,
        ...existingRows
          .filter((a) => !staleIds.has(a.id))
          .map((a) => (updated.has(a.id) ? { ...a, description, created_at: createdAt } : a)),
      ];
      setActivities((prev) => {
        const others = prev.filter((a) => activityCalendarEventId(a) !== ev.id);
        return [...finalRows, ...others].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      });
      if (touchedDealIds.size) { await Promise.all([...touchedDealIds].map((id) => api("deals", "PATCH", { last_activity_at: now }, `?id=eq.${id}`))); setDeals((prev) => prev.map((d) => (touchedDealIds.has(d.id) ? { ...d, last_activity_at: now } : d))); }
      if (touchedEnablerIds.size) { await Promise.all([...touchedEnablerIds].map((id) => api("enablers", "PATCH", { last_activity_at: now }, `?id=eq.${id}`))); setEnablers((prev) => prev.map((e) => (touchedEnablerIds.has(e.id) ? { ...e, last_activity_at: now } : e))); }
      if (touchedContactIds.size) { await Promise.all([...touchedContactIds].map((id) => api("contacts", "PATCH", { last_contacted_at: now }, `?id=eq.${id}`))); setContacts((prev) => prev.map((c) => (touchedContactIds.has(c.id) ? { ...c, last_contacted_at: now } : c))); }

      await saveEventOutcomeNotes(ev.id, text);
      const peopleCount = taggedContacts.length;
      const instCount = new Set(taggedInstRows.map((r) => (r.deal_id ? `deal:${r.deal_id}` : r.enabler_id ? `enabler:${r.enabler_id}` : r.organization_id ? `organization:${r.organization_id}` : null)).filter(Boolean)).size;
      // An edit says "updated" rather than "logged", so it is obvious the
      // existing entries changed instead of a second set being created.
      const verb = existingRows.length ? "updated on" : "logged to";
      showToast(`Outcome ${verb} ${peopleCount} ${peopleCount === 1 ? "person" : "people"} and ${instCount} ${instCount === 1 ? "institution" : "institutions"}.`);
      return { peopleCount, instCount, updated: existingRows.length > 0 };
    } catch (e) {
      console.error("[Outcome] log failed", e);
      showToast("Error logging outcome");
      return null;
    } finally { loggingOutcomeRef.current = false; }
  };

  // "Extract tasks from outcome" (Section 6): reuses the voice-note digest
  // prompt (it already returns {summary, action_items}) on typed outcome text,
  // then creates one todo per action item, linked to every tagged person and
  // the first tagged institution (a todo only carries one institution FK).
  /* ============================================================
     Executive Update: the curated biweekly deck (see CLAUDE.md).
     The system drafts it; Fahed owns every block from there on.
     ============================================================ */

  const execBlocksFor = (presentationId) => execBlocks
    .filter((b) => b.presentation_id === presentationId)
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const touchPresentation = async (id) => {
    const now = new Date().toISOString();
    // No updated_at trigger on this table, so every write stamps it by hand
    // (same as notes and materials).
    await api("exec_presentations", "PATCH", { updated_at: now }, `?id=eq.${id}`).catch(() => {});
    setExecPresentations((prev) => prev.map((p) => (p.id === id ? { ...p, updated_at: now } : p)));
  };

  // Gathers the raw two-week window and shapes it for the model. Deliberately
  // compact: names, stages, and one-line summaries, not full descriptions, so
  // the 800-token budget goes to synthesis rather than reading a log.
  const gatherExecContext = (startISO, endISO) => {
    const inRange = (d) => d && d >= startISO && d <= endISO;
    const acts = activities.filter((a) => inRange(a.created_at));
    const transitions = buildStageTransitions(activities, deals).filter((t) => inRange(t.date));
    const newDeals = deals.filter((d) => inRange(d.created_at));
    const newContacts = contacts.filter((c) => inRange(c.created_at));
    const newOrgs = organizations.filter((o) => inRange(o.created_at));
    const meetings = acts.filter((a) => ["meeting", "call", "demo"].includes(a.type));
    const nextEnd = new Date(new Date(endISO).getTime() + 14 * 86400000).toISOString();
    const upcoming = calendarEvents.filter((e) => e.start_time > endISO && e.start_time <= nextEnd);
    const nameFor = (a) => {
      const inst = activityInstitutionInfo(a, { deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles });
      const person = activityPersonInfo(a, contacts);
      return [inst?.name, person?.name].filter(Boolean).join(" / ") || "General";
    };
    const lines = [];
    lines.push(`PERIOD: ${formatDate(startISO)} to ${formatDate(endISO)}`);
    lines.push(`\nSTAGE CHANGES (${transitions.length}):`);
    transitions.forEach((t) => lines.push(`- ${t.company}${t.tier && t.tier !== "Untiered" ? ` (${t.tier})` : ""}: ${stageLabel(t.fromStage)} to ${stageLabel(t.toStage)}`));
    lines.push(`\nNEW DEALS (${newDeals.length}):`);
    newDeals.forEach((d) => lines.push(`- ${d.company}, stage ${stageLabel(d.stage)}${d.value ? `, value ${d.value}` : ""}`));
    lines.push(`\nMEETINGS AND CALLS (${meetings.length}):`);
    meetings.slice(0, 40).forEach((a) => lines.push(`- [${formatDate(a.created_at)}] ${nameFor(a)}: ${firstLine(cleanActivityText(a.description))}`));
    lines.push(`\nOTHER ACTIVITY (${acts.length - meetings.length}):`);
    acts.filter((a) => !meetings.includes(a)).slice(0, 30).forEach((a) => lines.push(`- ${a.type} with ${nameFor(a)}: ${firstLine(cleanActivityText(a.description))}`));
    lines.push(`\nNEW PEOPLE (${newContacts.length}):`);
    newContacts.forEach((c) => lines.push(`- ${c.name}${c.role ? `, ${c.role}` : ""}${c.company ? ` at ${c.company}` : ""}${c.warmth ? `, warmth ${c.warmth}` : ""}`));
    lines.push(`\nNEW INSTITUTIONS (${newOrgs.length}):`);
    newOrgs.forEach((o) => lines.push(`- ${o.name}${o.type ? `, ${o.type}` : ""}${o.city ? `, ${o.city}` : ""}`));
    const wonOrContracted = deals.filter((d) => ["won", "contracted"].includes(d.stage) && inRange(d.last_activity_at));
    lines.push(`\nWON OR CONTRACTED (${wonOrContracted.length}):`);
    wonOrContracted.forEach((d) => lines.push(`- ${d.company}, ${stageLabel(d.stage)}${d.value ? `, value ${d.value}` : ""}`));
    lines.push(`\nUPCOMING NEXT TWO WEEKS (${upcoming.length}):`);
    upcoming.slice(0, 20).forEach((e) => lines.push(`- ${formatDate(e.start_time)}: ${e.title}`));
    return lines.join("\n");
  };

  // The metric blocks are computed, never AI-written: numbers must be exact.
  const execMetrics = (startISO, endISO) => {
    const inRange = (d) => d && d >= startISO && d <= endISO;
    const acts = activities.filter((a) => inRange(a.created_at));
    const instKeys = new Set();
    acts.forEach((a) => {
      const inst = activityInstitutionInfo(a, { deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles });
      if (inst?.name) instKeys.add(inst.name);
    });
    return [
      { title: "Institutions engaged", content: String(instKeys.size) },
      { title: "Meetings held", content: String(acts.filter((a) => ["meeting", "call", "demo"].includes(a.type)).length) },
      { title: "New relationships", content: String(contacts.filter((c) => inRange(c.created_at)).length) },
      { title: "Deals advanced", content: String(buildStageTransitions(activities, deals).filter((t) => inRange(t.date)).length) },
      { title: "Outreach sent", content: String(acts.filter((a) => ["email", "linkedin", "whatsapp"].includes(a.type)).length) },
    ];
  };

  // "+ New Biweekly Update": creates the presentation, then drafts its blocks.
  // Metrics are computed locally and the narrative sections come from one AI
  // synthesis pass. If the AI call fails the presentation is still created with
  // its metrics, so the user always has something to edit rather than nothing.
  const createExecPresentation = async () => {
    if (execGenerating) return;
    setExecGenerating(true);
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 86400000);
    const endDate = end.toISOString().slice(0, 10);
    const startDate = start.toISOString().slice(0, 10);
    try {
      const rows = await api("exec_presentations", "POST", {
        title: `Executive Update, ${formatDate(start)} to ${formatDate(end)}`,
        period_start: startDate, period_end: endDate, status: "draft",
      });
      const pres = Array.isArray(rows) ? rows[0] : rows;
      if (!pres) throw new Error("no presentation row");
      setExecPresentations((prev) => [pres, ...prev]);
      setExecOpenId(pres.id);
      navigateTab("exec");

      const startISO = start.toISOString(), endISO = end.toISOString();
      const blocks = [];
      let order = 0;
      const push = (b) => { blocks.push({ presentation_id: pres.id, sort_order: order++, is_hidden: false, ...b }); };

      push({ block_type: "header", section: "metrics", title: "Headline Metrics", content: null });
      execMetrics(startISO, endISO).forEach((m) => push({ block_type: "metric", section: "metrics", title: m.title, content: m.content }));

      let ai = null;
      try { ai = await generateExecSummary(gatherExecContext(startISO, endISO)); }
      catch (e) { console.error("[Exec] AI draft failed", e); }

      EXEC_SECTIONS.filter((s) => s.id !== "metrics").forEach((sec) => {
        const items = Array.isArray(ai?.[sec.aiKey]) ? ai[sec.aiKey] : [];
        if (!items.length) return;
        push({ block_type: "header", section: sec.id, title: sec.label, content: null });
        items.forEach((it) => push({
          block_type: "item", section: sec.id,
          title: (it.title || "").trim() || null,
          content: (it.content || "").trim() || null,
        }));
      });

      const created = await api("exec_blocks", "POST", blocks);
      setExecBlocks((prev) => [...prev, ...(created || [])]);
      showToast(ai ? "Draft ready. Edit anything before you present." : "Created with metrics. AI draft unavailable, add items manually.");
    } catch (e) {
      console.error("[Exec] create failed", e);
      showToast("Could not create the update. Please try again.");
    } finally { setExecGenerating(false); }
  };

  const updateExecPresentation = async (id, patch) => {
    try {
      const now = new Date().toISOString();
      const body = { ...patch, updated_at: now };
      await api("exec_presentations", "PATCH", body, `?id=eq.${id}`);
      setExecPresentations((prev) => prev.map((p) => (p.id === id ? { ...p, ...body } : p)));
      savedToast();
    } catch { showToast("Could not save. Please try again."); }
  };

  const deleteExecPresentation = async (id) => {
    try {
      // No guaranteed ON DELETE CASCADE, so blocks go first (same convention
      // as every other delete in this app).
      await api("exec_blocks", "DELETE", null, `?presentation_id=eq.${id}`);
      await api("exec_presentations", "DELETE", null, `?id=eq.${id}`);
      setExecBlocks((prev) => prev.filter((b) => b.presentation_id !== id));
      setExecPresentations((prev) => prev.filter((p) => p.id !== id));
      setExecOpenId((cur) => (cur === id ? null : cur));
      showToast("Update deleted");
    } catch { showToast("Could not delete. Please try again."); }
  };

  const addExecBlock = async (presentationId, fields) => {
    try {
      const siblings = execBlocksFor(presentationId);
      const sort_order = siblings.length ? Math.max(...siblings.map((b) => b.sort_order ?? 0)) + 1 : 0;
      const rows = await api("exec_blocks", "POST", { presentation_id: presentationId, sort_order, is_hidden: false, ...fields });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setExecBlocks((prev) => [...prev, row]);
      await touchPresentation(presentationId);
      return true;
    } catch { showToast("Could not add block. Please try again."); return false; }
  };

  const updateExecBlock = async (id, patch) => {
    try {
      await api("exec_blocks", "PATCH", patch, `?id=eq.${id}`);
      setExecBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
      const block = execBlocks.find((b) => b.id === id);
      if (block) await touchPresentation(block.presentation_id);
      return true;
    } catch { showToast("Could not save block. Please try again."); return false; }
  };

  const deleteExecBlock = async (id) => {
    try {
      const block = execBlocks.find((b) => b.id === id);
      await api("exec_blocks", "DELETE", null, `?id=eq.${id}`);
      setExecBlocks((prev) => prev.filter((b) => b.id !== id));
      if (block) await touchPresentation(block.presentation_id);
      return true;
    } catch { showToast("Could not delete block. Please try again."); return false; }
  };

  // Drag reorder: renumbers the whole presentation so sort_order stays dense
  // and predictable, rather than juggling fractional positions.
  const reorderExecBlocks = async (presentationId, orderedIds) => {
    const next = orderedIds.map((id, i) => ({ id, sort_order: i }));
    setExecBlocks((prev) => prev.map((b) => {
      const hit = next.find((n) => n.id === b.id);
      return hit ? { ...b, sort_order: hit.sort_order } : b;
    }));
    try {
      await Promise.all(next.map((n) => api("exec_blocks", "PATCH", { sort_order: n.sort_order }, `?id=eq.${n.id}`)));
      await touchPresentation(presentationId);
    } catch { showToast("Could not save the new order."); }
  };

  const extractTasksFromOutcome = async (ev, outcomeText) => {
    const text = (outcomeText || "").trim();
    if (!text) { showToast("Outcome is empty"); return; }
    try {
      const { action_items } = await digestVoiceNote(text);
      const items = (action_items || []).filter((a) => (a.title || "").trim());
      if (!items.length) { showToast("No action items found"); return; }
      const taggedContactIds = eventContacts.filter((r) => r.calendar_event_id === ev.id).map((r) => r.contact_id);
      const firstInst = eventInstitutions.find((r) => r.calendar_event_id === ev.id);
      for (const item of items) {
        const hint = (item.due_date_hint || "").trim();
        const due = parseDueHint(hint);
        const title = (!due && hint) ? `${item.title.trim()} (${hint})` : item.title.trim();
        await saveTodo({
          title, priority: ["high", "medium", "low"].includes(item.priority) ? item.priority : "medium", due_date: due || undefined,
          contact_ids: taggedContactIds,
          deal_id: firstInst?.deal_id || null, enabler_id: firstInst?.enabler_id || null, organization_id: firstInst?.organization_id || null,
        });
      }
      showToast(`${items.length} task${items.length === 1 ? "" : "s"} created`);
    } catch { showToast("Error extracting tasks"); }
  };

  const updateBriefGoal = async (id, goal) => {
    try {
      await api("meeting_briefs", "PATCH", { my_goal: goal || null }, `?id=eq.${id}`);
      setMeetingBriefs((prev) => prev.map((b) => (b.id === id ? { ...b, my_goal: goal } : b)));
      savedToast();
    } catch { showToast("Error saving goal"); }
  };

  const deleteBrief = async (id) => {
    try {
      await api("meeting_briefs", "DELETE", null, `?id=eq.${id}`);
      setMeetingBriefs((prev) => prev.filter((b) => b.id !== id));
      setBriefViewId((cur) => (cur === id ? null : cur));
      showToast("Brief deleted");
    } catch { showToast("Error deleting brief"); }
  };

  // OUTREACH ENGINE.
  // Seed the 5 starter templates exactly once when the table is empty (never
  // from Boss View, which must not write).
  const seededTemplatesRef = useRef(false);
  useEffect(() => {
    if (loading || bossMode || emailTemplates.length > 0 || seededTemplatesRef.current) return;
    seededTemplatesRef.current = true;
    (async () => {
      try {
        const rows = await api("email_templates", "POST", STARTER_TEMPLATES);
        setEmailTemplates(Array.isArray(rows) ? rows : []);
      } catch { showToast("Error seeding starter templates"); }
    })();
  }, [loading, bossMode, emailTemplates.length]);

  const saveTemplate = async (form, id = null) => {
    const clean = { name: (form.name || "").trim() || "Untitled Template", category: form.category || "custom", channel: form.channel || "email", subject: form.subject || "", body: form.body || "" };
    try {
      if (id) {
        const now = new Date().toISOString();
        await api("email_templates", "PATCH", { ...clean, updated_at: now }, `?id=eq.${id}`);
        setEmailTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, ...clean, updated_at: now } : t)));
      } else {
        const rows = await api("email_templates", "POST", clean);
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (row) setEmailTemplates((prev) => [...prev, row]);
      }
      savedToast();
    } catch { showToast("Error saving template"); }
  };
  const deleteTemplate = async (id) => {
    try {
      await api("email_templates", "DELETE", null, `?id=eq.${id}`);
      setEmailTemplates((prev) => prev.filter((t) => t.id !== id));
      showToast("Template deleted");
    } catch { showToast("Error deleting template"); }
  };

  // Manual status change (Follow-ups rows + People table). Moving INTO
  // awaiting_reply stamps the wait clock; other statuses leave timestamps as is.
  const setOutreachStatus = async (contactId, status) => {
    const patch = { outreach_status: status };
    if (status === "awaiting_reply") {
      const c = contacts.find((x) => x.id === contactId);
      if (!c || c.outreach_status !== "awaiting_reply") { patch.awaiting_reply_since = new Date().toISOString(); patch.last_outreach_at = patch.awaiting_reply_since; }
    }
    // Stamp a reply time so the "Recently Replied" group can age out (H6).
    if (status === "replied") patch.last_contacted_at = new Date().toISOString();
    try {
      await api("contacts", "PATCH", patch, `?id=eq.${contactId}`);
      setContacts((prev) => prev.map((c) => (c.id === contactId ? { ...c, ...patch } : c)));
    } catch { showToast("Error updating outreach status"); }
  };

  // After the channel's send action (Open in Gmail / Copy the LinkedIn or
  // WhatsApp message / log a call outcome): mark awaiting reply, stamp the
  // channel used, and log an activity of the matching type. For email the
  // "Sent outreach:" prefix is a contract reply detection depends on (it only
  // ever watches type "email"); other channels can never be auto-detected
  // (see the Follow-ups "Mark as replied" button instead).
  const recordOutreach = async (contact, { channel = "email", description, bodySnippet } = {}) => {
    const now = new Date().toISOString();
    try {
      const patch = { outreach_status: "awaiting_reply", last_outreach_at: now, awaiting_reply_since: now, last_contacted_at: now, outreach_channel: channel };
      await api("contacts", "PATCH", patch, `?id=eq.${contact.id}`);
      const activityBody = { type: outreachChannelMeta(channel).activityType, contact_id: contact.id, description };
      if (bodySnippet) activityBody.body_snippet = bodySnippet;
      const rows = await api("activities", "POST", activityBody);
      setContacts((prev) => prev.map((c) => (c.id === contact.id ? { ...c, ...patch } : c)));
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setActivities((prev) => [row, ...prev]);
      showToast("Outreach logged, awaiting reply");
    } catch { showToast("Error logging outreach"); }
  };

  // REPLY DETECTION: the Gmail sync logs received emails as type "email" with
  // the matched contact_id. Any such activity newer than awaiting_reply_since
  // (and not one of our own "Sent outreach:" rows) flips the contact to
  // "replied". Ref-guarded so each contact is only patched once per session.
  const replyCheckedRef = useRef(new Set());
  useEffect(() => {
    if (loading || bossMode) return;
    const repliers = contacts.map((c) => {
      if (!(c.outreach_status === "awaiting_reply" && c.awaiting_reply_since && !replyCheckedRef.current.has(c.id))) return null;
      const replyActs = activities.filter((a) => a.type === "email" && a.contact_id === c.id &&
        !(a.description || "").startsWith("Sent outreach:") &&
        new Date(a.created_at) > new Date(c.awaiting_reply_since));
      if (replyActs.length === 0) return null;
      // Latest reply time drives the Recently Replied recency window (H6).
      const repliedAt = replyActs.reduce((m, a) => (new Date(a.created_at) > new Date(m) ? a.created_at : m), replyActs[0].created_at);
      return { contact: c, repliedAt };
    }).filter(Boolean);
    if (repliers.length === 0) return;
    repliers.forEach((r) => replyCheckedRef.current.add(r.contact.id));
    (async () => {
      try {
        await Promise.all(repliers.map((r) => api("contacts", "PATCH", { outreach_status: "replied", last_contacted_at: r.repliedAt }, `?id=eq.${r.contact.id}`)));
        const byId = new Map(repliers.map((r) => [r.contact.id, r.repliedAt]));
        setContacts((prev) => prev.map((c) => (byId.has(c.id) ? { ...c, outreach_status: "replied", last_contacted_at: byId.get(c.id) } : c)));
        showToast(`${repliers.length} contact${repliers.length === 1 ? "" : "s"} replied to your outreach`);
      } catch { /* retried on next load */ }
    })();
  }, [loading, bossMode, contacts, activities]);

  // Task/link navigation. Deals open the Pipeline deal sheet; enablers are
  // institutions, so open by name in the Ecosystem institution sheet.
  const openTaskLink = (link) => {
    if (link.type === "deal") { const d = deals.find((x) => x.id === link.id); if (d) openInstitution(d.company); }
    else if (link.type === "enabler") { const en = enablers.find((e) => e.id === link.id); if (en) openInstitution(en.name); }
    else if (link.type === "organization") { const o = organizations.find((x) => x.id === link.id); if (o) openInstitution(o.name); }
    else if (link.type === "contact") { openPerson(link.id); }
  };

  // ACTIVITY
  const addActivity = async (dealId, contactId, activity, enablerId = null, organizationId = null) => {
    const now = new Date().toISOString();
    try {
      // Section 2: an activity saved with only a contact_id still belongs to
      // that person's institution. Resolve it from their primary role (via
      // contact_roles) and store it on the row, rather than leaving it to be
      // derived (or not) at display time.
      let fkDeal = dealId, fkEnabler = enablerId, fkOrg = organizationId;
      if (contactId && !fkDeal && !fkEnabler && !fkOrg) {
        const contact = contacts.find((c) => c.id === contactId);
        const roles = contact ? resolveContactRoles(contact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles }) : [];
        const primary = roles.find((r) => r.is_primary) || roles[0];
        if (primary?.entity_type === "deal") fkDeal = primary.entity_id;
        else if (primary?.entity_type === "enabler") fkEnabler = primary.entity_id;
        else if (primary?.entity_type === "organization") fkOrg = primary.entity_id;
      }

      // Section 5: guard against accidental double-taps / double-submits. Skip
      // creating a new row if an identical one (same type, description, and
      // contact) was logged in the last 2 minutes.
      const twoMinAgo = Date.now() - 2 * 60 * 1000;
      const isDuplicate = activities.some((a) =>
        a.type === activity.type &&
        (a.description || "") === (activity.description || "") &&
        (a.contact_id || null) === (contactId || null) &&
        new Date(a.created_at).getTime() > twoMinAgo);
      if (isDuplicate) { showToast("Similar activity just logged"); return; }

      const rows = await api("activities", "POST", { deal_id: fkDeal, contact_id: contactId, enabler_id: fkEnabler, organization_id: fkOrg, ...activity });
      if (fkDeal) await api("deals", "PATCH", { last_activity_at: now }, `?id=eq.${fkDeal}`);
      if (contactId) await api("contacts", "PATCH", { last_contacted_at: now }, `?id=eq.${contactId}`);
      if (fkEnabler) await api("enablers", "PATCH", { last_activity_at: now }, `?id=eq.${fkEnabler}`);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setActivities((prev) => [row, ...prev]);
      if (fkDeal) setDeals((prev) => prev.map((d) => (d.id === fkDeal ? { ...d, last_activity_at: now } : d)));
      if (contactId) setContacts((prev) => prev.map((c) => (c.id === contactId ? { ...c, last_contacted_at: now } : c)));
      if (fkEnabler) setEnablers((prev) => prev.map((e) => (e.id === fkEnabler ? { ...e, last_activity_at: now } : e)));
      setModal(null); showToast("Activity logged");
    } catch { showToast("Error logging activity"); }
  };

  // A stable fingerprint for an activity, used as the tombstone key when the
  // user deletes one. Deliberately generic (type + first line + calendar day)
  // rather than Fathom-specific: any sync, including a calendar sync this repo
  // does not own, can consult it before recreating a row, and the key stays
  // stable across runs because it holds no ids or timestamps-to-the-second.
  const syncDismissalKey = (activity) => {
    // Collapse the whole cleaned body to one line and take a generous prefix.
    // Using only the FIRST line is too weak: every logged outcome begins
    // "Meeting:", so distinct items would collide on one key and a single
    // delete could suppress unrelated rows.
    const text = cleanActivityText(activity.description || "").replace(/\s+/g, " ").trim().slice(0, 180);
    if (!text) return null;
    const day = (activity.created_at || "").slice(0, 10);
    const source = isFathomActivity(activity) ? "fathom" : (activity.type || "activity");
    return { source, sync_key: `${activity.type || "activity"}|${day}|${text}` };
  };

  // Records that the user deliberately removed a synced item, so the next sync
  // run does not helpfully recreate it. Every deleted activity gets a tombstone,
  // not just the ones we know a sync produced, since the cost is one small row
  // and the failure it prevents (a deleted item silently coming back) is the
  // kind users stop trusting the app over.
  const recordSyncDismissal = async (activity) => {
    const key = syncDismissalKey(activity);
    if (!key) return;
    // A repeat dismissal is a no-op: sync_key is unique, so a 409 just means
    // it was already recorded.
    await api("sync_dismissals", "POST", key).catch((e) => { if (e?.status !== 409) throw e; });
  };

  // Inline timeline edit: PATCH the existing row (never an insert) and patch
  // local state, per the targeted-updates convention. The Fathom marker is
  // re-applied because the Apps Script still writes it and uses it to
  // recognize its own rows; the calendar-event link needs no marker at all now
  // that it lives in the calendar_event_id column.
  const updateActivity = async (activity, patch) => {
    if (savingActivityId) return false;
    setSavingActivityId(activity.id);
    try {
      const original = activity.description || "";
      const description = isFathomActivity(activity) ? `${FATHOM_MARKER} ${patch.description}` : patch.description;
      const body = { ...patch, description };
      await api("activities", "PATCH", body, `?id=eq.${activity.id}`);
      setActivities((prev) => prev.map((a) => (a.id === activity.id ? { ...a, ...body } : a)));
      // A sync may dedupe on the description the user just changed, so record
      // the ORIGINAL fingerprint as dismissed; otherwise the next run would see
      // its row as missing and add it back alongside the edited one.
      if (description !== original) await recordSyncDismissal(activity).catch((e) => console.warn("[Activity] dismissal record failed", e));
      savedToast();
      return true;
    } catch (e) {
      console.error("[Activity] save failed", e);
      showToast("Could not save activity. Please try again.");
      return false;
    }
    finally { setSavingActivityId(null); }
  };

  // Deleting an activity never touches the calendar event it came from: only
  // the activities row goes, and calendar_event_id is just a reference on it.
  // The dismissal record is written FIRST and independently, so a sync cannot
  // recreate the row even if the delete itself later fails.
  const deleteActivity = async (activity) => {
    try {
      await recordSyncDismissal(activity).catch((e) => console.warn("[Activity] dismissal record failed", e));
      await api("activities", "DELETE", null, `?id=eq.${activity.id}`);
      // Confirm it is actually gone rather than assuming a 2xx meant deleted:
      // a filter that matches nothing also returns 2xx, which would leave a
      // ghost row on screen that reappears on the next load.
      const still = (await api("activities", "GET", null, `?id=eq.${activity.id}&select=id`)) || [];
      if (still.length) throw new Error("row still present after delete");
      setActivities((prev) => prev.filter((a) => a.id !== activity.id));
      showToast("Activity deleted");
      return true;
    } catch (e) {
      console.error("[Activity] delete failed", e);
      showToast("Could not delete activity. Please try again.");
      return false;
    }
  };

  // "+ Add to timeline" (Section 3): a freeform, back-datable entry. Goes
  // through addActivity so it picks up the same institution resolution,
  // last_activity_at bumps and duplicate guard as every other logged activity.
  const addTimelineEntry = async (fields) => {
    const { deal_id, enabler_id, organization_id, contact_id, ...rest } = fields;
    await addActivity(deal_id, contact_id, rest, enabler_id, organization_id);
    return true;
  };

  // Option lists for the activity editor's person and institution pickers.
  const activityLinkOptions = {
    people: contacts.map((c) => ({ value: `contact:${c.id}`, label: c.name })).filter((o) => o.label),
    institutions: dedupeInstitutionOptions({ deals, enablers, organizations, prefer: ["deal", "enabler", "organization"] }),
  };

  // On-demand AI summary for an email activity's body_snippet (the Gmail sync
  // stores the cleaned snippet; the summary itself is only ever generated when
  // the user asks for it, and saved so it never has to run again).
  const summarizeEmailActivity = async (activity) => {
    const snippet = (activity.body_snippet || "").trim();
    if (!snippet || summarizingActivityId) return;
    setSummarizingActivityId(activity.id);
    try {
      const summary = await generateSummary(`Summarize this email in one clear sentence, focusing on what was communicated or requested: ${snippet}`, 150);
      await api("activities", "PATCH", { ai_summary: summary }, `?id=eq.${activity.id}`);
      setActivities((prev) => prev.map((a) => (a.id === activity.id ? { ...a, ai_summary: summary } : a)));
    } catch { showToast("Error summarizing email"); }
    setSummarizingActivityId(null);
  };

  const handleDrop = (e, stageId) => {
    e.preventDefault();
    const dealId = e.dataTransfer.getData("dealId");
    if (dealId) moveDeal(dealId, stageId);
    setDragOver(null);
  };

  const activeDeals = deals.filter((d) => !["won","lost"].includes(d.stage));
  const totalValue = activeDeals.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const institutions = buildInstitutions(deals, enablers, organizations);
  // Resolve a deal back to its institution (by normalized company name) so deal
  // cards can show the institution type and fall back to its city.
  const instByName = new Map(institutions.map((i) => [(i.name || "").trim().toLowerCase(), i]));
  const dealCityOpts = optionsWithCustom(CITY_OPTIONS, customOptions, "city");

  // Renders one pipeline deal card (shared by the grouped "All" view and the
  // single-tier filtered view). Shows type badge, an inline-editable city with
  // pin, and tier badge.
  const renderDealCard = (deal) => {
    const inst = instByName.get((deal.company || "").trim().toLowerCase());
    const cityText = deal.city || inst?.city || "";
    const typeMeta = inst?.type ? institutionTypeMeta(inst.type, customOptions) : null;
    const t = DEAL_TIERS.find((x) => x.id === (deal.tier || "Untiered"));
    const saveCity = (v) => (inst ? updateInstitutionCity(inst, v) : updateDeal(deal.id, { city: v || null }));
    return (
      <div key={deal.id} draggable={!bossMode} onDragStart={bossMode ? undefined : (e) => e.dataTransfer.setData("dealId", deal.id)}
        onClick={() => openInstitution(deal.company, "pipeline")}
        className="deal-card">
        <div className="deal-card-head">
          <div className="card-company">{deal.company}</div>
          {t && t.id !== "Untiered" && <span className="tier-badge" style={{ background: t.bg, color: t.fg }}>{t.label}</span>}
        </div>
        {typeMeta && <span className="badge card-type-badge" style={{ background: typeMeta.color + "22", color: typeMeta.color, border: `1px solid ${typeMeta.color}44` }}>{typeMeta.label}</span>}
        {deal.contact_name && (
          deal.contact_id
            ? <div className="card-contact card-contact-link" onClick={(e) => { e.stopPropagation(); openPerson(deal.contact_id); }} title={`Open ${deal.contact_name}`}>{deal.contact_name}{deal.contact_role ? ` · ${deal.contact_role}` : ""}</div>
            : <div className="card-contact">{deal.contact_name}{deal.contact_role ? ` · ${deal.contact_role}` : ""}</div>
        )}
        <div className="card-city-row">
          <InlineCity city={cityText} options={dealCityOpts} onAddCustomOption={addCustomOption} onSave={saveCity} compact />
          {deal.value > 0 && <span className="card-value">${Number(deal.value).toLocaleString()}</span>}
        </div>
        {deal.next_action && (
          <div className="card-next">
            <div className="card-next-label">NEXT</div>
            <div className="card-next-text">{deal.next_action}</div>
          </div>
        )}
      </div>
    );
  };
  const openTodos = sortTodos(todos.filter((t) => t.status === "open"));
  const filteredTasks = openTodos.filter((t) => {
    if (taskFilter === "high") return t.priority === "high";
    if (taskFilter === "due_today") return t.due_date && isToday(t.due_date);
    if (taskFilter === "overdue") return isOverdue(t.due_date);
    return true;
  });
  const completedTasks = todos.filter((t) => t.status === "completed").slice().sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  // Activities are already loaded ordered by created_at desc, so the first
  // match is the most recent auto-synced (email/meeting) activity.
  const lastSyncedActivity = activities.find((a) => a.type === "email" || a.type === "meeting");

  // NAVIGATION: institutions are keyed by normalized name; people by contact id.
  // A history stack records where each sheet was opened from, so Back always
  // returns to the actual origin (another sheet, Home, Tasks, the Map, etc.).
  // Switching tabs from the sidebar / tab bar clears the stack.
  const pushNav = () => setNavStack((s) => [...s.slice(-19), { view, institutionSheetKey, personSheetId, sheetOrigin }]);
  const openInstitution = (name, origin = null) => {
    if (!name) return;
    pushNav();
    setInstitutionSheetKey(name.trim().toLowerCase());
    if (origin) setSheetOrigin(origin);
    setView("institution-sheet");
  };
  const openPerson = (id) => { pushNav(); setPersonSheetId(id); setView("person-sheet"); };
  const goBack = () => {
    const prev = navStack[navStack.length - 1];
    setNavStack((s) => s.slice(0, -1));
    if (!prev) { setView(sheetOrigin === "pipeline" ? "pipeline" : "network"); setInstitutionSheetKey(null); setPersonSheetId(null); return; }
    setView(prev.view);
    setInstitutionSheetKey(prev.institutionSheetKey);
    setPersonSheetId(prev.personSheetId);
    setSheetOrigin(prev.sheetOrigin);
  };
  // Tab-level navigation resets the sheet history.
  const navigateTab = (v) => { setNavStack([]); setInstitutionSheetKey(null); setPersonSheetId(null); setView(v); };
  // Boss View's sidebar is now just Week in Review / Pipeline / Ecosystem /
  // Calendar / Tasks; if it ever lands elsewhere (deep link, stale URL) send
  // it back to the Week in Review, Andy's homepage, rather than a tab that is
  // no longer in his nav (M4).
  useEffect(() => {
    if (bossMode && ["outreach", "notes", "home", "map", "materials", "exec"].includes(view)) setView("reports");
  }, [bossMode, view]);
  const VIEW_BACK_LABELS = { home: "Home", calendar: "Calendar", pipeline: "Pipeline", network: "Ecosystem", map: "Network Map", tasks: "Tasks", notes: "Notes", materials: "Materials", outreach: "Outreach", reports: "Reports" };
  const backTarget = navStack[navStack.length - 1];
  const backLabel = (() => {
    if (!backTarget) return sheetOrigin === "pipeline" ? "Back to Pipeline" : "Back to Ecosystem";
    if (backTarget.view === "institution-sheet") { const i = institutions.find((x) => x.key === backTarget.institutionSheetKey); return i ? `Back to ${i.name}` : "Back"; }
    if (backTarget.view === "person-sheet") { const c = contacts.find((x) => x.id === backTarget.personSheetId); return c ? `Back to ${c.name}` : "Back"; }
    if (backTarget.view === "reports") return `Back to ${bossMode ? "Week in Review" : "Reports"}`;
    return `Back to ${VIEW_BACK_LABELS[backTarget.view] || "Ecosystem"}`;
  })();

  // Ref to the Pipeline kanban so the mobile stage nav can scroll-snap columns.
  const kanbanRef = useRef(null);
  const isMobile = useIsMobile();

  // Resolve any row carrying deal_id / enabler_id / organization_id / contact_id
  // (activities, todos, comments, or {deal_id} shims) to a display name and to a
  // navigation target. Used by the Command Center lists.
  const entityName = (o) => {
    if (!o) return null;
    if (o.deal_id) return deals.find((d) => d.id === o.deal_id)?.company || null;
    if (o.enabler_id) return enablers.find((e) => e.id === o.enabler_id)?.name || null;
    if (o.organization_id) return organizations.find((x) => x.id === o.organization_id)?.name || null;
    if (o.contact_id) return contacts.find((c) => c.id === o.contact_id)?.name || null;
    return null;
  };
  const openEntity = (o) => {
    if (!o) return;
    if (o.deal_id) { const d = deals.find((x) => x.id === o.deal_id); if (d) return openInstitution(d.company); }
    if (o.enabler_id) { const e = enablers.find((x) => x.id === o.enabler_id); if (e) return openInstitution(e.name); }
    if (o.organization_id) { const g = organizations.find((x) => x.id === o.organization_id); if (g) return openInstitution(g.name); }
    if (o.contact_id) return openPerson(o.contact_id);
  };

  // Command Center derived lists.
  // Today's Agenda reads from calendar_events (Google Calendar via Apps Script),
  // showing events whose start_time is today, ordered by start time.
  const homeMeetings = calendarEvents
    .filter((ev) => ev.start_time && isToday(ev.start_time))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  // "Last synced" = the most recent time the Apps Script wrote an event row.
  const calendarLastSynced = (() => {
    const times = calendarEvents.map((e) => e.updated_at).filter(Boolean).sort();
    return times.length ? formatDateTime(times[times.length - 1]) : null;
  })();
  // Options for manually linking an unmatched event: deduped institutions
  // (deal/enabler/organization, most-specific record) plus every contact.
  const calendarLinkOptions = [
    ...dedupeInstitutionOptions({ deals, enablers, organizations, prefer: ["deal", "enabler", "organization"] }),
    ...contacts.map((c) => ({ value: `contact:${c.id}`, label: c.name })).filter((o) => o.label),
  ];
  const urgencyRank = (t) => (isOverdue(t.due_date) ? 0 : (t.due_date && isToday(t.due_date)) ? 1 : t.priority === "high" ? 2 : 3);
  const urgentTasks = openTodos.slice().sort((a, b) => {
    const u = urgencyRank(a) - urgencyRank(b);
    if (u !== 0) return u;
    const ad = a.due_date ? new Date(a.due_date).getTime() : Infinity;
    const bd = b.due_date ? new Date(b.due_date).getTime() : Infinity;
    return ad - bd;
  }).slice(0, 5);
  const recentActivities = activities.slice(0, 10);
  const staleDeals = activeDeals
    .filter((d) => d.last_activity_at && daysAgo(d.last_activity_at) >= 14)
    .sort((a, b) => daysAgo(b.last_activity_at) - daysAgo(a.last_activity_at))
    .slice(0, 8);

  // Outreach: contacts awaiting a reply for NUDGE_AFTER_DAYS+ days (drives the
  // NEEDS NUDGE group and the Home banner).
  const needsNudgeCount = contacts.filter((c) => c.outreach_status === "awaiting_reply" && c.awaiting_reply_since && daysAgo(c.awaiting_reply_since) >= NUDGE_AFTER_DAYS).length;

  if (loading) return <div className="app loading-screen"><div className="loading-text">Loading Mango OS...</div></div>;

  return (
    <ReadOnlyContext.Provider value={bossMode}>
    <div className="app">
      {toast && <div className="toast">{toast}</div>}

      <Sidebar view={view} setView={navigateTab} tasksCount={openTodos.length} sheetOrigin={sheetOrigin} apiCallsToday={apiCallsToday} bossMode={bossMode} onRefresh={refreshData} onOpenSearch={() => setSearchOpen(true)} lastSynced={lastSyncedActivity ? `Synced ${formatDateTime(lastSyncedActivity.created_at)}` : "No sync yet"} reportsUnreadCount={bossMode ? 0 : unreadBossComments.length} />

      <main className="main">

      {/* UNIFIED INSTITUTION / DEAL SHEET */}
      {view === "institution-sheet" && institutionSheetKey && (() => {
        const inst = institutions.find((i) => i.key === institutionSheetKey);
        if (!inst) return null;
        const instActivities = activities.filter((a) =>
          (inst.dealId && a.deal_id === inst.dealId) ||
          (inst.enablerId && a.enabler_id === inst.enablerId) ||
          (inst.orgId && a.organization_id === inst.orgId));
        const instPeopleIds = new Set(institutionPeople(inst, { contactRoles, dealContacts, enablerContacts, networkEdges, contacts }).map((p) => p.contactId));
        const genSummary = (_e, acts, people) => {
          if (inst.org) return generateOrganizationSummary(inst.org, acts, people);
          if (inst.deal) return generateDealSummary(inst.deal, acts);
          return generateEnablerSummary(inst.enabler, acts);
        };
        const saveSummary = (_id, text) => {
          if (inst.org) return saveOrganizationSummary(inst.org.id, text);
          if (inst.deal) return saveDealSummary(inst.deal.id, text);
          return saveEnablerSummary(inst.enabler.id, text);
        };
        return (
          <InstitutionSheet
            institution={inst}
            onUpdateActivity={updateActivity}
            onDeleteActivity={deleteActivity}
            onAddTimelineEntry={addTimelineEntry}
            activityLinkOptions={activityLinkOptions}
            summaryEntity={inst.org || inst.deal || inst.enabler}
            activities={instActivities}
            allActivities={activities}
            contacts={contacts}
            deals={deals}
            enablers={enablers}
            organizations={organizations}
            dealContacts={dealContacts}
            enablerContacts={enablerContacts}
            networkEdges={networkEdges}
            contactRoles={contactRoles}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            onCreateInstitution={createInstitutionInline}
            onUpdate={(patch) => updateInstitution(inst, patch)}
            onUpdateCity={(city) => updateInstitutionCity(inst, city)}
            onRename={(name) => renameInstitution(inst, name)}
            onAutoFill={() => autoFillInstitution(inst)}
            onAutoFillIfEmpty={() => { if (!inst.description && !autoResearched.current.has(inst.key)) autoFillInstitution(inst, { silent: true }); }}
            researching={researchingInst === inst.key}
            onResearchKeyPeople={(onStatus) => researchKeyPeopleFor(inst, onStatus)}
            onResearchTrials={() => researchTrialsFor(inst)}
            onSaveResearch={(data) => saveInstitutionResearch(inst, data)}
            onAddResearchedPerson={(person) => addResearchedPerson(inst, person)}
            onAddResearchedPeople={(people) => addResearchedPeople(inst, people)}
            onSetFlag={(flag, checked) => setInstitutionFlag(inst, flag, checked)}
            onDelete={() => deleteInstitution(inst)}
            onAddActivity={addActivity}
            onSummarizeEmail={summarizeEmailActivity}
            summarizingActivityId={summarizingActivityId}
            linkedNotes={notes.filter((n) => (inst.dealId && n.deal_id === inst.dealId) || (inst.enablerId && n.enabler_id === inst.enablerId) || (inst.orgId && n.organization_id === inst.orgId))}
            materials={materials}
            materialLinks={materialLinks.filter((l) => (inst.dealId && l.deal_id === inst.dealId) || (inst.enablerId && l.enabler_id === inst.enablerId) || (inst.orgId && l.organization_id === inst.orgId))}
            onAttachMaterial={(materialId) => { const p = institutionPrimaryEntity(inst); return p ? attachMaterial(materialId, { [`${p.type}_id`]: p.id }) : undefined; }}
            onRemoveMaterialLink={removeMaterialLink}
            onDownloadMaterial={downloadMaterial}
            onOpenNote={openNote}
            onAddPersonRole={addPersonRole}
            onAddPersonWithRoles={addPersonWithRoles}
            onRemoveRole={removePersonRole}
            onRemoveNetworkEdge={removeNetworkEdge}
            onAddConnection={addConnection}
            onChangeStage={(stage) => inst.dealId && moveDeal(inst.dealId, stage)}
            onChangeTier={inst.dealId ? ((t) => setDealTier(inst.dealId, t)) : null}
            onUpdateDeal={inst.dealId ? ((patch) => updateDeal(inst.dealId, patch)) : null}
            todos={todos.filter((t) =>
              (inst.dealId && t.deal_id === inst.dealId) || (inst.enablerId && t.enabler_id === inst.enablerId) || (inst.orgId && t.organization_id === inst.orgId) ||
              (t.contact_id && instPeopleIds.has(t.contact_id)) ||
              todoContacts.some((tc) => tc.todo_id === t.id && instPeopleIds.has(tc.contact_id)))}
            todoContacts={todoContacts}
            taskInitial={(() => { const p = institutionPrimaryEntity(inst); return p ? { [`${p.type}_id`]: p.id } : {}; })()}
            onAddTodo={(form) => { const p = institutionPrimaryEntity(inst); return saveTodo({ ...(p ? { [`${p.type}_id`]: p.id } : {}), ...form }); }}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodo}
            onNavigate={openTaskLink}
            onGenerateSummary={genSummary}
            onSaveSummary={saveSummary}
            summarizing={summarizing}
            showToast={showToast}
            onOpenInstitution={openInstitution}
            onOpenPerson={openPerson}
            onOpenCalendarEvent={openCalendarEventDetail}
            backLabel={backLabel}
            onBack={goBack}
            bossNotesSlot={(() => {
              const tagged = bossComments.filter((c) => (inst.dealId && c.deal_id === inst.dealId) || (inst.enablerId && c.enabler_id === inst.enablerId) || (inst.orgId && c.organization_id === inst.orgId));
              if (!bossMode && tagged.length === 0) return null;
              const primary = institutionPrimaryEntity(inst);
              const tag = primary ? { [`${primary.type}_id`]: primary.id } : {};
              return <BossNotes comments={tagged} entityName={inst.name} tag={tag} author={commentAuthor} onPost={postBossComment} />;
            })()}
          />
        );
      })()}

      {/* PERSON SHEET */}
      {view === "person-sheet" && personSheetId && (() => {
        const sheetContact = contacts.find((c) => c.id === personSheetId);
        return sheetContact ? (
          <PersonSheet
            contact={sheetContact}
            onUpdateActivity={updateActivity}
            onDeleteActivity={deleteActivity}
            onAddTimelineEntry={addTimelineEntry}
            activityLinkOptions={activityLinkOptions}
            activities={activities.filter((a) => a.contact_id === sheetContact.id)}
            deals={deals}
            enablers={enablers}
            organizations={organizations}
            contacts={contacts}
            dealContacts={dealContacts}
            enablerContacts={enablerContacts}
            networkEdges={networkEdges}
            contactRoles={contactRoles}
            institutions={institutions}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            onCreateInstitution={createInstitutionInline}
            onUpdate={(patch) => updateContact(sheetContact.id, patch)}
            onDelete={deleteContact}
            onCompose={() => setCompose({ contactId: sheetContact.id, channel: sheetContact.outreach_channel || suggestChannel(sheetContact) })}
            onAddActivity={addActivity}
            onSummarizeEmail={summarizeEmailActivity}
            summarizingActivityId={summarizingActivityId}
            onAddTodo={(form) => saveTodo({ ...form, contact_ids: [...new Set([sheetContact.id, ...(form.contact_ids || [])])], contact_id: sheetContact.id })}
            todos={todos.filter((t) => t.contact_id === sheetContact.id || todoContacts.some((tc) => tc.todo_id === t.id && tc.contact_id === sheetContact.id))}
            todoContacts={todoContacts}
            taskInitial={{ contact_id: sheetContact.id }}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodo}
            onNavigateTask={openTaskLink}
            linkedNotes={notes.filter((n) => n.contact_id === sheetContact.id)}
            onOpenNote={openNote}
            onAddRole={addPersonRole}
            onRemoveRole={removePersonRole}
            onConnectPerson={({ sourceId, targetId, relationship, direction, notes }) => addNetworkEdge({ source_type: "contact", source_id: sourceId, target_type: "contact", target_id: targetId, relationship, strength: "medium", direction: direction || "bidirectional", notes })}
            onAddIntroducedPerson={({ name, role, institutionKey, notes }) => addPersonIntroducedBy({ introducerId: sheetContact.id, name, role, institutionKey, notes })}
            onCreateBareContact={(name) => addPersonIntroducedBy({ name })}
            onRemoveConnection={removeNetworkEdge}
            onSwapConnection={swapNetworkEdge}
            onGenerateSummary={generateContactSummary}
            onSaveSummary={saveContactSummary}
            summarizing={summarizing}
            showToast={showToast}
            onOpenInstitution={openInstitution}
            onOpenPerson={openPerson}
            onOpenCalendarEvent={openCalendarEventDetail}
            onBack={goBack}
            backLabel={backLabel}
          />
        ) : null;
      })()}

      {/* HOME / COMMAND CENTER */}
      {view === "home" && (
        <HomeTab
          greetingName={bossMode ? "Andy" : "Fahed"}
          unreadComments={unreadBossComments}
          onMarkRead={markCommentRead}
          commentTargetName={commentTargetName}
          onUpdateActivity={updateActivity}
          onDeleteActivity={deleteActivity}
          activityLinkOptions={activityLinkOptions}
          customOptions={customOptions}
          onAddCustomOption={addCustomOption}
          meetings={homeMeetings}
          eventEntityRow={eventEntityRow}
          onPrepBriefEvent={prepBriefForEvent}
          onOpenCalendarEvent={openCalendarEventDetail}
          onOpenCalendar={() => navigateTab("calendar")}
          urgentTasks={urgentTasks}
          onToggleTodo={toggleTodo}
          onNavigateTask={openTaskLink}
          recentActivities={recentActivities}
          deals={deals}
          enablers={enablers}
          organizations={organizations}
          contacts={contacts}
          todoContacts={todoContacts}
          dealContacts={dealContacts}
          enablerContacts={enablerContacts}
          networkEdges={networkEdges}
          contactRoles={contactRoles}
          onOpenInstitution={openInstitution}
          onOpenPerson={openPerson}
          staleDeals={staleDeals}
          entityName={entityName}
          onOpenEntity={openEntity}
          isMobile={isMobile}
          bossMode={bossMode}
          onOpenReports={() => navigateTab("reports")}
          notes={notes}
          onOpenNote={openNote}
          onOpenNotesView={() => navigateTab("notes")}
          onNewNote={async () => { await createNote(); navigateTab("notes"); }}
          onOpenMaterials={() => navigateTab("materials")}
          briefs={meetingBriefs}
          onPrepBrief={prepBriefForMeeting}
          onOpenBrief={setBriefViewId}
          onNewBrief={() => setShowNewBrief(true)}
          briefGenerating={briefGenerating}
          needsNudgeCount={needsNudgeCount}
          onOpenOutreach={() => navigateTab("outreach")}
          onRefresh={refreshData}
          onOpenSearch={() => setSearchOpen(true)}
        />
      )}

      {/* CALENDAR */}
      {view === "calendar" && (
        <CalendarTab
          events={calendarEvents}
          contacts={contacts}
          entityName={entityName}
          eventEntityRow={eventEntityRow}
          onOpenEntity={openEntity}
          onOpenDetail={openCalendarEventDetail}
          onPrepBrief={prepBriefForEvent}
          onLink={linkCalendarEvent}
          linkOptions={calendarLinkOptions}
          onCreateInstitution={createInstitutionInline}
          customOptions={customOptions}
          onAddCustomOption={addCustomOption}
          onRefresh={refreshCalendar}
          lastSynced={calendarLastSynced}
          briefGenerating={briefGenerating}
          eventInstitutions={eventInstitutions}
          eventContacts={eventContacts}
          activities={activities}
        />
      )}

      {/* PIPELINE */}
      {view === "pipeline" && (
        <div>
          <div className="page-header">
            <div>
              <div className="page-title">Pipeline</div>
              <div className="page-sub">Your commercial deals across the Kingdom</div>
            </div>
            {!bossMode && <button onClick={() => setModal({type:"deal",data:{stage:"prospecting"}})} className="btn-primary">+ New deal</button>}
          </div>
          <div className="stats-bar">
            {[[activeDeals.length,"Active deals"],[totalValue > 0 ? (totalValue >= 1000000 ? `$${(totalValue/1000000).toFixed(1)}M` : `$${(totalValue/1000).toFixed(0)}K`) : "N/A","Pipeline value"],[contacts.length,"People"],[institutions.length,"Institutions"],[openTodos.length,"Open tasks"]].map(([v,l],i) => (
              <div key={i} className="stat"><div className="stat-label">{l}</div><div className="stat-value">{v}</div></div>
            ))}
          </div>
          <div className="toolbar">
            <div className="tier-filter">
              {[{ id: "all", label: "All" }, ...DEAL_TIERS.filter(t => t.id !== "Untiered")].map(t => (
                <button key={t.id} onClick={() => setTierFilter(t.id)} className={`tag-btn ${tierFilter === t.id ? "active" : ""}`}>{t.label}</button>
              ))}
            </div>
          </div>
          <MobilePipelineNav kanbanRef={kanbanRef} />
          <div className="kanban" ref={kanbanRef}>
            {STAGES.map((stage) => {
              const sd = deals.filter(d => d.stage === stage.id && (tierFilter === "all" || (d.tier || "Untiered") === tierFilter));
              return (
                <div key={stage.id} className={`column ${dragOver === stage.id ? "drag-over" : ""}`}
                  onDragOver={bossMode ? undefined : (e) => { e.preventDefault(); setDragOver(stage.id); }}
                  onDragLeave={bossMode ? undefined : () => setDragOver(null)}
                  onDrop={bossMode ? undefined : (e) => handleDrop(e, stage.id)}>
                  <div className="col-header">
                    <div className="col-title-wrap"><div className="dot" style={{background: stage.color}} /><span className="col-title">{stage.label}</span></div>
                    <span className="col-count">{sd.length}</span>
                  </div>
                  <div className="col-body">
                    {tierFilter === "all"
                      ? DEAL_TIERS.map((tier) => {
                          const td = sd.filter((d) => (d.tier || "Untiered") === tier.id);
                          if (td.length === 0) return null;
                          return (
                            <div key={tier.id} className="tier-group">
                              <div className="tier-group-header">{tier.label}</div>
                              {td.map((deal) => renderDealCard(deal))}
                            </div>
                          );
                        })
                      : sd.map((deal) => renderDealCard(deal))}
                    {sd.length === 0 && <div className="empty-col">{stage.id === "prospecting" ? "Add your first deal" : "Drag deals here"}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* NETWORK */}
      {view === "network" && (
        <div className="section-pad">
          <div className="page-header" style={{ padding: "0 0 18px" }}>
            <div>
              <div className="page-title">Ecosystem</div>
              <div className="page-sub">Institutions and people across your ecosystem</div>
            </div>
          </div>
          <NetworkTab
            institutions={institutions}
            contacts={contacts}
            deals={deals}
            enablers={enablers}
            organizations={organizations}
            dealContacts={dealContacts}
            enablerContacts={enablerContacts}
            networkEdges={networkEdges}
            contactRoles={contactRoles}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            onAddInstitution={addInstitution}
            onCreateInstitution={createInstitutionInline}
            onAddPersonWithRoles={addPersonWithRoles}
            onUpdateInstitution={updateInstitution}
            onUpdateInstitutionCity={updateInstitutionCity}
            onUpdateContact={updateContact}
            onUpdateRoleTitle={updateRoleTitle}
            onSetOutreach={setOutreachStatus}
            onLinkPersonToInstitution={(contactId, name) => {
              const i = institutions.find((x) => x.name.toLowerCase() === (name || "").toLowerCase());
              const primary = i && institutionPrimaryEntity(i);
              if (primary) addPersonRole({ contactId, entityType: primary.type, entityId: primary.id });
            }}
            onOpenInstitution={openInstitution}
            onOpenPerson={openPerson}
            onOpenSearch={() => setSearchOpen(true)}
          />
        </div>
      )}

      {/* MAP (desktop only; the force graph is not usable on a phone) */}
      {view === "map" && (isMobile ? (
        <div className="section-pad">
          <div className="map-mobile-notice">Network Map is best viewed on desktop.</div>
        </div>
      ) : (
        <MapTab
          institutions={institutions}
          contacts={contacts}
          contactRoles={contactRoles}
          dealEnablers={dealEnablers}
          enablerContacts={enablerContacts}
          dealContacts={dealContacts}
          networkEdges={networkEdges}
          activities={activities}
          onOpenInstitution={openInstitution}
          onOpenPerson={openPerson}
        />
      ))}

      {/* TASKS */}
      {view === "tasks" && (
        <div className="section-pad">
          <div className="page-header" style={{ padding: "0 0 16px" }}>
            <div>
              <div className="page-title">Tasks</div>
              <div className="page-sub">Everything that needs your attention</div>
            </div>
          </div>
          {!bossMode && (
            <div className="tasks-quickadd">
              <TaskForm deals={deals} enablers={enablers} organizations={organizations} contacts={contacts} customOptions={customOptions} onAddCustomOption={addCustomOption} onCreateInstitution={createInstitutionInline} onSave={saveTodo} submitLabel="Add Task" showToast={showToast} />
            </div>
          )}
          <div className="timeline-tabs mb">
            {TASK_FILTER_TABS.map(t => (
              <button key={t.id} onClick={() => setTaskFilter(t.id)} className={`tag-btn ${taskFilter === t.id ? "active" : ""}`}>{t.label}</button>
            ))}
          </div>
          {filteredTasks.length === 0 ? (
            <div className="empty-state">No tasks match.</div>
          ) : (
            <div className="todo-list">
              {filteredTasks.map((t) => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  contacts={contacts}
                  deals={deals}
                  enablers={enablers}
                  organizations={organizations}
                  todoContacts={todoContacts}
                  customOptions={customOptions}
                  onAddCustomOption={addCustomOption}
                  onToggle={toggleTodo}
                  onUpdate={updateTodo}
                  onNavigate={openTaskLink}
                />
              ))}
            </div>
          )}
          {completedTasks.length > 0 && (
            <div className="todo-completed-toggle">
              <button onClick={() => setShowCompletedTasks(s => !s)} className="link-btn">{showCompletedTasks ? "▾" : "▸"} Completed ({completedTasks.length})</button>
              {showCompletedTasks && (
                <div className="todo-list todo-list-completed">
                  {completedTasks.map((t) => (
                    <TodoRow
                      key={t.id}
                      todo={t}
                      contacts={contacts}
                      deals={deals}
                      enablers={enablers}
                      organizations={organizations}
                      todoContacts={todoContacts}
                      customOptions={customOptions}
                      onAddCustomOption={addCustomOption}
                      onToggle={toggleTodo}
                      onUpdate={updateTodo}
                      onNavigate={openTaskLink}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* NOTES */}
      {view === "notes" && (
        <NotesTab
          notes={notes}
          selectedId={selectedNoteId}
          onSelect={setSelectedNoteId}
          onCreate={createNote}
          onUpdate={updateNote}
          onDelete={deleteNote}
          onTogglePin={(n) => updateNote(n.id, { is_pinned: !n.is_pinned })}
          onLink={linkNote}
          onCreateInstitution={createInstitutionInline}
          customOptions={customOptions}
          onAddCustomOption={addCustomOption}
          folders={noteFolders}
          onCreateFolder={createFolder}
          onRenameFolder={(id, name) => updateFolder(id, { name })}
          onDeleteFolder={deleteFolder}
          onMoveNote={moveNoteToFolder}
          deals={deals}
          enablers={enablers}
          organizations={organizations}
          contacts={contacts}
          isMobile={isMobile}
          bossMode={bossMode}
          showToast={showToast}
        />
      )}

      {/* MATERIALS LIBRARY */}
      {view === "materials" && (
        <MaterialsTab
          materials={materials}
          onUpload={uploadMaterial}
          onUpdate={updateMaterial}
          onDelete={deleteMaterial}
          onDownload={downloadMaterial}
          showToast={showToast}
        />
      )}

      {/* OUTREACH ENGINE */}
      {view === "outreach" && !bossMode && (
        <OutreachTab
          contacts={contacts}
          deals={deals}
          enablers={enablers}
          organizations={organizations}
          dealContacts={dealContacts}
          enablerContacts={enablerContacts}
          networkEdges={networkEdges}
          contactRoles={contactRoles}
          templates={emailTemplates}
          onSaveTemplate={saveTemplate}
          onDeleteTemplate={deleteTemplate}
          onSetStatus={setOutreachStatus}
          onCompose={(contactId, templateId = null, channel = null) => {
            const c = contacts.find((x) => x.id === contactId);
            setCompose({ contactId, templateId, channel: channel || c?.outreach_channel || suggestChannel(c) });
          }}
          onOpenPerson={openPerson}
          onOpenInstitution={(name) => openInstitution(name)}
        />
      )}

      {/* EXECUTIVE UPDATE */}
      {view === "exec" && (
        <ExecUpdateTab
          presentations={execPresentations}
          blocksFor={execBlocksFor}
          openId={execOpenId}
          onOpen={setExecOpenId}
          onCreate={createExecPresentation}
          generating={execGenerating}
          onUpdatePresentation={updateExecPresentation}
          onDeletePresentation={deleteExecPresentation}
          onAddBlock={addExecBlock}
          onUpdateBlock={updateExecBlock}
          onDeleteBlock={deleteExecBlock}
          onReorder={reorderExecBlocks}
          presenting={execPresenting}
          onPresent={() => setExecPresenting(true)}
          onExitPresent={() => setExecPresenting(false)}
          showToast={showToast}
        />
      )}

      {/* WEEK IN REVIEW */}
      {view === "reports" && (
        <WeekInReviewTab
          deals={deals}
          contacts={contacts}
          enablers={enablers}
          organizations={organizations}
          activities={activities}
          todos={todos}
          todoContacts={todoContacts}
          bossComments={bossComments}
          commentAuthor={commentAuthor}
          onPostComment={postBossComment}
          onMarkCommentRead={bossMode ? null : markCommentRead}
          calendarEvents={calendarEvents}
          dealContacts={dealContacts}
          enablerContacts={enablerContacts}
          networkEdges={networkEdges}
          contactRoles={contactRoles}
          institutions={institutions}
          onOpenInstitution={openInstitution}
          onOpenPerson={openPerson}
          onOpenTaskLink={openTaskLink}
          showToast={showToast}
        />
      )}

      </main>

      {/* Mobile-only bottom tab bar (the sidebar is hidden on phones). */}
      <MobileTabBar view={view} setView={navigateTab} tasksCount={openTodos.length} sheetOrigin={sheetOrigin} bossMode={bossMode} />

      {/* Floating two-way comment thread, available on every tab for Fahed and Andy.
          Only Fahed's opens clear the unread marker (the badge is Fahed's). */}
      <CommentPanel comments={bossComments} author={commentAuthor} unread={unreadComments} onOpen={bossMode ? undefined : markCommentsSeen} onPost={postBossComment} targetName={commentTargetName} showToast={showToast} />

      {/* GLOBAL SEARCH (Cmd+K) */}
      {searchOpen && (
        <GlobalSearch
          institutions={institutions}
          contacts={contacts}
          deals={deals}
          enablers={enablers}
          organizations={organizations}
          dealContacts={dealContacts}
          enablerContacts={enablerContacts}
          networkEdges={networkEdges}
          contactRoles={contactRoles}
          customOptions={customOptions}
          activities={activities}
          todos={todos}
          notes={notes}
          materials={materials}
          entityName={entityName}
          onOpenInstitution={(name) => { setSearchOpen(false); openInstitution(name); }}
          onOpenPerson={(id) => { setSearchOpen(false); openPerson(id); }}
          onOpenEntity={(row) => { setSearchOpen(false); openEntity(row); }}
          onOpenTasks={() => { setSearchOpen(false); navigateTab("tasks"); }}
          onOpenNote={(id) => { setSearchOpen(false); openNote(id); }}
          onOpenMaterials={() => { setSearchOpen(false); navigateTab("materials"); }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* MEETING BRIEF viewer / generator (Feature 2) */}
      {briefGenerating && (
        <div className="overlay">
          <div className="modal brief-modal">
            <div className="brief-generating">
              <div className="brief-generating-spinner" />
              Generating brief for {briefGenerating}...
            </div>
          </div>
        </div>
      )}
      {!briefGenerating && briefViewId && (() => {
        const brief = meetingBriefs.find((b) => b.id === briefViewId);
        if (!brief) return null;
        const relatedLinkIds = new Set(materialLinks
          .filter((l) => (brief.deal_id && l.deal_id === brief.deal_id) || (brief.enabler_id && l.enabler_id === brief.enabler_id) || (brief.organization_id && l.organization_id === brief.organization_id))
          .map((l) => l.material_id));
        return (
          <BriefModal
            brief={brief}
            entityName={entityName}
            relatedMaterials={materials.filter((m) => relatedLinkIds.has(m.id))}
            onDownloadMaterial={downloadMaterial}
            onSaveGoal={(goal) => updateBriefGoal(brief.id, goal)}
            onRegenerate={bossMode ? null : () => generateBrief({ ...brief, existingId: brief.id })}
            onSwitchType={bossMode ? null : () => switchBriefType(brief)}
            onDelete={bossMode ? null : () => { if (confirm("Delete this brief?")) deleteBrief(brief.id); }}
            onOpenEntity={(row) => { setBriefViewId(null); openEntity(row); }}
            readOnly={bossMode}
            onClose={() => setBriefViewId(null)}
          />
        );
      })()}
      {showNewBrief && !bossMode && (
        <NewBriefForm
          contacts={contacts}
          institutions={institutions}
          onCancel={() => setShowNewBrief(false)}
          onCreate={(form) => { setShowNewBrief(false); generateBrief(form); }}
        />
      )}

      {/* CALENDAR EVENT DETAIL PANEL: a global overlay so a "📅 Meeting" activity
          pill anywhere in the app can reopen the same event it came from. */}
      {eventDetailId && (() => {
        const ev = calendarEvents.find((e) => e.id === eventDetailId);
        if (!ev) return null;
        return (
          <EventDetailPanel
            ev={ev}
            contacts={contacts}
            deals={deals}
            enablers={enablers}
            organizations={organizations}
            eventInstitutions={eventInstitutions}
            eventContacts={eventContacts}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            onCreateInstitution={createInstitutionInline}
            onTagInstitution={tagEventInstitution}
            onUntagInstitution={untagEventInstitution}
            onTagPerson={tagEventPerson}
            onUntagPerson={untagEventPerson}
            onSavePrepNotes={saveEventPrepNotes}
            onSaveOutcomeNotes={saveEventOutcomeNotes}
            onGenerateBrief={generateEventBrief}
            briefGenerating={briefGenerating}
            onLogOutcome={logEventOutcome}
            onExtractTasks={extractTasksFromOutcome}
            onClose={closeCalendarEventDetail}
            showToast={showToast}
          />
        );
      })()}

      {/* OUTREACH compose panel (Feature 2) */}
      {compose && !bossMode && (() => {
        const composeContact = contacts.find((c) => c.id === compose.contactId);
        if (!composeContact) return null;
        return (
          <ComposeModal
            contact={composeContact}
            roles={resolveContactRoles(composeContact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles })}
            templates={emailTemplates}
            activities={activities}
            initialTemplateId={compose.templateId}
            initialChannel={compose.channel}
            onUpdateContact={(patch) => updateContact(composeContact.id, patch)}
            onSent={(payload) => { setCompose(null); recordOutreach(composeContact, payload); }}
            showToast={showToast}
            onClose={() => setCompose(null)}
          />
        );
      })()}

      {/* MODALS (creating new records only; hidden in Boss View) */}
      {!bossMode && modal?.type === "deal" && <DealForm deal={modal.data} contacts={contacts} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveDeal} onClose={() => setModal(null)} />}
    </div>
    </ReadOnlyContext.Provider>
  );
}

// Command Center: the mobile landing screen (also the first desktop tab). A
// morning briefing of unread boss notes, today's meetings, urgent tasks, recent
// activity, and stale deals. Purely presentational; all data is derived in App.
function HomeTab({ greetingName, unreadComments, onMarkRead, commentTargetName, meetings, eventEntityRow, onPrepBriefEvent, onOpenCalendarEvent, onOpenCalendar, urgentTasks, onToggleTodo, onNavigateTask, recentActivities, onUpdateActivity, onDeleteActivity, activityLinkOptions = {}, customOptions = [], onAddCustomOption = () => {}, deals, enablers, organizations, contacts, todoContacts = [], dealContacts, enablerContacts, networkEdges, contactRoles, onOpenInstitution, onOpenPerson, staleDeals, entityName, onOpenEntity, isMobile, bossMode, onOpenReports, notes = [], onOpenNote, onOpenNotesView, onNewNote, onOpenMaterials, briefs = [], onPrepBrief, onOpenBrief, onNewBrief, briefGenerating, needsNudgeCount = 0, onOpenOutreach, onRefresh, onOpenSearch }) {
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return (
    <div className="section-pad home">
      <div className="home-header">
        <div>
          <div className="home-greeting">Good {partOfDay}, {greetingName}</div>
          <div className="home-date">{formatFull(new Date())}</div>
        </div>
        <div className="home-header-actions">
          {onOpenSearch && <button className="home-refresh-btn" onClick={onOpenSearch} title="Search everything (Cmd+K)">🔍</button>}
          {onRefresh && <button className="home-refresh-btn" onClick={onRefresh} title="Reload all data from the server">↻</button>}
        </div>
      </div>

      {/* Andy's comments on the Week in Review live there now (see the Comments
          section on that page); this banner is just the shortcut in. */}
      {!bossMode && unreadComments.length > 0 && (
        <button className="home-comment-banner" onClick={onOpenReports}>
          <span>💬 Andy commented on the Week in Review</span>
          <span className="home-comment-banner-count">{unreadComments.length}</span>
        </button>
      )}

      {/* 1. Unread comments from the other person (Andy for Fahed, Fahed for Andy) */}
      <div className="home-section">
        <div className="home-section-title">Unread Comments</div>
        {unreadComments.length === 0 ? (
          <div className="home-empty">No new comments from {bossMode ? "Fahed" : "Andy"}.</div>
        ) : (
          <div className="home-list">
            {unreadComments.map((c) => {
              const tName = commentTargetName(c);
              return (
                <div key={c.id} className="home-card home-comment">
                  <Avatar name={c.author} size={34} />
                  <div className="home-comment-main">
                    <div className="home-comment-meta">
                      <span className="home-comment-author">{c.author}</span>
                      <span className="home-comment-time">{formatDateTime(c.created_at)}</span>
                    </div>
                    {c.content && <div className="home-comment-text">{c.content}</div>}
                    {tName && <button className="home-tag" onClick={() => onOpenEntity(c)}>re: {tName}</button>}
                  </div>
                  <button className="home-markread" onClick={() => onMarkRead(c.id)}>Mark read</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Today's agenda (from Google Calendar via calendar_events) */}
      <div className="home-section">
        <div className="home-section-head">
          <div className="home-section-title">Today's Agenda</div>
          {onOpenCalendar && <button className="home-section-action" onClick={onOpenCalendar}>Open Calendar</button>}
        </div>
        {meetings.length === 0 ? (
          <div className="home-empty">No events on your calendar today. Check the Google Calendar sync.</div>
        ) : (
          <div className="home-list">
            {meetings.map((ev) => {
              const entRow = eventEntityRow ? eventEntityRow(ev) : null;
              const ent = entRow ? entityName(entRow) : "";
              // Show Prep Brief for any match (including an internal team
              // contact) or a detected internal-only meeting with no match.
              const canPrepBrief = !!ent || isInternalMeeting(ev, contacts);
              return (
                <div key={ev.id} className={`home-card home-meeting ${onOpenCalendarEvent ? "home-task-clickable" : ""}`} onClick={onOpenCalendarEvent ? () => onOpenCalendarEvent(ev.id) : undefined}>
                  <div className="home-meeting-time">{formatTime(ev.start_time)}</div>
                  <div className="home-meeting-main">
                    <div className="home-meeting-title">{ev.title || "Untitled event"}</div>
                    <div className="home-meeting-sub">
                      {ev.location && <span>{ev.location}</span>}
                      {ent && <button type="button" className="home-meeting-entity home-meeting-entity-btn" onClick={(e) => { e.stopPropagation(); onOpenEntity(entRow); }}>{ent}</button>}
                    </div>
                  </div>
                  {!bossMode && onPrepBriefEvent && canPrepBrief && (
                    <button className="home-prep-btn" disabled={!!briefGenerating} onClick={(e) => { e.stopPropagation(); onPrepBriefEvent(ev); }}>Prep Brief</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Daily news briefing (Feature 3), below Today's Agenda */}
      <DailyBriefing isMobile={isMobile} bossMode={bossMode} />

      {/* Meeting prep briefs (Feature 2) */}
      <div className="home-section">
        <div className="home-section-head">
          <div className="home-section-title">Briefs</div>
          {!bossMode && onNewBrief && <button className="home-section-action" disabled={!!briefGenerating} onClick={onNewBrief}>+ New Brief</button>}
        </div>
        {briefs.length === 0 ? (
          <div className="home-empty">No briefs yet. Generate one from a meeting above, or create one manually.</div>
        ) : (
          <div className="home-list">
            {briefs.slice(0, 5).map((b) => (
              <div key={b.id} className="home-card home-brief" onClick={() => onOpenBrief(b.id)}>
                <div className="home-brief-main">
                  <div className="home-brief-title">{b.meeting_title || "Meeting brief"}</div>
                  <div className="home-brief-meta">
                    {b.meeting_date && <span>{formatDate(b.meeting_date)}</span>}
                    {entityName(b) && <span className="home-brief-entity">{entityName(b)}</span>}
                    <span className="home-brief-created">Prepared {formatDate(b.created_at)}</span>
                  </div>
                </div>
                <span className="home-brief-open">Open</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Urgent tasks */}
      <div className="home-section">
        <div className="home-section-title">Urgent Tasks</div>
        {!bossMode && needsNudgeCount > 0 && (
          <button className="home-nudge-banner" onClick={onOpenOutreach}>
            {needsNudgeCount} contact{needsNudgeCount === 1 ? "" : "s"} need{needsNudgeCount === 1 ? "s" : ""} a nudge
            <span className="home-nudge-arrow">→</span>
          </button>
        )}
        {urgentTasks.length === 0 ? (
          <div className="home-empty">No urgent tasks. You are all caught up.</div>
        ) : (
          <div className="home-list">
            {urgentTasks.map((t) => {
              const overdue = isOverdue(t.due_date);
              const dueToday = t.due_date && isToday(t.due_date);
              const name = entityName(t);
              return (
                <div key={t.id} className={`home-card home-task ${overdue ? "is-overdue" : dueToday ? "is-today" : ""} ${name ? "home-task-clickable" : ""}`} onClick={name ? () => onOpenEntity(t) : undefined}>
                  {!bossMode && onToggleTodo && (
                    <button className="home-task-check" title="Mark complete" onClick={(e) => { e.stopPropagation(); onToggleTodo(t); }} aria-label="Mark complete" />
                  )}
                  <div className="home-task-main">
                    <div className="home-task-title">{t.title}</div>
                    <div className="home-task-meta">
                      <PriorityBadge priority={t.priority} />
                      {t.due_date && <span className={`home-due ${overdue ? "due-overdue" : dueToday ? "due-today" : ""}`}>{overdue ? `Overdue ${formatDate(t.due_date)}` : dueToday ? "Due today" : `Due ${formatDate(t.due_date)}`}</span>}
                    </div>
                    <div onClick={(e) => e.stopPropagation()}>
                      <TaskPills todo={t} deals={deals} enablers={enablers} organizations={organizations} contacts={contacts} todoContacts={todoContacts} onNavigate={onNavigateTask} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. Recent activity */}
      <div className="home-section">
        <div className="home-section-title">Recent Activity</div>
        {recentActivities.length === 0 ? (
          <div className="home-empty">No activity logged yet.</div>
        ) : (
          <div className="home-list">
            {recentActivities.map((a) => (
              <HomeActivityRow
                key={a.id}
                activity={a}
                entityName={entityName}
                onOpenEntity={onOpenEntity}
                onUpdateActivity={onUpdateActivity}
                onDeleteActivity={onDeleteActivity}
                linkOptions={activityLinkOptions}
                customOptions={customOptions}
                onAddCustomOption={onAddCustomOption}
                pillProps={{ deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles, onOpenInstitution, onOpenPerson, onOpenCalendarEvent }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 5. Stale deals (no activity in 14+ days) */}
      <div className="home-section">
        <div className="home-section-title">Stale Deals</div>
        {staleDeals.length === 0 ? (
          <div className="home-empty">No stale deals. Everything has been touched recently.</div>
        ) : (
          <div className="home-list">
            {staleDeals.map((d) => {
              const stage = STAGES.find((s) => s.id === d.stage);
              return (
                <div key={d.id} className="home-card home-stale" onClick={() => onOpenEntity({ deal_id: d.id })}>
                  <div className="home-stale-main">
                    <div className="home-stale-name">{d.company}</div>
                    {stage && <span className="badge" style={{ background: stage.color + "22", color: stage.color, border: `1px solid ${stage.color}44` }}>{stage.label}</span>}
                  </div>
                  <div className="home-stale-days">{daysAgo(d.last_activity_at)} days quiet</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* My Notes (mobile: Notes has no bottom tab, so it lives here) */}
      {!bossMode && isMobile && (
        <div className="home-section">
          <div className="home-section-head">
            <div className="home-section-title">My Notes</div>
            <button className="home-section-action" onClick={onNewNote}>+ New</button>
          </div>
          {notes.length === 0 ? (
            <div className="home-empty">No notes yet. Tap + New to write one.</div>
          ) : (
            <div className="home-list">
              {[...notes]
                .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
                .slice(0, 4)
                .map((n) => {
                  const preview = (n.content || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
                  return (
                    <div key={n.id} className="home-card home-note" onClick={() => onOpenNote(n.id)}>
                      <div className="home-note-top">
                        <span className="home-note-title">{n.title || "Untitled"}</span>
                        {n.is_pinned && <span className="home-note-pin">📌</span>}
                      </div>
                      {preview && <div className="home-note-preview">{preview}</div>}
                      <div className="home-note-date">{formatDate(n.updated_at || n.created_at)}</div>
                    </div>
                  );
                })}
              <button className="home-reports-link" onClick={onOpenNotesView}>View All Notes</button>
            </div>
          )}
        </div>
      )}

      {!bossMode && isMobile && (
        <>
          <button className="home-reports-link" onClick={onOpenMaterials}>View Materials</button>
          <button className="home-reports-link" onClick={onOpenReports}>View Reports</button>
        </>
      )}
    </div>
  );
}

// Daily news briefing (Feature 3): three web-search sections cached in
// localStorage per day. Auto-fetches on the first Home load of the day; the
// Refresh button re-fetches all three in parallel. Each section fails and
// retries independently so one bad fetch never blanks the others.
// Bumped to v3 when article URLs were corrected (deep links, not homepages):
// a new key discards the older cached stories and forces one fresh fetch.
const NEWS_CACHE_KEY = "mango-news-briefing-v3";
function DailyBriefing({ isMobile, bossMode = false }) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const [data, setData] = useState(() => {
    try { return JSON.parse(localStorage.getItem(NEWS_CACHE_KEY) || "null"); } catch { return null; }
  });
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [collapsed, setCollapsed] = useState(() => Object.fromEntries(NEWS_SECTIONS.map((s) => [s.key, isMobile])));
  const startedRef = useRef(false);

  const cacheFresh = data && data.date === todayKey;

  // Fetch one section with resilience: up to 2 retries with a 2s backoff (web
  // search often times out transiently), then a no-web-search fallback on the
  // model's own knowledge before finally surfacing the error. Errors are logged
  // with their real message so a persistently failing section can be diagnosed.
  const fetchSection = useCallback(async (sec) => {
    setLoading((l) => ({ ...l, [sec.key]: true }));
    let stories = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try { stories = await fetchNewsStories(sec.prompt); break; }
      catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[News] ${sec.key} attempt ${attempt + 1}/3 failed:`, err?.message || err);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!stories && sec.fallbackPrompt) {
      try { stories = await fetchNewsStoriesNoSearch(sec.fallbackPrompt); }
      catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[News] ${sec.key} fallback (no web search) failed:`, err?.message || err);
      }
    }
    if (stories) {
      setErrors((e) => ({ ...e, [sec.key]: false }));
      setData((prev) => {
        const sections = prev && prev.date === todayKey ? { ...prev.sections } : {};
        sections[sec.key] = stories;
        const next = { date: todayKey, updatedAt: new Date().toISOString(), sections };
        try { localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify(next)); } catch { /* storage full */ }
        return next;
      });
    } else {
      setErrors((e) => ({ ...e, [sec.key]: true }));
    }
    setLoading((l) => ({ ...l, [sec.key]: false }));
  }, [todayKey]);

  // Stagger the three calls by 1s each (fire, +1s, +2s) so three simultaneous
  // web searches do not rate-limit or time each other out.
  const refreshAll = useCallback(() => {
    NEWS_SECTIONS.forEach((sec, i) => { setTimeout(() => fetchSection(sec), i * 1000); });
  }, [fetchSection]);

  // Fetch fresh news once per day: only on the first Home mount whose cache is
  // stale. Boss View never fetches: Andy's browser must not spend API calls on
  // Fahed's key (M4). He sees whatever cache exists, else a static note.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    try { localStorage.removeItem("mango-news-briefing"); localStorage.removeItem("mango-news-briefing-v2"); } catch { /* ignore */ }
    if (!cacheFresh && !bossMode) refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anyLoading = NEWS_SECTIONS.some((s) => loading[s.key]);
  return (
    <div className="home-section daily-briefing">
      <div className="home-section-head">
        <div className="home-section-title">Daily Briefing</div>
        <div className="briefing-head-right">
          {cacheFresh && data.updatedAt && <span className="briefing-updated">Last updated: {formatDateTime(data.updatedAt)}</span>}
          {!bossMode && <button className="home-section-action" disabled={anyLoading} onClick={refreshAll}>{anyLoading ? "Refreshing..." : "Refresh Briefing"}</button>}
        </div>
      </div>
      {bossMode && !cacheFresh ? (
        <div className="news-empty">Daily news is fetched on Fahed's device.</div>
      ) : NEWS_SECTIONS.map((sec) => {
        const stories = cacheFresh ? data.sections[sec.key] : null;
        const isCollapsed = collapsed[sec.key];
        return (
          <div key={sec.key} className="news-section">
            <button className="news-section-head" onClick={() => setCollapsed((c) => ({ ...c, [sec.key]: !c[sec.key] }))}>
              <span className="news-section-icon">{sec.icon}</span>
              <span className="news-section-label">{sec.label}</span>
              <span className="news-section-chevron">{isCollapsed ? "▸" : "▾"}</span>
            </button>
            {!isCollapsed && (
              errors[sec.key] ? (
                <button className="news-error" disabled={loading[sec.key]} onClick={() => fetchSection(sec)}>{loading[sec.key] ? "Retrying..." : `Couldn't load ${sec.label} news. Tap to retry.`}</button>
              ) : loading[sec.key] ? (
                <div className="news-skeletons">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="news-skeleton"><div className="news-skeleton-line w60" /><div className="news-skeleton-line w90" /></div>
                  ))}
                </div>
              ) : !stories || stories.length === 0 ? (
                <div className="news-empty">No stories loaded yet.</div>
              ) : (
                <div className="news-list">
                  {stories.map((s, i) => {
                    const href = newsStoryHref(s);
                    return (
                      <a key={i} className="news-row" href={href} target="_blank" rel="noopener noreferrer">
                        <div className="news-headline">{s.headline}</div>
                        {s.summary && <div className="news-summary">{s.summary}</div>}
                        {s.source && <span className="news-source">{s.source}</span>}
                      </a>
                    );
                  })}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   Calendar (Feature: Google Calendar via calendar_events)
   ============================================================ */

// Pill class by which matched_* FK an event carries (blue deal, gold enabler,
// green contact, gray organization), matching the TaskPills color language.
const eventMatchClass = (ev) => ev.matched_deal_id ? "task-pill-deal" : ev.matched_enabler_id ? "task-pill-enabler" : ev.matched_contact_id ? "task-pill-contact" : ev.matched_organization_id ? "task-pill-organization" : "";
const eventMatchPickType = (ev) => ev.matched_deal_id ? "deal" : ev.matched_enabler_id ? "enabler" : ev.matched_contact_id ? "contact" : ev.matched_organization_id ? "organization" : null;

// A day header label: Today / Tomorrow / weekday, month day.
const agendaDayLabel = (d) => {
  const date = new Date(d);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const tomorrow = new Date(t); tomorrow.setDate(t.getDate() + 1);
  if (isSameDay(date, t)) return "Today";
  if (isSameDay(date, tomorrow)) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
};

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
// Monday-based start of the week containing `d`.
const startOfWeek = (d) => { const x = startOfDay(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; };

// One event row shared by Agenda and the Week popover: time, title, location,
// attendees, matched-entity pill, and a Prep Brief / Link action.
// Whether an event has any tagged institutions/people, any prep or outcome
// notes, or a logged outcome (an activity carrying its CALEVENT marker) -
// drives the small at-a-glance indicators on the row (Section 8).
function eventIndicators(ev, { eventInstitutions = [], eventContacts = [], activities = [] }) {
  const tagged = eventInstitutions.some((r) => r.calendar_event_id === ev.id) || eventContacts.some((r) => r.calendar_event_id === ev.id);
  const hasNotes = !!(ev.prep_notes || "").trim() || !!(ev.outcome_notes || "").trim();
  const outcomeLogged = activities.some((a) => activityCalendarEventId(a) === ev.id);
  return { tagged, hasNotes, outcomeLogged };
}

function CalendarEventRow({ ev, entityName, eventEntityRow, onOpenEntity, onOpenDetail, onPrepBrief, onLink, linkOptions, onCreateInstitution, customOptions = [], onAddCustomOption = () => {}, briefGenerating, readOnly, contacts = [], eventInstitutions = [], eventContacts = [], activities = [], compact = false }) {
  const [linking, setLinking] = useState(false);
  const entRow = eventEntityRow(ev);
  const ent = entityName(entRow);
  const matched = eventMatchPickType(ev);
  const internalMeeting = isInternalMeeting(ev, contacts);
  // Show Prep Brief for ANY match (including an internal team contact) or for
  // a detected internal-only meeting with no match at all; only fall back to
  // "Link to entity" when there is truly no match and no internal signal.
  const canPrepBrief = (matched && ent) || internalMeeting;
  const attendees = Array.isArray(ev.attendees) ? ev.attendees.filter(Boolean) : [];
  const { tagged, hasNotes, outcomeLogged } = eventIndicators(ev, { eventInstitutions, eventContacts, activities });
  return (
    <div className={`cal-event ${compact ? "cal-event-compact" : ""} ${onOpenDetail ? "cal-event-click" : ""}`} onClick={onOpenDetail ? () => onOpenDetail(ev.id) : undefined}>
      <div className="cal-event-time">{formatTime(ev.start_time)}{ev.end_time ? ` - ${formatTime(ev.end_time)}` : ""}</div>
      <div className="cal-event-body">
        <div className="cal-event-title">
          {ev.title || "Untitled event"}
          {(tagged || hasNotes || outcomeLogged) && (
            <span className="cal-event-indicators">
              {tagged && <span title="Has tagged institutions or people">🏷️</span>}
              {hasNotes && <span title="Has prep or outcome notes">📝</span>}
              {outcomeLogged && <span title="Outcome logged">✅</span>}
            </span>
          )}
        </div>
        {ev.location && <div className="cal-event-loc">📍 {ev.location}</div>}
        {attendees.length > 0 && <div className="cal-event-attendees">{attendees.slice(0, 5).join(", ")}{attendees.length > 5 ? ` +${attendees.length - 5}` : ""}</div>}
        <div className="cal-event-actions" onClick={(e) => e.stopPropagation()}>
          {matched && ent && (
            <button className={`task-pill ${eventMatchClass(ev)}`} onClick={() => onOpenEntity(entRow)} title={`Open ${ent}`}>{ent}</button>
          )}
          {!matched && internalMeeting && <span className="badge brief-type-internal cal-internal-tag">Internal meeting</span>}
          {!readOnly && canPrepBrief && (
            <button className="cal-prep-btn" disabled={!!briefGenerating} onClick={() => onPrepBrief(ev)}>Prep Brief</button>
          )}
          {!readOnly && !canPrepBrief && (
            linking ? (
              <EntityPicker
                placeholder="Link to contact or institution..." options={linkOptions} value=""
                onChange={(val) => { const i = val.indexOf(":"); onLink(ev.id, { type: val.slice(0, i), id: val.slice(i + 1) }); setLinking(false); }}
                onCreateInstitution={onCreateInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
              />
            ) : (
              <button className="cal-link-btn" onClick={() => setLinking(true)}>Link to entity</button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// Full-screen Calendar view: Agenda (default) or Week, plus a refresh + last-synced.
function CalendarTab({ events, contacts = [], entityName, eventEntityRow, onOpenEntity, onOpenDetail, onPrepBrief, onLink, linkOptions, onCreateInstitution, customOptions = [], onAddCustomOption = () => {}, onRefresh, lastSynced, briefGenerating, eventInstitutions = [], eventContacts = [], activities = [] }) {
  const readOnly = useReadOnly();
  const [mode, setMode] = useState("agenda");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));

  const today0 = startOfDay(new Date());
  const twoDaysAgo = new Date(today0); twoDaysAgo.setDate(today0.getDate() - 2);
  const sorted = [...events].filter((e) => e.start_time).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const recent = sorted.filter((e) => { const t = new Date(e.start_time); return t < today0 && t >= twoDaysAgo; }).reverse();
  const upcoming = sorted.filter((e) => new Date(e.start_time) >= today0);

  // Group upcoming by calendar day.
  const dayGroups = [];
  upcoming.forEach((e) => {
    const key = new Date(e.start_time).toDateString();
    let g = dayGroups.find((x) => x.key === key);
    if (!g) { g = { key, date: e.start_time, items: [] }; dayGroups.push(g); }
    g.items.push(e);
  });

  const [recentOpen, setRecentOpen] = useState(false);
  const rowProps = { entityName, eventEntityRow, onOpenEntity, onOpenDetail, onPrepBrief, onLink, linkOptions, onCreateInstitution, customOptions, onAddCustomOption, briefGenerating, readOnly, contacts, eventInstitutions, eventContacts, activities };

  // Week grid days and their events.
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d; });
  const eventsForDay = (d) => sorted.filter((e) => isSameDay(e.start_time, d));
  const weekLabel = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${weekDays[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div className="section-pad calendar-tab">
      <div className="page-header">
        <div>
          <div className="page-title">Calendar</div>
          <div className="page-sub">Your Google Calendar, synced hourly</div>
        </div>
        <div className="calendar-head-actions">
          <div className="calendar-mode-toggle">
            <button className={mode === "agenda" ? "active" : ""} onClick={() => setMode("agenda")}>Agenda</button>
            <button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Week</button>
          </div>
          {lastSynced && <span className="calendar-synced">Last synced {lastSynced}</span>}
          <button className="btn-sec calendar-refresh" onClick={onRefresh} title="Re-read events from the database">↻ Refresh</button>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="empty-state">No calendar events yet. The Google Calendar sync (Apps Script) populates these hourly; use Refresh to re-check.</div>
      ) : mode === "agenda" ? (
        <div className="calendar-agenda">
          {recent.length > 0 && (
            <div className="cal-recent">
              <button className="cal-recent-head" onClick={() => setRecentOpen((o) => !o)}>{recentOpen ? "▾" : "▸"} Recent ({recent.length})</button>
              {recentOpen && <div className="cal-day-events">{recent.map((e) => <CalendarEventRow key={e.id} ev={e} {...rowProps} />)}</div>}
            </div>
          )}
          {dayGroups.length === 0 ? (
            <div className="home-empty">No upcoming events.</div>
          ) : dayGroups.map((g) => (
            <div key={g.key} className="cal-day">
              <div className={`cal-day-head ${isSameDay(g.date, today0) ? "is-today" : ""}`}>{agendaDayLabel(g.date)}</div>
              <div className="cal-day-events">{g.items.map((e) => <CalendarEventRow key={e.id} ev={e} {...rowProps} />)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="calendar-week">
          <div className="cal-week-nav">
            <button onClick={() => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); }}>‹ Prev</button>
            <span className="cal-week-label">{weekLabel}</span>
            <button onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</button>
            <button onClick={() => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); }}>Next ›</button>
          </div>
          <div className="cal-week-grid">
            {weekDays.map((d, i) => {
              const dayEvents = eventsForDay(d);
              return (
                <div key={i} className={`cal-week-col ${isSameDay(d, new Date()) ? "is-today" : ""}`}>
                  <div className="cal-week-colhead">
                    <div className="cal-week-dow">{d.toLocaleDateString("en-US", { weekday: "short" })}</div>
                    <div className="cal-week-date">{d.getDate()}</div>
                  </div>
                  <div className="cal-week-slots">
                    {dayEvents.length === 0 ? <div className="cal-week-empty" /> : dayEvents.map((e) => {
                      const { tagged, hasNotes, outcomeLogged } = eventIndicators(e, { eventInstitutions, eventContacts, activities });
                      return (
                        <button key={e.id} className={`cal-week-block ${eventMatchClass(e) || "cal-block-none"}`} onClick={() => onOpenDetail(e.id)} title={e.title}>
                          <span className="cal-week-block-time">{formatTime(e.start_time)}</span>
                          <span className="cal-week-block-title">{e.title || "Untitled"}</span>
                          {(tagged || hasNotes || outcomeLogged) && (
                            <span className="cal-event-indicators cal-week-block-indicators">
                              {tagged && <span title="Has tagged institutions or people">🏷️</span>}
                              {hasNotes && <span title="Has prep or outcome notes">📝</span>}
                              {outcomeLogged && <span title="Outcome logged">✅</span>}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Calendar event detail panel (a global overlay: side panel on desktop, a
// full-screen sheet on mobile via CSS): tag institutions and people, prep
// notes, a Generate Prep Brief that uses the tags, and an Outcome section
// (typed or voice) that fans out as activities to every tagged entity.
function EventDetailPanel({
  ev, contacts, deals, enablers, organizations,
  eventInstitutions, eventContacts, customOptions = [], onAddCustomOption = () => {}, onCreateInstitution,
  onTagInstitution, onUntagInstitution, onTagPerson, onUntagPerson,
  onSavePrepNotes, onSaveOutcomeNotes, onGenerateBrief, briefGenerating,
  onLogOutcome, onExtractTasks, onClose, showToast,
}) {
  const readOnly = useReadOnly();
  const [prepDraft, setPrepDraft] = useState(ev.prep_notes || "");
  const [outcomeDraft, setOutcomeDraft] = useState(ev.outcome_notes || "");
  const [extracting, setExtracting] = useState(false);
  const [logging, setLogging] = useState(false);
  const autoTaggedRef = useRef(new Set());

  useEffect(() => { setPrepDraft(ev.prep_notes || ""); setOutcomeDraft(ev.outcome_notes || ""); }, [ev.id, ev.prep_notes, ev.outcome_notes]);

  // Pre-populate People with any attendee that matches an existing contact by
  // email, once, and only the first time this event is ever opened (a later
  // deliberate removal should not silently come back).
  useEffect(() => {
    if (readOnly || autoTaggedRef.current.has(ev.id)) return;
    autoTaggedRef.current.add(ev.id);
    if (eventContacts.some((r) => r.calendar_event_id === ev.id)) return;
    const emails = Array.isArray(ev.attendee_emails) ? ev.attendee_emails.filter(Boolean).map((e) => e.toLowerCase()) : [];
    if (!emails.length) return;
    contacts.filter((c) => c.email && emails.includes(c.email.toLowerCase())).forEach((c) => onTagPerson(ev.id, c.id));
  }, [ev.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const instKey = (r) => (r.deal_id ? `deal:${r.deal_id}` : r.enabler_id ? `enabler:${r.enabler_id}` : `organization:${r.organization_id}`);
  const taggedInstRows = eventInstitutions.filter((r) => r.calendar_event_id === ev.id);
  const instOptions = dedupeInstitutionOptions({ deals, enablers, organizations, prefer: ["deal", "enabler", "organization"] });
  const taggedInstValues = taggedInstRows.map(instKey);
  const handleInstChange = (vals) => {
    vals.filter((v) => !taggedInstValues.includes(v)).forEach((v) => { const i = v.indexOf(":"); onTagInstitution(ev.id, { type: v.slice(0, i), id: v.slice(i + 1) }); });
    taggedInstRows.filter((r) => !vals.includes(instKey(r))).forEach((r) => onUntagInstitution(r.id));
  };

  const taggedContactRows = eventContacts.filter((r) => r.calendar_event_id === ev.id);
  const contactOptions = contacts.map((c) => ({ value: c.id, label: c.name })).filter((o) => o.label);
  const taggedContactValues = taggedContactRows.map((r) => r.contact_id);
  const handleContactChange = (vals) => {
    vals.filter((v) => !taggedContactValues.includes(v)).forEach((v) => onTagPerson(ev.id, v));
    taggedContactRows.filter((r) => !vals.includes(r.contact_id)).forEach((r) => onUntagPerson(r.id));
  };

  const attendees = Array.isArray(ev.attendees) ? ev.attendees.filter(Boolean) : [];
  const savePrep = () => { if ((ev.prep_notes || "") !== prepDraft) onSavePrepNotes(ev.id, prepDraft); };
  const saveOutcomeDraft = () => { if ((ev.outcome_notes || "") !== outcomeDraft) onSaveOutcomeNotes(ev.id, outcomeDraft); };

  const doLogOutcome = async () => {
    if (logging) return;
    setLogging(true);
    try { await onLogOutcome(ev, outcomeDraft); } finally { setLogging(false); }
  };
  const doExtractTasks = async () => {
    if (extracting) return;
    setExtracting(true);
    try { await onExtractTasks(ev, outcomeDraft); } finally { setExtracting(false); }
  };

  // Voice outcome (Section 7): VoiceRecorder captures and transcribes real
  // audio, then the digest summary lands in the Outcome textarea (and is
  // saved right away) instead of its own save button, so "Log Outcome"
  // afterward is the one action that fans it out to everyone.
  const onOutcomeVoiceDigest = ({ summary }) => {
    const clean = (summary || "").trim();
    if (!clean) return;
    const newText = outcomeDraft.trim() ? `${outcomeDraft.trim()}\n\n${clean}` : clean;
    setOutcomeDraft(newText);
    onSaveOutcomeNotes(ev.id, newText);
  };
  const onPrepVoiceText = (text) => {
    const clean = (text || "").trim();
    if (!clean) return;
    const newText = prepDraft.trim() ? `${prepDraft.trim()}\n\n${clean}` : clean;
    setPrepDraft(newText);
    onSavePrepNotes(ev.id, newText);
  };

  return (
    <div className="overlay event-detail-overlay" onClick={onClose}>
      <div className="modal event-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{ev.title || "Untitled event"}</div>
            <div className="brief-sub">{formatFull(ev.start_time)} . {formatTime(ev.start_time)}{ev.end_time ? ` - ${formatTime(ev.end_time)}` : ""}</div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {ev.location && <div className="event-detail-loc">📍 {ev.location}</div>}

        {attendees.length > 0 && (
          <div className="event-detail-section">
            <div className="section-label">Attendees</div>
            <div className="event-detail-attendees">{attendees.join(", ")}</div>
          </div>
        )}

        <div className="event-detail-section">
          <div className="section-label">Institutions</div>
          {readOnly ? (
            taggedInstRows.length === 0 ? <div className="empty-small">No institutions tagged.</div> : (
              <div className="multi-contact-pills">{taggedInstRows.map((r) => <span key={r.id} className="entity-picker-chip">{instOptions.find((o) => o.value === instKey(r))?.label || "Unknown"}</span>)}</div>
            )
          ) : (
            <MultiContactPicker
              options={instOptions}
              value={taggedInstValues}
              onChange={handleInstChange}
              placeholder="+ Tag institution..."
              onCreateInstitution={onCreateInstitution}
              customOptions={customOptions}
              onAddCustomOption={onAddCustomOption}
            />
          )}
        </div>

        <div className="event-detail-section">
          <div className="section-label">People</div>
          {readOnly ? (
            taggedContactRows.length === 0 ? <div className="empty-small">No people tagged.</div> : (
              <div className="multi-contact-pills">{taggedContactRows.map((r) => <span key={r.id} className="entity-picker-chip">{contacts.find((c) => c.id === r.contact_id)?.name || "Unknown"}</span>)}</div>
            )
          ) : (
            <MultiContactPicker options={contactOptions} value={taggedContactValues} onChange={handleContactChange} placeholder="+ Tag person..." />
          )}
        </div>

        <div className="event-detail-section">
          <div className="section-label">Prep Notes</div>
          <div className="event-detail-outcome-row">
            <textarea
              className="input textarea event-detail-textarea"
              placeholder="Notes before the meeting..."
              value={prepDraft}
              onChange={(e) => setPrepDraft(e.target.value)}
              onBlur={savePrep}
              disabled={readOnly}
            />
            {!readOnly && <VoiceRecorder mode="plain" onPlainText={onPrepVoiceText} showToast={showToast} compact title="Dictate prep notes" />}
          </div>
          {!readOnly && (
            <button className="btn-sec event-detail-brief-btn" disabled={!!briefGenerating} onClick={() => onGenerateBrief(ev)}>
              {briefGenerating ? "Generating..." : "Generate Prep Brief"}
            </button>
          )}
        </div>

        <div className="event-detail-section event-detail-outcome">
          <div className="section-label">Outcome</div>
          <div className="event-detail-outcome-row">
            <textarea
              className="input textarea event-detail-textarea"
              placeholder="What happened, decisions made, next steps..."
              value={outcomeDraft}
              onChange={(e) => setOutcomeDraft(e.target.value)}
              onBlur={saveOutcomeDraft}
              disabled={readOnly}
            />
            {!readOnly && <VoiceRecorder mode="digest" onDigest={onOutcomeVoiceDigest} showToast={showToast} title="Record outcome by voice" />}
          </div>
          {!readOnly && (
            <div className="event-detail-outcome-actions">
              <button className="btn-sec" disabled={extracting || !outcomeDraft.trim()} onClick={doExtractTasks}>{extracting ? "Extracting..." : "Extract tasks from outcome"}</button>
              <button className="btn-primary" disabled={logging || !outcomeDraft.trim()} onClick={doLogOutcome}>{logging ? "Logging..." : "Log Outcome"}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Week in Review (weekly boss meeting report, Reports tab)
   ============================================================ */
const addDaysLocal = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toISODate = (d) => { const x = new Date(d); const y = x.getFullYear(); const m = String(x.getMonth() + 1).padStart(2, "0"); const day = String(x.getDate()).padStart(2, "0"); return `${y}-${m}-${day}`; };
const parseISODateLocal = (s) => { const [y, m, day] = s.split("-").map(Number); return new Date(y, m - 1, day); };
const endOfDayLocal = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
// Inclusive range check: start/end are Date objects, end is the last day included.
const inWeekRange = (dateVal, start, end) => {
  if (!dateVal) return false;
  const t = new Date(dateVal).getTime();
  return t >= startOfDay(start).getTime() && t <= endOfDayLocal(end).getTime();
};

const ACT_TYPE_NOUNS = {
  call: ["call", "calls"],
  email: ["email", "emails"],
  meeting: ["meeting", "meetings"],
  scheduled_meeting: ["scheduled meeting", "scheduled meetings"],
  whatsapp: ["WhatsApp message", "WhatsApp messages"],
  linkedin: ["LinkedIn message", "LinkedIn messages"],
  note: ["note", "notes"],
  proposal: ["proposal", "proposals"],
  demo: ["demo", "demos"],
  voice_note: ["voice note", "voice notes"],
  transcript: ["transcript", "transcripts"],
};
const activityNoun = (type, count) => {
  const pair = ACT_TYPE_NOUNS[type] || [type, type];
  return count === 1 ? pair[0] : pair[1];
};

// Reconstructs stage-change history from the "Moved to X" note activities that
// moveDeal logs on every drag (there is no dedicated stage-history table).
// Walks each deal's moves chronologically, treating "prospecting" (the stage
// new deals start at) as the assumed origin before the first recorded move.
function buildStageTransitions(activities, deals) {
  const byDeal = new Map();
  activities
    .filter((a) => a.deal_id && a.type === "note" && typeof a.description === "string" && a.description.startsWith("Moved to "))
    .forEach((a) => {
      if (!byDeal.has(a.deal_id)) byDeal.set(a.deal_id, []);
      byDeal.get(a.deal_id).push(a);
    });
  const transitions = [];
  byDeal.forEach((acts, dealId) => {
    const deal = deals.find((d) => d.id === dealId);
    if (!deal) return;
    const sorted = acts.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let cursor = "prospecting";
    sorted.forEach((a) => {
      const label = a.description.slice("Moved to ".length).trim();
      const toStage = STAGES.find((s) => s.label === label);
      if (!toStage) return;
      transitions.push({ dealId, company: deal.company, tier: deal.tier, fromStage: cursor, toStage: toStage.id, date: a.created_at });
      cursor = toStage.id;
    });
  });
  return transitions;
}

const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label || id;

function DeltaBadge({ current, prior }) {
  const diff = current - prior;
  if (diff === 0) return <span className="stat-delta stat-delta-flat">No change vs last period</span>;
  const up = diff > 0;
  return (
    <span className={`stat-delta ${up ? "stat-delta-up" : "stat-delta-down"}`}>
      {up ? "↑" : "↓"} {Math.abs(diff)} vs last period
    </span>
  );
}

/* ============================================================
   Executive Update: the curated biweekly deck.
   The Week in Review is a live dashboard nobody edits; this is the
   opposite, a draft the system writes once and Fahed then owns
   completely (edit, hide, reorder, delete, add) before presenting.
   ============================================================ */

// Plain-text export, for pasting into an email or a doc.
function execPlainText(pres, blocks) {
  const lines = [pres.title || "Executive Update"];
  lines.push(`${formatDate(pres.period_start)} to ${formatDate(pres.period_end)}`);
  let section = null;
  blocks.filter((b) => !b.is_hidden).forEach((b) => {
    if (b.block_type === "header") { lines.push("", (b.title || execSectionLabel(b.section)).toUpperCase()); section = b.section; return; }
    if (b.section !== section && b.block_type !== "header") { /* keep flowing under the last header */ }
    if (b.block_type === "metric") { lines.push(`${b.title}: ${b.content || ""}`.trim()); return; }
    const title = (b.title || "").trim();
    const content = stripHtmlToText(b.content || "").trim();
    if (title && content) lines.push(`- ${title}: ${content}`);
    else if (title || content) lines.push(`- ${title || content}`);
  });
  return lines.join("\n");
}

// Slide-ready export: one block per section with bullets, so each section can
// be pasted straight onto its own slide.
function execSlideText(pres, blocks) {
  const visible = blocks.filter((b) => !b.is_hidden);
  const out = [`${pres.title || "Executive Update"}\n${formatDate(pres.period_start)} to ${formatDate(pres.period_end)}`];
  let current = null, buf = [];
  const flush = () => { if (current) out.push(`\n--- SLIDE: ${current} ---\n${buf.join("\n")}`); buf = []; };
  visible.forEach((b) => {
    if (b.block_type === "header") { flush(); current = (b.title || execSectionLabel(b.section)); return; }
    if (!current) current = execSectionLabel(b.section);
    if (b.block_type === "metric") { buf.push(`• ${b.title}: ${b.content || ""}`.trim()); return; }
    const title = (b.title || "").trim();
    const content = stripHtmlToText(b.content || "").trim();
    if (title) buf.push(`• ${title}`);
    if (content) buf.push(`   ${content}`);
  });
  flush();
  return out.join("\n");
}

// One editable block in EDIT MODE. Read state shows the rendered block with its
// controls; editing swaps it for the inline form, matching the click-to-edit
// pattern the rest of the app uses rather than opening a modal.
function ExecBlockRow({ block, onUpdate, onDelete, onDragStart, onDragOver, onDrop, isDragging, onMove, canMoveUp, canMoveDown }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(block.title || "");
  const [content, setContent] = useState(block.content || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setTitle(block.title || ""); setContent(block.content || ""); }, [block.title, block.content]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const ok = await onUpdate(block.id, { title: title.trim() || null, content: content.trim() || null });
    setSaving(false);
    if (ok !== false) setEditing(false);
  };

  const isHeader = block.block_type === "header";
  const isMetric = block.block_type === "metric";

  if (editing) {
    return (
      <div className="exec-block exec-block-editing" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }}>
        <input className="input exec-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isMetric ? "Metric label" : "Title"} autoFocus />
        {isHeader ? null : isMetric ? (
          <input className="input exec-edit-metric" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Value" />
        ) : (
          <RichTextEditor value={content} onChange={setContent} mini placeholder="What the executives should hear..." />
        )}
        <div className="exec-edit-actions">
          <button type="button" className="btn-primary" disabled={saving} onClick={save}>{saving ? "Saving..." : "Save"}</button>
          <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
          <span className="exec-edit-hint">Esc to cancel</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`exec-block exec-block-${block.block_type} ${block.is_hidden ? "exec-block-hidden" : ""} ${isDragging ? "exec-block-dragging" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className="exec-drag-handle" title="Drag to reorder">⠿</span>
      <div className="exec-block-body">
        {isHeader ? (
          <div className="exec-block-header-text">{block.title || execSectionLabel(block.section)}</div>
        ) : isMetric ? (
          <div className="exec-metric-inline">
            <span className="exec-metric-value">{block.content}</span>
            <span className="exec-metric-label">{block.title}</span>
          </div>
        ) : (
          <>
            {block.title && <div className="exec-block-title">{block.title}</div>}
            {block.content && <RichTextView value={block.content} className="exec-block-content" />}
            {block.block_type === "commentary" && <span className="exec-commentary-tag">Commentary</span>}
          </>
        )}
      </div>
      <div className="exec-block-actions">
        {/* Drag works on desktop; these arrows are the reorder path on touch,
            where HTML5 drag and drop does not fire. */}
        <button type="button" className="exec-move-btn" onClick={() => onMove(block.id, -1)} disabled={!canMoveUp} title="Move up">↑</button>
        <button type="button" className="exec-move-btn" onClick={() => onMove(block.id, 1)} disabled={!canMoveDown} title="Move down">↓</button>
        <button type="button" onClick={() => setEditing(true)} title="Edit">✎</button>
        <button type="button" onClick={() => onUpdate(block.id, { is_hidden: !block.is_hidden })} title={block.is_hidden ? "Show in presentation" : "Hide from presentation"}>
          {block.is_hidden ? "🚫" : "👁"}
        </button>
        <button type="button" className="exec-action-danger" onClick={() => { if (window.confirm("Delete this block?")) onDelete(block.id); }} title="Delete">✕</button>
      </div>
    </div>
  );
}

// "+ Add block": section, type, title, content. Also how a section header gets
// added, since a header is just a block whose type is header.
function ExecAddBlock({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState("pipeline");
  const [blockType, setBlockType] = useState("item");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!title.trim() && !content.trim()) return;
    setSaving(true);
    const ok = await onAdd({ section, block_type: blockType, title: title.trim() || null, content: content.trim() || null });
    setSaving(false);
    if (ok !== false) { setTitle(""); setContent(""); setOpen(false); }
  };

  if (!open) return <button type="button" className="link-btn exec-add-btn" onClick={() => setOpen(true)}>+ Add block</button>;
  return (
    <div className="exec-add-form" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <div className="exec-add-row">
        <label className="exec-add-field">
          <span className="exec-add-label">Section</span>
          <select className="input" value={section} onChange={(e) => setSection(e.target.value)}>
            {EXEC_SECTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="exec-add-field">
          <span className="exec-add-label">Type</span>
          <select className="input" value={blockType} onChange={(e) => setBlockType(e.target.value)}>
            {EXEC_BLOCK_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
      </div>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={blockType === "header" ? "Section header text" : "Title"} autoFocus />
      {blockType !== "header" && (blockType === "metric"
        ? <input className="input" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Value" />
        : <RichTextEditor value={content} onChange={setContent} mini placeholder="Detail..." />
      )}
      <div className="exec-edit-actions">
        <button type="button" className="btn-primary" disabled={saving || (!title.trim() && !content.trim())} onClick={submit}>{saving ? "Adding..." : "Add block"}</button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// PRESENT MODE: a clean full-screen render of the visible blocks only, sized
// for screen-share. Escape exits. Deliberately shows no controls at all, so
// nothing editable is on screen while executives are watching.
function ExecPresentView({ pres, blocks, onExit }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onExit(); };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("exec-presenting-body");
    return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("exec-presenting-body"); };
  }, [onExit]);

  const visible = blocks.filter((b) => !b.is_hidden);
  // Group into runs so each header owns the blocks that follow it, and a run of
  // metrics can render as a row of big numbers.
  const groups = [];
  visible.forEach((b) => {
    if (b.block_type === "header" || !groups.length) groups.push({ header: b.block_type === "header" ? b : null, items: b.block_type === "header" ? [] : [b] });
    else groups[groups.length - 1].items.push(b);
  });

  return (
    <div className="exec-present">
      <button type="button" className="exec-present-exit" onClick={onExit} title="Exit presentation (Esc)">✕</button>
      <div className="exec-present-inner">
        <header className="exec-present-head">
          <h1>{pres.title || "Executive Update"}</h1>
          <div className="exec-present-period">{formatDate(pres.period_start)} to {formatDate(pres.period_end)}</div>
        </header>
        {groups.map((g, i) => {
          const metrics = g.items.filter((b) => b.block_type === "metric");
          const rest = g.items.filter((b) => b.block_type !== "metric");
          return (
            <section key={i} className="exec-present-section">
              {g.header && <h2>{g.header.title || execSectionLabel(g.header.section)}</h2>}
              {metrics.length > 0 && (
                <div className="exec-present-metrics">
                  {metrics.map((m) => (
                    <div key={m.id} className="exec-present-metric">
                      <div className="exec-present-metric-value">{m.content}</div>
                      <div className="exec-present-metric-label">{m.title}</div>
                    </div>
                  ))}
                </div>
              )}
              {rest.map((b) => (
                <div key={b.id} className={`exec-present-item ${b.block_type === "commentary" ? "exec-present-commentary" : ""}`}>
                  {b.title && <div className="exec-present-item-title">{b.title}</div>}
                  {b.content && <RichTextView value={b.content} className="exec-present-item-body" />}
                </div>
              ))}
            </section>
          );
        })}
        {visible.length === 0 && <div className="exec-present-empty">Nothing to present yet. Add or unhide some blocks.</div>}
      </div>
    </div>
  );
}

function ExecUpdateTab({
  presentations, blocksFor, openId, onOpen, onCreate, generating,
  onUpdatePresentation, onDeletePresentation,
  onAddBlock, onUpdateBlock, onDeleteBlock, onReorder,
  presenting, onPresent, onExitPresent, showToast,
}) {
  const readOnly = useReadOnly();
  const [dragId, setDragId] = useState(null);
  const pres = presentations.find((p) => p.id === openId) || null;
  const blocks = pres ? blocksFor(pres.id) : [];

  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); showToast(`${label} copied`); }
    catch { showToast("Could not copy"); }
  };

  if (presenting && pres) return <ExecPresentView pres={pres} blocks={blocks} onExit={onExitPresent} />;

  // LIST VIEW
  if (!pres) {
    return (
      <div className="exec-tab">
        <div className="page-head">
          <div>
            <h1 className="page-title">Executive Update</h1>
            <p className="page-sub">The curated biweekly deck you present to the executive team.</p>
          </div>
          {!readOnly && (
            <button className="btn-primary" onClick={onCreate} disabled={generating}>
              {generating ? "Drafting..." : "+ New Biweekly Update"}
            </button>
          )}
        </div>
        {generating && <div className="exec-generating">Pulling the last two weeks and drafting your update. This takes a few seconds.</div>}
        {presentations.length === 0 && !generating ? (
          <div className="empty-small">No executive updates yet. Create one to draft it from the last two weeks.</div>
        ) : (
          <div className="exec-list">
            {presentations.map((p) => {
              const count = blocksFor(p.id).filter((b) => !b.is_hidden).length;
              return (
                <button key={p.id} type="button" className="exec-list-item" onClick={() => onOpen(p.id)}>
                  <div className="exec-list-main">
                    <div className="exec-list-title">{p.title}</div>
                    <div className="exec-list-meta">
                      {formatDate(p.period_start)} to {formatDate(p.period_end)} . {count} block{count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <span className={`badge exec-status exec-status-${p.status}`}>{p.status === "presented" ? "Presented" : "Draft"}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // EDIT VIEW
  // Shift one block by one position. Same renumber path as drag, so both
  // reorder routes end up writing the identical dense sort_order sequence.
  const move = (id, delta) => {
    const ids = blocks.map((b) => b.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorder(pres.id, ids);
  };

  const onDrop = (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = blocks.map((b) => b.id);
    const from = ids.indexOf(dragId), to = ids.indexOf(targetId);
    if (from === -1 || to === -1) { setDragId(null); return; }
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorder(pres.id, ids);
    setDragId(null);
  };

  return (
    <div className="exec-tab exec-editor">
      <div className="page-head exec-editor-head">
        <div className="exec-editor-headmain">
          <button type="button" className="btn-back" onClick={() => onOpen(null)}>← All updates</button>
          {readOnly ? (
            <h1 className="page-title">{pres.title}</h1>
          ) : (
            <input
              className="exec-title-input"
              defaultValue={pres.title}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== pres.title) onUpdatePresentation(pres.id, { title: v }); }}
            />
          )}
          <div className="exec-period">
            {readOnly ? (
              <span>{formatDate(pres.period_start)} to {formatDate(pres.period_end)}</span>
            ) : (
              <>
                <input type="date" className="input exec-date" defaultValue={pres.period_start || ""} onBlur={(e) => onUpdatePresentation(pres.id, { period_start: e.target.value || null })} />
                <span className="exec-period-to">to</span>
                <input type="date" className="input exec-date" defaultValue={pres.period_end || ""} onBlur={(e) => onUpdatePresentation(pres.id, { period_end: e.target.value || null })} />
              </>
            )}
          </div>
        </div>
        <div className="exec-editor-actions">
          <button className="btn-primary" onClick={onPresent}>Present</button>
          <button className="btn-ghost" onClick={() => copy(execPlainText(pres, blocks), "Update")}>Copy as text</button>
          <button className="btn-ghost" onClick={() => copy(execSlideText(pres, blocks), "Slides")}>Copy for slides</button>
          <button className="btn-ghost" onClick={() => window.print()}>Print</button>
          {!readOnly && (
            <>
              <button
                className="btn-ghost"
                onClick={() => onUpdatePresentation(pres.id, { status: pres.status === "presented" ? "draft" : "presented" })}
              >
                {pres.status === "presented" ? "Mark as draft" : "Mark as presented"}
              </button>
              <button className="btn-ghost exec-action-danger" onClick={() => { if (window.confirm("Delete this update and all of its blocks?")) onDeletePresentation(pres.id); }}>Delete</button>
            </>
          )}
        </div>
      </div>

      <div className="exec-blocks">
        {blocks.length === 0 && <div className="empty-small">No blocks yet. Add one below.</div>}
        {blocks.map((b) => (
          readOnly ? (
            <div key={b.id} className={`exec-block exec-block-${b.block_type} ${b.is_hidden ? "exec-block-hidden" : ""}`}>
              <div className="exec-block-body">
                {b.block_type === "header" ? <div className="exec-block-header-text">{b.title || execSectionLabel(b.section)}</div>
                  : b.block_type === "metric" ? <div className="exec-metric-inline"><span className="exec-metric-value">{b.content}</span><span className="exec-metric-label">{b.title}</span></div>
                  : <>{b.title && <div className="exec-block-title">{b.title}</div>}{b.content && <RichTextView value={b.content} className="exec-block-content" />}</>}
              </div>
            </div>
          ) : (
            <ExecBlockRow
              key={b.id}
              block={b}
              onUpdate={onUpdateBlock}
              onDelete={onDeleteBlock}
              isDragging={dragId === b.id}
              onDragStart={() => setDragId(b.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onDrop(b.id); }}
              onMove={move}
              canMoveUp={blocks.indexOf(b) > 0}
              canMoveDown={blocks.indexOf(b) < blocks.length - 1}
            />
          )
        ))}
      </div>

      {!readOnly && <ExecAddBlock onAdd={(fields) => onAddBlock(pres.id, fields)} />}
    </div>
  );
}

function WeekInReviewTab({ deals, contacts, enablers, organizations, activities, todos, todoContacts = [], bossComments, commentAuthor, onPostComment, onMarkCommentRead, calendarEvents, dealContacts, enablerContacts, networkEdges, contactRoles, onOpenInstitution, onOpenPerson, onOpenTaskLink, showToast }) {
  const readOnly = useReadOnly();
  const [start, setStart] = useState(() => startOfWeek(new Date()));
  const [end, setEnd] = useState(() => addDaysLocal(startOfWeek(new Date()), 6));
  const [showCustom, setShowCustom] = useState(false);
  const [blockers, setBlockers] = useState([]);
  const [newBlocker, setNewBlocker] = useState("");
  const [copied, setCopied] = useState(null);
  // A "Respond" click on a blocker/flag pre-loads the Comments composer below
  // with a quoted reference (and the item's entity tag, if it has one).
  const [pendingReply, setPendingReply] = useState(null); // { text, tag } | null
  const [expandedTags, setExpandedTags] = useState(() => new Set());
  const commentsRef = useRef(null);

  const weekKey = `mango-week-review-blockers-${toISODate(start)}`;
  useEffect(() => {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(weekKey) || "[]"); } catch { saved = []; }
    setBlockers(Array.isArray(saved) ? saved : []);
  }, [weekKey]);

  const persistBlockers = (list) => {
    setBlockers(list);
    try { localStorage.setItem(weekKey, JSON.stringify(list)); } catch {}
  };
  const addBlocker = () => {
    const text = newBlocker.trim();
    if (!text) return;
    persistBlockers([...blockers, text]);
    setNewBlocker("");
  };
  const removeBlocker = (idx) => persistBlockers(blockers.filter((_, i) => i !== idx));

  const rangeDays = Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86400000) + 1;
  const priorStart = addDaysLocal(start, -rangeDays);
  const priorEnd = addDaysLocal(end, -rangeDays);

  const shiftRange = (dir) => {
    setStart((s) => addDaysLocal(s, dir * rangeDays));
    setEnd((e) => addDaysLocal(e, dir * rangeDays));
  };
  const jumpToThisWeek = () => {
    setStart(startOfWeek(new Date()));
    setEnd(addDaysLocal(startOfWeek(new Date()), 6));
  };

  const ctx = { deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles };

  // Ties an institution's name back to whichever backing rows (deal/enabler/
  // organization) it has, so a comment tagged to any of them surfaces here.
  const institutionIdsFor = (name) => {
    const key = (name || "").trim().toLowerCase();
    const ids = {};
    const d = deals.find((x) => (x.company || "").trim().toLowerCase() === key);
    if (d) ids.deal_id = d.id;
    const e = enablers.find((x) => (x.name || "").trim().toLowerCase() === key);
    if (e) ids.enabler_id = e.id;
    const o = organizations.find((x) => (x.name || "").trim().toLowerCase() === key);
    if (o) ids.organization_id = o.id;
    return ids;
  };
  const unresolvedCommentsFor = (name) => {
    const ids = institutionIdsFor(name);
    if (!ids.deal_id && !ids.enabler_id && !ids.organization_id) return [];
    return bossComments.filter((c) => !c.is_read && ((ids.deal_id && c.deal_id === ids.deal_id) || (ids.enabler_id && c.enabler_id === ids.enabler_id) || (ids.organization_id && c.organization_id === ids.organization_id)));
  };
  const toggleTag = (name) => setExpandedTags((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const respondTo = (text, tag = {}) => {
    setPendingReply({ text: `Re: "${text}"\n\n`, tag });
    setTimeout(() => commentsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const commentTargetName = (c) => {
    if (c.deal_id) return deals.find((d) => d.id === c.deal_id)?.company || null;
    if (c.enabler_id) return enablers.find((e) => e.id === c.enabler_id)?.name || null;
    if (c.organization_id) return organizations.find((o) => o.id === c.organization_id)?.name || null;
    return null;
  };
  // Small inline badge next to a Pipeline Movement / Activity by Institution
  // row: shows an unresolved-comment count for that institution, and expands
  // those comments right there when clicked.
  const CommentTagBadge = ({ name }) => {
    const list = unresolvedCommentsFor(name);
    if (list.length === 0) return null;
    return (
      <button type="button" className="wir-comment-tag" onClick={(e) => { e.stopPropagation(); toggleTag(name); }} title={`${list.length} unresolved comment${list.length === 1 ? "" : "s"}`}>
        💬 {list.length}
      </button>
    );
  };
  const CommentTagInline = ({ name }) => {
    if (!expandedTags.has(name)) return null;
    const list = unresolvedCommentsFor(name);
    if (list.length === 0) return null;
    return (
      <div className="wir-comment-inline" onClick={(e) => e.stopPropagation()}>
        {list.map((c) => (
          <div key={c.id} className="wir-comment-inline-item">
            <span className="wir-comment-inline-author">{c.author}:</span>
            <span className="wir-comment-inline-text">{firstLine(c.content)}</span>
          </div>
        ))}
      </div>
    );
  };

  const weekActs = activities.filter((a) => inWeekRange(a.created_at, start, end));
  const priorActs = activities.filter((a) => inWeekRange(a.created_at, priorStart, priorEnd));

  // Section 1: headline metrics
  const newContacts = contacts.filter((c) => inWeekRange(c.created_at, start, end)).length;
  const priorNewContacts = contacts.filter((c) => inWeekRange(c.created_at, priorStart, priorEnd)).length;

  const meetingsHeld = weekActs.filter((a) => a.type === "meeting" || a.type === "scheduled_meeting").length;
  const priorMeetingsHeld = priorActs.filter((a) => a.type === "meeting" || a.type === "scheduled_meeting").length;

  const institutionKeySet = (acts) => {
    const set = new Set();
    acts.forEach((a) => { const inst = activityInstitutionInfo(a, ctx); if (inst) set.add(inst.name.toLowerCase()); });
    return set;
  };
  const institutionsEngaged = institutionKeySet(weekActs).size;
  const priorInstitutionsEngaged = institutionKeySet(priorActs).size;

  const allTransitions = buildStageTransitions(activities, deals);
  const weekTransitions = allTransitions.filter((t) => inWeekRange(t.date, start, end)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const priorTransitions = allTransitions.filter((t) => inWeekRange(t.date, priorStart, priorEnd));
  const dealsAdvanced = weekTransitions.length;
  const priorDealsAdvanced = priorTransitions.length;

  const outreachSent = weekActs.filter((a) => ["email", "linkedin", "whatsapp"].includes(a.type)).length;
  const priorOutreachSent = priorActs.filter((a) => ["email", "linkedin", "whatsapp"].includes(a.type)).length;

  // Section 2: new deals this week
  const newDeals = deals.filter((d) => inWeekRange(d.created_at, start, end));

  // Section 3: activity by institution
  const instGroups = new Map();
  weekActs.forEach((a) => {
    const inst = activityInstitutionInfo(a, ctx);
    if (!inst) return;
    const key = inst.name.toLowerCase();
    if (!instGroups.has(key)) instGroups.set(key, { name: inst.name, kind: inst.kind, count: 0, byType: {}, people: new Map() });
    const g = instGroups.get(key);
    g.count += 1;
    g.byType[a.type] = (g.byType[a.type] || 0) + 1;
    const person = activityPersonInfo(a, contacts);
    if (person) g.people.set(person.id, person.name);
  });
  const instActivity = [...instGroups.values()].sort((a, b) => b.count - a.count);

  // Section 4: new relationships
  const newPeople = contacts.filter((c) => inWeekRange(c.created_at, start, end)).map((c) => {
    const roles = resolveContactRoles(c, ctx);
    const primary = roles.find((r) => r.is_primary) || roles[0];
    return { id: c.id, name: c.name, role: c.role, institutionName: primary?.institutionName || "" };
  });
  const newInstitutions = organizations.filter((o) => inWeekRange(o.created_at, start, end)).map((o) => {
    const deal = deals.find((d) => (d.company || "").trim().toLowerCase() === (o.name || "").trim().toLowerCase());
    return { id: o.id, name: o.name, type: o.type, tier: deal?.tier || null };
  });

  // Section 5: coming up next week (the 7 days right after the selected range)
  const nextStart = addDaysLocal(end, 1);
  const nextEnd = addDaysLocal(nextStart, 6);
  const upcomingEvents = calendarEvents.filter((e) => inWeekRange(e.start_time, nextStart, nextEnd)).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const upcomingScheduled = activities.filter((a) => a.type === "scheduled_meeting" && inWeekRange(a.scheduled_for, nextStart, nextEnd)).sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));
  const upcomingTasks = todos.filter((t) => t.status === "open" && (t.priority === "high" || inWeekRange(t.due_date, nextStart, nextEnd)));
  const upcomingEventEntity = (e) => {
    if (e.matched_deal_id) { const d = deals.find((x) => x.id === e.matched_deal_id); return d ? { name: d.company } : null; }
    if (e.matched_enabler_id) { const en = enablers.find((x) => x.id === e.matched_enabler_id); return en ? { name: en.name } : null; }
    if (e.matched_organization_id) { const o = organizations.find((x) => x.id === e.matched_organization_id); return o ? { name: o.name } : null; }
    return null;
  };

  // Section 6: blockers, plus auto-surfaced flags
  const stuckDeals = deals.filter((d) => !["won", "lost"].includes(d.stage) && (!d.last_activity_at || daysAgo(d.last_activity_at) >= 14));
  const unresolvedComments = bossComments.filter((c) => c.author !== "Fahed Al Essa" && !c.is_read);

  const rangeLabel = `${formatDate(start)} to ${formatDate(end)}, ${end.getFullYear()}`;
  const deltaText = (cur, pri) => `${cur - pri >= 0 ? "+" : ""}${cur - pri} vs last period`;

  const generatePlainReport = () => {
    let r = `WEEK IN REVIEW: ${rangeLabel}\n${"=".repeat(50)}\n\n`;
    r += `HEADLINE METRICS\n`;
    r += `. New contacts added: ${newContacts} (${deltaText(newContacts, priorNewContacts)})\n`;
    r += `. Meetings held: ${meetingsHeld} (${deltaText(meetingsHeld, priorMeetingsHeld)})\n`;
    r += `. Institutions engaged: ${institutionsEngaged} (${deltaText(institutionsEngaged, priorInstitutionsEngaged)})\n`;
    r += `. Deals advanced: ${dealsAdvanced} (${deltaText(dealsAdvanced, priorDealsAdvanced)})\n`;
    r += `. Outreach sent: ${outreachSent} (${deltaText(outreachSent, priorOutreachSent)})\n\n`;

    r += `PIPELINE MOVEMENT\n`;
    if (weekTransitions.length === 0) r += `. No stage changes this period.\n`;
    weekTransitions.forEach((t) => { r += `. ${t.company} (${t.tier || "Untiered"}): ${stageLabel(t.fromStage)} to ${stageLabel(t.toStage)}, ${formatDate(t.date)}\n`; });
    if (newDeals.length > 0) { r += `\nNEW TO PIPELINE\n`; newDeals.forEach((d) => { r += `. ${d.company} (${d.tier || "Untiered"})\n`; }); }
    r += `\n`;

    r += `ACTIVITY BY INSTITUTION\n`;
    if (instActivity.length === 0) r += `. No activity logged this period.\n`;
    instActivity.forEach((g) => {
      const parts = Object.entries(g.byType).map(([t, c]) => `${c} ${activityNoun(t, c)}`).join(", ");
      const people = [...g.people.values()].join(", ");
      r += `. ${g.name}: ${parts}${people ? ` (${people})` : ""}\n`;
    });
    r += `\n`;

    r += `NEW RELATIONSHIPS\n`;
    if (newPeople.length === 0 && newInstitutions.length === 0) r += `. None this period.\n`;
    newPeople.forEach((p) => { r += `. ${p.name}${p.role ? `, ${p.role}` : ""}${p.institutionName ? ` at ${p.institutionName}` : ""}\n`; });
    newInstitutions.forEach((i) => { r += `. ${i.name} (${institutionTypeMeta(i.type).label}${i.tier ? `, ${i.tier}` : ""})\n`; });
    r += `\n`;

    r += `COMING UP NEXT WEEK\n`;
    if (upcomingEvents.length === 0 && upcomingScheduled.length === 0 && upcomingTasks.length === 0) r += `. Nothing scheduled yet.\n`;
    upcomingEvents.forEach((e) => { r += `. ${formatDate(e.start_time)}: ${e.title || "Untitled event"}\n`; });
    upcomingScheduled.forEach((a) => { r += `. ${formatDate(a.scheduled_for)}: ${firstLine(cleanActivityText(a.description)) || "Scheduled meeting"}\n`; });
    if (upcomingTasks.length > 0) { r += `Tasks:\n`; upcomingTasks.forEach((t) => { r += `. ${t.title}${t.due_date ? ` (due ${formatDate(t.due_date)})` : ""}\n`; }); }
    r += `\n`;

    r += `BLOCKERS AND DECISIONS NEEDED\n`;
    if (blockers.length === 0 && stuckDeals.length === 0 && unresolvedComments.length === 0) r += `. None flagged.\n`;
    blockers.forEach((b) => { r += `. ${b}\n`; });
    stuckDeals.forEach((d) => { r += `. ${d.company}: no activity in ${d.last_activity_at ? `${daysAgo(d.last_activity_at)} days` : "a while"}, may need attention\n`; });
    unresolvedComments.forEach((c) => { r += `. Unresolved comment from ${c.author}: ${firstLine(c.content)}\n`; });

    return r;
  };

  const generateHtmlReport = () => {
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let h = `<div style="font-family:-apple-system,Arial,sans-serif;color:#2A2620;max-width:640px;">`;
    h += `<h2 style="margin-bottom:2px;">Week in Review</h2><div style="color:#8A8072;margin-bottom:16px;">${esc(rangeLabel)}</div>`;
    h += `<h3>Headline Metrics</h3><ul>`;
    h += `<li>New contacts added: <b>${newContacts}</b> (${esc(deltaText(newContacts, priorNewContacts))})</li>`;
    h += `<li>Meetings held: <b>${meetingsHeld}</b> (${esc(deltaText(meetingsHeld, priorMeetingsHeld))})</li>`;
    h += `<li>Institutions engaged: <b>${institutionsEngaged}</b> (${esc(deltaText(institutionsEngaged, priorInstitutionsEngaged))})</li>`;
    h += `<li>Deals advanced: <b>${dealsAdvanced}</b> (${esc(deltaText(dealsAdvanced, priorDealsAdvanced))})</li>`;
    h += `<li>Outreach sent: <b>${outreachSent}</b> (${esc(deltaText(outreachSent, priorOutreachSent))})</li>`;
    h += `</ul>`;

    h += `<h3>Pipeline Movement</h3>`;
    if (weekTransitions.length === 0) h += `<p>No stage changes this period.</p>`;
    else { h += `<ul>`; weekTransitions.forEach((t) => { h += `<li>${esc(t.company)} (${esc(t.tier || "Untiered")}): ${esc(stageLabel(t.fromStage))} to ${esc(stageLabel(t.toStage))}, ${esc(formatDate(t.date))}</li>`; }); h += `</ul>`; }
    if (newDeals.length > 0) { h += `<p><b>New to Pipeline</b></p><ul>`; newDeals.forEach((d) => { h += `<li>${esc(d.company)} (${esc(d.tier || "Untiered")})</li>`; }); h += `</ul>`; }

    h += `<h3>Activity by Institution</h3>`;
    if (instActivity.length === 0) h += `<p>No activity logged this period.</p>`;
    else { h += `<ul>`; instActivity.forEach((g) => { const parts = Object.entries(g.byType).map(([t, c]) => `${c} ${activityNoun(t, c)}`).join(", "); const people = [...g.people.values()].join(", "); h += `<li>${esc(g.name)}: ${esc(parts)}${people ? ` (${esc(people)})` : ""}</li>`; }); h += `</ul>`; }

    h += `<h3>New Relationships</h3>`;
    if (newPeople.length === 0 && newInstitutions.length === 0) h += `<p>None this period.</p>`;
    else {
      h += `<ul>`;
      newPeople.forEach((p) => { h += `<li>${esc(p.name)}${p.role ? `, ${esc(p.role)}` : ""}${p.institutionName ? ` at ${esc(p.institutionName)}` : ""}</li>`; });
      newInstitutions.forEach((i) => { h += `<li>${esc(i.name)} (${esc(institutionTypeMeta(i.type).label)}${i.tier ? `, ${esc(i.tier)}` : ""})</li>`; });
      h += `</ul>`;
    }

    h += `<h3>Coming Up Next Week</h3>`;
    if (upcomingEvents.length === 0 && upcomingScheduled.length === 0 && upcomingTasks.length === 0) h += `<p>Nothing scheduled yet.</p>`;
    else {
      h += `<ul>`;
      upcomingEvents.forEach((e) => { h += `<li>${esc(formatDate(e.start_time))}: ${esc(e.title || "Untitled event")}</li>`; });
      upcomingScheduled.forEach((a) => { h += `<li>${esc(formatDate(a.scheduled_for))}: ${esc(firstLine(cleanActivityText(a.description)) || "Scheduled meeting")}</li>`; });
      h += `</ul>`;
      if (upcomingTasks.length > 0) { h += `<p><b>Tasks</b></p><ul>`; upcomingTasks.forEach((t) => { h += `<li>${esc(t.title)}${t.due_date ? ` (due ${esc(formatDate(t.due_date))})` : ""}</li>`; }); h += `</ul>`; }
    }

    h += `<h3>Blockers and Decisions Needed</h3>`;
    if (blockers.length === 0 && stuckDeals.length === 0 && unresolvedComments.length === 0) h += `<p>None flagged.</p>`;
    else {
      h += `<ul>`;
      blockers.forEach((b) => { h += `<li>${esc(b)}</li>`; });
      stuckDeals.forEach((d) => { h += `<li>${esc(d.company)}: no activity in ${d.last_activity_at ? `${daysAgo(d.last_activity_at)} days` : "a while"}, may need attention</li>`; });
      unresolvedComments.forEach((c) => { h += `<li>Unresolved comment from ${esc(c.author)}: ${esc(firstLine(c.content))}</li>`; });
      h += `</ul>`;
    }

    h += `</div>`;
    return h;
  };

  const copyPlain = () => {
    navigator.clipboard.writeText(generatePlainReport()).then(() => {
      setCopied("plain"); showToast && showToast("Report copied"); setTimeout(() => setCopied(null), 2000);
    });
  };
  const copyEmail = () => {
    const text = generatePlainReport();
    if (window.ClipboardItem) {
      const html = generateHtmlReport();
      const item = new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      });
      navigator.clipboard.write([item]).then(() => {
        setCopied("email"); showToast && showToast("Email-ready report copied"); setTimeout(() => setCopied(null), 2000);
      }).catch(() => {
        navigator.clipboard.writeText(text).then(() => { setCopied("email"); setTimeout(() => setCopied(null), 2000); });
      });
    } else {
      navigator.clipboard.writeText(text).then(() => { setCopied("email"); setTimeout(() => setCopied(null), 2000); });
    }
  };

  return (
    <div className="section-pad wir">
      <div className="page-header wir-header">
        <div>
          <div className="page-title">Week in Review</div>
          <div className="page-sub">{readOnly ? "Fahed's week: what moved, what's next, and what needs your input." : "A live dashboard for the Tuesday call, and a copy/send version for Andy beforehand."}</div>
        </div>
        <div className="wir-actions">
          {!readOnly && <button className="btn-copy btn-copy-lg" onClick={copyPlain}>{copied === "plain" ? "Copied!" : "Copy Report"}</button>}
          <button className="btn-copy" onClick={copyEmail}>{copied === "email" ? "Copied!" : "Copy for Email"}</button>
        </div>
      </div>

      <div className="wir-range-bar">
        <button type="button" className="wir-range-arrow" onClick={() => shiftRange(-1)} title="Previous period">‹</button>
        <div className="wir-range-label">{rangeLabel}</div>
        <button type="button" className="wir-range-arrow" onClick={() => shiftRange(1)} title="Next period">›</button>
        <button type="button" className="wir-range-btn" onClick={jumpToThisWeek}>This week</button>
        <button type="button" className="wir-range-btn" onClick={() => setShowCustom((v) => !v)}>{showCustom ? "Hide custom range" : "Custom range"}</button>
      </div>
      {showCustom && (
        <div className="wir-custom-range">
          <label>From <input type="date" value={toISODate(start)} onChange={(e) => e.target.value && setStart(parseISODateLocal(e.target.value))} /></label>
          <label>To <input type="date" value={toISODate(end)} onChange={(e) => e.target.value && setEnd(parseISODateLocal(e.target.value))} /></label>
        </div>
      )}

      <div className="stats-bar wir-metrics">
        <div className="stat">
          <div className="stat-label">New Contacts</div>
          <div className="stat-value">{newContacts}</div>
          <DeltaBadge current={newContacts} prior={priorNewContacts} />
        </div>
        <div className="stat">
          <div className="stat-label">Meetings Held</div>
          <div className="stat-value">{meetingsHeld}</div>
          <DeltaBadge current={meetingsHeld} prior={priorMeetingsHeld} />
        </div>
        <div className="stat">
          <div className="stat-label">Institutions Engaged</div>
          <div className="stat-value">{institutionsEngaged}</div>
          <DeltaBadge current={institutionsEngaged} prior={priorInstitutionsEngaged} />
        </div>
        <div className="stat">
          <div className="stat-label">Deals Advanced</div>
          <div className="stat-value">{dealsAdvanced}</div>
          <DeltaBadge current={dealsAdvanced} prior={priorDealsAdvanced} />
        </div>
        <div className="stat">
          <div className="stat-label">Outreach Sent</div>
          <div className="stat-value">{outreachSent}</div>
          <DeltaBadge current={outreachSent} prior={priorOutreachSent} />
        </div>
      </div>

      <div className="wir-section">
        <div className="wir-section-title">Pipeline Movement</div>
        {weekTransitions.length === 0 ? (
          <div className="wir-empty">No stage changes this period.</div>
        ) : (
          <div className="wir-list">
            {weekTransitions.map((t, i) => {
              const tierMeta = DEAL_TIERS.find((x) => x.id === t.tier) || DEAL_TIERS[DEAL_TIERS.length - 1];
              return (
                <div key={i} className="wir-row-wrap">
                  <div className="wir-row wir-row-click" onClick={() => onOpenInstitution(t.company)}>
                    <div className="wir-row-main">
                      <span className="wir-row-name">{t.company}</span>
                      <span className="badge" style={{ background: tierMeta.bg, color: tierMeta.fg, border: `1px solid ${tierMeta.fg}44` }}>{tierMeta.label}</span>
                      <CommentTagBadge name={t.company} />
                    </div>
                    <div className="wir-row-detail">{stageLabel(t.fromStage)} to {stageLabel(t.toStage)}</div>
                    <div className="wir-row-date">{formatDate(t.date)}</div>
                  </div>
                  <CommentTagInline name={t.company} />
                </div>
              );
            })}
          </div>
        )}
        {newDeals.length > 0 && (
          <>
            <div className="wir-subhead">New to Pipeline</div>
            <div className="wir-list">
              {newDeals.map((d) => {
                const tierMeta = DEAL_TIERS.find((x) => x.id === d.tier) || DEAL_TIERS[DEAL_TIERS.length - 1];
                return (
                  <div key={d.id} className="wir-row wir-row-click" onClick={() => onOpenInstitution(d.company)}>
                    <div className="wir-row-main">
                      <span className="wir-row-name">{d.company}</span>
                      <span className="badge" style={{ background: tierMeta.bg, color: tierMeta.fg, border: `1px solid ${tierMeta.fg}44` }}>{tierMeta.label}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="wir-section">
        <div className="wir-section-title">Activity by Institution</div>
        {instActivity.length === 0 ? (
          <div className="wir-empty">No activity logged this period.</div>
        ) : (
          <div className="wir-list">
            {instActivity.map((g) => (
              <div key={g.name} className="wir-row-wrap">
                <div className="wir-row">
                  <button type="button" className={`task-pill task-pill-${g.kind}`} onClick={() => onOpenInstitution(g.name)}>{g.name}</button>
                  <CommentTagBadge name={g.name} />
                  <div className="wir-row-detail">{Object.entries(g.byType).map(([t, c]) => `${c} ${activityNoun(t, c)}`).join(", ")}</div>
                  {g.people.size > 0 && <div className="wir-row-people">{[...g.people.values()].join(", ")}</div>}
                </div>
                <CommentTagInline name={g.name} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="wir-section">
        <div className="wir-section-title">New Relationships</div>
        {(newPeople.length === 0 && newInstitutions.length === 0) ? (
          <div className="wir-empty">No new people or institutions this period.</div>
        ) : (
          <>
            {newPeople.length > 0 && (
              <div className="wir-list">
                {newPeople.map((p) => (
                  <div key={p.id} className="wir-row wir-row-click" onClick={() => onOpenPerson(p.id)}>
                    <span className="wir-row-name">{p.name}</span>
                    <span className="wir-row-detail">{p.role}{p.institutionName ? ` at ${p.institutionName}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
            {newInstitutions.length > 0 && (
              <div className="wir-list">
                {newInstitutions.map((i) => {
                  const meta = institutionTypeMeta(i.type);
                  return (
                    <div key={i.id} className="wir-row wir-row-click" onClick={() => onOpenInstitution(i.name)}>
                      <span className="wir-row-name">{i.name}</span>
                      <span className="badge" style={{ background: meta.color + "22", color: meta.color, border: `1px solid ${meta.color}44` }}>{meta.label}</span>
                      {i.tier && <span className="badge">{i.tier}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="wir-section">
        <div className="wir-section-title">Coming Up Next Week</div>
        {(upcomingEvents.length === 0 && upcomingScheduled.length === 0 && upcomingTasks.length === 0) ? (
          <div className="wir-empty">Nothing scheduled yet.</div>
        ) : (
          <div className="wir-list">
            {upcomingEvents.map((e) => {
              const inst = upcomingEventEntity(e);
              const clickable = !!inst || !!e.matched_contact_id;
              return (
                <div key={`ev-${e.id}`} className={`wir-row ${clickable ? "wir-row-click" : ""}`} onClick={() => { if (inst) onOpenInstitution(inst.name); else if (e.matched_contact_id) onOpenPerson(e.matched_contact_id); }}>
                  <span className="wir-row-name">{e.title || "Untitled event"}</span>
                  <span className="wir-row-detail">{formatDateTime(e.start_time)}</span>
                </div>
              );
            })}
            {upcomingScheduled.map((a) => (
              <div key={`sm-${a.id}`} className="wir-row">
                <span className="wir-row-name">{firstLine(cleanActivityText(a.description)) || "Scheduled meeting"}</span>
                <span className="wir-row-detail">{formatDateTime(a.scheduled_for)}</span>
              </div>
            ))}
            {upcomingTasks.length > 0 && (
              <>
                <div className="wir-subhead">Tasks</div>
                {upcomingTasks.map((t) => (
                  <div key={t.id} className="wir-row">
                    <span className="wir-row-name">{t.title}</span>
                    <PriorityBadge priority={t.priority} />
                    {t.due_date && <span className="wir-row-detail">Due {formatDate(t.due_date)}</span>}
                    <TaskPills todo={t} deals={deals} enablers={enablers} organizations={organizations} contacts={contacts} todoContacts={todoContacts} onNavigate={onOpenTaskLink} />
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div className={`wir-section ${readOnly ? "wir-blockers-prominent" : ""}`}>
        <div className="wir-section-title">Blockers and Decisions Needed{readOnly && <span className="wir-blockers-tag">Your action list</span>}</div>
        <div className="wir-blockers-list">
          {blockers.map((b, i) => (
            <div key={i} className="wir-blocker-item">
              <span>{b}</span>
              <div className="wir-blocker-item-actions">
                {readOnly && <button type="button" className="btn-copy" onClick={() => respondTo(b)}>Respond</button>}
                {!readOnly && <button type="button" className="wir-blocker-remove" onClick={() => removeBlocker(i)} title="Remove">✕</button>}
              </div>
            </div>
          ))}
          {blockers.length === 0 && <div className="wir-empty">Nothing flagged for input this period.</div>}
        </div>
        {!readOnly && (
          <div className="wir-blocker-add">
            <input type="text" value={newBlocker} onChange={(e) => setNewBlocker(e.target.value)} placeholder="Add an item for Andy's input..." onKeyDown={(e) => { if (e.key === "Enter") addBlocker(); }} />
            <button type="button" className="btn-copy" onClick={addBlocker}>Add</button>
          </div>
        )}
        {(stuckDeals.length > 0 || unresolvedComments.length > 0) && <div className="wir-subhead">Auto-flagged</div>}
        {stuckDeals.length > 0 && (
          <div className="wir-list">
            {stuckDeals.map((d) => (
              <div key={d.id} className="wir-row wir-row-flag">
                <div className="wir-row-click" onClick={() => onOpenInstitution(d.company)} style={{ flex: 1 }}>
                  <span className="wir-row-name">{d.company}</span>
                  <span className="wir-row-detail">May need attention: no activity in {d.last_activity_at ? `${daysAgo(d.last_activity_at)} days` : "a while"}</span>
                </div>
                {readOnly && <button type="button" className="btn-copy" onClick={() => respondTo(`${d.company}: no activity in ${d.last_activity_at ? `${daysAgo(d.last_activity_at)} days` : "a while"}`, institutionIdsFor(d.company))}>Respond</button>}
              </div>
            ))}
          </div>
        )}
        {unresolvedComments.length > 0 && (
          <div className="wir-list">
            {unresolvedComments.map((c) => (
              <div key={c.id} className="wir-row wir-row-flag">
                <span className="wir-row-name">Comment from {c.author}</span>
                <span className="wir-row-detail">{firstLine(c.content)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="wir-section wir-comments-section" ref={commentsRef}>
        <div className="wir-section-title">Comments</div>
        <div className="page-sub wir-comments-sub">Between Fahed and Andy, right here on the report.</div>
        <WeekInReviewComments
          comments={bossComments}
          author={commentAuthor}
          onPost={onPostComment}
          onMarkRead={onMarkCommentRead}
          readOnly={readOnly}
          targetName={commentTargetName}
          pendingReply={pendingReply}
          onConsumeReply={() => setPendingReply(null)}
        />
      </div>
    </div>
  );
}

// The Week in Review's always-visible comment thread (item 3): the same
// two-way conversation as the floating CommentPanel, but shown inline so the
// report and the discussion around it live on one page. A "Respond" click
// elsewhere on the page pre-fills the composer via pendingReply.
function WeekInReviewComments({ comments, author, onPost, onMarkRead, readOnly, targetName, pendingReply, onConsumeReply }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const textareaRef = useRef(null);
  const markedRef = useRef(new Set());
  const sorted = [...comments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  useEffect(() => {
    if (!pendingReply) return;
    setText(pendingReply.text);
    textareaRef.current?.focus();
  }, [pendingReply]);

  // Fahed viewing this section marks Andy's comments read (item 6). Andy's own
  // view never marks Fahed's comments read here (no onMarkRead is passed in).
  useEffect(() => {
    if (!onMarkRead) return;
    comments.forEach((c) => {
      if (!c.is_read && c.author !== author && !markedRef.current.has(c.id)) {
        markedRef.current.add(c.id);
        onMarkRead(c.id);
      }
    });
  }, [comments, author, onMarkRead]);

  const send = async () => {
    const t = text.trim();
    if (!t || posting) return;
    setPosting(true);
    try {
      await onPost({ author, content: t, ...(pendingReply?.tag || {}) });
      setText("");
      if (pendingReply) onConsumeReply();
    } finally { setPosting(false); }
  };

  return (
    <div className="wir-comments">
      <div className="comment-compose wir-comment-compose">
        <textarea ref={textareaRef} className="input comment-compose-input" placeholder={readOnly ? "Leave a note for Fahed..." : "Reply to Andy..."} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
        <button className="btn-primary" onClick={send} disabled={posting || !text.trim()}>Send</button>
      </div>
      {pendingReply?.text && (text === pendingReply.text) && <div className="wir-comment-replying">Replying to the item above</div>}
      <div className="comment-feed wir-comment-feed">
        {sorted.length === 0 && <div className="empty-small">No comments yet. Start the conversation.</div>}
        {sorted.map((c) => {
          const tName = targetName ? targetName(c) : null;
          return (
            <div key={c.id} className="boss-comment">
              <Avatar name={c.author} size={32} />
              <div className="boss-comment-main">
                <div className="boss-comment-meta"><span className="boss-comment-author">{c.author}</span><span className="boss-comment-time">{formatDateTime(c.created_at)}</span></div>
                {tName && <div className="comment-target-chip">re: {tName}</div>}
                {c.content && <div className="boss-comment-text">{c.content}</div>}
                {c.file_data && (String(c.file_data).startsWith("data:image")
                  ? <img className="boss-comment-img" src={c.file_data} alt={c.file_name || "attachment"} />
                  : <a className="boss-comment-file" href={c.file_data} download={c.file_name || "file"}>📎 {c.file_name || "Download attachment"}</a>)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   Materials Library (Feature 1)
   ============================================================ */

// Reads a picked file into a base64 data URL, rejecting anything over 5MB.
const readMaterialFile = (file) => new Promise((resolve, reject) => {
  if (file.size > MAX_MATERIAL_BYTES) { reject(new Error("too_large")); return; }
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error("read_failed"));
  reader.readAsDataURL(file);
});

function MaterialTypeBadge({ type }) {
  const m = materialTypeMeta(type);
  return <span className="badge" style={{ background: m.color + "22", color: m.color, border: `1px solid ${m.color}44` }}>{m.label}</span>;
}

function MaterialUploadForm({ onSave, onCancel, showToast }) {
  const [file, setFile] = useState(null); // { file_name, file_data, file_size, mime_type }
  const [name, setName] = useState("");
  const [type, setType] = useState("one_pager");
  const [audience, setAudience] = useState("general");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const dataUrl = await readMaterialFile(f);
      setFile({ file_name: f.name, file_data: dataUrl, file_size: f.size, mime_type: f.type || "application/octet-stream" });
      // Auto-fill the name from the filename (sans extension), still editable.
      if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ""));
    } catch (err) {
      showToast(err.message === "too_large" ? "File too large. Keep materials under 5MB." : "Could not read that file.");
    }
  };

  const submit = async () => {
    if (!file || !name.trim() || saving) return;
    setSaving(true);
    try { await onSave({ name, type, audience, version, notes, ...file }); onCancel(); }
    finally { setSaving(false); }
  };

  return (
    <div className="material-form">
      <input ref={fileRef} type="file" accept=".pdf,.pptx,.docx,.doc,.ppt,image/*,application/pdf" className="photo-input-hidden" onChange={pick} />
      <div className="material-form-file">
        <button className="btn-sec" onClick={() => fileRef.current?.click()}>{file ? "Change file" : "Choose file..."}</button>
        {file && <span className="material-form-filename">{file.file_name} ({formatBytes(file.file_size)})</span>}
      </div>
      <div className="material-form-row">
        <input className="input material-form-name" placeholder="Material name..." value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          {MATERIAL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>
          {MATERIAL_AUDIENCES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <input className="input material-form-version" placeholder="Version (e.g. v2)" value={version} onChange={(e) => setVersion(e.target.value)} />
      </div>
      <textarea className="input material-form-notes" placeholder="Notes (optional)..." value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="task-form-actions">
        <button className="btn-sec" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={!file || !name.trim() || saving}>{saving ? "Uploading..." : "Upload"}</button>
      </div>
    </div>
  );
}

function MaterialCard({ material: m, onUpdate, onDelete, onDownload }) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ name: m.name, type: m.type, audience: m.audience || "general", version: m.version || "" });
  const startEdit = () => { setF({ name: m.name, type: m.type, audience: m.audience || "general", version: m.version || "" }); setEditing(true); };
  const save = () => {
    if (!f.name.trim()) return;
    onUpdate(m.id, { name: f.name.trim(), type: f.type, audience: f.audience, version: f.version.trim() || null });
    setEditing(false);
  };
  if (editing) {
    return (
      <div className="material-card material-card-editing">
        <input className="input" value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
        <div className="material-edit-row">
          <select className="input" value={f.type} onChange={(e) => setF((p) => ({ ...p, type: e.target.value }))}>
            {MATERIAL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <select className="input" value={f.audience} onChange={(e) => setF((p) => ({ ...p, audience: e.target.value }))}>
            {MATERIAL_AUDIENCES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <input className="input material-form-version" placeholder="Version" value={f.version} onChange={(e) => setF((p) => ({ ...p, version: e.target.value }))} />
        </div>
        <div className="task-form-actions">
          <button className="btn-sec" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={!f.name.trim()}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <div className="material-card">
      <div className="material-card-top">
        <div className="material-name">{m.name}</div>
        <MaterialTypeBadge type={m.type} />
      </div>
      <div className="material-meta-row">
        {m.audience && <span className="material-audience">{materialAudienceLabel(m.audience)}</span>}
        {m.version && <span className="material-version">{m.version}</span>}
      </div>
      {m.notes && <div className="material-notes">{m.notes}</div>}
      <div className="material-file-row">
        {m.file_size ? <span>{formatBytes(m.file_size)}</span> : null}
        <span>Uploaded {formatDate(m.created_at)}</span>
      </div>
      <div className="material-actions">
        <button className="btn-copy" onClick={() => onDownload(m)}>Download</button>
        {!readOnly && <button className="btn-copy" onClick={startEdit}>Edit</button>}
        {!readOnly && <button className="btn-copy material-delete" onClick={() => { if (confirm(`Delete "${m.name}"?`)) onDelete(m.id); }}>Delete</button>}
      </div>
    </div>
  );
}

function MaterialsTab({ materials, onUpload, onUpdate, onDelete, onDownload, showToast }) {
  const readOnly = useReadOnly();
  const [uploading, setUploading] = useState(false);
  return (
    <div className="section-pad">
      <div className="page-header" style={{ padding: "0 0 16px" }}>
        <div>
          <div className="page-title">Materials</div>
          <div className="page-sub">Sales collateral, ready to share</div>
        </div>
        {!readOnly && <button className="btn-primary" onClick={() => setUploading((u) => !u)}>{uploading ? "Cancel" : "+ Upload Material"}</button>}
      </div>
      {uploading && <MaterialUploadForm onSave={onUpload} onCancel={() => setUploading(false)} showToast={showToast} />}
      {materials.length === 0 ? (
        <div className="empty-state">No materials yet. Upload your first one-pager or deck.</div>
      ) : (
        <div className="materials-grid">
          {materials.map((m) => <MaterialCard key={m.id} material={m} onUpdate={onUpdate} onDelete={onDelete} onDownload={onDownload} />)}
        </div>
      )}
    </div>
  );
}

// "Materials" section on the unified Institution Sheet: materials linked to any
// of the institution's backing rows, plus an attach picker over the library.
function MaterialsSection({ materials = [], links = [], onAttach, onRemoveLink, onDownload }) {
  const readOnly = useReadOnly();
  const [picking, setPicking] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const linked = links
    .map((l) => ({ link: l, material: materials.find((m) => m.id === l.material_id) }))
    .filter((x) => x.material);
  const linkedIds = new Set(linked.map((x) => x.material.id));
  const attachable = materials.filter((m) => !linkedIds.has(m.id));
  const attach = async (materialId) => {
    if (attaching) return;
    setAttaching(true);
    try { await onAttach(materialId); setPicking(false); } finally { setAttaching(false); }
  };
  return (
    <div className="people-section">
      <div className="ai-summary-header">
        <div className="section-label">Materials</div>
        {!readOnly && onAttach && <button className="btn-copy" onClick={() => setPicking((p) => !p)}>{picking ? "Cancel" : "Attach Material"}</button>}
      </div>
      {picking && (
        <div className="material-picker">
          {attachable.length === 0 ? (
            <div className="empty-small">Every library material is already attached (or the library is empty).</div>
          ) : attachable.map((m) => (
            <button key={m.id} className="material-picker-row" onClick={() => attach(m.id)} disabled={attaching}>
              <span className="material-picker-name">{m.name}</span>
              <MaterialTypeBadge type={m.type} />
              {m.version && <span className="material-version">{m.version}</span>}
            </button>
          ))}
        </div>
      )}
      {linked.length === 0 ? (
        <div className="empty-small">No materials attached yet.</div>
      ) : (
        <div className="material-links-list">
          {linked.map(({ link, material: m }) => (
            <div key={link.id} className="material-link-row">
              <span className="material-picker-name">{m.name}</span>
              {m.version && <span className="material-version">{m.version}</span>}
              <button className="material-dl-btn" title="Download" onClick={() => onDownload(m)}>⬇</button>
              {!readOnly && <button className="person-remove" title="Remove" onClick={() => onRemoveLink(link.id)}>✕</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Meeting Prep Briefs (Feature 2)
   ============================================================ */

// Full brief viewer: AI sections rendered with the structured formatter, an
// editable "My Goal" field, related materials, and a Regenerate link.
function BriefModal({ brief, entityName, relatedMaterials = [], onDownloadMaterial, onSaveGoal, onRegenerate, onSwitchType, onDelete, onOpenEntity, readOnly, onClose }) {
  const [goal, setGoal] = useState(brief.my_goal || "");
  useEffect(() => { setGoal(brief.my_goal || ""); }, [brief.id]);
  const linkedName = entityName(brief);
  const isInternal = brief.brief_type === "internal";
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal brief-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="brief-type-row">
              <span className={`badge brief-type-badge ${isInternal ? "brief-type-internal" : "brief-type-external"}`}>{isInternal ? "Internal Team Brief" : "External Meeting Brief"}</span>
              {onSwitchType && <button type="button" className="link-btn brief-switch-type" onClick={onSwitchType}>Switch to {isInternal ? "External" : "Internal"}</button>}
            </div>
            <div className="modal-title">{brief.meeting_title || "Meeting brief"}</div>
            <div className="brief-sub">
              {brief.meeting_date && <span>{formatDateTime(brief.meeting_date)}</span>}
              {linkedName && <button className="home-tag" onClick={() => onOpenEntity(brief)}>{linkedName}</button>}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="brief-body">
          <FormattedActivityBody lines={(brief.brief_content || "No content.").split("\n")} />
        </div>

        <div className="brief-goal">
          <div className="section-label">My Goal for This Meeting</div>
          {readOnly ? (
            <div className="notes-readonly">{brief.my_goal || "No goal set."}</div>
          ) : (
            <textarea
              className="input brief-goal-input"
              placeholder="What do I want out of this meeting?"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onBlur={() => { if ((goal || "") !== (brief.my_goal || "")) onSaveGoal(goal.trim()); }}
            />
          )}
        </div>

        <div className="brief-materials">
          <div className="section-label">Related Materials</div>
          {relatedMaterials.length === 0 ? (
            <div className="empty-small">No materials linked to this deal or institution.</div>
          ) : (
            <div className="material-links-list">
              {relatedMaterials.map((m) => (
                <div key={m.id} className="material-link-row">
                  <span className="material-picker-name">{m.name}</span>
                  {m.version && <span className="material-version">{m.version}</span>}
                  <button className="material-dl-btn" title="Download" onClick={() => onDownloadMaterial(m)}>⬇</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="brief-footer">
          <span className="brief-created">Generated {formatDateTime(brief.created_at)}</span>
          <div className="brief-footer-actions">
            {onDelete && <button className="link-btn brief-delete" onClick={onDelete}>Delete</button>}
            {onRegenerate && <button className="link-btn" onClick={onRegenerate}>Regenerate</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Manual "+ New Brief": pick a contact or an institution, set title and date.
function NewBriefForm({ contacts, institutions, onCancel, onCreate }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [contactId, setContactId] = useState("");
  const [instKey, setInstKey] = useState("");
  const submit = () => {
    if (!title.trim() || (!contactId && !instKey)) return;
    const form = { meeting_title: title.trim(), meeting_date: date || null };
    if (contactId) form.contact_id = contactId;
    const inst = instKey ? institutions.find((i) => i.key === instKey) : null;
    const p = institutionPrimaryEntity(inst);
    if (p) form[`${p.type}_id`] = p.id;
    onCreate(form);
  };
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">New Meeting Brief</div>
          <button className="close-btn" onClick={onCancel}>✕</button>
        </div>
        <div className="form-grid">
          <div className="field-full"><label className="label">Meeting title</label><input className="input" placeholder="e.g. Intro call with KFSHRC" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field-full"><label className="label">Date</label><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field-full"><label className="label">Contact</label>
            <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">No contact</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field-full"><label className="label">Institution</label>
            <select className="input" value={instKey} onChange={(e) => setInstKey(e.target.value)}>
              <option value="">No institution</option>
              {institutions.map((i) => <option key={i.key} value={i.key}>{i.name}</option>)}
            </select>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn-sec" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={!title.trim() || (!contactId && !instKey)}>Generate Brief</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Outreach Engine (templates, compose, follow-ups)
   ============================================================ */

function OutreachStatusSelect({ contact, onSetStatus }) {
  const m = outreachStatusMeta(contact.outreach_status);
  return (
    <select
      className="outreach-status-select"
      value={contact.outreach_status || "not_contacted"}
      onChange={(e) => onSetStatus(contact.id, e.target.value)}
      style={{ color: m.color, borderColor: m.color + "55", background: m.color + "14" }}
      title="Change outreach status"
    >
      {OUTREACH_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
  );
}

// Whether a contact has the contact detail a given channel actually needs.
const channelHasTarget = (c, ch) => {
  if (ch === "email") return !!(c.email || "").trim();
  if (ch === "linkedin") return !!(c.linkedin || "").trim();
  if (ch === "phone" || ch === "whatsapp") return !!(c.phone || "").trim();
  return false;
};
const channelMissingLabel = (ch) => (ch === "email" ? "No email" : ch === "linkedin" ? "No LinkedIn URL" : "No phone");

// One row on the Follow-ups dashboard.
function FollowupRow({ contact, channel, institution, daysWaiting, showMarkReplied, onSetStatus, onOpenPerson, onOpenInstitution, action }) {
  const cm = outreachChannelMeta(channel);
  return (
    <div className="followup-row">
      <Avatar name={contact.name} size={32} />
      <div className="followup-main" onClick={() => onOpenPerson(contact.id)}>
        <div className="followup-name">
          {contact.name}
          <span className="followup-channel-badge" style={{ color: cm.color, background: cm.color + "1a" }} title={`${cm.label} outreach`}>{cm.glyph}</span>
        </div>
        <div className="followup-meta">
          {institution && (onOpenInstitution
            ? <span className="followup-inst-link" onClick={(e) => { e.stopPropagation(); onOpenInstitution(institution); }} title={`Open ${institution}`}>{institution}</span>
            : <span>{institution}</span>)}
          {daysWaiting != null && <span className={daysWaiting >= NUDGE_AFTER_DAYS ? "followup-days overdue" : "followup-days"}>{daysWaiting} day{daysWaiting === 1 ? "" : "s"} waiting</span>}
          {contact.last_outreach_at && <span>Last outreach {formatDate(contact.last_outreach_at)}</span>}
        </div>
      </div>
      <OutreachStatusSelect contact={contact} onSetStatus={onSetStatus} />
      {showMarkReplied && <button className="btn-sec followup-action" onClick={(e) => { e.stopPropagation(); onSetStatus(contact.id, "replied"); }}>Mark as replied</button>}
      {action}
    </div>
  );
}

function OutreachTab({ contacts, deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles, templates, onSaveTemplate, onDeleteTemplate, onSetStatus, onCompose, onOpenPerson, onOpenInstitution }) {
  const [subtab, setSubtab] = useState("followups");
  const [channelFilter, setChannelFilter] = useState("all");
  const [templateChannelFilter, setTemplateChannelFilter] = useState("all");
  const [editingTemplate, setEditingTemplate] = useState(null); // null | "new" | template row
  const rolesCtx = { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles };
  const instOf = (c) => {
    const roles = resolveContactRoles(c, rolesCtx);
    const primary = roles.find((r) => r.is_primary) || roles[0];
    return primary ? primary.institutionName : c.company || "";
  };
  // The channel to badge/filter/compose by: the one actually used last, or the
  // best-guess suggestion when a contact has never been reached yet.
  const channelOf = (c) => c.outreach_channel || suggestChannel(c);
  const byChannel = (list) => (channelFilter === "all" ? list : list.filter((c) => channelOf(c) === channelFilter));
  // A reengagement/follow-up template matched to the contact's own channel,
  // falling back to any reengagement template if that channel has none yet.
  const reengagementFor = (c) => {
    const ch = channelOf(c);
    return templates.find((t) => t.category === "reengagement" && (t.channel || "email") === ch) || templates.find((t) => t.category === "reengagement");
  };

  // Grouping. Contacts with a null status count as not_contacted (DB default).
  const awaitingAll = contacts.filter((c) => c.outreach_status === "awaiting_reply");
  const needsNudge = awaitingAll.filter((c) => c.awaiting_reply_since && daysAgo(c.awaiting_reply_since) >= NUDGE_AFTER_DAYS);
  const nudgeIds = new Set(needsNudge.map((c) => c.id));
  const awaiting = awaitingAll.filter((c) => !nudgeIds.has(c.id));
  // RECENTLY REPLIED is capped to the last 7 days so it does not grow forever (H6).
  const replied = contacts.filter((c) => c.outreach_status === "replied" && c.last_contacted_at && daysAgo(c.last_contacted_at) <= 7);
  // NOT YET CONTACTED: untouched contacts linked to Tier 1 deals or warm/hot. A
  // Tier 1 deal is on an institution, so people count whether their tie is to
  // the deal, the institution's organization row, or its enabler row (H6). We
  // resolve each Tier 1 deal's institution by normalized name to its org/enabler
  // backing rows, then gather people across every link table plus contacts.company.
  const norm = (s) => (s || "").trim().toLowerCase();
  const tier1Deals = deals.filter((d) => d.tier === "Tier 1");
  const tier1DealIds = new Set(tier1Deals.map((d) => d.id));
  const tier1Names = new Set(tier1Deals.map((d) => norm(d.company)).filter(Boolean));
  const tier1OrgIds = new Set(organizations.filter((o) => tier1Names.has(norm(o.name))).map((o) => o.id));
  const tier1EnablerIds = new Set(enablers.filter((e) => tier1Names.has(norm(e.name))).map((e) => e.id));
  const tier1ContactIds = new Set([
    ...dealContacts.filter((dc) => tier1DealIds.has(dc.deal_id)).map((dc) => dc.contact_id),
    ...enablerContacts.filter((ec) => tier1EnablerIds.has(ec.enabler_id)).map((ec) => ec.contact_id),
    ...contactRoles.filter((r) => (r.entity_type === "deal" && tier1DealIds.has(r.entity_id)) || (r.entity_type === "organization" && tier1OrgIds.has(r.entity_id)) || (r.entity_type === "enabler" && tier1EnablerIds.has(r.entity_id))).map((r) => r.contact_id),
    ...deals.filter((d) => tier1DealIds.has(d.id) && d.contact_id).map((d) => d.contact_id),
    ...networkEdges.filter((ne) => ne.source_type === "contact" && ne.target_type === "organization" && tier1OrgIds.has(ne.target_id)).map((ne) => ne.source_id),
    ...contacts.filter((c) => tier1Names.has(norm(c.company))).map((c) => c.id),
  ]);
  const notContacted = contacts.filter((c) =>
    (!c.outreach_status || c.outreach_status === "not_contacted") &&
    (tier1ContactIds.has(c.id) || ["warm", "hot"].includes(c.warmth)));

  const byWait = (a, b) => new Date(a.awaiting_reply_since || 0) - new Date(b.awaiting_reply_since || 0);

  const group = (title, tone, list, renderAction, daysOf = null, empty, markReplied = false) => (
    <div className="followup-group">
      <div className={`followup-group-head tone-${tone}`}>{title} ({list.length})</div>
      {list.length === 0 ? <div className="empty-small followup-empty">{empty}</div> : (
        <div className="followup-list">
          {list.map((c) => (
            <FollowupRow
              key={c.id}
              contact={c}
              channel={channelOf(c)}
              institution={instOf(c)}
              daysWaiting={daysOf ? daysOf(c) : null}
              showMarkReplied={markReplied && channelOf(c) !== "email"}
              onSetStatus={onSetStatus}
              onOpenPerson={onOpenPerson}
              onOpenInstitution={onOpenInstitution}
              action={renderAction ? renderAction(c) : null}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="section-pad">
      <div className="page-header" style={{ padding: "0 0 16px" }}>
        <div>
          <div className="page-title">Outreach</div>
          <div className="page-sub">Who to email next, and what to say</div>
        </div>
      </div>
      <div className="network-subtabs">
        <button className={`subtab ${subtab === "followups" ? "active" : ""}`} onClick={() => setSubtab("followups")}>Follow-ups</button>
        <button className={`subtab ${subtab === "templates" ? "active" : ""}`} onClick={() => setSubtab("templates")}>Templates</button>
      </div>

      {subtab === "followups" ? (
        <>
          <div className="outreach-channel-filter">
            <button className={`tag-btn ${channelFilter === "all" ? "active" : ""}`} onClick={() => setChannelFilter("all")}>All channels</button>
            {OUTREACH_CHANNELS.map((c) => (
              <button key={c.id} className={`tag-btn ${channelFilter === c.id ? "active" : ""}`} onClick={() => setChannelFilter(c.id)}>{c.glyph} {c.label}</button>
            ))}
          </div>
          {group("NEEDS NUDGE", "red", byChannel([...needsNudge].sort(byWait)),
            (c) => (channelHasTarget(c, channelOf(c))
              ? <button className="btn-sec followup-action" onClick={() => onCompose(c.id, reengagementFor(c)?.id || null, channelOf(c))}>Draft Nudge</button>
              : <span className="followup-noemail">{channelMissingLabel(channelOf(c))}</span>),
            (c) => daysAgo(c.awaiting_reply_since),
            "Nobody is overdue for a nudge.", true)}
          {group("AWAITING REPLY", "yellow", byChannel([...awaiting].sort(byWait)), null,
            (c) => (c.awaiting_reply_since ? daysAgo(c.awaiting_reply_since) : null),
            "No open outreach under 5 days.", true)}
          {group("RECENTLY REPLIED", "green", byChannel(replied),
            null, null, "No replies detected yet.")}
          {group("NOT YET CONTACTED", "gray", byChannel(notContacted),
            (c) => (channelHasTarget(c, channelOf(c))
              ? <button className="btn-sec followup-action" onClick={() => onCompose(c.id, null, channelOf(c))}>Compose</button>
              : <span className="followup-noemail">{channelMissingLabel(channelOf(c))}</span>),
            null, "No untouched Tier 1 or warm contacts.")}
        </>
      ) : (
        <>
          <div className="ai-summary-header">
            <div className="section-label">Templates</div>
            <button className="btn-copy" onClick={() => setEditingTemplate("new")}>+ New Template</button>
          </div>
          <div className="outreach-channel-filter">
            <button className={`tag-btn ${templateChannelFilter === "all" ? "active" : ""}`} onClick={() => setTemplateChannelFilter("all")}>All</button>
            {OUTREACH_CHANNELS.map((c) => (
              <button key={c.id} className={`tag-btn ${templateChannelFilter === c.id ? "active" : ""}`} onClick={() => setTemplateChannelFilter(c.id)}>{c.glyph} {c.label}</button>
            ))}
          </div>
          {editingTemplate && (
            <TemplateEditor
              template={editingTemplate === "new" ? null : editingTemplate}
              onSave={async (form) => { await onSaveTemplate(form, editingTemplate === "new" ? null : editingTemplate.id); setEditingTemplate(null); }}
              onCancel={() => setEditingTemplate(null)}
            />
          )}
          {(() => {
            const filteredTemplates = templateChannelFilter === "all" ? templates : templates.filter((t) => (t.channel || "email") === templateChannelFilter);
            return filteredTemplates.length === 0 ? (
              <div className="empty-state">No templates yet.</div>
            ) : (
              <div className="template-list">
                {filteredTemplates.map((t) => {
                  const cat = templateCategoryMeta(t.category);
                  const cm = outreachChannelMeta(t.channel || "email");
                  return (
                    <div key={t.id} className="template-row" onClick={() => setEditingTemplate(t)}>
                      <div className="template-main">
                        <div className="template-name-row">
                          <span className="template-name">{t.name}</span>
                          <span className="badge" style={{ background: cm.color + "22", color: cm.color, border: `1px solid ${cm.color}44` }}>{cm.glyph} {cm.label}</span>
                          <span className="badge" style={{ background: cat.color + "22", color: cat.color, border: `1px solid ${cat.color}44` }}>{cat.label}</span>
                        </div>
                        {t.subject && <div className="template-subject">{t.subject}</div>}
                      </div>
                      <button className="person-remove" title="Delete template" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete template "${t.name}"?`)) onDeleteTemplate(t.id); }}>✕</button>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

function TemplateEditor({ template, onSave, onCancel }) {
  const [f, setF] = useState({ name: template?.name || "", category: template?.category || "custom", channel: template?.channel || "email", subject: template?.subject || "", body: template?.body || "" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const hasSubject = f.channel === "email";
  return (
    <div className="template-editor">
      <div className="template-editor-row">
        <input className="input template-editor-name" placeholder="Template name..." value={f.name} onChange={(e) => set("name", e.target.value)} />
        <select className="input" value={f.channel} onChange={(e) => set("channel", e.target.value)}>
          {OUTREACH_CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select className="input" value={f.category} onChange={(e) => set("category", e.target.value)}>
          {TEMPLATE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      {hasSubject && <input className="input template-editor-subject" placeholder="Subject line..." value={f.subject} onChange={(e) => set("subject", e.target.value)} />}
      <textarea className="input template-editor-body" placeholder={f.channel === "phone" ? "Talking points / call script..." : "Message body..."} value={f.body} onChange={(e) => set("body", e.target.value)} />
      <div className="merge-legend">
        Merge fields: {MERGE_FIELDS.map(([token, hint]) => <span key={token} className="merge-chip" title={hint}>{token}</span>)}
      </div>
      <div className="task-form-actions">
        <button className="btn-sec" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={() => onSave(f)} disabled={!f.name.trim()}>Save Template</button>
      </div>
    </div>
  );
}

// Compose panel: pick a template, merge fields fill from the contact, then
// hand off to Gmail or the clipboard. Either action marks the contact
// awaiting_reply and logs a "Sent outreach" activity via onSent.
// LinkedIn connection requests cap around this many characters; InMail and
// direct messages to an existing connection allow much more.
const LINKEDIN_REQUEST_LIMIT = 300;

const normalizeUrl = (u) => {
  const t = (u || "").trim();
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
};
const digitsOnly = (s) => (s || "").replace(/[^\d]/g, "");

function ComposeModal({ contact, roles, templates, initialTemplateId, initialChannel, activities = [], onUpdateContact, onSent, showToast, onClose }) {
  const [channel, setChannel] = useState(initialChannel || suggestChannel(contact));
  const channelTemplates = templates.filter((t) => (t.channel || "email") === channel);
  const initial = initialTemplateId && (templates.find((t) => t.id === initialTemplateId)?.channel || "email") === channel
    ? templates.find((t) => t.id === initialTemplateId) : null;
  const [templateId, setTemplateId] = useState(initial ? initial.id : "");
  const [subject, setSubject] = useState(initial ? fillTemplate(initial.subject, contact, roles) : "");
  const [body, setBody] = useState(initial ? fillTemplate(initial.body, contact, roles) : "");
  const [addingLinkedin, setAddingLinkedin] = useState(false);
  const [linkedinDraft, setLinkedinDraft] = useState("");
  const recentContext = activities.filter((a) => a.contact_id === contact.id).slice(0, 3).map((a) => firstLine(cleanActivityText(a.description))).filter(Boolean).join("\n");
  const [talkingPoints, setTalkingPoints] = useState((contact.ai_summary || recentContext || "").trim());
  const [callOutcome, setCallOutcome] = useState("");
  const [logging, setLogging] = useState(false);

  const switchChannel = (next) => { setChannel(next); setTemplateId(""); setSubject(""); setBody(""); };
  const pickTemplate = (id) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) { setSubject(fillTemplate(t.subject, contact, roles)); setBody(fillTemplate(t.body, contact, roles)); }
  };
  const hasNotePlaceholder = subject.includes("{my_note}") || body.includes("{my_note}");

  // EMAIL
  const emailValid = isValidEmail(contact.email);
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(contact.email || "")}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const openGmail = () => { window.open(gmailUrl, "_blank", "noopener"); onSent({ channel: "email", description: `Sent outreach: ${subject}`, bodySnippet: body }); };
  const copyEmail = () => {
    navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`).then(
      () => { showToast("Email copied to clipboard"); onSent({ channel: "email", description: `Sent outreach: ${subject}`, bodySnippet: body }); },
      () => showToast("Could not copy to clipboard"));
  };

  // LINKEDIN
  const linkedinUrl = normalizeUrl(contact.linkedin);
  const openLinkedinProfile = () => { window.open(linkedinUrl, "_blank", "noopener"); };
  const saveLinkedinUrl = async () => {
    const url = linkedinDraft.trim();
    if (!url) return;
    await onUpdateContact({ linkedin: url });
    setAddingLinkedin(false); setLinkedinDraft("");
  };
  const copyLinkedin = () => {
    navigator.clipboard.writeText(body).then(
      () => { showToast("Message copied to clipboard"); onSent({ channel: "linkedin", description: "Sent LinkedIn message", bodySnippet: body }); },
      () => showToast("Could not copy to clipboard"));
  };

  // WHATSAPP
  const waPhone = digitsOnly(contact.phone);
  const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(body)}`;
  const openWhatsapp = () => { window.open(waUrl, "_blank", "noopener"); onSent({ channel: "whatsapp", description: "Sent WhatsApp message", bodySnippet: body }); };
  const copyWhatsapp = () => {
    navigator.clipboard.writeText(body).then(
      () => { showToast("Message copied to clipboard"); onSent({ channel: "whatsapp", description: "Sent WhatsApp message", bodySnippet: body }); },
      () => showToast("Could not copy to clipboard"));
  };

  // PHONE
  const telHref = `tel:${digitsOnly(contact.phone)}`;
  const logCall = async () => {
    if (logging) return;
    setLogging(true);
    try { await onSent({ channel: "phone", description: callOutcome.trim() || `Called ${contact.name}` }); }
    finally { setLogging(false); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal compose-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">Compose to {contact.name}</div>
            <div className="brief-sub">{contact.email || contact.phone || contact.linkedin || "No contact details on file"}</div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="compose-channel-tabs">
          {OUTREACH_CHANNELS.map((c) => (
            <button key={c.id} type="button" className={`tag-btn ${channel === c.id ? "active" : ""}`} onClick={() => switchChannel(c.id)}>{c.glyph} {c.label}</button>
          ))}
        </div>

        {channel === "email" && (
          <>
            <select className="input compose-template-select" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">Pick a template...</option>
              {channelTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} ({templateCategoryMeta(t.category).label})</option>)}
            </select>
            <label className="label">Subject</label>
            <input className="input compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject..." />
            <label className="label">Body</label>
            <textarea className="input compose-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Pick a template above, or write from scratch..." />
            {hasNotePlaceholder && (
              <div className="compose-note-warning">The <span className="compose-note-token">{"{my_note}"}</span> placeholder is still in this email. Replace it with your personal note before sending.</div>
            )}
            {contact.email && !emailValid && (
              <div className="compose-note-warning">"{contact.email}" does not look like a valid email address. Fix it on the person's sheet before opening Gmail.</div>
            )}
            <div className="modal-actions compose-actions">
              <button className="btn-sec" onClick={copyEmail} disabled={!subject.trim() && !body.trim()}>Copy to Clipboard</button>
              <button className="btn-primary" onClick={openGmail} disabled={!emailValid || (!subject.trim() && !body.trim())}>Open in Gmail</button>
            </div>
          </>
        )}

        {channel === "linkedin" && (
          <>
            <select className="input compose-template-select" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">Pick a template...</option>
              {channelTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} ({templateCategoryMeta(t.category).label})</option>)}
            </select>
            <label className="label">Message</label>
            <textarea className="input compose-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Pick a template above, or write from scratch..." />
            <div className={`compose-char-counter ${body.length > LINKEDIN_REQUEST_LIMIT ? "over" : ""}`}>
              {body.length} / {LINKEDIN_REQUEST_LIMIT} characters (connection request limit)
              {body.length > LINKEDIN_REQUEST_LIMIT && " , over the limit for a connection request"}
            </div>
            <div className="compose-hint">InMail and messages to an existing connection allow much more than a connection request.</div>
            {hasNotePlaceholder && (
              <div className="compose-note-warning">The <span className="compose-note-token">{"{my_note}"}</span> placeholder is still in this message. Replace it with your personal note before sending.</div>
            )}
            {!contact.linkedin && !addingLinkedin && (
              <div className="compose-note-warning">No LinkedIn URL on file. <button type="button" className="link-btn" onClick={() => setAddingLinkedin(true)}>Add LinkedIn URL first</button></div>
            )}
            {addingLinkedin && (
              <div className="compose-inline-add">
                <input className="input" placeholder="linkedin.com/in/..." value={linkedinDraft} onChange={(e) => setLinkedinDraft(e.target.value)} />
                <button type="button" className="btn-sec" onClick={() => setAddingLinkedin(false)}>Cancel</button>
                <button type="button" className="btn-primary" onClick={saveLinkedinUrl} disabled={!linkedinDraft.trim()}>Save</button>
              </div>
            )}
            <div className="modal-actions compose-actions">
              <button className="btn-sec" onClick={copyLinkedin} disabled={!body.trim()}>Copy Message</button>
              <button className="btn-primary" onClick={openLinkedinProfile} disabled={!contact.linkedin}>Open LinkedIn Profile</button>
            </div>
          </>
        )}

        {channel === "whatsapp" && (
          <>
            <select className="input compose-template-select" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">Pick a template...</option>
              {channelTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} ({templateCategoryMeta(t.category).label})</option>)}
            </select>
            <label className="label">Message</label>
            <textarea className="input compose-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Pick a template above, or write from scratch..." />
            {hasNotePlaceholder && (
              <div className="compose-note-warning">The <span className="compose-note-token">{"{my_note}"}</span> placeholder is still in this message. Replace it with your personal note before sending.</div>
            )}
            {!contact.phone && (
              <div className="compose-note-warning">No phone number on file. Add one on the person's sheet before opening WhatsApp.</div>
            )}
            <div className="modal-actions compose-actions">
              <button className="btn-sec" onClick={copyWhatsapp} disabled={!body.trim()}>Copy Message</button>
              <button className="btn-primary" onClick={openWhatsapp} disabled={!contact.phone || !body.trim()}>Open WhatsApp</button>
            </div>
          </>
        )}

        {channel === "phone" && (
          <>
            {contact.phone ? (
              <div className="compose-phone-row">
                <div className="compose-phone-number">{contact.phone}</div>
                <a className="btn-primary compose-call-btn" href={telHref}>Call</a>
              </div>
            ) : (
              <div className="compose-note-warning">No phone number on file. Add one on the person's sheet.</div>
            )}
            <label className="label">Talking points</label>
            <textarea className="input compose-body" value={talkingPoints} onChange={(e) => setTalkingPoints(e.target.value)} placeholder="What to cover on the call..." />
            <label className="label">Log call outcome</label>
            <textarea className="input compose-body compose-call-outcome" value={callOutcome} onChange={(e) => setCallOutcome(e.target.value)} placeholder="What happened on the call..." />
            <div className="modal-actions compose-actions">
              <button className="btn-primary" onClick={logCall} disabled={logging}>{logging ? "Logging..." : "Log Call"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Resolve a note's single linked entity to { type, entityId, name } or null.
function noteLinkedEntity(note, { deals, enablers, organizations, contacts }) {
  if (note.deal_id) { const d = deals.find((x) => x.id === note.deal_id); if (d) return { type: "deal", entityId: d.id, name: d.company, kind: "Deal" }; }
  if (note.enabler_id) { const e = enablers.find((x) => x.id === note.enabler_id); if (e) return { type: "enabler", entityId: e.id, name: e.name, kind: "Enabler" }; }
  if (note.organization_id) { const o = organizations.find((x) => x.id === note.organization_id); if (o) return { type: "organization", entityId: o.id, name: o.name, kind: "Organization" }; }
  if (note.contact_id) { const c = contacts.find((x) => x.id === note.contact_id); if (c) return { type: "contact", entityId: c.id, name: c.name, kind: "Person" }; }
  return null;
}

// Dedupes institutions across the deals/enablers/organizations tables by
// normalized name, so an institution that exists as both an enabler and an
// organization (or also a deal) shows up ONCE in a picker (audit M2). `prefer`
// is the order in which a picked entry resolves to a backing record's id/type:
// organization for org-to-x edges, enabler for enabler-specific tables, deal
// where a Target's blue pill is most meaningful.
function dedupeInstitutionOptions({ deals = [], enablers = [], organizations = [], prefer = ["organization", "enabler", "deal"] }) {
  const byName = new Map();
  const put = (rawName, kind, row) => {
    const key = (rawName || "").trim().toLowerCase();
    if (!key) return;
    if (!byName.has(key)) byName.set(key, { name: (rawName || "").trim(), deal: null, enabler: null, org: null });
    byName.get(key)[kind] = row;
  };
  organizations.forEach((o) => put(o.name, "org", o));
  enablers.forEach((e) => put(e.name, "enabler", e));
  deals.forEach((d) => put(d.company, "deal", d));
  const pick = (rec) => {
    for (const p of prefer) {
      if (p === "deal" && rec.deal) return { type: "deal", id: rec.deal.id };
      if (p === "enabler" && rec.enabler) return { type: "enabler", id: rec.enabler.id };
      if (p === "organization" && rec.org) return { type: "organization", id: rec.org.id };
    }
    return null;
  };
  return [...byName.values()]
    .map((rec) => { const p = pick(rec); return p ? { value: `${p.type}:${p.id}`, label: rec.name } : null; })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Flat searchable list of linkable entities (deduped institutions plus people).
function buildNoteEntityOptions({ deals, enablers, organizations, contacts }, query) {
  const q = (query || "").trim().toLowerCase();
  const KIND = { deal: "Deal", enabler: "Enabler", organization: "Organization" };
  const instOpts = dedupeInstitutionOptions({ deals, enablers, organizations, prefer: ["deal", "enabler", "organization"] })
    .map((o) => { const i = o.value.indexOf(":"); const type = o.value.slice(0, i); return { type, entityId: o.value.slice(i + 1), name: o.label, kind: KIND[type] }; });
  const opts = [
    ...instOpts,
    ...contacts.map((c) => ({ type: "contact", entityId: c.id, name: c.name, kind: "Person" })),
  ].filter((o) => o.name);
  return q ? opts.filter((o) => o.name.toLowerCase().includes(q)) : opts;
}

// Flattens the folder tree into [{folder, depth}] in display order (sort_order
// then name), for the editor's "move to folder" picker.
function flattenFolders(folders, parentId = null, depth = 0) {
  return folders
    .filter((f) => (f.parent_id || null) === (parentId || null))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name))
    .flatMap((f) => [{ folder: f, depth }, ...flattenFolders(folders, f.id, depth + 1)]);
}

// Notes tab: a folder-tree list panel (pinned at top, then folders, then an
// Unfiled section) beside a distraction-free editor. On mobile the two are
// separate full-screen views (list, then editor).
function NotesTab({ notes, selectedId, onSelect, onCreate, onUpdate, onDelete, onTogglePin, onLink, onCreateInstitution, customOptions = [], onAddCustomOption = () => {}, folders = [], onCreateFolder, onRenameFolder, onDeleteFolder, onMoveNote, deals, enablers, organizations, contacts, isMobile, bossMode, showToast }) {
  const readOnly = useReadOnly();
  const [search, setSearch] = useState("");
  const [focusNew, setFocusNew] = useState(null);
  const [expanded, setExpanded] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("mango-note-folders-expanded") || "[]")); } catch { return new Set(); }
  });
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [menu, setMenu] = useState(null); // { folderId, x, y }
  const [dragNoteId, setDragNoteId] = useState(null);
  const [dragOverTarget, setDragOverTarget] = useState(null); // folder id or "unfiled"
  const [creatingNote, setCreatingNote] = useState(false);
  const entityCtx = { deals, enablers, organizations, contacts };

  const persistExpanded = (set) => { try { localStorage.setItem("mango-note-folders-expanded", JSON.stringify([...set])); } catch { /* ignore */ } };
  const toggleExpand = (id) => setExpanded((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); persistExpanded(next); return next; });
  const expand = (id) => setExpanded((prev) => { const next = new Set(prev); next.add(id); persistExpanded(next); return next; });

  const q = search.trim().toLowerCase();
  const byUpdated = (a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);

  const childFolders = (parentId) => folders
    .filter((f) => (f.parent_id || null) === (parentId || null))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || "").localeCompare(b.name || ""));
  const notesInFolder = (folderId) => notes.filter((n) => (n.folder_id || null) === folderId && !n.is_pinned).sort(byUpdated);
  const folderNoteCount = (folderId) => notesInFolder(folderId).length + childFolders(folderId).reduce((s, c) => s + folderNoteCount(c.id), 0);

  const pinned = notes.filter((n) => n.is_pinned).sort(byUpdated);
  const unfiled = notes.filter((n) => !n.folder_id && !n.is_pinned).sort(byUpdated);
  const selected = notes.find((n) => n.id === selectedId) || null;
  const searchResults = q ? notes.filter((n) => (n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q)).sort(byUpdated) : null;

  const handleNewNote = async () => {
    if (creatingNote) return;
    setCreatingNote(true);
    try { const row = await onCreate(); if (row) { setFocusNew(row.id); setSearch(""); } } finally { setCreatingNote(false); }
  };
  const handleNewFolder = async () => { const row = await onCreateFolder("New Folder", null); if (row) { setRenamingId(row.id); setRenameValue("New Folder"); } };
  const startRename = (f) => { setMenu(null); setRenamingId(f.id); setRenameValue(f.name); };
  const commitRename = () => { if (renamingId) onRenameFolder(renamingId, renameValue.trim() || "Untitled Folder"); setRenamingId(null); };
  const newSubfolder = async (parent) => { setMenu(null); const row = await onCreateFolder("New Folder", parent.id); if (row) { expand(parent.id); setRenamingId(row.id); setRenameValue("New Folder"); } };
  const removeFolder = (f) => { setMenu(null); if (confirm(`Delete folder "${f.name}"? Its notes move to Unfiled.`)) onDeleteFolder(f.id); };

  const onNoteDragStart = (e, id) => { setDragNoteId(id); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch { /* ignore */ } };
  const onFolderDrop = (folderId) => { if (dragNoteId) onMoveNote(dragNoteId, folderId); setDragNoteId(null); setDragOverTarget(null); };

  // Recursive render (a plain function, not a component, so inline rename inputs
  // keep focus across re-renders).
  const renderFolder = (folder, depth) => {
    const isOpen = expanded.has(folder.id);
    const kids = childFolders(folder.id);
    const own = notesInFolder(folder.id);
    return (
      <div key={folder.id} className="folder-node">
        <div
          className={`folder-row ${dragOverTarget === folder.id ? "drop-over" : ""}`}
          style={{ paddingLeft: 8 + depth * 15 }}
          onClick={() => renamingId !== folder.id && toggleExpand(folder.id)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ folderId: folder.id, x: e.clientX, y: e.clientY }); }}
          onDragOver={(e) => { if (dragNoteId) { e.preventDefault(); setDragOverTarget(folder.id); } }}
          onDragLeave={() => setDragOverTarget((t) => (t === folder.id ? null : t))}
          onDrop={(e) => { e.preventDefault(); onFolderDrop(folder.id); }}
        >
          <span className="folder-chevron">{isOpen ? "▾" : "▸"}</span>
          <span className="folder-icon">📁</span>
          {renamingId === folder.id ? (
            <input
              autoFocus
              className="folder-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenamingId(null); }}
            />
          ) : (
            <span className="folder-name">{folder.name}</span>
          )}
          <span className="folder-count">{folderNoteCount(folder.id)}</span>
          {!readOnly && renamingId !== folder.id && (
            <button className="folder-menu-btn" title="Folder options" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ folderId: folder.id, x: r.right, y: r.bottom }); }}>⋯</button>
          )}
        </div>
        {isOpen && (
          <div className="folder-children">
            {kids.map((k) => renderFolder(k, depth + 1))}
            {own.map((n) => (
              <NoteListItem key={n.id} note={n} active={n.id === selectedId} onSelect={onSelect} entityCtx={entityCtx} indent={8 + (depth + 1) * 15 + 6} draggable={!isMobile && !readOnly} onDragStart={(e) => onNoteDragStart(e, n.id)} />
            ))}
            {kids.length === 0 && own.length === 0 && <div className="folder-empty" style={{ paddingLeft: 8 + (depth + 1) * 15 + 6 }}>Empty</div>}
          </div>
        )}
      </div>
    );
  };

  const menuFolder = menu ? folders.find((f) => f.id === menu.folderId) : null;
  const mobileEditing = isMobile && !!selected;

  return (
    <div className={`notes-view ${mobileEditing ? "notes-editing" : ""}`}>
      <div className="notes-list-panel">
        <div className="notes-list-head">
          {!readOnly && (
            <div className="notes-head-btns">
              <button className="btn-primary notes-new-btn" onClick={handleNewNote} disabled={creatingNote}>+ New Note</button>
              <button className="btn-sec notes-new-folder-btn" onClick={handleNewFolder}>+ New Folder</button>
            </div>
          )}
          <input className="input notes-search" placeholder="Search notes..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="notes-list-scroll">
          {q ? (
            searchResults.length === 0 ? (
              <div className="empty-small notes-empty">No notes match.</div>
            ) : (
              <div className="notes-group">
                <div className="notes-group-head">Search Results</div>
                {searchResults.map((n) => <NoteListItem key={n.id} note={n} active={n.id === selectedId} onSelect={onSelect} entityCtx={entityCtx} />)}
              </div>
            )
          ) : (notes.length === 0 && folders.length === 0) ? (
            <div className="empty-small notes-empty">No notes yet. Create your first one.</div>
          ) : (
            <>
              {pinned.length > 0 && (
                <div className="notes-group">
                  <div className="notes-group-head">📌 Pinned</div>
                  {pinned.map((n) => <NoteListItem key={n.id} note={n} active={n.id === selectedId} onSelect={onSelect} entityCtx={entityCtx} draggable={!isMobile && !readOnly} onDragStart={(e) => onNoteDragStart(e, n.id)} />)}
                </div>
              )}
              <div className="notes-tree">
                {childFolders(null).map((f) => renderFolder(f, 0))}
              </div>
              <div
                className={`notes-unfiled ${dragOverTarget === "unfiled" ? "drop-over" : ""}`}
                onDragOver={(e) => { if (dragNoteId) { e.preventDefault(); setDragOverTarget("unfiled"); } }}
                onDragLeave={() => setDragOverTarget((t) => (t === "unfiled" ? null : t))}
                onDrop={(e) => { e.preventDefault(); onFolderDrop(null); }}
              >
                <div className="notes-group-head">Unfiled{unfiled.length ? ` (${unfiled.length})` : ""}</div>
                {unfiled.map((n) => <NoteListItem key={n.id} note={n} active={n.id === selectedId} onSelect={onSelect} entityCtx={entityCtx} draggable={!isMobile && !readOnly} onDragStart={(e) => onNoteDragStart(e, n.id)} />)}
                {unfiled.length === 0 && <div className="notes-unfiled-empty">No unfiled notes.</div>}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="notes-editor-panel">
        {selected ? (
          <NoteEditor
            key={selected.id}
            note={selected}
            readOnly={readOnly}
            autoFocusTitle={focusNew === selected.id}
            onClearAutoFocus={() => setFocusNew(null)}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onTogglePin={onTogglePin}
            onLink={onLink}
            onCreateInstitution={onCreateInstitution}
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onBack={() => onSelect(null)}
            entityCtx={entityCtx}
            folders={folders}
            onMoveNote={onMoveNote}
            isMobile={isMobile}
            showToast={showToast}
          />
        ) : (
          <div className="notes-editor-empty">Select a note, or create a new one to start writing.</div>
        )}
      </div>

      {menu && menuFolder && (
        <>
          <div className="folder-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="folder-menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 150) }}>
            <button className="folder-menu-item" onClick={() => startRename(menuFolder)}>Rename</button>
            <button className="folder-menu-item" onClick={() => newSubfolder(menuFolder)}>Create subfolder</button>
            <button className="folder-menu-item danger" onClick={() => removeFolder(menuFolder)}>Delete</button>
          </div>
        </>
      )}
    </div>
  );
}

function NoteListItem({ note, active, onSelect, entityCtx, indent = 0, draggable = false, onDragStart }) {
  const ent = noteLinkedEntity(note, entityCtx);
  const preview = stripHtmlToText(note.content).slice(0, 140);
  return (
    <button className={`note-list-item ${active ? "active" : ""}`} style={indent ? { paddingLeft: indent } : undefined} draggable={draggable} onDragStart={onDragStart} onClick={() => onSelect(note.id)}>
      <div className="note-item-top">
        <span className="note-item-title">{note.title || "Untitled"}</span>
        {note.is_pinned && <span className="note-item-pin" title="Pinned">📌</span>}
      </div>
      {preview && <div className="note-item-preview">{preview}</div>}
      <div className="note-item-meta">
        <span className="note-item-date">{formatDate(note.updated_at || note.created_at)}</span>
        {ent && <span className="note-item-tag">{ent.name}</span>}
      </div>
    </button>
  );
}

function NoteEditor({ note, readOnly, autoFocusTitle, onClearAutoFocus, onUpdate, onDelete, onTogglePin, onLink, onCreateInstitution, customOptions = [], onAddCustomOption = () => {}, onBack, entityCtx, folders = [], onMoveNote, isMobile, showToast = () => {} }) {
  const [title, setTitle] = useState(note.title || "");
  const [content, setContent] = useState(note.content || "");
  const [saved, setSaved] = useState(false);
  const [linking, setLinking] = useState(false);
  const [creatingInst, setCreatingInst] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [folderPicking, setFolderPicking] = useState(false);
  const titleRef = useRef(null);
  const debounceRef = useRef(null);
  const savedTimerRef = useRef(null);

  useEffect(() => { setTitle(note.title || ""); setContent(note.content || ""); }, [note.id]);
  useEffect(() => {
    if (autoFocusTitle && titleRef.current) { titleRef.current.focus(); titleRef.current.select(); onClearAutoFocus && onClearAutoFocus(); }
  }, [autoFocusTitle, onClearAutoFocus]);
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); if (savedTimerRef.current) clearTimeout(savedTimerRef.current); }, []);

  const flashSaved = () => {
    setSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaved(false), 1600);
  };
  const saveTitle = () => {
    if (readOnly) return;
    const clean = title.trim() || "Untitled";
    if (clean !== (note.title || "")) { onUpdate(note.id, { title: clean }); flashSaved(); }
    if (title !== clean) setTitle(clean);
  };
  const onContentChange = (v) => {
    setContent(v);
    if (readOnly) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { onUpdate(note.id, { content: v }); flashSaved(); }, 1000);
  };
  const flushContent = () => {
    if (readOnly) return;
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    if (content !== (note.content || "")) { onUpdate(note.id, { content }); flashSaved(); }
  };
  // Plain dictation (Part 1d): appended as a new paragraph, which the user
  // can then format with the toolbar like anything else they typed.
  const onVoiceText = (text) => {
    const clean = (text || "").trim();
    if (!clean) return;
    const esc = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const appended = isContentEmpty(content) ? `<div>${esc}</div>` : `${content}<div>${esc}</div>`;
    onContentChange(appended);
  };

  const linked = noteLinkedEntity(note, entityCtx);
  const options = buildNoteEntityOptions(entityCtx, linkQuery).slice(0, 8);
  const flatFolders = flattenFolders(folders);
  const currentFolder = folders.find((f) => f.id === note.folder_id);

  return (
    <div className="note-editor">
      <div className="note-editor-topbar">
        {isMobile && <button className="note-back-btn" onClick={onBack}>← Notes</button>}
        <span className={`note-saved ${saved ? "show" : ""}`}>Saved</span>
      </div>
      {readOnly ? (
        <div className="note-title-static">{note.title || "Untitled"}</div>
      ) : (
        <input
          ref={titleRef}
          className="note-title-input"
          placeholder="Untitled"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      )}
      {readOnly ? (
        <RichTextView value={note.content} className="note-content-static" />
      ) : (
        <>
          <RichTextEditor value={content} onChange={onContentChange} onBlur={flushContent} placeholder="Start writing..." />
          <div className="note-voice-row">
            <VoiceRecorder mode="plain" onPlainText={onVoiceText} showToast={showToast} compact title="Dictate into this note" />
          </div>
        </>
      )}

      {!readOnly && (
        <div className="note-toolbar">
          <button className={`note-tool-btn ${note.is_pinned ? "active" : ""}`} onClick={() => onTogglePin(note)} title={note.is_pinned ? "Unpin" : "Pin"}>
            📌 {note.is_pinned ? "Pinned" : "Pin"}
          </button>

          <div className="note-link-wrap">
            {linked ? (
              <span className="note-link-pill">
                {linked.name}
                <button className="note-link-remove" onClick={() => onLink(note.id, null)} title="Unlink">✕</button>
              </span>
            ) : linking ? (
              creatingInst ? (
                <InstitutionCreateForm
                  customOptions={customOptions}
                  onAddCustomOption={onAddCustomOption}
                  onCancel={() => setCreatingInst(false)}
                  onCreate={async (form) => {
                    const created = await onCreateInstitution(form);
                    if (created?.preferred) { onLink(note.id, { type: created.preferred.type, entityId: created.preferred.id }); setCreatingInst(false); setLinking(false); return true; }
                    return false;
                  }}
                />
              ) : (
                <div className="note-link-picker">
                  <input autoFocus className="input note-link-search" placeholder="Search deals, people..." value={linkQuery} onChange={(e) => setLinkQuery(e.target.value)} onBlur={() => setTimeout(() => setLinking(false), 150)} />
                  {linkQuery.trim() && (
                    <div className="note-link-options">
                      {options.length === 0 ? <div className="empty-small">No matches.</div> : options.map((o) => (
                        <button key={`${o.type}-${o.entityId}`} className="note-link-option" onMouseDown={() => { onLink(note.id, o); setLinking(false); setLinkQuery(""); }}>
                          <span className="note-link-option-name">{o.name}</span>
                          <span className="note-link-option-kind">{o.kind}</span>
                        </button>
                      ))}
                      {onCreateInstitution && (
                        <button className="note-link-option note-link-create" onMouseDown={() => setCreatingInst(true)}>+ Add new institution</button>
                      )}
                    </div>
                  )}
                </div>
              )
            ) : (
              <button className="note-tool-btn" onClick={() => { setLinking(true); setLinkQuery(""); }}>Link to...</button>
            )}
          </div>

          <div className="note-folder-wrap">
            <button className={`note-tool-btn ${currentFolder ? "active" : ""}`} onClick={() => setFolderPicking((v) => !v)} title="Move to folder">📁 {currentFolder ? currentFolder.name : "Folder"}</button>
            {folderPicking && (
              <>
                <div className="note-folder-backdrop" onClick={() => setFolderPicking(false)} />
                <div className="note-folder-options">
                  <button className={`note-folder-option ${!note.folder_id ? "active" : ""}`} onClick={() => { onMoveNote(note.id, null); setFolderPicking(false); }}>No folder (Unfiled)</button>
                  {flatFolders.map(({ folder, depth }) => (
                    <button key={folder.id} className={`note-folder-option ${note.folder_id === folder.id ? "active" : ""}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => { onMoveNote(note.id, folder.id); setFolderPicking(false); }}>📁 {folder.name}</button>
                  ))}
                  {folders.length === 0 && <div className="empty-small note-folder-empty">No folders yet. Create one in the list.</div>}
                </div>
              </>
            )}
          </div>

          <button className="note-tool-btn note-delete-btn" onClick={() => { if (confirm("Delete this note?")) onDelete(note.id); }} title="Delete note">🗑 Delete</button>
        </div>
      )}
    </div>
  );
}

// Read-only "Linked Notes" section shown on Institution and Person sheets.
function LinkedNotesSection({ notes, onOpenNote }) {
  if (!notes || notes.length === 0) return null;
  const sorted = [...notes].sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  return (
    <div className="people-section">
      <div className="section-label">Linked Notes</div>
      <div className="linked-notes-list">
        {sorted.map((n) => (
          <button key={n.id} className="linked-note-row" onClick={() => onOpenNote(n.id)}>
            <span className="linked-note-title">{n.title || "Untitled"}</span>
            <span className="linked-note-date">{formatDate(n.updated_at || n.created_at)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DealForm({ deal, contacts, customOptions, onAddCustomOption, onSave, onClose }) {
  const isEdit = !!deal.id;
  const [f, setF] = useState({ id:deal.id||"", company:deal.company||"", type:deal.type||"hospital", contact_id:deal.contact_id||"", contact_name:deal.contact_name||"", contact_role:deal.contact_role||"", value:deal.value||"", stage:deal.stage||"prospecting", tier:deal.tier||"Untiered", city:deal.city||"", region:deal.region||"", notes:deal.notes||"", next_action:deal.next_action||"" });
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  const pickContact = (id) => { const c = contacts.find(x=>x.id===id); if(c){setF(p=>({...p, contact_id:id, contact_name:c.name||"", contact_role:c.role||"", company:p.company||c.company||""}));} else {set("contact_id","");} };
  const stageOpts = optionsWithCustom(STAGES, customOptions, "deal_stage");
  const typeOpts = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");
  const cityOpts = optionsWithCustom(CITY_OPTIONS, customOptions, "city");
  const regionOpts = optionsWithCustom(REGION_OPTIONS, customOptions, "region");
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{isEdit?"Edit Deal":"New Deal"}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field-full"><label className="label">Company *</label><input className="input" value={f.company} onChange={e=>set("company",e.target.value)} placeholder="e.g. KFSHRC" /></div>
        {contacts.length > 0 && <div className="field-full"><label className="label">Link to Contact</label><select className="input" value={f.contact_id} onChange={e=>pickContact(e.target.value)}><option value="">Select...</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.name}{c.company?` (${c.company})`:""}</option>)}</select></div>}
        <div className="field"><label className="label">Contact Name</label><input className="input" value={f.contact_name} onChange={e=>set("contact_name",e.target.value)} /></div>
        <div className="field"><label className="label">Role</label><input className="input" value={f.contact_role} onChange={e=>set("contact_role",e.target.value)} /></div>
        <div className="field"><label className="label">Value (USD)</label><input className="input" type="number" value={f.value} onChange={e=>set("value",e.target.value)} placeholder="Optional" /></div>
        <div className="field"><label className="label">Type</label><SelectWithCustom options={typeOpts} value={f.type} onChange={(v)=>{set("type",v); trackCustom("institution_type", typeOpts, onAddCustomOption)(v);}} placeholder="e.g. Hospital" /></div>
        <div className="field"><label className="label">Stage</label><SelectWithCustom options={stageOpts} value={f.stage} onChange={(v)=>{set("stage",v); trackCustom("deal_stage", stageOpts, onAddCustomOption)(v);}} /></div>
        <div className="field"><label className="label">Tier</label><select className="input" value={f.tier} onChange={e=>set("tier",e.target.value)}>{DEAL_TIERS.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
        <div className="field"><label className="label">City</label><SelectWithCustom options={cityOpts} value={f.city} onChange={(v)=>{set("city",v); trackCustom("city", cityOpts, onAddCustomOption)(v);}} placeholder="City name..." /></div>
        <div className="field"><label className="label">Region</label><SelectWithCustom options={regionOpts} value={f.region} onChange={(v)=>{set("region",v); trackCustom("region", regionOpts, onAddCustomOption)(v);}} placeholder="Region name..." /></div>
        <div className="field-full"><label className="label">Next Action</label><input className="input" value={f.next_action} onChange={e=>set("next_action",e.target.value)} placeholder="What needs to happen next?" /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.company.trim()&&onSave(f)} className="btn-primary" disabled={!f.company.trim()}>{isEdit?"Save":"Add Deal"}</button></div>
    </div></div>
  );
}

const TIMELINE_TABS = [
  { id: "all", label: "All" },
  { id: "call", label: "Calls" },
  { id: "email", label: "Emails" },
  { id: "meeting", label: "Meetings" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "note", label: "Notes" },
];

const TASK_FILTER_TABS = [
  { id: "all", label: "All" },
  { id: "high", label: "High Priority" },
  { id: "due_today", label: "Due Today" },
  { id: "overdue", label: "Overdue" },
];

// Resolves the full set of institutions a contact holds a role at, reading
// contact_roles first and falling back to the legacy junction tables / edges /
// deals.contact_id for pairs not yet covered by a real contact_roles row.
function resolveContactRoles(contact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles }) {
  const resolve = (entityType, entityId) => {
    if (entityType === "deal") return deals.find(d => d.id === entityId);
    if (entityType === "enabler") return enablers.find(en => en.id === entityId);
    if (entityType === "organization") return organizations.find(o => o.id === entityId);
    return null;
  };
  const roleRows = contactRoles.filter(r => r.contact_id === contact.id);
  const covered = new Set(roleRows.map(r => `${r.entity_type}:${r.entity_id}`));
  const fallbackRows = [
    ...dealContacts.filter(dc => dc.contact_id === contact.id).map(dc => ({ entity_type: "deal", entity_id: dc.deal_id, role_title: dc.role_in_deal })),
    ...deals.filter(d => d.contact_id === contact.id).map(d => ({ entity_type: "deal", entity_id: d.id, role_title: d.contact_role })),
    ...enablerContacts.filter(ec => ec.contact_id === contact.id).map(ec => ({ entity_type: "enabler", entity_id: ec.enabler_id, role_title: ec.role_in_org })),
    ...networkEdges.filter(ne => ne.source_type === "contact" && ne.source_id === contact.id && ne.target_type === "organization").map(ne => ({ entity_type: "organization", entity_id: ne.target_id, role_title: ne.notes })),
  ].filter(r => !covered.has(`${r.entity_type}:${r.entity_id}`));
  const seen = new Set();
  return [
    ...roleRows.map(r => ({ ...r, removable: true })),
    ...fallbackRows.filter(r => { const k = `${r.entity_type}:${r.entity_id}`; if (seen.has(k)) return false; seen.add(k); return true; }).map(r => ({ ...r, removable: false })),
  ]
    .map(r => ({ ...r, institution: resolve(r.entity_type, r.entity_id) }))
    .filter(r => r.institution)
    .map(r => ({ ...r, institutionName: r.entity_type === "deal" ? r.institution.company : r.institution.name }));
}

// Base person-to-person relationship types for the Connect form. `can_introduce`
// is directional and gets an explicit two-way direction chooser (either person
// can be the introducer, see the Connect form); `reports_to` is directional
// (the source reports to the target); colleague/knows/friend are symmetric.
// `rel` is the canonical relationship stored in network_edges, `direction` its
// one_way/bidirectional flag. `preview` renders a live sentence with both names
// filled in; for the directional-but-not-chooser types it shows what will save.
const PERSON_CONNECTION_TYPES = [
  { id: "can_introduce", rel: "can_introduce", direction: "one_way", directional: true, short: "Can introduce" },
  { id: "reports_to", rel: "reports_to", direction: "one_way", short: "Reports to", preview: (a, b) => `${a} reports to ${b}` },
  { id: "colleague", rel: "colleague", direction: "bidirectional", short: "Colleague", preview: (a, b) => `${a} is a colleague of ${b}` },
  { id: "knows", rel: "knows", direction: "bidirectional", short: "Knows", preview: (a, b) => `${a} knows ${b}` },
  { id: "friend", rel: "friend", direction: "bidirectional", short: "Friend", preview: (a, b) => `${a} is a friend of ${b}` },
];

// Whether a person-to-person relationship is directional (has a meaningful
// source/target order), so an existing edge can be flipped with the swap
// control on the Connections list.
const isDirectionalPersonRel = (r) => ["can_introduce", "reports_to"].includes((r || "").toLowerCase());

// Wording of an existing person-to-person edge from the perspective of the
// person whose sheet is open (`viewingId`), with `otherName` already resolved.
// Directional edges read differently on each side; symmetric ones read the
// same both ways. It is ONE edge shown from two perspectives, never duplicated.
function personConnectionSentence(ne, viewingId, otherName) {
  const rel = (ne.relationship || "").toLowerCase();
  const viewerIsSource = ne.source_id === viewingId;
  if (rel === "can_introduce") {
    return viewerIsSource
      ? `Can introduce you to ${otherName}`
      : `Reachable through ${otherName} (can introduce you)`;
  }
  if (rel === "reports_to") {
    return viewerIsSource ? `Reports to ${otherName}` : `${otherName} reports to them`;
  }
  if (rel === "colleague") return `Colleague of ${otherName}`;
  if (rel === "knows") return `Knows ${otherName}`;
  if (rel === "friend") return `Friend of ${otherName}`;
  if (rel === "works_with") return `Works with ${otherName}`;
  if (rel === "family") return `Family of ${otherName}`;
  const label = PERSON_CONNECTION_RELATIONSHIPS.find((r) => r.id === rel)?.label
    || NETWORK_EDGE_RELATIONSHIPS.find((r) => r.id === rel)?.label
    || (rel ? rel.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Connected to");
  return `${label} ${otherName}`;
}

// Searchable single-select over contacts, with an inline "+ Add new person"
// option that creates a bare contact and selects it. Used by the Connect form.
function ContactConnectPicker({ contacts, value, onChange, onCreateContact, placeholder = "Search people..." }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const selected = contacts.find((c) => c.id === value);
  const query = q.trim().toLowerCase();
  const filtered = (query ? contacts.filter((c) => (c.name || "").toLowerCase().includes(query) || (c.company || "").toLowerCase().includes(query)) : contacts).slice(0, 8);
  if (selected) {
    return (
      <div className="entity-picker">
        <span className="entity-picker-chip">
          {selected.name}
          <button type="button" className="entity-picker-clear" onClick={() => onChange("")} title="Clear">✕</button>
        </span>
      </div>
    );
  }
  if (creating) {
    return (
      <div className="entity-picker conn-create-inline">
        <input
          className="input" placeholder="New person's name" autoFocus
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              const name = e.currentTarget.value.trim();
              if (!name) return;
              const created = await onCreateContact(name);
              if (created?.id) { onChange(created.id); setCreating(false); setOpen(false); }
            }
            if (e.key === "Escape") setCreating(false);
          }}
        />
        <button type="button" className="btn-sec" onMouseDown={() => setCreating(false)}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="entity-picker">
      <input
        className="input entity-picker-input"
        placeholder={placeholder}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="entity-picker-options">
          {filtered.length === 0 ? <div className="empty-small entity-picker-empty">No matches.</div> : filtered.map((c) => (
            <button type="button" key={c.id} className="entity-picker-option" onMouseDown={() => { onChange(c.id); setQ(""); setOpen(false); }}>{c.name}{c.company ? ` (${c.company})` : ""}</button>
          ))}
          {onCreateContact && (
            <button type="button" className="entity-picker-option entity-picker-create" onMouseDown={() => setCreating(true)}>+ Add new person</button>
          )}
        </div>
      )}
    </div>
  );
}

function PersonSheet({ contact, activities, deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles, institutions, customOptions = [], onAddCustomOption = () => {}, onCreateInstitution, onUpdate, onDelete, onCompose, onAddActivity, onSummarizeEmail, summarizingActivityId, onUpdateActivity, onDeleteActivity, onAddTimelineEntry, activityLinkOptions = {}, onAddTodo, todos = [], todoContacts = [], taskInitial = {}, onToggleTodo, onUpdateTodo, onNavigateTask, linkedNotes = [], onOpenNote, onAddRole, onRemoveRole, onConnectPerson, onAddIntroducedPerson, onCreateBareContact, onRemoveConnection, onSwapConnection, onGenerateSummary, onSaveSummary, summarizing, showToast, onOpenInstitution, onOpenPerson, onOpenCalendarEvent, onBack, backLabel = "Back to Ecosystem", bossNotesSlot }) {
  const readOnly = useReadOnly();
  const [filter, setFilter] = useState("all");
  const [addingRole, setAddingRole] = useState(false);
  const [roleInst, setRoleInst] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [savingRole, setSavingRole] = useState(false);
  const [addingConn, setAddingConn] = useState(false);
  const [connContactId, setConnContactId] = useState("");
  const [connType, setConnType] = useState("can_introduce");
  // For "can introduce", which way the introduction flows: "forward" = this
  // person (A) is the introducer; "reverse" = the picked person (B) is.
  const [connDir, setConnDir] = useState("forward");
  const [connNotes, setConnNotes] = useState("");
  const [savingConn, setSavingConn] = useState(false);
  // "+ Someone they can introduce me to" streamlined shortcut (item 4).
  const [addingIntro, setAddingIntro] = useState(false);
  const [introName, setIntroName] = useState("");
  const [introRole, setIntroRole] = useState("");
  const [introInst, setIntroInst] = useState("");
  const [introNotes, setIntroNotes] = useState("");
  const [savingIntro, setSavingIntro] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();
  const warmth = WARMTH_LEVELS.find(w => w.id === (contact.warmth || "unknown"));

  // The old edit-contact modal is gone; tags, source, and the internal flag are
  // edited inline here. Marking someone internal auto-tags them "Internal Team"
  // (same rule as persistContact); internal people drive the Network Map's
  // Internal nodes.
  const tagOpts = optionsWithCustom(toOptions(TAG_OPTIONS), customOptions, "tag").map((o) => o.id);
  const toggleTag = (t) => {
    const tags = (contact.tags || []).includes(t) ? (contact.tags || []).filter((x) => x !== t) : [...(contact.tags || []), t];
    if (!(contact.tags || []).includes(t)) trackCustom("tag", toOptions(tagOpts), onAddCustomOption)(t);
    onUpdate({ tags });
  };
  const setInternal = (checked) => {
    const tags = [...(contact.tags || [])];
    if (checked && !tags.includes("Internal Team")) tags.push("Internal Team");
    onUpdate({ is_internal: checked, tags });
  };

  const roles = resolveContactRoles(contact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
  // The person's primary role's institution FKs: Quick Add activities and + Task
  // both auto-cross-link to this so they show on the person's timeline AND their
  // institution's, without the user manually linking anything.
  const primaryRole = roles.find((r) => r.is_primary) || roles[0];
  const primaryInstitution = primaryRole ? {
    dealId: primaryRole.entity_type === "deal" ? primaryRole.entity_id : null,
    enablerId: primaryRole.entity_type === "enabler" ? primaryRole.entity_id : null,
    organizationId: primaryRole.entity_type === "organization" ? primaryRole.entity_id : null,
  } : null;
  const taskInitialWithInstitution = {
    ...(primaryRole ? {
      deal_id: primaryRole.entity_type === "deal" ? primaryRole.entity_id : undefined,
      enabler_id: primaryRole.entity_type === "enabler" ? primaryRole.entity_id : undefined,
      organization_id: primaryRole.entity_type === "organization" ? primaryRole.entity_id : undefined,
    } : {}),
    ...taskInitial,
  };

  const instOptions = institutions.map(i => {
    const pe = institutionPrimaryEntity(i);
    return pe ? { key: `${pe.type}:${pe.id}`, label: `${i.name}${i.type ? ` (${institutionTypeMeta(i.type, customOptions).label})` : ""}` } : null;
  }).filter(Boolean);

  const submitRole = async () => {
    if (!roleInst || savingRole) return;
    setSavingRole(true);
    try {
      const idx = roleInst.indexOf(":");
      await onAddRole({ contactId: contact.id, entityType: roleInst.slice(0, idx), entityId: roleInst.slice(idx + 1), roleTitle });
      setAddingRole(false); setRoleInst(""); setRoleTitle("");
    } finally { setSavingRole(false); }
  };

  // Quick Add's "At institution..." picker only offers this person's own roles
  // (it cross-links an activity to an institution they already belong to), so
  // creating one inline from there also links this person to it right away.
  const createInstitutionAndLinkContact = onCreateInstitution ? async (form) => {
    const created = await onCreateInstitution(form);
    if (created?.preferred) await onAddRole({ contactId: contact.id, entityType: created.preferred.type, entityId: created.preferred.id, roleTitle: "" });
    return created;
  } : undefined;

  const relLabel = (id) => PERSON_CONNECTION_RELATIONSHIPS.find(r => r.id === id)?.label || NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === id)?.label || id;
  // Resolves a "(role, institution)" hint for a person, using their primary role.
  const personDetail = (other) => {
    const otherRoles = resolveContactRoles(other, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
    const primary = otherRoles.find(r => r.is_primary) || otherRoles[0];
    if (!primary) return other.company || "";
    const parts = [primary.role_title, primary.institutionName].filter(Boolean);
    return parts.join(", ");
  };

  // Connections: every network_edge touching this contact, resolved to the
  // other end and worded correctly from THIS person's perspective (item 2).
  const connectedContactIds = new Set();
  const connections = networkEdges
    .filter(ne => (ne.source_type === "contact" && ne.source_id === contact.id) || (ne.target_type === "contact" && ne.target_id === contact.id))
    .map(ne => {
      const isSource = ne.source_type === "contact" && ne.source_id === contact.id;
      const otherType = isSource ? ne.target_type : ne.source_type;
      const otherId = isSource ? ne.target_id : ne.source_id;
      if (otherType === "contact") {
        const other = contacts.find(c => c.id === otherId);
        if (!other) return null;
        connectedContactIds.add(otherId);
        const detail = personDetail(other);
        const sentence = personConnectionSentence(ne, contact.id, other.name);
        return { id: ne.id, sentence, detail, notes: ne.notes || "", swappable: isDirectionalPersonRel(ne.relationship), onClick: () => onOpenPerson(other.id) };
      }
      const other = otherType === "deal" ? deals.find(d => d.id === otherId) : otherType === "enabler" ? enablers.find(e => e.id === otherId) : organizations.find(o => o.id === otherId);
      if (!other) return null;
      const name = otherType === "deal" ? other.company : other.name;
      return { id: ne.id, sentence: `${relLabel(ne.relationship)} ${name}`, detail: "", notes: ne.notes || "", swappable: false, onClick: () => onOpenInstitution(name) };
    })
    .filter(Boolean);

  const connectableContacts = contacts.filter(c => c.id !== contact.id && !connectedContactIds.has(c.id));
  // The Connect form uses the picked person's real name live in the direction
  // labels. Until Person B is picked, use a placeholder for the second name.
  const connOtherName = contacts.find(c => c.id === connContactId)?.name || "the other person";
  const connTypeObj = PERSON_CONNECTION_TYPES.find(t => t.id === connType) || PERSON_CONNECTION_TYPES[0];

  const submitConn = async () => {
    if (!connContactId || !onConnectPerson || savingConn) return;
    const type = connTypeObj;
    // For "can introduce", the direction radio decides who is the introducer;
    // the introducer is ALWAYS the edge source. Everything else keeps its own
    // fixed direction (reports_to: source reports to target; symmetric ones
    // source/target order is immaterial).
    const reverse = type.id === "can_introduce" && connDir === "reverse";
    const sourceId = reverse ? connContactId : contact.id;
    const targetId = reverse ? contact.id : connContactId;
    setSavingConn(true);
    try {
      await onConnectPerson({ sourceId, targetId, relationship: type.rel, direction: type.direction, notes: connNotes });
      setAddingConn(false); setConnContactId(""); setConnType("can_introduce"); setConnDir("forward"); setConnNotes("");
    } finally { setSavingConn(false); }
  };

  const createBareContactForConn = onCreateBareContact ? async (name) => await onCreateBareContact(name) : null;

  const submitIntro = async () => {
    if (!introName.trim() || !onAddIntroducedPerson || savingIntro) return;
    setSavingIntro(true);
    try {
      await onAddIntroducedPerson({ name: introName.trim(), role: introRole.trim(), institutionKey: introInst || null, notes: introNotes.trim() });
      setAddingIntro(false); setIntroName(""); setIntroRole(""); setIntroInst(""); setIntroNotes("");
    } finally { setSavingIntro(false); }
  };

  return (
    <div className="deal-sheet">
      <button onClick={onBack} className="sheet-back">← {backLabel}</button>

      <div className="sheet-top">
        <div className="sheet-top-row">
          <div className="sheet-person-head">
            <Avatar name={contact.name} size={52} />
            <div>
            <div className="sheet-company"><InlineText value={contact.name} onSave={(v) => v.trim() && onUpdate({ name: v.trim() })} placeholder="Name" /></div>
            <div className="sheet-meta-row">
              <BadgeSelect options={WARMTH_LEVELS} value={contact.warmth || "unknown"} color={warmth?.color} onChange={(v) => onUpdate({ warmth: v })} dot title="Change warmth" />
              {readOnly ? (
                contact.is_internal ? <span className="badge internal-badge">Internal Team</span> : null
              ) : (
                <label className="checkbox-label internal-toggle" title="Internal team members are Path Finder roots on the Network Map">
                  <input type="checkbox" checked={!!contact.is_internal} onChange={(e) => setInternal(e.target.checked)} /> Internal Team
                </label>
              )}
            </div>
            <div className="contact-details mb-sm">
              <div>📧 <InlineText value={contact.email} onSave={(v) => onUpdate({ email: v })} placeholder="Add email" />
                {(contact.email || contact.phone || contact.linkedin) && !readOnly && onCompose && (
                  <button className="compose-btn" onClick={onCompose} title="Compose outreach to this contact">✉ Compose</button>
                )}
              </div>
              <div>📞 <InlineText value={contact.phone} onSave={(v) => onUpdate({ phone: v })} placeholder="Add phone" /></div>
              <div>🔗 <InlineText value={contact.linkedin} onSave={(v) => onUpdate({ linkedin: v })} placeholder="Add LinkedIn" /></div>
              <div>🧭 Source: <InlineText value={contact.source} onSave={(v) => onUpdate({ source: v || null })} placeholder="e.g. Conference, Referral" /></div>
            </div>
            <div className="tags-row">
              {(contact.tags || []).map(t => <span key={t} className="tag">{t}</span>)}
              {!readOnly && <button className="tag tag-edit-btn" onClick={() => setEditingTags(v => !v)}>{editingTags ? "Done" : (contact.tags || []).length ? "✎ Tags" : "+ Tags"}</button>}
            </div>
            {editingTags && !readOnly && (
              <div className="tags-edit-panel">
                <TagPickerWithCustom options={tagOpts} value={contact.tags || []} onToggle={toggleTag} />
              </div>
            )}
            </div>
          </div>
          <div className="sheet-actions">
            {!readOnly && <button onClick={() => { if (confirm("Delete this person?")) onDelete(contact.id); }} className="btn-sec btn-danger">Delete</button>}
          </div>
        </div>
      </div>

      {bossNotesSlot}

      <SummaryCard entity={contact} activities={activities} onGenerateSummary={onGenerateSummary} onSaveSummary={onSaveSummary} summarizing={summarizing} />

      {(() => {
        const profile = parseProfileNotes(contact.notes);
        if (Object.keys(profile).length === 0) return null;
        return (
          <div className="people-section">
            <div className="section-label">Profile</div>
            {profile.Department && <div className="profile-line"><span className="profile-key">Department</span>{profile.Department}</div>}
            {profile.Education && <div className="profile-line"><span className="profile-key">Education</span>{profile.Education}</div>}
            {profile.Publications && <div className="profile-line"><span className="profile-key">Publications</span>{profile.Publications}</div>}
            {profile.Relevance && <div className="profile-line"><span className="profile-key">Why relevant</span>{profile.Relevance}</div>}
            {profile.Confidence && <div className="profile-line"><span className="profile-key">Confidence</span>{profile.Confidence}</div>}
          </div>
        );
      })()}

      <div className="people-section">
        <div className="section-label">Notes</div>
        <NotesEditor value={contact.notes} onSave={(v) => onUpdate({ notes: v })} showToast={showToast} />
      </div>

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Roles</div>
          {!readOnly && <button onClick={() => setAddingRole(v => !v)} className="btn-copy">{addingRole ? "Cancel" : "+ Add Role"}</button>}
        </div>
        {addingRole && (
          <div className="quickadd-inline-row mb-sm">
            <InstitutionSelect
              options={instOptions} value={roleInst} onChange={setRoleInst} optKey="key"
              onCreateInstitution={onCreateInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
            />
            <input className="input" placeholder="Role title (e.g. CEO)" value={roleTitle} onChange={e => setRoleTitle(e.target.value)} />
            <button onClick={submitRole} className="btn-primary" disabled={!roleInst || savingRole}>{savingRole ? "Adding..." : "Add"}</button>
          </div>
        )}
        {roles.length === 0 ? (
          <div className="empty-small">Not linked to any institution yet.</div>
        ) : (
          <div className="people-grid">
            {roles.map(r => {
              const badge = institutionTypeMeta(r.entity_type === "enabler" ? (r.institution.type || "enabler") : (r.institution.type || ""), customOptions);
              const stage = r.entity_type === "deal" ? STAGES.find(s => s.id === r.institution.stage) : null;
              return (
                <div key={`${r.entity_type}-${r.entity_id}`} className="person-card" onClick={() => onOpenInstitution(r.institutionName)}>
                  <div className="person-card-top">
                    <div>
                      <div className="person-name">{r.institutionName}</div>
                      {r.role_title && <div className="person-role">{r.role_title}</div>}
                    </div>
                    {!readOnly && r.removable && onRemoveRole && <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this role?")) onRemoveRole(r); }} className="person-remove" title="Remove">✕</button>}
                  </div>
                  <div className="todo-meta-row mb-sm">
                    {r.institution.type && badge && <span className="badge" style={{background:badge.color+"22",color:badge.color,border:`1px solid ${badge.color}44`}}>{badge.label}</span>}
                    {stage && <span className="badge" style={{background:stage.color+"22",color:stage.color,border:`1px solid ${stage.color}44`}}>{stage.label}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Connections</div>
          {!readOnly && (
            <div className="conn-header-actions">
              {onAddIntroducedPerson && <button onClick={() => { setAddingIntro(v => !v); setAddingConn(false); }} className="btn-primary conn-intro-btn">{addingIntro ? "Cancel" : "+ Someone they can introduce me to"}</button>}
              <button onClick={() => { setAddingConn(v => !v); setAddingIntro(false); }} className="btn-copy">{addingConn ? "Cancel" : "+ Connect to Person"}</button>
            </div>
          )}
        </div>
        {addingIntro && (
          <div className="conn-form">
            <div className="conn-form-hint">Add someone {contact.name} can introduce you to. This creates the person and the introduction link in one step.</div>
            <input className="input" placeholder="Their name (required)" value={introName} onChange={e => setIntroName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === "Enter") submitIntro(); }} />
            <div className="conn-form-row">
              <input className="input" placeholder="Role (optional, e.g. Head of Oncology)" value={introRole} onChange={e => setIntroRole(e.target.value)} />
              <InstitutionSelect
                options={instOptions} value={introInst} onChange={setIntroInst} optKey="key" placeholder="Institution (optional)"
                onCreateInstitution={onCreateInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
              />
            </div>
            <input className="input" placeholder="Notes (optional, e.g. offered at the July 15 meeting)" value={introNotes} onChange={e => setIntroNotes(e.target.value)} />
            <div className="conn-form-actions">
              <button onClick={submitIntro} className="btn-primary" disabled={!introName.trim() || savingIntro}>{savingIntro ? "Adding..." : "Add and link"}</button>
            </div>
          </div>
        )}
        {addingConn && (
          <div className="conn-form">
            <div className="conn-form-field">
              <span className="conn-form-label">Who?</span>
              <ContactConnectPicker contacts={connectableContacts} value={connContactId} onChange={setConnContactId} onCreateContact={createBareContactForConn} />
            </div>
            <div className="conn-form-field">
              <span className="conn-form-label">Relationship</span>
              <select className="input" value={connType} onChange={e => setConnType(e.target.value)}>
                {PERSON_CONNECTION_TYPES.map(t => <option key={t.id} value={t.id}>{t.short}</option>)}
              </select>
            </div>
            {connTypeObj.directional ? (
              <div className="conn-form-field">
                <span className="conn-form-label">Which way does the introduction go?</span>
                <div className="conn-dir-choice">
                  <label className="conn-dir-option">
                    <input type="radio" name="conn-dir" checked={connDir === "forward"} onChange={() => setConnDir("forward")} />
                    <span>{contact.name} can introduce me to {connOtherName}</span>
                  </label>
                  <label className="conn-dir-option">
                    <input type="radio" name="conn-dir" checked={connDir === "reverse"} onChange={() => setConnDir("reverse")} />
                    <span>{connOtherName} can introduce me to {contact.name}</span>
                  </label>
                </div>
              </div>
            ) : (
              <div className="conn-form-preview">{connTypeObj.preview(contact.name, connOtherName)}</div>
            )}
            <input className="input" placeholder="Notes (optional, e.g. offered at the July 15 meeting)" value={connNotes} onChange={e => setConnNotes(e.target.value)} />
            <div className="conn-form-actions">
              <button onClick={submitConn} className="btn-primary" disabled={!connContactId || savingConn}>{savingConn ? "Connecting..." : "Connect"}</button>
            </div>
          </div>
        )}
        {connections.length === 0 ? (
          <div className="empty-small">No connections logged yet.</div>
        ) : (
          <div className="todo-list">
            {connections.map(c => (
              <div key={c.id} className="path-row">
                <div onClick={c.onClick} style={{ cursor: "pointer", flex: 1 }}>
                  <div className="path-chain">{c.sentence}{c.detail ? ` (${c.detail})` : ""}</div>
                  {c.notes && <div className="conn-notes">{c.notes}</div>}
                </div>
                {!readOnly && c.swappable && onSwapConnection && <button onClick={(e) => { e.stopPropagation(); onSwapConnection(c.id); }} className="conn-swap-btn" title="Swap direction (flip who introduces whom)">⇄</button>}
                {!readOnly && onRemoveConnection && <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this connection?")) onRemoveConnection(c.id); }} className="person-remove" title="Remove">✕</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {onAddTodo && (
        <TodoSection
          label="Tasks"
          todos={todos}
          contacts={contacts}
          deals={deals}
          enablers={enablers}
          organizations={organizations}
          todoContacts={todoContacts}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onCreateInstitution={onCreateInstitution}
          initial={taskInitialWithInstitution}
          onAdd={onAddTodo}
          onToggle={onToggleTodo}
          onUpdate={onUpdateTodo}
          onNavigate={onNavigateTask}
        />
      )}

      <LinkedNotesSection notes={linkedNotes} onOpenNote={onOpenNote} />

      <QuickAdd contactId={contact.id} contactLinkedin={contact.linkedin} onSaveContactLinkedin={(url) => onUpdate({ linkedin: url })} linkInstitutions={(() => { const seen = new Set(); return roles.map((r) => ({ key: `${r.entity_type}:${r.entity_id}`, label: r.institutionName, dealId: r.entity_type === "deal" ? r.entity_id : null, enablerId: r.entity_type === "enabler" ? r.entity_id : null, organizationId: r.entity_type === "organization" ? r.entity_id : null })).filter((li) => { const k = (li.label || "").trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); })()} primaryInstitution={primaryInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCreateInstitution={createInstitutionAndLinkContact} onAddActivity={onAddActivity} onCreateTasks={onAddTodo ? (tasks) => Promise.all(tasks.map((t) => onAddTodo(t))) : undefined} showToast={showToast} />

      <div className="timeline">
        <div className="section-label">Activity Timeline</div>
        <div className="timeline-tabs">
          {TIMELINE_TABS.map(t => (
            <button key={t.id} onClick={() => setFilter(t.id)} className={`tag-btn ${filter === t.id ? "active" : ""}`}>{t.label}</button>
          ))}
        </div>
        <TimelineAddEntry
          initial={{
            contact_id: contact.id,
            deal_id: primaryInstitution?.dealId || null,
            enabler_id: primaryInstitution?.enablerId || null,
            organization_id: primaryInstitution?.organizationId || null,
          }}
          linkOptions={activityLinkOptions}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onSave={onAddTimelineEntry}
        />
        <div className="timeline-list">
          {filtered.length === 0 && <div className="empty-small">No activities yet</div>}
          {filtered.map(a => (
            <ActivityRow
              key={a.id}
              activity={a}
              deals={deals} enablers={enablers} organizations={organizations} contacts={contacts}
              dealContacts={dealContacts} enablerContacts={enablerContacts} networkEdges={networkEdges} contactRoles={contactRoles}
              onOpenInstitution={onOpenInstitution} onOpenPerson={onOpenPerson} onOpenCalendarEvent={onOpenCalendarEvent}
              onSummarizeEmail={onSummarizeEmail} summarizingId={summarizingActivityId}
              onUpdateActivity={onUpdateActivity} onDeleteActivity={onDeleteActivity}
              linkOptions={activityLinkOptions} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
              hidePerson
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PeopleSection({ people, activities, contacts, institutionName, customOptions = [], onAddCustomOption = () => {}, selectedContactId, onSelectPerson, onAdd, onAddNew, onRemove }) {
  const readOnly = useReadOnly();
  const [adding, setAdding] = useState(false);
  const linkedIds = new Set(people.map(p => p.contact_id));
  const available = contacts.filter(c => !linkedIds.has(c.id));

  return (
    <div className="people-section">
      <div className="ai-summary-header">
        <div className="section-label">People</div>
        {!readOnly && <button onClick={() => setAdding(v => !v)} className="btn-copy">{adding ? "Cancel" : "+ Add Person"}</button>}
      </div>
      {adding && (
        <InstitutionAddPerson
          institutionName={institutionName}
          availableContacts={available}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onAddExisting={async (contactId, role) => { await onAdd(contactId, role); setAdding(false); }}
          onAddNew={async (form) => { await onAddNew(form); setAdding(false); }}
        />
      )}
      {people.length === 0 ? (
        <div className="empty-small">No people linked yet.</div>
      ) : (
        <div className="people-grid">
          {people.map(p => {
            const c = p.contact || {};
            const active = selectedContactId === p.contact_id;
            const count = activities.filter(a => a.contact_id === p.contact_id).length;
            const warmth = WARMTH_LEVELS.find(w => w.id === (c.warmth || "unknown"));
            return (
              <div key={p.id} className={`person-card ${active ? "active" : ""}`} onClick={() => onSelectPerson(p.contact_id)}>
                <div className="person-card-top">
                  <Avatar name={c.name} size={40} />
                  <div className="person-card-body">
                    <div className="person-name">{c.name}</div>
                    {p.role && <div className="person-role">{p.role}</div>}
                    {c.company && <div className="person-company">{c.company}</div>}
                  </div>
                  <div className="person-warmth"><span className="warmth-dot" style={{background:warmth?.color}} />{warmth?.label}</div>
                  {!readOnly && <button onClick={(e) => { e.stopPropagation(); if (confirm(`Remove ${c.name || "this person"}?`)) onRemove(p); }} className="person-remove" title="Remove">✕</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// linkPeople (institution sheets) and linkInstitutions (person sheets) power the
// optional cross-link pickers: an activity logged here can carry BOTH the
// institution FKs and a contact_id, so it appears on both timelines (audit H1).
function QuickAdd({ dealId = null, enablerId = null, organizationId = null, contactId, contactLinkedin = null, onSaveContactLinkedin, linkPeople = [], linkInstitutions = [], primaryInstitution = null, customOptions = [], onAddCustomOption = () => {}, onCreateInstitution, onAddActivity, onCreateTasks, showToast }) {
  const readOnly = useReadOnly();
  const [qType, setQType] = useState("call");
  const [qDesc, setQDesc] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [qWith, setQWith] = useState("");
  // On a Person Sheet, default the "At institution..." picker to the person's
  // primary role so a Quick Add activity cross-links to their institution without
  // the user having to pick anything (audit-style fix: activities logged on a
  // contact card now always reach the institution timeline too).
  const [qAt, setQAt] = useState(() => {
    if (!primaryInstitution) return "";
    const match = linkInstitutions.find((li) =>
      (primaryInstitution.dealId && li.dealId === primaryInstitution.dealId) ||
      (primaryInstitution.enablerId && li.enablerId === primaryInstitution.enablerId) ||
      (primaryInstitution.organizationId && li.organizationId === primaryInstitution.organizationId));
    return match ? match.key : "";
  });
  // Holds the FK set for an institution created inline via "+ Add new
  // institution" here, so it resolves immediately even before linkInstitutions
  // (a prop derived from already-loaded state) has caught up with a reload.
  const [qAtOverride, setQAtOverride] = useState(null);
  const handleCreateInstitution = onCreateInstitution ? async (form) => {
    const created = await onCreateInstitution(form);
    if (created?.preferred) setQAtOverride({ key: `${created.preferred.type}:${created.preferred.id}`, dealId: created.dealId, enablerId: created.enablerId, organizationId: created.orgId });
    return created;
  } : undefined;
  // Effective FK set for this log: the sheet's own entity, then an explicit
  // cross-link pick, then (for a Person Sheet) the person's primary institution
  // as an automatic fallback so the activity always reaches it.
  const linkedInst = linkInstitutions.find((li) => li.key === qAt) || (qAtOverride && qAtOverride.key === qAt ? qAtOverride : null);
  const instFallback = linkedInst || primaryInstitution;
  const fkArgs = () => ({
    dealId: dealId || (instFallback ? instFallback.dealId : null),
    enablerId: enablerId || (instFallback ? instFallback.enablerId : null),
    organizationId: organizationId || (instFallback ? instFallback.organizationId : null),
    contactId: contactId || qWith || null,
  });
  const [posting, setPosting] = useState(false);
  const [summarizingText, setSummarizingText] = useState(false);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const fileInputRef = useRef(null);

  // Voice notes (Section 9): VoiceRecorder captures real audio and uploads it
  // to /api/transcribe (Whisper); the transcript is then sent to Claude here
  // for a clean summary + action items, same as before.
  const [voiceResult, setVoiceResult] = useState(null); // { summary, action_items: [{title, priority, due_date_hint, checked}] }
  const [savingVoice, setSavingVoice] = useState(false);

  const onVoiceDigest = ({ summary, action_items }) => {
    setVoiceResult({ summary, action_items: (action_items || []).map((a) => ({ ...a, checked: true })) });
  };

  const setActionItem = (i, patch) => setVoiceResult((r) => {
    const items = r.action_items.map((a, j) => (j === i ? { ...a, ...patch } : a));
    return { ...r, action_items: items };
  });

  const saveVoiceNote = async (withTasks) => {
    if (!voiceResult || savingVoice) return;
    const summary = voiceResult.summary.trim();
    if (!summary) { showToast("Summary is empty"); return; }
    setSavingVoice(true);
    try {
      const fk = fkArgs();
      await onAddActivity(fk.dealId, fk.contactId, { type: "voice_note", description: summary }, fk.enablerId, fk.organizationId);
      if (withTasks && onCreateTasks) {
        const tasks = voiceResult.action_items
          .filter((a) => a.checked && (a.title || "").trim())
          .map((a) => {
            const hint = (a.due_date_hint || "").trim();
            const due = parseDueHint(hint);
            const title = (!due && hint) ? `${a.title.trim()} (${hint})` : a.title.trim();
            return { title, priority: ["high", "medium", "low"].includes(a.priority) ? a.priority : "medium", due_date: due || undefined };
          });
        if (tasks.length) await onCreateTasks(tasks);
      }
      setVoiceResult(null);
      showToast(withTasks ? "Note saved and tasks created" : "Note saved");
    } catch { showToast("Error saving note"); }
    setSavingVoice(false);
  };

  if (readOnly) return null;

  const submit = async () => {
    const text = qDesc.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      const fk = fkArgs();
      await onAddActivity(fk.dealId, fk.contactId, { type: qType, description: text }, fk.enablerId, fk.organizationId);
      const linkedinToSave = linkedinUrl.trim();
      if (qType === "linkedin" && linkedinToSave && onSaveContactLinkedin) await onSaveContactLinkedin(linkedinToSave);
      setQDesc(""); setQWith(""); setQAt(""); setLinkedinUrl("");
    } finally { setPosting(false); }
  };

  const summarizeTranscript = async () => {
    const text = qDesc.trim();
    if (!text || summarizingText) return;
    setSummarizingText(true);
    try {
      const prompt = `Summarize this meeting transcript. Provide key points, decisions made, and action items. Be concise. Do not use em dashes; use commas, periods, colons, or parentheses instead.\n\nTranscript:\n${text}`;
      setQDesc(await generateSummary(prompt, 1000));
    } catch { showToast("Error summarizing transcript"); }
    setSummarizingText(false);
  };

  const pickPhoto = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setPhotoFile(f);
    const reader = new FileReader();
    reader.onload = () => setPhotoPreview(reader.result);
    reader.readAsDataURL(f);
  };

  const clearPhoto = () => {
    setPhotoFile(null); setPhotoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const summarizePhoto = async () => {
    if (!photoFile || photoLoading) return;
    setPhotoLoading(true);
    try {
      const base64 = await fileToJpegBase64(photoFile);
      const text = await summarizeImage(base64, PHOTO_NOTE_PROMPT);
      const fk = fkArgs();
      await onAddActivity(fk.dealId, fk.contactId, { type: "note", description: text }, fk.enablerId, fk.organizationId);
      clearPhoto();
    } catch { showToast("Error processing photo"); }
    setPhotoLoading(false);
  };

  return (
    <div className="quickadd">
      <div className="section-label">Quick Add</div>
      <div className="quickadd-row">
        {qType === "transcript" ? (
          <textarea
            className="input quickadd-textarea"
            placeholder="Paste meeting transcript..."
            value={qDesc}
            onChange={e => setQDesc(e.target.value)}
          />
        ) : (
          <input
            className="input quickadd-input"
            placeholder="Log an update..."
            value={qDesc}
            onChange={e => setQDesc(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
          />
        )}
        <SelectWithCustom
          className="input quickadd-type"
          options={optionsWithCustom(ACT_TYPES.map(t => ({ id: t.id, label: `${t.icon} ${t.label}` })), customOptions, "activity_type")}
          value={qType}
          onChange={(v) => { setQType(v); trackCustom("activity_type", optionsWithCustom(ACT_TYPES.map(t => ({ id: t.id, label: `${t.icon} ${t.label}` })), customOptions, "activity_type"), onAddCustomOption)(v); }}
        />
        {linkPeople.length > 0 && (
          <select className="input quickadd-link" value={qWith} onChange={(e) => setQWith(e.target.value)} title="Also log this on a person's timeline">
            <option value="">With person...</option>
            {linkPeople.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {(linkInstitutions.length > 0 || onCreateInstitution) && (
          <InstitutionSelect
            options={linkInstitutions} value={qAt} onChange={setQAt} optKey="key" placeholder="At institution..."
            className="input quickadd-link" title="Also log this on an institution's timeline"
            onCreateInstitution={handleCreateInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
          />
        )}
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" className="photo-input-hidden" onChange={pickPhoto} />
        <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-sec photo-btn" title="Upload photo of notes">📷</button>
        <VoiceRecorder mode="digest" onDigest={onVoiceDigest} showToast={showToast} title="Record a voice note" />
        <button onClick={submit} className="btn-primary" disabled={!qDesc.trim() || posting}>Add</button>
      </div>

      {qType === "linkedin" && onSaveContactLinkedin && !contactLinkedin && (
        <input
          className="input quickadd-linkedin-url"
          placeholder="LinkedIn profile URL (optional)"
          value={linkedinUrl}
          onChange={(e) => setLinkedinUrl(e.target.value)}
        />
      )}

      {voiceResult && (
        <div className="voice-result-card">
          <div className="voice-result-head"><span className="voice-result-mic">🎤</span> Meeting Note</div>
          <textarea
            className="input voice-result-summary"
            value={voiceResult.summary}
            onChange={(e) => setVoiceResult((r) => ({ ...r, summary: e.target.value }))}
          />
          {voiceResult.action_items.length > 0 && (
            <div className="voice-actions-list">
              <div className="voice-actions-label">Action Items</div>
              {voiceResult.action_items.map((a, i) => (
                <label key={i} className="voice-action-item">
                  <input type="checkbox" checked={a.checked} onChange={(e) => setActionItem(i, { checked: e.target.checked })} />
                  <span className="voice-action-title">{a.title}</span>
                  <PriorityBadge priority={a.priority} />
                  {a.due_date_hint ? <span className="voice-action-hint">{a.due_date_hint}</span> : null}
                </label>
              ))}
            </div>
          )}
          <div className="voice-result-actions">
            <button type="button" onClick={() => saveVoiceNote(false)} className="btn-sec" disabled={savingVoice}>Save Note</button>
            {onCreateTasks && voiceResult.action_items.some((a) => a.checked) && (
              <button type="button" onClick={() => saveVoiceNote(true)} className="btn-primary" disabled={savingVoice}>Save Note + Create Tasks</button>
            )}
            <button type="button" onClick={() => setVoiceResult(null)} className="link-btn voice-discard" disabled={savingVoice}>Discard</button>
          </div>
        </div>
      )}

      {qType === "transcript" && (
        <div className="quickadd-transcript-actions">
          <button onClick={summarizeTranscript} className="btn-copy" disabled={!qDesc.trim() || summarizingText}>{summarizingText ? "Summarizing..." : "Summarize with AI"}</button>
        </div>
      )}

      {photoPreview && (
        <div className="photo-preview-row">
          <img src={photoPreview} alt="Note preview" className="photo-preview-img" />
          <button onClick={summarizePhoto} className="btn-primary" disabled={photoLoading}>{photoLoading ? "Processing..." : "Summarize"}</button>
          <button onClick={clearPhoto} className="btn-sec" disabled={photoLoading}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function PriorityBadge({ priority }) {
  const p = PRIORITIES.find(x => x.id === priority) || PRIORITIES[PRIORITIES.length - 1];
  return <span className="badge priority-badge" style={{background:p.color+"22",color:p.color,border:`1px solid ${p.color}44`}}>{p.label}</span>;
}

// Collapsible AI summary. Default collapsed to a 2-line preview; click the header
// or chevron to expand. Click the expanded body to edit inline.
function SummaryCard({ entity, activities, onGenerateSummary, onSaveSummary, summarizing }) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [draft, setDraft] = useState(entity.ai_summary || "");

  // Summaries are generated on demand, never automatically on sheet-open: opening
  // a fresh institution or person sheet should not silently cost an API call (L8).
  // An existing summary shows instantly; the empty state and Regenerate button
  // are the only ways to spend. Hidden entirely in read-only (Boss View) mode.
  const mostRecent = activities.length > 0 ? Math.max(...activities.map(a => new Date(a.created_at).getTime())) : 0;
  const summaryTime = entity.ai_summary_updated_at ? new Date(entity.ai_summary_updated_at).getTime() : 0;
  const isStale = !!entity.ai_summary && mostRecent > summaryTime;

  const startEdit = (e) => { e && e.stopPropagation(); setDraft(entity.ai_summary || ""); setCollapsed(false); setEditing(true); };
  const save = async () => { await onSaveSummary(entity.id, draft); setEditing(false); };

  return (
    <div className="ai-summary">
      <div className="ai-summary-header ai-summary-toggle" onClick={() => !editing && setCollapsed(c => !c)}>
        <div className="section-label">AI Summary</div>
        <div className="ai-summary-header-right">
          {!readOnly && isStale && !summarizing && <span className="ai-summary-stale" title="Activity has been logged since this summary was written">New activity since last summary</span>}
          {!readOnly && <button onClick={(e) => { e.stopPropagation(); onGenerateSummary(entity, activities); }} className="link-btn" disabled={summarizing}>Regenerate</button>}
          {!editing && <span className="ai-summary-chevron">{collapsed ? "▸" : "▾"}</span>}
        </div>
      </div>
      {summarizing ? (
        <div className="empty-small">Updating summary...</div>
      ) : editing ? (
        <>
          <textarea className="input textarea ai-summary-edit" value={draft} onChange={e => setDraft(e.target.value)} />
          <div className="ai-summary-edit-actions">
            <button onClick={() => setEditing(false)} className="btn-sec">Cancel</button>
            <button onClick={save} className="btn-primary">Save</button>
          </div>
        </>
      ) : entity.ai_summary ? (
        <>
          <div className={`ai-summary-text ${collapsed ? "ai-summary-collapsed" : ""}`} onClick={readOnly ? undefined : startEdit} title={readOnly ? undefined : "Click to edit"}>{entity.ai_summary}</div>
          {!collapsed && <div className="ai-summary-updated">Last updated: {formatDate(entity.ai_summary_updated_at)}</div>}
        </>
      ) : readOnly ? (
        <div className="empty-small">No summary yet.</div>
      ) : (
        <button className="link-btn" onClick={(e) => { e.stopPropagation(); onGenerateSummary(entity, activities); }}>Generate summary</button>
      )}
    </div>
  );
}

// The compact inline "+ Add new institution" mini-form embedded directly inside
// any institution picker (never navigates away): name, type, Target/Enabler.
// `onCreate` is expected to create the institution and resolve to a truthy
// value on success (falsy leaves the form open so the user can retry).
function InstitutionCreateForm({ customOptions = [], onAddCustomOption = () => {}, onCreate, onCancel }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("hospital");
  const [isTarget, setIsTarget] = useState(false);
  const [isEnabler, setIsEnabler] = useState(false);
  const [saving, setSaving] = useState(false);
  const typeOpts = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const ok = await onCreate({ name: name.trim(), type, isTarget, isEnabler });
      if (!ok) setSaving(false);
    } catch { setSaving(false); }
  };

  return (
    <div className="inst-create-inline" onClick={(e) => e.stopPropagation()}>
      <input
        className="input" placeholder="Institution name" autoFocus value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
      />
      <SelectWithCustom options={typeOpts} value={type} onChange={(v) => { setType(v); trackCustom("institution_type", typeOpts, onAddCustomOption)(v); }} />
      <div className="inst-create-inline-flags">
        <label className="checkbox-label"><input type="checkbox" checked={isTarget} onChange={(e) => setIsTarget(e.target.checked)} /> Target</label>
        <label className="checkbox-label"><input type="checkbox" checked={isEnabler} onChange={(e) => setIsEnabler(e.target.checked)} /> Enabler</label>
      </div>
      <div className="inst-create-inline-actions">
        <button type="button" className="btn-sec" onMouseDown={onCancel}>Cancel</button>
        <button type="button" className="btn-primary" onMouseDown={submit} disabled={!name.trim() || saving}>{saving ? "Creating..." : "Create"}</button>
      </div>
    </div>
  );
}

// Plain-<select>-based institution picker (the app's usual pattern for a single
// institution field). Adds a "+ Add new institution" option at the bottom;
// picking it swaps the select for InstitutionCreateForm, and on success selects
// the new institution and returns to the normal dropdown.
function InstitutionSelect({ options, value, onChange, onCreateInstitution, customOptions = [], onAddCustomOption = () => {}, placeholder = "Select institution...", className = "input", optKey = "value", rawId = false, title }) {
  const [creating, setCreating] = useState(false);
  if (creating) {
    return (
      <InstitutionCreateForm
        customOptions={customOptions}
        onAddCustomOption={onAddCustomOption}
        onCancel={() => setCreating(false)}
        onCreate={async (form) => {
          const created = await onCreateInstitution(form);
          if (created?.preferred) { onChange(rawId ? String(created.preferred.id) : `${created.preferred.type}:${created.preferred.id}`); setCreating(false); return true; }
          return false;
        }}
      />
    );
  }
  return (
    <select className={className} title={title} value={value} onChange={(e) => { if (e.target.value === "__create__") setCreating(true); else onChange(e.target.value); }}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o[optKey]} value={o[optKey]}>{o.label}</option>)}
      {onCreateInstitution && <option value="__create__">+ Add new institution</option>}
    </select>
  );
}

// Searchable single-select for linking a task to one entity. Shows the picked
// item as a removable chip; otherwise a filter input over the options. When
// `onCreateInstitution` is supplied, an extra "+ Add new institution" entry at
// the bottom of the results swaps the dropdown for an inline creation form.
function EntityPicker({ placeholder, options, value, onChange, onCreateInstitution, customOptions = [], onAddCustomOption = () => {} }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const selected = options.find((o) => o.value === value);
  const query = q.trim().toLowerCase();
  const filtered = (query ? options.filter((o) => o.label.toLowerCase().includes(query)) : options).slice(0, 8);
  if (selected) {
    return (
      <div className="entity-picker">
        <span className="entity-picker-chip">
          {selected.label}
          <button type="button" className="entity-picker-clear" onClick={() => onChange("")} title="Unlink">✕</button>
        </span>
      </div>
    );
  }
  if (creating) {
    return (
      <div className="entity-picker">
        <InstitutionCreateForm
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onCancel={() => setCreating(false)}
          onCreate={async (form) => {
            const created = await onCreateInstitution(form);
            if (created?.preferred) { onChange(`${created.preferred.type}:${created.preferred.id}`); setCreating(false); setOpen(false); return true; }
            return false;
          }}
        />
      </div>
    );
  }
  return (
    <div className="entity-picker">
      <input
        className="input entity-picker-input"
        placeholder={placeholder}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="entity-picker-options">
          {filtered.length === 0 ? <div className="empty-small entity-picker-empty">No matches.</div> : filtered.map((o) => (
            <button type="button" key={o.value} className="entity-picker-option" onMouseDown={() => { onChange(o.value); setQ(""); setOpen(false); }}>{o.label}</button>
          ))}
          {onCreateInstitution && (
            <button type="button" className="entity-picker-option entity-picker-create" onMouseDown={() => setCreating(true)}>+ Add new institution</button>
          )}
        </div>
      )}
    </div>
  );
}

// Multi-select over a list of {value, label} options: already-picked entries
// show as removable chips, with a search box below to add more. Used for a
// task's contacts, where any number of people can be linked.
// Generic multi-select over {value, label} options: already-picked entries
// show as removable pills, with a search box below to add more. Used for a
// task's contacts, and (with onCreateInstitution) for tagging institutions on
// a calendar event, where "+ Add new institution" creates one inline.
function MultiContactPicker({ options, value = [], onChange, placeholder = "Search contacts...", onCreateInstitution, customOptions = [], onAddCustomOption = () => {} }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const selected = value.map((id) => options.find((o) => o.value === id)).filter(Boolean);
  const query = q.trim().toLowerCase();
  const available = options.filter((o) => !value.includes(o.value));
  const filtered = (query ? available.filter((o) => o.label.toLowerCase().includes(query)) : available).slice(0, 8);
  const add = (id) => { onChange([...value, id]); setQ(""); setOpen(false); };
  const remove = (id) => onChange(value.filter((v) => v !== id));
  return (
    <div className="entity-picker multi-contact-picker">
      {selected.length > 0 && (
        <div className="multi-contact-pills">
          {selected.map((o) => (
            <span key={o.value} className="entity-picker-chip">
              {o.label}
              <button type="button" className="entity-picker-clear" onClick={() => remove(o.value)} title="Remove">✕</button>
            </span>
          ))}
        </div>
      )}
      {creating ? (
        <InstitutionCreateForm
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onCancel={() => setCreating(false)}
          onCreate={async (form) => {
            const created = await onCreateInstitution(form);
            if (created?.preferred) { add(`${created.preferred.type}:${created.preferred.id}`); setCreating(false); return true; }
            return false;
          }}
        />
      ) : (
        <>
          <input
            className="input entity-picker-input"
            placeholder={placeholder}
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {open && (
            <div className="entity-picker-options">
              {filtered.length === 0 ? <div className="empty-small entity-picker-empty">No matches.</div> : filtered.map((o) => (
                <button type="button" key={o.value} className="entity-picker-option" onMouseDown={() => add(o.value)}>{o.label}</button>
              ))}
              {onCreateInstitution && (
                <button type="button" className="entity-picker-option entity-picker-create" onMouseDown={() => setCreating(true)}>+ Add new institution</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The one task form used everywhere (Tasks tab quick-add, sheet To-Do/Task
// sections, and inline task editing). Links to any combination of deal,
// institution (enabler or organization), and any number of contacts. `initial`
// pre-fills from context (its `contact_ids` array, falling back to a single
// `contact_id`); when there is no onCancel it behaves as a persistent quick-add
// and resets after each save.
function TaskForm({ deals = [], enablers = [], organizations = [], contacts = [], customOptions = [], onAddCustomOption = () => {}, onCreateInstitution, initial = {}, onSave, onCancel, submitLabel = "Add Task", showToast = () => {} }) {
  const [title, setTitle] = useState(initial.title || "");
  const [priority, setPriority] = useState(initial.priority || "medium");
  const [dueDate, setDueDate] = useState(initial.due_date || "");
  const [dealId, setDealId] = useState(initial.deal_id || "");
  const [inst, setInst] = useState(initial.enabler_id ? `enabler:${initial.enabler_id}` : initial.organization_id ? `organization:${initial.organization_id}` : "");
  const [contactIds, setContactIds] = useState(initial.contact_ids || (initial.contact_id ? [initial.contact_id] : []));
  const [saving, setSaving] = useState(false);
  const priorityOpts = optionsWithCustom(PRIORITIES, customOptions, "priority");

  const dealOpts = deals.map((d) => ({ value: d.id, label: d.company })).filter((o) => o.label);
  // Deals have their own picker, so the Institution picker only dedupes
  // enablers and organizations (prefer enabler so its gold pill is kept).
  const instOpts = dedupeInstitutionOptions({ enablers, organizations, prefer: ["enabler", "organization"] });
  const contactOpts = contacts.map((c) => ({ value: c.id, label: c.name })).filter((o) => o.label);
  // A freshly created institution flagged as a Target resolves to "deal:id"
  // (there is no separate deal picker to fall back to here), so route it to
  // the Deal picker instead of the Institution one.
  const handleInstChange = (v) => { if (v.startsWith("deal:")) { setDealId(v.slice(5)); setInst(""); } else setInst(v); };

  const submit = async () => {
    if (!title.trim() || saving) return;
    const form = { title: title.trim(), priority, due_date: dueDate || null, deal_id: dealId || null, enabler_id: null, organization_id: null, contact_ids: contactIds, contact_id: contactIds[0] || null };
    if (inst.startsWith("enabler:")) form.enabler_id = inst.slice(8);
    else if (inst.startsWith("organization:")) form.organization_id = inst.slice(13);
    setSaving(true);
    try {
      await onSave(form);
      if (!onCancel) { setTitle(""); setPriority("medium"); setDueDate(""); setDealId(""); setInst(""); setContactIds([]); }
    } finally { setSaving(false); }
  };

  return (
    <div className="task-form">
      <div className="task-form-title-row">
        <input className="input task-form-title" placeholder="Task title..." value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} />
        <VoiceRecorder mode="plain" onPlainText={(t) => setTitle((v) => (v.trim() ? `${v.trim()} ${t}` : t))} showToast={showToast} compact title="Dictate task title" />
      </div>
      <div className="task-form-row">
        <SelectWithCustom className="input task-form-priority" options={priorityOpts} value={priority} onChange={(v) => { setPriority(v); trackCustom("priority", priorityOpts, onAddCustomOption)(v); }} />
        <input className="input task-form-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <div className="task-form-links">
        <div className="task-form-link"><span className="task-form-link-label">Deal</span><EntityPicker placeholder="Search deals..." options={dealOpts} value={dealId} onChange={setDealId} /></div>
        <div className="task-form-link"><span className="task-form-link-label">Institution</span><EntityPicker placeholder="Search enablers and orgs..." options={instOpts} value={inst} onChange={handleInstChange} onCreateInstitution={onCreateInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption} /></div>
        <div className="task-form-link"><span className="task-form-link-label">Contacts</span><MultiContactPicker placeholder="Search contacts..." options={contactOpts} value={contactIds} onChange={setContactIds} /></div>
      </div>
      <div className="task-form-actions">
        {onCancel && <button className="btn-sec" onClick={onCancel}>Cancel</button>}
        <button className="btn-primary" onClick={submit} disabled={!title.trim() || saving}>{submitLabel}</button>
      </div>
    </div>
  );
}

// Clickable pills for every entity a task is linked to: blue deal, gold enabler,
// green contact, gray organization. Clicking navigates to that entity's sheet.
function TaskPills({ todo, deals = [], enablers = [], organizations = [], contacts = [], todoContacts = [], onNavigate }) {
  const pills = [];
  if (todo.deal_id) { const d = deals.find((x) => x.id === todo.deal_id); if (d) pills.push({ kind: "deal", id: d.id, label: d.company }); }
  if (todo.enabler_id) { const e = enablers.find((x) => x.id === todo.enabler_id); if (e) pills.push({ kind: "enabler", id: e.id, label: e.name }); }
  if (todo.organization_id) { const o = organizations.find((x) => x.id === todo.organization_id); if (o) pills.push({ kind: "organization", id: o.id, label: o.name }); }
  // A task can now link any number of people via todo_contacts; fall back to
  // the legacy single contact_id for rows from before that table existed.
  const linkedContactIds = todoContacts.length
    ? [...new Set(todoContacts.filter((tc) => tc.todo_id === todo.id).map((tc) => tc.contact_id))]
    : (todo.contact_id ? [todo.contact_id] : []);
  linkedContactIds.forEach((cid) => { const c = contacts.find((x) => x.id === cid); if (c) pills.push({ kind: "contact", id: c.id, label: c.name }); });
  if (pills.length === 0) return null;
  return (
    <div className="task-pills">
      {pills.map((p) => (onNavigate
        ? <button key={`${p.kind}-${p.id}`} className={`task-pill task-pill-${p.kind}`} onClick={() => onNavigate({ type: p.kind, id: p.id })}>{p.label}</button>
        : <span key={`${p.kind}-${p.id}`} className={`task-pill task-pill-${p.kind}`}>{p.label}</span>))}
    </div>
  );
}

function TodoRow({ todo, contacts = [], deals = [], enablers = [], organizations = [], todoContacts = [], customOptions = [], onAddCustomOption = () => {}, onCreateInstitution, onToggle, onUpdate, onNavigate }) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState(false);
  const overdue = todo.status !== "completed" && isOverdue(todo.due_date);
  const done = todo.status === "completed";

  if (editing && !readOnly && onUpdate) {
    const contactIds = todoContacts.length
      ? [...new Set(todoContacts.filter((tc) => tc.todo_id === todo.id).map((tc) => tc.contact_id))]
      : (todo.contact_id ? [todo.contact_id] : []);
    return (
      <div className="todo-row todo-row-editing">
        <input type="checkbox" checked={done} onChange={() => onToggle(todo)} className="todo-checkbox" />
        <div className="todo-main">
          <TaskForm
            deals={deals} enablers={enablers} organizations={organizations} contacts={contacts}
            customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCreateInstitution={onCreateInstitution}
            initial={{ ...todo, contact_ids: contactIds }} submitLabel="Save"
            onSave={(form) => { onUpdate(todo.id, form); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`todo-row ${done ? "todo-done" : ""}`}>
      <input type="checkbox" checked={done} onChange={() => onToggle(todo)} disabled={readOnly} className="todo-checkbox" />
      <div className="todo-main">
        <div className="todo-title-row">
          <span className="todo-title">{todo.title}</span>
          {!readOnly && !done && onUpdate && <button onClick={() => setEditing(true)} className="icon-btn" title="Edit task">✎</button>}
          {!readOnly && onUpdate
            ? <BadgeSelect options={PRIORITIES} value={todo.priority} color={PRIORITIES.find(p => p.id === todo.priority)?.color} onChange={(v) => onUpdate(todo.id, { priority: v })} title="Change priority" />
            : <PriorityBadge priority={todo.priority} />}
          {overdue && <span className="badge overdue-badge">Overdue</span>}
          {!readOnly && done && <button onClick={() => onToggle(todo)} className="btn-copy todo-reopen">Reopen</button>}
        </div>
        <div className="todo-meta-row">
          {done && todo.completed_at && <span className="todo-due">Completed {formatDate(todo.completed_at)}</span>}
          {!done && todo.due_date && <span className="todo-due">Due {formatDate(todo.due_date)}</span>}
        </div>
        <TaskPills todo={todo} deals={deals} enablers={enablers} organizations={organizations} contacts={contacts} todoContacts={todoContacts} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

// A tasks section for a sheet (institution "To-Dos" or person "Tasks"). The
// "+ Task" button expands the shared TaskForm, pre-filled from `initial`.
function TodoSection({ label = "To-Dos", todos, contacts = [], deals = [], enablers = [], organizations = [], todoContacts = [], customOptions = [], onAddCustomOption = () => {}, onCreateInstitution, initial = {}, onAdd, onToggle, onUpdate, onNavigate }) {
  const readOnly = useReadOnly();
  const [showForm, setShowForm] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const open = sortTodos(todos.filter(t => t.status !== "completed"));
  const completed = todos.filter(t => t.status === "completed").slice().sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  const rowProps = { contacts, deals, enablers, organizations, todoContacts, customOptions, onAddCustomOption, onCreateInstitution, onToggle, onUpdate, onNavigate };

  return (
    <div className="todo-section">
      <div className="ai-summary-header">
        <div className="section-label">{label}</div>
        {!readOnly && <button onClick={() => setShowForm(s => !s)} className="btn-copy">{showForm ? "Cancel" : "+ Task"}</button>}
      </div>
      {showForm && (
        <TaskForm
          deals={deals} enablers={enablers} organizations={organizations} contacts={contacts}
          customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCreateInstitution={onCreateInstitution}
          initial={initial} submitLabel="Add Task"
          onCancel={() => setShowForm(false)}
          onSave={async (form) => { await onAdd(form); setShowForm(false); }}
        />
      )}
      {open.length === 0 ? (
        <div className="empty-small">No open tasks.</div>
      ) : (
        <div className="todo-list">
          {open.map(t => <TodoRow key={t.id} todo={t} {...rowProps} />)}
        </div>
      )}
      {completed.length > 0 && (
        <div className="todo-completed-toggle">
          <button onClick={() => setShowCompleted(s => !s)} className="link-btn">{showCompleted ? "▾" : "▸"} Completed ({completed.length})</button>
          {showCompleted && (
            <div className="todo-list todo-list-completed">
              {completed.map(t => <TodoRow key={t.id} todo={t} {...rowProps} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// Traverses network_edges outward from a deal (and its matching organization, if any)
// up to 2 hops, to surface indirect paths in, e.g. "BECO Capital > Sahab > NUPCO".
function findNetworkPaths(deal, rootOrg, networkEdges, organizations, enablers, contacts, contactRoles = []) {
  const roots = [{ type: "deal", id: deal.id, name: deal.company }];
  if (rootOrg) roots.push({ type: "organization", id: rootOrg.id, name: rootOrg.name });
  const rootKeys = new Set(roots.map(r => `${r.type}:${r.id}`));

  const resolve = (type, id) => {
    if (type === "organization") return organizations.find(o => o.id === id);
    if (type === "enabler") return enablers.find(e => e.id === id);
    if (type === "contact") return contacts.find(c => c.id === id);
    if (type === "deal") return deal.id === id ? deal : null;
    return null;
  };
  const nameOf = (entity) => entity.name || entity.company || "";

  // Two kinds of hops: explicit network_edges, and implicit ones inferred from
  // contact_roles (the same person holding roles at two different institutions).
  const neighborsOf = (type, id) => {
    const edgeNeighbors = networkEdges
      .filter(ne => (ne.source_type === type && ne.source_id === id) || (ne.target_type === type && ne.target_id === id))
      .map(ne => {
        const isSource = ne.source_type === type && ne.source_id === id;
        const otherType = isSource ? ne.target_type : ne.source_type;
        const otherId = isSource ? ne.target_id : ne.source_id;
        const rel = NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === ne.relationship)?.label || ne.relationship;
        return { type: otherType, id: otherId, key: `edge-${ne.id}`, via: ne.notes || rel };
      });
    const roleNeighbors = [];
    contactRoles.filter(r => r.entity_type === type && r.entity_id === id).forEach(r => {
      const contactName = r.contacts?.name || contacts.find(c => c.id === r.contact_id)?.name || "a shared contact";
      contactRoles.filter(r2 => r2.contact_id === r.contact_id && !(r2.entity_type === type && r2.entity_id === id)).forEach(r2 => {
        roleNeighbors.push({ type: r2.entity_type, id: r2.entity_id, key: `role-${r.id}-${r2.id}`, via: `${contactName}${r2.role_title ? ` (${r2.role_title})` : ""}` });
      });
    });
    return [...edgeNeighbors, ...roleNeighbors];
  };

  const paths = [];
  const seen = new Set();
  roots.forEach(root => {
    neighborsOf(root.type, root.id).forEach(n1 => {
      if (rootKeys.has(`${n1.type}:${n1.id}`)) return;
      const e1 = resolve(n1.type, n1.id);
      if (!e1) return;
      if (!seen.has(n1.key)) {
        seen.add(n1.key);
        paths.push({ id: n1.key, chain: [nameOf(e1), root.name], via: [n1.via] });
      }
      neighborsOf(n1.type, n1.id).forEach(n2 => {
        if (rootKeys.has(`${n2.type}:${n2.id}`)) return;
        if (n2.type === n1.type && n2.id === n1.id) return;
        const e2 = resolve(n2.type, n2.id);
        if (!e2) return;
        const key = `${n1.key}-${n2.key}`;
        if (!seen.has(key)) {
          seen.add(key);
          paths.push({ id: key, chain: [nameOf(e2), nameOf(e1), root.name], via: [n2.via, n1.via] });
        }
      });
    });
  });
  return paths;
}


function AddOrgLinkModal({ title, pickLabel, entityOptions, showRole, customOptions = [], onAddCustomOption = () => {}, onCreateInstitution, onSave, onClose }) {
  const [entityId, setEntityId] = useState("");
  const [relationship, setRelationship] = useState("knows");
  const [role, setRole] = useState("");
  const [strength, setStrength] = useState("medium");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const relOpts = optionsWithCustom(NETWORK_EDGE_RELATIONSHIPS, customOptions, "relationship_type");
  const strengthOpts = optionsWithCustom(STRENGTHS, customOptions, "strength");
  const submit = async () => {
    if (!entityId || saving) return;
    setSaving(true);
    try { await onSave({ entityId, relationship, role, strength, notes }); } finally { setSaving(false); }
  };
  return (
    <div className="overlay" onClick={onClose}><div className="modal modal-sm" onClick={e => e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{title}</div><button onClick={onClose} className="close-btn">✕</button></div>
      {entityOptions.length === 0 && !onCreateInstitution ? (
        <div className="empty-small">Nothing available to link.</div>
      ) : (
        <div className="mb-sm">
          <label className="label">{pickLabel}</label>
          <InstitutionSelect
            options={entityOptions} value={entityId} onChange={setEntityId} optKey="id" placeholder="Select..." rawId
            onCreateInstitution={onCreateInstitution ? async (form) => { const created = await onCreateInstitution(form); return created ? { preferred: { id: created.orgId } } : null; } : undefined}
            customOptions={customOptions} onAddCustomOption={onAddCustomOption}
          />
        </div>
      )}
      <div className="mb-sm"><label className="label">Relationship</label><SelectWithCustom options={relOpts} value={relationship} onChange={(v)=>{setRelationship(v); trackCustom("relationship_type", relOpts, onAddCustomOption)(v);}} /></div>
      {showRole && (
        <div className="mb-sm"><label className="label">Role / Title</label><input className="input" value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. CEO, Board Member" /></div>
      )}
      <div className="mb-sm"><label className="label">Strength</label><SelectWithCustom options={strengthOpts} value={strength} onChange={(v)=>{setStrength(v); trackCustom("strength", strengthOpts, onAddCustomOption)(v);}} /></div>
      <div className="mb-sm"><label className="label">Notes</label><textarea className="input textarea" value={notes} onChange={e => setNotes(e.target.value)} /></div>
      <div className="modal-actions">
        <button onClick={onClose} className="btn-sec">Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!entityId || saving}>{saving ? "Adding..." : "Add"}</button>
      </div>
    </div></div>
  );
}

// Matches a raw type value against the known vocabularies case insensitively, so
// legacy free-typed values (e.g. "Hospital" typed before custom_options existed)
// group under the same canonical entry as new lowercase ids.
function institutionTypeMeta(typeId, customOptions = []) {
  const norm = (typeId || "").trim().toLowerCase();
  const found = INSTITUTION_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm)
    || ORG_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm)
    || optionsFromCustom(customOptions, "institution_type").find(t => t.id.toLowerCase() === norm);
  if (found) return found;
  const label = typeId ? typeId.charAt(0).toUpperCase() + typeId.slice(1).replace(/_/g, " ") : "Other";
  return { id: norm || "other", label, color: "#7B8A9E" };
}

// Canonical grouping key for a raw type value: the matching known id if one
// exists (case insensitively), otherwise the lowercased raw value so same-spelled
// custom values still collapse into a single group.
function normalizeTypeKey(typeId) {
  const norm = (typeId || "").trim().toLowerCase();
  const known = INSTITUTION_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm) || ORG_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm);
  return known ? known.id : norm;
}

const INSTITUTION_TYPE_PLURALS = {
  hospital: "Hospitals", vc: "VCs", government: "Government", tech_company: "Tech Companies",
  payer: "Payers", regulator: "Regulators", association: "Associations", research: "Research",
  pharmaceutical: "Pharmaceutical",
};

// Dropdown options for picking an existing institution (one per name), valued by
// the contact_roles primary entity ("type:id").
function institutionPickerOptions(institutions, customOptions) {
  return institutions.map(i => {
    const pe = institutionPrimaryEntity(i);
    return pe ? { key: `${pe.type}:${pe.id}`, label: `${i.name}${i.type ? ` (${institutionTypeMeta(i.type, customOptions).label})` : ""}` } : null;
  }).filter(Boolean);
}

// Every person linked to an institution, unioning contact_roles across the
// institution's deal/enabler/organization plus legacy junction rows/edges.
function institutionPeople(inst, { contactRoles, dealContacts, enablerContacts, networkEdges, contacts }) {
  const targets = [];
  if (inst.dealId) targets.push(["deal", inst.dealId]);
  if (inst.enablerId) targets.push(["enabler", inst.enablerId]);
  if (inst.orgId) targets.push(["organization", inst.orgId]);
  const rows = [];
  contactRoles.forEach(r => { if (targets.some(([t, id]) => r.entity_type === t && r.entity_id === id)) rows.push({ contactId: r.contact_id, role: r.role_title, source: "role", roleRow: r }); });
  if (inst.dealId) dealContacts.filter(dc => dc.deal_id === inst.dealId).forEach(dc => rows.push({ contactId: dc.contact_id, role: dc.role_in_deal, source: "legacy" }));
  if (inst.enablerId) enablerContacts.filter(ec => ec.enabler_id === inst.enablerId).forEach(ec => rows.push({ contactId: ec.contact_id, role: ec.role_in_org, source: "legacy" }));
  if (inst.orgId) networkEdges.filter(ne => ne.source_type === "contact" && ne.target_type === "organization" && ne.target_id === inst.orgId).forEach(ne => rows.push({ contactId: ne.source_id, role: ne.notes, source: "edge", removeId: ne.id }));
  const seen = new Set();
  return rows.filter(p => { if (seen.has(p.contactId)) return false; seen.add(p.contactId); return true; })
    .map(p => ({ ...p, contact: contacts.find(c => c.id === p.contactId) }))
    .filter(p => p.contact);
}

function InstitutionSheet({
  institution: inst, summaryEntity, activities, allActivities, contacts, deals, enablers, organizations,
  dealContacts, enablerContacts, networkEdges, contactRoles, customOptions = [], onAddCustomOption = () => {}, onCreateInstitution,
  onUpdate, onUpdateCity, onRename, onAutoFill, onAutoFillIfEmpty, researching, onSetFlag, onDelete, onAddActivity, onSummarizeEmail, summarizingActivityId, onUpdateActivity, onDeleteActivity, onAddTimelineEntry, activityLinkOptions = {}, linkedNotes = [], onOpenNote, onAddPersonRole, onAddPersonWithRoles, onRemoveRole, onRemoveNetworkEdge, onAddConnection,
  onResearchKeyPeople, onResearchTrials, onSaveResearch, onAddResearchedPerson, onAddResearchedPeople,
  onChangeStage, onChangeTier, onUpdateDeal, todos = [], todoContacts = [], taskInitial = {}, onAddTodo, onToggleTodo, onUpdateTodo, onNavigate,
  materials = [], materialLinks = [], onAttachMaterial, onRemoveMaterialLink, onDownloadMaterial,
  onGenerateSummary, onSaveSummary, summarizing, showToast, onOpenInstitution, onOpenPerson, onOpenCalendarEvent, onBack, backLabel = "Back to Ecosystem", bossNotesSlot,
}) {
  const readOnly = useReadOnly();
  const [filter, setFilter] = useState("all");
  const [timelineScope, setTimelineScope] = useState("all");
  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const meta = institutionTypeMeta(inst.type, customOptions);
  const stage = STAGES.find(s => s.id === (inst.stage || "prospecting"));
  const tier = DEAL_TIERS.find(t => t.id === (inst.deal?.tier || "Untiered"));
  const typeOpts = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");
  const cityOpts = optionsWithCustom(CITY_OPTIONS, customOptions, "city");
  // Auto-research an institution the first time its sheet opens with no description.
  useEffect(() => {
    if (onAutoFillIfEmpty) onAutoFillIfEmpty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.key]);

  // ---- "Research Key People" state ----
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchStatus, setResearchStatus] = useState("");
  const [researchError, setResearchError] = useState(null);
  const [researchResults, setResearchResults] = useState(null);
  const [researchedAt, setResearchedAt] = useState(null);
  const [trials, setTrials] = useState(null);
  const [trialsLoading, setTrialsLoading] = useState(false);
  const [addedKeys, setAddedKeys] = useState({});
  const [addingAll, setAddingAll] = useState(false);
  const [addAllCount, setAddAllCount] = useState(0);

  // Hydrate previous research (from organizations.research_data) when the sheet opens.
  useEffect(() => {
    setAddedKeys({}); setAddingAll(false); setResearchLoading(false); setTrialsLoading(false); setResearchError(null); setResearchStatus("");
    let hydrated = false;
    if (inst.researchData) {
      try {
        const d = JSON.parse(inst.researchData);
        setResearchResults(d.people || null);
        setTrials(d.trials ? { trials: d.trials } : null);
        setResearchedAt(d.researchedAt || null);
        setResearchOpen(!!(d.people));
        hydrated = true;
      } catch { /* ignore malformed history */ }
    }
    if (!hydrated) { setResearchResults(null); setTrials(null); setResearchedAt(null); setResearchOpen(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.key]);

  const people = institutionPeople(inst, { contactRoles, dealContacts, enablerContacts, networkEdges, contacts });
  // The cumulative timeline: every activity tagged directly to this
  // institution, PLUS every activity logged with any of its people (a role at
  // this institution is enough, regardless of which entity the activity's own
  // FK points at). Array.filter never repeats an element, so this is already
  // deduplicated by construction.
  const peopleContactIds = new Set(people.map((p) => p.contactId));
  const cumulativeActivities = (allActivities || activities).filter((a) =>
    (inst.dealId && a.deal_id === inst.dealId) ||
    (inst.enablerId && a.enabler_id === inst.enablerId) ||
    (inst.orgId && a.organization_id === inst.orgId) ||
    (a.contact_id && peopleContactIds.has(a.contact_id)));
  const cumulativePeopleCount = new Set(cumulativeActivities.map((a) => a.contact_id).filter(Boolean)).size;
  // A researched person counts as "added" if this session added them, or a
  // person with the same name is already linked to this institution (so
  // reopening the sheet and Add All never create duplicates).
  const networkNames = new Set(people.map(p => (p.contact.name || "").trim().toLowerCase()));
  const isAdded = (key, name) => !!addedKeys[key] || networkNames.has((name || "").trim().toLowerCase());

  const researchPeopleList = () => [
    ...((researchResults?.clinical_champions) || []).map((p, i) => ({ p, key: `cc:${i}` })),
    ...((researchResults?.decision_makers) || []).map((p, i) => ({ p, key: `dm:${i}` })),
  ].filter(x => (x.p.name || "").trim());

  const runResearch = async () => {
    setResearchOpen(true); setResearchLoading(true); setResearchError(null); setResearchStatus("");
    setResearchResults(null); setTrials(null); setResearchedAt(null); setAddedKeys({});
    let people;
    try {
      people = await onResearchKeyPeople((msg) => setResearchStatus(msg));
      setResearchResults(people);
    } catch (e) {
      setResearchLoading(false); setResearchStatus("");
      setResearchError(e?.message || "unknown error");
      return;
    }
    setResearchLoading(false); setResearchStatus("");
    // Second call: clinical trials supplement.
    setTrialsLoading(true);
    let trialsRes = { trials: [] };
    try { trialsRes = await onResearchTrials(); } catch { trialsRes = { trials: [] }; }
    setTrials(trialsRes); setTrialsLoading(false);
    const at = new Date().toISOString();
    setResearchedAt(at);
    onSaveResearch({ people, trials: trialsRes.trials || [], researchedAt: at });
  };

  const addOne = async (person, key) => {
    const created = await onAddResearchedPerson(person);
    if (created) setAddedKeys(a => ({ ...a, [key]: true }));
  };
  const addAll = async () => {
    const pending = researchPeopleList().filter(x => !isAdded(x.key, x.p.name));
    if (pending.length === 0) return;
    setAddAllCount(pending.length); setAddingAll(true);
    await onAddResearchedPeople(pending.map(x => x.p));
    setAddedKeys(a => { const n = { ...a }; pending.forEach(x => { n[x.key] = true; }); return n; });
    setAddingAll(false);
  };
  const pendingCount = researchPeopleList().filter(x => !isAdded(x.key, x.p.name)).length;

  const scopedActivities = timelineScope === "direct" ? activities : cumulativeActivities;
  const filtered = scopedActivities.filter(a => filter === "all" || a.type === filter).slice().reverse();
  const primary = institutionPrimaryEntity(inst);

  const targets = [["deal", inst.dealId], ["enabler", inst.enablerId], ["organization", inst.orgId]].filter(([, id]) => id);
  const alsoAt = (contactId) => contactRoles
    .filter(r => r.contact_id === contactId && !targets.some(([t, id]) => r.entity_type === t && r.entity_id === id))
    .map(r => {
      const other = r.entity_type === "deal" ? deals.find(d => d.id === r.entity_id) : r.entity_type === "enabler" ? enablers.find(e => e.id === r.entity_id) : organizations.find(o => o.id === r.entity_id);
      if (!other) return null;
      return { name: r.entity_type === "deal" ? other.company : other.name, role: r.role_title };
    }).filter(Boolean);

  // Explicit org-to-org / org-to-deal / org-to-enabler connections.
  const touches = (ne, kind) => inst.orgId && ((ne.source_type === "organization" && ne.source_id === inst.orgId && ne.target_type === kind) || (ne.target_type === "organization" && ne.target_id === inst.orgId && ne.source_type === kind));
  const otherEnd = (ne, kind) => { const isSrc = ne.source_type === "organization" && ne.source_id === inst.orgId; const ot = isSrc ? ne.target_type : ne.source_type; const oid = isSrc ? ne.target_id : ne.source_id; return ot === kind ? oid : null; };
  const explicitConns = [
    ...networkEdges.filter(ne => touches(ne, "organization")).map(ne => { const o = organizations.find(x => x.id === otherEnd(ne, "organization")); return o ? { id: ne.id, name: o.name, rel: ne.relationship, removable: true } : null; }),
    ...networkEdges.filter(ne => touches(ne, "deal")).map(ne => { const d = deals.find(x => x.id === otherEnd(ne, "deal")); return d ? { id: ne.id, name: d.company, rel: ne.relationship, removable: true } : null; }),
    ...networkEdges.filter(ne => touches(ne, "enabler")).map(ne => { const e = enablers.find(x => x.id === otherEnd(ne, "enabler")); return e ? { id: ne.id, name: e.name, rel: ne.relationship, removable: true } : null; }),
  ].filter(Boolean);

  // Auto-detected connections through shared people.
  const sharedConns = (() => {
    const myIds = new Set(people.map(p => p.contact.id));
    const seen = new Set(explicitConns.map(c => c.name.toLowerCase()));
    const out = [];
    contactRoles.filter(r => myIds.has(r.contact_id) && !targets.some(([t, id]) => r.entity_type === t && r.entity_id === id)).forEach(r => {
      const other = r.entity_type === "deal" ? deals.find(d => d.id === r.entity_id) : r.entity_type === "enabler" ? enablers.find(e => e.id === r.entity_id) : organizations.find(o => o.id === r.entity_id);
      if (!other) return;
      const name = r.entity_type === "deal" ? other.company : other.name;
      if (name.toLowerCase() === inst.name.toLowerCase() || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      out.push({ key: `${r.entity_type}:${r.entity_id}`, name, via: contacts.find(c => c.id === r.contact_id)?.name || "a shared contact", role: r.role_title });
    });
    return out;
  })();

  const pathsIn = inst.isTarget && inst.deal ? findNetworkPaths(inst.deal, inst.org, networkEdges, organizations, enablers, contacts, contactRoles) : [];

  return (
    <div className="deal-sheet">
      <button onClick={onBack} className="sheet-back">← {backLabel}</button>

      <div className="sheet-top">
        <div className="sheet-top-row">
          <div>
            <InlineText value={inst.name} onSave={(v) => v.trim() && onRename(v.trim())} className="sheet-company" placeholder="Institution name" />
            <div className="sheet-meta-row">
              <InlineSelectField
                value={inst.type || "hospital"}
                options={typeOpts}
                fieldName="institution_type"
                onAddCustomOption={onAddCustomOption}
                onSave={(v) => onUpdate({ type: v })}
                render={(v) => { const m = institutionTypeMeta(v, customOptions); return <span className="badge" style={{ background: m.color + "22", color: m.color, border: `1px solid ${m.color}44` }}>{m.label}</span>; }}
              />
              {inst.isInternal && <span className="badge flag-badge-internal">Internal</span>}
              {inst.isTarget && <span className="badge flag-badge-target">Target</span>}
              {inst.isEnabler && <span className="badge flag-badge-enabler">Enabler</span>}
              {inst.isTarget && onChangeTier && (
                <BadgeSelect options={DEAL_TIERS} value={inst.deal?.tier || "Untiered"} color={tier?.fg} onChange={(v) => onChangeTier(v)} title="Change tier" />
              )}
              <CityEditor city={inst.city} options={cityOpts} onAddCustomOption={onAddCustomOption} onSave={(v) => onUpdateCity(v)} />
            </div>
            {!readOnly && (
              <div className="classification-row">
                <label className={`checkbox-label ${inst.isInternal ? "checkbox-disabled" : ""}`}><input type="checkbox" checked={inst.isTarget && !inst.isInternal} disabled={inst.isInternal} onChange={(e) => { if (!e.target.checked && inst.dealId && !confirm("Unchecking Target removes the linked pipeline deal (its people and stage). Activity history is kept. Continue?")) return; onSetFlag("target", e.target.checked); }} /> Target</label>
                <label className="checkbox-label"><input type="checkbox" checked={inst.isEnabler} onChange={(e) => { if (!e.target.checked && inst.enablerId && !confirm("Unchecking Enabler removes the linked enabler record. Activity history is kept. Continue?")) return; onSetFlag("enabler", e.target.checked); }} /> Enabler</label>
                <label className="checkbox-label"><input type="checkbox" checked={inst.isInternal} onChange={(e) => { if (e.target.checked && inst.dealId && !confirm("Marking Internal removes the linked pipeline deal (an internal org is not a target). Activity history is kept. Continue?")) return; onSetFlag("internal", e.target.checked); }} /> Internal</label>
              </div>
            )}
            <div className="sheet-contact">Sector: <InlineText value={inst.sector} onSave={(v) => onUpdate({ sector: v })} placeholder="Add sector" /></div>
            <div className="sheet-contact">Website: <InlineText value={inst.website} onSave={(v) => onUpdate({ website: v })} placeholder="Add website" /></div>
            <div className="sheet-contact">Region: <InlineText value={inst.region} onSave={(v) => onUpdate({ region: v || null })} placeholder="Add region" /></div>
          </div>
          {!readOnly && (
            <div className="sheet-actions">
              <button onClick={onAutoFill} className="btn-sec" disabled={researching}>{researching ? "AI researching..." : "Auto-fill with AI"}</button>
              <button onClick={() => { if (confirm("Delete this institution and all its linked records?")) onDelete(); }} className="btn-sec btn-danger">Delete</button>
            </div>
          )}
        </div>
        {inst.isTarget && (
          <div className="sheet-next inst-stage-row">
            <span className="next-label">Pipeline stage:</span>
            <BadgeSelect options={STAGES} value={inst.stage || "prospecting"} color={stage?.color} onChange={(v) => onChangeStage(v)} dot title="Change stage" />
            {onUpdateDeal && (
              <>
                <span className="next-label">Value (USD):</span>
                <InlineText
                  value={inst.deal?.value ? String(inst.deal.value) : ""}
                  placeholder="Add value"
                  onSave={(v) => { const n = Number(v); onUpdateDeal({ value: v !== "" && !Number.isNaN(n) && n > 0 ? n : null }); }}
                />
                <span className="next-label">Next action:</span>
                <InlineText value={inst.deal?.next_action} placeholder="What happens next?" onSave={(v) => onUpdateDeal({ next_action: v || null })} />
              </>
            )}
          </div>
        )}
      </div>

      {bossNotesSlot}

      <SummaryCard entity={summaryEntity} activities={activities} onGenerateSummary={onGenerateSummary} onSaveSummary={onSaveSummary} summarizing={summarizing} />

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Description</div>
          {researching && <span className="empty-small">AI researching...</span>}
        </div>
        <NotesEditor value={inst.description} onSave={(v) => onUpdate({ description: v })} placeholder="What does this institution do? Click Auto-fill with AI to research." showToast={showToast} />
      </div>

      <div className="people-section">
        <div className="section-label">Notes</div>
        <NotesEditor value={inst.notes} onSave={(v) => onUpdate({ notes: v })} showToast={showToast} />
      </div>

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">People at {inst.name}</div>
          {!readOnly && (
            <div className="header-btn-group">
              <div className="research-btn-wrap">
                <button onClick={runResearch} className="btn-primary btn-research" disabled={researchLoading}>{researchLoading ? "Researching..." : "🔍 Research Key People"}</button>
                <div className="research-credits-note">Uses AI credits</div>
              </div>
              <button onClick={() => setAddPersonOpen(v => !v)} className="btn-copy">{addPersonOpen ? "Cancel" : "+ Add Person"}</button>
            </div>
          )}
        </div>
        {addPersonOpen && primary && (
          <InstitutionAddPerson
            institutionName={inst.name}
            availableContacts={contacts.filter(c => !people.some(p => p.contactId === c.id))}
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onAddExisting={async (contactId, role) => { await onAddPersonRole({ contactId, entityType: primary.type, entityId: primary.id, roleTitle: role }); setAddPersonOpen(false); }}
            onAddNew={async (form) => { await onAddPersonWithRoles({ ...form, company: inst.name, roles: [{ institutionKey: `${primary.type}:${primary.id}`, role: form.role }] }); setAddPersonOpen(false); }}
          />
        )}
        {people.length === 0 ? (
          <div className="empty-small">No people linked yet.</div>
        ) : (
          <div className="people-grid">
            {people.map(p => {
              const warmth = WARMTH_LEVELS.find(w => w.id === (p.contact.warmth || "unknown"));
              const others = alsoAt(p.contact.id);
              return (
                <div key={p.contactId} className="person-card" onClick={() => onOpenPerson(p.contact.id)}>
                  <div className="person-card-top">
                    <div>
                      <div className="person-name"><span className="warmth-dot" style={{background:warmth?.color}} />{p.contact.name}</div>
                      {p.role && <div className="person-role">{p.role}</div>}
                      {p.contact.email && <div className="person-company">{p.contact.email}</div>}
                    </div>
                    {!readOnly && (p.source === "role" || p.source === "edge") && (
                      <button onClick={(e) => { e.stopPropagation(); if (!confirm(`Remove ${p.contact.name}?`)) return; if (p.source === "role") onRemoveRole(p.roleRow); else onRemoveNetworkEdge(p.removeId); }} className="person-remove" title="Remove">✕</button>
                    )}
                  </div>
                  {others.length > 0 && <div className="also-at">Also: {others.map((o, i) => <span key={i}>{o.role ? `${o.role} at ` : ""}{o.name}{i < others.length - 1 ? ", " : ""}</span>)}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {researchOpen && (
        <div className="people-section research-panel">
          <div className="ai-summary-header">
            <div className="section-label">Key People Research</div>
            <div className="header-btn-group">
              {researchResults && !researchLoading && pendingCount > 0 && (
                <button onClick={addAll} className="btn-copy" disabled={addingAll}>{addingAll ? `Adding ${addAllCount} people...` : `Add All (${pendingCount})`}</button>
              )}
              <button onClick={() => setResearchOpen(false)} className="btn-sec">Done</button>
            </div>
          </div>
          {researchedAt && !researchLoading && <div className="research-meta">Last researched {formatDate(researchedAt)}</div>}

          {researchLoading ? (
            <div className="research-loading">{researchStatus || `Researching ${inst.name}...`}</div>
          ) : researchError ? (
            <div className="research-error">
              <div className="research-error-msg">Research failed: {researchError}. Try again.</div>
              <button onClick={runResearch} className="btn-primary">Retry</button>
            </div>
          ) : researchResults ? (
            <>
              {researchResults.institution_notes && <div className="detail-notes research-inst-notes">{researchResults.institution_notes}</div>}
              {[["Clinical Champions", researchResults.clinical_champions || [], "cc", true], ["Decision Makers", researchResults.decision_makers || [], "dm", false]].map(([title, list, section, showPubs]) => (
                <div key={section} className="research-group">
                  <div className="research-group-title">{title} ({list.length})</div>
                  {list.length === 0 ? (
                    <div className="empty-small">None found.</div>
                  ) : list.map((p, i) => {
                    const key = `${section}:${i}`;
                    const cm = CONFIDENCE_META[(p.confidence || "").toLowerCase()] || CONFIDENCE_META.low;
                    return (
                      <div key={key} className="research-person-card">
                        <div className="research-person-head">
                          <div className="research-person-ident">
                            <div className="research-person-name">{p.name}</div>
                            {(p.title || p.department) && <div className="research-person-title">{p.title}{p.title && p.department ? " · " : ""}{p.department}</div>}
                          </div>
                          <span className="badge" style={{ background: cm.color + "22", color: cm.color }}>{cm.label}</span>
                        </div>
                        {p.education && <div className="research-person-line"><span className="research-person-key">Education:</span> {p.education}</div>}
                        {showPubs && p.publications && <div className="research-person-line"><span className="research-person-key">Research:</span> {p.publications}</div>}
                        {p.relevance && <div className="research-person-relevance">{p.relevance}</div>}
                        <div className="research-person-actions">
                          {isAdded(key, p.name)
                            ? <span className="research-added">✓ Added</span>
                            : <button onClick={() => addOne(p, key)} className="btn-copy">Add to Ecosystem</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          ) : (
            <div className="empty-small">No research yet.</div>
          )}

          {(trialsLoading || trials) && !researchLoading && (
            <div className="research-trials">
              <div className="research-group-title">Clinical Trials at {inst.name}</div>
              {trialsLoading ? (
                <div className="empty-small">Searching clinical trials...</div>
              ) : (trials.trials || []).length === 0 ? (
                <div className="empty-small">No active oncology trials found.</div>
              ) : (
                <div className="research-trials-list">
                  {(trials.trials || []).map((t, i) => (
                    <div key={i} className="research-trial-card">
                      <div className="research-trial-name">{t.name || "Untitled trial"}</div>
                      <div className="research-trial-meta">
                        {t.nct_id && <span className="badge date-badge">{t.nct_id}</span>}
                        {t.condition && <span className="research-trial-cond">{t.condition}</span>}
                      </div>
                      {t.sponsor && <div className="research-trial-sponsor">Sponsor: {t.sponsor}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {onAddTodo && (
        <TodoSection todos={todos} contacts={contacts} deals={deals} enablers={enablers} organizations={organizations} todoContacts={todoContacts} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCreateInstitution={onCreateInstitution} initial={taskInitial} onAdd={onAddTodo} onToggle={onToggleTodo} onUpdate={onUpdateTodo} onNavigate={onNavigate} />
      )}

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Connected Institutions</div>
          {!readOnly && inst.orgId && <button onClick={() => setConnectOpen(true)} className="btn-copy">+ Add Connection</button>}
        </div>
        {explicitConns.length === 0 && sharedConns.length === 0 ? (
          <div className="empty-small">No connected institutions yet.</div>
        ) : (
          <div className="todo-list">
            {explicitConns.map(c => (
              <div key={c.id} className="path-row">
                <div className="path-chain" onClick={() => onOpenInstitution(c.name)} style={{ cursor: "pointer" }}>{c.name}</div>
                <div className="todo-meta-row">
                  <span className="badge">{NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === c.rel)?.label || c.rel}</span>
                  {!readOnly && <button onClick={() => { if (confirm("Remove this connection?")) onRemoveNetworkEdge(c.id); }} className="person-remove" title="Remove">✕</button>}
                </div>
              </div>
            ))}
            {sharedConns.map(c => (
              <div key={c.key} className="path-row" onClick={() => onOpenInstitution(c.name)} style={{ cursor: "pointer" }}>
                <div className="path-chain">Connected to {c.name} through {c.via}{c.role ? ` (${c.role})` : ""}</div>
              </div>
            ))}
          </div>
        )}
        {connectOpen && inst.orgId && (
          <AddOrgLinkModal
            title="Connect Institution"
            pickLabel="Institution"
            entityOptions={organizations.filter(o => o.id !== inst.orgId).map(o => ({ id: o.id, label: o.name }))}
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onCreateInstitution={onCreateInstitution}
            onSave={async (f) => { await onAddConnection({ aType: "organization", aId: inst.orgId, bType: "organization", bId: f.entityId, relationship: f.relationship, strength: f.strength, notes: f.notes }); setConnectOpen(false); }}
            onClose={() => setConnectOpen(false)}
          />
        )}
      </div>

      {inst.isTarget && (
        <div className="people-section">
          <div className="section-label">Paths In</div>
          {pathsIn.length === 0 ? (
            <div className="empty-small">No indirect paths found. Add people and connections to surface how you can reach this target.</div>
          ) : (
            <div className="todo-list">
              {pathsIn.slice(0, 5).map(p => (
                <div key={p.id} className="path-row">
                  <div className="path-chain">You {p.chain.map((name, i) => <span key={i}>{"> "}{name}{p.via[i] ? ` (${p.via[i]})` : ""}{i < p.chain.length - 1 ? " " : ""}</span>)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <MaterialsSection materials={materials} links={materialLinks} onAttach={onAttachMaterial} onRemoveLink={onRemoveMaterialLink} onDownload={onDownloadMaterial} />

      <LinkedNotesSection notes={linkedNotes} onOpenNote={onOpenNote} />

      <QuickAdd dealId={inst.dealId} enablerId={inst.enablerId} organizationId={inst.orgId} contactId={null} linkPeople={people.map((p) => p.contact)} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onAddActivity={onAddActivity} onCreateTasks={onAddTodo ? (tasks) => Promise.all(tasks.map((t) => onAddTodo(t))) : undefined} showToast={showToast} />

      <div className="timeline">
        <div className="section-label">Activity Timeline</div>
        <div className="timeline-scope-summary">{cumulativeActivities.length} interaction{cumulativeActivities.length === 1 ? "" : "s"} across {cumulativePeopleCount} people</div>
        <div className="timeline-scope-toggle">
          <button type="button" onClick={() => setTimelineScope("all")} className={`tag-btn ${timelineScope === "all" ? "active" : ""}`}>All activity</button>
          <button type="button" onClick={() => setTimelineScope("direct")} className={`tag-btn ${timelineScope === "direct" ? "active" : ""}`}>Direct only</button>
        </div>
        <div className="timeline-tabs">
          {TIMELINE_TABS.map(tb => <button key={tb.id} onClick={() => setFilter(tb.id)} className={`tag-btn ${filter === tb.id ? "active" : ""}`}>{tb.label}</button>)}
        </div>
        <TimelineAddEntry
          initial={{ deal_id: inst.dealId || null, enabler_id: inst.enablerId || null, organization_id: inst.orgId || null, contact_id: null }}
          linkOptions={activityLinkOptions}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onSave={onAddTimelineEntry}
        />
        <div className="timeline-list">
          {filtered.length === 0 && <div className="empty-small">No activities yet</div>}
          {filtered.map(a => (
            <ActivityRow
              key={a.id}
              activity={a}
              deals={deals} enablers={enablers} organizations={organizations} contacts={contacts}
              onOpenInstitution={onOpenInstitution} onOpenPerson={onOpenPerson} onOpenCalendarEvent={onOpenCalendarEvent}
              onSummarizeEmail={onSummarizeEmail} summarizingId={summarizingActivityId}
              onUpdateActivity={onUpdateActivity} onDeleteActivity={onDeleteActivity}
              linkOptions={activityLinkOptions} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
              hideInstitution
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Inline "+ Add Person" on the Institution Sheet: pick an existing contact, or
// (below the divider) create a brand new one, either way linking them here.
function InstitutionAddPerson({ institutionName, availableContacts, customOptions, onAddCustomOption, onAddExisting, onAddNew }) {
  const [contactId, setContactId] = useState("");
  const [existingRole, setExistingRole] = useState("");
  const [f, setF] = useState({ name: "", role: "", email: "", phone: "", linkedin: "", warmth: "unknown" });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const warmthOpts = optionsWithCustom(WARMTH_LEVELS, customOptions, "warmth");
  return (
    <div className="quickadd-inline-form">
      {availableContacts.length > 0 && (
        <>
          <div className="quickadd-inline-row">
            <select className="input" value={contactId} onChange={e => setContactId(e.target.value)}>
              <option value="">Search existing people...</option>
              {availableContacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="input" placeholder={`Role at ${institutionName}`} value={existingRole} onChange={e => setExistingRole(e.target.value)} />
            <button onClick={() => contactId && onAddExisting(contactId, existingRole)} className="btn-primary" disabled={!contactId}>Add</button>
          </div>
          <div className="form-divider">or add someone new</div>
        </>
      )}
      <div className="form-grid">
        <div className="field"><label className="label">Name *</label><input className="input" value={f.name} onChange={e => set("name", e.target.value)} /></div>
        <div className="field"><label className="label">Role at {institutionName}</label><input className="input" value={f.role} onChange={e => set("role", e.target.value)} /></div>
        <div className="field"><label className="label">Email</label><input className="input" type="email" value={f.email} onChange={e => set("email", e.target.value)} /></div>
        <div className="field"><label className="label">Phone</label><input className="input" value={f.phone} onChange={e => set("phone", e.target.value)} /></div>
        <div className="field-full"><label className="label">LinkedIn</label><input className="input" value={f.linkedin} onChange={e => set("linkedin", e.target.value)} placeholder="linkedin.com/in/..." /></div>
        <div className="field-full"><label className="label">Warmth</label><ButtonGroupWithCustom options={warmthOpts} value={f.warmth} onChange={(v) => { set("warmth", v); trackCustom("warmth", warmthOpts, onAddCustomOption)(v); }} renderOption={(w) => <><span className="warmth-dot" style={{background:w.color}} />{w.label}</>} /></div>
      </div>
      <div className="modal-actions">
        <button onClick={() => f.name.trim() && onAddNew(f)} className="btn-primary" disabled={!f.name.trim()}>Add New Person</button>
      </div>
    </div>
  );
}

function InstitutionForm({ customOptions = [], onAddCustomOption = () => {}, onSave, onCancel }) {
  const [f, setF] = useState({ name: "", type: "hospital", city: "", region: "", isTarget: false, isEnabler: false, isInternal: false, sector: "", description: "", website: "" });
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const typeOpts = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");
  const cityOpts = optionsWithCustom(CITY_OPTIONS, customOptions, "city");
  const regionOpts = optionsWithCustom(REGION_OPTIONS, customOptions, "region");
  const submit = async () => {
    if (!f.name.trim() || saving) return;
    setSaving(true);
    try { await onSave(f); } finally { setSaving(false); }
  };
  return (
    <div className="quickadd-inline-form">
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. NUPCO" /></div>
        <div className="field"><label className="label">Type</label><SelectWithCustom options={typeOpts} value={f.type} onChange={(v) => { set("type", v); trackCustom("institution_type", typeOpts, onAddCustomOption)(v); }} /></div>
        <div className="field"><label className="label">City</label><SelectWithCustom options={cityOpts} value={f.city} onChange={(v) => { set("city", v); trackCustom("city", cityOpts, onAddCustomOption)(v); }} placeholder="City name..." /></div>
        <div className="field"><label className="label">Region</label><SelectWithCustom options={regionOpts} value={f.region} onChange={(v) => { set("region", v); trackCustom("region", regionOpts, onAddCustomOption)(v); }} placeholder="Region name..." /></div>
        <div className="field-full checkbox-row">
          <label className={`checkbox-label ${f.isInternal ? "checkbox-disabled" : ""}`}><input type="checkbox" checked={f.isTarget && !f.isInternal} disabled={f.isInternal} onChange={e => set("isTarget", e.target.checked)} /> Target (a sales/BD target)</label>
          <label className="checkbox-label"><input type="checkbox" checked={f.isEnabler} onChange={e => set("isEnabler", e.target.checked)} /> Enabler (can help us reach targets)</label>
          <label className="checkbox-label"><input type="checkbox" checked={f.isInternal} onChange={e => set("isInternal", e.target.checked)} /> Internal (our own team)</label>
        </div>
      </div>
      <button type="button" onClick={() => setShowMore(s => !s)} className="link-btn">{showMore ? "Hide details" : "More details"}</button>
      {showMore && (
        <div className="form-grid">
          <div className="field"><label className="label">Sector</label><input className="input" value={f.sector} onChange={e => set("sector", e.target.value)} placeholder="e.g. Oncology" /></div>
          <div className="field"><label className="label">Website</label><input className="input" value={f.website} onChange={e => set("website", e.target.value)} placeholder="https://..." /></div>
          <div className="field-full"><label className="label">Description</label><textarea className="input textarea" value={f.description} onChange={e => set("description", e.target.value)} /></div>
        </div>
      )}
      <div className="modal-actions">
        <button onClick={onCancel} className="btn-sec">Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!f.name.trim() || saving}>Save</button>
      </div>
    </div>
  );
}

function PersonForm({ institutions, contacts, customOptions = [], onAddCustomOption = () => {}, onCreateInstitution, onSave, onCancel }) {
  const instOptions = institutionPickerOptions(institutions, customOptions);
  const warmthOpts = optionsWithCustom(WARMTH_LEVELS, customOptions, "warmth");
  const relOpts = optionsWithCustom(CONNECTION_RELATIONSHIPS, customOptions, "relationship");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [warmth, setWarmth] = useState("unknown");
  const [notes, setNotes] = useState("");
  const [roles, setRoles] = useState([{ institutionKey: "", role: "", primary: true }]);
  const [showConn, setShowConn] = useState(false);
  const [introducedBy, setIntroducedBy] = useState("");
  const [introNotes, setIntroNotes] = useState("");
  const [canReach, setCanReach] = useState("");
  const [relationship, setRelationship] = useState("can_introduce");
  const [saving, setSaving] = useState(false);

  const updateRole = (i, patch) => setRoles(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRole = () => setRoles(prev => [...prev, { institutionKey: "", role: "", primary: false }]);
  const removeRole = (i) => setRoles(prev => prev.filter((_, idx) => idx !== i));
  const setPrimary = (i) => setRoles(prev => prev.map((r, idx) => ({ ...r, primary: idx === i })));

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const ordered = [...roles].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
      const payload = ordered.map(r => ({ institutionKey: r.institutionKey, role: r.role }));
      await onSave({ name, email, phone, linkedin, warmth, notes, roles: payload, introducedBy: introducedBy || null, introNotes: introNotes || null, canReach: canReach || null, relationship });
    } finally { setSaving(false); }
  };

  return (
    <div className="quickadd-inline-form">
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={name} onChange={e => setName(e.target.value)} /></div>
      </div>

      <label className="label">Roles</label>
      {roles.map((r, i) => (
        <div key={i} className="quickadd-inline-row">
          <InstitutionSelect
            options={instOptions} value={r.institutionKey} onChange={(v) => updateRole(i, { institutionKey: v })} optKey="key"
            onCreateInstitution={onCreateInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
          />
          <input className="input" placeholder="Role title" value={r.role} onChange={e => updateRole(i, { role: e.target.value })} />
          <label className="checkbox-label primary-check"><input type="checkbox" checked={r.primary} onChange={() => setPrimary(i)} /> Primary</label>
          {roles.length > 1 && <button onClick={() => removeRole(i)} className="person-remove" title="Remove role">✕</button>}
        </div>
      ))}
      <button type="button" onClick={addRole} className="link-btn">+ Add another role</button>

      <div className="conn-toggle-wrap">
        <button type="button" onClick={() => setShowConn(s => !s)} className="link-btn">{showConn ? "Hide" : "How are they connected to us?"}</button>
      </div>
      {showConn && (
        <div className="form-grid">
          <div className="field"><label className="label">Introduced by / reachable through</label>
            <select className="input" value={introducedBy} onChange={e => setIntroducedBy(e.target.value)}>
              <option value="">No one specific</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {introducedBy && (
            <div className="field"><label className="label">Introduction notes</label>
              <input className="input" value={introNotes} onChange={e => setIntroNotes(e.target.value)} placeholder="e.g. offered at the July 15 meeting" />
            </div>
          )}
          <div className="field"><label className="label">Can help us reach (institution)</label>
            <InstitutionSelect
              options={instOptions} value={canReach} onChange={setCanReach} optKey="key" placeholder="Nothing specific"
              onCreateInstitution={onCreateInstitution} customOptions={customOptions} onAddCustomOption={onAddCustomOption}
            />
          </div>
          {canReach && (
            <div className="field-full"><label className="label">Relationship to that institution</label><SelectWithCustom options={relOpts} value={relationship} onChange={(v) => { setRelationship(v); trackCustom("relationship", relOpts, onAddCustomOption)(v); }} /></div>
          )}
        </div>
      )}

      <div className="form-grid">
        <div className="field"><label className="label">Email</label><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label className="label">Phone</label><input className="input" value={phone} onChange={e => setPhone(e.target.value)} /></div>
        <div className="field"><label className="label">LinkedIn URL</label><input className="input" value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="linkedin.com/in/..." /></div>
        <div className="field-full"><label className="label">Warmth</label><ButtonGroupWithCustom options={warmthOpts} value={warmth} onChange={(v) => { setWarmth(v); trackCustom("warmth", warmthOpts, onAddCustomOption)(v); }} renderOption={(w) => <><span className="warmth-dot" style={{background:w.color}} />{w.label}</>} /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={notes} onChange={e => setNotes(e.target.value)} /></div>
      </div>

      <div className="modal-actions">
        <button onClick={onCancel} className="btn-sec">Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!name.trim() || saving}>Add Person</button>
      </div>
    </div>
  );
}

const NETWORK_SUBTABS = [{ id: "institutions", label: "Institutions" }, { id: "people", label: "People" }];

// The unified Ecosystem tab: institutions grouped by type (Institutions sub-tab)
// and everyone in the ecosystem (People sub-tab). Institutions are the derived
// name-keyed union of deals/enablers/organizations; people are contacts.
function NetworkTab({
  institutions, contacts, deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles,
  customOptions, onAddCustomOption, onAddInstitution, onCreateInstitution, onAddPersonWithRoles, onUpdateInstitution, onUpdateInstitutionCity, onUpdateContact, onUpdateRoleTitle, onSetOutreach, onLinkPersonToInstitution, onOpenInstitution, onOpenPerson, onOpenSearch,
}) {
  const [subtab, setSubtab] = useState("institutions");
  const [typeFilter, setTypeFilter] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [targetsOnly, setTargetsOnly] = useState(false);
  const [enablersOnly, setEnablersOnly] = useState(false);
  const [internalOnly, setInternalOnly] = useState(false);
  const [warmthFilter, setWarmthFilter] = useState("");
  const [instFilter, setInstFilter] = useState("");
  const [activeForm, setActiveForm] = useState(null);
  const [peopleView, setPeopleView] = useState("table");
  const [fabOpen, setFabOpen] = useState(false);
  const readOnly = useReadOnly();
  const isMobile = useIsMobile();
  // On mobile the editable table is unusable, so People always renders as cards.
  const effectivePeopleView = isMobile ? "cards" : peopleView;

  const cities = Array.from(new Set(institutions.flatMap(i => parseCities(i.city)))).sort();
  const types = Array.from(new Set(institutions.map(i => i.type).filter(Boolean)));
  const orderedTypes = [
    ...INSTITUTION_TYPES.map(t => t.id).filter(id => types.includes(id)),
    ...types.filter(id => !INSTITUTION_TYPES.some(t => t.id === id)).sort(),
  ];

  const filteredInst = institutions.filter(i =>
    (!typeFilter || i.type === typeFilter) &&
    (!cityFilter || parseCities(i.city).includes(cityFilter)) &&
    (!targetsOnly || i.isTarget) &&
    (!enablersOnly || i.isEnabler) &&
    (!internalOnly || i.isInternal));

  // People sub-tab data: every contact with their resolved roles.
  const peopleData = contacts.map(c => {
    const roles = resolveContactRoles(c, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
    const roleStr = roles.map(r => `${r.role_title ? `${r.role_title} at ` : ""}${r.institutionName}`).join(", ");
    const connCount = roles.length + networkEdges.filter(ne => (ne.source_type === "contact" && ne.source_id === c.id) || (ne.target_type === "contact" && ne.target_id === c.id)).length;
    const personCities = Array.from(new Set(roles.flatMap(r => parseCities(r.institution.city))));
    return { contact: c, roles, roleStr, connCount, cities: personCities };
  });
  const filteredPeople = peopleData.filter(p =>
    (!warmthFilter || (p.contact.warmth || "unknown") === warmthFilter) &&
    (!cityFilter || p.cities.includes(cityFilter)) &&
    (!instFilter || p.roles.some(r => r.institutionName === instFilter)));
  const instNames = Array.from(new Set(institutions.map(i => i.name))).sort();
  const typeOptsAll = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");
  const cityOptsAll = optionsWithCustom(CITY_OPTIONS, customOptions, "city");

  return (
    <div className="network-directory">
      <div className="network-top-bar">
        <button type="button" className="input network-search network-search-btn" onClick={onOpenSearch}>Search people and institutions...</button>
        <div className="network-top-buttons">
          {!readOnly && <button onClick={() => setActiveForm(a => (a === "institution" ? null : "institution"))} className={`btn-primary ${activeForm === "institution" ? "active-toggle" : ""}`}>+ Institution</button>}
          {!readOnly && <button onClick={() => setActiveForm(a => (a === "person" ? null : "person"))} className={`btn-primary ${activeForm === "person" ? "active-toggle" : ""}`}>+ Person</button>}
        </div>
      </div>

      {!readOnly && (
        <div className={`mobile-add-fab ${fabOpen ? "open" : ""}`}>
          {fabOpen && (
            <div className="mobile-add-fab-options">
              <button onClick={() => { setActiveForm("institution"); setFabOpen(false); }} className="mobile-add-fab-opt">+ Institution</button>
              <button onClick={() => { setActiveForm("person"); setFabOpen(false); }} className="mobile-add-fab-opt">+ Person</button>
            </div>
          )}
          <button onClick={() => setFabOpen((o) => !o)} className="mobile-add-fab-btn" aria-label={fabOpen ? "Close" : "Add"}>{fabOpen ? "✕" : "+"}</button>
        </div>
      )}

      {activeForm === "institution" && (
        <InstitutionForm customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCancel={() => setActiveForm(null)} onSave={async (f) => { await onAddInstitution(f); setActiveForm(null); }} />
      )}
      {activeForm === "person" && (
        <PersonForm institutions={institutions} contacts={contacts} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCreateInstitution={onCreateInstitution} onCancel={() => setActiveForm(null)} onSave={async (f) => { await onAddPersonWithRoles(f); setActiveForm(null); }} />
      )}

      <div className="network-subtabs">
        {NETWORK_SUBTABS.map(t => <button key={t.id} onClick={() => setSubtab(t.id)} className={`subtab ${subtab === t.id ? "active" : ""}`}>{t.label}</button>)}
      </div>

      {subtab === "institutions" ? (
        <>
          <div className="network-filter-row">
            <SelectWithCustom className="input select-filter" options={[{ id: "", label: "All Types" }, ...INSTITUTION_TYPES.filter(t => types.includes(t.id)), ...types.filter(id => !INSTITUTION_TYPES.some(t => t.id === id)).map(id => ({ id, label: institutionTypeMeta(id, customOptions).label }))]} value={typeFilter} onChange={setTypeFilter} />
            <SelectWithCustom className="input select-filter" options={[{ id: "", label: "All Cities" }, ...toOptions(Array.from(new Set([...SAUDI_CITIES, ...cities])).sort())]} value={cityFilter} onChange={setCityFilter} />
            <label className="checkbox-label toggle-filter"><input type="checkbox" checked={targetsOnly} onChange={e => setTargetsOnly(e.target.checked)} /> Targets only</label>
            <label className="checkbox-label toggle-filter"><input type="checkbox" checked={enablersOnly} onChange={e => setEnablersOnly(e.target.checked)} /> Enablers only</label>
            <label className="checkbox-label toggle-filter"><input type="checkbox" checked={internalOnly} onChange={e => setInternalOnly(e.target.checked)} /> Internal only</label>
          </div>
          {filteredInst.length === 0 ? (
            <div className="empty-state">No institutions match.</div>
          ) : (
            // Internal Team group renders first (purple), then the type groups
            // with internal institutions excluded so the team appears once.
            [
              ...(() => { const items = filteredInst.filter(i => i.isInternal); return items.length ? [{ key: "__internal", header: `INTERNAL TEAM (${items.length})`, items, internal: true }] : []; })(),
              ...orderedTypes.map(typeId => {
                const items = filteredInst.filter(i => i.type === typeId && !i.isInternal);
                if (items.length === 0) return null;
                const meta = institutionTypeMeta(typeId, customOptions);
                const plural = INSTITUTION_TYPE_PLURALS[typeId] || (meta.label.endsWith("s") ? meta.label : `${meta.label}s`);
                return { key: typeId || "other", header: `${plural.toUpperCase()} (${items.length})`, items, internal: false };
              }).filter(Boolean),
            ].map(grp => (
              <div key={grp.key} className={`institution-group ${grp.internal ? "institution-group-internal" : ""}`}>
                <div className="institution-group-header">{grp.header}</div>
                <div className="institution-grid">
                  {grp.items.map(inst => {
                    const ppl = institutionPeople(inst, { contactRoles, dealContacts, enablerContacts, networkEdges, contacts });
                    const preview = ppl.slice(0, 3);
                    const stage = inst.isTarget ? STAGES.find(s => s.id === inst.stage) : null;
                    return (
                      <div key={inst.key} className={`institution-card ${inst.isInternal ? "institution-card-internal" : ""}`} onClick={() => onOpenInstitution(inst.name)}>
                        <div className="institution-card-top">
                          <div className="institution-name">{inst.name}</div>
                          <InlineSelectField
                            value={inst.type || "hospital"}
                            options={typeOptsAll}
                            fieldName="institution_type"
                            onAddCustomOption={onAddCustomOption}
                            onSave={(v) => onUpdateInstitution(inst, { type: v })}
                            render={(v) => { const m = institutionTypeMeta(v, customOptions); return <span className="badge" style={{ background: m.color + "22", color: m.color, border: `1px solid ${m.color}44` }}>{m.label}</span>; }}
                          />
                        </div>
                        <div className="institution-flags-row">
                          {inst.isInternal && <span className="badge flag-badge-internal">Internal</span>}
                          {inst.isTarget && <span className="badge flag-badge-target">Target</span>}
                          {inst.isEnabler && <span className="badge flag-badge-enabler">Enabler</span>}
                          <InlineCity city={inst.city} options={cityOptsAll} onAddCustomOption={onAddCustomOption} onSave={(v) => onUpdateInstitutionCity(inst, v)} compact />
                          {stage && <span className="badge" style={{background:stage.color+"22",color:stage.color,border:`1px solid ${stage.color}44`}}>{stage.label}</span>}
                        </div>
                        <div className="institution-people-count">{ppl.length} {ppl.length === 1 ? "person" : "people"}</div>
                        {preview.length > 0 && (
                          <div className="institution-people-preview">
                            {preview.map((p, i) => (
                              <div key={i} className="institution-preview-person">
                                <Avatar name={p.contact.name} size={28} />
                                <div className="preview-person-text">
                                  <div className="preview-person-name">{p.contact.name}</div>
                                  {p.role && <div className="preview-person-role">{p.role}</div>}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {inst.lastActivity && <div className="institution-last-activity">{daysAgo(inst.lastActivity)}d ago</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </>
      ) : (
        <>
          {isMobile && <div className="mobile-people-note">Switch to desktop for table editing.</div>}
          <div className="network-filter-row">
            <div className="view-toggle desktop-only-flex">
              <button className={`view-toggle-btn ${peopleView === "cards" ? "active" : ""}`} onClick={() => setPeopleView("cards")}>Cards</button>
              <button className={`view-toggle-btn ${peopleView === "table" ? "active" : ""}`} onClick={() => setPeopleView("table")}>Table</button>
            </div>
            <SelectWithCustom className="input select-filter" options={[{ id: "", label: "All Warmth" }, ...WARMTH_LEVELS]} value={warmthFilter} onChange={setWarmthFilter} />
            <SelectWithCustom className="input select-filter" options={[{ id: "", label: "All Cities" }, ...toOptions(Array.from(new Set([...SAUDI_CITIES, ...cities])).sort())]} value={cityFilter} onChange={setCityFilter} />
            <select className="input select-filter" value={instFilter} onChange={e => setInstFilter(e.target.value)}>
              <option value="">All Institutions</option>
              {instNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {filteredPeople.length === 0 ? (
            <div className="empty-state">No people match.</div>
          ) : effectivePeopleView === "table" ? (
            <PeopleTable
              people={filteredPeople}
              institutionNames={instNames}
              cities={cities}
              customOptions={customOptions}
              onAddCustomOption={onAddCustomOption}
              onUpdateContact={onUpdateContact}
              onUpdateRoleTitle={onUpdateRoleTitle}
              onSetOutreach={onSetOutreach}
              onLinkPersonToInstitution={onLinkPersonToInstitution}
              onOpenPerson={onOpenPerson}
            />
          ) : (
            <div className="institution-grid">
              {filteredPeople.map(({ contact, roleStr, connCount }) => {
                const warmth = WARMTH_LEVELS.find(w => w.id === (contact.warmth || "unknown"));
                return (
                  <div key={contact.id} className="institution-card" onClick={() => onOpenPerson(contact.id)}>
                    <div className="institution-card-top" style={{ alignItems: "center", gap: 11 }}>
                      <Avatar name={contact.name} size={34} />
                      <div className="institution-name" style={{ flex: 1 }}>{contact.name}</div>
                      {contact.is_internal && <span className="badge internal-badge">Internal</span>}
                      <span className="warmth-dot" style={{background:warmth?.color, marginRight: 0}} title={warmth?.label} />
                    </div>
                    {roleStr && <div className="person-net-roles">{roleStr}</div>}
                    {(contact.email || contact.phone) && <div className="person-net-contact">{contact.email}{contact.email && contact.phone ? " . " : ""}{contact.phone}</div>}
                    <div className="institution-last-activity">{connCount} connection{connCount === 1 ? "" : "s"}{contact.last_contacted_at ? ` . ${daysAgo(contact.last_contacted_at)}d ago` : ""}</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A flat editable table cell. Enter or Tab commits and moves focus down the
// same column (onNext), so a whole column can be filled in rapidly. Escape reverts.
function TableTextCell({ value, onSave, placeholder, colKey, rowIndex, cellRefs, onNext }) {
  const readOnly = useReadOnly();
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  const commit = () => { if ((v || "") !== (value || "")) onSave(v); };
  if (readOnly) return <span className="table-cell-ro">{value || ""}</span>;
  return (
    <input
      ref={(el) => { cellRefs.current[`${rowIndex}:${colKey}`] = el; }}
      className="table-cell-input"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); commit(); onNext(); }
        else if (e.key === "Escape") { setV(value || ""); e.currentTarget.blur(); }
      }}
    />
  );
}

// Editable, sortable table of people for rapid data entry (LinkedIn especially).
function PeopleTable({ people, institutionNames, cities, onUpdateContact, onUpdateRoleTitle, onSetOutreach, onLinkPersonToInstitution, onOpenPerson }) {
  const readOnly = useReadOnly();
  const [sort, setSort] = useState({ col: "institution", dir: "asc" });
  const cellRefs = useRef({});
  const cityList = Array.from(new Set([...SAUDI_CITIES, ...cities])).sort();
  const cols = [["name", "Name"], ["role", "Role"], ["institution", "Institution"], ["city", "City"], ["email", "Email"], ["phone", "Phone"], ["linkedin", "LinkedIn"], ["warmth", "Warmth"], ["outreach", "Outreach"], ["last", "Last Contacted"]];

  const rows = people.map((p) => {
    const primary = p.roles.find((r) => r.is_primary) || p.roles[0];
    // Source of truth for the Role cell is the primary real contact_roles entry
    // (removable). Only fall back to contacts.role when there is none (audit M7).
    const primaryRole = p.roles.find((r) => r.removable && r.is_primary) || p.roles.find((r) => r.removable) || null;
    const roleTitle = primaryRole ? (primaryRole.role_title || "") : (p.contact.role || (primary ? primary.role_title : "") || "");
    return { contact: p.contact, institution: primary ? primary.institutionName : "", roleTitle, primaryRole, extraRoles: Math.max(0, p.roles.length - 1) };
  });
  const val = (r, col) => {
    if (col === "name") return r.contact.name || "";
    if (col === "role") return r.roleTitle || "";
    if (col === "institution") return r.institution || "";
    if (col === "city") return r.contact.city || "";
    if (col === "email") return r.contact.email || "";
    if (col === "phone") return r.contact.phone || "";
    if (col === "warmth") return r.contact.warmth || "";
    if (col === "outreach") return r.contact.outreach_status || "not_contacted";
    if (col === "last") return r.contact.last_contacted_at || "";
    return "";
  };
  const sorted = [...rows].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    if (sort.col === "institution") {
      const c = (a.institution || "").localeCompare(b.institution || "");
      return (c || (a.contact.name || "").localeCompare(b.contact.name || "")) * dir;
    }
    return String(val(a, sort.col)).localeCompare(String(val(b, sort.col))) * dir;
  });
  const toggleSort = (col) => setSort((s) => (s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" }));
  const focusCell = (col, idx) => { const el = cellRefs.current[`${idx}:${col}`]; if (el) el.focus(); };
  const selKey = (e, col, idx) => { if ((e.key === "Tab" && !e.shiftKey) || e.key === "Enter") { e.preventDefault(); focusCell(col, idx + 1); } };
  const text = (contact, col, idx, placeholder) => (
    <TableTextCell colKey={col} rowIndex={idx} cellRefs={cellRefs} placeholder={placeholder}
      value={contact[col] || ""} onSave={(v) => onUpdateContact(contact.id, { [col]: v })} onNext={() => focusCell(col, idx + 1)} />
  );

  return (
    <div className="people-table-wrap">
      <table className="people-table">
        <thead>
          <tr>
            {cols.map(([c, l]) => <th key={c} onClick={() => toggleSort(c)} className={sort.col === c ? "sorted" : ""}>{l}{sort.col === c ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, idx) => {
            const c = r.contact;
            const warmth = WARMTH_LEVELS.find((w) => w.id === (c.warmth || "unknown"));
            return (
              <tr key={c.id}>
                <td className="table-name-cell">{text(c, "name", idx, "Name")}{c.is_internal && <span className="badge internal-badge table-internal-badge">Internal</span>}</td>
                <td className="table-role-cell"><TableTextCell colKey="role" rowIndex={idx} cellRefs={cellRefs} placeholder="Role" value={r.roleTitle} onSave={(v) => onUpdateRoleTitle(r.contact, r.primaryRole, v)} onNext={() => focusCell("role", idx + 1)} />{r.extraRoles > 0 && <span className="table-more-roles" title="Has more roles">+{r.extraRoles}</span>}</td>
                <td>
                  {readOnly ? <span className="table-cell-ro">{r.institution}</span> : (
                    <select className="table-cell-select" value={r.institution} ref={(el) => { cellRefs.current[`${idx}:institution`] = el; }}
                      onChange={(e) => e.target.value && onLinkPersonToInstitution(c.id, e.target.value)} onKeyDown={(e) => selKey(e, "institution", idx)}>
                      <option value="">Set institution...</option>
                      {institutionNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  )}
                </td>
                <td>
                  {readOnly ? <span className="table-cell-ro">{c.city || ""}</span> : (
                    <select className="table-cell-select" value={c.city || ""} ref={(el) => { cellRefs.current[`${idx}:city`] = el; }}
                      onChange={(e) => onUpdateContact(c.id, { city: e.target.value || null })} onKeyDown={(e) => selKey(e, "city", idx)}>
                      <option value="">City...</option>
                      {cityList.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  )}
                </td>
                <td>{text(c, "email", idx, "Add email")}</td>
                <td>{text(c, "phone", idx, "Add phone")}</td>
                <td className="table-linkedin">{text(c, "linkedin", idx, "Add LinkedIn")}</td>
                <td>
                  {readOnly ? <span className="badge" style={{ background: warmth?.color + "22", color: warmth?.color }}>{warmth?.label}</span> : (
                    <select className="table-cell-select table-warmth" value={c.warmth || "unknown"} ref={(el) => { cellRefs.current[`${idx}:warmth`] = el; }}
                      onChange={(e) => onUpdateContact(c.id, { warmth: e.target.value })} onKeyDown={(e) => selKey(e, "warmth", idx)} style={{ color: warmth?.color, fontWeight: 700 }}>
                      {WARMTH_LEVELS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                    </select>
                  )}
                </td>
                <td>
                  {(() => {
                    const om = outreachStatusMeta(c.outreach_status);
                    return readOnly || !onSetOutreach ? (
                      <span className="badge" style={{ background: om.color + "22", color: om.color, border: `1px solid ${om.color}44` }}>{om.label}</span>
                    ) : (
                      <select className="table-cell-select" value={c.outreach_status || "not_contacted"} ref={(el) => { cellRefs.current[`${idx}:outreach`] = el; }}
                        onChange={(e) => onSetOutreach(c.id, e.target.value)} onKeyDown={(e) => selKey(e, "outreach", idx)} style={{ color: om.color, fontWeight: 700 }}>
                        {OUTREACH_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select>
                    );
                  })()}
                </td>
                <td className="table-last">{c.last_contacted_at ? formatDate(c.last_contacted_at) : "Never"}</td>
                <td><button className="table-open-btn" onClick={() => onOpenPerson(c.id)} title="Open profile">↗</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}



// ============================================================
// Global search (Cmd+K): client-side search over every loaded entity type,
// grouped by kind, each result navigating straight to its home.
// ============================================================
function GlobalSearch({ institutions, contacts, deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles, customOptions = [], activities, todos, notes, materials, entityName, onOpenInstitution, onOpenPerson, onOpenEntity, onOpenTasks, onOpenNote, onOpenMaterials, onClose }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const query = q.trim().toLowerCase();
  const hit = (s) => (s || "").toLowerCase().includes(query);
  const CAP = 5;
  const roleCtx = { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles };
  // A person's institution can live on the raw company text field, or only in
  // contact_roles (added via a role picker rather than typed on the contact),
  // so resolve their primary role's institution name too before matching.
  const personInstitutionName = (c) => {
    const roles = resolveContactRoles(c, roleCtx);
    const primary = roles.find((r) => r.is_primary) || roles[0];
    return primary?.institutionName || "";
  };
  const groups = query.length < 2 ? [] : [
    {
      label: "Institutions",
      items: institutions.filter((i) => hit(i.name) || hit(i.type) || hit(institutionTypeMeta(i.type, customOptions).label) || parseCities(i.city).some(hit)).slice(0, CAP).map((i) => ({
        key: `inst-${i.key}`, title: i.name,
        sub: [i.isTarget ? "Target" : null, i.isEnabler ? "Enabler" : null, parseCities(i.city)[0] || null].filter(Boolean).join(" . "),
        go: () => onOpenInstitution(i.name),
      })),
    },
    {
      label: "People",
      items: contacts.filter((c) => hit(c.name) || hit(c.company) || hit(c.role) || hit(c.email) || hit(personInstitutionName(c))).slice(0, CAP).map((c) => ({
        key: `c-${c.id}`, title: c.name, sub: [c.role, c.company || personInstitutionName(c)].filter(Boolean).join(", "),
        go: () => onOpenPerson(c.id),
      })),
    },
    {
      label: "Activities",
      items: activities.filter((a) => hit(cleanActivityText(a.description))).slice(0, CAP).map((a) => ({
        key: `a-${a.id}`, title: firstLine(cleanActivityText(a.description)),
        sub: [entityName(a) || "General", formatDate(a.created_at)].join(" . "),
        go: () => onOpenEntity(a),
      })),
    },
    {
      label: "Tasks",
      items: todos.filter((t) => hit(t.title)).slice(0, CAP).map((t) => ({
        key: `t-${t.id}`, title: t.title,
        sub: [t.status === "completed" ? "Completed" : "Open", entityName(t)].filter(Boolean).join(" . "),
        go: () => (entityName(t) ? onOpenEntity(t) : onOpenTasks()),
      })),
    },
    {
      label: "Notes",
      items: notes.filter((n) => hit(n.title) || hit(n.content)).slice(0, CAP).map((n) => ({
        key: `n-${n.id}`, title: n.title || "Untitled",
        sub: formatDate(n.updated_at || n.created_at),
        go: () => onOpenNote(n.id),
      })),
    },
    {
      label: "Materials",
      items: materials.filter((m) => hit(m.name) || hit(m.notes)).slice(0, CAP).map((m) => ({
        key: `m-${m.id}`, title: m.name,
        sub: [materialTypeMeta(m.type).label, m.version].filter(Boolean).join(" . "),
        go: () => onOpenMaterials(),
      })),
    },
  ].filter((g) => g.items.length > 0);
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  const first = groups[0] && groups[0].items[0];

  return (
    <div className="overlay search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="input search-input"
          placeholder="Search institutions, people, activities, tasks, notes, materials..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && first) first.go(); }}
        />
        <div className="search-results">
          {query.length < 2 ? (
            <div className="search-hint">Type at least 2 characters. Enter opens the top result, Esc closes.</div>
          ) : total === 0 ? (
            <div className="search-hint">No matches for "{q.trim()}".</div>
          ) : groups.map((g) => (
            <div key={g.label} className="search-group">
              <div className="search-group-head">{g.label}</div>
              {g.items.map((it) => (
                <button key={it.key} className="search-result" onClick={it.go}>
                  <span className="search-result-title">{it.title}</span>
                  {it.sub && <span className="search-result-sub">{it.sub}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Two-way comment thread between Fahed and Andy. A floating button (bottom right)
// opens a slide-up panel from any tab, in both the normal app and Boss View.
// ============================================================
function CommentPanel({ comments, author, unread = 0, onOpen, onPost, targetName, showToast }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [file, setFile] = useState(null); // { file_name, file_data }
  const fileRef = useRef(null);
  const sorted = [...comments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const toggle = () => { const next = !open; setOpen(next); if (next && onOpen) onOpen(); };
  const pickFile = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { if (showToast) showToast("File too large. Keep attachments under 2MB."); return; }
    const reader = new FileReader();
    reader.onload = () => setFile({ file_name: f.name, file_data: reader.result });
    reader.readAsDataURL(f);
  };
  const send = async () => {
    const t = text.trim();
    if ((!t && !file) || posting) return;
    setPosting(true);
    try { await onPost({ author, content: t, ...(file || {}) }); setText(""); setFile(null); } finally { setPosting(false); }
  };
  return (
    <>
      {open && (
        <div className="comment-panel">
          <div className="comment-panel-head">
            <div>
              <div className="comment-panel-title">Comments</div>
              <div className="comment-panel-sub">Between Fahed and Andy</div>
            </div>
            <button className="close-btn" onClick={() => setOpen(false)} title="Close">✕</button>
          </div>
          <div className="comment-compose">
            <textarea className="input comment-compose-input" placeholder={author === "Andy Liu" ? "Leave a note for Fahed..." : "Reply to Andy..."} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
            <input ref={fileRef} type="file" className="photo-input-hidden" onChange={pickFile} />
            <button className="boss-clip-btn" onClick={() => fileRef.current && fileRef.current.click()} title="Attach a file or screenshot">📎</button>
            <button className="btn-primary" onClick={send} disabled={posting || (!text.trim() && !file)}>Send</button>
          </div>
          {file && (
            <div className="comment-attach-row">
              <span className="boss-file-chip">📎 {file.file_name}<button className="person-remove" title="Remove attachment" onClick={() => setFile(null)}>✕</button></span>
            </div>
          )}
          <div className="comment-panel-author">Posting as {author}</div>
          <div className="comment-feed">
            {sorted.length === 0 && <div className="empty-small">No comments yet. Start the conversation.</div>}
            {sorted.map((c) => {
              const tName = targetName ? targetName(c) : null;
              return (
                <div key={c.id} className="boss-comment">
                  <Avatar name={c.author} size={32} />
                  <div className="boss-comment-main">
                    <div className="boss-comment-meta"><span className="boss-comment-author">{c.author}</span><span className="boss-comment-time">{formatDateTime(c.created_at)}</span></div>
                    {tName && <div className="comment-target-chip">re: {tName}</div>}
                    {c.content && <div className="boss-comment-text">{c.content}</div>}
                    {c.file_data && (String(c.file_data).startsWith("data:image")
                      ? <img className="boss-comment-img" src={c.file_data} alt={c.file_name || "attachment"} />
                      : <a className="boss-comment-file" href={c.file_data} download={c.file_name || "file"}>📎 {c.file_name || "Download attachment"}</a>)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <button className={`comment-fab ${open ? "open" : ""}`} onClick={toggle} title="Comments">
        <span className="comment-fab-icon">💬</span>
        {unread > 0 && !open && <span className="comment-fab-badge">{unread}</span>}
      </button>
    </>
  );
}

// Per-entity "Boss Notes": comments tagged to a specific deal or institution.
// Andy adds notes here in Boss View; Fahed sees them (and can reply) on the sheet.
function BossNotes({ comments, entityName, tag, author, onPost }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const sorted = [...comments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const send = async () => {
    const t = text.trim();
    if (!t || posting) return;
    setPosting(true);
    try { await onPost({ author, content: t, ...tag }); setText(""); setAdding(false); } finally { setPosting(false); }
  };
  return (
    <div className="people-section boss-notes">
      <div className="ai-summary-header">
        <div className="section-label">Boss Notes</div>
        {!adding && <button className="btn-copy boss-addnote-btn" onClick={() => setAdding(true)} title={`Comment on ${entityName}`}>💬 Add note</button>}
      </div>
      {adding && (
        <div className="boss-note-form">
          <div className="boss-note-on">Comment on {entityName}</div>
          <textarea className="input textarea boss-note-input" placeholder={`Leave a note about ${entityName}...`} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <div className="boss-note-actions">
            <button className="btn-sec" onClick={() => { setAdding(false); setText(""); }}>Cancel</button>
            <button className="btn-primary" onClick={send} disabled={posting || !text.trim()}>Send</button>
          </div>
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="empty-small">No notes on {entityName} yet.</div>
      ) : (
        <div className="boss-notes-list">
          {sorted.map((c) => (
            <div key={c.id} className="boss-comment">
              <Avatar name={c.author} size={30} />
              <div className="boss-comment-main">
                <div className="boss-comment-meta"><span className="boss-comment-author">{c.author}</span><span className="boss-comment-time">{formatDateTime(c.created_at)}</span></div>
                {c.content && <div className="boss-comment-text">{c.content}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
