// Vercel serverless function: transcribes a recorded voice clip via the OpenAI
// Whisper API. The API key must stay server-side (TRANSCRIBE_API_KEY), since
// this is a client-side Vite app with no other backend. Accepts a JSON body
// { audio: base64 string, mimeType: string } rather than raw multipart, since
// the client (VoiceRecorder) already has the recording as a Blob in memory
// and base64-JSON round-trips reliably through fetch on every mobile browser,
// including iOS Safari.
export const config = {
  maxDuration: 60,
};

// Picks a reasonable file extension for the multipart upload to Whisper,
// which infers the codec from the filename.
function extensionFor(mimeType) {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("mp4")) return "mp4";
  if (t.includes("aac")) return "aac";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("wav")) return "wav";
  return "webm";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const apiKey = process.env.TRANSCRIBE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Transcription is not configured. Add TRANSCRIBE_API_KEY in Vercel and redeploy." });
    return;
  }

  try {
    const body = req.body || {};
    const audio = typeof body.audio === "string" ? body.audio : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/webm";
    if (!audio) {
      res.status(400).json({ error: "No audio provided." });
      return;
    }

    let buffer;
    try {
      buffer = Buffer.from(audio, "base64");
    } catch {
      res.status(400).json({ error: "Audio was not valid base64 data." });
      return;
    }
    if (buffer.length === 0) {
      res.status(400).json({ error: "No audio captured. Try recording again." });
      return;
    }

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), `audio.${extensionFor(mimeType)}`);
    form.append("model", "whisper-1");

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!whisperRes.ok) {
      let detail = "";
      try { detail = (await whisperRes.json())?.error?.message || ""; } catch { /* non-JSON error body */ }
      res.status(whisperRes.status >= 400 && whisperRes.status < 600 ? whisperRes.status : 502).json({
        error: detail || `Transcription failed (${whisperRes.status}). Please try again.`,
      });
      return;
    }

    const data = await whisperRes.json();
    res.status(200).json({ text: (data.text || "").trim() });
  } catch (e) {
    res.status(500).json({ error: `Transcription error: ${e?.message || "unknown error"}. Please try again.` });
  }
}
