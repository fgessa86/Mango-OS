export const formatDate = (d) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
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
