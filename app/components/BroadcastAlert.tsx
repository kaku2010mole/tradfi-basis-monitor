"use client";

import { useEffect } from "react";
import styles from "./BroadcastAlert.module.css";

type BroadcastAlertProps = {
  open: boolean;
  title: string;
  message: string;
  tone: "positive" | "negative";
  onDismiss: () => void;
};

export default function BroadcastAlert({ open, title, message, tone, onDismiss }: BroadcastAlertProps) {
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(onDismiss, 10_000);
    return () => window.clearTimeout(timer);
  }, [onDismiss, open]);

  if (!open) return null;
  return (
    <div className={`${styles.broadcast} ${tone === "positive" ? styles.positive : styles.negative}`} role="alert" aria-live="assertive">
      <div className={styles.beacon} aria-hidden="true"><i /><i /><i /></div>
      <div className={styles.copy}>
        <span>TRIGGER BROADCAST</span>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      <button onClick={onDismiss} aria-label="Dismiss trigger broadcast">Dismiss</button>
      <div className={styles.sweep} aria-hidden="true" />
    </div>
  );
}
