export type DisplayTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "tradfi-display-theme";

let theme: DisplayTheme = "light";
const listeners = new Set<() => void>();

export const getDisplayTheme = () => theme;
export const getServerTheme = (): DisplayTheme => "light";

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function preferredTheme(): DisplayTheme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* The system preference also works when browser storage is unavailable. */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setDisplayTheme(next: DisplayTheme, persist = true) {
  if (next !== "light" && next !== "dark") return;
  document.documentElement.dataset.theme = next;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Keep this session's selection. */ }
  }
  if (theme === next) return;
  theme = next;
  for (const listener of listeners) listener();
}

export const THEME_INIT_SCRIPT = `(function(){var theme;try{theme=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}if(theme!=="light"&&theme!=="dark")theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=theme})()`;
