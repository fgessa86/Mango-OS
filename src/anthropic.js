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
const callAnthropic = async (body, timeoutMs = RESEARCH_TIMEOUT_MS) => {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing VITE_ANTHROPIC_API_KEY");
  bumpApiCalls();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    if (e.name === "AbortError") throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
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

const webSearchText = async (content, maxTokens = 4000, timeoutMs) => {
  const data = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content }],
  }, timeoutMs);
  return extractText(data);
};

// Like webSearchText but also returns the real article URLs the web_search tool
// surfaced. The web_search_20250305 tool emits `web_search_tool_result` blocks
// whose `content` is an array of `web_search_result` items ({url, title}); text
// blocks additionally carry `citations` pointing at those same result URLs. We
// harvest both so callers can replace a model-guessed homepage link with the
// actual deep link to the story.
const webSearchTextWithSources = async (content, maxTokens = 4000, timeoutMs) => {
  const data = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content }],
  }, timeoutMs);
  return { text: extractText(data), sources: extractSearchSources(data) };
};

const extractSearchSources = (data) => {
  const sources = [];
  const push = (url, title) => { if (url) sources.push({ url: String(url), title: String(title || "") }); };
  for (const block of data?.content || []) {
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r && r.type === "web_search_result") push(r.url, r.title);
      }
    }
    if (block?.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) push(c?.url, c?.title || c?.cited_text);
    }
  }
  return sources;
};

const plainText = async (content, maxTokens = 2000, timeoutMs) => {
  const data = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  }, timeoutMs);
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

// Meeting prep brief (Feature 2): turns gathered CRM context into a short,
// scannable four-section brief. The exact section headings ("WHO:" etc.) are a
// contract with the React renderer, which formats "Heading:" lines and bullets.
export const generateMeetingBrief = async (context) => {
  const prompt = `Generate a concise meeting prep brief. Include: 1) WHO: name, role, relationship warmth, last interaction date. 2) CONTEXT: 3-4 sentence summary of the relationship history and recent discussions. 3) OPEN ITEMS: pending tasks or commitments involving this person. 4) SUGGESTED TALKING POINTS: 2-3 recommendations based on the history. Keep it scannable and short.

Format the response as plain text with exactly these four heading lines: "WHO:", "CONTEXT:", "OPEN ITEMS:", "SUGGESTED TALKING POINTS:". Under each heading use short plain sentences or "- " bullet lines. No markdown, no asterisks, no backticks. Do not use em dashes anywhere; use commas, periods, colons, or parentheses instead.

Here is the data:
${context}`;
  const text = await plainText(prompt, 600);
  if (!text) throw new Error("empty brief response");
  return text;
};

// Internal team meeting brief: a status roll-up instead of a relationship prep
// (auto-selected when a calendar event's attendees are all internal team). The
// four headings are a contract with the React renderer, same as the external brief.
export const generateInternalBrief = async (meetingTitle, context) => {
  const prompt = `Generate an internal team meeting brief for ${meetingTitle}. This is a sync with my own team, not an external prospect. Summarize: 1) PIPELINE MOVEMENT: what progressed, what's new, what stalled this week. 2) DECISIONS NEEDED: deals or issues that need team input or a decision. 3) BLOCKERS: anything I'm stuck on or need help with. 4) HIGHLIGHTS: wins or notable developments worth raising. Keep it crisp and scannable, suitable for a status update.

Format the response as plain text with exactly these four heading lines: "PIPELINE MOVEMENT:", "DECISIONS NEEDED:", "BLOCKERS:", "HIGHLIGHTS:". Under each heading use short plain sentences or "- " bullet lines. No markdown, no asterisks, no backticks. Do not use em dashes anywhere; use commas, periods, colons, or parentheses instead.

Here is the data:
${context}`;
  const text = await plainText(prompt, 600);
  if (!text) throw new Error("empty brief response");
  return text;
};

// Executive Update draft: synthesizes two weeks of raw CRM activity into crisp,
// executive-appropriate bullets. Executives want signal, not a log, so the
// prompt is explicit that this is a synthesis and that raw entries should be
// merged, ranked, and dropped rather than restated.
//
// The response contract is a JSON object keyed by section id, each holding an
// array of {title, content}. Returning structured data (rather than prose the
// app would have to parse) is what lets every bullet become its own editable
// block with its own title and body.
export const generateExecSummary = async (context) => {
  const prompt = `You are preparing a biweekly update that a VP of Commercial will present to the executive team of a healthcare company operating in Saudi Arabia. Below is the CRM data for the last two weeks.

Synthesize it. Do NOT restate the log. Merge related entries, drop noise (vendor marketing emails, calendar invite acceptances, and automated notifications are never worth reporting), and keep only what an executive would care about: momentum, risk, money, and relationships that open doors. If a section has nothing worth reporting, return an empty array rather than padding it.

Lead with the strongest signal: real meetings with decision-relevant people. Write for an audience with no context on individual contacts, so name the institution and why it matters, not just the person.

The MEETINGS HELD list has already been deduplicated, so treat each entry as one real meeting and never split or repeat one. For each meeting use its NOTES to write both a one-line outcome and the talking points.

Return ONLY a JSON object with exactly these keys:
{
  "meetings": [{
    "title": "meeting name, who it was with, and the date",
    "content": "ONE line: the outcome and why it matters",
    "talking_points": ["3 to 5 short substantive bullets from the notes, the detail he would speak to if an executive asks"]
  }],
  "bd_momentum": [{"title": "short headline, max 8 words", "content": "1-2 sentences on pipeline or relationship progress"}],
  "outreach": [{"title": "short headline", "content": "1 sentence on volume, channel, and who was targeted"}],
  "coming_up": [{"title": "what is coming", "content": "1 sentence on why it matters"}]
}

At most 5 meetings and at most 4 items in every other section, fewer if the data does not support more. Talking points must come from the meeting's own notes; if a meeting has no notes, return an empty talking_points array rather than inventing detail. No markdown, no asterisks, no backticks. Do not use em dashes anywhere; use commas, periods, colons, or parentheses instead.

Here is the data:
${context}`;
  const text = await plainText(prompt, 900);
  const cleaned = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const obj = JSON.parse(cleaned.slice(first, last + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch { return null; }
};

// Pulls a JSON ARRAY out of a model response (news briefing): strips markdown
// fences, keeps the substring from the first [ to the last ]. Returns null so
// callers can decide whether to surface a retry.
const parseJsonArray = (text) => {
  const cleaned = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = cleaned.indexOf("[");
  if (first === -1) return null;
  const last = cleaned.lastIndexOf("]");
  if (last > first) {
    try {
      const arr = JSON.parse(cleaned.slice(first, last + 1));
      if (Array.isArray(arr)) return arr;
    } catch { /* fall through to partial recovery */ }
  }
  // Partial recovery: the response was valid JSON until max_tokens cut it off
  // (no closing ]). Walk the array body and keep every complete top-level
  // {...} object, so a truncated response still yields the stories it did emit.
  return recoverJsonObjects(cleaned.slice(first + 1));
};

// Scans a string for complete, balanced top-level {...} objects (string-aware,
// so braces inside quoted values do not confuse the depth counter) and returns
// the ones that parse. Returns null if none are recoverable.
const recoverJsonObjects = (s) => {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try { objs.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip malformed */ }
        start = -1;
      }
    }
  }
  return objs.length ? objs : null;
};

const googleSearchLink = (headline) => `https://www.google.com/search?q=${encodeURIComponent(headline)}`;

// A "homepage" URL is a bare domain with no article path (e.g. https://forbes.com
// or https://forbes.com/). A real article deep-links to a path after the domain.
// Unparseable URLs are treated as homepages (unusable) so they get the fallback.
export const isHomepageUrl = (url) => {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "").toLowerCase() === "google.com") return false; // an intentional search link is fine
    return u.pathname.replace(/\/+$/, "") === "";
  } catch { return true; }
};

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from", "as", "is", "are", "new", "says", "study", "report"]);
const tokenize = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

// Picks the real article URL for a story: prefer the model's own url when it is
// already a deep link, otherwise match the story to one of the web-search result
// URLs (deep links only) by headline/title word overlap, with a bonus when the
// result's domain matches the story's stated source. Falls back to null so the
// caller can substitute a Google search link.
const pickArticleUrl = (story, sources = []) => {
  const modelUrl = String(story.url || "").trim();
  if (modelUrl && !isHomepageUrl(modelUrl)) return modelUrl;
  const headlineWords = tokenize(story.headline);
  const sourceWords = tokenize(story.source);
  let best = null, bestScore = 0;
  for (const s of sources) {
    if (!s.url || isHomepageUrl(s.url)) continue;
    const titleWords = tokenize(s.title);
    let score = headlineWords.filter((w) => titleWords.includes(w)).length;
    const domain = domainOf(s.url);
    if (sourceWords.some((w) => domain.includes(w))) score += 2;
    if (score > bestScore) { bestScore = score; best = s.url; }
  }
  return bestScore > 0 ? best : null;
};

const normalizeStories = (arr, { defaultSource = "", sources = [] } = {}) => arr
  .filter((s) => s && s.headline)
  .slice(0, 5)
  .map((s) => {
    const headline = String(s.headline);
    const url = pickArticleUrl(s, sources) || googleSearchLink(headline);
    return { headline, summary: String(s.summary || ""), source: String(s.source || "").trim() || defaultSource, url };
  });

// Final render-time guard (audit: news links pointed at homepages): if a story's
// resolved url is still a bare homepage (e.g. from an older cached payload), use
// a Google search link for the headline instead.
export const newsStoryHref = (story) => {
  const url = String(story?.url || "").trim();
  return url && !isHomepageUrl(url) ? url : googleSearchLink(String(story?.headline || ""));
};

// Daily news briefing (Feature 3): one web-search call per section, JSON-only
// response parsed to [{headline, summary, source, url}]. A longer timeout and
// higher max_tokens (fewer truncations) suit the slow web-search path. The
// article URL is taken from the model's deep link when it has one, else matched
// to the web_search result URLs. Throws so the UI can retry that one section.
export const fetchNewsStories = async (prompt, { maxTokens = 1500, timeoutMs = 90000 } = {}) => {
  const { text, sources } = await webSearchTextWithSources(prompt, maxTokens, timeoutMs);
  const arr = parseJsonArray(text);
  if (!arr) throw new Error("could not parse news stories");
  return normalizeStories(arr, { sources });
};

// Graceful fallback for a section that keeps failing the web-search path: a
// plain (no web search) call using the model's own knowledge. There are no
// search result URLs here, so a story without a real deep link gets a Google
// search link, and a blank source degrades to a label.
export const fetchNewsStoriesNoSearch = async (prompt) => {
  const text = await plainText(prompt, 1500);
  const arr = parseJsonArray(text);
  if (!arr) throw new Error("could not parse fallback news stories");
  return normalizeStories(arr, { defaultSource: "Model knowledge" });
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
