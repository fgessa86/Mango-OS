import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./supabase";
import { generateSummary, summarizeImage } from "./anthropic";
import { STAGES, ACT_TYPES, TAG_OPTIONS, ENABLER_TYPES, PRIORITIES, ORG_TYPES, DEAL_ENABLER_RELATIONSHIPS, NETWORK_EDGE_RELATIONSHIPS, STRENGTHS, WARMTH_LEVELS } from "./constants";
import { formatDate, formatDateTime, formatFull, daysAgo, isToday, isThisWeek, isOverdue } from "./utils";
import "./styles.css";

const PHOTO_NOTE_PROMPT = "This is a photo of handwritten meeting notes. Please transcribe and summarize the key points, action items, and any decisions made. Be concise.";

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
  const [networkSection, setNetworkSection] = useState("organizations");
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
  const [summarizing, setSummarizing] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("mango-theme") || "dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  useEffect(() => {
    localStorage.setItem("mango-theme", theme);
    // body sits outside .app, so it needs its own theme class — otherwise its
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
      const [d, c, a, en, dc, ec, td, orgs, de, ne] = await Promise.all([
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
      ]);
      setDeals(d || []); setContacts(c || []); setActivities(a || []); setEnablers(en || []);
      setDealContacts(dc || []); setEnablerContacts(ec || []); setTodos(td || []);
      setOrganizations(orgs || []); setDealEnablers(de || []); setNetworkEdges(ne || []);
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
      for (const k of ["contact_id", "contact_name", "contact_role", "notes", "next_action"]) {
        const v = (form[k] || "").trim();
        if (v) clean[k] = v;
      }
      // value is numeric — never send an empty string; only send a valid positive number
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
  const saveContact = async (form) => {
    try {
      const name = (form.name || "").trim();
      if (!name) { showToast("Name is required"); return; }
      const clean = { name, warmth: form.warmth || "unknown" };
      // Only send optional string fields when they have real content
      for (const k of ["role", "company", "email", "phone", "linkedin", "source", "notes"]) {
        const v = (form[k] || "").trim();
        if (v) clean[k] = v;
      }
      if (form.tags && form.tags.length > 0) clean.tags = form.tags;
      if (form.id) {
        await api("contacts", "PATCH", clean, `?id=eq.${form.id}`);
      } else {
        await api("contacts", "POST", clean);
      }
      await loadData(); setModal(null); showToast(form.id ? "Contact updated" : "Contact added");
    } catch { showToast("Error saving contact"); }
  };

  const deleteContact = async (id) => {
    try {
      await api("deal_contacts", "DELETE", null, `?contact_id=eq.${id}`);
      await api("enabler_contacts", "DELETE", null, `?contact_id=eq.${id}`);
      await api("todos", "DELETE", null, `?contact_id=eq.${id}`);
      await api("contacts", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Contact deleted");
      setView("contacts"); setContactSheetId(null);
    } catch { showToast("Error deleting contact"); }
  };

  const toggleContactInternal = async (id, current) => {
    try {
      await api("contacts", "PATCH", { is_internal: !current }, `?id=eq.${id}`);
      await loadData(); showToast(!current ? "Marked as internal" : "Removed from internal team");
    } catch { showToast("Error updating contact"); }
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
      for (const k of ["contact_id", "contact_name", "notes"]) {
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
      await api("todos", "DELETE", null, `?enabler_id=eq.${id}`);
      await api("enablers", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Enabler deleted");
      setView("enablers"); setEnablerSheetId(null);
    } catch { showToast("Error deleting enabler"); }
  };

  // PEOPLE (deal_contacts / enabler_contacts junction tables)
  const addDealContact = async (dealId, contactId, role) => {
    try {
      const clean = { deal_id: dealId, contact_id: contactId };
      if ((role || "").trim()) clean.role_in_deal = role.trim();
      await api("deal_contacts", "POST", clean);
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person — maybe already linked"); }
  };

  const removeDealContact = async (id) => {
    try {
      await api("deal_contacts", "DELETE", null, `?id=eq.${id}`);
      await loadData(); showToast("Person removed");
    } catch { showToast("Error removing person"); }
  };

  const addEnablerContact = async (enablerId, contactId, role) => {
    try {
      const clean = { enabler_id: enablerId, contact_id: contactId };
      if ((role || "").trim()) clean.role_in_org = role.trim();
      await api("enabler_contacts", "POST", clean);
      await loadData(); showToast("Person added");
    } catch { showToast("Error adding person — maybe already linked"); }
  };

  const removeEnablerContact = async (id) => {
    try {
      await api("enabler_contacts", "DELETE", null, `?id=eq.${id}`);
      await loadData(); showToast("Person removed");
    } catch { showToast("Error removing person"); }
  };

  // ORGANIZATIONS
  const saveOrganization = async (form) => {
    try {
      const name = (form.name || "").trim();
      if (!name) { showToast("Name is required"); return; }
      const clean = { name, type: form.type || "competitor" };
      for (const k of ["sector", "description", "website", "notes"]) {
        const v = (form[k] || "").trim();
        if (v) clean[k] = v;
      }
      if (form.id) {
        await api("organizations", "PATCH", clean, `?id=eq.${form.id}`);
      } else {
        await api("organizations", "POST", clean);
      }
      await loadData(); setModal(null); showToast(form.id ? "Organization updated" : "Organization added");
    } catch { showToast("Error saving organization"); }
  };

  const deleteOrganization = async (id) => {
    try {
      await api("organizations", "DELETE", null, `?id=eq.${id}`);
      await loadData(); showToast("Organization deleted");
    } catch { showToast("Error deleting organization"); }
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

Keep it tight and scannable. No preamble.`;
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

Keep it tight and scannable. No preamble.`;
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

Keep it tight and scannable. No preamble.`;
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
  const addActivity = async (dealId, contactId, activity, enablerId = null) => {
    try {
      await api("activities", "POST", { deal_id: dealId, contact_id: contactId, enabler_id: enablerId, ...activity });
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
            dealEnablers={dealEnablers.filter((de) => de.deal_id === sheetDeal.id)}
            onEdit={(d) => setModal({ type: "deal", data: d })}
            onDelete={deleteDeal}
            onAddActivity={addActivity}
            onAddPerson={(contactId, role) => addDealContact(sheetDeal.id, contactId, role)}
            onRemovePerson={removeDealContact}
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
            dealEnablers={dealEnablers.filter((de) => de.enabler_id === sheetEnabler.id)}
            onEdit={(en) => setModal({ type: "enabler", data: en })}
            onDelete={deleteEnabler}
            onAddActivity={addActivity}
            onAddPerson={(contactId, role) => addEnablerContact(sheetEnabler.id, contactId, role)}
            onRemovePerson={removeEnablerContact}
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
            dealContacts={dealContacts}
            enablerContacts={enablerContacts}
            onEdit={(c) => setModal({ type: "contact", data: c })}
            onDelete={deleteContact}
            onAddActivity={addActivity}
            onAddTodo={(form) => saveTodo({ ...form, contact_id: sheetContact.id })}
            onToggleTodo={toggleTodo}
            onUpdateTodo={updateTodo}
            onGenerateSummary={generateContactSummary}
            onSaveSummary={saveContactSummary}
            summarizing={summarizing}
            showToast={showToast}
            onOpenDeal={(id) => { setDealSheetId(id); setView("deal-sheet"); }}
            onOpenEnabler={(id) => { setEnablerSheetId(id); setView("enabler-sheet"); }}
            onBack={() => { setView("contacts"); setContactSheetId(null); }}
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
          <div className="timeline-tabs mb">
            {[["organizations","Organizations"],["connections","Connections"],["internal","Internal Team"]].map(([k,l]) => (
              <button key={k} onClick={() => setNetworkSection(k)} className={`tag-btn ${networkSection === k ? "active" : ""}`}>{l}</button>
            ))}
          </div>
          {networkSection === "organizations" && (
            <OrganizationsSection
              organizations={organizations}
              onEdit={(o) => setModal({ type: "organization", data: o })}
              onAdd={() => setModal({ type: "organization", data: {} })}
              onDelete={deleteOrganization}
            />
          )}
          {networkSection === "connections" && (
            <ConnectionsSection
              dealEnablers={dealEnablers}
              networkEdges={networkEdges}
              deals={deals}
              enablers={enablers}
              contacts={contacts}
              organizations={organizations}
              onAdd={addDealEnabler}
              onRemove={removeDealEnabler}
            />
          )}
          {networkSection === "internal" && (
            <InternalTeamSection
              contacts={contacts}
              deals={deals}
              enablers={enablers}
              dealContacts={dealContacts}
              enablerContacts={enablerContacts}
              onToggleInternal={toggleContactInternal}
              onOpenContact={(id) => { setContactSheetId(id); setView("contact-sheet"); }}
            />
          )}
        </div>
      )}

      {/* TASKS */}
      {view === "tasks" && (
        <div className="section-pad">
          <TaskQuickAdd deals={activeDeals} enablers={enablers} onAdd={saveTodo} />
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
      {modal?.type === "deal" && <DealForm deal={modal.data} contacts={contacts} onSave={saveDeal} onClose={() => setModal(null)} />}
      {modal?.type === "contact" && <ContactForm contact={modal.data} onSave={saveContact} onClose={() => setModal(null)} />}
      {modal?.type === "enabler" && <EnablerForm enabler={modal.data} contacts={contacts} onSave={saveEnabler} onClose={() => setModal(null)} />}
      {modal?.type === "organization" && <OrganizationForm organization={modal.data} onSave={saveOrganization} onClose={() => setModal(null)} />}
    </div>
  );
}

function DealForm({ deal, contacts, onSave, onClose }) {
  const isEdit = !!deal.id;
  const [f, setF] = useState({ id:deal.id||"", company:deal.company||"", contact_id:deal.contact_id||"", contact_name:deal.contact_name||"", contact_role:deal.contact_role||"", value:deal.value||"", stage:deal.stage||"prospecting", notes:deal.notes||"", next_action:deal.next_action||"" });
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  const pickContact = (id) => { const c = contacts.find(x=>x.id===id); if(c){setF(p=>({...p, contact_id:id, contact_name:c.name||"", contact_role:c.role||"", company:p.company||c.company||""}));} else {set("contact_id","");} };
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{isEdit?"Edit Deal":"New Deal"}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field-full"><label className="label">Company *</label><input className="input" value={f.company} onChange={e=>set("company",e.target.value)} placeholder="e.g. KFSHRC" /></div>
        {contacts.length > 0 && <div className="field-full"><label className="label">Link to Contact</label><select className="input" value={f.contact_id} onChange={e=>pickContact(e.target.value)}><option value="">Select...</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.name}{c.company?` (${c.company})`:""}</option>)}</select></div>}
        <div className="field"><label className="label">Contact Name</label><input className="input" value={f.contact_name} onChange={e=>set("contact_name",e.target.value)} /></div>
        <div className="field"><label className="label">Role</label><input className="input" value={f.contact_role} onChange={e=>set("contact_role",e.target.value)} /></div>
        <div className="field"><label className="label">Value (USD)</label><input className="input" type="number" value={f.value} onChange={e=>set("value",e.target.value)} placeholder="Optional" /></div>
        <div className="field"><label className="label">Stage</label><select className="input" value={f.stage} onChange={e=>set("stage",e.target.value)}>{STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
        <div className="field-full"><label className="label">Next Action</label><input className="input" value={f.next_action} onChange={e=>set("next_action",e.target.value)} placeholder="What needs to happen next?" /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.company.trim()&&onSave(f)} className="btn-primary" disabled={!f.company.trim()}>{isEdit?"Save":"Add Deal"}</button></div>
    </div></div>
  );
}

function ContactForm({ contact, onSave, onClose }) {
  const isEdit = !!contact.id;
  const [f, setF] = useState({ id:contact.id||"", name:contact.name||"", role:contact.role||"", company:contact.company||"", email:contact.email||"", phone:contact.phone||"", linkedin:contact.linkedin||"", source:contact.source||"", notes:contact.notes||"", tags:contact.tags||[], warmth:contact.warmth||"unknown" });
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const toggleTag = (t) => setF(p=>({...p, tags:p.tags.includes(t)?p.tags.filter(x=>x!==t):[...p.tags,t]}));
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
        <div className="field-full"><label className="label">Warmth</label><div className="tags-select">{WARMTH_LEVELS.map(w=><button key={w.id} onClick={()=>set("warmth",w.id)} className={`tag-btn ${f.warmth===w.id?"active":""}`}><span className="warmth-dot" style={{background:w.color}} />{w.label}</button>)}</div></div>
        <div className="field-full"><label className="label">Tags</label><div className="tags-select">{TAG_OPTIONS.map(t=><button key={t} onClick={()=>toggleTag(t)} className={`tag-btn ${f.tags.includes(t)?"active":""}`}>{t}</button>)}</div></div>
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

function DealSheet({ deal, activities, people, todos, contacts, deals, enablers, dealEnablers, onEdit, onDelete, onAddActivity, onAddPerson, onRemovePerson, onAddTodo, onToggleTodo, onUpdateTodo, onNavigate, onGenerateSummary, onSaveSummary, summarizing, showToast, onBack }) {
  const stage = STAGES.find(s => s.id === deal.stage);
  const [filter, setFilter] = useState("all");
  const [personFilter, setPersonFilter] = useState(null);

  const peopleNorm = people.map(p => ({ id: p.id, contact_id: p.contact_id, role: p.role_in_deal, contact: p.contacts }));
  const filtered = activities
    .filter(a => filter === "all" || a.type === filter)
    .filter(a => !personFilter || a.contact_id === personFilter)
    .slice().reverse();
  const filteredPersonName = personFilter ? peopleNorm.find(p => p.contact_id === personFilter)?.contact?.name : null;

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

      <TodoSection todos={todos} contacts={contacts} deals={deals} enablers={enablers} onAdd={onAddTodo} onToggle={onToggleTodo} onUpdate={onUpdateTodo} onNavigate={onNavigate} />

      <QuickAdd
        dealId={deal.id}
        contactId={deal.contact_id || null}
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

function EnablerForm({ enabler, contacts, onSave, onClose }) {
  const isEdit = !!enabler.id;
  const [f, setF] = useState({ id:enabler.id||"", name:enabler.name||"", type:enabler.type||"vc", contact_id:enabler.contact_id||"", contact_name:enabler.contact_name||"", notes:enabler.notes||"" });
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  const pickContact = (id) => { const c = contacts.find(x=>x.id===id); if(c){setF(p=>({...p, contact_id:id, contact_name:c.name||""}));} else {set("contact_id","");} };
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{isEdit?"Edit Enabler":"New Enabler"}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. STV, Monsha'at" /></div>
        <div className="field"><label className="label">Type</label><select className="input" value={f.type} onChange={e=>set("type",e.target.value)}>{ENABLER_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
        {contacts.length > 0 && <div className="field"><label className="label">Link to Contact</label><select className="input" value={f.contact_id} onChange={e=>pickContact(e.target.value)}><option value="">Select...</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.name}{c.company?` (${c.company})`:""}</option>)}</select></div>}
        <div className="field-full"><label className="label">Contact Name</label><input className="input" value={f.contact_name} onChange={e=>set("contact_name",e.target.value)} /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.name.trim()&&onSave(f)} className="btn-primary" disabled={!f.name.trim()}>{isEdit?"Save":"Add Enabler"}</button></div>
    </div></div>
  );
}

function EnablerSheet({ enabler, activities, people, todos, contacts, deals, enablers, dealEnablers, onEdit, onDelete, onAddActivity, onAddPerson, onRemovePerson, onAddTodo, onToggleTodo, onUpdateTodo, onNavigate, onAddConnection, onRemoveConnection, onGenerateSummary, onSaveSummary, summarizing, showToast, onBack }) {
  const type = ENABLER_TYPES.find(t => t.id === enabler.type);
  const [filter, setFilter] = useState("all");
  const [personFilter, setPersonFilter] = useState(null);
  const [linkModalOpen, setLinkModalOpen] = useState(false);

  const peopleNorm = people.map(p => ({ id: p.id, contact_id: p.contact_id, role: p.role_in_org, contact: p.contacts }));
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
            onSave={async (form) => { await onAddConnection(form); setLinkModalOpen(false); }}
            onClose={() => setLinkModalOpen(false)}
          />
        )}
      </div>

      <TodoSection todos={todos} contacts={contacts} deals={deals} enablers={enablers} onAdd={onAddTodo} onToggle={onToggleTodo} onUpdate={onUpdateTodo} onNavigate={onNavigate} />

      <QuickAdd
        enablerId={enabler.id}
        contactId={enabler.contact_id || null}
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

function ContactSheet({ contact, activities, todos, deals, enablers, dealContacts, enablerContacts, onEdit, onDelete, onAddActivity, onAddTodo, onToggleTodo, onUpdateTodo, onGenerateSummary, onSaveSummary, summarizing, showToast, onOpenDeal, onOpenEnabler, onBack }) {
  const [filter, setFilter] = useState("all");
  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();

  const linkedDealIds = new Set([
    ...dealContacts.filter(dc => dc.contact_id === contact.id).map(dc => dc.deal_id),
    ...deals.filter(d => d.contact_id === contact.id).map(d => d.id),
  ]);
  const linkedDeals = deals.filter(d => linkedDealIds.has(d.id));

  const linkedEnablerIds = new Set(enablerContacts.filter(ec => ec.contact_id === contact.id).map(ec => ec.enabler_id));
  const linkedEnablers = enablers.filter(en => linkedEnablerIds.has(en.id));

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
        <div className="section-label">Linked Deals</div>
        {linkedDeals.length === 0 ? (
          <div className="empty-small">No linked deals.</div>
        ) : (
          <div className="people-grid">
            {linkedDeals.map(d => {
              const s = STAGES.find(x => x.id === d.stage);
              return (
                <div key={d.id} className="person-card" onClick={() => onOpenDeal(d.id)}>
                  <div className="person-name">{d.company}</div>
                  {s && <span className="badge" style={{background:s.color+"22",color:s.color,border:`1px solid ${s.color}44`,marginTop:"4px",display:"inline-block"}}>{s.label}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="people-section">
        <div className="section-label">Linked Enablers</div>
        {linkedEnablers.length === 0 ? (
          <div className="empty-small">No linked enablers.</div>
        ) : (
          <div className="people-grid">
            {linkedEnablers.map(en => {
              const et = ENABLER_TYPES.find(x => x.id === en.type);
              return (
                <div key={en.id} className="person-card" onClick={() => onOpenEnabler(en.id)}>
                  <div className="person-name">{en.name}</div>
                  {et && <span className="badge enabler-type-badge" style={{background:et.color+"22",color:et.color,border:`1px solid ${et.color}44`}}>{et.label}</span>}
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
        onAdd={onAddTodo}
        onToggle={onToggleTodo}
        onUpdate={onUpdateTodo}
        onNavigate={(link) => (link.type === "deal" ? onOpenDeal(link.id) : onOpenEnabler(link.id))}
      />

      <QuickAdd
        contactId={contact.id}
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
            return (
              <div key={p.id} className={`person-card ${active ? "active" : ""}`} onClick={() => onSelectPerson(p.contact_id)}>
                <div className="person-card-top">
                  <div>
                    <div className="person-name">{c.name}</div>
                    {p.role && <div className="person-role">{p.role}</div>}
                    {c.company && <div className="person-company">{c.company}</div>}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); if (confirm(`Remove ${c.name || "this person"}?`)) onRemove(p.id); }} className="person-remove" title="Remove">✕</button>
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

function QuickAdd({ dealId = null, enablerId = null, contactId, onAddActivity, showToast }) {
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
      await onAddActivity(dealId, contactId, { type: qType, description: text }, enablerId);
      setQDesc("");
    } finally { setPosting(false); }
  };

  const summarizeTranscript = async () => {
    const text = qDesc.trim();
    if (!text || summarizingText) return;
    setSummarizingText(true);
    try {
      const prompt = `Summarize this meeting transcript. Provide key points, decisions made, and action items. Be concise.\n\nTranscript:\n${text}`;
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
      await onAddActivity(dealId, contactId, { type: "note", description: text }, enablerId);
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
        <select className="input quickadd-type" value={qType} onChange={e => setQType(e.target.value)}>
          {ACT_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
        </select>
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

function TodoForm({ contacts, onSave, onCancel }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueDate, setDueDate] = useState("");
  const [contactId, setContactId] = useState("");

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onSave({ title: t, priority, due_date: dueDate || null, contact_id: contactId || null });
  };

  return (
    <div className="todo-form">
      <input className="input" placeholder="To-do title..." value={title} onChange={e => setTitle(e.target.value)} />
      <div className="todo-form-row">
        <select className="input" value={priority} onChange={e => setPriority(e.target.value)}>
          {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
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

function TodoRow({ todo, contacts, deals = [], enablers = [], onToggle, onUpdate, onNavigate }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [priority, setPriority] = useState(todo.priority);
  const [dueDate, setDueDate] = useState(todo.due_date || "");
  const [link, setLink] = useState(todo.deal_id ? `deal:${todo.deal_id}` : todo.enabler_id ? `enabler:${todo.enabler_id}` : "");

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
            <select className="input" value={priority} onChange={e => setPriority(e.target.value)}>
              {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
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

function TodoSection({ todos, contacts, deals = [], enablers = [], onAdd, onToggle, onUpdate, onNavigate }) {
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
          onCancel={() => setShowForm(false)}
          onSave={async (form) => { await onAdd(form); setShowForm(false); }}
        />
      )}
      {open.length === 0 ? (
        <div className="empty-small">No open to-dos.</div>
      ) : (
        <div className="todo-list">
          {open.map(t => <TodoRow key={t.id} todo={t} contacts={contacts} deals={deals} enablers={enablers} onToggle={onToggle} onUpdate={onUpdate} onNavigate={onNavigate} />)}
        </div>
      )}
      {completed.length > 0 && (
        <div className="todo-completed-toggle">
          <button onClick={() => setShowCompleted(s => !s)} className="link-btn">{showCompleted ? "Hide completed" : `Show completed (${completed.length})`}</button>
          {showCompleted && (
            <div className="todo-list todo-list-completed">
              {completed.map(t => <TodoRow key={t.id} todo={t} contacts={contacts} deals={deals} enablers={enablers} onToggle={onToggle} onUpdate={onUpdate} onNavigate={onNavigate} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskQuickAdd({ deals, enablers, onAdd }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [link, setLink] = useState("");

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
        <select className="input quickadd-type" value={priority} onChange={e => setPriority(e.target.value)}>
          {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
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

function OrganizationForm({ organization, onSave, onClose }) {
  const isEdit = !!organization.id;
  const [f, setF] = useState({ id:organization.id||"", name:organization.name||"", type:organization.type||"competitor", sector:organization.sector||"", description:organization.description||"", website:organization.website||"", notes:organization.notes||"" });
  const set = (k,v) => setF(p => ({...p,[k]:v}));
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">{isEdit?"Edit Organization":"New Organization"}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="form-grid">
        <div className="field-full"><label className="label">Name *</label><input className="input" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Competitor Inc." /></div>
        <div className="field"><label className="label">Type</label><select className="input" value={f.type} onChange={e=>set("type",e.target.value)}>{ORG_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
        <div className="field"><label className="label">Sector</label><input className="input" value={f.sector} onChange={e=>set("sector",e.target.value)} placeholder="e.g. Oncology, Fintech" /></div>
        <div className="field-full"><label className="label">Website</label><input className="input" value={f.website} onChange={e=>set("website",e.target.value)} placeholder="https://..." /></div>
        <div className="field-full"><label className="label">Description</label><textarea className="input textarea" value={f.description} onChange={e=>set("description",e.target.value)} /></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.name.trim()&&onSave(f)} className="btn-primary" disabled={!f.name.trim()}>{isEdit?"Save":"Add Organization"}</button></div>
    </div></div>
  );
}

function OrganizationsSection({ organizations, onEdit, onAdd, onDelete }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const filtered = organizations.filter(o => {
    const ms = !search || [o.name, o.sector].some(f => f?.toLowerCase().includes(search.toLowerCase()));
    const mt = !typeFilter || o.type === typeFilter;
    return ms && mt;
  });

  return (
    <div>
      <div className="contacts-toolbar">
        <div className="search-row">
          <input className="input" placeholder="Search organizations..." value={search} onChange={e => setSearch(e.target.value)} />
          <select className="input select-filter" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {ORG_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <button onClick={onAdd} className="btn-primary">+ New Organization</button>
      </div>
      {filtered.length === 0 && <div className="empty-state">{organizations.length === 0 ? "No organizations yet. Add your first one." : "No organizations match."}</div>}
      <div className="contacts-grid">
        {filtered.map(o => {
          const t = ORG_TYPES.find(x => x.id === o.type);
          return (
            <div key={o.id} className="contact-card" onClick={() => onEdit(o)}>
              <div className="contact-top">
                <div>
                  <div className="contact-name">{o.name}</div>
                  {t && <span className="badge enabler-type-badge" style={{background:t.color+"22",color:t.color,border:`1px solid ${t.color}44`}}>{t.label}</span>}
                </div>
                <button onClick={(e) => { e.stopPropagation(); if (confirm(`Delete ${o.name}?`)) onDelete(o.id); }} className="person-remove" title="Delete">✕</button>
              </div>
              {o.sector && <div className="contact-company">{o.sector}</div>}
              {o.description && <div className="enabler-summary-preview">{o.description.slice(0, 120)}{o.description.length > 120 ? "…" : ""}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddConnectionModal({ deals, enablers, fixedEnablerId, fixedDealId, onSave, onClose }) {
  const [enablerId, setEnablerId] = useState(fixedEnablerId || "");
  const [dealId, setDealId] = useState(fixedDealId || "");
  const [relationship, setRelationship] = useState("can_introduce");
  const [strength, setStrength] = useState("medium");
  const [notes, setNotes] = useState("");

  return (
    <div className="overlay" onClick={onClose}><div className="modal modal-sm" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">Add Connection</div><button onClick={onClose} className="close-btn">✕</button></div>
      {!fixedEnablerId && (
        <div className="mb-sm"><label className="label">Enabler</label><select className="input" value={enablerId} onChange={e=>setEnablerId(e.target.value)}><option value="">Select...</option>{enablers.map(en=><option key={en.id} value={en.id}>{en.name}</option>)}</select></div>
      )}
      {!fixedDealId && (
        <div className="mb-sm"><label className="label">Deal</label><select className="input" value={dealId} onChange={e=>setDealId(e.target.value)}><option value="">Select...</option>{deals.map(d=><option key={d.id} value={d.id}>{d.company}</option>)}</select></div>
      )}
      <div className="mb-sm"><label className="label">Relationship</label><select className="input" value={relationship} onChange={e=>setRelationship(e.target.value)}>{DEAL_ENABLER_RELATIONSHIPS.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></div>
      <div className="mb-sm"><label className="label">Strength</label><select className="input" value={strength} onChange={e=>setStrength(e.target.value)}>{STRENGTHS.filter(s=>s.id!=="unknown").map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
      <div className="mb-sm"><label className="label">Notes</label><textarea className="input textarea" value={notes} onChange={e=>setNotes(e.target.value)} /></div>
      <div className="modal-actions">
        <button onClick={onClose} className="btn-sec">Cancel</button>
        <button onClick={() => enablerId && dealId && onSave({ enabler_id: enablerId, deal_id: dealId, relationship, strength, notes })} className="btn-primary" disabled={!enablerId || !dealId}>Add</button>
      </div>
    </div></div>
  );
}

function ConnectionsSection({ dealEnablers, networkEdges, deals, enablers, contacts, organizations, onAdd, onRemove }) {
  const [modalOpen, setModalOpen] = useState(false);

  const resolveEntity = (type, id) => {
    const map = { deal: deals, enabler: enablers, contact: contacts, organization: organizations };
    const found = map[type]?.find(x => x.id === id);
    if (!found) return `${type} (${String(id).slice(0, 8)})`;
    return found.company || found.name;
  };

  return (
    <div>
      <div className="contacts-toolbar">
        <div className="section-label" style={{margin:0}}>Enabler → Deal Connections</div>
        <button onClick={() => setModalOpen(true)} className="btn-primary">+ Add Connection</button>
      </div>
      {dealEnablers.length === 0 ? (
        <div className="empty-state">No connections yet.</div>
      ) : (
        <div className="todo-list mb">
          {dealEnablers.map(de => {
            const rel = DEAL_ENABLER_RELATIONSHIPS.find(r => r.id === de.relationship);
            const str = STRENGTHS.find(s => s.id === de.strength);
            return (
              <div key={de.id} className="connection-row">
                <div className="connection-main">
                  <span className="connection-title">{de.enablers?.name || "Unknown enabler"} → {de.deals?.company || "Unknown deal"}</span>
                  <div className="todo-meta-row">
                    {rel && <span className="badge">{rel.label}</span>}
                    {str && <span className="badge" style={{background:str.color+"22",color:str.color,border:`1px solid ${str.color}44`}}>{str.label}</span>}
                  </div>
                  {de.notes && <div className="connection-notes">{de.notes}</div>}
                </div>
                <button onClick={() => { if (confirm("Remove this connection?")) onRemove(de.id); }} className="person-remove" title="Remove">✕</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="section-label boss-section-label">Network Edges</div>
      {networkEdges.length === 0 ? (
        <div className="empty-small">No network edges recorded yet.</div>
      ) : (
        <div className="todo-list">
          {networkEdges.map(ne => {
            const rel = NETWORK_EDGE_RELATIONSHIPS.find(r => r.id === ne.relationship);
            const str = STRENGTHS.find(s => s.id === ne.strength);
            return (
              <div key={ne.id} className="connection-row">
                <div className="connection-main">
                  <span className="connection-title">{resolveEntity(ne.source_type, ne.source_id)} → {resolveEntity(ne.target_type, ne.target_id)}</span>
                  <div className="todo-meta-row">
                    {rel && <span className="badge">{rel.label}</span>}
                    {str && <span className="badge" style={{background:str.color+"22",color:str.color,border:`1px solid ${str.color}44`}}>{str.label}</span>}
                    <span className="task-link-static">{ne.direction === "one_way" ? "One-way" : "Bidirectional"}</span>
                  </div>
                  {ne.notes && <div className="connection-notes">{ne.notes}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <AddConnectionModal
          deals={deals}
          enablers={enablers}
          onSave={async (form) => { await onAdd(form); setModalOpen(false); }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function InternalTeamSection({ contacts, deals, enablers, dealContacts, enablerContacts, onToggleInternal, onOpenContact }) {
  const [addContactId, setAddContactId] = useState("");
  const internalContacts = contacts.filter(c => c.is_internal);
  const availableContacts = contacts.filter(c => !c.is_internal);

  return (
    <div>
      <div className="contacts-toolbar">
        <div className="search-row">
          <select className="input" value={addContactId} onChange={e => setAddContactId(e.target.value)}>
            <option value="">Select a contact to mark internal...</option>
            {availableContacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <button
          onClick={() => { if (addContactId) { onToggleInternal(addContactId, false); setAddContactId(""); } }}
          className="btn-primary"
          disabled={!addContactId}
        >+ Mark as Internal</button>
      </div>
      {internalContacts.length === 0 ? (
        <div className="empty-state">No internal team members yet.</div>
      ) : (
        <div className="contacts-grid">
          {internalContacts.map(c => {
            const linkedDealIds = new Set([
              ...dealContacts.filter(dc => dc.contact_id === c.id).map(dc => dc.deal_id),
              ...deals.filter(d => d.contact_id === c.id).map(d => d.id),
            ]);
            const linkedEnablerIds = new Set(enablerContacts.filter(ec => ec.contact_id === c.id).map(ec => ec.enabler_id));
            const linkedDealNames = deals.filter(d => linkedDealIds.has(d.id)).map(d => d.company);
            const linkedEnablerNames = enablers.filter(en => linkedEnablerIds.has(en.id)).map(en => en.name);
            return (
              <div key={c.id} className="contact-card" onClick={() => onOpenContact(c.id)}>
                <div className="contact-top">
                  <div>
                    <div className="contact-name">{c.name}</div>
                    {c.role && <div className="contact-role">{c.role}</div>}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); onToggleInternal(c.id, true); }} className="person-remove" title="Remove from internal team">✕</button>
                </div>
                {linkedDealNames.length > 0 && <div className="contact-meta">Deals: {linkedDealNames.join(", ")}</div>}
                {linkedEnablerNames.length > 0 && <div className="contact-meta">Enablers: {linkedEnablerNames.join(", ")}</div>}
                {linkedDealNames.length === 0 && linkedEnablerNames.length === 0 && <div className="contact-meta">No linked deals or enablers</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
