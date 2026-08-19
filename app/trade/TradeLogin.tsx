"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./page.module.css";

export default function TradeLogin({
  configured,
  title = "Protected Execution",
  description = "Enter the separate execution password to continue.",
  returnHref = "/",
}: {
  configured: boolean;
  title?: string;
  description?: string;
  returnHref?: string;
}) {
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
      <p className={styles.eyebrow}>RESTRICTED LIVE EXECUTION</p>
      <h1>{title}</h1>
      <p>{description}</p>
      <form onSubmit={unlock}>
        <label>Execution password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
        <button disabled={!configured || loading || !password}>{loading ? "Unlocking…" : "Unlock execution page"}</button>
      </form>
      {!configured && <p className={styles.error}>Execution access is not configured on this deployment.</p>}
      {error && <p className={styles.error}>{error}</p>}
      <Link href={returnHref}>← Return to dashboard</Link>
    </section>
  </main>;
}
