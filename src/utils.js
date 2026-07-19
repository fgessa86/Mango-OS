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

// Fathom recap marker: the Apps Script prefixes auto-imported meeting recaps
// with this token (kept in sync with FATHOM_MARKER in gmail-sync-updated.js).
// Shared so any surface that renders a raw description can strip it (M11).
export const FATHOM_MARKER = "[[FATHOM]]";
export const isFathomActivity = (a) => typeof a?.description === "string" && a.description.startsWith(FATHOM_MARKER);
export const stripFathomMarker = (desc) => {
  const d = desc || "";
  return d.startsWith(FATHOM_MARKER) ? d.slice(FATHOM_MARKER.length).replace(/^[ \t]+/, "") : d;
};

// Calendar-event outcome marker: logging a meeting outcome from the calendar
// event detail panel prefixes the activity description with this token (the
// event id it belongs to), so the timeline can link back to the event without
// a dedicated calendar_event_id column on activities.
export const CALEVENT_MARKER_PREFIX = "[[CALEVENT:";
export const CALEVENT_MARKER_SUFFIX = "]]";
export const calendarEventIdFromActivity = (desc) => {
  const d = desc || "";
  if (!d.startsWith(CALEVENT_MARKER_PREFIX)) return null;
  const end = d.indexOf(CALEVENT_MARKER_SUFFIX);
  return end === -1 ? null : d.slice(CALEVENT_MARKER_PREFIX.length, end);
};
export const stripCalendarEventMarker = (desc) => {
  const d = desc || "";
  if (!d.startsWith(CALEVENT_MARKER_PREFIX)) return d;
  const end = d.indexOf(CALEVENT_MARKER_SUFFIX);
  if (end === -1) return d;
  return d.slice(end + CALEVENT_MARKER_SUFFIX.length).replace(/^[ \t\n]+/, "");
};
// Strips whichever known marker prefix (Fathom recap or calendar-event
// outcome) an activity description carries, for any place that just wants the
// human-readable content (AI prompts, plain-text previews, etc).
export const cleanActivityText = (desc) => stripFathomMarker(stripCalendarEventMarker(desc));
