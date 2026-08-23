/**
 * Theme picker — a compact dropdown of palette swatches for the top nav.
 * Uses the useTheme hook so selection persists across reloads.
 */
import { useEffect, useRef, useState } from "react";
import { THEMES, useTheme } from "./theme";

export default function ThemeSwitcher() {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const active = THEMES.find((t) => t.id === theme) || THEMES[0];

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="theme-switcher" ref={rootRef}>
      <button
        type="button"
        className="theme-switcher-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${active.label}. Click to change.`}
        title={`Theme: ${active.label}`}
      >
        <span
          className="theme-swatch"
          style={{
            background: `linear-gradient(135deg, ${active.swatch[0]}, ${active.swatch[1]})`,
          }}
          aria-hidden="true"
        />
        <span className="theme-switcher-label">{active.label}</span>
        <span className="theme-switcher-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="theme-menu" role="menu">
          <div className="theme-menu-heading">Choose a theme</div>
          <div className="theme-menu-grid">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitemradio"
                aria-checked={t.id === theme}
                className={`theme-option${t.id === theme ? " active" : ""}`}
                onClick={() => {
                  setTheme(t.id);
                  setOpen(false);
                }}
                title={t.label}
              >
                <span
                  className="theme-swatch theme-swatch-lg"
                  style={{
                    background: `linear-gradient(135deg, ${t.swatch[0]}, ${t.swatch[1]})`,
                  }}
                  aria-hidden="true"
                >
                  {t.id === theme && <span className="theme-swatch-check">✓</span>}
                </span>
                <span className="theme-option-label">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
