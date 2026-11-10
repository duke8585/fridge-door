import { signal } from "./signal";

type Theme = "light" | "dark";
const storageKey = "fd-theme";
const system = window.matchMedia("(prefers-color-scheme: dark)");
let preference: Theme | undefined;
try {
  const saved = localStorage.getItem(storageKey);
  if (saved === "light" || saved === "dark") preference = saved;
} catch {
  // Storage can be unavailable in private browsing.
}

export const theme = signal<Theme>(preference ?? (system.matches ? "dark" : "light"));
const apply = (value: Theme): void => {
  document.documentElement.dataset.theme = value;
  theme.set(value);
};
apply(theme.get());
system.addEventListener("change", () => {
  if (preference === undefined) apply(system.matches ? "dark" : "light");
});

export function toggleTheme(): void {
  preference = theme.get() === "dark" ? "light" : "dark";
  apply(preference);
  try {
    localStorage.setItem(storageKey, preference);
  } catch {
  }
}
