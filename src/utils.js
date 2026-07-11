export const formatDate = (d) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
export const formatDateTime = (d) => d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
export const formatFull = (d) => d ? new Date(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "";
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
