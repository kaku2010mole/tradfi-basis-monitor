"use client";
import { useEffect, useState } from "react";

type Status = { authorized?: boolean; messages?: number; lastMessageAt?: number; refreshedAt?: number; tokenExpiresAt?: number;
  connections?: string[]; receivedSymbols?: string[]; missingSymbols?: string[]; storage?: string; error?: string };
const at = (value?: number) => value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong", hour12: false }) + " HKT" : "—";
export default function PosleyConnectPage() {
  const [status, setStatus] = useState<Status>({}), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    if (new URLSearchParams(location.search).has("error")) setError("Authorization did not complete. Please start again; no credentials were returned to this page.");
    const load = async () => {
      try {
        const response = await fetch("/api/posley-cloud/status", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Cloud service unavailable.");
        if (!stopped) {
          setStatus(body);
          if (!new URLSearchParams(location.search).has("error")) setError("");
        }
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : "Status unavailable."); }
    };
    void load(); const timer = setInterval(() => void load(), 5_000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  async function connect() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/posley-cloud/connect", { method: "POST", cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not start login.");
      location.assign(body.url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Login unavailable."); setBusy(false); }
  }
  return <main style={{ maxWidth: 850, margin: "48px auto", padding: 28, background: "white", borderRadius: 20, color: "#18332c" }}>
    <a href="/stock-basis">← Stock cross-venue basis</a>
    <h1>Posley cloud connection</h1>
    <p>Render connects directly to the Posley gateway. The market feed keeps running when this browser or the local Posley relay is closed.</p>
    <p><strong>{status.authorized ? "Server authorization saved" : "Authorization required"}</strong> · {status.connections?.join(" / ") || "Not connected"}</p>
    <button onClick={() => void connect()} disabled={busy} style={{ padding: "14px 24px", borderRadius: 10, border: 0, background: "#007e60", color: "white", fontWeight: 700, cursor: "pointer" }}>
      {busy ? "Opening Posley…" : status.authorized ? "Reconnect Posley with Google" : "Authorize Posley with Google"}
    </button>
    {(error || status.error) && <p role="alert" style={{ color: "#ad3528" }}>{error || status.error}</p>}
    <dl style={{ lineHeight: 1.9 }}>
      <dt>Credential storage</dt><dd>{status.storage || "Render persistent disk only"} · never sent to your browser</dd>
      <dt>Cloud messages received</dt><dd>{status.messages?.toLocaleString() ?? "0"}</dd>
      <dt>Latest cloud message</dt><dd>{at(status.lastMessageAt)}</dd>
      <dt>Latest authorization / renewal</dt><dd>{at(status.refreshedAt)}</dd>
      <dt>Current ID token expires</dt><dd>{at(status.tokenExpiresAt)} · automatically renewed by Render</dd>
      <dt>Symbols received</dt><dd>{status.receivedSymbols?.join(", ") || "Waiting"}</dd>
      <dt>Not yet received</dt><dd>{status.missingSymbols?.join(", ") || "None"}</dd>
    </dl>
    <p>Posley may require another Google login when its renewable authorization expires or is revoked. Futu OpenD remains a separate feed; this connection does not move Futu to the cloud.</p>
  </main>;
}
