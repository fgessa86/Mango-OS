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

// Stable lowercase ids; the Quick Add dropdown always saves `id`, never `label`.
// Unknown/legacy types (old data, or a type this list has since dropped) are
// handled gracefully wherever ACT_TYPES is looked up: a default icon/glyph and
// the raw type string are shown instead of breaking.
export const ACT_TYPES = [
  { id: "call", label: "Call", icon: "\u{1F4DE}" },
  { id: "email", label: "Email", icon: "\u{1F4E7}" },
  { id: "meeting", label: "Meeting", icon: "\u{1F91D}" },
  { id: "scheduled_meeting", label: "Scheduled Meeting", icon: "\u{1F4C5}" },
  { id: "whatsapp", label: "WhatsApp", icon: "\u{1F4AC}", color: "#25D366" },
  { id: "linkedin", label: "LinkedIn", icon: "in", color: "#0A66C2" },
  { id: "note", label: "Note", icon: "\u{1F4DD}" },
  { id: "proposal", label: "Proposal", icon: "\u{1F4C4}" },
  { id: "demo", label: "Demo", icon: "\u{1F5A5}" },
  { id: "voice_note", label: "Voice Note", icon: "\u{1F3A4}" },
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
// tab. An institution is always an organizations row; whether it is also a
// pipeline Target and/or an Enabler is captured by separate checkboxes (which
// create linked deals/enablers rows), NOT by the type. Field name for
// custom_options is "institution_type".
export const INSTITUTION_TYPES = [
  { id: "hospital", label: "Hospital", color: "#059669" },
  { id: "vc", label: "VC", color: "#8B5CF6" },
  { id: "government", label: "Government", color: "#0EA5E9" },
  { id: "tech_company", label: "Tech Company", color: "#6366F1" },
  { id: "payer", label: "Payer", color: "#A855F7" },
  { id: "regulator", label: "Regulator", color: "#3B82F6" },
  { id: "association", label: "Association", color: "#F97316" },
  { id: "research", label: "Research", color: "#14B8A6" },
  { id: "pharmaceutical", label: "Pharmaceutical", color: "#EC4899" },
];

// Relationship vocabulary for the "how are they connected to us" picker on the
// Add Person form (person-to-person and person-to-institution edges). Field
// name for custom_options is "relationship".
export const CONNECTION_RELATIONSHIPS = [
  { id: "can_introduce", label: "Can Introduce" },
  { id: "knows", label: "Knows" },
  { id: "works_with", label: "Works With" },
  { id: "board_overlap", label: "Board Overlap" },
];

// Pipeline tiers for deals. Stored as the raw string ("Tier 1"/"Untiered") on
// the deals.tier column, so the id IS the stored value. Field name for
// custom_options is not used (fixed vocabulary).
// bg/fg are the exact badge design tokens; color mirrors fg for the editable
// pill selector on the Deal Sheet.
export const DEAL_TIERS = [
  { id: "Tier 1", label: "Tier 1", color: "#B77400", bg: "#FDECCB", fg: "#B77400" },
  { id: "Tier 2", label: "Tier 2", color: "#2A6FDB", bg: "#E4EDFB", fg: "#2A6FDB" },
  { id: "Tier 3", label: "Tier 3", color: "#6B6B7B", bg: "#ECECEF", fg: "#6B6B7B" },
  { id: "Untiered", label: "Untiered", color: "#8A8072", bg: "#F1EADD", fg: "#8A8072" },
];

// Relationship vocabulary for person-to-person connections. Used as the label
// source for rendering an existing edge; the Connect form builds its own
// directional, name-templated option list (PERSON_CONNECTION_OPTIONS in
// App.jsx). Field name for custom_options is "relationship" (shared with the
// other relationship pickers).
export const PERSON_CONNECTION_RELATIONSHIPS = [
  { id: "can_introduce", label: "Can Introduce" },
  { id: "introduced_by", label: "Introduced By" },
  { id: "reports_to", label: "Reports To" },
  { id: "colleague", label: "Colleague" },
  { id: "knows", label: "Knows" },
  { id: "friend", label: "Friend" },
  { id: "works_with", label: "Works With" },
  { id: "family", label: "Family" },
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
  { id: "colleague", label: "Colleague" },
  { id: "friend", label: "Friend" },
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
  "Mecca", "Medina", "Tabuk", "Abha", "Dubai",
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
