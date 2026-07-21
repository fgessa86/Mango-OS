export const formatDate = (d) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
export const formatDateTime = (d) => d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
export const formatFull = (d) => d ? new Date(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "";
export const formatTime = (d) => d ? new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
// True when two dates fall on the same calendar day.
export const isSameDay = (a, b) => a && b && new Date(a).toDateString() === new Date(b).toDateString();
export const daysAgo = (d) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 0;
export const isToday = (d) => d && new Date(d).toDateString() === new Date().toDateString();
export const isThisWeek = (d) => {
  if (!d) return false;
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  start.setHours(0, 0, 0, 0);
  return new Date(d) >= start;
};
export const isOverdue = (d) => {
  if (!d) return false;
  const due = new Date(d); due.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return due < today;
};

// <input type="datetime-local"> speaks local wall-clock time with no zone, so
// an ISO timestamp has to be shifted into local time to display and shifted
// back out on save. Used by the activity timeline's editable date, which is
// what makes back-dating an entry to when it actually happened possible.
export const toDateTimeLocal = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromDateTimeLocal = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Fathom recap marker: the Apps Script prefixes auto-imported meeting recaps
// with this token (kept in sync with FATHOM_MARKER in gmail-sync-updated.js).
// Shared so any surface that renders a raw description can strip it (M11).
export const FATHOM_MARKER = "[[FATHOM]]";
export const isFathomActivity = (a) => typeof a?.description === "string" && a.description.startsWith(FATHOM_MARKER);
export const stripFathomMarker = (desc) => {
  const d = desc || "";
  return d.startsWith(FATHOM_MARKER) ? d.slice(FATHOM_MARKER.length).replace(/^[ \t]+/, "") : d;
};

// Legacy calendar-event outcome marker. Outcome activities used to embed the
// event id in the description text; the linkage now lives ONLY in the
// activities.calendar_event_id column and nothing writes this marker any more.
// The reader is kept so a row written before the migration still resolves.
export const CALEVENT_MARKER_PREFIX = "[[CALEVENT:";
export const CALEVENT_MARKER_SUFFIX = "]]";
export const calendarEventIdFromActivity = (desc) => {
  const d = desc || "";
  if (!d.startsWith(CALEVENT_MARKER_PREFIX)) return null;
  const end = d.indexOf(CALEVENT_MARKER_SUFFIX);
  return end === -1 ? null : d.slice(CALEVENT_MARKER_PREFIX.length, end);
};
// The calendar event an activity belongs to. activities.calendar_event_id is
// the source of truth; the legacy description marker is only a fallback for a
// row that predates the column being populated.
export const activityCalendarEventId = (a) => a?.calendar_event_id || calendarEventIdFromActivity(a?.description);

// Any internal double-bracket token, anywhere in the string. Internal markers
// are plumbing ([[FATHOM]], the legacy [[CALEVENT:uuid]]) and must NEVER reach
// the user, so display goes through a blanket strip rather than a list of
// known prefixes: a marker that is new, repeated, or not at the start still
// gets removed instead of leaking into the timeline.
const INTERNAL_MARKER_RE = /\[\[[^\]]*\]\][ \t]*\n?/g;

// The human-readable text of an activity description: every internal marker
// removed, leading blank space tidied. This is the ONLY thing that should ever
// be rendered, previewed, copied into a report, or fed to an AI prompt.
export const cleanActivityText = (desc) => (desc || "").replace(INTERNAL_MARKER_RE, "").replace(/^[ \t\n]+/, "");
// Back-compat aliases: both older helpers now route through the same blanket
// strip, so any caller still reaching for one cannot reintroduce a leak.
export const stripCalendarEventMarker = cleanActivityText;
