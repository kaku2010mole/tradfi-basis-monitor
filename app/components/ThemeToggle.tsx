"use client";

import { useSyncExternalStore } from "react";
import { getDisplayTheme, getServerTheme, setDisplayTheme, subscribeTheme } from "../lib/themePreference";
import styles from "./PageSwitcher.module.css";

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getDisplayTheme, getServerTheme);
  const dark = theme === "dark";
  const label = dark ? "Switch to light mode" : "Switch to dark mode";

  return <button type="button" className={styles.themeToggle} aria-label={label}
    aria-pressed={dark} title={dark ? "浅色模式 / Light mode" : "深色模式 / Dark mode"}
    translate="no" data-no-translate="true" onClick={() => setDisplayTheme(dark ? "light" : "dark")}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      {dark ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
        : <path d="M20.7 13A8.8 8.8 0 0 1 11 3.3 8.8 8.8 0 1 0 20.7 13Z" />}
    </svg>
    <span>{dark ? "Light" : "Dark"}</span>
  </button>;
}
