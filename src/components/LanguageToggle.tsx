import { useI18n, type Locale } from "../i18n";

type Props = {
  compact?: boolean;
};

export function LanguageToggle({ compact = false }: Props) {
  const { locale, setLocale, t } = useI18n();

  const pick = (next: Locale) => {
    if (next !== locale) setLocale(next);
  };

  return (
    <div
      className={`language-toggle${compact ? " compact" : ""}`}
      role="group"
      aria-label={t("lang.label")}
    >
      <button
        type="button"
        className={locale === "cs" ? "lang-btn active" : "lang-btn"}
        aria-pressed={locale === "cs"}
        onClick={() => pick("cs")}
      >
        CS
      </button>
      <button
        type="button"
        className={locale === "en" ? "lang-btn active" : "lang-btn"}
        aria-pressed={locale === "en"}
        onClick={() => pick("en")}
      >
        EN
      </button>
    </div>
  );
}
