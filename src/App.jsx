import { useState, useEffect, useCallback } from "react";
import { api } from "./supabase";
import { STAGES, ACT_TYPES, TAG_OPTIONS } from "./constants";
import { formatDate, formatFull, daysAgo, isToday, isThisWeek } from "./utils";
import "./styles.css";

export default function App() {
  const [view, setView] = useState("pipeline");
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [reportCopied, setReportCopied] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [contactSearch, setContactSearch] = useState("");
  const [contactTagFilter, setContactTagFilter] = useState("");
  const [toast, setToast] = useState(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  const loadData = useCallback(async () => {
    try {
      const [d, c, a] = await Promise.all([
        api("deals", "GET", null, "?select=*&order=created_at.desc"),
        api("contacts", "GET", null, "?select=*&order=name.asc"),
        api("activities", "GET", null, "?select=*&order=created_at.desc"),
      ]);
      setDeals(d || []); setContacts(c || []); setActivities(a || []);
    } catch (e) { showToast("Failed to load data"); }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // DEAL CRUD
  const saveDeal = async (form) => {
    try {
      const clean = {
        company: form.company,
        stage: form.stage || "prospecting",
        last_activity_at: new Date().toISOString(),
      };
      if (form.contact_id) clean.contact_id = form.contact_id;
      if (form.contact_name) clean.contact_name = form.contact_name;
      if (form.contact_role) clean.contact_role = form.contact_role;
      if (form.value && Number(form.value) > 0) clean.value = Number(form.value);
      if (form.notes) clean.notes = form.notes;
      if (form.next_action) clean.next_action = form.next_action;
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
      const clean = { name: form.name };
      if (form.role) clean.role = form.role;
      if (form.company) clean.company = form.company;
      if (form.email) clean.email = form.email;
      if (form.phone) clean.phone = form.phone;
      if (form.linkedin) clean.linkedin = form.linkedin;
      if (form.source) clean.source = form.source;
      if (form.notes) clean.notes = form.notes;
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

  // ACTIVITY
  const addActivity = async (dealId, contactId, activity) => {
    try {
      await api("activities", "POST", { deal_id: dealId, contact_id: contactId, ...activity });
      if (dealId) await api("deals", "PATCH", { last_activity_at: new Date().toISOString() }, `?id=eq.${dealId}`);
      if (contactId) await api("contacts", "PATCH", { last_contacted_at: new Date().toISOString() }, `?id=eq.${contactId}`);
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
          {[["pipeline","Pipeline"],["contacts","Contacts"],["reports","Reports"],["boss","Boss View"]].map(([k,l]) => (
            <button key={k} onClick={() => setView(k)} className={`nav-tab ${view === k ? "active" : ""}`}>{l}</button>
          ))}
        </nav>
      </header>

      <div className="stats-bar">
        {[[activeDeals.length,"Active Deals"],[totalValue > 0 ? `$${(totalValue/1000).toFixed(0)}K` : "N/A","Pipeline Value"],[contacts.length,"Contacts"],[deals.filter(d=>isToday(d.last_activity_at)).length,"Touched Today"],[deals.filter(d=>d.stage==="won").length,"Won"]].map(([v,l],i) => (
          <div key={i} className="stat"><div className="stat-value">{v}</div><div className="stat-label">{l}</div></div>
        ))}
      </div>

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
                        onClick={() => setModal({type:"deal-detail",data:deal})}
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
      {modal?.type === "deal-detail" && <DealDetail deal={modal.data} activities={activities.filter(a => a.deal_id === modal.data.id)} contacts={contacts} onMove={moveDeal} onEdit={(d) => setModal({type:"deal",data:d})} onDelete={deleteDeal} onActivity={(id) => setModal({type:"activity",data:{deal_id:id}})} onClose={() => setModal(null)} />}
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
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.company&&onSave(f)} className="btn-primary" disabled={!f.company}>{isEdit?"Save":"Add Deal"}</button></div>
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
      <div className="modal-actions"><button onClick={onClose} className="btn-sec">Cancel</button><button onClick={()=>f.name&&onSave(f)} className="btn-primary" disabled={!f.name}>{isEdit?"Save":"Add Contact"}</button></div>
    </div></div>
  );
}

function DealDetail({ deal, activities, contacts, onMove, onEdit, onDelete, onActivity, onClose }) {
  const stage = STAGES.find(s=>s.id===deal.stage);
  return (
    <div className="overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><div><div className="modal-title">{deal.company}</div>{deal.contact_name && <div className="modal-sub">{deal.contact_name}{deal.contact_role?` . ${deal.contact_role}`:""}</div>}</div><button onClick={onClose} className="close-btn">✕</button></div>
      <div className="badges">{stage && <span className="badge" style={{background:stage.color+"22",color:stage.color,border:`1px solid ${stage.color}44`}}>{stage.label}</span>}{deal.value>0&&<span className="badge val-badge">${Number(deal.value).toLocaleString()}</span>}<span className="badge date-badge">Created {formatDate(deal.created_at)}</span></div>
      {deal.notes && <div className="detail-notes">{deal.notes}</div>}
      {deal.next_action && <div className="next-box"><span className="next-label">Next:</span> {deal.next_action}</div>}
      <div className="section"><div className="section-label">Move to</div><div className="tags-select">{STAGES.filter(s=>s.id!==deal.stage).map(s=><button key={s.id} onClick={()=>{onMove(deal.id,s.id);onClose();}} className="tag-btn" style={{borderColor:s.color+"66",color:s.color}}>{s.label}</button>)}</div></div>
      <div className="detail-actions"><button onClick={()=>onActivity(deal.id)} className="btn-sec">+ Activity</button><button onClick={()=>onEdit(deal)} className="btn-sec">Edit</button><button onClick={()=>{if(confirm("Delete?"))onDelete(deal.id)}} className="btn-sec btn-danger">Delete</button></div>
      <div className="section-label">Activity History</div>
      <div className="activity-list">{activities.length===0?<div className="empty-small">No activities yet</div>:activities.slice().reverse().map(a=><div key={a.id} className="activity-item"><span>{ACT_TYPES.find(t=>t.id===a.type)?.icon||"."}</span><div><div className="act-desc">{a.description}</div><div className="act-date">{formatDate(a.created_at)}</div></div></div>)}</div>
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
