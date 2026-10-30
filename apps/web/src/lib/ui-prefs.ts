// UI preferences kept in plain cookies (not sensitive), readable by server and browser.
export type Theme = "system" | "light" | "dark";
export const THEME_COOKIE = "ulx_theme";
export const SIDEBAR_COOKIE = "ulx_sidebar";
export const OPEN_PALETTE_EVENT = "ulx:open-palette";
export const THEME_EVENT = "ulx:theme";

export function parseTheme(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
