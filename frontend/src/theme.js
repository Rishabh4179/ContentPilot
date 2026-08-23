/**
 * Theme system — persists the chosen palette to localStorage and reflects it
 * on <html data-theme="…">. Keep THEMES in sync with the [data-theme="…"]
 * blocks in styles.css.
 */
import { useCallback, useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "contentpilot-theme";

export const THEMES = [
  { id: "midnight", label: "Midnight", swatch: ["#6366f1", "#8b5cf6"], mode: "dark" },
  { id: "ocean", label: "Ocean", swatch: ["#22d3ee", "#0ea5e9"], mode: "dark" },
  { id: "forest", label: "Forest", swatch: ["#34d399", "#10b981"], mode: "dark" },
  { id: "sunset", label: "Sunset", swatch: ["#fb923c", "#f43f5e"], mode: "dark" },
  { id: "rose", label: "Rose", swatch: ["#f472b6", "#a855f7"], mode: "dark" },
  { id: "nord", label: "Nord", swatch: ["#88c0d0", "#81a1c1"], mode: "dark" },
  { id: "mono", label: "Mono", swatch: ["#a1a1aa", "#71717a"], mode: "dark" },
  { id: "light", label: "Daylight", swatch: ["#6366f1", "#8b5cf6"], mode: "light" },
];

export const DEFAULT_THEME = "midnight";

const VALID = new Set(THEMES.map((t) => t.id));

/** Read the persisted theme (falls back to default). Safe on server/no-storage. */
export function getStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && VALID.has(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

/** Apply a theme id to the document root immediately. */
export function applyTheme(id) {
  const theme = VALID.has(id) ? id : DEFAULT_THEME;
  document.documentElement.setAttribute("data-theme", theme);
  const mode = THEMES.find((t) => t.id === theme)?.mode || "dark";
  document.documentElement.style.colorScheme = mode;
}

/** React hook returning [theme, setTheme]. Persists + applies on change. */
export function useTheme() {
  const [theme, setThemeState] = useState(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const setTheme = useCallback((id) => {
    if (VALID.has(id)) setThemeState(id);
  }, []);

  return [theme, setTheme];
}
