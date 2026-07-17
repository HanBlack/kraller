import { cs, type MessageTree } from "./messages/cs";
import { en } from "./messages/en";
import { getLocale } from "./store";
import type { Locale } from "./types";

type Params = Record<string, string | number>;

const dictionaries: Record<Locale, MessageTree> = { cs, en };

function lookup(dict: MessageTree, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = dict;
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  let out = text;
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

export function translate(
  key: string,
  params?: Params,
  locale: Locale = getLocale(),
): string {
  const text =
    lookup(dictionaries[locale], key) ??
    lookup(dictionaries.cs, key) ??
    key;
  return interpolate(text, params);
}

export function t(
  key: string,
  params?: Params,
  locale?: Locale,
): string {
  return translate(key, params, locale ?? getLocale());
}

export function dateLocale(locale: Locale = getLocale()): string {
  return locale === "en" ? "en-GB" : "cs-CZ";
}
