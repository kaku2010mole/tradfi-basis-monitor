// One preference shared by every dashboard; no market-data state is touched.
export type DisplayLanguage = "en" | "zh-CN";
export const LANGUAGE_STORAGE_KEY = "tradfi-display-language";
let language: DisplayLanguage = "en";
const listeners = new Set<() => void>();
export const getDisplayLanguage = () => language;
export const getServerLanguage = (): DisplayLanguage => "en";
export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setDisplayLanguage(next: DisplayLanguage, persist = true) {
  if (next !== "en" && next !== "zh-CN") return;
  if (persist) { try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Private browsing still supports this session. */ } }
  if (language === next) return;
  language = next;
  for (const listener of listeners) listener();
}
export function restoreDisplayLanguage() {
  try { setDisplayLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) === "zh-CN" ? "zh-CN" : "en", false); } catch { /* English is the default. */ }
}
