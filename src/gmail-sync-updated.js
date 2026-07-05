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

  const label = getOrCreateLabel_(GMAIL_LABEL_NAME);
  const threads = GmailApp.search(
    `${SYNC_LOOKBACK_QUERY} -label:${GMAIL_LABEL_NAME.replace("/", "-")}`,
    0,
    MAX_THREADS_PER_RUN
  );

  let logged = 0;
  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      if (logActivityForMessage_(config, message, deals, contacts, enablers)) logged++;
    });
    thread.addLabel(label);
  });

  Logger.log(`Sync complete: ${threads.length} thread(s) scanned, ${logged} activit(y/ies) logged.`);
}

function logActivityForMessage_(config, message, deals, contacts, enablers) {
  const fromHeader = message.getFrom();
  const senderEmail = extractEmail_(fromHeader);
  if (!senderEmail) return false;

  const senderDomain = senderEmail.split("@")[1];
  if (!senderDomain || FREE_MAIL_DOMAINS.has(senderDomain)) return false;

  const contact = contacts.find((c) => (c.email || "").toLowerCase() === senderEmail);
  // Same domain-to-name matching pattern for both deals and enablers.
  const deal = matchByDomain_(deals, senderDomain, (d) => d.company);
  const enabler = matchByDomain_(enablers, senderDomain, (e) => e.name);

  if (!contact && !deal && !enabler) return false;

  const contactId = (contact && contact.id)
    || (deal && deal.contact_id)
    || (enabler && enabler.contact_id)
    || null;

  postTable_(config, "activities", {
    type: "email",
    description: `Email: "${message.getSubject()}" from ${fromHeader}`,
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
