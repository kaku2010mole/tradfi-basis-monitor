"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { getDisplayLanguage, getServerLanguage, LANGUAGE_STORAGE_KEY, restoreDisplayLanguage, setDisplayLanguage, subscribeLanguage } from "../lib/languagePreference";
import type { PageTranslator } from "../lib/pageTranslation";

export default function GlobalTranslation() {
  const language = useSyncExternalStore(subscribeLanguage, getDisplayLanguage, getServerLanguage);
  const translator = useRef<PageTranslator | null>(null);
  useEffect(() => {
    restoreDisplayLanguage();
    const sync = (event: StorageEvent) => { if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) setDisplayLanguage(event.newValue === "zh-CN" ? "zh-CN" : "en", false); };
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("storage", sync); translator.current?.dispose(); translator.current = null; };
  }, []);
  useEffect(() => {
    let active = true;
    document.documentElement.lang = language;
    if (language === "en") translator.current?.setLanguage("en");
    else void import("../lib/pageTranslation").then(({ createPageTranslator }) => {
      if (!active) return;
      translator.current ??= createPageTranslator(document);
      translator.current.setLanguage(language);
    });
    return () => { active = false; };
  }, [language]);
  return null;
}
