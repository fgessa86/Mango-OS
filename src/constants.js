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

export const PRIORITIES = [
  { id: "high", label: "High", color: "#EF4444" },
  { id: "medium", label: "Medium", color: "#F59E0B" },
  { id: "low", label: "Low", color: "#7B8A9E" },
];

export const ORG_TYPES = [
  { id: "competitor", label: "Competitor", color: "#EF4444" },
  { id: "market_player", label: "Market Player", color: "#22C55E" },
  { id: "regulator", label: "Regulator", color: "#3B82F6" },
  { id: "payer", label: "Payer", color: "#A855F7" },
  { id: "association", label: "Association", color: "#F97316" },
  { id: "research", label: "Research", color: "#14B8A6" },
  { id: "government", label: "Government", color: "#0EA5E9" },
  { id: "hospital", label: "Hospital", color: "#059669" },
];

// The unified "everything is an institution" type vocabulary for the Network
// tab: target/enabler route to the deals/enablers tables on creation (see
// addInstitution), everything else routes to organizations. Field name for
// custom_options is "institution_type".
export const INSTITUTION_TYPES = [
  { id: "target", label: "Target", color: "#F59E0B" },
  { id: "enabler", label: "Enabler", color: "#8B5CF6" },
  { id: "competitor", label: "Competitor", color: "#EF4444" },
  { id: "payer", label: "Payer", color: "#A855F7" },
  { id: "government", label: "Government", color: "#0EA5E9" },
  { id: "regulator", label: "Regulator", color: "#3B82F6" },
  { id: "association", label: "Association", color: "#F97316" },
  { id: "research", label: "Research", color: "#14B8A6" },
  { id: "hospital", label: "Hospital", color: "#059669" },
];

export const DEAL_ENABLER_RELATIONSHIPS = [
  { id: "can_introduce", label: "Can Introduce" },
  { id: "active", label: "Active" },
  { id: "institutional", label: "Institutional" },
];

export const NETWORK_EDGE_RELATIONSHIPS = [
  { id: "works_at", label: "Works At" },
  { id: "board_member", label: "Board Member" },
  { id: "advisor", label: "Advisor" },
  { id: "knows", label: "Knows" },
  { id: "can_introduce", label: "Can Introduce" },
  { id: "reports_to", label: "Reports To" },
  { id: "subsidiary", label: "Subsidiary" },
  { id: "parent", label: "Parent" },
  { id: "board_overlap", label: "Board Overlap" },
  { id: "partnership", label: "Partnership" },
  { id: "competitor_to", label: "Competitor To" },
  { id: "regulates", label: "Regulates" },
  { id: "funds", label: "Funds" },
  { id: "invested_in", label: "Invested In" },
  { id: "custom", label: "Custom" },
];

export const SAUDI_CITIES = [
  "Riyadh", "Jeddah", "Dammam", "Dhahran", "Al Khobar",
  "Mecca", "Medina", "Tabuk", "Abha",
];

export const REGIONS = ["Central", "Western", "Eastern", "Northern", "Southern"];

export const STRENGTHS = [
  { id: "strong", label: "Strong", color: "#22C55E" },
  { id: "medium", label: "Medium", color: "#F59E0B" },
  { id: "weak", label: "Weak", color: "#94A3B8" },
  { id: "unknown", label: "Unknown", color: "#64748B" },
];

export const WARMTH_LEVELS = [
  { id: "unknown", label: "Unknown", color: "#94A3B8" },
  { id: "cold", label: "Cold", color: "#3B82F6" },
  { id: "warm", label: "Warm", color: "#F59E0B" },
  { id: "hot", label: "Hot", color: "#F97316" },
  { id: "active", label: "Active", color: "#22C55E" },
];

export const TAG_OPTIONS = [
  "Decision Maker", "Technical Buyer", "Champion", "Influencer",
  "Gatekeeper", "End User", "C-Suite", "Government",
  "Private Sector", "Oncology", "Data", "Procurement", "Internal Team"
];
