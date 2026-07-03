export const STAGES = [
  { id: "prospecting", label: "Prospecting", color: "#6B7280" },
  { id: "qualified", label: "Qualified", color: "#8B5CF6" },
  { id: "meeting_set", label: "Meeting Set", color: "#3B82F6" },
  { id: "meeting_done", label: "Meeting Done", color: "#06B6D4" },
  { id: "proposal", label: "Proposal", color: "#F59E0B" },
  { id: "negotiation", label: "Negotiation", color: "#F97316" },
  { id: "contracted", label: "Contracted", color: "#10B981" },
  { id: "won", label: "Won", color: "#22C55E" },
  { id: "lost", label: "Lost", color: "#EF4444" },
];

export const ACT_TYPES = [
  { id: "call", label: "Call", icon: "\u{1F4DE}" },
  { id: "email", label: "Email", icon: "\u{1F4E7}" },
  { id: "meeting", label: "Meeting", icon: "\u{1F91D}" },
  { id: "note", label: "Note", icon: "\u{1F4DD}" },
  { id: "proposal_sent", label: "Proposal", icon: "\u{1F4C4}" },
  { id: "demo", label: "Demo", icon: "\u{1F5A5}" },
  { id: "transcript", label: "Paste Transcript", icon: "\u{1F4CB}" },
];

export const ENABLER_TYPES = [
  { id: "vc", label: "VC", color: "#8B5CF6" },
  { id: "government", label: "Government", color: "#3B82F6" },
  { id: "research", label: "Research", color: "#06B6D4" },
  { id: "strategic_partner", label: "Strategic Partner", color: "#F59E0B" },
  { id: "accelerator", label: "Accelerator", color: "#10B981" },
  { id: "connector", label: "Connector", color: "#EC4899" },
];

export const TAG_OPTIONS = [
  "Decision Maker", "Technical Buyer", "Champion", "Influencer",
  "Gatekeeper", "End User", "C-Suite", "Government",
  "Private Sector", "Oncology", "Data", "Procurement"
];
