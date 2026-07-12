// Theme selector (Auto / Light / Dark). Writes the choice to <html data-theme>
// (removed for Auto so the device preference wins) and persists to localStorage.

const THEME_KEY = "th-theme";
const THEME_OPTS = [
  ["auto", "◐", "Auto"],
  ["light", "☀", "Light"],
  ["dark", "☾", "Dark"],
];

export function currentTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {}
  return "auto";
}

export function themeToggleHtml() {
  const mode = currentTheme();
  return `<div class="theme-toggle" role="group" aria-label="Theme">
    ${THEME_OPTS.map(
      ([id, glyph, label]) =>
        `<button data-theme-opt="${id}" title="${label}" aria-label="${label}" aria-pressed="${mode === id}" class="${mode === id ? "active" : ""}">${glyph}</button>`
    ).join("")}
  </div>`;
}

export function wireThemeToggle(container = document) {
  container.querySelectorAll("[data-theme-opt]").forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.themeOpt;
      const root = document.documentElement;
      if (mode === "auto") root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", mode);
      try { localStorage.setItem(THEME_KEY, mode); } catch {}
      btn.closest(".theme-toggle").querySelectorAll("button").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      });
    };
  });
}
