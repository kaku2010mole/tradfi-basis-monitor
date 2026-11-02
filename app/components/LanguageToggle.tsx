"use client";

import { useSyncExternalStore } from "react";
import { getDisplayLanguage, getServerLanguage, setDisplayLanguage, subscribeLanguage } from "../lib/languagePreference";
import styles from "./LanguageToggle.module.css";

export default function LanguageToggle() {
  const language = useSyncExternalStore(subscribeLanguage, getDisplayLanguage, getServerLanguage);
  const chinese = language === "zh-CN";
  return <button type="button" className={styles.toggle} translate="no" data-no-translate="true"
    aria-label={chinese ? "Switch all pages to English" : "Translate all pages to Chinese"}
    aria-pressed={chinese} title={chinese ? "恢复英文 / Switch to English" : "一键翻译为中文 / Translate to Chinese"}
    onClick={() => setDisplayLanguage(chinese ? "en" : "zh-CN")}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 5h11M8 3v2m-3 3c1 4 3.5 6.5 7 8M12 5c-.5 5-3.5 9-8 12M13 21l4-10 4 10m-6.5-4h5" /></svg>
    <span>{chinese ? "English" : "中文"}</span>
  </button>;
}
