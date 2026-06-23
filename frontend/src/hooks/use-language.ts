import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export type AppLang = "en" | "zh";

/**
 * Current UI language + a toggle that flips en⇄zh and persists to localStorage.
 * Derives `lang` from `i18n.language` each render (useTranslation re-renders on
 * `languageChanged`), so consumers stay in sync without a separate state mirror.
 * Single source for the zh-detection rule + the `lang` persistence key.
 */
export function useLanguageToggle(): { lang: AppLang; toggle: () => void } {
  const { i18n } = useTranslation();
  const lang: AppLang = i18n.language?.startsWith("zh") ? "zh" : "en";
  const toggle = useCallback(() => {
    const next: AppLang = i18n.language?.startsWith("zh") ? "en" : "zh";
    void i18n.changeLanguage(next);
    try {
      localStorage.setItem("lang", next);
    } catch {
      /* ignore persistence failures (private mode etc.) */
    }
  }, [i18n]);
  return { lang, toggle };
}

/** Excalidraw's own locale code for the current app language (it ships "zh-CN"). */
export function excalidrawLangCode(lang: AppLang): string {
  return lang === "zh" ? "zh-CN" : "en";
}
