import { useState, useEffect, useCallback } from "react";
import { api } from "./supabase";
import { generateSummary } from "./anthropic";
import { STAGES, ACT_TYPES, TAG_OPTIONS, ENABLER_TYPES } from "./constants";
import { formatDate, formatFull, daysAgo, isToday, isThisWeek } from "./utils";
import "./styles.css";

export default function App() {
  const [view, setView] = useState("pipeline");
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [enablers, setEnablers] = useState([]);
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
  const [summarizing, setSummarizing] = useState(false);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  const loadData = useCallback(async () => {
    try {
      const [d, c, a, en] = await Promise.all([
        api("deals", "GET", null, "?select=*&order=created_at.desc"),
        api("contacts", "GET", null, "?select=*&order=name.asc"),
        api("activities", "GET", null, "?select=*&order=created_at.desc"),
        api("enablers", "GET", null, "?select=*&order=name.asc"),
      ]);
      setDeals(d || []); setContacts(c || []); setActivities(a || []); setEnablers(en || []);
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
      const clean = { name };
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
      await api("contacts", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Contact deleted");
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
      await api("enablers", "DELETE", null, `?id=eq.${id}`);
      await loadData(); setModal(null); showToast("Enabler deleted");
      setView("enablers"); setEnablerSheetId(null);
    } catch { showToast("Error deleting enabler"); }
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

  if (loading) return <div className="app loading-screen"><div className="loading-text">Loading Mango OS...</div></div>;

  return (
    <div className="app">
      {toast && <div className="toast">{toast}</div>}

      <header className="header">
        <div className="header-left">
          <span className="logo">🥭</span>
          <div><div className="title">Mango OS</div><div className="subtitle">Pipeline Command Center</div></div>
        </div>
        <nav className="nav">
          {[["pipeline","Pipeline"],["contacts","Contacts"],["enablers","Enablers"],["reports","Reports"],["boss","Boss View"]].map(([k,l]) => (
            <button key={k} onClick={() => setView(k)} className={`nav-tab ${view === k ? "active" : ""}`}>{l}</button>
          ))}
        </nav>
      </header>

      {view !== "deal-sheet" && view !== "enabler-sheet" && (
        <div className="stats-bar">
          {[[activeDeals.length,"Active Deals"],[totalValue > 0 ? `$${(totalValue/1000).toFixed(0)}K` : "N/A","Pipeline Value"],[contacts.length,"Contacts"],[enablers.length,"Enablers"],[deals.filter(d=>isToday(d.last_activity_at)).length,"Touched Today"],[deals.filter(d=>d.stage==="won").length,"Won"]].map(([v,l],i) => (
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
            onEdit={(d) => setModal({ type: "deal", data: d })}
            onDelete={deleteDeal}
            onAddActivity={addActivity}
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
            onEdit={(en) => setModal({ type: "enabler", data: en })}
            onDelete={deleteEnabler}
            onAddActivity={addActivity}
            onGenerateSummary={generateEnablerSummary}
            summarizing={summarizing}
            onBack={() => { setView("enablers"); setEnablerSheetId(null); }}
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
              return (
                <div key={c.id} className="contact-card" onClick={() => setModal({type:"contact-detail",data:c})}>
                  <div className="contact-top">
                    <div>
                      <div className="contact-name">{c.name}</div>
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
          <div className="center"><button onClick={() => copyReport("eow")} className="btn-copy btn-copy-lg">{reportCopied === "eow" ? "Copied!" : "Copy Weekly Report"}</button></div>
        </div>
      )}

      {/* MODALS */}
      {modal?.type === "deal" && <DealForm deal={modal.data} contacts={contacts} onSave={saveDeal} onClose={() => setModal(null)} />}
      {modal?.type === "contact" && <ContactForm contact={modal.data} onSave={saveContact} onClose={() => setModal(null)} />}
      {modal?.type === "enabler" && <EnablerForm enabler={modal.data} contacts={contacts} onSave={saveEnabler} onClose={() => setModal(null)} />}
      {modal?.type === "contact-detail" && <ContactDetail contact={modal.data} deals={deals} activities={activities.filter(a => a.contact_id === modal.data.id)} onEdit={(c) => setModal({type:"contact",data:c})} onDelete={deleteContact} onActivity={(id) => setModal({type:"activity",data:{contact_id:id}})} onClose={() => setModal(null)} />}
      {modal?.type === "activity" && <ActivityForm data={modal.data} deals={deals} contacts={contacts} onSave={addActivity} onClose={() => setModal(null)} />}
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
  const [f, setF] = useState({ id:contact.id||"", name:contact.name||"", role:contact.role||"", company:contact.company||"", email:contact.email||"", phone:contact.phone||"", linkedin:contact.linkedin||"", source:contact.source||"", notes:contact.notes||"", tags:contact.tags||[] });
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
        <div className="field-full"><label className="label">Tags</label><div className="tags-select">{TAG_OPTIONS.map(t=><button key={t} onClick={()=>toggleTag(t)} className={`tag-btn ${f.tags.includes(t)?"active":""}`}>{t}</button>)}</div></div>
        <div className="field-full"><label className="label">Notes</label><textarea className="input textarea" value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>
      </div>
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.name.trim()&&onSave(f)} className="btn-primary" disabled={!f.name.trim()}>{isEdit?"Save":"Add Contact"}</button></div>
    </div></div>
  );
}

function ContactDetail({ contact, deals, activities, onEdit, onDelete, onActivity, onClose }) {
  const cd = deals.filter(d=>d.contact_id===contact.id);
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div><div className="modal-title">{contact.name}</div>{contact.role && <div className="modal-sub">{contact.role}</div>}{contact.company && <div className="contact-company">{contact.company}</div>}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="contact-details">{contact.email&&<div>📧 {contact.email}</div>}{contact.phone&&<div>📞 {contact.phone}</div>}{contact.linkedin&&<div>🔗 {contact.linkedin}</div>}{contact.source&&<div className="source-text">Source: {contact.source}</div>}</div>
      {(contact.tags||[]).length > 0 && <div className="tags-row mb">{contact.tags.map(t=><span key={t} className="tag">{t}</span>)}</div>}
      {contact.notes && <div className="detail-notes">{contact.notes}</div>}
      {cd.length > 0 && <div className="section"><div className="section-label">Linked Deals</div>{cd.map(d=>{const s=STAGES.find(x=>x.id===d.stage);return <div key={d.id} className="linked-deal"><span>{d.company}</span><span style={{color:s?.color}}>{s?.label}</span></div>;})}</div>}
      <div className="detail-actions"><button onClick={()=>onActivity(contact.id)} className="btn-sec">+ Activity</button><button onClick={()=>onEdit(contact)} className="btn-sec">Edit</button><button onClick={()=>{if(confirm("Delete?"))onDelete(contact.id)}} className="btn-sec btn-danger">Delete</button></div>
      <div className="section-label">Activity History</div>
      <div className="activity-list">{activities.length===0?<div className="empty-small">No activities yet</div>:activities.slice().reverse().map(a=><div key={a.id} className="activity-item"><span>{ACT_TYPES.find(t=>t.id===a.type)?.icon||"."}</span><div><div className="act-desc">{a.description}</div><div className="act-date">{formatDate(a.created_at)}</div></div></div>)}</div>
    </div></div>
  );
}

function ActivityForm({ data, deals, contacts, onSave, onClose }) {
  const [type,setType] = useState("call");
  const [desc,setDesc] = useState("");
  const [dealId,setDealId] = useState(data.deal_id||"");
  const [contactId,setContactId] = useState(data.contact_id||"");
  return (
    <div className="overlay" onClick={onClose}><div className="modal modal-sm" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div className="modal-title">Log Activity</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="tags-select mb">{ACT_TYPES.map(t=><button key={t.id} onClick={()=>setType(t.id)} className={`tag-btn ${type===t.id?"active":""}`}>{t.icon} {t.label}</button>)}</div>
      {!data.deal_id&&<div className="mb-sm"><label className="label">Deal</label><select className="input" value={dealId} onChange={e=>setDealId(e.target.value)}><option value="">None</option>{deals.map(d=><option key={d.id} value={d.id}>{d.company}</option>)}</select></div>}
      {!data.contact_id&&<div className="mb-sm"><label className="label">Contact</label><select className="input" value={contactId} onChange={e=>setContactId(e.target.value)}><option value="">None</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      <textarea className="input textarea" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="What happened?" />
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>desc&&onSave(dealId||null,contactId||null,{type,description:desc})} className="btn-primary" disabled={!desc}>Log</button></div>
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

function DealSheet({ deal, activities, onEdit, onDelete, onAddActivity, onBack }) {
  const stage = STAGES.find(s => s.id === deal.stage);
  const [filter, setFilter] = useState("all");
  const [qDesc, setQDesc] = useState("");
  const [qType, setQType] = useState("call");
  const [posting, setPosting] = useState(false);

  const submitQuickAdd = async () => {
    const text = qDesc.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      await onAddActivity(deal.id, deal.contact_id || null, { type: qType, description: text });
      setQDesc("");
    } finally { setPosting(false); }
  };

  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();

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

      <div className="quickadd">
        <div className="section-label">Quick Add</div>
        <div className="quickadd-row">
          <input
            className="input quickadd-input"
            placeholder="Log an update..."
            value={qDesc}
            onChange={e => setQDesc(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submitQuickAdd(); }}
          />
          <select className="input quickadd-type" value={qType} onChange={e => setQType(e.target.value)}>
            {ACT_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
          </select>
          <button onClick={submitQuickAdd} className="btn-primary" disabled={!qDesc.trim() || posting}>Add</button>
        </div>
      </div>

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

function EnablerSheet({ enabler, activities, onEdit, onDelete, onAddActivity, onGenerateSummary, summarizing, onBack }) {
  const type = ENABLER_TYPES.find(t => t.id === enabler.type);
  const [filter, setFilter] = useState("all");
  const [qDesc, setQDesc] = useState("");
  const [qType, setQType] = useState("call");
  const [posting, setPosting] = useState(false);

  const submitQuickAdd = async () => {
    const text = qDesc.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      await onAddActivity(null, enabler.contact_id || null, { type: qType, description: text }, enabler.id);
      setQDesc("");
    } finally { setPosting(false); }
  };

  const filtered = activities.filter(a => filter === "all" || a.type === filter).slice().reverse();

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

      <div className="ai-summary">
        <div className="ai-summary-header">
          <div className="section-label">AI Summary</div>
          <button onClick={() => onGenerateSummary(enabler, activities)} className="btn-copy" disabled={summarizing}>{summarizing ? "Generating..." : "Generate Summary"}</button>
        </div>
        {enabler.ai_summary ? (
          <>
            <div className="ai-summary-text">{enabler.ai_summary}</div>
            <div className="ai-summary-updated">Last updated: {formatDate(enabler.ai_summary_updated_at)}</div>
          </>
        ) : (
          <div className="empty-small">No summary yet. Generate one from the activity history.</div>
        )}
      </div>

      <div className="quickadd">
        <div className="section-label">Quick Add</div>
        <div className="quickadd-row">
          <input
            className="input quickadd-input"
            placeholder="Log an update..."
            value={qDesc}
            onChange={e => setQDesc(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submitQuickAdd(); }}
          />
          <select className="input quickadd-type" value={qType} onChange={e => setQType(e.target.value)}>
            {ACT_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
          </select>
          <button onClick={submitQuickAdd} className="btn-primary" disabled={!qDesc.trim() || posting}>Add</button>
        </div>
      </div>

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
