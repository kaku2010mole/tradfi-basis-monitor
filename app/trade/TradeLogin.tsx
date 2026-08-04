"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./page.module.css";

export default function TradeLogin({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/trade-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Access denied.");
      window.location.reload();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : "Access denied.");
      setLoading(false);
    }
  };

  return <main className={styles.loginShell}>
    <section className={styles.loginCard}>
      <p className={styles.eyebrow}>RESTRICTED EXECUTION SURFACE</p>
      <h1>Binance Order Desk</h1>
      <p>This panel can submit signed USDⓈ-M Futures orders. Enter the separate trading password to continue.</p>
      <form onSubmit={unlock}>
        <label>Trading panel password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
        <button disabled={!configured || loading || !password}>{loading ? "Unlocking…" : "Unlock order desk"}</button>
      </form>
      {!configured && <p className={styles.error}>Trading access has not been configured on this deployment.</p>}
      {error && <p className={styles.error}>{error}</p>}
      <Link href="/oracle">← Return to Oracle Monitor</Link>
    </section>
  </main>;
}
