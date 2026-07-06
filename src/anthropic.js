const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;

export const generateSummary = async (prompt) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
};

// Researches an institution and returns { description, oncology_relevance,
// website, sector } or { unknown: true } if the model does not recognize it.
export const researchInstitution = async (name, city) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  const location = (city || "").trim() ? `${city}, Saudi Arabia` : "Saudi Arabia";
  const prompt = `Provide a brief 2-3 sentence description of ${name} in ${location}. Include what they do, their relevance to healthcare and oncology if any, their website URL, and their sector. Respond in JSON format: {description, oncology_relevance, website, sector}. If you don't know the institution, respond with {unknown: true}. Do not use em dashes anywhere; use commas, periods, colons, or parentheses instead.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { unknown: true };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { unknown: true };
  }
};

// Shared helper: run a web-search-enabled message and return the concatenated
// text of every text block, with any markdown code fences stripped.
const webSearchText = async (content, maxTokens = 4000) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
};

// Pulls the first balanced JSON object out of a model response, tolerating
// stray prose or markdown fences around it.
const parseJsonBlock = (text, fallback) => {
  const cleaned = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
};

// Web-search research for key people at an institution, split into clinical
// champions (oncologists) and decision makers, for an oncology data company.
export const researchKeyPeople = async (name, city) => {
  const location = (city || "").trim() ? `${city}, Saudi Arabia` : "Saudi Arabia";
  const content = `Research ${name} in ${location}. I need to find key people who would be relevant for a healthcare data and oncology analytics company. Focus on:\n\n1. CLINICAL CHAMPIONS (3-5 people): Oncologists specializing in breast cancer, lung cancer, or colorectal cancer. Include their full name, title, department, education background if findable, and any notable research or publications.\n\n2. DECISION MAKERS (3-5 people): Hospital leadership, heads of pharmacy, procurement directors, IT/digital health leads, CMOs, deputy directors, anyone involved in drug formulary decisions or technology partnerships.\n\nFor each person found, provide:\n- Full name\n- Title/role at the institution\n- Department\n- Education (if findable)\n- Notable research or publications (if applicable)\n- Why they would be relevant for an oncology data company\n- Confidence level: high (found on official sources), medium (found in publications/conferences), low (mentioned indirectly)\n\nRespond ONLY in JSON format, no markdown, no backticks:\n{"clinical_champions": [{"name": "", "title": "", "department": "", "education": "", "publications": "", "relevance": "", "confidence": ""}], "decision_makers": [{"name": "", "title": "", "department": "", "education": "", "relevance": "", "confidence": ""}], "institution_notes": ""}`;
  const text = await webSearchText(content, 4000);
  const parsed = parseJsonBlock(text, { clinical_champions: [], decision_makers: [], institution_notes: "" });
  return {
    clinical_champions: Array.isArray(parsed.clinical_champions) ? parsed.clinical_champions : [],
    decision_makers: Array.isArray(parsed.decision_makers) ? parsed.decision_makers : [],
    institution_notes: parsed.institution_notes || "",
  };
};

// Web-search for active oncology clinical trials at an institution.
export const researchClinicalTrials = async (name) => {
  const content = `Search for active clinical trials at ${name} in Saudi Arabia related to breast cancer, lung cancer, or colorectal cancer. List the trial names, NCT IDs, conditions, and sponsors. Respond ONLY in JSON format, no markdown, no backticks: {"trials": [{"name": "", "nct_id": "", "condition": "", "sponsor": ""}]}. If none are found, respond with {"trials": []}. Do not use em dashes anywhere; use commas, periods, colons, or parentheses instead.`;
  const text = await webSearchText(content, 2000);
  const parsed = parseJsonBlock(text, { trials: [] });
  return { trials: Array.isArray(parsed.trials) ? parsed.trials : [] };
};

export const summarizeImage = async (base64, prompt) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
};
