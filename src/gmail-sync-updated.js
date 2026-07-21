/**
 * Mango OS, Gmail to Supabase activity sync (Google Apps Script)
 *
 * NOTE: This is a from-scratch reference implementation, not a patch to an
 * existing script (none was available to extend). It follows the schema and
 * conventions of the Mango OS React app (see src/supabase.js, src/constants.js)
 * so field names and tables line up, but the actual sender-matching heuristics
 * here are a reasonable default, not a guaranteed match for whatever matching
 * logic your original script used. Review before relying on it.
 *
 * What it does:
 *   1. Scans recent Gmail threads for messages.
 *   2. Matches the sender's email/domain against Supabase contacts, deals,
 *      and enablers (enablers use the exact same domain-matching pattern as
 *      deals, this is the piece that's new).
 *   3. Logs a matched email as an "email" activity, linked to whichever of
 *      contact_id / deal_id / enabler_id it matched.
 *   4. Labels processed threads so they're never logged twice.
 *   5. Auto-ingests Fathom meeting recaps: emails from no-reply@fathom.video
 *      with a "Recap for ..." subject are parsed (Meeting Purpose, Key
 *      Takeaways, Action Items) into a structured "meeting" activity against
 *      the matched contact/deal/enabler, and each action item assigned to
 *      Fahed becomes a todo. The activity description is prefixed with the
 *      FATHOM_MARKER token so the React app can show a Fathom badge and render
 *      the structured body with light formatting (see ActivityDescription in
 *      src/App.jsx). Recaps are de-duplicated by title + date so re-scanning
 *      the same email never logs it twice.
 *
 * SETUP:
 *   1. In the Apps Script editor: Project Settings > Script Properties, add
 *      SUPABASE_URL and SUPABASE_KEY (the same values as src/supabase.js).
 *      Do not hardcode the key in source: script properties keep it out of
 *      any copy/paste or version history of this file.
 *   2. Run `setup()` once to create the Gmail label and a time-driven trigger
 *      (defaults to every 15 minutes). Re-running it is safe / idempotent.
 *   3. To sync manually, run `syncGmailToMango()` directly.
 */

const GMAIL_LABEL_NAME = "MangoOS/Synced";
const SYNC_LOOKBACK_QUERY = "newer_than:2d";
const MAX_THREADS_PER_RUN = 50;

// Fathom recap detection. The marker MUST match FATHOM_MARKER in src/App.jsx:
// the React app strips it and shows a Fathom badge on the activity.
const FATHOM_SENDER = "no-reply@fathom.video";
const FATHOM_MARKER = "[[FATHOM]]";
// The activity owner. Action items assigned to this person become todos, and
// this name is removed from the recap title when matching the other participant.
const OWNER_NAME = "Fahed Al Essa";
const OWNER_FIRST = "Fahed";

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);

function setup() {
  getOrCreateLabel_(GMAIL_LABEL_NAME);

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "syncGmailToMango")
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("syncGmailToMango")
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log("Setup complete: label + 15-minute trigger installed.");
}

function syncGmailToMango() {
  const config = getConfig_();
  const deals = fetchTable_(config, "deals", "id,company,contact_id,contact_name");
  const contacts = fetchTable_(config, "contacts", "id,name,email,company");
  const enablers = fetchTable_(config, "enablers", "id,name,contact_id,contact_name");

  // Fathom recaps run first (matched by sender, independent of the synced label).
  processFathomRecaps_(config, contacts, deals, enablers);

  const label = getOrCreateLabel_(GMAIL_LABEL_NAME);
  const threads = GmailApp.search(
    `${SYNC_LOOKBACK_QUERY} -label:${GMAIL_LABEL_NAME.replace("/", "-")}`,
    0,
    MAX_THREADS_PER_RUN
  );

  // Captured BEFORE any work, so anything that arrives mid-run is still picked
  // up next time rather than being skipped by its own run's mark.
  const runStartedAt = new Date();

  let logged = 0;
  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      if (logActivityForMessage_(config, message, deals, contacts, enablers)) logged++;
    });
    thread.addLabel(label);
  });

  setLastSyncMark_(runStartedAt);
  Logger.log(`Sync complete: ${threads.length} thread(s) scanned, ${logged} activit(y/ies) logged.`);
}

function logActivityForMessage_(config, message, deals, contacts, enablers) {
  const fromHeader = message.getFrom();
  const senderEmail = extractEmail_(fromHeader);
  if (!senderEmail) return false;
  // Fathom recaps are handled by processFathomRecaps_, not the generic logger.
  if (senderEmail === FATHOM_SENDER) return false;

  const senderDomain = senderEmail.split("@")[1];
  if (!senderDomain || FREE_MAIL_DOMAINS.has(senderDomain)) return false;
  // Already considered on a previous run: never add it again.
  if (olderThanLastSync_(message.getDate())) return false;

  const contact = contacts.find((c) => (c.email || "").toLowerCase() === senderEmail);
  // Same domain-to-name matching pattern for both deals and enablers.
  const deal = matchByDomain_(deals, senderDomain, (d) => d.company);
  const enabler = matchByDomain_(enablers, senderDomain, (e) => e.name);

  if (!contact && !deal && !enabler) return false;

  const contactId = (contact && contact.id)
    || (deal && deal.contact_id)
    || (enabler && enabler.contact_id)
    || null;

  const description = `Email: "${message.getSubject()}" from ${fromHeader}`;
  // Do not resurrect something the user deleted in the app. The thread label
  // normally stops a re-scan, but a relabel, a restored backup, or a second
  // message on the thread can still bring us back here.
  if (activityDismissed_(config, "email", message.getDate(), description)) return false;

  postTable_(config, "activities", {
    type: "email",
    description: description,
    contact_id: contactId,
    deal_id: deal ? deal.id : null,
    enabler_id: enabler ? enabler.id : null,
  });

  const now = new Date().toISOString();
  if (deal) patchTable_(config, "deals", `id=eq.${deal.id}`, { last_activity_at: now });
  if (enabler) patchTable_(config, "enablers", `id=eq.${enabler.id}`, { last_activity_at: now });
  if (contactId) patchTable_(config, "contacts", `id=eq.${contactId}`, { last_contacted_at: now });

  return true;
}

/* ============================================================
   Fathom meeting recap ingestion
   ============================================================ */

// Scans for Fathom recap emails and logs each as a structured meeting activity
// (plus todos for the owner's action items). Matched by sender, so it works
// regardless of the MangoOS/Synced label the generic pass applies.
function processFathomRecaps_(config, contacts, deals, enablers) {
  const query = `from:${FATHOM_SENDER} subject:"Recap for" ${SYNC_LOOKBACK_QUERY}`;
  const threads = GmailApp.search(query, 0, MAX_THREADS_PER_RUN);
  let logged = 0;
  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      if (extractEmail_(message.getFrom()) !== FATHOM_SENDER) return;
      const subject = message.getSubject() || "";
      if (!/recap for/i.test(subject)) return;
      if (processOneFathomRecap_(config, message, subject, contacts, deals, enablers)) logged++;
    });
  });
  Logger.log(`Fathom: ${threads.length} thread(s) scanned, ${logged} recap(s) logged.`);
  return logged;
}

function processOneFathomRecap_(config, message, subject, contacts, deals, enablers) {
  const title = fathomTitleFromSubject_(subject);
  const dateLabel = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), "MMM d");

  const notes = extractFathomNotes_(message);
  if (!notes) return false;
  const sections = parseFathomSections_(notes);
  if (!sections.purpose && sections.takeaways.length === 0 && sections.actionItems.length === 0) return false;

  // Step 6: skip if this recap (same title + date) was already logged, was
  // dismissed by the user in the app, or predates the last successful run.
  if (fathomActivityExists_(config, title, dateLabel)) return false;
  if (olderThanLastSync_(message.getDate())) return false;
  if (activityDismissed_(config, "meeting", message.getDate(), `${title} (${dateLabel})`)) return false;

  const description = buildFathomDescription_(title, dateLabel, sections);

  // Step 3: match the other participant in the title to a contact, and follow
  // that contact through to a linked deal / enabler.
  const contact = matchFathomContact_(title, contacts);
  const contactId = contact ? contact.id : null;
  const deal = contact ? deals.find((d) => d.contact_id === contact.id) : null;
  const enabler = contact ? enablers.find((e) => e.contact_id === contact.id) : null;

  // Step 4: log the meeting activity.
  postTable_(config, "activities", {
    type: "meeting",
    description: description,
    contact_id: contactId,
    deal_id: deal ? deal.id : null,
    enabler_id: enabler ? enabler.id : null,
  });

  const now = new Date().toISOString();
  if (deal) patchTable_(config, "deals", `id=eq.${deal.id}`, { last_activity_at: now });
  if (enabler) patchTable_(config, "enablers", `id=eq.${enabler.id}`, { last_activity_at: now });
  if (contactId) patchTable_(config, "contacts", `id=eq.${contactId}`, { last_contacted_at: now });

  // Step 5: turn the owner's action items into todos.
  createFathomTodos_(config, sections.actionItems, deal ? deal.id : null, enabler ? enabler.id : null, contactId);

  return true;
}

// "Recap for \"Fahed / Gavin\"" -> "Fahed / Gavin".
function fathomTitleFromSubject_(subject) {
  const m = subject.match(/recap for\s*[:\-]?\s*"?([^"]+?)"?\s*$/i);
  return (m ? m[1] : subject.replace(/^recap for\s*/i, "")).trim();
}

// Fathom puts the full recap in a hidden (display:none) preview div at the top
// of the HTML body. Pull that out and flatten it to plain text; fall back to the
// message's plain body if the hidden div is missing or too short.
function extractFathomNotes_(message) {
  const html = message.getBody() || "";
  const m = html.match(/<div[^>]*style=("|')[^"']*display\s*:\s*none[^"']*\1[^>]*>([\s\S]*?)<\/div>/i);
  let notes = m ? htmlToText_(m[2]) : "";
  if (notes.replace(/\s/g, "").length < 40) {
    notes = (message.getPlainBody() || "").trim();
  }
  return notes;
}

function htmlToText_(html) {
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

// Splits the recap into { purpose, takeaways[], actionItems[], topics[] } by
// walking lines and switching section on a recognized heading.
function parseFathomSections_(text) {
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

// Structured, deterministic description (so re-scans dedup cleanly). Purpose is
// condensed to two sentences; takeaways/action items are capped for brevity.
function buildFathomDescription_(title, dateLabel, sections) {
  const parts = [`${FATHOM_MARKER} ${title} (${dateLabel})`];
  if (sections.purpose) parts.push(`Purpose: ${condenseSentences_(sections.purpose, 2)}`);
  if (sections.takeaways.length) {
    parts.push("Key Takeaways:\n" + sections.takeaways.slice(0, 5).map((t) => `- ${t}`).join("\n"));
  }
  if (sections.actionItems.length) {
    parts.push("Action Items:\n" + sections.actionItems.slice(0, 8).map((a) => `- ${a}`).join("\n"));
  }
  return parts.join("\n\n");
}

function condenseSentences_(text, maxSentences) {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]*/g) || [text];
  return sentences.slice(0, maxSentences).join(" ").trim();
}

// Parses the recap title for the non-owner participant(s) and finds a contact
// whose name matches (exact, first-name, or substring).
function matchFathomContact_(title, contacts) {
  const parts = title.split(/\s*[\/,&]\s*|\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
  const others = parts.filter((p) => !new RegExp(`^${OWNER_FIRST}(\\s+al\\s+essa)?$`, "i").test(p));
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

// Step 5: one todo per action item assigned to the owner. Priority is "high"
// when a deadline is present, "medium" otherwise; a parsed date becomes due_date.
function createFathomTodos_(config, actionItems, dealId, enablerId, contactId) {
  actionItems.forEach((item) => {
    if (!new RegExp(OWNER_FIRST, "i").test(item)) return;
    const due = parseFathomDueDate_(item);
    postTable_(config, "todos", {
      title: cleanActionTitle_(item),
      priority: due ? "high" : "medium",
      status: "open",
      due_date: due || null,
      deal_id: dealId || null,
      enabler_id: enablerId || null,
      contact_id: contactId || null,
    });
  });
}

function cleanActionTitle_(item) {
  return item
    .replace(/^\[?\s*fahed(\s+al\s+essa)?\s*\]?\s*[:\-–]\s*/i, "")
    .replace(/^\(?\s*fahed(\s+al\s+essa)?\s*\)?\s+(to|will|should)\s+/i, "")
    .trim() || item;
}

// Best-effort natural-language due date -> "yyyy-MM-dd" (mirrors parseDueHint in
// the React app). Returns null when nothing matches.
function parseFathomDueDate_(text) {
  const t = text.toLowerCase();
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const iso = (d) => Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
  if (/\btoday\b/.test(t)) return iso(now);
  if (/\btomorrow\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return iso(d); }
  if (/end of (the )?week/.test(t)) { const d = new Date(now); const add = ((5 - d.getDay() + 7) % 7) || 5; d.setDate(d.getDate() + add); return iso(d); }
  if (/\bnext week\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 7); return iso(d); }
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${days[i]}\\b`).test(t)) {
      const d = new Date(now); let add = (i - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add); return iso(d);
    }
  }
  const isoMatch = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mn = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (mn) {
    const mon = months[mn[1]]; const day = parseInt(mn[2], 10); const yr = now.getFullYear();
    let d = new Date(yr, mon, day); if (d < now) d = new Date(yr + 1, mon, day);
    return iso(d);
  }
  return null;
}

// Dedup helper: should this recap be skipped? True when a matching activity
// already exists, OR when the user deliberately deleted (or edited) the one we
// logged before. The React app records that in sync_dismissals so a manual
// delete is not undone by the next run, which would otherwise recreate the row
// forever since this pass dedupes on the description prefix.
function fathomActivityExists_(config, title, dateLabel) {
  const prefix = `${FATHOM_MARKER} ${title} (${dateLabel})`;
  if (syncDismissed_(config, prefix)) return true;
  const query = `type=eq.meeting&select=id&limit=1&description=like.${encodeURIComponent(prefix.replace(/[%_]/g, " "))}*`;
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/activities?${query}`, {
    method: "get",
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) return false;
  return JSON.parse(res.getContentText()).length > 0;
}

// Has the user dismissed this synced item in the app (deleted or edited the
// activity it produced)? The app writes one sync_dismissals row per deleted
// activity; this is the tombstone check that stops a deleted item from
// silently coming back on the next run.
function syncDismissed_(config, syncKey) {
  const query = `select=id&limit=1&sync_key=eq.${encodeURIComponent(syncKey)}`;
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/sync_dismissals?${query}`, {
    method: "get",
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) return false;
  return JSON.parse(res.getContentText()).length > 0;
}

// Tombstone key for a generic activity. MUST match syncDismissalKey in
// src/App.jsx exactly: "type|YYYY-MM-DD|body", where body is the whole
// description with all whitespace collapsed to single spaces and capped at
// 180 characters. That is the contract between the two files; changing it on
// one side silently stops deleted items from staying deleted.
function activityDismissKey_(type, date, description) {
  const body = String(description || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const day = Utilities.formatDate(date, "UTC", "yyyy-MM-dd");
  return `${type}|${day}|${body}`;
}

function activityDismissed_(config, type, date, description) {
  return syncDismissed_(config, activityDismissKey_(type, date, description));
}

// High-water mark: the timestamp of the last successful run, kept in script
// properties. Anything older than this has already been considered once, so
// re-adding it can only ever be a duplicate or something the user removed on
// purpose. This is the belt to the tombstone table's braces.
function lastSyncMark_() {
  const raw = PropertiesService.getScriptProperties().getProperty("LAST_SYNC_AT");
  return raw ? new Date(raw) : null;
}

function setLastSyncMark_(when) {
  PropertiesService.getScriptProperties().setProperty("LAST_SYNC_AT", (when || new Date()).toISOString());
}

// True when this item predates the high-water mark and so must not be added.
// The first ever run has no mark and processes the normal lookback window.
function olderThanLastSync_(date) {
  const mark = lastSyncMark_();
  return !!mark && date && date.getTime() <= mark.getTime();
}

// Normalizes a company/enabler name to bare alphanumerics and checks whether
// the sender's domain root contains it (or vice versa), e.g. "BECO Capital"
// -> "becocapital", matched against domain root "becocapital" from
// jp@becocapital.com.
function matchByDomain_(records, domain, nameGetter) {
  const domainRoot = domain.split(".")[0].toLowerCase();
  return records.find((r) => {
    const name = (nameGetter(r) || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return name.length > 2 && (domainRoot.includes(name) || name.includes(domainRoot));
  }) || null;
}

function extractEmail_(fromHeader) {
  const match = fromHeader.match(/<(.+)>/);
  const email = (match ? match[1] : fromHeader).toLowerCase().trim();
  return email.includes("@") ? email : null;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty("SUPABASE_URL");
  const supabaseKey = props.getProperty("SUPABASE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Set SUPABASE_URL and SUPABASE_KEY in Project Settings > Script Properties before running.");
  }
  return { supabaseUrl, supabaseKey };
}

function fetchTable_(config, table, select) {
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/${table}?select=${select}`, {
    method: "get",
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    Logger.log(`fetchTable_(${table}) failed: ${res.getContentText()}`);
    return [];
  }
  return JSON.parse(res.getContentText());
}

function postTable_(config, table, body) {
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/${table}`, {
    method: "post",
    headers: { ...supabaseHeaders_(config), Prefer: "return=minimal" },
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) Logger.log(`postTable_(${table}) failed: ${res.getContentText()}`);
}

function patchTable_(config, table, query, body) {
  const res = UrlFetchApp.fetch(`${config.supabaseUrl}/rest/v1/${table}?${query}`, {
    method: "patch",
    headers: { ...supabaseHeaders_(config), Prefer: "return=minimal" },
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) Logger.log(`patchTable_(${table}) failed: ${res.getContentText()}`);
}

function supabaseHeaders_(config) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
  };
}
