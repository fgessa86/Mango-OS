const SUPABASE_URL = "https://dhvrqpsjralylcphtrmu.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRodnJxcHNqcmFseWxjcGh0cm11Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4OTE1OTEsImV4cCI6MjA5ODQ2NzU5MX0.1YlBS-TesxZJ9EzN4RDDgOhs2G6dJa6CUr4HRLKlOgA";

export const api = async (table, method = "GET", body = null, query = "") => {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
  if (method === "POST" || method === "PATCH") headers["Prefer"] = "return=representation";
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
