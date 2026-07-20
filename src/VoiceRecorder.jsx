import { useState, useRef, useEffect } from "react";
import { digestVoiceNote } from "./anthropic";

// iOS Safari records audio/mp4 (aac); Chrome and Firefox record audio/webm
// (opus). Pick whichever the browser actually supports rather than assuming
// one format, so recording works the same on every mobile browser.
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
function pickSupportedMimeType() {
  if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined" || !window.MediaRecorder.isTypeSupported) return "";
  return CANDIDATE_MIME_TYPES.find((t) => window.MediaRecorder.isTypeSupported(t)) || "";
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result || "";
    const comma = result.indexOf(",");
    resolve(comma === -1 ? result : result.slice(comma + 1));
  };
  reader.onerror = () => reject(new Error("Could not read the recording."));
  reader.readAsDataURL(blob);
});

export const formatRecSeconds = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// One shared recorder used everywhere audio capture is needed: Quick Add,
// meeting outcomes, prep notes, note bodies, entity scratchpads, task titles.
// Records real audio via MediaRecorder (not the Web Speech API, which iOS
// Safari and most non-Chrome mobile browsers do not support at all) and
// uploads it to /api/transcribe (a Vercel function wrapping OpenAI Whisper),
// since the transcription key must stay server-side. `mode="digest"`
// additionally runs the transcript through Claude for a clean summary plus
// action items (meeting outcomes, voice notes); `mode="plain"` just hands
// back the raw transcript for dictation into a field (note body, task title,
// prep notes), which the caller appends to its target.
export default function VoiceRecorder({ mode = "plain", onPlainText, onDigest, showToast = () => {}, compact = false, title }) {
  const [state, setState] = useState("idle"); // idle | recording | transcribing | digesting | error
  const [seconds, setSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const mimeTypeRef = useRef("");
  const lastBlobRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  const transcribe = async (blob) => {
    setState("transcribing");
    try {
      const base64 = await blobToBase64(blob);
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: base64, mimeType: blob.type || "audio/webm" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status}).`);
      const text = (data.text || "").trim();
      if (!text) { lastBlobRef.current = null; setErrorMsg("No speech detected. Try again."); setState("error"); return; }
      lastBlobRef.current = null;
      if (mode === "digest") {
        setState("digesting");
        try {
          const result = await digestVoiceNote(text);
          onDigest && onDigest({ summary: result.summary || text, action_items: result.action_items || [] });
        } catch {
          showToast("Error processing voice note, saved the raw transcript instead");
          onDigest && onDigest({ summary: text, action_items: [] });
        }
      } else {
        onPlainText && onPlainText(text);
      }
      setState("idle");
    } catch (e) {
      setErrorMsg(e.message || "Transcription failed.");
      setState("error");
    }
  };

  const startRecording = async () => {
    setErrorMsg("");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setErrorMsg(e && (e.name === "NotAllowedError" || e.name === "PermissionDeniedError")
        ? "Microphone access denied. Enable it in your browser settings."
        : "Could not access the microphone on this device.");
      setState("error");
      return;
    }
    streamRef.current = stream;
    const mimeType = pickSupportedMimeType();
    mimeTypeRef.current = mimeType;
    let rec;
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setErrorMsg("Recording is not supported in this browser.");
      setState("error");
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    mediaRecorderRef.current = rec;
    rec.start();
    setState("recording");
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  };

  const stopRecording = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    rec.onstop = () => {
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeTypeRef.current || "audio/webm" });
      chunksRef.current = [];
      if (blob.size === 0) { setErrorMsg("No audio captured. Try again."); setState("error"); return; }
      lastBlobRef.current = blob;
      transcribe(blob);
    };
    if (rec.state !== "inactive") rec.stop();
    else rec.onstop();
  };

  const retry = () => {
    if (lastBlobRef.current) transcribe(lastBlobRef.current);
    else { setState("idle"); setErrorMsg(""); }
  };

  const dismiss = () => { setState("idle"); setErrorMsg(""); lastBlobRef.current = null; };

  const micTap = () => {
    if (state === "recording") stopRecording();
    else if (state === "idle" || state === "error") startRecording();
  };

  const busy = state === "transcribing" || state === "digesting";
  const label = state === "recording" ? "Stop recording" : "Record";
  const icon = state === "recording" ? "⏹" : busy ? "..." : "🎙";

  return (
    <div className={`voice-recorder ${compact ? "voice-recorder-compact" : ""}`}>
      <button
        type="button"
        className={`voice-recorder-btn ${compact ? "voice-recorder-btn-compact" : ""} ${state === "recording" ? "recording" : ""}`}
        onClick={micTap}
        disabled={busy}
        title={title || label}
      >
        {icon}
      </button>
      {state === "recording" && (
        <span className="voice-recorder-status">
          <span className="voice-rec-dot" />
          {formatRecSeconds(seconds)}
        </span>
      )}
      {state === "transcribing" && <span className="voice-recorder-status">Transcribing...</span>}
      {state === "digesting" && <span className="voice-recorder-status">Processing...</span>}
      {state === "error" && (
        <span className="voice-recorder-error">
          {errorMsg}
          {lastBlobRef.current && <button type="button" className="link-btn" onClick={retry}>Retry</button>}
          <button type="button" className="link-btn" onClick={dismiss}>Dismiss</button>
        </span>
      )}
    </div>
  );
}
