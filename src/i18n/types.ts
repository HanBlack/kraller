export type Locale = "cs" | "en";

export const LOCALES: Locale[] = ["cs", "en"];

export const LOCALE_STORAGE_KEY = "kraller-locale";

export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "cs";
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith("cs") || lang.startsWith("sk")) return "cs";
  return "en";
}
