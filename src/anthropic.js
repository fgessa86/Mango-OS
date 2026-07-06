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
