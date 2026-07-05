import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./supabase";
import { generateSummary, summarizeImage } from "./anthropic";
import { STAGES, ACT_TYPES, TAG_OPTIONS, ENABLER_TYPES, PRIORITIES, ORG_TYPES, INSTITUTION_TYPES, DEAL_ENABLER_RELATIONSHIPS, NETWORK_EDGE_RELATIONSHIPS, STRENGTHS, WARMTH_LEVELS, SAUDI_CITIES, REGIONS } from "./constants";
import { formatDate, formatDateTime, formatFull, daysAgo, isToday, isThisWeek, isOverdue } from "./utils";
import "./styles.css";

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
  const [contactSearch, setContactSearch] = useState("");
  const [contactTagFilter, setContactTagFilter] = useState("");
  const [enablerSearch, setEnablerSearch] = useState("");
  const [enablerTypeFilter, setEnablerTypeFilter] = useState("");
  const [toast, setToast] = useState(null);
  const [dealSheetId, setDealSheetId] = useState(null);
  const [enablerSheetId, setEnablerSheetId] = useState(null);
  const [contactSheetId, setContactSheetId] = useState(null);
  const [organizationSheetId, setOrganizationSheetId] = useState(null);
  const [customOptions, setCustomOptions] = useState([]);
  const [contactRoles, setContactRoles] = useState([]);
  const [summarizing, setSummarizing] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("mango-theme") || "dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  useEffect(() => {
    localStorage.setItem("mango-theme", theme);
    // body sits outside .app, so it needs its own theme class: otherwise its
    // inherited `color` falls back to the bare :root/media-query value instead
    // of the explicit dark/light override, and anything inheriting straight
    // from body (rather than an element with its own color rule) picks up
    // the wrong theme.
    document.body.classList.remove("dark-mode", "light-mode");
    document.body.classList.add(theme === "light" ? "light-mode" : "dark-mode");
  }, [theme]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e) => { if (settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  const loadData = useCallback(async () => {
    try {
      const [d, c, a, en, dc, ec, td, orgs, de, ne, co, cr] = await Promise.all([
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
      ]);
      setDeals(d || []); setContacts(c || []); setActivities(a || []); setEnablers(en || []);
      setDealContacts(dc || []); setEnablerContacts(ec || []); setTodos(td || []);
      setOrganizations(orgs || []); setDealEnablers(de || []); setNetworkEdges(ne || []);
      setCustomOptions(co || []); setContactRoles(cr || []);
    } catch (e) { showToast("Failed to load data"); }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Kick back to pipeline if the open deal sheet's deal was deleted elsewhere
  useEffect(() => {
    if (view === "deal-sheet" && dealSheetId && deals.length > 0 && !deals.find((d) => d.id === dealSheetId)) {
      setView("pipeline"); setDealSheetId(null);
    }
  }, [deals, view, dealSheetId]);

  // Kick back to the enablers list if the open enabler sheet's enabler was deleted elsewhere
  useEffect(() => {
    if (view === "enabler-sheet" && enablerSheetId && enablers.length > 0 && !enablers.find((en) => en.id === enablerSheetId)) {
      setView("enablers"); setEnablerSheetId(null);
    }
  }, [enablers, view, enablerSheetId]);

  // Kick back to the contacts list if the open contact sheet's contact was deleted elsewhere
  useEffect(() => {
    if (view === "contact-sheet" && contactSheetId && contacts.length > 0 && !contacts.find((c) => c.id === contactSheetId)) {
      setView("contacts"); setContactSheetId(null);
    }
  }, [contacts, view, contactSheetId]);

  // Kick back to the network directory if the open organization sheet's organization was deleted elsewhere
  useEffect(() => {
    if (view === "organization-sheet" && organizationSheetId && organizations.length > 0 && !organizations.find((o) => o.id === organizationSheetId)) {
      setView("network"); setOrganizationSheetId(null);
    }
  }, [organizations, view, organizationSheetId]);

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

  const deleteDeal = async (id) => {
    try {
      await api("activities", "DELETE", null, `?deal_id=eq.${id}`);
      await api("deal_contacts", "DELETE", null, `?deal_id=eq.${id}`);
      await api("contact_roles", "DELETE", null, `?entity_type=eq.deal&entity_id=eq.${id}`);
      await api("todos", "DELETE", null, `?deal_id=eq.${id}`);
      await api("deals", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Deal deleted");
      setView("pipeline"); setDealSheetId(null);
    } catch { showToast("Error deleting deal"); }
  };

  const moveDeal = async (dealId, newStage) => {
    try {
      await api("deals", "PATCH", { stage: newStage, last_activity_at: new Date().toISOString() }, `?id=eq.${dealId}`);
      await api("activities", "POST", { deal_id: dealId, type: "note", description: `Moved to ${STAGES.find((s) => s.id === newStage)?.label}` });
      await loadData();
    } catch { showToast("Error moving deal"); }
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
      await api("contacts", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Contact deleted");
      setView("contacts"); setContactSheetId(null);
    } catch { showToast("Error deleting contact"); }
  };

  // ENABLER CRUD
  const saveEnabler = async (form) => {
    try {
      const name = (form.name || "").trim();
      if (!name) { showToast("Name is required"); return; }
      const clean = {
        name,
        type: form.type || "vc",
        last_activity_at: new Date().toISOString(),
      };
      // Only send optional string fields when they have real content
      for (const k of ["contact_id", "contact_name", "notes", "city", "region"]) {
        const v = (form[k] || "").trim();
        if (v) clean[k] = v;
      }
      if (form.id) {
        await api("enablers", "PATCH", clean, `?id=eq.${form.id}`);
      } else {
        await api("enablers", "POST", clean);
      }
      await loadData(); setModal(null); showToast(form.id ? "Enabler updated" : "Enabler added");
    } catch { showToast("Error saving enabler"); }
  };

  const deleteEnabler = async (id) => {
    try {
      await api("activities", "DELETE", null, `?enabler_id=eq.${id}`);
      await api("enabler_contacts", "DELETE", null, `?enabler_id=eq.${id}`);
      await api("contact_roles", "DELETE", null, `?entity_type=eq.enabler&entity_id=eq.${id}`);
      await api("todos", "DELETE", null, `?enabler_id=eq.${id}`);
      await api("enablers", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Enabler deleted");
      setView("enablers"); setEnablerSheetId(null);
    } catch { showToast("Error deleting enabler"); }
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

  const removeEnablerContact = async (id) => {
    try {
      const row = enablerContacts.find((ec) => ec.id === id);
      await api("enabler_contacts", "DELETE", null, `?id=eq.${id}`);
      if (row) await api("contact_roles", "DELETE", null, `?contact_id=eq.${row.contact_id}&entity_type=eq.enabler&entity_id=eq.${row.enabler_id}`).catch(() => {});
      await loadData(); showToast("Person removed");
    } catch { showToast("Error removing person"); }
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

  // Creates a contact plus one or more contact_roles in one go, for the
  // Network tab's "+ Person" form (a primary role plus any "Add another role" rows).
  const addPersonWithRoles = async ({ name, email, phone, warmth, roles }) => {
    try {
      const created = await persistContact({ name, email, phone, warmth });
      if (!created) throw new Error("Could not create contact");
      const validRoles = (roles || []).filter((r) => r.institutionKey);
      for (let i = 0; i < validRoles.length; i++) {
        const r = validRoles[i];
        const idx = r.institutionKey.indexOf(":");
        const entityType = r.institutionKey.slice(0, idx);
        const entityId = r.institutionKey.slice(idx + 1);
        await persistPersonRole({ contactId: created.id, entityType, entityId, roleTitle: r.role, isPrimary: i === 0 });
      }
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person"); }
  };

  // ORGANIZATIONS
  const persistOrganization = async (form) => {
    const name = (form.name || "").trim();
    if (!name) throw new Error("Name is required");
    const clean = { name, type: form.type || "competitor", country: (form.country || "").trim() || "Saudi Arabia" };
    for (const k of ["sector", "description", "website", "notes", "city", "region", "address"]) {
      const v = (form[k] || "").trim();
      if (v) clean[k] = v;
    }
    if (form.id) {
      await api("organizations", "PATCH", clean, `?id=eq.${form.id}`);
    } else {
      await api("organizations", "POST", clean);
    }
  };

  const saveOrganization = async (form) => {
    try {
      await persistOrganization(form);
      await loadData(); setModal(null); showToast(form.id ? "Organization updated" : "Organization added");
    } catch { showToast("Error saving organization"); }
  };

  // Network tab's "+ Institution" form: everything is an institution, but
  // Target/Enabler types route to the deals/enablers tables (so the Pipeline
  // and Enablers tabs stay in sync) and every other type routes to organizations.
  const addInstitution = async (form) => {
    const name = (form.name || "").trim();
    if (!name) { showToast("Name is required"); return; }
    const type = form.type || "competitor";
    const extraNotes = [form.sector, form.description].filter((v) => (v || "").trim()).join(". ");
    try {
      if (type === "target") {
        const clean = { company: name, stage: "prospecting", last_activity_at: new Date().toISOString() };
        if (form.city) clean.city = form.city;
        if (form.region) clean.region = form.region;
        if (extraNotes) clean.notes = extraNotes;
        await api("deals", "POST", clean);
      } else if (type === "enabler") {
        const clean = { name, type: "strategic_partner", last_activity_at: new Date().toISOString() };
        if (form.city) clean.city = form.city;
        if (form.region) clean.region = form.region;
        if (extraNotes) clean.notes = extraNotes;
        await api("enablers", "POST", clean);
      } else {
        await persistOrganization({ name, type, city: form.city, region: form.region, sector: form.sector, description: form.description, website: form.website });
      }
      await loadData(); showToast("Institution added. Click to add people.");
    } catch { showToast("Error adding institution"); }
  };

  const deleteOrganization = async (id) => {
    try {
      await api("activities", "DELETE", null, `?organization_id=eq.${id}`);
      await api("network_edges", "DELETE", null, `?source_type=eq.organization&source_id=eq.${id}`);
      await api("network_edges", "DELETE", null, `?target_type=eq.organization&target_id=eq.${id}`);
      await api("contact_roles", "DELETE", null, `?entity_type=eq.organization&entity_id=eq.${id}`);
      await api("organizations", "DELETE", null, `?id=eq.${id}`);
      await loadData(); showToast("Organization deleted");
      setView("network"); setOrganizationSheetId(null);
    } catch { showToast("Error deleting organization"); }
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

  const removeDealEnabler = async (id) => {
    try {
      await api("deal_enablers", "DELETE", null, `?id=eq.${id}`);
      await loadData(); showToast("Connection removed");
    } catch { showToast("Error removing connection"); }
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

  const openTaskLink = (link) => {
    if (link.type === "deal") { setDealSheetId(link.id); setView("deal-sheet"); }
    else if (link.type === "enabler") { setEnablerSheetId(link.id); setView("enabler-sheet"); }
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
  const filteredContacts = contacts.filter((c) => {
    const ms = !contactSearch || [c.name, c.company, c.email].some((f) => f?.toLowerCase().includes(contactSearch.toLowerCase()));
    const mt = !contactTagFilter || (c.tags || []).includes(contactTagFilter);
    return ms && mt;
  });
  const filteredEnablers = enablers.filter((en) => {
    const ms = !enablerSearch || [en.name, en.contact_name].some((f) => f?.toLowerCase().includes(enablerSearch.toLowerCase()));
    const mt = !enablerTypeFilter || en.type === enablerTypeFilter;
    return ms && mt;
  });
  const openTodos = sortTodos(todos.filter((t) => t.status === "open"));
  const filteredTasks = openTodos.filter((t) => {
    if (taskFilter === "high") return t.priority === "high";
    if (taskFilter === "due_today") return t.due_date && isToday(t.due_date);
    if (taskFilter === "overdue") return isOverdue(t.due_date);
    return true;
  });
  // Activities are already loaded ordered by created_at desc, so the first
  // match is the most recent auto-synced (email/meeting) activity.
  const lastSyncedActivity = activities.find((a) => a.type === "email" || a.type === "meeting");

  if (loading) return <div className="app loading-screen"><div className="loading-text">Loading Mango OS...</div></div>;

  return (
    <div className={`app ${theme === "light" ? "light-mode" : "dark-mode"}`}>
      {toast && <div className="toast">{toast}</div>}

      <header className="header">
        <div className="header-left">
          <span className="logo">🥭</span>
          <div><div className="title">Mango OS</div><div className="subtitle">Pipeline Command Center</div></div>
        </div>
        <div className="header-right">
          <nav className="nav">
            {[["pipeline","Pipeline"],["contacts","Contacts"],["enablers","Enablers"],["network","Network"],["tasks","Tasks"],["reports","Reports"],["boss","Boss View"]].map(([k,l]) => (
              <button key={k} onClick={() => setView(k)} className={`nav-tab ${view === k ? "active" : ""}`}>{l}</button>
            ))}
          </nav>
          <div className="last-synced" title="Most recent auto-logged email or meeting activity">
            <span className="last-synced-dot" />
            Last synced: {lastSyncedActivity ? formatDateTime(lastSyncedActivity.created_at) : "Never"}
          </div>
          <div className="settings-wrap" ref={settingsRef}>
            <button onClick={() => setSettingsOpen((s) => !s)} className="settings-btn" title="Settings">⚙️</button>
            {settingsOpen && (
              <div className="settings-dropdown">
                <div className="settings-dropdown-label">Theme</div>
                <button onClick={() => { setTheme("dark"); setSettingsOpen(false); }} className={`settings-option ${theme === "dark" ? "active" : ""}`}>🌙 Dark Mode</button>
                <button onClick={() => { setTheme("light"); setSettingsOpen(false); }} className={`settings-option ${theme === "light" ? "active" : ""}`}>☀️ Light Mode</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {view !== "deal-sheet" && view !== "enabler-sheet" && view !== "contact-sheet" && (
        <div className="stats-bar">
          {[[activeDeals.length,"Active Deals"],[totalValue > 0 ? `$${(totalValue/1000).toFixed(0)}K` : "N/A","Pipeline Value"],[contacts.length,"Contacts"],[enablers.length,"Enablers"],[openTodos.length,"Open Tasks"],[deals.filter(d=>isToday(d.last_activity_at)).length,"Touched Today"],[deals.filter(d=>d.stage==="won").length,"Won"]].map(([v,l],i) => (
            <div key={i} className="stat"><div className="stat-value">{v}</div><div className="stat-label">{l}</div></div>
          ))}
        </div>
      )}

      {/* DEAL SHEET */}
      {view === "deal-sheet" && dealSheetId && (() => {
        const sheetDeal = deals.find((d) => d.id === dealSheetId);
        return sheetDeal ? (
          <DealSheet
            deal={sheetDeal}
            activities={activities.filter((a) => a.deal_id === sheetDeal.id)}
            people={dealContacts.filter((dc) => dc.deal_id === sheetDeal.id)}
            todos={todos.filter((t) => t.deal_id === sheetDeal.id)}
            contacts={contacts}
            deals={deals}
            enablers={enablers}
            organizations={organizations}
            networkEdges={networkEdges}
            contactRoles={contactRoles}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            dealEnablers={dealEnablers.filter((de) => de.deal_id === sheetDeal.id)}
            onEdit={(d) => setModal({ type: "deal", data: d })}
            onDelete={deleteDeal}
            onAddActivity={addActivity}
            onAddPerson={(contactId, role) => addDealContact(sheetDeal.id, contactId, role)}
            onRemovePerson={(p) => (p.source === "edge" ? removeNetworkEdge(p.id) : removeDealContact(p.id))}
            onAddTodo={(form) => saveTodo({ ...form, deal_id: sheetDeal.id })}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodo}
            onNavigate={openTaskLink}
            onGenerateSummary={generateDealSummary}
            onSaveSummary={saveDealSummary}
            summarizing={summarizing}
            showToast={showToast}
            onBack={() => { setView("pipeline"); setDealSheetId(null); }}
          />
        ) : null;
      })()}

      {/* ENABLER SHEET */}
      {view === "enabler-sheet" && enablerSheetId && (() => {
        const sheetEnabler = enablers.find((en) => en.id === enablerSheetId);
        return sheetEnabler ? (
          <EnablerSheet
            enabler={sheetEnabler}
            activities={activities.filter((a) => a.enabler_id === sheetEnabler.id)}
            people={enablerContacts.filter((ec) => ec.enabler_id === sheetEnabler.id)}
            todos={todos.filter((t) => t.enabler_id === sheetEnabler.id)}
            contacts={contacts}
            deals={deals}
            enablers={enablers}
            networkEdges={networkEdges}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            dealEnablers={dealEnablers.filter((de) => de.enabler_id === sheetEnabler.id)}
            onEdit={(en) => setModal({ type: "enabler", data: en })}
            onDelete={deleteEnabler}
            onAddActivity={addActivity}
            onAddPerson={(contactId, role) => addEnablerContact(sheetEnabler.id, contactId, role)}
            onRemovePerson={(p) => (p.source === "edge" ? removeNetworkEdge(p.id) : removeEnablerContact(p.id))}
            onAddConnection={(form) => addDealEnabler({ ...form, enabler_id: sheetEnabler.id })}
            onRemoveConnection={removeDealEnabler}
            onAddTodo={(form) => saveTodo({ ...form, enabler_id: sheetEnabler.id })}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodo}
            onNavigate={openTaskLink}
            onGenerateSummary={generateEnablerSummary}
            onSaveSummary={saveEnablerSummary}
            summarizing={summarizing}
            showToast={showToast}
            onBack={() => { setView("enablers"); setEnablerSheetId(null); }}
          />
        ) : null;
      })()}

      {/* CONTACT SHEET */}
      {view === "contact-sheet" && contactSheetId && (() => {
        const sheetContact = contacts.find((c) => c.id === contactSheetId);
        return sheetContact ? (
          <ContactSheet
            contact={sheetContact}
            activities={activities.filter((a) => a.contact_id === sheetContact.id)}
            todos={todos.filter((t) => t.contact_id === sheetContact.id)}
            deals={deals}
            enablers={enablers}
            organizations={organizations}
            dealContacts={dealContacts}
            enablerContacts={enablerContacts}
            networkEdges={networkEdges}
            contactRoles={contactRoles}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            onEdit={(c) => setModal({ type: "contact", data: c })}
            onDelete={deleteContact}
            onAddActivity={addActivity}
            onRemoveRole={removePersonRole}
            onAddTodo={(form) => saveTodo({ ...form, contact_id: sheetContact.id })}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodo}
            onGenerateSummary={generateContactSummary}
            onSaveSummary={saveContactSummary}
            summarizing={summarizing}
            showToast={showToast}
            onOpenDeal={(id) => { setDealSheetId(id); setView("deal-sheet"); }}
            onOpenEnabler={(id) => { setEnablerSheetId(id); setView("enabler-sheet"); }}
            onOpenOrganization={(id) => { setOrganizationSheetId(id); setView("organization-sheet"); }}
            onBack={() => { setView("contacts"); setContactSheetId(null); }}
          />
        ) : null;
      })()}

      {/* ORGANIZATION SHEET */}
      {view === "organization-sheet" && organizationSheetId && (() => {
        const sheetOrganization = organizations.find((o) => o.id === organizationSheetId);
        return sheetOrganization ? (
          <OrganizationSheet
            organization={sheetOrganization}
            activities={activities.filter((a) => a.organization_id === sheetOrganization.id)}
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
            onEdit={(o) => setModal({ type: "organization", data: o })}
            onDelete={deleteOrganization}
            onAddActivity={addActivity}
            onAddConnection={addConnection}
            onRemoveNetworkEdge={removeNetworkEdge}
            onRemoveRole={removePersonRole}
            onGenerateSummary={generateOrganizationSummary}
            onSaveSummary={saveOrganizationSummary}
            summarizing={summarizing}
            showToast={showToast}
            onOpenContact={(id) => { setContactSheetId(id); setView("contact-sheet"); }}
            onOpenDeal={(id) => { setDealSheetId(id); setView("deal-sheet"); }}
            onOpenEnabler={(id) => { setEnablerSheetId(id); setView("enabler-sheet"); }}
            onOpenOrganization={(id) => { setOrganizationSheetId(id); setView("organization-sheet"); }}
            onBack={() => { setView("network"); setOrganizationSheetId(null); }}
          />
        ) : null;
      })()}

      {/* PIPELINE */}
      {view === "pipeline" && (
        <div>
          <div className="toolbar"><button onClick={() => setModal({type:"deal",data:{stage:"prospecting"}})} className="btn-primary">+ New Deal</button></div>
          <div className="kanban">
            {STAGES.map((stage) => {
              const sd = deals.filter(d => d.stage === stage.id);
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
                    {sd.map((deal) => (
                      <div key={deal.id} draggable onDragStart={(e) => e.dataTransfer.setData("dealId", deal.id)}
                        onClick={() => { setDealSheetId(deal.id); setView("deal-sheet"); }}
                        className="deal-card" style={{borderLeftColor: stage.color}}>
                        <div className="card-company">{deal.company}</div>
                        {deal.contact_name && <div className="card-contact">{deal.contact_name}{deal.contact_role ? ` . ${deal.contact_role}` : ""}</div>}
                        {deal.city && <span className="city-pin">📍 {deal.city}</span>}
                        {deal.value > 0 && <div className="card-value">${Number(deal.value).toLocaleString()}</div>}
                        {deal.next_action && <div className="card-next">Next: {deal.next_action}</div>}
                        <div className="card-meta">{daysAgo(deal.created_at)}d in pipeline</div>
                      </div>
                    ))}
                    {sd.length === 0 && <div className="empty-col">{stage.id === "prospecting" ? "Add your first deal" : "Drag deals here"}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CONTACTS */}
      {view === "contacts" && (
        <div className="section-pad">
          <div className="contacts-toolbar">
            <div className="search-row">
              <input className="input" placeholder="Search contacts..." value={contactSearch} onChange={(e) => setContactSearch(e.target.value)} />
              <select className="input select-filter" value={contactTagFilter} onChange={(e) => setContactTagFilter(e.target.value)}>
                <option value="">All Tags</option>
                {TAG_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <button onClick={() => setModal({type:"contact",data:{}})} className="btn-primary">+ New Contact</button>
          </div>
          {filteredContacts.length === 0 && <div className="empty-state">{contacts.length === 0 ? "No contacts yet. Add your first contact." : "No contacts match."}</div>}
          <div className="contacts-grid">
            {filteredContacts.map((c) => {
              const cd = deals.filter(d => d.contact_id === c.id);
              const ca = activities.filter(a => a.contact_id === c.id);
              const warmth = WARMTH_LEVELS.find(w => w.id === (c.warmth || "unknown"));
              return (
                <div key={c.id} className="contact-card" onClick={() => { setContactSheetId(c.id); setView("contact-sheet"); }}>
                  <div className="contact-top">
                    <div>
                      <div className="contact-name">
                        <span className="warmth-dot" style={{background: warmth?.color}} title={`Warmth: ${warmth?.label}`} />
                        {c.name}
                      </div>
                      {c.role && <div className="contact-role">{c.role}</div>}
                      {c.company && <div className="contact-company">{c.company}</div>}
                    </div>
                    <div className="contact-age">{c.last_contacted_at ? `${daysAgo(c.last_contacted_at)}d ago` : "Never"}</div>
                  </div>
                  {c.email && <div className="contact-email">{c.email}</div>}
                  <div className="tags-row">{(c.tags||[]).map(t => <span key={t} className="tag">{t}</span>)}</div>
                  <div className="contact-meta">{cd.length} deal{cd.length !== 1 ? "s" : ""} . {ca.length} activities</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ENABLERS */}
      {view === "enablers" && (
        <div className="section-pad">
          <div className="contacts-toolbar">
            <div className="search-row">
              <input className="input" placeholder="Search enablers..." value={enablerSearch} onChange={(e) => setEnablerSearch(e.target.value)} />
              <select className="input select-filter" value={enablerTypeFilter} onChange={(e) => setEnablerTypeFilter(e.target.value)}>
                <option value="">All Types</option>
                {ENABLER_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <button onClick={() => setModal({type:"enabler",data:{}})} className="btn-primary">+ New Enabler</button>
          </div>
          {filteredEnablers.length === 0 && <div className="empty-state">{enablers.length === 0 ? "No enablers yet. Add your first enabler." : "No enablers match."}</div>}
          <div className="contacts-grid">
            {filteredEnablers.map((en) => {
              const et = ENABLER_TYPES.find(t => t.id === en.type);
              return (
                <div key={en.id} className="contact-card" onClick={() => { setEnablerSheetId(en.id); setView("enabler-sheet"); }}>
                  <div className="contact-top">
                    <div>
                      <div className="contact-name">{en.name}</div>
                      {et && <span className="badge enabler-type-badge" style={{background:et.color+"22",color:et.color,border:`1px solid ${et.color}44`}}>{et.label}</span>}
                      {en.city && <span className="city-pin">📍 {en.city}</span>}
                    </div>
                    <div className="contact-age">{en.last_activity_at ? `${daysAgo(en.last_activity_at)}d ago` : "Never"}</div>
                  </div>
                  {en.contact_name && <div className="contact-email">{en.contact_name}</div>}
                  {en.ai_summary && <div className="enabler-summary-preview">{en.ai_summary.slice(0, 120)}{en.ai_summary.length > 120 ? "…" : ""}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* NETWORK */}
      {view === "network" && (
        <div className="section-pad">
          <NetworkTab
            contacts={contacts}
            deals={deals}
            enablers={enablers}
            organizations={organizations}
            contactRoles={contactRoles}
            customOptions={customOptions}
            onAddCustomOption={addCustomOption}
            onAddInstitution={addInstitution}
            onAddPersonWithRoles={addPersonWithRoles}
            onOpenDeal={(id) => { setDealSheetId(id); setView("deal-sheet"); }}
            onOpenEnabler={(id) => { setEnablerSheetId(id); setView("enabler-sheet"); }}
            onOpenOrganization={(id) => { setOrganizationSheetId(id); setView("organization-sheet"); }}
          />
        </div>
      )}

      {/* TASKS */}
      {view === "tasks" && (
        <div className="section-pad">
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
        <div className="section-pad">
          <div className="boss-header"><div className="boss-title">Pipeline Overview</div><div className="boss-date">{formatFull(new Date())}</div></div>
          <div className="pipeline-bar">
            {STAGES.filter(s => !["won","lost"].includes(s.id)).map(s => {
              const c = deals.filter(d => d.stage === s.id).length;
              if (!c) return null;
              return <div key={s.id} className="bar-seg" style={{background: s.color, flex: c}}><span className="bar-label">{s.label} ({c})</span></div>;
            })}
            {activeDeals.length === 0 && <div className="bar-seg bar-empty">No active deals</div>}
          </div>
          <div className="boss-stages">
            {STAGES.map(s => {
              const sd = deals.filter(d => d.stage === s.id);
              if (!sd.length) return null;
              const v = sd.reduce((sum,d) => sum + (Number(d.value)||0), 0);
              return (
                <div key={s.id} className="boss-stage-card">
                  <div className="boss-stage-head"><div className="col-title-wrap"><div className="dot" style={{background:s.color}} /><span className="boss-stage-name">{s.label}</span></div><span className="boss-stage-count">{sd.length} deal{sd.length!==1?"s":""}{v > 0 ? ` . $${v.toLocaleString()}` : ""}</span></div>
                  {sd.map(d => <div key={d.id} className="boss-deal"><span>{d.company}</span>{d.value > 0 && <span className="boss-deal-val">${Number(d.value).toLocaleString()}</span>}</div>)}
                </div>
              );
            })}
          </div>
          <div className="boss-activity">
            <div className="boss-act-title">This Week</div>
            <div className="boss-act-row">
              {[[deals.filter(d=>isThisWeek(d.last_activity_at)).length,"deals touched"],[activities.filter(a=>isThisWeek(a.created_at)).length,"activities"],[deals.filter(d=>isThisWeek(d.created_at)).length,"new deals"]].map(([n,l],i) => (
                <div key={i}><span className="boss-num">{n}</span> <span className="boss-num-label">{l}</span></div>
              ))}
            </div>
          </div>
          <div className="section-label boss-section-label">Key Summaries</div>
          <div className="key-summaries">
            {[...activeDeals.filter(d => d.ai_summary).map(d => ({ id: d.id, name: d.company, summary: d.ai_summary })),
              ...enablers.filter(en => en.ai_summary).map(en => ({ id: en.id, name: en.name, summary: en.ai_summary }))]
              .map(item => (
                <div key={item.id} className="key-summary-card">
                  <div className="key-summary-header">{item.name}</div>
                  <div className="key-summary-text">{item.summary}</div>
                </div>
              ))}
            {activeDeals.filter(d => d.ai_summary).length === 0 && enablers.filter(en => en.ai_summary).length === 0 && (
              <div className="empty-small">No summaries yet.</div>
            )}
          </div>

          <div className="section-label boss-section-label">Action Items</div>
          <div className="action-items">
            {sortTodos(todos.filter(t => t.status === "open")).slice(0, 10).map(t => {
              const linkedDeal = t.deal_id ? deals.find(d => d.id === t.deal_id) : null;
              const linkedEnabler = t.enabler_id ? enablers.find(en => en.id === t.enabler_id) : null;
              return (
                <div key={t.id} className="action-item-row">
                  <PriorityBadge priority={t.priority} />
                  <span className="action-item-title">{t.title}</span>
                  {(linkedDeal || linkedEnabler) && <span className="action-item-link">{linkedDeal ? linkedDeal.company : linkedEnabler.name}</span>}
                  {t.due_date && <span className="todo-due">Due {formatDate(t.due_date)}</span>}
                </div>
              );
            })}
            {todos.filter(t => t.status === "open").length === 0 && <div className="empty-small">No open action items.</div>}
          </div>

          <div className="center"><button onClick={() => copyReport("eow")} className="btn-copy btn-copy-lg">{reportCopied === "eow" ? "Copied!" : "Copy Weekly Report"}</button></div>
        </div>
      )}

      {/* MODALS */}
      {modal?.type === "deal" && <DealForm deal={modal.data} contacts={contacts} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveDeal} onClose={() => setModal(null)} />}
      {modal?.type === "contact" && <ContactForm contact={modal.data} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveContact} onClose={() => setModal(null)} />}
      {modal?.type === "enabler" && <EnablerForm enabler={modal.data} contacts={contacts} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveEnabler} onClose={() => setModal(null)} />}
      {modal?.type === "organization" && <OrganizationForm organization={modal.data} customOptions={customOptions} onAddCustomOption={addCustomOption} onSave={saveOrganization} onClose={() => setModal(null)} />}
    </div>
  );
}

function DealForm({ deal, contacts, customOptions, onAddCustomOption, onSave, onClose }) {
  const isEdit = !!deal.id;
  const [f, setF] = useState({ id:deal.id||"", company:deal.company||"", contact_id:deal.contact_id||"", contact_name:deal.contact_name||"", contact_role:deal.contact_role||"", value:deal.value||"", stage:deal.stage||"prospecting", city:deal.city||"", region:deal.region||"", notes:deal.notes||"", next_action:deal.next_action||"" });
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

function DealSheet({ deal, activities, people, todos, contacts, deals, enablers, organizations, networkEdges, contactRoles, dealEnablers, customOptions = [], onAddCustomOption = () => {}, onEdit, onDelete, onAddActivity, onAddPerson, onRemovePerson, onAddTodo, onToggleTodo, onUpdateTodo, onNavigate, onGenerateSummary, onSaveSummary, summarizing, showToast, onBack }) {
  const stage = STAGES.find(s => s.id === deal.stage);
  const [filter, setFilter] = useState("all");
  const [personFilter, setPersonFilter] = useState(null);

  const junctionPeople = people.map(p => ({ id: p.id, contact_id: p.contact_id, role: p.role_in_deal, contact: p.contacts, source: "junction" }));
  const edgePeople = networkEdges
    .filter(ne => ne.source_type === "contact" && ne.target_type === "deal" && ne.target_id === deal.id)
    .map(ne => ({ id: ne.id, contact_id: ne.source_id, role: ne.notes || NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === ne.relationship)?.label, contact: contacts.find(c => c.id === ne.source_id), source: "edge" }))
    .filter(p => p.contact && !junctionPeople.some(jp => jp.contact_id === p.contact_id));
  const peopleNorm = [...junctionPeople, ...edgePeople];
  const filtered = activities
    .filter(a => filter === "all" || a.type === filter)
    .filter(a => !personFilter || a.contact_id === personFilter)
    .slice().reverse();
  const filteredPersonName = personFilter ? peopleNorm.find(p => p.contact_id === personFilter)?.contact?.name : null;

  const dealOrg = organizations.find(o => (o.name || "").toLowerCase() === (deal.company || "").toLowerCase());
  const pathsIn = findNetworkPaths(deal, dealOrg, networkEdges, organizations, enablers, contacts, contactRoles);

  return (
    <div className="deal-sheet">
      <button onClick={onBack} className="sheet-back">← Back to Pipeline</button>

      <div className="sheet-top">
        <div className="sheet-top-row">
          <div>
            <div className="sheet-company">{deal.company}</div>
            <div className="sheet-meta-row">
              {stage && <span className="badge" style={{background:stage.color+"22",color:stage.color,border:`1px solid ${stage.color}44`}}>{stage.label}</span>}
              {deal.value > 0 && <span className="badge val-badge">${Number(deal.value).toLocaleString()}</span>}
            </div>
            {deal.contact_name && <div className="sheet-contact">{deal.contact_name}{deal.contact_role ? ` . ${deal.contact_role}` : ""}</div>}
          </div>
          <div className="sheet-actions">
            <button onClick={() => onEdit(deal)} className="btn-sec">Edit</button>
            <button onClick={() => { if (confirm("Delete this deal?")) onDelete(deal.id); }} className="btn-sec btn-danger">Delete</button>
          </div>
        </div>
        {deal.next_action && <div className="next-box sheet-next"><span className="next-label">Next:</span> {deal.next_action}</div>}
        {deal.notes && <div className="detail-notes sheet-notes">{deal.notes}</div>}
      </div>

      <SummaryCard
        entity={deal}
        activities={activities}
        onGenerateSummary={onGenerateSummary}
        onSaveSummary={onSaveSummary}
        summarizing={summarizing}
      />

      <PeopleSection
        people={peopleNorm}
        activities={activities}
        contacts={contacts}
        roleLabel="Role in Deal"
        selectedContactId={personFilter}
        onSelectPerson={(id) => setPersonFilter(p => p === id ? null : id)}
        onAdd={onAddPerson}
        onRemove={onRemovePerson}
      />

      <div className="people-section">
        <div className="section-label">Paths In</div>
        {pathsIn.length === 0 ? (
          <div className="empty-small">No indirect paths found. Add organizations and connections in the Network tab to surface them here.</div>
        ) : (
          <div className="todo-list">
            {pathsIn.map(p => (
              <div key={p.id} className="path-row">
                <div className="path-chain">
                  You {p.chain.map((name, i) => (
                    <span key={i}>{"> "}{name}{p.via[i] ? ` (${p.via[i]})` : ""}{i < p.chain.length - 1 ? " " : ""}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="people-section">
        <div className="section-label">Enabler Paths</div>
        {dealEnablers.length === 0 ? (
          <div className="empty-small">No enablers connected to this deal.</div>
        ) : (
          <div className="people-grid">
            {dealEnablers.map(de => {
              const en = enablers.find(x => x.id === de.enabler_id);
              const rel = DEAL_ENABLER_RELATIONSHIPS.find(r => r.id === de.relationship);
              const str = STRENGTHS.find(s => s.id === de.strength);
              if (!en) return null;
              return (
                <div key={de.id} className="person-card" onClick={() => onNavigate({ type: "enabler", id: en.id })}>
                  <div className="person-name">{en.name}</div>
                  <div className="todo-meta-row mb-sm">
                    {rel && <span className="badge">{rel.label}</span>}
                    {str && <span className="badge" style={{background:str.color+"22",color:str.color,border:`1px solid ${str.color}44`}}>{str.label}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TodoSection todos={todos} contacts={contacts} deals={deals} enablers={enablers} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onAdd={onAddTodo} onToggle={onToggleTodo} onUpdate={onUpdateTodo} onNavigate={onNavigate} />

      <QuickAdd
        dealId={deal.id}
        contactId={deal.contact_id || null}
        customOptions={customOptions}
        onAddCustomOption={onAddCustomOption}
        onAddActivity={onAddActivity}
        showToast={showToast}
      />

      <div className="timeline">
        <div className="section-label">Activity Timeline</div>
        {filteredPersonName && (
          <div className="person-filter-badge">Filtered to {filteredPersonName} <button onClick={() => setPersonFilter(null)} className="person-filter-clear">✕</button></div>
        )}
        <div className="timeline-tabs">
          {TIMELINE_TABS.map(t => (
            <button key={t.id} onClick={() => setFilter(t.id)} className={`tag-btn ${filter === t.id ? "active" : ""}`}>{t.label}</button>
          ))}
        </div>
        <div className="timeline-list">
          {filtered.length === 0 && <div className="empty-small">No activities yet</div>}
          {filtered.map(a => (
            <div key={a.id} className="timeline-item">
              <span className="timeline-icon">{ACT_TYPES.find(t => t.id === a.type)?.icon || "."}</span>
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

function EnablerForm({ enabler, contacts, customOptions, onAddCustomOption, onSave, onClose }) {
  const isEdit = !!enabler.id;
  const [f, setF] = useState({ id:enabler.id||"", name:enabler.name||"", type:enabler.type||"vc", contact_id:enabler.contact_id||"", contact_name:enabler.contact_name||"", city:enabler.city||"", region:enabler.region||"", notes:enabler.notes||"" });
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  const pickContact = (id) => { const c = contacts.find(x=>x.id===id); if(c){setF(p=>({...p, contact_id:id, contact_name:c.name||""}));} else {set("contact_id","");} };
  const typeOpts = optionsWithCustom(ENABLER_TYPES, customOptions, "enabler_type");
  const cityOpts = optionsWithCustom(CITY_OPTIONS, customOptions, "city");
  const regionOpts = optionsWithCustom(REGION_OPTIONS, customOptions, "region");
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{isEdit?"Edit Enabler":"New Enabler"}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. STV, Monsha'at" /></div>
        <div className="field"><label className="label">Type</label><SelectWithCustom options={typeOpts} value={f.type} onChange={(v)=>{set("type",v); trackCustom("enabler_type", typeOpts, onAddCustomOption)(v);}} /></div>
        {contacts.length > 0 && <div className="field"><label className="label">Link to Contact</label><select className="input" value={f.contact_id} onChange={e=>pickContact(e.target.value)}><option value="">Select...</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.name}{c.company?` (${c.company})`:""}</option>)}</select></div>}
        <div className="field"><label className="label">City</label><SelectWithCustom options={cityOpts} value={f.city} onChange={(v)=>{set("city",v); trackCustom("city", cityOpts, onAddCustomOption)(v);}} placeholder="City name..." /></div>
        <div className="field"><label className="label">Region</label><SelectWithCustom options={regionOpts} value={f.region} onChange={(v)=>{set("region",v); trackCustom("region", regionOpts, onAddCustomOption)(v);}} placeholder="Region name..." /></div>
        <div className="field-full"><label className="label">Contact Name</label><input className="input" value={f.contact_name} onChange={e=>set("contact_name",e.target.value)} /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.name.trim()&&onSave(f)} className="btn-primary" disabled={!f.name.trim()}>{isEdit?"Save":"Add Enabler"}</button></div>
    </div></div>
  );
}

function EnablerSheet({ enabler, activities, people, todos, contacts, deals, enablers, networkEdges, dealEnablers, customOptions = [], onAddCustomOption = () => {}, onEdit, onDelete, onAddActivity, onAddPerson, onRemovePerson, onAddTodo, onToggleTodo, onUpdateTodo, onNavigate, onAddConnection, onRemoveConnection, onGenerateSummary, onSaveSummary, summarizing, showToast, onBack }) {
  const type = ENABLER_TYPES.find(t => t.id === enabler.type);
  const [filter, setFilter] = useState("all");
  const [personFilter, setPersonFilter] = useState(null);
  const [linkModalOpen, setLinkModalOpen] = useState(false);

  const junctionPeople = people.map(p => ({ id: p.id, contact_id: p.contact_id, role: p.role_in_org, contact: p.contacts, source: "junction" }));
  const edgePeople = networkEdges
    .filter(ne => ne.source_type === "contact" && ne.target_type === "enabler" && ne.target_id === enabler.id)
    .map(ne => ({ id: ne.id, contact_id: ne.source_id, role: ne.notes || NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === ne.relationship)?.label, contact: contacts.find(c => c.id === ne.source_id), source: "edge" }))
    .filter(p => p.contact && !junctionPeople.some(jp => jp.contact_id === p.contact_id));
  const peopleNorm = [...junctionPeople, ...edgePeople];
  const filtered = activities
    .filter(a => filter === "all" || a.type === filter)
    .filter(a => !personFilter || a.contact_id === personFilter)
    .slice().reverse();
  const filteredPersonName = personFilter ? peopleNorm.find(p => p.contact_id === personFilter)?.contact?.name : null;

  return (
    <div className="deal-sheet">
      <button onClick={onBack} className="sheet-back">← Back to Enablers</button>

      <div className="sheet-top">
        <div className="sheet-top-row">
          <div>
            <div className="sheet-company">{enabler.name}</div>
            <div className="sheet-meta-row">
              {type && <span className="badge" style={{background:type.color+"22",color:type.color,border:`1px solid ${type.color}44`}}>{type.label}</span>}
            </div>
            {enabler.contact_name && <div className="sheet-contact">{enabler.contact_name}</div>}
          </div>
          <div className="sheet-actions">
            <button onClick={() => onEdit(enabler)} className="btn-sec">Edit</button>
            <button onClick={() => { if (confirm("Delete this enabler?")) onDelete(enabler.id); }} className="btn-sec btn-danger">Delete</button>
          </div>
        </div>
        {enabler.notes && <div className="detail-notes sheet-notes">{enabler.notes}</div>}
      </div>

      <SummaryCard
        entity={enabler}
        activities={activities}
        onGenerateSummary={onGenerateSummary}
        onSaveSummary={onSaveSummary}
        summarizing={summarizing}
      />

      <PeopleSection
        people={peopleNorm}
        activities={activities}
        contacts={contacts}
        roleLabel="Role in Org"
        selectedContactId={personFilter}
        onSelectPerson={(id) => setPersonFilter(p => p === id ? null : id)}
        onAdd={onAddPerson}
        onRemove={onRemovePerson}
      />

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Connected Targets</div>
          <button onClick={() => setLinkModalOpen(true)} className="btn-copy">+ Link Target</button>
        </div>
        {dealEnablers.length === 0 ? (
          <div className="empty-small">No deals connected yet.</div>
        ) : (
          <div className="people-grid">
            {dealEnablers.map(de => {
              const d = deals.find(x => x.id === de.deal_id);
              const rel = DEAL_ENABLER_RELATIONSHIPS.find(r => r.id === de.relationship);
              const str = STRENGTHS.find(s => s.id === de.strength);
              if (!d) return null;
              return (
                <div key={de.id} className="person-card" onClick={() => onNavigate({ type: "deal", id: d.id })}>
                  <div className="person-card-top">
                    <div className="person-name">{d.company}</div>
                    <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this connection?")) onRemoveConnection(de.id); }} className="person-remove" title="Remove">✕</button>
                  </div>
                  <div className="todo-meta-row mb-sm">
                    {rel && <span className="badge">{rel.label}</span>}
                    {str && <span className="badge" style={{background:str.color+"22",color:str.color,border:`1px solid ${str.color}44`}}>{str.label}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {linkModalOpen && (
          <AddConnectionModal
            deals={deals}
            enablers={enablers}
            fixedEnablerId={enabler.id}
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onSave={async (form) => { await onAddConnection(form); setLinkModalOpen(false); }}
            onClose={() => setLinkModalOpen(false)}
          />
        )}
      </div>

      <TodoSection todos={todos} contacts={contacts} deals={deals} enablers={enablers} customOptions={customOptions} onAddCustomOption={onAddCustomOption} onAdd={onAddTodo} onToggle={onToggleTodo} onUpdate={onUpdateTodo} onNavigate={onNavigate} />

      <QuickAdd
        enablerId={enabler.id}
        contactId={enabler.contact_id || null}
        customOptions={customOptions}
        onAddCustomOption={onAddCustomOption}
        onAddActivity={onAddActivity}
        showToast={showToast}
      />

      <div className="timeline">
        <div className="section-label">Activity Timeline</div>
        {filteredPersonName && (
          <div className="person-filter-badge">Filtered to {filteredPersonName} <button onClick={() => setPersonFilter(null)} className="person-filter-clear">✕</button></div>
        )}
        <div className="timeline-tabs">
          {TIMELINE_TABS.map(t => (
            <button key={t.id} onClick={() => setFilter(t.id)} className={`tag-btn ${filter === t.id ? "active" : ""}`}>{t.label}</button>
          ))}
        </div>
        <div className="timeline-list">
          {filtered.length === 0 && <div className="empty-small">No activities yet</div>}
          {filtered.map(a => (
            <div key={a.id} className="timeline-item">
              <span className="timeline-icon">{ACT_TYPES.find(t => t.id === a.type)?.icon || "."}</span>
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

function ContactSheet({ contact, activities, todos, deals, enablers, organizations, dealContacts, enablerContacts, networkEdges, contactRoles, customOptions = [], onAddCustomOption = () => {}, onEdit, onDelete, onAddActivity, onRemoveRole, onAddTodo, onToggleTodo, onUpdateTodo, onGenerateSummary, onSaveSummary, summarizing, showToast, onOpenDeal, onOpenEnabler, onOpenOrganization, onBack }) {
  const [filter, setFilter] = useState("all");
  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();

  const resolveInstitution = (entityType, entityId) => {
    if (entityType === "deal") return deals.find(d => d.id === entityId);
    if (entityType === "enabler") return enablers.find(en => en.id === entityId);
    if (entityType === "organization") return organizations.find(o => o.id === entityId);
    return null;
  };
  const openInstitution = (entityType, entityId) => {
    if (entityType === "deal") onOpenDeal(entityId);
    else if (entityType === "enabler") onOpenEnabler(entityId);
    else if (entityType === "organization") onOpenOrganization(entityId);
  };

  // contact_roles is the source of truth going forward, but data linked before
  // it existed only lives in deal_contacts/enabler_contacts/network_edges/the
  // legacy deals.contact_id field, so those are included as read-only fallbacks
  // for any (entity_type, entity_id) pair not already covered by a real role row.
  const roleRows = contactRoles.filter(r => r.contact_id === contact.id);
  const covered = new Set(roleRows.map(r => `${r.entity_type}:${r.entity_id}`));
  const fallbackRows = [
    ...dealContacts.filter(dc => dc.contact_id === contact.id).map(dc => ({ entity_type: "deal", entity_id: dc.deal_id, role_title: dc.role_in_deal, removable: false })),
    ...deals.filter(d => d.contact_id === contact.id).map(d => ({ entity_type: "deal", entity_id: d.id, role_title: d.contact_role, removable: false })),
    ...enablerContacts.filter(ec => ec.contact_id === contact.id).map(ec => ({ entity_type: "enabler", entity_id: ec.enabler_id, role_title: ec.role_in_org, removable: false })),
    ...networkEdges.filter(ne => ne.source_type === "contact" && ne.source_id === contact.id && ne.target_type === "organization").map(ne => ({ entity_type: "organization", entity_id: ne.target_id, role_title: ne.notes, removable: false })),
  ].filter(r => !covered.has(`${r.entity_type}:${r.entity_id}`));
  const seenFallback = new Set();
  const roles = [
    ...roleRows.map(r => ({ ...r, removable: true })),
    ...fallbackRows.filter(r => { const k = `${r.entity_type}:${r.entity_id}`; if (seenFallback.has(k)) return false; seenFallback.add(k); return true; }),
  ]
    .map(r => ({ ...r, institution: resolveInstitution(r.entity_type, r.entity_id) }))
    .filter(r => r.institution);

  return (
    <div className="deal-sheet">
      <button onClick={onBack} className="sheet-back">← Back to Contacts</button>

      <div className="sheet-top">
        <div className="sheet-top-row">
          <div>
            <div className="sheet-company">{contact.name}</div>
            {(contact.role || contact.company) && (
              <div className="sheet-contact">{contact.role}{contact.role && contact.company ? " . " : ""}{contact.company}</div>
            )}
            <div className="contact-details mb-sm">
              {contact.email && <div>📧 {contact.email}</div>}
              {contact.phone && <div>📞 {contact.phone}</div>}
              {contact.linkedin && <div>🔗 {contact.linkedin}</div>}
              {contact.source && <div className="source-text">Source: {contact.source}</div>}
            </div>
            {(contact.tags || []).length > 0 && <div className="tags-row">{contact.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>}
          </div>
          <div className="sheet-actions">
            <button onClick={() => onEdit(contact)} className="btn-sec">Edit</button>
            <button onClick={() => { if (confirm("Delete this contact?")) onDelete(contact.id); }} className="btn-sec btn-danger">Delete</button>
          </div>
        </div>
        {contact.notes && <div className="detail-notes sheet-notes">{contact.notes}</div>}
      </div>

      <SummaryCard
        entity={contact}
        activities={activities}
        onGenerateSummary={onGenerateSummary}
        onSaveSummary={onSaveSummary}
        summarizing={summarizing}
      />

      <div className="people-section">
        <div className="section-label">Institutions</div>
        {roles.length === 0 ? (
          <div className="empty-small">Not linked to any institution yet.</div>
        ) : (
          <div className="people-grid">
            {roles.map(r => {
              const name = r.entity_type === "deal" ? r.institution.company : r.institution.name;
              const badge = r.entity_type === "deal" ? STAGES.find(s => s.id === r.institution.stage)
                : r.entity_type === "enabler" ? ENABLER_TYPES.find(t => t.id === r.institution.type)
                : (ORG_TYPES.find(t => t.id === r.institution.type) || INSTITUTION_TYPES.find(t => t.id === r.institution.type));
              return (
                <div key={`${r.entity_type}-${r.entity_id}`} className="person-card" onClick={() => openInstitution(r.entity_type, r.entity_id)}>
                  <div className="person-card-top">
                    <div>
                      <div className="person-name">{name}</div>
                      {r.role_title && <div className="person-role">{r.role_title}</div>}
                    </div>
                    {r.removable && onRemoveRole && <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this role?")) onRemoveRole(r); }} className="person-remove" title="Remove">✕</button>}
                  </div>
                  {badge && <span className="badge" style={{background:badge.color+"22",color:badge.color,border:`1px solid ${badge.color}44`}}>{badge.label}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TodoSection
        todos={todos}
        contacts={[]}
        deals={deals}
        enablers={enablers}
        customOptions={customOptions}
        onAddCustomOption={onAddCustomOption}
        onAdd={onAddTodo}
        onToggle={onToggleTodo}
        onUpdate={onUpdateTodo}
        onNavigate={(link) => (link.type === "deal" ? onOpenDeal(link.id) : onOpenEnabler(link.id))}
      />

      <QuickAdd
        contactId={contact.id}
        customOptions={customOptions}
        onAddCustomOption={onAddCustomOption}
        onAddActivity={onAddActivity}
        showToast={showToast}
      />

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
              <span className="timeline-icon">{ACT_TYPES.find(t => t.id === a.type)?.icon || "."}</span>
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

function PeopleSection({ people, activities, contacts, roleLabel, selectedContactId, onSelectPerson, onAdd, onRemove }) {
  const [modalOpen, setModalOpen] = useState(false);
  const linkedIds = new Set(people.map(p => p.contact_id));
  const available = contacts.filter(c => !linkedIds.has(c.id));

  return (
    <div className="people-section">
      <div className="ai-summary-header">
        <div className="section-label">People</div>
        <button onClick={() => setModalOpen(true)} className="btn-copy">+ Add Person</button>
      </div>
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
                  <div>
                    <div className="person-name"><span className="warmth-dot" style={{background:warmth?.color}} />{c.name}</div>
                    {p.role && <div className="person-role">{p.role}</div>}
                    {c.company && <div className="person-company">{c.company}</div>}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); if (confirm(`Remove ${c.name || "this person"}?`)) onRemove(p); }} className="person-remove" title="Remove">✕</button>
                </div>
                <div className="person-meta">{count} activit{count === 1 ? "y" : "ies"}</div>
              </div>
            );
          })}
        </div>
      )}
      {modalOpen && (
        <AddPersonModal
          contacts={available}
          roleLabel={roleLabel}
          onSave={async (contactId, role) => { await onAdd(contactId, role); setModalOpen(false); }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function AddPersonModal({ contacts, roleLabel, onSave, onClose }) {
  const [contactId, setContactId] = useState("");
  const [role, setRole] = useState("");
  return (
    <div className="overlay" onClick={onClose}><div className="modal modal-sm" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">Add Person</div><button onClick={onClose} className="close-btn">✕</button></div>
      {contacts.length === 0 ? (
        <div className="empty-small">No available contacts to link. Everyone is already added, or you have no contacts yet.</div>
      ) : (
        <>
          <div className="mb-sm">
            <label className="label">Contact</label>
            <select className="input" value={contactId} onChange={e => setContactId(e.target.value)}>
              <option value="">Select...</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ""}</option>)}
            </select>
          </div>
          <div className="mb-sm">
            <label className="label">{roleLabel}</label>
            <input className="input" value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. Decision Maker" />
          </div>
        </>
      )}
      <div className="modal-actions">
        <button onClick={onClose} className="btn-sec">Cancel</button>
        <button onClick={() => contactId && onSave(contactId, role)} className="btn-primary" disabled={!contactId}>Add</button>
      </div>
    </div></div>
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
      setQDesc(await generateSummary(prompt));
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

function SummaryCard({ entity, activities, onGenerateSummary, onSaveSummary, summarizing }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entity.ai_summary || "");

  useEffect(() => {
    const mostRecent = activities.length > 0 ? Math.max(...activities.map(a => new Date(a.created_at).getTime())) : 0;
    const summaryTime = entity.ai_summary_updated_at ? new Date(entity.ai_summary_updated_at).getTime() : 0;
    if (!entity.ai_summary || mostRecent > summaryTime) {
      onGenerateSummary(entity, activities);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id]);

  const startEdit = () => { setDraft(entity.ai_summary || ""); setEditing(true); };
  const save = async () => { await onSaveSummary(entity.id, draft); setEditing(false); };

  return (
    <div className="ai-summary">
      <div className="ai-summary-header">
        <div className="section-label">AI Summary</div>
        {!editing && entity.ai_summary && !summarizing && <button onClick={startEdit} className="icon-btn" title="Edit summary">✎ Edit</button>}
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
          <div className="ai-summary-text" onClick={startEdit} title="Click to edit">{entity.ai_summary}</div>
          <div className="ai-summary-updated">Last updated: {formatDate(entity.ai_summary_updated_at)}</div>
        </>
      ) : (
        <div className="empty-small">No summary yet.</div>
      )}
      {!editing && (
        <button onClick={() => onGenerateSummary(entity, activities)} className="link-btn" disabled={summarizing}>Regenerate</button>
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

  return (
    <div className={`todo-row ${todo.status === "completed" ? "todo-done" : ""}`}>
      <input type="checkbox" checked={todo.status === "completed"} onChange={() => onToggle(todo)} className="todo-checkbox" />
      <div className="todo-main">
        <div className="todo-title-row">
          <span className="todo-title">{todo.title}</span>
          {onUpdate && <button onClick={startEdit} className="icon-btn" title="Edit task">✎</button>}
          <PriorityBadge priority={todo.priority} />
          {overdue && <span className="badge overdue-badge">Overdue</span>}
        </div>
        <div className="todo-meta-row">
          {todo.due_date && <span className="todo-due">Due {formatDate(todo.due_date)}</span>}
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
          <button onClick={() => setShowCompleted(s => !s)} className="link-btn">{showCompleted ? "Hide completed" : `Show completed (${completed.length})`}</button>
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

function AddConnectionModal({ deals, enablers, fixedEnablerId, fixedDealId, customOptions = [], onAddCustomOption = () => {}, onSave, onClose }) {
  const [enablerId, setEnablerId] = useState(fixedEnablerId || "");
  const [dealId, setDealId] = useState(fixedDealId || "");
  const [relationship, setRelationship] = useState("can_introduce");
  const [strength, setStrength] = useState("medium");
  const [notes, setNotes] = useState("");
  const relOpts = optionsWithCustom(DEAL_ENABLER_RELATIONSHIPS, customOptions, "relationship_type");
  const strengthOpts = optionsWithCustom(STRENGTHS.filter(s=>s.id!=="unknown"), customOptions, "strength");

  return (
    <div className="overlay" onClick={onClose}><div className="modal modal-sm" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">Add Connection</div><button onClick={onClose} className="close-btn">✕</button></div>
      {!fixedEnablerId && (
        <div className="mb-sm"><label className="label">Enabler</label><select className="input" value={enablerId} onChange={e=>setEnablerId(e.target.value)}><option value="">Select...</option>{enablers.map(en=><option key={en.id} value={en.id}>{en.name}</option>)}</select></div>
      )}
      {!fixedDealId && (
        <div className="mb-sm"><label className="label">Deal</label><select className="input" value={dealId} onChange={e=>setDealId(e.target.value)}><option value="">Select...</option>{deals.map(d=><option key={d.id} value={d.id}>{d.company}</option>)}</select></div>
      )}
      <div className="mb-sm"><label className="label">Relationship</label><SelectWithCustom options={relOpts} value={relationship} onChange={(v)=>{setRelationship(v); trackCustom("relationship_type", relOpts, onAddCustomOption)(v);}} /></div>
      <div className="mb-sm"><label className="label">Strength</label><SelectWithCustom options={strengthOpts} value={strength} onChange={(v)=>{setStrength(v); trackCustom("strength", strengthOpts, onAddCustomOption)(v);}} /></div>
      <div className="mb-sm"><label className="label">Notes</label><textarea className="input textarea" value={notes} onChange={e=>setNotes(e.target.value)} /></div>
      <div className="modal-actions">
        <button onClick={onClose} className="btn-sec">Cancel</button>
        <button onClick={() => enablerId && dealId && onSave({ enabler_id: enablerId, deal_id: dealId, relationship, strength, notes })} className="btn-primary" disabled={!enablerId || !dealId}>Add</button>
      </div>
    </div></div>
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


function OrganizationForm({ organization, customOptions = [], onAddCustomOption = () => {}, onSave, onClose }) {
  const isEdit = !!organization.id;
  const [f, setF] = useState({
    id: organization.id || "",
    name: organization.name || "",
    type: organization.type || "competitor",
    city: organization.city || "",
    region: organization.region || "",
    country: organization.country || "Saudi Arabia",
    sector: organization.sector || "",
    address: organization.address || "",
    description: organization.description || "",
    website: organization.website || "",
    notes: organization.notes || "",
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const typeOpts = optionsWithCustom(INSTITUTION_TYPES.filter((t) => t.id !== "target" && t.id !== "enabler"), customOptions, "institution_type");
  const cityOpts = optionsWithCustom(CITY_OPTIONS, customOptions, "city");
  const regionOpts = optionsWithCustom(REGION_OPTIONS, customOptions, "region");
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e => e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{isEdit ? "Edit Organization" : "New Organization"}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={f.name} onChange={e=>set("name",e.target.value)} /></div>
        <div className="field"><label className="label">Type</label><SelectWithCustom options={typeOpts} value={f.type} onChange={(v)=>{set("type",v); trackCustom("institution_type", typeOpts, onAddCustomOption)(v);}} /></div>
        <div className="field"><label className="label">Sector</label><input className="input" value={f.sector} onChange={e=>set("sector",e.target.value)} /></div>
        <div className="field"><label className="label">City</label><SelectWithCustom options={cityOpts} value={f.city} onChange={(v)=>{set("city",v); trackCustom("city", cityOpts, onAddCustomOption)(v);}} placeholder="City name..." /></div>
        <div className="field"><label className="label">Region</label><SelectWithCustom options={regionOpts} value={f.region} onChange={(v)=>{set("region",v); trackCustom("region", regionOpts, onAddCustomOption)(v);}} placeholder="Region name..." /></div>
        <div className="field-full"><label className="label">Country</label><input className="input" value={f.country} onChange={e=>set("country",e.target.value)} /></div>
        <div className="field-full"><label className="label">Address</label><input className="input" value={f.address} onChange={e=>set("address",e.target.value)} /></div>
        <div className="field-full"><label className="label">Website</label><input className="input" value={f.website} onChange={e=>set("website",e.target.value)} placeholder="https://..." /></div>
        <div className="field-full"><label className="label">Description</label><textarea className="input textarea" value={f.description} onChange={e=>set("description",e.target.value)} /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions">
        <button onClick={onClose} className="btn-sec">Cancel</button>
        <button onClick={() => f.name.trim() && onSave(f)} className="btn-primary" disabled={!f.name.trim()}>{isEdit ? "Save" : "Add Organization"}</button>
      </div>
    </div></div>
  );
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

function OrganizationSheet({
  organization, activities, contacts, deals, enablers, organizations,
  dealContacts, enablerContacts, networkEdges, contactRoles,
  customOptions = [], onAddCustomOption = () => {},
  onEdit, onDelete, onAddActivity,
  onAddConnection, onRemoveNetworkEdge, onRemoveRole, onGenerateSummary, onSaveSummary, summarizing, showToast,
  onOpenContact, onOpenDeal, onOpenEnabler, onOpenOrganization, onBack,
}) {
  const [filter, setFilter] = useState("all");
  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const [addOrgOpen, setAddOrgOpen] = useState(false);
  const [addDealOpen, setAddDealOpen] = useState(false);
  const [addEnablerOpen, setAddEnablerOpen] = useState(false);

  const t = ORG_TYPES.find(x => x.id === organization.type) || INSTITUTION_TYPES.find(x => x.id === organization.type);
  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();

  const keyPeopleRoles = contactRoles.filter(r => r.entity_type === "organization" && r.entity_id === organization.id);
  const keyPeopleEdges = networkEdges.filter(ne => ne.target_type === "organization" && ne.target_id === organization.id && ne.source_type === "contact");
  const matchedDeal = deals.find(d => (d.company || "").toLowerCase() === organization.name.toLowerCase());
  const matchedEnabler = enablers.find(en => (en.name || "").toLowerCase() === organization.name.toLowerCase());
  const keyPeopleRaw = [
    ...keyPeopleRoles.map(r => ({ contactId: r.contact_id, role: r.role_title, removeId: r.id, removable: true, source: "role" })),
    ...keyPeopleEdges.map(ne => ({ contactId: ne.source_id, role: ne.notes || NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === ne.relationship)?.label, removeId: ne.id, removable: true, source: "edge" })),
    ...(matchedDeal ? dealContacts.filter(dc => dc.deal_id === matchedDeal.id).map(dc => ({ contactId: dc.contact_id, role: dc.role_in_deal, removable: false })) : []),
    ...(matchedEnabler ? enablerContacts.filter(ec => ec.enabler_id === matchedEnabler.id).map(ec => ({ contactId: ec.contact_id, role: ec.role_in_org, removable: false })) : []),
  ];
  const seenIds = new Set();
  const keyPeople = keyPeopleRaw
    .filter(p => { if (seenIds.has(p.contactId)) return false; seenIds.add(p.contactId); return true; })
    .map(p => ({ ...p, contact: contacts.find(c => c.id === p.contactId) }))
    .filter(p => p.contact);

  // "Also at" lines: every OTHER institution a key person here also holds a role at.
  const alsoAt = (contactId) => contactRoles
    .filter(r => r.contact_id === contactId && !(r.entity_type === "organization" && r.entity_id === organization.id))
    .map(r => {
      const inst = r.entity_type === "deal" ? deals.find(d => d.id === r.entity_id)
        : r.entity_type === "enabler" ? enablers.find(e => e.id === r.entity_id)
        : organizations.find(o => o.id === r.entity_id);
      if (!inst) return null;
      const name = r.entity_type === "deal" ? inst.company : inst.name;
      return { name, role: r.role_title };
    })
    .filter(Boolean);

  const otherEndOfEdge = (ne, kind) => {
    const isSource = ne.source_type === "organization" && ne.source_id === organization.id;
    const otherType = isSource ? ne.target_type : ne.source_type;
    const otherId = isSource ? ne.target_id : ne.source_id;
    return otherType === kind ? otherId : null;
  };
  const touchesOrg = (ne, kind) => (ne.source_type === "organization" && ne.source_id === organization.id && ne.target_type === kind)
    || (ne.target_type === "organization" && ne.target_id === organization.id && ne.source_type === kind);

  const connectedOrgs = networkEdges.filter(ne => touchesOrg(ne, "organization"))
    .map(ne => { const id = otherEndOfEdge(ne, "organization"); const org = organizations.find(o => o.id === id); return org ? { org, edge: ne } : null; })
    .filter(Boolean);
  const connectedDeals = networkEdges.filter(ne => touchesOrg(ne, "deal"))
    .map(ne => { const id = otherEndOfEdge(ne, "deal"); const deal = deals.find(d => d.id === id); return deal ? { deal, edge: ne } : null; })
    .filter(Boolean);
  const connectedEnablers = networkEdges.filter(ne => touchesOrg(ne, "enabler"))
    .map(ne => { const id = otherEndOfEdge(ne, "enabler"); const enabler = enablers.find(e => e.id === id); return enabler ? { enabler, edge: ne } : null; })
    .filter(Boolean);

  // Auto-detected connections: other institutions that share one of this
  // organization's key people, and aren't already an explicit connection above.
  const sharedPersonConnections = (() => {
    const myContactIds = new Set(keyPeople.map(p => p.contact.id));
    const seen = new Set();
    const results = [];
    contactRoles
      .filter(r => myContactIds.has(r.contact_id) && !(r.entity_type === "organization" && r.entity_id === organization.id))
      .forEach(r => {
        const key = `${r.entity_type}:${r.entity_id}`;
        if (seen.has(key)) return;
        if (r.entity_type === "organization" && connectedOrgs.some(c => c.org.id === r.entity_id)) return;
        if (r.entity_type === "deal" && connectedDeals.some(c => c.deal.id === r.entity_id)) return;
        if (r.entity_type === "enabler" && connectedEnablers.some(c => c.enabler.id === r.entity_id)) return;
        let inst = null;
        if (r.entity_type === "deal") inst = deals.find(d => d.id === r.entity_id);
        else if (r.entity_type === "enabler") inst = enablers.find(e => e.id === r.entity_id);
        else inst = organizations.find(o => o.id === r.entity_id);
        if (!inst) return;
        seen.add(key);
        const contactName = contacts.find(c => c.id === r.contact_id)?.name || "a shared contact";
        results.push({
          key,
          name: r.entity_type === "deal" ? inst.company : inst.name,
          via: contactName,
          role: r.role_title,
          onClick: r.entity_type === "deal" ? () => onOpenDeal(inst.id) : r.entity_type === "enabler" ? () => onOpenEnabler(inst.id) : () => onOpenOrganization(inst.id),
        });
      });
    return results;
  })();

  const handleGenerateSummary = (org, acts) => onGenerateSummary(org, acts, keyPeople.map(p => p.contact.name));

  return (
    <div className="deal-sheet">
      <button onClick={onBack} className="sheet-back">← Back to Network</button>

      <div className="sheet-top">
        <div className="sheet-top-row">
          <div>
            <div className="sheet-company">{organization.name}</div>
            <div className="sheet-meta-row">
              {t && <span className="badge" style={{background:t.color+"22",color:t.color,border:`1px solid ${t.color}44`}}>{t.label}</span>}
              {organization.city && <span className="city-pin">📍 {organization.city}{organization.region ? `, ${organization.region}` : ""}</span>}
            </div>
            {organization.sector && <div className="sheet-contact">{organization.sector}</div>}
            {organization.website && <div className="sheet-contact"><a href={organization.website} target="_blank" rel="noreferrer" className="task-link">{organization.website}</a></div>}
          </div>
          <div className="sheet-actions">
            <button onClick={() => onEdit(organization)} className="btn-sec">Edit</button>
            <button onClick={() => { if (confirm("Delete this organization?")) onDelete(organization.id); }} className="btn-sec btn-danger">Delete</button>
          </div>
        </div>
        {organization.description && <div className="detail-notes sheet-notes">{organization.description}</div>}
        {organization.notes && <div className="detail-notes sheet-notes">{organization.notes}</div>}
      </div>

      <SummaryCard
        entity={organization}
        activities={activities}
        onGenerateSummary={handleGenerateSummary}
        onSaveSummary={onSaveSummary}
        summarizing={summarizing}
      />

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Key People</div>
          <button onClick={() => setAddPersonOpen(true)} className="btn-copy">+ Add Person</button>
        </div>
        {keyPeople.length === 0 ? (
          <div className="empty-small">No key people linked yet.</div>
        ) : (
          <div className="people-grid">
            {keyPeople.map(p => {
              const warmth = WARMTH_LEVELS.find(w => w.id === (p.contact.warmth || "unknown"));
              const others = alsoAt(p.contact.id);
              return (
                <div key={p.contactId} className="person-card" onClick={() => onOpenContact(p.contact.id)}>
                  <div className="person-card-top">
                    <div>
                      <div className="person-name"><span className="warmth-dot" style={{background:warmth?.color}} />{p.contact.name}</div>
                      {p.role && <div className="person-role">{p.role}</div>}
                    </div>
                    {p.removable && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!confirm(`Remove ${p.contact.name}?`)) return;
                          if (p.source === "role") onRemoveRole({ id: p.removeId, contact_id: p.contactId, entity_type: "organization", entity_id: organization.id });
                          else onRemoveNetworkEdge(p.removeId);
                        }}
                        className="person-remove"
                        title="Remove"
                      >✕</button>
                    )}
                  </div>
                  {others.length > 0 && (
                    <div className="also-at">Also at: {others.map((o, i) => <span key={i}>{o.name}{o.role ? ` (${o.role})` : ""}{i < others.length - 1 ? ", " : ""}</span>)}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {addPersonOpen && (
          <AddOrgLinkModal
            title="Add Person"
            pickLabel="Contact"
            entityOptions={contacts.filter(c => !keyPeople.some(p => p.contactId === c.id)).map(c => ({ id: c.id, label: c.name }))}
            showRole
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onSave={async (f) => {
              await onAddConnection({ aType: "contact", aId: f.entityId, bType: "organization", bId: organization.id, relationship: f.relationship, role: f.role, strength: f.strength, notes: f.notes });
              setAddPersonOpen(false);
            }}
            onClose={() => setAddPersonOpen(false)}
          />
        )}
      </div>

      {sharedPersonConnections.length > 0 && (
        <div className="people-section">
          <div className="section-label">Also Connected (via shared people)</div>
          <div className="todo-list">
            {sharedPersonConnections.map(c => (
              <div key={c.key} className="path-row" onClick={c.onClick} style={{ cursor: "pointer" }}>
                <div className="path-chain">Connected to {c.name} through {c.via}{c.role ? ` (${c.role})` : ""}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Connected Organizations</div>
          <button onClick={() => setAddOrgOpen(true)} className="btn-copy">+ Connect Organization</button>
        </div>
        {connectedOrgs.length === 0 ? (
          <div className="empty-small">No connected organizations.</div>
        ) : (
          <div className="people-grid">
            {connectedOrgs.map(({ org, edge }) => {
              const ot = ORG_TYPES.find(x => x.id === org.type) || INSTITUTION_TYPES.find(x => x.id === org.type);
              const rel = NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === edge.relationship);
              return (
                <div key={edge.id} className="person-card" onClick={() => onOpenOrganization(org.id)}>
                  <div className="person-card-top">
                    <div className="person-name">{org.name}</div>
                    <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this connection?")) onRemoveNetworkEdge(edge.id); }} className="person-remove" title="Remove">✕</button>
                  </div>
                  <div className="todo-meta-row mb-sm">
                    {ot && <span className="badge" style={{background:ot.color+"22",color:ot.color,border:`1px solid ${ot.color}44`}}>{ot.label}</span>}
                    {rel && <span className="badge">{rel.label}</span>}
                  </div>
                  {edge.notes && <div className="connection-notes">{edge.notes}</div>}
                </div>
              );
            })}
          </div>
        )}
        {addOrgOpen && (
          <AddOrgLinkModal
            title="Connect Organization"
            pickLabel="Organization"
            entityOptions={organizations.filter(o => o.id !== organization.id).map(o => ({ id: o.id, label: o.name }))}
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onSave={async (f) => {
              await onAddConnection({ aType: "organization", aId: organization.id, bType: "organization", bId: f.entityId, relationship: f.relationship, strength: f.strength, notes: f.notes });
              setAddOrgOpen(false);
            }}
            onClose={() => setAddOrgOpen(false)}
          />
        )}
      </div>

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Connected Deals</div>
          <button onClick={() => setAddDealOpen(true)} className="btn-copy">+ Connect Deal</button>
        </div>
        {connectedDeals.length === 0 ? (
          <div className="empty-small">No connected deals.</div>
        ) : (
          <div className="people-grid">
            {connectedDeals.map(({ deal, edge }) => {
              const s = STAGES.find(x => x.id === deal.stage);
              return (
                <div key={edge.id} className="person-card" onClick={() => onOpenDeal(deal.id)}>
                  <div className="person-card-top">
                    <div className="person-name">{deal.company}</div>
                    <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this connection?")) onRemoveNetworkEdge(edge.id); }} className="person-remove" title="Remove">✕</button>
                  </div>
                  {s && <span className="badge" style={{background:s.color+"22",color:s.color,border:`1px solid ${s.color}44`}}>{s.label}</span>}
                </div>
              );
            })}
          </div>
        )}
        {addDealOpen && (
          <AddOrgLinkModal
            title="Connect Deal"
            pickLabel="Deal"
            entityOptions={deals.map(d => ({ id: d.id, label: d.company }))}
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onSave={async (f) => {
              await onAddConnection({ aType: "organization", aId: organization.id, bType: "deal", bId: f.entityId, relationship: f.relationship, strength: f.strength, notes: f.notes });
              setAddDealOpen(false);
            }}
            onClose={() => setAddDealOpen(false)}
          />
        )}
      </div>

      <div className="people-section">
        <div className="ai-summary-header">
          <div className="section-label">Connected Enablers</div>
          <button onClick={() => setAddEnablerOpen(true)} className="btn-copy">+ Connect Enabler</button>
        </div>
        {connectedEnablers.length === 0 ? (
          <div className="empty-small">No connected enablers.</div>
        ) : (
          <div className="people-grid">
            {connectedEnablers.map(({ enabler, edge }) => {
              const et = ENABLER_TYPES.find(x => x.id === enabler.type);
              return (
                <div key={edge.id} className="person-card" onClick={() => onOpenEnabler(enabler.id)}>
                  <div className="person-card-top">
                    <div className="person-name">{enabler.name}</div>
                    <button onClick={(e) => { e.stopPropagation(); if (confirm("Remove this connection?")) onRemoveNetworkEdge(edge.id); }} className="person-remove" title="Remove">✕</button>
                  </div>
                  {et && <span className="badge enabler-type-badge" style={{background:et.color+"22",color:et.color,border:`1px solid ${et.color}44`}}>{et.label}</span>}
                </div>
              );
            })}
          </div>
        )}
        {addEnablerOpen && (
          <AddOrgLinkModal
            title="Connect Enabler"
            pickLabel="Enabler"
            entityOptions={enablers.map(en => ({ id: en.id, label: en.name }))}
            customOptions={customOptions}
            onAddCustomOption={onAddCustomOption}
            onSave={async (f) => {
              await onAddConnection({ aType: "organization", aId: organization.id, bType: "enabler", bId: f.entityId, relationship: f.relationship, strength: f.strength, notes: f.notes });
              setAddEnablerOpen(false);
            }}
            onClose={() => setAddEnablerOpen(false)}
          />
        )}
      </div>

      <QuickAdd
        organizationId={organization.id}
        contactId={null}
        customOptions={customOptions}
        onAddCustomOption={onAddCustomOption}
        onAddActivity={onAddActivity}
        showToast={showToast}
      />

      <div className="timeline">
        <div className="section-label">Activity Timeline</div>
        <div className="timeline-tabs">
          {TIMELINE_TABS.map(tb => (
            <button key={tb.id} onClick={() => setFilter(tb.id)} className={`tag-btn ${filter === tb.id ? "active" : ""}`}>{tb.label}</button>
          ))}
        </div>
        <div className="timeline-list">
          {filtered.length === 0 && <div className="empty-small">No activities yet</div>}
          {filtered.map(a => (
            <div key={a.id} className="timeline-item">
              <span className="timeline-icon">{ACT_TYPES.find(t2 => t2.id === a.type)?.icon || "."}</span>
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

function InstitutionForm({ customOptions = [], onAddCustomOption = () => {}, onSave, onCancel }) {
  const [f, setF] = useState({ name: "", type: "competitor", city: "", region: "", sector: "", description: "", website: "" });
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
        <div className="field-full"><label className="label">Name *</label><input className="input" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. NUPCO" /></div>
        <div className="field"><label className="label">Type</label><SelectWithCustom options={typeOpts} value={f.type} onChange={(v)=>{set("type",v); trackCustom("institution_type", typeOpts, onAddCustomOption)(v);}} /></div>
        <div className="field"><label className="label">City</label><SelectWithCustom options={cityOpts} value={f.city} onChange={(v)=>{set("city",v); trackCustom("city", cityOpts, onAddCustomOption)(v);}} placeholder="City name..." /></div>
        <div className="field"><label className="label">Region</label><SelectWithCustom options={regionOpts} value={f.region} onChange={(v)=>{set("region",v); trackCustom("region", regionOpts, onAddCustomOption)(v);}} placeholder="Region name..." /></div>
        <div className="field"><label className="label">Sector</label><input className="input" value={f.sector} onChange={e=>set("sector",e.target.value)} placeholder="e.g. Oncology, Fintech" /></div>
        <div className="field-full"><label className="label">Website</label><input className="input" value={f.website} onChange={e=>set("website",e.target.value)} placeholder="https://..." /></div>
        <div className="field-full"><label className="label">Description</label><textarea className="input textarea" value={f.description} onChange={e=>set("description",e.target.value)} /></div>
      </div>
      <div className="modal-actions">
        <button onClick={onCancel} className="btn-sec">Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!f.name.trim() || saving}>Save</button>
      </div>
    </div>
  );
}

function buildInstitutionOptions(deals, enablers, organizations) {
  return [
    ...deals.map(d => ({ key: `deal:${d.id}`, label: `${d.company} (Target)` })),
    ...enablers.map(en => ({ key: `enabler:${en.id}`, label: `${en.name} (Enabler)` })),
    ...organizations.map(o => ({ key: `organization:${o.id}`, label: `${o.name} (${(ORG_TYPES.find(t=>t.id===o.type) || INSTITUTION_TYPES.find(t=>t.id===o.type))?.label || "Organization"})` })),
  ];
}

function PersonForm({ deals, enablers, organizations, customOptions = [], onAddCustomOption = () => {}, onSave, onCancel }) {
  const institutionOptions = buildInstitutionOptions(deals, enablers, organizations);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [institutionKey, setInstitutionKey] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [warmth, setWarmth] = useState("unknown");
  const [extraRoles, setExtraRoles] = useState([]);
  const [saving, setSaving] = useState(false);
  const warmthOpts = optionsWithCustom(WARMTH_LEVELS, customOptions, "warmth");

  const addExtraRole = () => setExtraRoles(prev => [...prev, { institutionKey: "", role: "" }]);
  const updateExtraRole = (i, patch) => setExtraRoles(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeExtraRole = (i) => setExtraRoles(prev => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({ name, email, phone, warmth, roles: [{ institutionKey, role }, ...extraRoles] });
    } finally { setSaving(false); }
  };

  return (
    <div className="quickadd-inline-form">
      <div className="form-grid">
        <div className="field"><label className="label">Name *</label><input className="input" value={name} onChange={e=>setName(e.target.value)} /></div>
        <div className="field"><label className="label">Role</label><input className="input" value={role} onChange={e=>setRole(e.target.value)} placeholder="e.g. CEO, Head of Oncology" /></div>
        <div className="field-full">
          <label className="label">Institution</label>
          <select className="input" value={institutionKey} onChange={e=>setInstitutionKey(e.target.value)}>
            <option value="">Select...</option>
            {institutionOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
        <div className="field"><label className="label">Email</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} /></div>
        <div className="field"><label className="label">Phone</label><input className="input" value={phone} onChange={e=>setPhone(e.target.value)} /></div>
        <div className="field-full"><label className="label">Warmth</label><ButtonGroupWithCustom options={warmthOpts} value={warmth} onChange={(v)=>{setWarmth(v); trackCustom("warmth", warmthOpts, onAddCustomOption)(v);}} renderOption={(w)=><><span className="warmth-dot" style={{background:w.color}} />{w.label}</>} /></div>
      </div>

      {extraRoles.length > 0 && (
        <div className="mb-sm">
          <label className="label">Other roles</label>
          {extraRoles.map((r, i) => (
            <div className="quickadd-inline-row" key={i}>
              <select className="input" value={r.institutionKey} onChange={e => updateExtraRole(i, { institutionKey: e.target.value })}>
                <option value="">Select institution...</option>
                {institutionOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <input className="input" placeholder="Role" value={r.role} onChange={e => updateExtraRole(i, { role: e.target.value })} />
              <button onClick={() => removeExtraRole(i)} className="person-remove" title="Remove role">✕</button>
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={addExtraRole} className="link-btn">+ Add another role</button>

      <div className="modal-actions">
        <button onClick={onCancel} className="btn-sec">Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!name.trim() || saving}>Add Person</button>
      </div>
    </div>
  );
}

const INSTITUTION_TYPE_PLURALS = {
  target: "Targets", enabler: "Enablers", competitor: "Competitors", payer: "Payers",
  government: "Government", regulator: "Regulators", association: "Associations",
  research: "Research", hospital: "Hospitals", market_player: "Market Players",
};

// Matches a type value against the known vocabularies case insensitively, so
// legacy free-typed values (e.g. "Hospital" typed before custom_options
// existed) still group under the same canonical entry as new lowercase ids.
function institutionTypeMeta(typeId, customOptions) {
  const norm = (typeId || "").trim().toLowerCase();
  const found = INSTITUTION_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm)
    || ORG_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm)
    || optionsFromCustom(customOptions, "institution_type").find(t => t.id.toLowerCase() === norm);
  if (found) return found;
  const label = typeId ? typeId.charAt(0).toUpperCase() + typeId.slice(1).replace(/_/g, " ") : "Other";
  return { id: norm || "other", label, color: "#7B8A9E" };
}

// Canonical grouping key for a raw type value: the matching known id if one
// exists (case insensitively), otherwise the lowercased raw value so at least
// same-spelling custom values collapse into a single group.
function normalizeTypeKey(typeId) {
  const norm = (typeId || "").trim().toLowerCase();
  const known = INSTITUTION_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm) || ORG_TYPES.find(t => t.id === norm || t.label.toLowerCase() === norm);
  return known ? known.id : norm;
}

// The unified Network tab: every deal/enabler/organization is treated as an
// "institution" and grouped by type, with people nested inside as contact_roles.
function NetworkTab({
  contacts, deals, enablers, organizations, contactRoles, customOptions,
  onAddCustomOption, onAddInstitution, onAddPersonWithRoles,
  onOpenDeal, onOpenEnabler, onOpenOrganization,
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [activeForm, setActiveForm] = useState(null);

  const institutions = [
    ...deals.map(d => ({ kind: "deal", id: d.id, name: d.company, type: "target", city: d.city, lastActivity: d.last_activity_at })),
    ...enablers.map(en => ({ kind: "enabler", id: en.id, name: en.name, type: "enabler", city: en.city, lastActivity: en.last_activity_at })),
    ...organizations.map(o => ({ kind: "organization", id: o.id, name: o.name, type: normalizeTypeKey(o.type), city: o.city, lastActivity: null })),
  ];

  const peopleFor = (kind, id) => contactRoles
    .filter(r => r.entity_type === kind && r.entity_id === id)
    .map(r => ({ name: r.contacts?.name || contacts.find(c => c.id === r.contact_id)?.name, role: r.role_title }))
    .filter(p => p.name);

  const onOpenInstitution = (inst) => {
    if (inst.kind === "deal") onOpenDeal(inst.id);
    else if (inst.kind === "enabler") onOpenEnabler(inst.id);
    else onOpenOrganization(inst.id);
  };

  const cities = Array.from(new Set(institutions.map(i => i.city).filter(Boolean))).sort();
  const types = Array.from(new Set(institutions.map(i => i.type).filter(Boolean)));

  const q = search.trim().toLowerCase();
  const filtered = institutions.filter(i => (!typeFilter || i.type === typeFilter) && (!cityFilter || i.city === cityFilter) && (!q || i.name.toLowerCase().includes(q)));

  const orderedTypes = [
    ...INSTITUTION_TYPES.map(t => t.id).filter(id => types.includes(id)),
    ...types.filter(id => !INSTITUTION_TYPES.some(t => t.id === id)).sort(),
  ];

  return (
    <div className="network-directory">
      <div className="network-top-bar">
        <input className="input network-search" placeholder="Search institutions..." value={search} onChange={e => setSearch(e.target.value)} />
        <div className="network-top-buttons">
          <button onClick={() => setActiveForm(a => (a === "institution" ? null : "institution"))} className={`btn-primary ${activeForm === "institution" ? "active-toggle" : ""}`}>+ Institution</button>
          <button onClick={() => setActiveForm(a => (a === "person" ? null : "person"))} className={`btn-primary ${activeForm === "person" ? "active-toggle" : ""}`}>+ Person</button>
        </div>
      </div>

      {activeForm === "institution" && (
        <InstitutionForm
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onCancel={() => setActiveForm(null)}
          onSave={async (f) => { await onAddInstitution(f); setActiveForm(null); }}
        />
      )}
      {activeForm === "person" && (
        <PersonForm
          deals={deals}
          enablers={enablers}
          organizations={organizations}
          customOptions={customOptions}
          onAddCustomOption={onAddCustomOption}
          onCancel={() => setActiveForm(null)}
          onSave={async (f) => { await onAddPersonWithRoles(f); setActiveForm(null); }}
        />
      )}

      <div className="network-filter-row">
        <SelectWithCustom
          className="input select-filter"
          options={[{ id: "", label: "All Types" }, ...types.map(id => ({ id, label: institutionTypeMeta(id, customOptions).label }))]}
          value={typeFilter}
          onChange={setTypeFilter}
        />
        <SelectWithCustom
          className="input select-filter"
          options={[{ id: "", label: "All Cities" }, ...toOptions(Array.from(new Set([...SAUDI_CITIES, ...cities])).sort())]}
          value={cityFilter}
          onChange={setCityFilter}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">No institutions match.</div>
      ) : (
        orderedTypes.map(typeId => {
          const group = filtered.filter(i => i.type === typeId);
          if (group.length === 0) return null;
          const meta = institutionTypeMeta(typeId, customOptions);
          const plural = INSTITUTION_TYPE_PLURALS[typeId] || (meta.label.endsWith("s") ? meta.label : `${meta.label}s`);
          return (
            <div key={typeId} className="institution-group">
              <div className="institution-group-header">{plural.toUpperCase()} ({group.length})</div>
              <div className="institution-grid">
                {group.map(inst => {
                  const people = peopleFor(inst.kind, inst.id);
                  const preview = people.slice(0, 3);
                  return (
                    <div key={`${inst.kind}-${inst.id}`} className="institution-card" onClick={() => onOpenInstitution(inst)}>
                      <div className="institution-card-top">
                        <div className="institution-name">{inst.name}</div>
                        <span className="badge" style={{background:meta.color+"22",color:meta.color,border:`1px solid ${meta.color}44`}}>{meta.label}</span>
                      </div>
                      {inst.city && <span className="city-pin">📍 {inst.city}</span>}
                      <div className="institution-people-count">{people.length} {people.length === 1 ? "person" : "people"}</div>
                      {preview.length > 0 && (
                        <div className="institution-people-preview">
                          {preview.map((p, i) => <div key={i} className="institution-preview-person">{p.name}{p.role ? ` (${p.role})` : ""}</div>)}
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
    </div>
  );
}
