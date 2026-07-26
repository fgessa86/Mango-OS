/**
 * FATHOM NOTES COMPANION (Google Apps Script) - reference file, not part of the
 * Vite app.
 *
 * WHY THIS EXISTS: the sync script currently running in your Google account logs
 * each Fathom recap as a `Meeting (Fathom): "<title>"` ACTIVITY (with a
 * truncated excerpt in body_snippet), but does not create the full recap NOTE
 * and does not fill the meeting OUTCOME. This companion adds exactly those two
 * things, reading the Fathom email DIRECTLY from Gmail so it captures the FULL
 * recap (not the truncated excerpt), and it never creates activities, so it can
 * never duplicate the ones your existing sync already writes.
 *
 * HOW TO INSTALL:
 *   1. In the SAME Google Apps Script project as your existing sync, add a new
 *      file and paste this whole file in. (Every name here is suffixed `Fn_` so
 *      nothing collides with your existing functions.)
 *   2. It reads the same `SUPABASE_URL` and `SUPABASE_KEY` Script Properties your
 *      sync already uses. Nothing else to configure.
 *   3. Add a time-driven trigger for `syncFathomNotes` (hourly is fine). It is
 *      idempotent: it only creates a note when one does not already exist for
 *      the recap (matched by calendar event, else by the deterministic title),
 *      and only fills an outcome that is empty or was itself Fathom-filled, so a
 *      real outcome you typed is never overwritten.
 *
 * The note it writes has title "Fathom Recap, <title>, <date>", body the full
 * recap as the notes editor's HTML, and is tagged to the same contact/deal/
 * enabler your recap resolves to plus the matched calendar event, so it surfaces
 * as an openable card on the meeting module and the contact/institution sheets.
 */

const FN_FATHOM_SENDER = "no-reply@fathom.video";
const FN_FATHOM_MARKER = "[[FATHOM]]"; // must match FATHOM_MARKER in utils.js
const FN_OWNER_FIRST = "Fahed";
const FN_LOOKBACK_DAYS = 14; // re-scanning is safe: everything below is idempotent
const FN_MAX_THREADS = 50;

function syncFathomNotes() {
  const config = getFnConfig_();
  const contacts = fetchFn_(config, "contacts", "id,name,email,company");
  const deals = fetchFn_(config, "deals", "id,company,contact_id");
  const enablers = fetchFn_(config, "enablers", "id,name,contact_id");
  const events = fetchFn_(config, "calendar_events",
    "id,title,start_time,outcome_notes,matched_contact_id,matched_deal_id,matched_enabler_id,matched_organization_id");

  const query = `from:${FN_FATHOM_SENDER} subject:"Recap for" newer_than:${FN_LOOKBACK_DAYS}d`;
  const threads = GmailApp.search(query, 0, FN_MAX_THREADS);
  let touched = 0;
  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      if (extractEmailFn_(message.getFrom()) !== FN_FATHOM_SENDER) return;
      if (!/recap for/i.test(message.getSubject() || "")) return;
      if (processFathomNote_(config, message, contacts, deals, enablers, events)) touched++;
    });
  });
  Logger.log(`Fathom notes companion: ${threads.length} thread(s) scanned, ${touched} note(s)/outcome(s) written.`);
}

function processFathomNote_(config, message, contacts, deals, enablers, events) {
  const title = fathomTitleFn_(message.getSubject() || "");
  const dateLabel = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), "MMM d");
  const notes = extractFathomNotesFn_(message);
  if (!notes) return false;
  const sections = parseFathomSectionsFn_(notes);
  if (!sections.purpose && sections.takeaways.length === 0 && sections.actionItems.length === 0) return false;

  // Resolve the other participant to a contact, and follow through to a deal /
  // enabler, exactly like the main sync does.
  const contact = matchFathomContactFn_(title, contacts);
  const contactId = contact ? contact.id : null;
  const deal = contact ? deals.find((d) => d.contact_id === contact.id) : null;
  const enabler = contact ? enablers.find((e) => e.contact_id === contact.id) : null;
  const event = matchFathomEventFn_(title, message.getDate(), contactId, deal, enabler, events);

  const noteTitle = `Fathom Recap, ${title}, ${dateLabel}`;
  let wrote = false;
  if (!fathomNoteExistsFn_(config, event, noteTitle)) {
    postFn_(config, "notes", {
      title: noteTitle,
      content: fathomNotesToHtmlFn_(notes),
      // Prefer the recap's own resolution, fall back to the matched event's tags
      // so an unmatched-contact recap still lands on the meeting's entities.
      contact_id: contactId || (event ? event.matched_contact_id : null),
      deal_id: deal ? deal.id : (event ? event.matched_deal_id : null),
      enabler_id: enabler ? enabler.id : (event ? event.matched_enabler_id : null),
      organization_id: event ? event.matched_organization_id : null,
      calendar_event_id: event ? event.id : null,
      updated_at: new Date().toISOString(),
    });
    wrote = true;
  }
  // Fill the matched meeting's outcome (idempotent, never clobbers a real one).
  if (event && (!event.outcome_notes || event.outcome_notes.indexOf(FN_FATHOM_MARKER) === 0)) {
    const outcome = buildFathomOutcomeFn_(sections);
    if (outcome) {
      patchFn_(config, "calendar_events", `id=eq.${event.id}`, { outcome_notes: `${FN_FATHOM_MARKER} ${outcome}` });
      wrote = true;
    }
  }
  return wrote;
}

// ---- Parsing (mirrors the main sync's Fathom parsing) --------------------

// "Recap for \"Fahed / Gavin\"" -> "Fahed / Gavin".
function fathomTitleFn_(subject) {
  const m = subject.match(/recap for\s*[:\-]?\s*"?([^"]+?)"?\s*$/i);
  return (m ? m[1] : subject.replace(/^recap for\s*/i, "")).trim();
}

// Fathom puts the full recap in a hidden (display:none) preview div at the top
// of the HTML body. Pull that out and flatten it; fall back to the plain body.
function extractFathomNotesFn_(message) {
  const html = message.getBody() || "";
  const m = html.match(/<div[^>]*style=("|')[^"']*display\s*:\s*none[^"']*\1[^>]*>([\s\S]*?)<\/div>/i);
  let notes = m ? htmlToTextFn_(m[2]) : "";
  if (notes.replace(/\s/g, "").length < 40) notes = (message.getPlainBody() || "").trim();
  return notes;
}

function htmlToTextFn_(html) {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseFathomSectionsFn_(text) {
  const sections = { purpose: "", takeaways: [], actionItems: [], topics: [] };
  const purposeLines = [];
  let current = null;
  const headerFor = (line) => {
    const t = line.trim().toLowerCase().replace(/[:*_#]+$/, "").trim();
    if (t === "meeting purpose" || t === "purpose") return "purpose";
    if (t === "key takeaways" || t === "takeaways") return "takeaways";
    if (t === "action items" || t === "action item" || t === "next steps") return "actionItems";
    if (t === "topics" || t === "topic") return "topics";
    return null;
  };
  text.split("\n").forEach((raw) => {
    const t = raw.trim();
    if (!t) return;
    const h = headerFor(t);
    if (h) { current = h; return; }
    const item = t.replace(/^[-•*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (current === "purpose") purposeLines.push(t);
    else if (current === "takeaways") sections.takeaways.push(item);
    else if (current === "actionItems") sections.actionItems.push(item);
    else if (current === "topics") sections.topics.push(item);
  });
  sections.purpose = purposeLines.join(" ").trim();
  return sections;
}

// Full recap as the notes editor's HTML: recognized section names become
// headings, bullet lines become list items, everything else a paragraph.
function fathomNotesToHtmlFn_(notes) {
  const headingFor = (line) => {
    const t = line.trim().toLowerCase().replace(/[:*_#]+$/, "").trim();
    if (t === "meeting purpose" || t === "purpose") return "Meeting Purpose";
    if (t === "key takeaways" || t === "takeaways") return "Key Takeaways";
    if (t === "action items" || t === "action item" || t === "next steps") return "Action Items";
    if (t === "topics" || t === "topic") return "Topics";
    return null;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = [];
  let inList = false;
  const closeList = () => { if (inList) { html.push("</ul>"); inList = false; } };
  (notes || "").split("\n").forEach((raw) => {
    const t = raw.trim();
    if (!t) return;
    const h = headingFor(t);
    if (h) { closeList(); html.push(`<h3>${esc(h)}</h3>`); return; }
    if (/^[-•*]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${esc(t.replace(/^[-•*]\s+/, "").replace(/^\d+[.)]\s+/, ""))}</li>`);
      return;
    }
    closeList();
    html.push(`<p>${esc(t)}</p>`);
  });
  closeList();
  return html.join("");
}

// Short outcome summary: condensed purpose plus a few takeaways and action items.
function buildFathomOutcomeFn_(sections) {
  const parts = [];
  if (sections.purpose) parts.push(condenseSentencesFn_(sections.purpose, 2));
  if (sections.takeaways.length) parts.push("Key takeaways: " + sections.takeaways.slice(0, 5).join("; "));
  if (sections.actionItems.length) parts.push("Action items: " + sections.actionItems.slice(0, 5).join("; "));
  return parts.join("\n\n").trim();
}

function condenseSentencesFn_(text, maxSentences) {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]*/g) || [text];
  return sentences.slice(0, maxSentences).join(" ").trim();
}

// ---- Matching -------------------------------------------------------------

function matchFathomContactFn_(title, contacts) {
  const parts = title.split(/\s*[\/,&]\s*|\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
  const others = parts.filter((p) => !new RegExp(`^${FN_OWNER_FIRST}(\\s+al\\s+essa)?$`, "i").test(p));
  for (let i = 0; i < others.length; i++) {
    const name = others[i].toLowerCase();
    if (name.length < 2) continue;
    const found = contacts.find((c) => {
      const cn = (c.name || "").toLowerCase();
      if (!cn) return false;
      if (cn === name) return true;
      const first = cn.split(/\s+/)[0];
      return first === name || cn.indexOf(name) !== -1 || name.indexOf(first) !== -1;
    });
    if (found) return found;
  }
  return null;
}

// The calendar event this recap reports on: same day, matched to the resolved
// contact/deal/enabler, or whose title overlaps the recap title.
function matchFathomEventFn_(title, dateObj, contactId, deal, enabler, events) {
  if (!events || !events.length) return null;
  const tz = Session.getScriptTimeZone();
  const day = Utilities.formatDate(dateObj, tz, "yyyy-MM-dd");
  const sameDay = events.filter((e) => e.start_time && Utilities.formatDate(new Date(e.start_time), tz, "yyyy-MM-dd") === day);
  if (!sameDay.length) return null;
  const byContact = contactId && sameDay.find((e) => e.matched_contact_id === contactId);
  if (byContact) return byContact;
  const byDeal = deal && sameDay.find((e) => e.matched_deal_id === deal.id);
  if (byDeal) return byDeal;
  const byEnabler = enabler && sameDay.find((e) => e.matched_enabler_id === enabler.id);
  if (byEnabler) return byEnabler;
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return sameDay.find((e) => { const et = (e.title || "").toLowerCase(); return words.some((w) => et.indexOf(w) !== -1); }) || null;
}

// True when a note for this recap already exists (by event, else by title).
function fathomNoteExistsFn_(config, event, noteTitle) {
  const query = event
    ? `calendar_event_id=eq.${event.id}&select=id&limit=1`
    : `title=eq.${encodeURIComponent(noteTitle)}&select=id&limit=1`;
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/notes?${query}`, {
    method: "get", headers: supabaseHeadersFn_(config), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) return false;
  return JSON.parse(res.getContentText()).length > 0;
}

// ---- Supabase plumbing (uses the same script properties as your main sync) --

function getFnConfig_() {
  const props = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty("SUPABASE_URL");
  const supabaseKey = props.getProperty("SUPABASE_KEY");
  if (!supabaseUrl || !supabaseKey) throw new Error("Set SUPABASE_URL and SUPABASE_KEY in Project Settings > Script Properties.");
  return { supabaseUrl, supabaseKey };
}

function fetchFn_(config, table, select) {
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/${table}?select=${select}`, {
    method: "get", headers: supabaseHeadersFn_(config), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) { Logger.log(`fetchFn_(${table}) failed: ${res.getContentText()}`); return []; }
  return JSON.parse(res.getContentText());
}

function postFn_(config, table, body) {
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/${table}`, {
    method: "post", headers: { ...supabaseHeadersFn_(config), Prefer: "return=minimal" },
    contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) Logger.log(`postFn_(${table}) failed: ${res.getContentText()}`);
}

function patchFn_(config, table, query, body) {
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/${table}?${query}`, {
    method: "patch", headers: { ...supabaseHeadersFn_(config), Prefer: "return=minimal" },
    contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) Logger.log(`patchFn_(${table}) failed: ${res.getContentText()}`);
}

function supabaseHeadersFn_(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

function extractEmailFn_(fromHeader) {
  const match = fromHeader.match(/<(.+)>/);
  const email = (match ? match[1] : fromHeader).toLowerCase().trim();
  return email.includes("@") ? email : null;
}
