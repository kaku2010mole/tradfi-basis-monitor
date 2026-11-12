"use client";

import { useEffect } from "react";
import { preferredTheme, setDisplayTheme, THEME_STORAGE_KEY } from "../lib/themePreference";

export default function GlobalTheme() {
  useEffect(() => {
    setDisplayTheme(preferredTheme(), false);
    const syncStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setDisplayTheme(preferredTheme(), false);
    };
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystem = () => {
      try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        if (saved === "light" || saved === "dark") return;
      } catch { /* Continue following the system when storage is unavailable. */ }
      setDisplayTheme(system.matches ? "dark" : "light", false);
    };
    window.addEventListener("storage", syncStorage);
    system.addEventListener("change", syncSystem);
    return () => {
      window.removeEventListener("storage", syncStorage);
      system.removeEventListener("change", syncSystem);
    };
  }, []);
  return null;
}
