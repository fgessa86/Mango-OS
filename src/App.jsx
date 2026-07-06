import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./supabase";
import { generateSummary, summarizeImage, researchInstitution, researchKeyPeople, researchClinicalTrials, getApiCallsToday } from "./anthropic";
import { STAGES, ACT_TYPES, TAG_OPTIONS, ENABLER_TYPES, PRIORITIES, ORG_TYPES, INSTITUTION_TYPES, CONNECTION_RELATIONSHIPS, DEAL_ENABLER_RELATIONSHIPS, NETWORK_EDGE_RELATIONSHIPS, PERSON_CONNECTION_RELATIONSHIPS, DEAL_TIERS, STRENGTHS, WARMTH_LEVELS, SAUDI_CITIES, REGIONS } from "./constants";
import { formatDate, formatDateTime, formatFull, daysAgo, isToday, isThisWeek, isOverdue } from "./utils";
import MapTab from "./MapTab";
import "./styles.css";

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
  demo: { glyph: "◎", bg: "#EFEAFB", fg: "#8B5CF6" },
  note: { glyph: "✎", bg: "#FDF0DA", fg: "#B5791A" },
  proposal_sent: { glyph: "✎", bg: "#FDF0DA", fg: "#B5791A" },
  transcript: { glyph: "✎", bg: "#FDF0DA", fg: "#B5791A" },
};
function ActivityGlyph({ type }) {
  const g = ACTIVITY_GLYPHS[type] || { glyph: "•", bg: "#F1EADD", fg: "#8A8072" };
  return <span className="timeline-icon" style={{ background: g.bg, color: g.fg }}>{g.glyph}</span>;
}

// Minimal geometric nav icons (2px strokes). Active color is handled via CSS.
function NavIcon({ shape }) {
  if (shape === "square") return <span className="nav-icon nav-icon-square" />;
  if (shape === "circle") return <span className="nav-icon nav-icon-circle" />;
  if (shape === "diamond") return <span className="nav-icon nav-icon-diamond" />;
  if (shape === "lines") return <span className="nav-icon nav-icon-lines"><i /><i /><i /></span>;
  if (shape === "chart") return <span className="nav-icon nav-icon-square" style={{ borderRadius: 4 }} />;
  return null;
}

// Left sidebar: wordmark, primary nav (geometric icons), a More section for
// Reports/Boss View, static Saved Views, and a user card pinned to the bottom.
function Sidebar({ view, setView, tasksCount, sheetOrigin = "network", apiCallsToday = 0 }) {
  const nav = [
    { id: "pipeline", label: "Pipeline", shape: "square" },
    { id: "network", label: "Ecosystem", shape: "circle" },
    { id: "map", label: "Network Map", shape: "diamond" },
    { id: "tasks", label: "Tasks", shape: "lines", count: tasksCount },
  ];
  const more = [
    { id: "reports", label: "Reports" },
    { id: "boss", label: "Boss View" },
  ];
  const mapView = view === "institution-sheet" ? sheetOrigin : view === "person-sheet" ? "network" : view;
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">🥭</span>
        <span className="sidebar-wordmark">Mango OS</span>
      </div>
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

      <div className="sidebar-section-label">More</div>
      <div className="sidebar-more">
        {more.map((n) => (
          <button key={n.id} onClick={() => setView(n.id)} className={`nav-item nav-item-sm ${mapView === n.id ? "active" : ""}`}>
            <span className="nav-bar" />
            <span className="nav-label">{n.label}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-section-label">Saved Views</div>
      <div className="sidebar-saved">
        {["Tier 1 targets", "Riyadh accounts", "Closing this quarter"].map((s) => (
          <div key={s} className="saved-view">{s}</div>
        ))}
      </div>

      <div className="sidebar-user">
        <Avatar name="Fahed Al Essa" size={34} initials="FA" />
        <div className="sidebar-user-meta">
          <div className="sidebar-user-name">Fahed Al Essa</div>
          <div className="sidebar-user-role">VP of Commercial</div>
        </div>
      </div>
      <div className="sidebar-api-calls" title="Anthropic API calls made today (resets at midnight)">API calls today: {apiCallsToday}</div>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const ref = useRef(null);
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const len = ref.current.value.length;
      ref.current.setSelectionRange(len, len);
    }
  }, [editing]);
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

// Always-visible scratchpad textarea. Saves on blur, never behind an edit button.
function NotesEditor({ value, onSave, placeholder = "Add notes..." }) {
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value]);
  const commit = () => { if ((draft || "") !== (value || "")) onSave(draft); };
  return (
    <textarea
      className="input notes-editor"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
    />
  );
}

// A colored pill that is a real <select>: click opens the native dropdown, the
// chosen value saves immediately. Used for stage / tier / type / warmth / priority.
function BadgeSelect({ options, value, color = "#9A8F7C", onChange, dot = false, title }) {
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
  const [editing, setEditing] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!editing || !wrapRef.current) return;
    const el = wrapRef.current.querySelector("select, input");
    if (el) { el.focus(); try { el.showPicker && el.showPicker(); } catch { /* not user-activated, stays focused */ } }
  }, [editing]);
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
  const [adding, setAdding] = useState(false);
  const cities = parseCities(city);
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
  const [editing, setEditing] = useState(false);
  const cities = parseCities(city);
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
  const [view, setView] = useState("pipeline");
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [bossComments, setBossComments] = useState([]);
  const [apiCallsToday, setApiCallsToday] = useState(() => getApiCallsToday());
  const [enablers, setEnablers] = useState([]);
  const [dealContacts, setDealContacts] = useState([]);
  const [enablerContacts, setEnablerContacts] = useState([]);
  const [todos, setTodos] = useState([]);
  const [taskFilter, setTaskFilter] = useState("all");
  const [organizations, setOrganizations] = useState([]);
  const [dealEnablers, setDealEnablers] = useState([]);
  const [networkEdges, setNetworkEdges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [reportCopied, setReportCopied] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [tierFilter, setTierFilter] = useState("all");
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [toast, setToast] = useState(null);
  const [institutionSheetKey, setInstitutionSheetKey] = useState(null);
  const [sheetOrigin, setSheetOrigin] = useState("network");
  const [personSheetId, setPersonSheetId] = useState(null);
  const [customOptions, setCustomOptions] = useState([]);
  const [contactRoles, setContactRoles] = useState([]);
  const [summarizing, setSummarizing] = useState(false);
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
      const [d, c, a, en, dc, ec, td, orgs, de, ne, co, cr, bc] = await Promise.all([
        api("deals", "GET", null, "?select=*&order=created_at.desc"),
        api("contacts", "GET", null, "?select=*&order=name.asc"),
        api("activities", "GET", null, "?select=*&order=created_at.desc"),
        api("enablers", "GET", null, "?select=*&order=name.asc"),
        api("deal_contacts", "GET", null, "?select=*,contacts(*)&order=created_at.asc"),
        api("enabler_contacts", "GET", null, "?select=*,contacts(*)&order=created_at.asc"),
        api("todos", "GET", null, "?select=*&order=created_at.desc"),
        api("organizations", "GET", null, "?select=*&order=name.asc"),
        api("deal_enablers", "GET", null, "?select=*,deals(*),enablers(*)&order=created_at.desc"),
        api("network_edges", "GET", null, "?select=*&order=created_at.desc"),
        api("custom_options", "GET", null, "?select=*&order=created_at.asc"),
        api("contact_roles", "GET", null, "?select=*,contacts(*)&order=created_at.asc"),
        api("boss_comments", "GET", null, "?select=*&order=created_at.desc").catch(() => []),
      ]);
      setDeals(d || []); setContacts(c || []); setActivities(a || []); setEnablers(en || []);
      setDealContacts(dc || []); setEnablerContacts(ec || []); setTodos(td || []);
      setOrganizations(orgs || []); setDealEnablers(de || []); setNetworkEdges(ne || []);
      setCustomOptions(co || []); setContactRoles(cr || []); setBossComments(bc || []);
    } catch (e) { showToast("Failed to load data"); }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Boss View can be opened standalone via ?view=boss (shareable link, no sidebar).
  const [bossStandalone] = useState(() => new URLSearchParams(window.location.search).get("view") === "boss");
  useEffect(() => { if (bossStandalone) setView("boss"); }, [bossStandalone]);

  // Keep the sidebar API-call counter in sync. bumpApiCalls dispatches this event;
  // also refresh on focus so a day rollover shows the reset count.
  useEffect(() => {
    const sync = () => setApiCallsToday(getApiCallsToday());
    window.addEventListener("mango-api-call", sync);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("mango-api-call", sync); window.removeEventListener("focus", sync); };
  }, []);

  const postBossComment = async ({ author, content, file_name, file_data }) => {
    const text = (content || "").trim();
    if (!text && !file_data) return;
    try {
      const clean = { author, content: text };
      if (file_name) clean.file_name = file_name;
      if (file_data) clean.file_data = file_data;
      await api("boss_comments", "POST", clean);
      await loadData();
    } catch { showToast("Error posting comment"); }
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
      await api("custom_options", "POST", { field_name: fieldName, value: v });
      await loadData();
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
      await loadData(); setModal(null); showToast(form.id ? "Deal updated" : "Deal added");
    } catch { showToast("Error saving deal"); }
  };


  const moveDeal = async (dealId, newStage) => {
    try {
      await api("deals", "PATCH", { stage: newStage, last_activity_at: new Date().toISOString() }, `?id=eq.${dealId}`);
      await api("activities", "POST", { deal_id: dealId, type: "note", description: `Moved to ${STAGES.find((s) => s.id === newStage)?.label}` });
      await loadData();
    } catch { showToast("Error moving deal"); }
  };

  const setDealTier = async (dealId, tier) => {
    try {
      await api("deals", "PATCH", { tier: tier || "Untiered" }, `?id=eq.${dealId}`);
      await loadData(); savedToast();
    } catch { showToast("Error updating tier"); }
  };

  // ---- Generic inline-edit PATCH helpers (single-field saves from the sheets) ----
  const updateDeal = async (id, patch) => {
    try {
      await api("deals", "PATCH", { ...patch, last_activity_at: new Date().toISOString() }, `?id=eq.${id}`);
      await loadData(); savedToast();
    } catch { showToast("Error saving"); }
  };
  const updateContact = async (id, patch) => {
    try {
      await api("contacts", "PATCH", patch, `?id=eq.${id}`);
      await loadData(); savedToast();
    } catch { showToast("Error saving"); }
  };
  const updateEnabler = async (id, patch) => {
    try {
      await api("enablers", "PATCH", patch, `?id=eq.${id}`);
      await loadData(); savedToast();
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
      const orgId = await ensureOrgId(inst);
      if (!orgId) throw new Error("no org");
      await api("organizations", "PATCH", patch, `?id=eq.${orgId}`);
      await loadData(); savedToast();
    } catch { showToast("Error saving"); }
  };
  // City lives on every backing row, so keep the organization, deal, and enabler
  // in sync when it changes (a Target's deal card reads the deal's city).
  const updateInstitutionCity = async (inst, city) => {
    const c = (city || "").trim() || null;
    try {
      const orgId = await ensureOrgId(inst);
      if (orgId) await api("organizations", "PATCH", { city: c }, `?id=eq.${orgId}`);
      if (inst.dealId) await api("deals", "PATCH", { city: c }, `?id=eq.${inst.dealId}`);
      if (inst.enablerId) await api("enablers", "PATCH", { city: c }, `?id=eq.${inst.enablerId}`);
      await loadData(); savedToast();
    } catch { showToast("Error saving"); }
  };
  // Renaming an institution renames every backing row and re-keys the open sheet.
  const renameInstitution = async (inst, rawName) => {
    const name = (rawName || "").trim();
    if (!name || name === inst.name) return;
    try {
      if (inst.orgId) await api("organizations", "PATCH", { name }, `?id=eq.${inst.orgId}`);
      if (inst.dealId) await api("deals", "PATCH", { company: name }, `?id=eq.${inst.dealId}`);
      if (inst.enablerId) await api("enablers", "PATCH", { name }, `?id=eq.${inst.enablerId}`);
      if (!inst.orgId && !inst.dealId && !inst.enablerId) return;
      await loadData(); setInstitutionSheetKey(name.toLowerCase()); savedToast();
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
      const companyLower = clean.company.toLowerCase();
      const matchedDeal = deals.find((d) => (d.company || "").toLowerCase() === companyLower);
      if (matchedDeal) await api("deal_contacts", "POST", { deal_id: matchedDeal.id, contact_id: created.id }).catch(() => {});
      const matchedEnabler = enablers.find((en) => (en.name || "").toLowerCase() === companyLower);
      if (matchedEnabler) await api("enabler_contacts", "POST", { enabler_id: matchedEnabler.id, contact_id: created.id }).catch(() => {});
    }
    return created;
  };

  const saveContact = async (form) => {
    try {
      await persistContact(form);
      await loadData(); setModal(null); showToast(form.id ? "Contact updated" : "Contact added");
    } catch { showToast("Error saving contact"); }
  };

  const deleteContact = async (id) => {
    try {
      await api("deal_contacts", "DELETE", null, `?contact_id=eq.${id}`);
      await api("enabler_contacts", "DELETE", null, `?contact_id=eq.${id}`);
      await api("contact_roles", "DELETE", null, `?contact_id=eq.${id}`);
      await api("network_edges", "DELETE", null, `?source_type=eq.contact&source_id=eq.${id}`);
      await api("todos", "DELETE", null, `?contact_id=eq.${id}`);
      await api("network_edges", "DELETE", null, `?target_type=eq.contact&target_id=eq.${id}`);
      await api("contacts", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Person deleted");
      setView("network"); setPersonSheetId(null);
    } catch { showToast("Error deleting person"); }
  };

  // PEOPLE (deal_contacts / enabler_contacts junction tables, plus contact_roles
  // as the newer unified source of truth; addPersonRole/removePersonRole below
  // keep all three in sync no matter which surface the write comes from)
  const addDealContact = async (dealId, contactId, role) => {
    try {
      const clean = { deal_id: dealId, contact_id: contactId };
      if ((role || "").trim()) clean.role_in_deal = role.trim();
      await api("deal_contacts", "POST", clean);
      await api("contact_roles", "POST", { contact_id: contactId, entity_type: "deal", entity_id: dealId, role_title: (role || "").trim() || null }).catch(() => {});
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person (maybe already linked)"); }
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
      const clean = { enabler_id: enablerId, contact_id: contactId };
      if ((role || "").trim()) clean.role_in_org = role.trim();
      await api("enabler_contacts", "POST", clean);
      await api("contact_roles", "POST", { contact_id: contactId, entity_type: "enabler", entity_id: enablerId, role_title: (role || "").trim() || null }).catch(() => {});
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person (maybe already linked)"); }
  };


  // Adds a contact_roles row for any institution kind (deal/enabler/organization)
  // and fans out to the matching legacy table so every existing sheet's People
  // section (which still reads deal_contacts/enabler_contacts/network_edges)
  // keeps working without changes. No UI side effects, so callers that add
  // several roles in a row (see addPersonWithRoles) can reload/toast once at the end.
  const persistPersonRole = async ({ contactId, entityType, entityId, roleTitle, isPrimary = false }) => {
    const title = (roleTitle || "").trim() || null;
    await api("contact_roles", "POST", { contact_id: contactId, entity_type: entityType, entity_id: entityId, role_title: title, is_primary: !!isPrimary });
    if (entityType === "deal") {
      await api("deal_contacts", "POST", { deal_id: entityId, contact_id: contactId, ...(title ? { role_in_deal: title } : {}) }).catch(() => {});
    } else if (entityType === "enabler") {
      await api("enabler_contacts", "POST", { enabler_id: entityId, contact_id: contactId, ...(title ? { role_in_org: title } : {}) }).catch(() => {});
    } else if (entityType === "organization") {
      await api("network_edges", "POST", { source_type: "contact", source_id: contactId, target_type: "organization", target_id: entityId, relationship: "works_at", strength: "unknown", ...(title ? { notes: title } : {}) }).catch(() => {});
    }
  };

  const addPersonRole = async (args) => {
    try {
      await persistPersonRole(args);
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person (maybe already linked)"); }
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
  // Each role's institutionKey is "type:id" for an existing institution, or a
  // { newName, newType } object to create a fresh organization inline. Also
  // writes the optional "connected through" and "can help us reach" edges.
  const addPersonWithRoles = async ({ name, company, role, email, phone, linkedin, warmth, notes, roles, connectedThrough, canReach, relationship }) => {
    try {
      // company/role, when supplied (e.g. adding a new person from an institution
      // sheet), populate the contact's own company/role fields in the same save.
      const created = await persistContact({ name, company, role, email, phone, linkedin, warmth, notes });
      if (!created) throw new Error("Could not create contact");
      const validRoles = (roles || []).filter((r) => r.institutionKey || (r.newName || "").trim());
      let primaryAssigned = false;
      for (const r of validRoles) {
        let entityType, entityId;
        if (r.newName && r.newName.trim()) {
          const org = await persistOrganization({ name: r.newName.trim(), type: r.newType || "hospital" });
          if (!org) continue;
          entityType = "organization"; entityId = org.id;
        } else {
          const idx = r.institutionKey.indexOf(":");
          entityType = r.institutionKey.slice(0, idx);
          entityId = r.institutionKey.slice(idx + 1);
        }
        await persistPersonRole({ contactId: created.id, entityType, entityId, roleTitle: r.role, isPrimary: !primaryAssigned });
        primaryAssigned = true;
      }
      const rel = relationship || "knows";
      if (connectedThrough) {
        await api("network_edges", "POST", { source_type: "contact", source_id: created.id, target_type: "contact", target_id: connectedThrough, relationship: rel, strength: "medium", direction: "bidirectional" }).catch(() => {});
      }
      if (canReach) {
        const idx = canReach.indexOf(":");
        await api("network_edges", "POST", { source_type: "contact", source_id: created.id, target_type: canReach.slice(0, idx), target_id: canReach.slice(idx + 1), relationship: rel, strength: "medium", direction: "directed" }).catch(() => {});
      }
      const n = validRoles.length;
      await loadData(); showToast(`${created.name} added${n > 0 ? ` with ${n} role${n === 1 ? "" : "s"}` : ""}.`);
    } catch { showToast("Error adding person"); }
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
    await api("deal_contacts", "DELETE", null, `?deal_id=eq.${id}`).catch(() => {});
    await api("contact_roles", "DELETE", null, `?entity_type=eq.deal&entity_id=eq.${id}`).catch(() => {});
    await api("deal_enablers", "DELETE", null, `?deal_id=eq.${id}`).catch(() => {});
    await api("deals", "DELETE", null, `?id=eq.${id}`);
  };

  const purgeEnabler = async (id) => {
    await api("activities", "PATCH", { enabler_id: null }, `?enabler_id=eq.${id}`).catch(() => {});
    await api("todos", "PATCH", { enabler_id: null }, `?enabler_id=eq.${id}`).catch(() => {});
    await api("enabler_contacts", "DELETE", null, `?enabler_id=eq.${id}`).catch(() => {});
    await api("contact_roles", "DELETE", null, `?entity_type=eq.enabler&entity_id=eq.${id}`).catch(() => {});
    await api("deal_enablers", "DELETE", null, `?enabler_id=eq.${id}`).catch(() => {});
    await api("enablers", "DELETE", null, `?id=eq.${id}`);
  };

  // Ecosystem tab's "+ Institution" form. Always creates an organizations row, and
  // creates a linked deal (Target) and/or enabler (Enabler) when those boxes are
  // checked, keeping the Pipeline in sync.
  const addInstitution = async (form) => {
    const name = (form.name || "").trim();
    if (!name) { showToast("Name is required"); return; }
    try {
      const org = await persistOrganization({ name, type: form.type, city: form.city, region: form.region, sector: form.sector, description: form.description, website: form.website });
      if (form.isTarget) await createDealForInstitution({ name, city: form.city, region: form.region });
      if (form.isEnabler) await createEnablerForInstitution({ name, city: form.city, region: form.region });
      await loadData(); showToast(`${name} added. Click to add people.`);
      // Auto-research the new institution unless the user supplied a description.
      if (org?.id && !(form.description || "").trim()) {
        autoFillInstitution({ key: name.toLowerCase(), name, city: form.city, orgId: org.id });
      }
    } catch { showToast("Error adding institution"); }
  };

  // Institution Sheet's edit modal. Ensures an organizations row exists, then
  // reconciles the Target/Enabler checkboxes against the existing linked rows:
  // checking creates the deal/enabler, unchecking archives it.
  const saveInstitution = async (form) => {
    const name = (form.name || "").trim();
    if (!name) { showToast("Name is required"); return; }
    try {
      await persistOrganization({ id: form.orgId || undefined, name, type: form.type, city: form.city, region: form.region, sector: form.sector, description: form.description, website: form.website, notes: form.notes });
      if (form.isTarget && !form.dealId) await createDealForInstitution({ name, city: form.city, region: form.region });
      else if (!form.isTarget && form.dealId) await purgeDeal(form.dealId);
      else if (form.isTarget && form.dealId) await api("deals", "PATCH", { company: name, ...(form.city ? { city: form.city } : {}), ...(form.region ? { region: form.region } : {}) }, `?id=eq.${form.dealId}`);
      if (form.isEnabler && !form.enablerId) await createEnablerForInstitution({ name, city: form.city, region: form.region });
      else if (!form.isEnabler && form.enablerId) await purgeEnabler(form.enablerId);
      else if (form.isEnabler && form.enablerId) await api("enablers", "PATCH", { name, ...(form.city ? { city: form.city } : {}), ...(form.region ? { region: form.region } : {}) }, `?id=eq.${form.enablerId}`);
      await loadData(); setModal(null); showToast("Institution updated");
      setInstitutionSheetKey(name.toLowerCase());
    } catch { showToast("Error saving institution"); }
  };

  // Toggles an institution's Target or Enabler flag directly from the sheet:
  // checking creates the linked deal/enabler, unchecking archives it (history kept).
  const setInstitutionFlag = async (inst, flag, checked) => {
    try {
      if (flag === "target") {
        if (checked && !inst.dealId) await createDealForInstitution({ name: inst.name, city: inst.city, region: inst.region });
        else if (!checked && inst.dealId) await purgeDeal(inst.dealId);
        else return;
      } else {
        if (checked && !inst.enablerId) await createEnablerForInstitution({ name: inst.name, city: inst.city, region: inst.region });
        else if (!checked && inst.enablerId) await purgeEnabler(inst.enablerId);
        else return;
      }
      await loadData(); savedToast();
    } catch { showToast("Error updating institution"); }
  };

  const deleteInstitution = async (inst) => {
    try {
      if (inst.dealId) await purgeDeal(inst.dealId);
      if (inst.enablerId) await purgeEnabler(inst.enablerId);
      if (inst.orgId) {
        await api("activities", "DELETE", null, `?organization_id=eq.${inst.orgId}`);
        await api("network_edges", "DELETE", null, `?source_type=eq.organization&source_id=eq.${inst.orgId}`);
        await api("network_edges", "DELETE", null, `?target_type=eq.organization&target_id=eq.${inst.orgId}`);
        await api("contact_roles", "DELETE", null, `?entity_type=eq.organization&entity_id=eq.${inst.orgId}`);
        await api("organizations", "DELETE", null, `?id=eq.${inst.orgId}`);
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

  // DEAL <-> ENABLER CONNECTIONS
  const addDealEnabler = async (form) => {
    try {
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
        ? dealActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${a.description}`).join("\n")
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
      await api("deals", "PATCH", { ai_summary: summary, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${deal.id}`);
      await loadData(); showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const generateEnablerSummary = async (enabler, enablerActivities) => {
    setSummarizing(true);
    try {
      const activityText = enablerActivities.length > 0
        ? enablerActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${a.description}`).join("\n")
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
      await api("enablers", "PATCH", { ai_summary: summary, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${enabler.id}`);
      await loadData(); showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const generateContactSummary = async (contact, contactActivities) => {
    setSummarizing(true);
    try {
      const activityText = contactActivities.length > 0
        ? contactActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${a.description}`).join("\n")
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
      await api("contacts", "PATCH", { ai_summary: summary, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${contact.id}`);
      await loadData(); showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const saveContactSummary = async (id, text) => {
    try {
      await api("contacts", "PATCH", { ai_summary: text, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${id}`);
      await loadData(); showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  const generateOrganizationSummary = async (organization, orgActivities, keyPeopleNames) => {
    setSummarizing(true);
    try {
      const activityText = orgActivities.length > 0
        ? orgActivities.slice().reverse().map((a) => `[${formatDate(a.created_at)}] ${ACT_TYPES.find((t) => t.id === a.type)?.label || a.type}: ${a.description}`).join("\n")
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
      await api("organizations", "PATCH", { ai_summary: summary, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${organization.id}`);
      await loadData(); showToast("Summary generated");
    } catch { showToast("Error generating summary"); }
    setSummarizing(false);
  };

  const saveOrganizationSummary = async (id, text) => {
    try {
      await api("organizations", "PATCH", { ai_summary: text, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${id}`);
      await loadData(); showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  const saveDealSummary = async (id, text) => {
    try {
      await api("deals", "PATCH", { ai_summary: text, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${id}`);
      await loadData(); showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  const saveEnablerSummary = async (id, text) => {
    try {
      await api("enablers", "PATCH", { ai_summary: text, ai_summary_updated_at: new Date().toISOString() }, `?id=eq.${id}`);
      await loadData(); showToast("Summary saved");
    } catch { showToast("Error saving summary"); }
  };

  // TODOS
  const saveTodo = async (form) => {
    try {
      const title = (form.title || "").trim();
      if (!title) { showToast("Title is required"); return; }
      const clean = { title, priority: form.priority || "medium", status: "open" };
      if (form.due_date) clean.due_date = form.due_date;
      if (form.contact_id) clean.contact_id = form.contact_id;
      if (form.deal_id) clean.deal_id = form.deal_id;
      if (form.enabler_id) clean.enabler_id = form.enabler_id;
      await api("todos", "POST", clean);
      await loadData(); showToast("To-do added");
    } catch { showToast("Error adding to-do"); }
  };

  const toggleTodo = async (todo) => {
    try {
      const completing = todo.status !== "completed";
      await api("todos", "PATCH", { status: completing ? "completed" : "open", completed_at: completing ? new Date().toISOString() : null }, `?id=eq.${todo.id}`);
      await loadData();
    } catch { showToast("Error updating to-do"); }
  };

  const updateTodo = async (id, patch) => {
    try {
      await api("todos", "PATCH", patch, `?id=eq.${id}`);
      await loadData(); showToast("To-do updated");
    } catch { showToast("Error updating to-do"); }
  };

  // Task/link navigation. Deals open the Pipeline deal sheet; enablers are
  // institutions, so open by name in the Ecosystem institution sheet.
  const openTaskLink = (link) => {
    if (link.type === "deal") { const d = deals.find((x) => x.id === link.id); if (d) openInstitution(d.company); }
    else if (link.type === "enabler") { const en = enablers.find((e) => e.id === link.id); if (en) openInstitution(en.name); }
  };

  // ACTIVITY
  const addActivity = async (dealId, contactId, activity, enablerId = null, organizationId = null) => {
    try {
      await api("activities", "POST", { deal_id: dealId, contact_id: contactId, enabler_id: enablerId, organization_id: organizationId, ...activity });
      if (dealId) await api("deals", "PATCH", { last_activity_at: new Date().toISOString() }, `?id=eq.${dealId}`);
      if (contactId) await api("contacts", "PATCH", { last_contacted_at: new Date().toISOString() }, `?id=eq.${contactId}`);
      if (enablerId) await api("enablers", "PATCH", { last_activity_at: new Date().toISOString() }, `?id=eq.${enablerId}`);
      await loadData(); setModal(null); showToast("Activity logged");
    } catch { showToast("Error logging activity"); }
  };

  const handleDrop = (e, stageId) => {
    e.preventDefault();
    const dealId = e.dataTransfer.getData("dealId");
    if (dealId) moveDeal(dealId, stageId);
    setDragOver(null);
  };

  // REPORTS
  const generateEOD = () => {
    const todayActs = activities.filter((a) => isToday(a.created_at));
    const todayDeals = deals.filter((d) => isToday(d.last_activity_at));
    let r = `DAILY UPDATE | ${formatFull(new Date())}\n\nDEALS TOUCHED: ${todayDeals.length}  |  ACTIVITIES: ${todayActs.length}\n\n`;
    if (todayActs.length > 0) {
      r += `TODAY'S ACTIVITY:\n`;
      todayActs.forEach((a) => {
        const deal = deals.find((d) => d.id === a.deal_id);
        r += `${ACT_TYPES.find((t) => t.id === a.type)?.icon || "."} ${deal?.company || "General"}: ${a.description}\n`;
      });
      r += "\n";
    }
    r += `PIPELINE SNAPSHOT:\n`;
    STAGES.filter((s) => !["won","lost"].includes(s.id)).forEach((s) => {
      const c = deals.filter((d) => d.stage === s.id).length;
      if (c > 0) r += `  ${s.label}: ${c}\n`;
    });
    const tv = deals.filter((d) => !["won","lost"].includes(d.stage)).reduce((s, d) => s + (Number(d.value) || 0), 0);
    if (tv > 0) r += `  Total Value: $${tv.toLocaleString()}\n`;
    const prio = deals.filter((d) => d.next_action && !["won","lost"].includes(d.stage)).slice(0, 5);
    if (prio.length > 0) { r += `\nTOMORROW'S PRIORITIES:\n`; prio.forEach((d) => { r += `. ${d.company}: ${d.next_action}\n`; }); }
    return r;
  };

  const generateEOW = () => {
    const weekActs = activities.filter((a) => isThisWeek(a.created_at));
    let r = `WEEKLY PIPELINE REPORT | Week of ${formatFull(new Date())}\n${"=".repeat(50)}\n\n`;
    r += `SUMMARY\n. Deals touched: ${deals.filter((d) => isThisWeek(d.last_activity_at)).length}\n. Activities: ${weekActs.length}\n. New deals: ${deals.filter((d) => isThisWeek(d.created_at)).length}\n. Won: ${deals.filter((d) => d.stage === "won" && isThisWeek(d.last_activity_at)).length}\n. Lost: ${deals.filter((d) => d.stage === "lost" && isThisWeek(d.last_activity_at)).length}\n\n`;
    const byType = {};
    weekActs.forEach((a) => { byType[a.type] = (byType[a.type] || 0) + 1; });
    if (Object.keys(byType).length > 0) { r += `ACTIVITY BREAKDOWN:\n`; Object.entries(byType).forEach(([t, c]) => { r += `. ${ACT_TYPES.find((x) => x.id === t)?.label || t}: ${c}\n`; }); r += "\n"; }
    r += `PIPELINE BY STAGE:\n`;
    STAGES.forEach((s) => {
      const sd = deals.filter((d) => d.stage === s.id);
      if (sd.length > 0) {
        const v = sd.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
        r += `\n${s.label} (${sd.length})${v > 0 ? ` | $${v.toLocaleString()}` : ""}\n`;
        sd.forEach((d) => { r += `  . ${d.company}${d.contact_name ? ` (${d.contact_name})` : ""}${d.next_action ? ` | Next: ${d.next_action}` : ""}\n`; });
      }
    });
    const total = deals.filter((d) => !["won","lost"].includes(d.stage));
    const tv = total.reduce((s, d) => s + (Number(d.value) || 0), 0);
    r += `\nTOTALS: ${total.length} active deals${tv > 0 ? ` | $${tv.toLocaleString()} pipeline value` : ""}\n`;
    return r;
  };

  const copyReport = (type) => {
    navigator.clipboard.writeText(type === "eod" ? generateEOD() : generateEOW()).then(() => {
      setReportCopied(type); setTimeout(() => setReportCopied(null), 2000);
    });
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
      <div key={deal.id} draggable onDragStart={(e) => e.dataTransfer.setData("dealId", deal.id)}
        onClick={() => openInstitution(deal.company, "pipeline")}
        className="deal-card">
        <div className="deal-card-head">
          <div className="card-company">{deal.company}</div>
          {t && t.id !== "Untiered" && <span className="tier-badge" style={{ background: t.bg, color: t.fg }}>{t.label}</span>}
        </div>
        {typeMeta && <span className="badge card-type-badge" style={{ background: typeMeta.color + "22", color: typeMeta.color, border: `1px solid ${typeMeta.color}44` }}>{typeMeta.label}</span>}
        {deal.contact_name && <div className="card-contact">{deal.contact_name}{deal.contact_role ? ` · ${deal.contact_role}` : ""}</div>}
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
  const openInstitution = (name, origin = "network") => { if (name) { setInstitutionSheetKey(name.trim().toLowerCase()); setSheetOrigin(origin); setView("institution-sheet"); } };
  const openPerson = (id) => { setPersonSheetId(id); setView("person-sheet"); };

  if (loading) return <div className="app loading-screen"><div className="loading-text">Loading Mango OS...</div></div>;

  if (bossStandalone) {
    return (
      <div className="app">
        {toast && <div className="toast">{toast}</div>}
        <main className="main">
          <BossView deals={deals} activeDeals={activeDeals} enablers={enablers} institutions={institutions} instByName={instByName} todos={todos} activities={activities} contacts={contacts} customOptions={customOptions} comments={bossComments} onPostComment={postBossComment} standalone />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      {toast && <div className="toast">{toast}</div>}

      <Sidebar view={view} setView={setView} tasksCount={openTodos.length} sheetOrigin={sheetOrigin} apiCallsToday={apiCallsToday} lastSynced={lastSyncedActivity ? `Synced ${formatDateTime(lastSyncedActivity.created_at)}` : "No sync yet"} />

      <main className="main">

      {/* UNIFIED INSTITUTION / DEAL SHEET */}
      {view === "institution-sheet" && institutionSheetKey && (() => {
        const inst = institutions.find((i) => i.key === institutionSheetKey);
        if (!inst) return null;
        const instActivities = activities.filter((a) =>
          (inst.dealId && a.deal_id === inst.dealId) ||
          (inst.enablerId && a.enabler_id === inst.enablerId) ||
          (inst.orgId && a.organization_id === inst.orgId));
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
            summaryEntity={inst.org || inst.deal || inst.enabler}
            activities={instActivities}
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
            onAddPersonRole={addPersonRole}
            onAddPersonWithRoles={addPersonWithRoles}
            onRemoveRole={removePersonRole}
            onRemoveNetworkEdge={removeNetworkEdge}
            onAddConnection={addConnection}
            onChangeStage={(stage) => inst.dealId && moveDeal(inst.dealId, stage)}
            onChangeTier={inst.dealId ? ((t) => setDealTier(inst.dealId, t)) : null}
            todos={todos.filter((t) => (inst.dealId && t.deal_id === inst.dealId) || (inst.enablerId && t.enabler_id === inst.enablerId))}
            onAddTodo={(form) => saveTodo({ ...form, deal_id: inst.dealId || null, enabler_id: inst.dealId ? null : (inst.enablerId || null) })}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodo}
            onNavigate={openTaskLink}
            onGenerateSummary={genSummary}
            onSaveSummary={saveSummary}
            summarizing={summarizing}
            showToast={showToast}
            onOpenInstitution={openInstitution}
            onOpenPerson={openPerson}
            backLabel={sheetOrigin === "pipeline" ? "Back to Pipeline" : "Back to Ecosystem"}
            onBack={() => { setView(sheetOrigin); setInstitutionSheetKey(null); }}
          />
        );
      })()}

      {/* PERSON SHEET */}
      {view === "person-sheet" && personSheetId && (() => {
        const sheetContact = contacts.find((c) => c.id === personSheetId);
        return sheetContact ? (
          <PersonSheet
            contact={sheetContact}
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
            onUpdate={(patch) => updateContact(sheetContact.id, patch)}
            onDelete={deleteContact}
            onAddActivity={addActivity}
            onAddRole={addPersonRole}
            onRemoveRole={removePersonRole}
            onConnectPerson={(sourceId, targetId, relationship) => addNetworkEdge({ source_type: "contact", source_id: sourceId, target_type: "contact", target_id: targetId, relationship, strength: "medium", direction: "bidirectional" })}
            onRemoveConnection={removeNetworkEdge}
            onGenerateSummary={generateContactSummary}
            onSaveSummary={saveContactSummary}
            summarizing={summarizing}
            showToast={showToast}
            onOpenInstitution={openInstitution}
            onOpenPerson={openPerson}
            onBack={() => { setView("network"); setPersonSheetId(null); }}
          />
        ) : null;
      })()}

      {/* PIPELINE */}
      {view === "pipeline" && (
        <div>
          <div className="page-header">
            <div>
              <div className="page-title">Pipeline</div>
              <div className="page-sub">Your commercial deals across the Kingdom</div>
            </div>
            <button onClick={() => setModal({type:"deal",data:{stage:"prospecting"}})} className="btn-primary">+ New deal</button>
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
          <div className="kanban">
            {STAGES.map((stage) => {
              const sd = deals.filter(d => d.stage === stage.id && (tierFilter === "all" || (d.tier || "Untiered") === tierFilter));
              return (
                <div key={stage.id} className={`column ${dragOver === stage.id ? "drag-over" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(stage.id); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => handleDrop(e, stage.id)}>
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
            onAddPersonWithRoles={addPersonWithRoles}
            onUpdateInstitution={updateInstitution}
            onUpdateInstitutionCity={updateInstitutionCity}
            onUpdateContact={updateContact}
            onLinkPersonToInstitution={(contactId, name) => {
              const i = institutions.find((x) => x.name.toLowerCase() === (name || "").toLowerCase());
              const primary = i && institutionPrimaryEntity(i);
              if (primary) addPersonRole({ contactId, entityType: primary.type, entityId: primary.id });
            }}
            onOpenInstitution={openInstitution}
            onOpenPerson={openPerson}
          />
        </div>
      )}

      {/* MAP */}
      {view === "map" && (
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
      )}

      {/* TASKS */}
      {view === "tasks" && (
        <div className="section-pad">
          <div className="page-header" style={{ padding: "0 0 16px" }}>
            <div>
              <div className="page-title">Tasks</div>
              <div className="page-sub">Everything that needs your attention</div>
            </div>
          </div>
          <TaskQuickAdd deals={activeDeals} enablers={enablers} customOptions={customOptions} onAddCustomOption={addCustomOption} onAdd={saveTodo} />
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

      {/* REPORTS */}
      {view === "reports" && (
        <div className="section-pad reports">
          {[["eod","End of Day Report","Today's activities and tomorrow's priorities"],["eow","End of Week Report","Weekly summary and pipeline breakdown"]].map(([k,t,d]) => (
            <div key={k} className="report-box">
              <div className="report-header">
                <div><div className="report-title">{t}</div><div className="report-desc">{d}</div></div>
                <button onClick={() => copyReport(k)} className="btn-copy">{reportCopied === k ? "Copied!" : "Copy"}</button>
              </div>
              <pre className="report-pre">{k === "eod" ? generateEOD() : generateEOW()}</pre>
            </div>
          ))}
        </div>
      )}

      {/* BOSS VIEW */}
      {view === "boss" && (
        <BossView deals={deals} activeDeals={activeDeals} enablers={enablers} institutions={institutions} instByName={instByName} todos={todos} activities={activities} contacts={contacts} customOptions={customOptions} comments={bossComments} onPostComment={postBossComment} />
      )}

      </main>

      {/* MODALS */}
      {modal?.type === "deal" && <DealForm deal={modal.data} contacts={contacts} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveDeal} onClose={() => setModal(null)} />}
      {modal?.type === "contact" && <ContactForm contact={modal.data} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveContact} onClose={() => setModal(null)} />}
      {modal?.type === "institution" && <InstitutionEditModal institution={modal.data} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveInstitution} onClose={() => setModal(null)} />}
    </div>
  );
}

function DealForm({ deal, contacts, customOptions, onAddCustomOption, onSave, onClose }) {
  const isEdit = !!deal.id;
  const [f, setF] = useState({ id:deal.id||"", company:deal.company||"", contact_id:deal.contact_id||"", contact_name:deal.contact_name||"", contact_role:deal.contact_role||"", value:deal.value||"", stage:deal.stage||"prospecting", tier:deal.tier||"Untiered", city:deal.city||"", region:deal.region||"", notes:deal.notes||"", next_action:deal.next_action||"" });
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  const pickContact = (id) => { const c = contacts.find(x=>x.id===id); if(c){setF(p=>({...p, contact_id:id, contact_name:c.name||"", contact_role:c.role||"", company:p.company||c.company||""}));} else {set("contact_id","");} };
  const stageOpts = optionsWithCustom(STAGES, customOptions, "deal_stage");
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

function ContactForm({ contact, customOptions, onAddCustomOption, onSave, onClose }) {
  const isEdit = !!contact.id;
  const [f, setF] = useState({ id:contact.id||"", name:contact.name||"", role:contact.role||"", company:contact.company||"", email:contact.email||"", phone:contact.phone||"", linkedin:contact.linkedin||"", source:contact.source||"", notes:contact.notes||"", tags:contact.tags||[], warmth:contact.warmth||"unknown", is_internal:!!contact.is_internal });
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const tagOpts = optionsWithCustom(toOptions(TAG_OPTIONS), customOptions, "tag").map((o) => o.id);
  const toggleTag = (t) => {
    setF(p=>({...p, tags:p.tags.includes(t)?p.tags.filter(x=>x!==t):[...p.tags,t]}));
    if (!f.tags.includes(t)) trackCustom("tag", toOptions(tagOpts), onAddCustomOption)(t);
  };
  const warmthOpts = optionsWithCustom(WARMTH_LEVELS, customOptions, "warmth");
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{isEdit?"Edit Contact":"New Contact"}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field"><label className="label">Name *</label><input className="input" value={f.name} onChange={e=>set("name",e.target.value)} /></div>
        <div className="field"><label className="label">Role / Title</label><input className="input" value={f.role} onChange={e=>set("role",e.target.value)} /></div>
        <div className="field"><label className="label">Company</label><input className="input" value={f.company} onChange={e=>set("company",e.target.value)} /></div>
        <div className="field"><label className="label">Email</label><input className="input" type="email" value={f.email} onChange={e=>set("email",e.target.value)} /></div>
        <div className="field"><label className="label">Phone</label><input className="input" value={f.phone} onChange={e=>set("phone",e.target.value)} /></div>
        <div className="field"><label className="label">LinkedIn</label><input className="input" value={f.linkedin} onChange={e=>set("linkedin",e.target.value)} /></div>
        <div className="field"><label className="label">Source</label><input className="input" value={f.source} onChange={e=>set("source",e.target.value)} placeholder="e.g. Conference, Referral" /></div>
        <div className="field-full"><label className="label">Warmth</label><ButtonGroupWithCustom options={warmthOpts} value={f.warmth} onChange={(v)=>{set("warmth",v); trackCustom("warmth", warmthOpts, onAddCustomOption)(v);}} renderOption={(w)=><><span className="warmth-dot" style={{background:w.color}} />{w.label}</>} /></div>
        <div className="field-full"><label className="checkbox-label"><input type="checkbox" checked={f.is_internal} onChange={e=>set("is_internal",e.target.checked)} /> Internal team member</label></div>
        <div className="field-full"><label className="label">Tags</label><TagPickerWithCustom options={tagOpts} value={f.tags} onToggle={toggleTag} /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.name.trim()&&onSave(f)} className="btn-primary" disabled={!f.name.trim()}>{isEdit?"Save":"Add Contact"}</button></div>
    </div></div>
  );
}


const TIMELINE_TABS = [
  { id: "all", label: "All" },
  { id: "call", label: "Calls" },
  { id: "email", label: "Emails" },
  { id: "meeting", label: "Meetings" },
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

function PersonSheet({ contact, activities, deals, enablers, organizations, contacts, dealContacts, enablerContacts, networkEdges, contactRoles, institutions, customOptions = [], onAddCustomOption = () => {}, onUpdate, onDelete, onAddActivity, onAddRole, onRemoveRole, onConnectPerson, onRemoveConnection, onGenerateSummary, onSaveSummary, summarizing, showToast, onOpenInstitution, onOpenPerson, onBack }) {
  const [filter, setFilter] = useState("all");
  const [addingRole, setAddingRole] = useState(false);
  const [roleInst, setRoleInst] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [addingConn, setAddingConn] = useState(false);
  const [connContactId, setConnContactId] = useState("");
  const [connRel, setConnRel] = useState("knows");
  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();
  const warmth = WARMTH_LEVELS.find(w => w.id === (contact.warmth || "unknown"));

  const roles = resolveContactRoles(contact, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });

  const instOptions = institutions.map(i => {
    const pe = institutionPrimaryEntity(i);
    return pe ? { key: `${pe.type}:${pe.id}`, label: `${i.name}${i.type ? ` (${institutionTypeMeta(i.type, customOptions).label})` : ""}` } : null;
  }).filter(Boolean);

  const submitRole = async () => {
    if (!roleInst) return;
    const idx = roleInst.indexOf(":");
    await onAddRole({ contactId: contact.id, entityType: roleInst.slice(0, idx), entityId: roleInst.slice(idx + 1), roleTitle });
    setAddingRole(false); setRoleInst(""); setRoleTitle("");
  };

  const relLabel = (id) => PERSON_CONNECTION_RELATIONSHIPS.find(r => r.id === id)?.label || NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === id)?.label || id;
  // Resolves a "(role, institution)" hint for a person, using their primary role.
  const personDetail = (other) => {
    const otherRoles = resolveContactRoles(other, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
    const primary = otherRoles.find(r => r.is_primary) || otherRoles[0];
    if (!primary) return other.company || "";
    const parts = [primary.role_title, primary.institutionName].filter(Boolean);
    return parts.join(", ");
  };

  // Connections: every network_edge touching this contact, resolved to the other end.
  const connectedContactIds = new Set();
  const connections = networkEdges
    .filter(ne => (ne.source_type === "contact" && ne.source_id === contact.id) || (ne.target_type === "contact" && ne.target_id === contact.id))
    .map(ne => {
      const isSource = ne.source_type === "contact" && ne.source_id === contact.id;
      const otherType = isSource ? ne.target_type : ne.source_type;
      const otherId = isSource ? ne.target_id : ne.source_id;
      const rel = relLabel(ne.relationship);
      if (otherType === "contact") {
        const other = contacts.find(c => c.id === otherId);
        if (!other) return null;
        connectedContactIds.add(otherId);
        const detail = personDetail(other);
        return { id: ne.id, label: other.name, detail, rel, onClick: () => onOpenPerson(other.id) };
      }
      const other = otherType === "deal" ? deals.find(d => d.id === otherId) : otherType === "enabler" ? enablers.find(e => e.id === otherId) : organizations.find(o => o.id === otherId);
      if (!other) return null;
      const name = otherType === "deal" ? other.company : other.name;
      return { id: ne.id, label: name, detail: "", rel, onClick: () => onOpenInstitution(name) };
    })
    .filter(Boolean);

  const connectableContacts = contacts.filter(c => c.id !== contact.id && !connectedContactIds.has(c.id));
  const relOpts = optionsWithCustom(PERSON_CONNECTION_RELATIONSHIPS, customOptions, "relationship");

  const submitConn = async () => {
    if (!connContactId || !onConnectPerson) return;
    await onConnectPerson(contact.id, connContactId, connRel);
    setAddingConn(false); setConnContactId(""); setConnRel("knows");
  };

  return (
    <div className="deal-sheet">
      <button onClick={onBack} className="sheet-back">← Back to Ecosystem</button>

      <div className="sheet-top">
        <div className="sheet-top-row">
          <div className="sheet-person-head">
            <Avatar name={contact.name} size={52} />
            <div>
            <div className="sheet-company"><InlineText value={contact.name} onSave={(v) => v.trim() && onUpdate({ name: v.trim() })} placeholder="Name" /></div>
            <div className="sheet-meta-row">
              <BadgeSelect options={WARMTH_LEVELS} value={contact.warmth || "unknown"} color={warmth?.color} onChange={(v) => onUpdate({ warmth: v })} dot title="Change warmth" />
            </div>
            <div className="contact-details mb-sm">
              <div>📧 <InlineText value={contact.email} onSave={(v) => onUpdate({ email: v })} placeholder="Add email" /></div>
              <div>📞 <InlineText value={contact.phone} onSave={(v) => onUpdate({ phone: v })} placeholder="Add phone" /></div>
              <div>🔗 <InlineText value={contact.linkedin} onSave={(v) => onUpdate({ linkedin: v })} placeholder="Add LinkedIn" /></div>
            </div>
            {(contact.tags || []).length > 0 && <div className="tags-row">{contact.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>}
            </div>
          </div>
          <div className="sheet-actions">
            <button onClick={() => { if (confirm("Delete this person?")) onDelete(contact.id); }} className="btn-sec btn-danger">Delete</button>
          </div>
        </div>
      </div>

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
        <NotesEditor value={contact.notes} onSave={(v) => onUpdate({ notes: v })} />
      </div>

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Roles</div>
          <button onClick={() => setAddingRole(v => !v)} className="btn-copy">{addingRole ? "Cancel" : "+ Add Role"}</button>
        </div>
        {addingRole && (
          <div className="quickadd-inline-row mb-sm">
            <select className="input" value={roleInst} onChange={e => setRoleInst(e.target.value)}>
              <option value="">Select institution...</option>
              {instOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <input className="input" placeholder="Role title (e.g. CEO)" value={roleTitle} onChange={e => setRoleTitle(e.target.value)} />
            <button onClick={submitRole} className="btn-primary" disabled={!roleInst}>Add</button>
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
                    {r.removable && onRemoveRole && <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this role?")) onRemoveRole(r); }} className="person-remove" title="Remove">✕</button>}
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
          <button onClick={() => setAddingConn(v => !v)} className="btn-copy">{addingConn ? "Cancel" : "+ Connect to Person"}</button>
        </div>
        {addingConn && (
          <div className="quickadd-inline-row mb-sm">
            <select className="input" value={connContactId} onChange={e => setConnContactId(e.target.value)}>
              <option value="">Select a person...</option>
              {connectableContacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ""}</option>)}
            </select>
            <SelectWithCustom options={relOpts} value={connRel} onChange={(v) => { setConnRel(v); trackCustom("relationship", relOpts, onAddCustomOption)(v); }} />
            <button onClick={submitConn} className="btn-primary" disabled={!connContactId}>Connect</button>
          </div>
        )}
        {connections.length === 0 ? (
          <div className="empty-small">No connections logged yet.</div>
        ) : (
          <div className="todo-list">
            {connections.map(c => (
              <div key={c.id} className="path-row">
                <div onClick={c.onClick} style={{ cursor: "pointer", flex: 1 }}>
                  <div className="path-chain">{c.rel} {c.label}{c.detail ? ` (${c.detail})` : ""}</div>
                </div>
                {onRemoveConnection && <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this connection?")) onRemoveConnection(c.id); }} className="person-remove" title="Remove">✕</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      <QuickAdd contactId={contact.id} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onAddActivity={onAddActivity} showToast={showToast} />

      <div className="timeline">
        <div className="section-label">Activity Timeline</div>
        <div className="timeline-tabs">
          {TIMELINE_TABS.map(t => (
            <button key={t.id} onClick={() => setFilter(t.id)} className={`tag-btn ${filter === t.id ? "active" : ""}`}>{t.label}</button>
          ))}
        </div>
        <div className="timeline-list">
          {filtered.length === 0 && <div className="empty-small">No activities yet</div>}
          {filtered.map(a => (
            <div key={a.id} className="timeline-item">
              <ActivityGlyph type={a.type} />
              <div>
                <div className="act-desc">{a.description}</div>
                <div className="act-date">{formatDate(a.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PeopleSection({ people, activities, contacts, institutionName, customOptions = [], onAddCustomOption = () => {}, selectedContactId, onSelectPerson, onAdd, onAddNew, onRemove }) {
  const [adding, setAdding] = useState(false);
  const linkedIds = new Set(people.map(p => p.contact_id));
  const available = contacts.filter(c => !linkedIds.has(c.id));

  return (
    <div className="people-section">
      <div className="ai-summary-header">
        <div className="section-label">People</div>
        <button onClick={() => setAdding(v => !v)} className="btn-copy">{adding ? "Cancel" : "+ Add Person"}</button>
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
                  <button onClick={(e) => { e.stopPropagation(); if (confirm(`Remove ${c.name || "this person"}?`)) onRemove(p); }} className="person-remove" title="Remove">✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuickAdd({ dealId = null, enablerId = null, organizationId = null, contactId, customOptions = [], onAddCustomOption = () => {}, onAddActivity, showToast }) {
  const [qType, setQType] = useState("call");
  const [qDesc, setQDesc] = useState("");
  const [posting, setPosting] = useState(false);
  const [summarizingText, setSummarizingText] = useState(false);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const fileInputRef = useRef(null);

  const submit = async () => {
    const text = qDesc.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      await onAddActivity(dealId, contactId, { type: qType, description: text }, enablerId, organizationId);
      setQDesc("");
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
      await onAddActivity(dealId, contactId, { type: "note", description: text }, enablerId, organizationId);
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
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" className="photo-input-hidden" onChange={pickPhoto} />
        <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-sec photo-btn" title="Upload photo of notes">📷</button>
        <button onClick={submit} className="btn-primary" disabled={!qDesc.trim() || posting}>Add</button>
      </div>

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
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [draft, setDraft] = useState(entity.ai_summary || "");

  // Only auto-generate when there is NO cached summary at all. An existing (even
  // stale) summary is shown instantly with no API call; the "New activity" hint
  // below prompts the user to Regenerate manually.
  useEffect(() => {
    if (!entity.ai_summary) onGenerateSummary(entity, activities);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id]);

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
          {isStale && !summarizing && <span className="ai-summary-stale" title="Activity has been logged since this summary was written">New activity since last summary</span>}
          <button onClick={(e) => { e.stopPropagation(); onGenerateSummary(entity, activities); }} className="link-btn" disabled={summarizing}>Regenerate</button>
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
          <div className={`ai-summary-text ${collapsed ? "ai-summary-collapsed" : ""}`} onClick={startEdit} title="Click to edit">{entity.ai_summary}</div>
          {!collapsed && <div className="ai-summary-updated">Last updated: {formatDate(entity.ai_summary_updated_at)}</div>}
        </>
      ) : (
        <div className="empty-small">No summary yet.</div>
      )}
    </div>
  );
}

function TodoForm({ contacts, customOptions = [], onAddCustomOption = () => {}, onSave, onCancel }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueDate, setDueDate] = useState("");
  const [contactId, setContactId] = useState("");
  const priorityOpts = optionsWithCustom(PRIORITIES, customOptions, "priority");

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onSave({ title: t, priority, due_date: dueDate || null, contact_id: contactId || null });
  };

  return (
    <div className="todo-form">
      <input className="input" placeholder="To-do title..." value={title} onChange={e => setTitle(e.target.value)} />
      <div className="todo-form-row">
        <SelectWithCustom options={priorityOpts} value={priority} onChange={(v) => { setPriority(v); trackCustom("priority", priorityOpts, onAddCustomOption)(v); }} />
        <input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
        {contacts.length > 0 && (
          <select className="input" value={contactId} onChange={e => setContactId(e.target.value)}>
            <option value="">No contact</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <button onClick={onCancel} className="btn-sec">Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!title.trim()}>Add</button>
      </div>
    </div>
  );
}

function TodoRow({ todo, contacts, deals = [], enablers = [], customOptions = [], onAddCustomOption = () => {}, onToggle, onUpdate, onNavigate }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [priority, setPriority] = useState(todo.priority);
  const [dueDate, setDueDate] = useState(todo.due_date || "");
  const [link, setLink] = useState(todo.deal_id ? `deal:${todo.deal_id}` : todo.enabler_id ? `enabler:${todo.enabler_id}` : "");
  const priorityOpts = optionsWithCustom(PRIORITIES, customOptions, "priority");

  const contact = todo.contact_id ? contacts.find(c => c.id === todo.contact_id) : null;
  const linkedDeal = todo.deal_id ? deals.find(d => d.id === todo.deal_id) : null;
  const linkedEnabler = todo.enabler_id ? enablers.find(en => en.id === todo.enabler_id) : null;
  const overdue = todo.status !== "completed" && isOverdue(todo.due_date);

  const startEdit = () => {
    setTitle(todo.title); setPriority(todo.priority); setDueDate(todo.due_date || "");
    setLink(todo.deal_id ? `deal:${todo.deal_id}` : todo.enabler_id ? `enabler:${todo.enabler_id}` : "");
    setEditing(true);
  };

  const save = () => {
    const t = title.trim();
    if (!t || !onUpdate) return;
    const patch = { title: t, priority, due_date: dueDate || null, deal_id: null, enabler_id: null };
    if (link.startsWith("deal:")) patch.deal_id = link.slice(5);
    else if (link.startsWith("enabler:")) patch.enabler_id = link.slice(8);
    onUpdate(todo.id, patch);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="todo-row todo-row-editing">
        <input type="checkbox" checked={todo.status === "completed"} onChange={() => onToggle(todo)} className="todo-checkbox" />
        <div className="todo-main">
          <input className="input todo-edit-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="To-do title..." />
          <div className="todo-form-row">
            <SelectWithCustom options={priorityOpts} value={priority} onChange={(v) => { setPriority(v); trackCustom("priority", priorityOpts, onAddCustomOption)(v); }} />
            <input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            <select className="input task-link-select" value={link} onChange={e => setLink(e.target.value)}>
              <option value="">No link</option>
              {deals.length > 0 && <optgroup label="Deals">{deals.map(d => <option key={d.id} value={`deal:${d.id}`}>{d.company}</option>)}</optgroup>}
              {enablers.length > 0 && <optgroup label="Enablers">{enablers.map(en => <option key={en.id} value={`enabler:${en.id}`}>{en.name}</option>)}</optgroup>}
            </select>
            <button onClick={() => setEditing(false)} className="btn-sec">Cancel</button>
            <button onClick={save} className="btn-primary" disabled={!title.trim()}>Save</button>
          </div>
        </div>
      </div>
    );
  }

  const done = todo.status === "completed";
  return (
    <div className={`todo-row ${done ? "todo-done" : ""}`}>
      <input type="checkbox" checked={done} onChange={() => onToggle(todo)} className="todo-checkbox" />
      <div className="todo-main">
        <div className="todo-title-row">
          <span className="todo-title">{todo.title}</span>
          {!done && onUpdate && <button onClick={startEdit} className="icon-btn" title="Edit task">✎</button>}
          {onUpdate
            ? <BadgeSelect options={PRIORITIES} value={todo.priority} color={PRIORITIES.find(p => p.id === todo.priority)?.color} onChange={(v) => onUpdate(todo.id, { priority: v })} title="Change priority" />
            : <PriorityBadge priority={todo.priority} />}
          {overdue && <span className="badge overdue-badge">Overdue</span>}
          {done && <button onClick={() => onToggle(todo)} className="btn-copy todo-reopen">Reopen</button>}
        </div>
        <div className="todo-meta-row">
          {done && todo.completed_at && <span className="todo-due">Completed {formatDate(todo.completed_at)}</span>}
          {!done && todo.due_date && <span className="todo-due">Due {formatDate(todo.due_date)}</span>}
          {contact && <span className="todo-contact">{contact.name}</span>}
          {(linkedDeal || linkedEnabler) && (onNavigate
            ? <button onClick={() => onNavigate(linkedDeal ? { type: "deal", id: linkedDeal.id } : { type: "enabler", id: linkedEnabler.id })} className="task-link">{linkedDeal ? linkedDeal.company : linkedEnabler.name}</button>
            : <span className="task-link-static">{linkedDeal ? linkedDeal.company : linkedEnabler.name}</span>)}
        </div>
      </div>
    </div>
  );
}

function TodoSection({ todos, contacts, deals = [], enablers = [], customOptions = [], onAddCustomOption = () => {}, onAdd, onToggle, onUpdate, onNavigate }) {
  const [showForm, setShowForm] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const open = sortTodos(todos.filter(t => t.status !== "completed"));
  const completed = todos.filter(t => t.status === "completed").slice().sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

  return (
    <div className="todo-section">
      <div className="ai-summary-header">
        <div className="section-label">To-Dos</div>
        <button onClick={() => setShowForm(s => !s)} className="btn-copy">{showForm ? "Cancel" : "+ Add To-Do"}</button>
      </div>
      {showForm && (
        <TodoForm
          contacts={contacts}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onCancel={() => setShowForm(false)}
          onSave={async (form) => { await onAdd(form); setShowForm(false); }}
        />
      )}
      {open.length === 0 ? (
        <div className="empty-small">No open to-dos.</div>
      ) : (
        <div className="todo-list">
          {open.map(t => <TodoRow key={t.id} todo={t} contacts={contacts} deals={deals} enablers={enablers} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onToggle={onToggle} onUpdate={onUpdate} onNavigate={onNavigate} />)}
        </div>
      )}
      {completed.length > 0 && (
        <div className="todo-completed-toggle">
          <button onClick={() => setShowCompleted(s => !s)} className="link-btn">{showCompleted ? "▾" : "▸"} Completed ({completed.length})</button>
          {showCompleted && (
            <div className="todo-list todo-list-completed">
              {completed.map(t => <TodoRow key={t.id} todo={t} contacts={contacts} deals={deals} enablers={enablers} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onToggle={onToggle} onUpdate={onUpdate} onNavigate={onNavigate} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskQuickAdd({ deals, enablers, customOptions = [], onAddCustomOption = () => {}, onAdd }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [link, setLink] = useState("");
  const priorityOpts = optionsWithCustom(PRIORITIES, customOptions, "priority");

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const form = { title: t, priority };
    if (link.startsWith("deal:")) form.deal_id = link.slice(5);
    else if (link.startsWith("enabler:")) form.enabler_id = link.slice(8);
    onAdd(form);
    setTitle(""); setPriority("medium"); setLink("");
  };

  return (
    <div className="quickadd">
      <div className="quickadd-row">
        <input
          className="input quickadd-input"
          placeholder="New task..."
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
        />
        <SelectWithCustom className="input quickadd-type" options={priorityOpts} value={priority} onChange={(v) => { setPriority(v); trackCustom("priority", priorityOpts, onAddCustomOption)(v); }} />
        <select className="input task-link-select" value={link} onChange={e => setLink(e.target.value)}>
          <option value="">No link</option>
          {deals.length > 0 && <optgroup label="Deals">{deals.map(d => <option key={d.id} value={`deal:${d.id}`}>{d.company}</option>)}</optgroup>}
          {enablers.length > 0 && <optgroup label="Enablers">{enablers.map(en => <option key={en.id} value={`enabler:${en.id}`}>{en.name}</option>)}</optgroup>}
        </select>
        <button onClick={submit} className="btn-primary" disabled={!title.trim()}>Add</button>
      </div>
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


function AddOrgLinkModal({ title, pickLabel, entityOptions, showRole, customOptions = [], onAddCustomOption = () => {}, onSave, onClose }) {
  const [entityId, setEntityId] = useState("");
  const [relationship, setRelationship] = useState("knows");
  const [role, setRole] = useState("");
  const [strength, setStrength] = useState("medium");
  const [notes, setNotes] = useState("");
  const relOpts = optionsWithCustom(NETWORK_EDGE_RELATIONSHIPS, customOptions, "relationship_type");
  const strengthOpts = optionsWithCustom(STRENGTHS, customOptions, "strength");
  return (
    <div className="overlay" onClick={onClose}><div className="modal modal-sm" onClick={e => e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{title}</div><button onClick={onClose} className="close-btn">✕</button></div>
      {entityOptions.length === 0 ? (
        <div className="empty-small">Nothing available to link.</div>
      ) : (
        <div className="mb-sm">
          <label className="label">{pickLabel}</label>
          <select className="input" value={entityId} onChange={e => setEntityId(e.target.value)}>
            <option value="">Select...</option>
            {entityOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
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
        <button onClick={() => entityId && onSave({ entityId, relationship, role, strength, notes })} className="btn-primary" disabled={!entityId}>Add</button>
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
  institution: inst, summaryEntity, activities, contacts, deals, enablers, organizations,
  dealContacts, enablerContacts, networkEdges, contactRoles, customOptions = [], onAddCustomOption = () => {},
  onUpdate, onUpdateCity, onRename, onAutoFill, onAutoFillIfEmpty, researching, onSetFlag, onDelete, onAddActivity, onAddPersonRole, onAddPersonWithRoles, onRemoveRole, onRemoveNetworkEdge, onAddConnection,
  onResearchKeyPeople, onResearchTrials, onSaveResearch, onAddResearchedPerson, onAddResearchedPeople,
  onChangeStage, onChangeTier, todos = [], onAddTodo, onToggleTodo, onUpdateTodo, onNavigate,
  onGenerateSummary, onSaveSummary, summarizing, showToast, onOpenInstitution, onOpenPerson, onBack, backLabel = "Back to Ecosystem",
}) {
  const [filter, setFilter] = useState("all");
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

  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();
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
              {inst.isTarget && <span className="badge flag-badge-target">Target</span>}
              {inst.isEnabler && <span className="badge flag-badge-enabler">Enabler</span>}
              {inst.isTarget && onChangeTier && (
                <BadgeSelect options={DEAL_TIERS} value={inst.deal?.tier || "Untiered"} color={tier?.fg} onChange={(v) => onChangeTier(v)} title="Change tier" />
              )}
              <CityEditor city={inst.city} options={cityOpts} onAddCustomOption={onAddCustomOption} onSave={(v) => onUpdateCity(v)} />
            </div>
            <div className="classification-row">
              <label className="checkbox-label"><input type="checkbox" checked={inst.isTarget} onChange={(e) => { if (!e.target.checked && inst.dealId && !confirm("Unchecking Target removes the linked pipeline deal (its people and stage). Activity history is kept. Continue?")) return; onSetFlag("target", e.target.checked); }} /> Target</label>
              <label className="checkbox-label"><input type="checkbox" checked={inst.isEnabler} onChange={(e) => { if (!e.target.checked && inst.enablerId && !confirm("Unchecking Enabler removes the linked enabler record. Activity history is kept. Continue?")) return; onSetFlag("enabler", e.target.checked); }} /> Enabler</label>
            </div>
            <div className="sheet-contact">Sector: <InlineText value={inst.sector} onSave={(v) => onUpdate({ sector: v })} placeholder="Add sector" /></div>
            <div className="sheet-contact">Website: <InlineText value={inst.website} onSave={(v) => onUpdate({ website: v })} placeholder="Add website" /></div>
          </div>
          <div className="sheet-actions">
            <button onClick={onAutoFill} className="btn-sec" disabled={researching}>{researching ? "AI researching..." : "Auto-fill with AI"}</button>
            <button onClick={() => { if (confirm("Delete this institution and all its linked records?")) onDelete(); }} className="btn-sec btn-danger">Delete</button>
          </div>
        </div>
        {inst.isTarget && (
          <div className="sheet-next inst-stage-row">
            <span className="next-label">Pipeline stage:</span>
            <BadgeSelect options={STAGES} value={inst.stage || "prospecting"} color={stage?.color} onChange={(v) => onChangeStage(v)} dot title="Change stage" />
          </div>
        )}
      </div>

      <SummaryCard entity={summaryEntity} activities={activities} onGenerateSummary={onGenerateSummary} onSaveSummary={onSaveSummary} summarizing={summarizing} />

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Description</div>
          {researching && <span className="empty-small">AI researching...</span>}
        </div>
        <NotesEditor value={inst.description} onSave={(v) => onUpdate({ description: v })} placeholder="What does this institution do? Click Auto-fill with AI to research." />
      </div>

      <div className="people-section">
        <div className="section-label">Notes</div>
        <NotesEditor value={inst.notes} onSave={(v) => onUpdate({ notes: v })} />
      </div>

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">People at {inst.name}</div>
          <div className="header-btn-group">
            <div className="research-btn-wrap">
              <button onClick={runResearch} className="btn-primary btn-research" disabled={researchLoading}>{researchLoading ? "Researching..." : "🔍 Research Key People"}</button>
              <div className="research-credits-note">Uses AI credits</div>
            </div>
            <button onClick={() => setAddPersonOpen(v => !v)} className="btn-copy">{addPersonOpen ? "Cancel" : "+ Add Person"}</button>
          </div>
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
                    {(p.source === "role" || p.source === "edge") && (
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

      {(inst.dealId || inst.enablerId) && onAddTodo && (
        <TodoSection todos={todos} contacts={contacts} deals={deals} enablers={enablers} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onAdd={onAddTodo} onToggle={onToggleTodo} onUpdate={onUpdateTodo} onNavigate={onNavigate} />
      )}

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Connected Institutions</div>
          {inst.orgId && <button onClick={() => setConnectOpen(true)} className="btn-copy">+ Add Connection</button>}
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
                  <button onClick={() => { if (confirm("Remove this connection?")) onRemoveNetworkEdge(c.id); }} className="person-remove" title="Remove">✕</button>
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

      <QuickAdd dealId={inst.dealId} enablerId={inst.enablerId} organizationId={inst.orgId} contactId={null} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onAddActivity={onAddActivity} showToast={showToast} />

      <div className="timeline">
        <div className="section-label">Activity Timeline</div>
        <div className="timeline-tabs">
          {TIMELINE_TABS.map(tb => <button key={tb.id} onClick={() => setFilter(tb.id)} className={`tag-btn ${filter === tb.id ? "active" : ""}`}>{tb.label}</button>)}
        </div>
        <div className="timeline-list">
          {filtered.length === 0 && <div className="empty-small">No activities yet</div>}
          {filtered.map(a => (
            <div key={a.id} className="timeline-item">
              <ActivityGlyph type={a.type} />
              <div><div className="act-desc">{a.description}</div><div className="act-date">{formatDate(a.created_at)}</div></div>
            </div>
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

function InstitutionEditModal({ institution: inst, customOptions = [], onAddCustomOption = () => {}, onSave, onClose }) {
  const [f, setF] = useState({
    orgId: inst.orgId, dealId: inst.dealId, enablerId: inst.enablerId,
    name: inst.name || "", type: inst.type || "hospital", city: inst.city || "", region: inst.region || "",
    sector: inst.sector || "", description: inst.description || "", website: inst.website || "", notes: inst.notes || "",
    isTarget: !!inst.isTarget, isEnabler: !!inst.isEnabler,
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const typeOpts = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");
  const cityOpts = optionsWithCustom(CITY_OPTIONS, customOptions, "city");
  const regionOpts = optionsWithCustom(REGION_OPTIONS, customOptions, "region");
  const submit = () => {
    if (!f.name.trim()) return;
    if (!f.isTarget && inst.dealId && !confirm("Unchecking Target removes the linked pipeline deal (its people and pipeline stage). Activity history is kept. Continue?")) return;
    if (!f.isEnabler && inst.enablerId && !confirm("Unchecking Enabler removes the linked enabler record. Activity history is kept. Continue?")) return;
    onSave(f);
  };
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e => e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">Edit Institution</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={f.name} onChange={e => set("name", e.target.value)} /></div>
        <div className="field"><label className="label">Type</label><SelectWithCustom options={typeOpts} value={f.type} onChange={(v) => { set("type", v); trackCustom("institution_type", typeOpts, onAddCustomOption)(v); }} /></div>
        <div className="field"><label className="label">Sector</label><input className="input" value={f.sector} onChange={e => set("sector", e.target.value)} /></div>
        <div className="field"><label className="label">City</label><SelectWithCustom options={cityOpts} value={f.city} onChange={(v) => { set("city", v); trackCustom("city", cityOpts, onAddCustomOption)(v); }} placeholder="City name..." /></div>
        <div className="field"><label className="label">Region</label><SelectWithCustom options={regionOpts} value={f.region} onChange={(v) => { set("region", v); trackCustom("region", regionOpts, onAddCustomOption)(v); }} placeholder="Region name..." /></div>
        <div className="field-full checkbox-row">
          <label className="checkbox-label"><input type="checkbox" checked={f.isTarget} onChange={e => set("isTarget", e.target.checked)} /> Target (a sales/BD target)</label>
          <label className="checkbox-label"><input type="checkbox" checked={f.isEnabler} onChange={e => set("isEnabler", e.target.checked)} /> Enabler (can help us reach targets)</label>
        </div>
        <div className="field-full"><label className="label">Website</label><input className="input" value={f.website} onChange={e => set("website", e.target.value)} placeholder="https://..." /></div>
        <div className="field-full"><label className="label">Description</label><textarea className="input textarea" value={f.description} onChange={e => set("description", e.target.value)} /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e => set("notes", e.target.value)} /></div>
      </div>
      <div className="modal-actions">
        <button onClick={onClose} className="btn-sec">Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!f.name.trim()}>Save</button>
      </div>
    </div></div>
  );
}

function InstitutionForm({ customOptions = [], onAddCustomOption = () => {}, onSave, onCancel }) {
  const [f, setF] = useState({ name: "", type: "hospital", city: "", region: "", isTarget: false, isEnabler: false, sector: "", description: "", website: "" });
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
          <label className="checkbox-label"><input type="checkbox" checked={f.isTarget} onChange={e => set("isTarget", e.target.checked)} /> Target (a sales/BD target)</label>
          <label className="checkbox-label"><input type="checkbox" checked={f.isEnabler} onChange={e => set("isEnabler", e.target.checked)} /> Enabler (can help us reach targets)</label>
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

function PersonForm({ institutions, contacts, customOptions = [], onAddCustomOption = () => {}, onSave, onCancel }) {
  const instOptions = institutionPickerOptions(institutions, customOptions);
  const typeOpts = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");
  const warmthOpts = optionsWithCustom(WARMTH_LEVELS, customOptions, "warmth");
  const relOpts = optionsWithCustom(CONNECTION_RELATIONSHIPS, customOptions, "relationship");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [warmth, setWarmth] = useState("unknown");
  const [notes, setNotes] = useState("");
  const [roles, setRoles] = useState([{ institutionKey: "", role: "", primary: true, newName: "", newType: "hospital" }]);
  const [showConn, setShowConn] = useState(false);
  const [connectedThrough, setConnectedThrough] = useState("");
  const [canReach, setCanReach] = useState("");
  const [relationship, setRelationship] = useState("can_introduce");
  const [saving, setSaving] = useState(false);

  const updateRole = (i, patch) => setRoles(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRole = () => setRoles(prev => [...prev, { institutionKey: "", role: "", primary: false, newName: "", newType: "hospital" }]);
  const removeRole = (i) => setRoles(prev => prev.filter((_, idx) => idx !== i));
  const setPrimary = (i) => setRoles(prev => prev.map((r, idx) => ({ ...r, primary: idx === i })));

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const ordered = [...roles].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
      const payload = ordered.map(r => r.institutionKey === "__create__"
        ? { newName: r.newName, newType: r.newType, role: r.role }
        : { institutionKey: r.institutionKey, role: r.role });
      await onSave({ name, email, phone, warmth, notes, roles: payload, connectedThrough: connectedThrough || null, canReach: canReach || null, relationship });
    } finally { setSaving(false); }
  };

  return (
    <div className="quickadd-inline-form">
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={name} onChange={e => setName(e.target.value)} /></div>
      </div>

      <label className="label">Roles</label>
      {roles.map((r, i) => (
        <div key={i}>
          <div className="quickadd-inline-row">
            <select className="input" value={r.institutionKey} onChange={e => updateRole(i, { institutionKey: e.target.value })}>
              <option value="">Select institution...</option>
              {instOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              <option value="__create__">+ Create new institution</option>
            </select>
            <input className="input" placeholder="Role title" value={r.role} onChange={e => updateRole(i, { role: e.target.value })} />
            <label className="checkbox-label primary-check"><input type="checkbox" checked={r.primary} onChange={() => setPrimary(i)} /> Primary</label>
            {roles.length > 1 && <button onClick={() => removeRole(i)} className="person-remove" title="Remove role">✕</button>}
          </div>
          {r.institutionKey === "__create__" && (
            <div className="quickadd-inline-row inline-create">
              <input className="input" placeholder="New institution name" value={r.newName} onChange={e => updateRole(i, { newName: e.target.value })} />
              <SelectWithCustom options={typeOpts} value={r.newType} onChange={(v) => { updateRole(i, { newType: v }); trackCustom("institution_type", typeOpts, onAddCustomOption)(v); }} />
            </div>
          )}
        </div>
      ))}
      <button type="button" onClick={addRole} className="link-btn">+ Add another role</button>

      <div className="conn-toggle-wrap">
        <button type="button" onClick={() => setShowConn(s => !s)} className="link-btn">{showConn ? "Hide" : "How are they connected to us?"}</button>
      </div>
      {showConn && (
        <div className="form-grid">
          <div className="field"><label className="label">Connected through</label>
            <select className="input" value={connectedThrough} onChange={e => setConnectedThrough(e.target.value)}>
              <option value="">No one specific</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field"><label className="label">Can help us reach</label>
            <select className="input" value={canReach} onChange={e => setCanReach(e.target.value)}>
              <option value="">Nothing specific</option>
              {instOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div className="field-full"><label className="label">Relationship</label><SelectWithCustom options={relOpts} value={relationship} onChange={(v) => { setRelationship(v); trackCustom("relationship", relOpts, onAddCustomOption)(v); }} /></div>
        </div>
      )}

      <div className="form-grid">
        <div className="field"><label className="label">Email</label><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label className="label">Phone</label><input className="input" value={phone} onChange={e => setPhone(e.target.value)} /></div>
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
  customOptions, onAddCustomOption, onAddInstitution, onAddPersonWithRoles, onUpdateInstitution, onUpdateInstitutionCity, onUpdateContact, onLinkPersonToInstitution, onOpenInstitution, onOpenPerson,
}) {
  const [subtab, setSubtab] = useState("institutions");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [targetsOnly, setTargetsOnly] = useState(false);
  const [enablersOnly, setEnablersOnly] = useState(false);
  const [warmthFilter, setWarmthFilter] = useState("");
  const [instFilter, setInstFilter] = useState("");
  const [activeForm, setActiveForm] = useState(null);
  const [peopleView, setPeopleView] = useState("table");

  const cities = Array.from(new Set(institutions.flatMap(i => parseCities(i.city)))).sort();
  const types = Array.from(new Set(institutions.map(i => i.type).filter(Boolean)));
  const orderedTypes = [
    ...INSTITUTION_TYPES.map(t => t.id).filter(id => types.includes(id)),
    ...types.filter(id => !INSTITUTION_TYPES.some(t => t.id === id)).sort(),
  ];

  const q = search.trim().toLowerCase();
  const filteredInst = institutions.filter(i =>
    (!typeFilter || i.type === typeFilter) &&
    (!cityFilter || parseCities(i.city).includes(cityFilter)) &&
    (!targetsOnly || i.isTarget) &&
    (!enablersOnly || i.isEnabler) &&
    (!q || i.name.toLowerCase().includes(q)));

  // People sub-tab data: every contact with their resolved roles.
  const peopleData = contacts.map(c => {
    const roles = resolveContactRoles(c, { deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles });
    const roleStr = roles.map(r => `${r.role_title ? `${r.role_title} at ` : ""}${r.institutionName}`).join(", ");
    const connCount = roles.length + networkEdges.filter(ne => (ne.source_type === "contact" && ne.source_id === c.id) || (ne.target_type === "contact" && ne.target_id === c.id)).length;
    const personCities = Array.from(new Set(roles.flatMap(r => parseCities(r.institution.city))));
    return { contact: c, roles, roleStr, connCount, cities: personCities };
  });
  const filteredPeople = peopleData.filter(p =>
    (!q || p.contact.name.toLowerCase().includes(q) || p.roleStr.toLowerCase().includes(q)) &&
    (!warmthFilter || (p.contact.warmth || "unknown") === warmthFilter) &&
    (!cityFilter || p.cities.includes(cityFilter)) &&
    (!instFilter || p.roles.some(r => r.institutionName === instFilter)));
  const instNames = Array.from(new Set(institutions.map(i => i.name))).sort();
  const typeOptsAll = optionsWithCustom(INSTITUTION_TYPES, customOptions, "institution_type");
  const cityOptsAll = optionsWithCustom(CITY_OPTIONS, customOptions, "city");

  return (
    <div className="network-directory">
      <div className="network-top-bar">
        <input className="input network-search" placeholder={`Search ${subtab}...`} value={search} onChange={e => setSearch(e.target.value)} />
        <div className="network-top-buttons">
          <button onClick={() => setActiveForm(a => (a === "institution" ? null : "institution"))} className={`btn-primary ${activeForm === "institution" ? "active-toggle" : ""}`}>+ Institution</button>
          <button onClick={() => setActiveForm(a => (a === "person" ? null : "person"))} className={`btn-primary ${activeForm === "person" ? "active-toggle" : ""}`}>+ Person</button>
        </div>
      </div>

      {activeForm === "institution" && (
        <InstitutionForm customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCancel={() => setActiveForm(null)} onSave={async (f) => { await onAddInstitution(f); setActiveForm(null); }} />
      )}
      {activeForm === "person" && (
        <PersonForm institutions={institutions} contacts={contacts} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onCancel={() => setActiveForm(null)} onSave={async (f) => { await onAddPersonWithRoles(f); setActiveForm(null); }} />
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
          </div>
          {filteredInst.length === 0 ? (
            <div className="empty-state">No institutions match.</div>
          ) : (
            orderedTypes.map(typeId => {
              const group = filteredInst.filter(i => i.type === typeId);
              if (group.length === 0) return null;
              const meta = institutionTypeMeta(typeId, customOptions);
              const plural = INSTITUTION_TYPE_PLURALS[typeId] || (meta.label.endsWith("s") ? meta.label : `${meta.label}s`);
              return (
                <div key={typeId || "other"} className="institution-group">
                  <div className="institution-group-header">{plural.toUpperCase()} ({group.length})</div>
                  <div className="institution-grid">
                    {group.map(inst => {
                      const ppl = institutionPeople(inst, { contactRoles, dealContacts, enablerContacts, networkEdges, contacts });
                      const preview = ppl.slice(0, 3);
                      const stage = inst.isTarget ? STAGES.find(s => s.id === inst.stage) : null;
                      return (
                        <div key={inst.key} className="institution-card" onClick={() => onOpenInstitution(inst.name)}>
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
              );
            })
          )}
        </>
      ) : (
        <>
          <div className="network-filter-row">
            <div className="view-toggle">
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
          ) : peopleView === "table" ? (
            <PeopleTable
              people={filteredPeople}
              institutionNames={instNames}
              cities={cities}
              customOptions={customOptions}
              onAddCustomOption={onAddCustomOption}
              onUpdateContact={onUpdateContact}
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
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  const commit = () => { if ((v || "") !== (value || "")) onSave(v); };
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
function PeopleTable({ people, institutionNames, cities, onUpdateContact, onLinkPersonToInstitution, onOpenPerson }) {
  const [sort, setSort] = useState({ col: "institution", dir: "asc" });
  const cellRefs = useRef({});
  const cityList = Array.from(new Set([...SAUDI_CITIES, ...cities])).sort();
  const cols = [["name", "Name"], ["role", "Role"], ["institution", "Institution"], ["city", "City"], ["email", "Email"], ["phone", "Phone"], ["linkedin", "LinkedIn"], ["warmth", "Warmth"], ["last", "Last Contacted"]];

  const rows = people.map((p) => {
    const primary = p.roles.find((r) => r.is_primary) || p.roles[0];
    return { contact: p.contact, institution: primary ? primary.institutionName : "", roleTitle: p.contact.role || (primary ? primary.role_title : "") || "", extraRoles: Math.max(0, p.roles.length - 1) };
  });
  const val = (r, col) => {
    if (col === "name") return r.contact.name || "";
    if (col === "role") return r.roleTitle || "";
    if (col === "institution") return r.institution || "";
    if (col === "city") return r.contact.city || "";
    if (col === "email") return r.contact.email || "";
    if (col === "phone") return r.contact.phone || "";
    if (col === "warmth") return r.contact.warmth || "";
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
                <td>{text(c, "name", idx, "Name")}</td>
                <td className="table-role-cell">{text({ ...c, role: r.roleTitle }, "role", idx, "Role")}{r.extraRoles > 0 && <span className="table-more-roles" title="Has more roles">+{r.extraRoles}</span>}</td>
                <td>
                  <select className="table-cell-select" value={r.institution} ref={(el) => { cellRefs.current[`${idx}:institution`] = el; }}
                    onChange={(e) => e.target.value && onLinkPersonToInstitution(c.id, e.target.value)} onKeyDown={(e) => selKey(e, "institution", idx)}>
                    <option value="">Set institution...</option>
                    {institutionNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </td>
                <td>
                  <select className="table-cell-select" value={c.city || ""} ref={(el) => { cellRefs.current[`${idx}:city`] = el; }}
                    onChange={(e) => onUpdateContact(c.id, { city: e.target.value || null })} onKeyDown={(e) => selKey(e, "city", idx)}>
                    <option value="">City...</option>
                    {cityList.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </td>
                <td>{text(c, "email", idx, "Add email")}</td>
                <td>{text(c, "phone", idx, "Add phone")}</td>
                <td className="table-linkedin">{text(c, "linkedin", idx, "Add LinkedIn")}</td>
                <td>
                  <select className="table-cell-select table-warmth" value={c.warmth || "unknown"} ref={(el) => { cellRefs.current[`${idx}:warmth`] = el; }}
                    onChange={(e) => onUpdateContact(c.id, { warmth: e.target.value })} onKeyDown={(e) => selKey(e, "warmth", idx)} style={{ color: warmth?.color, fontWeight: 700 }}>
                    {WARMTH_LEVELS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                  </select>
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
// Boss View: a standalone, mostly read-only dashboard for the boss (Andy).
// Overview | Pipeline | Key Summaries | Comments. Shareable via ?view=boss.
// ============================================================
const BOSS_TABS = [["overview", "Overview"], ["pipeline", "Pipeline"], ["summaries", "Key Summaries"], ["comments", "Comments"]];

function BossView({ deals, activeDeals, enablers, institutions, instByName, todos, activities, customOptions = [], comments = [], onPostComment, standalone = false }) {
  const [tab, setTab] = useState("overview");
  const [readDeal, setReadDeal] = useState(null);
  const totalValue = activeDeals.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const openTasks = todos.filter((t) => t.status === "open");
  const overdueCount = openTasks.filter((t) => isOverdue(t.due_date)).length;
  const valueText = totalValue >= 1000000 ? `$${(totalValue / 1000000).toFixed(1)}M` : totalValue > 0 ? `$${(totalValue / 1000).toFixed(0)}K` : "N/A";
  const dealCity = (d) => { const i = instByName.get((d.company || "").trim().toLowerCase()); return parseCities(d.city || i?.city || ""); };

  return (
    <div className={`boss-view ${standalone ? "boss-standalone" : ""}`}>
      <div className="boss-topbar">
        <div className="boss-brand"><span className="sidebar-logo">🥭</span><span className="sidebar-wordmark">Mango OS</span><span className="boss-badge">Boss View</span></div>
        <div className="boss-nav">
          {BOSS_TABS.map(([id, l]) => <button key={id} className={`boss-nav-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{l}</button>)}
        </div>
      </div>

      <div className="boss-body">
        {tab === "overview" && (
          <>
            <div className="stats-bar boss-stats">
              <div className="stat"><div className="stat-label">Active deals</div><div className="stat-value">{activeDeals.length}</div></div>
              <div className="stat"><div className="stat-label">Pipeline value</div><div className="stat-value">{valueText}</div></div>
              <div className="stat"><div className="stat-label">Tasks due</div><div className="stat-value">{openTasks.length}</div>{overdueCount > 0 && <div className="stat-delta">{overdueCount} overdue</div>}</div>
              <div className="stat">
                <div className="stat-label">Deals by tier</div>
                <div className="boss-tier-mini">{DEAL_TIERS.filter((t) => t.id !== "Untiered").map((t) => <span key={t.id} className="tier-badge" style={{ background: t.bg, color: t.fg }}>{t.label}: {activeDeals.filter((d) => (d.tier || "Untiered") === t.id).length}</span>)}</div>
              </div>
            </div>
            <div className="boss-section">
              <div className="section-label">Pipeline health</div>
              <div className="pipeline-bar">
                {STAGES.filter((s) => !["won", "lost"].includes(s.id)).map((s) => { const c = activeDeals.filter((d) => d.stage === s.id).length; if (!c) return null; return <div key={s.id} className="bar-seg" style={{ background: s.color, flex: c }}><span className="bar-label">{s.label} ({c})</span></div>; })}
                {activeDeals.length === 0 && <div className="bar-seg bar-empty">No active deals</div>}
              </div>
            </div>
            <div className="boss-section">
              <div className="section-label">This week</div>
              <div className="boss-activity"><div className="boss-act-row">
                {[[deals.filter((d) => isThisWeek(d.last_activity_at)).length, "deals touched"], [activities.filter((a) => isThisWeek(a.created_at)).length, "activities"], [deals.filter((d) => isThisWeek(d.created_at)).length, "new deals"]].map(([n, l], i) => (
                  <div key={i}><span className="boss-num">{n}</span> <span className="boss-num-label">{l}</span></div>
                ))}
              </div></div>
            </div>
          </>
        )}

        {tab === "pipeline" && (
          <div className="boss-kanban kanban">
            {STAGES.map((stage) => {
              const sd = activeDeals.filter((d) => d.stage === stage.id);
              return (
                <div key={stage.id} className="column">
                  <div className="col-header"><div className="col-title-wrap"><div className="dot" style={{ background: stage.color }} /><span className="col-title">{stage.label}</span></div><span className="col-count">{sd.length}</span></div>
                  <div className="col-body">
                    {DEAL_TIERS.map((tier) => {
                      const td = sd.filter((d) => (d.tier || "Untiered") === tier.id);
                      if (td.length === 0) return null;
                      return (
                        <div key={tier.id} className="tier-group">
                          <div className="tier-group-header">{tier.label}</div>
                          {td.map((deal) => {
                            const inst = instByName.get((deal.company || "").trim().toLowerCase());
                            const typeMeta = inst?.type ? institutionTypeMeta(inst.type, customOptions) : null;
                            const t = DEAL_TIERS.find((x) => x.id === (deal.tier || "Untiered"));
                            return (
                              <div key={deal.id} className="deal-card" onClick={() => setReadDeal(deal)}>
                                <div className="deal-card-head"><div className="card-company">{deal.company}</div>{t && t.id !== "Untiered" && <span className="tier-badge" style={{ background: t.bg, color: t.fg }}>{t.label}</span>}</div>
                                {typeMeta && <span className="badge card-type-badge" style={{ background: typeMeta.color + "22", color: typeMeta.color, border: `1px solid ${typeMeta.color}44` }}>{typeMeta.label}</span>}
                                <div className="card-city-row"><CityPills city={deal.city || inst?.city} compact />{deal.value > 0 && <span className="card-value">${Number(deal.value).toLocaleString()}</span>}</div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    {sd.length === 0 && <div className="empty-col">No deals</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "summaries" && (
          <div className="section-pad">
            <div className="section-label">Key Summaries</div>
            {[...institutions.filter((i) => i.isTarget && i.deal?.ai_summary).map((i) => ({ id: i.key, name: i.name, kind: "Target", summary: i.deal.ai_summary })),
              ...institutions.filter((i) => i.isEnabler && i.enabler?.ai_summary).map((i) => ({ id: i.key + "-en", name: i.name, kind: "Enabler", summary: i.enabler.ai_summary })),
              ...institutions.filter((i) => !i.isTarget && !i.isEnabler && i.org?.ai_summary).map((i) => ({ id: i.key + "-org", name: i.name, kind: "Institution", summary: i.org.ai_summary }))]
              .map((item) => <BossSummaryCard key={item.id} item={item} />)}
            {institutions.every((i) => !i.deal?.ai_summary && !i.enabler?.ai_summary && !i.org?.ai_summary) && <div className="empty-small">No summaries yet.</div>}

            <div className="section-label boss-section-label">Top Action Items</div>
            <div className="action-items">
              {sortTodos(openTasks).slice(0, 10).map((t) => {
                const linkedDeal = t.deal_id ? deals.find((d) => d.id === t.deal_id) : null;
                const linkedEnabler = t.enabler_id ? enablers.find((en) => en.id === t.enabler_id) : null;
                return (
                  <div key={t.id} className="action-item-row">
                    <PriorityBadge priority={t.priority} />
                    <span className="action-item-title">{t.title}</span>
                    {(linkedDeal || linkedEnabler) && <span className="action-item-link">{linkedDeal ? linkedDeal.company : linkedEnabler.name}</span>}
                    {t.due_date && <span className="todo-due">Due {formatDate(t.due_date)}</span>}
                  </div>
                );
              })}
              {openTasks.length === 0 && <div className="empty-small">No open action items.</div>}
            </div>
          </div>
        )}

        {tab === "comments" && <BossComments comments={comments} onPost={onPostComment} />}
      </div>

      {readDeal && (() => {
        const inst = instByName.get((readDeal.company || "").trim().toLowerCase());
        const st = STAGES.find((s) => s.id === readDeal.stage);
        const t = DEAL_TIERS.find((x) => x.id === (readDeal.tier || "Untiered"));
        const acts = activities.filter((a) => a.deal_id === readDeal.id).slice(0, 6);
        return (
          <div className="overlay" onClick={() => setReadDeal(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">{readDeal.company}</div><button onClick={() => setReadDeal(null)} className="close-btn">✕</button></div>
            <div className="sheet-meta-row">
              {st && <span className="badge" style={{ background: st.color + "22", color: st.color, border: `1px solid ${st.color}44` }}>{st.label}</span>}
              {t && t.id !== "Untiered" && <span className="tier-badge" style={{ background: t.bg, color: t.fg }}>{t.label}</span>}
              <CityPills city={readDeal.city || inst?.city} />
              {readDeal.value > 0 && <span className="badge val-badge">${Number(readDeal.value).toLocaleString()}</span>}
            </div>
            {readDeal.contact_name && <div className="sheet-contact" style={{ marginTop: 8 }}>{readDeal.contact_name}{readDeal.contact_role ? ` · ${readDeal.contact_role}` : ""}</div>}
            {readDeal.ai_summary && <><div className="section-label" style={{ marginTop: 16 }}>AI Summary</div><div className="key-summary-text">{readDeal.ai_summary}</div></>}
            <div className="section-label" style={{ marginTop: 16 }}>Recent activity</div>
            {acts.length === 0 ? <div className="empty-small">No activity logged.</div> : (
              <div className="timeline-list">{acts.map((a) => <div key={a.id} className="timeline-item"><ActivityGlyph type={a.type} /><div><div className="act-desc">{a.description}</div><div className="act-date">{formatDate(a.created_at)}</div></div></div>)}</div>
            )}
          </div></div>
        );
      })()}
    </div>
  );
}

function BossSummaryCard({ item }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="key-summary-card">
      <div className="key-summary-header boss-summary-head" onClick={() => setOpen((o) => !o)}>
        <span>{item.name} <span className="boss-summary-kind">{item.kind}</span></span>
        <span className="ai-summary-chevron">{open ? "▾" : "▸"}</span>
      </div>
      <div className={`key-summary-text ${open ? "" : "ai-summary-collapsed"}`}>{item.summary}</div>
    </div>
  );
}

function BossComments({ comments, onPost }) {
  const [author, setAuthor] = useState("Fahed Al Essa");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [posting, setPosting] = useState(false);
  const fileRef = useRef(null);
  const pickFile = (e) => { const f = e.target.files?.[0]; if (!f) return; const reader = new FileReader(); reader.onload = () => setFile({ name: f.name, data: reader.result }); reader.readAsDataURL(f); };
  const send = async () => {
    if ((!text.trim() && !file) || posting) return;
    setPosting(true);
    try { await onPost({ author, content: text, file_name: file?.name, file_data: file?.data }); setText(""); setFile(null); if (fileRef.current) fileRef.current.value = ""; } finally { setPosting(false); }
  };
  const sorted = [...comments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return (
    <div className="section-pad boss-comments">
      <div className="boss-comment-box">
        <div className="boss-comment-as">
          <span className="boss-as-label">Post as</span>
          {["Fahed Al Essa", "Andy Liu"].map((a) => <button key={a} className={`boss-as-btn ${author === a ? "active" : ""}`} onClick={() => setAuthor(a)}>{a}</button>)}
        </div>
        <textarea className="input textarea boss-comment-input" placeholder="Write a comment..." value={text} onChange={(e) => setText(e.target.value)} />
        {file && <div className="boss-file-chip">📎 {file.name}<button onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }} className="city-pill-x">✕</button></div>}
        <div className="boss-comment-actions">
          <button className="boss-clip-btn" onClick={() => fileRef.current && fileRef.current.click()} title="Attach file">📎</button>
          <input ref={fileRef} type="file" className="photo-input-hidden" onChange={pickFile} />
          <button className="btn-primary" onClick={send} disabled={posting || (!text.trim() && !file)}>Send</button>
        </div>
      </div>
      <div className="boss-comment-feed">
        {sorted.length === 0 && <div className="empty-small">No comments yet. Start the conversation.</div>}
        {sorted.map((c) => (
          <div key={c.id} className="boss-comment">
            <Avatar name={c.author} size={34} />
            <div className="boss-comment-main">
              <div className="boss-comment-meta"><span className="boss-comment-author">{c.author}</span><span className="boss-comment-time">{formatDateTime(c.created_at)}</span></div>
              {c.content && <div className="boss-comment-text">{c.content}</div>}
              {c.file_data && (String(c.file_data).startsWith("data:image")
                ? <img className="boss-comment-img" src={c.file_data} alt={c.file_name || "attachment"} />
                : <a className="boss-comment-file" href={c.file_data} download={c.file_name || "file"}>📎 {c.file_name || "Download attachment"}</a>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


