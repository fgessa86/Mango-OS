const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;

// Daily Anthropic API call counter, persisted in localStorage and reset at
// midnight (keyed by date). bumpApiCalls is called once per real request.
export const getApiCallsToday = () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const raw = JSON.parse(localStorage.getItem("mango-api-calls") || "{}");
    return raw.date === today ? (raw.count || 0) : 0;
  } catch { return 0; }
};
export const bumpApiCalls = () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const raw = JSON.parse(localStorage.getItem("mango-api-calls") || "{}");
    const count = raw.date === today ? (raw.count || 0) + 1 : 1;
    localStorage.setItem("mango-api-calls", JSON.stringify({ date: today, count }));
    window.dispatchEvent(new CustomEvent("mango-api-call", { detail: count }));
    return count;
  } catch { return 0; }
};

export const generateSummary = async (prompt, maxTokens = 500) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  bumpApiCalls();
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
  bumpApiCalls();
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
      max_tokens: 300,
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

// Web search can be slow, so allow a generous timeout before aborting.
const RESEARCH_TIMEOUT_MS = 60000;

// Low-level Anthropic call with a 60 second timeout, readable error messages,
// and a raw-response console.log for debugging in browser dev tools.
const callAnthropic = async (body) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  bumpApiCalls();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("request timed out after 60 seconds");
    throw new Error(e.message || "network error reaching Anthropic");
  }
  clearTimeout(timer);
  const data = await res.json().catch(() => null);
  // eslint-disable-next-line no-console
  console.log("[Research] raw Anthropic response:", data);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic API error ${res.status}`);
  }
  return data;
};

// Concatenate every text block from a (possibly multi-block) response. Web
// search responses interleave text, server_tool_use, and web_search_tool_result
// blocks, so we keep only the text and join it.
const extractText = (data) => (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

const webSearchText = async (content, maxTokens = 4000) => {
  const data = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content }],
  });
  return extractText(data);
};

const plainText = async (content, maxTokens = 2000) => {
  const data = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  });
  return extractText(data);
};

// Pulls a JSON object out of a model response: strips markdown fences, then
// keeps only the substring from the first { to the last }. Returns null (not a
// fallback) so callers can decide whether to retry.
const parseJsonBlock = (text) => {
  const cleaned = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return null;
  }
};

// Whatever fields parsed correctly are returned; missing or malformed fields
// degrade to empty so partial results still surface (graceful partial results).
const normalizeKeyPeople = (parsed) => ({
  clinical_champions: Array.isArray(parsed?.clinical_champions) ? parsed.clinical_champions : [],
  decision_makers: Array.isArray(parsed?.decision_makers) ? parsed.decision_makers : [],
  institution_notes: (parsed && parsed.institution_notes) || "",
});

const KEY_PEOPLE_SHAPE = `{"clinical_champions": [{"name": "", "title": "", "department": "", "education": "", "publications": "", "relevance": "", "confidence": ""}], "decision_makers": [{"name": "", "title": "", "department": "", "education": "", "relevance": "", "confidence": ""}], "institution_notes": ""}`;

// Research key people at an institution: clinical champions (oncologists) and
// decision makers, for an oncology data company. Tries a web search first; on
// any failure (timeout, tool error, unparseable response) it automatically
// retries once WITHOUT web search using the model's training knowledge. The
// optional onStatus callback lets the UI show "Retrying without web search...".
export const researchKeyPeople = async (name, city, onStatus = () => {}) => {
  const location = (city || "").trim() ? `${city}, Saudi Arabia` : "Saudi Arabia";
  const webPrompt = `Research ${name} in ${location}. I need to find key people who would be relevant for a healthcare data and oncology analytics company. Focus on:\n\n1. CLINICAL CHAMPIONS (3-5 people): Oncologists specializing in breast cancer, lung cancer, or colorectal cancer. Include their full name, title, department, education background if findable, and any notable research or publications.\n\n2. DECISION MAKERS (3-5 people): Hospital leadership, heads of pharmacy, procurement directors, IT/digital health leads, CMOs, deputy directors, anyone involved in drug formulary decisions or technology partnerships.\n\nFor each person found, provide:\n- Full name\n- Title/role at the institution\n- Department\n- Education (if findable)\n- Notable research or publications (if applicable)\n- Why they would be relevant for an oncology data company\n- Confidence level: high (found on official sources), medium (found in publications/conferences), low (mentioned indirectly)\n\nRespond ONLY in JSON format, no markdown, no backticks:\n${KEY_PEOPLE_SHAPE}`;

  let webErr;
  try {
    const parsed = parseJsonBlock(await webSearchText(webPrompt, 4000));
    if (parsed) return normalizeKeyPeople(parsed);
    webErr = new Error("could not parse the research results");
  } catch (e) {
    webErr = e;
  }

  // Retry once without web search, using the model's own knowledge.
  onStatus("Retrying without web search...");
  const simplePrompt = `Based on what you already know about ${name} in ${location}, list key people relevant to a healthcare data and oncology analytics company: 3 to 5 clinical champions (oncologists in breast, lung, or colorectal cancer) and 3 to 5 decision makers (hospital leadership, heads of pharmacy, procurement, IT or digital health leads, CMOs). If you are not certain, give your best knowledge and mark confidence low. Respond ONLY in JSON, no markdown, no backticks:\n${KEY_PEOPLE_SHAPE}\nDo not use em dashes anywhere; use commas, periods, colons, or parentheses instead.`;
  try {
    const parsed = parseJsonBlock(await plainText(simplePrompt, 2000));
    if (parsed) return normalizeKeyPeople(parsed);
    throw new Error("could not parse the research results");
  } catch (fallbackErr) {
    throw new Error(webErr?.message || fallbackErr?.message || "unknown error");
  }
};

// Web-search for active oncology clinical trials at an institution. Best effort:
// falls back to model knowledge if the web search fails, and never throws (an
// empty list is a valid, non-blocking result for this supplementary section).
export const researchClinicalTrials = async (name) => {
  const shape = `{"trials": [{"name": "", "nct_id": "", "condition": "", "sponsor": ""}]}`;
  const content = `Search for active clinical trials at ${name} in Saudi Arabia related to breast cancer, lung cancer, or colorectal cancer. List the trial names, NCT IDs, conditions, and sponsors. Respond ONLY in JSON format, no markdown, no backticks: ${shape}. If none are found, respond with {"trials": []}. Do not use em dashes anywhere; use commas, periods, colons, or parentheses instead.`;
  try {
    const parsed = parseJsonBlock(await webSearchText(content, 2000));
    if (parsed) return { trials: Array.isArray(parsed.trials) ? parsed.trials : [] };
  } catch { /* fall back below */ }
  try {
    const parsed = parseJsonBlock(await plainText(content, 1500));
    return { trials: Array.isArray(parsed?.trials) ? parsed.trials : [] };
  } catch {
    return { trials: [] };
  }
};

export const summarizeImage = async (base64, prompt) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  bumpApiCalls();
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
      max_tokens: 500,
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

// Section 9: turn a raw voice-note transcription into a clean, structured record.
// Returns { summary, action_items: [{title, priority, due_date_hint}] }. The raw
// transcription is never shown to the user; only this digested result is.
export const digestVoiceNote = async (transcript) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  const prompt = `You are turning a raw voice note (recorded right after a meeting or call) into a structured record. Produce two things:

1. SUMMARY: a clean 2 to 4 sentence summary written in the past tense and third person. Fix grammar, remove filler words, and keep only what matters.
2. ACTION ITEMS: every follow up or task mentioned, as a JSON array where each element is {"title": string, "priority": "high" | "medium" | "low", "due_date_hint": string}. Use an empty string for due_date_hint when no timing was mentioned. Return an empty array when there are no action items.

Respond with JSON only, no markdown and no backticks, in exactly this shape: {"summary": string, "action_items": array}. Do not use em dashes anywhere; use commas, periods, colons, or parentheses instead.

Here is the raw transcription:
${transcript}`;
  bumpApiCalls();
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
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const data = await res.json();
  let text = data.content?.[0]?.text?.trim() || "";
  // Strip any markdown code fences the model may have added before parsing.
  text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : text);
  return {
    summary: (parsed.summary || "").trim(),
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
  };
};
