import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useSyncExternalStore } from "react";
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Button, Dropdown, Space } from "antd";
import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { messages as zh } from "../locales/zh/messages.po";
import { messages as en } from "../locales/en/messages.po";
export type LanguagePreference = "system" | "zh" | "en";
export type ThemePreference = "system" | "light" | "dark";
const keys = {
  language: "mini-archipel.language",
  theme: "mini-archipel.theme",
};
const eventName = "mini-archipel-preferences";
function stored(key: string): string | null {
  try {
    return volatile.get(key) ?? localStorage.getItem(key);
  } catch {
    return volatile.get(key) ?? null;
  }
}
export function resolveLanguage(
  preference: LanguagePreference,
  languages: readonly string[],
): "zh" | "en" {
  return preference === "system"
    ? languages[0]?.toLowerCase().startsWith("zh")
      ? "zh"
      : "en"
    : preference;
}
export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
function snapshot() {
  const language = stored(keys.language),
    theme = stored(keys.theme);
  const lp = language === "zh" || language === "en" ? language : "system";
  const tp = theme === "light" || theme === "dark" ? theme : "system";
  return [
    lp,
    tp,
    resolveLanguage(lp, navigator.languages),
    resolveTheme(tp, matchMedia("(prefers-color-scheme: dark)").matches),
  ].join(":");
}
export function syncPreferences() {
  const [, , locale, appearance] = snapshot().split(":");
  const languageChanged = locale !== i18n.locale;
  if (languageChanged)
    i18n.loadAndActivate({
      locale: locale === "zh" ? "zh" : "en",
      messages: locale === "zh" ? zh : en,
    });
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.theme = appearance;
  document.documentElement.style.colorScheme = appearance ?? "light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", appearance === "dark" ? "#142133" : "#f3f6fa");
  if (languageChanged) document.title = t`群岛 · 节点工作台`;
}
function subscribe(notify: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const change = (event: Event) => {
    if (event.type === "storage") volatile.clear();
    syncPreferences();
    notify();
  };
  media.addEventListener("change", change);
  window.addEventListener("languagechange", change);
  window.addEventListener("storage", change);
  window.addEventListener(eventName, change);
  return () => {
    media.removeEventListener("change", change);
    window.removeEventListener("languagechange", change);
    window.removeEventListener("storage", change);
    window.removeEventListener(eventName, change);
  };
}
function setPreference(key: "language", value: LanguagePreference): void;
function setPreference(key: "theme", value: ThemePreference): void;
function setPreference(key: keyof typeof keys, value: string) {
  volatile.set(keys[key], value);
  try {
    localStorage.setItem(keys[key], value);
  } catch {
    /* Private browsing may block persistence. */
  }
  syncPreferences();
  window.dispatchEvent(new Event(eventName));
}
const volatile = new Map<string, string>();
export function usePreferences() {
  const value = useSyncExternalStore(subscribe, snapshot);
  const [language, theme, locale, appearance] = value.split(":") as [
    LanguagePreference,
    ThemePreference,
    "zh" | "en",
    "light" | "dark",
  ];
  return {
    language,
    theme,
    locale,
    dark: appearance === "dark",
  };
}
export function Preferences() {
  const { t } = useLinguiMacro();
  const { language, theme } = usePreferences();
  const system = t`系统`;
  const languages = [
    {
      key: "system",
      label: system,
    },
    {
      key: "zh",
      label: /* lingui-extract-ignore */ "中文",
    },
    {
      key: "en",
      label: "English",
    },
  ];
  const themes = [
    {
      key: "system",
      label: system,
      icon: <Monitor size={15} />,
    },
    {
      key: "light",
      label: t`浅色`,
      icon: <Sun size={15} />,
    },
    {
      key: "dark",
      label: t`深色`,
      icon: <Moon size={15} />,
    },
  ];
  const languageLabel =
    languages.find((option) => option.key === language)?.label ?? system;
  const themeLabel =
    themes.find((option) => option.key === theme)?.label ?? system;
  return (
    <Space size={0} className="preferences">
      <Dropdown
        trigger={["click"]}
        menu={{
          items: languages,
          selectable: true,
          selectedKeys: [language],
          onClick: ({ key }) => {
            setPreference("language", key as LanguagePreference);
          },
        }}
      >
        <Button
          type="text"
          icon={<Languages size={17} />}
          aria-label={t`语言：${languageLabel}`}
        />
      </Dropdown>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: themes,
          selectable: true,
          selectedKeys: [theme],
          onClick: ({ key }) => {
            setPreference("theme", key as ThemePreference);
          },
        }}
      >
        <Button
          type="text"
          icon={
            theme === "system" ? (
              <Monitor size={17} />
            ) : theme === "dark" ? (
              <Moon size={17} />
            ) : (
              <Sun size={17} />
            )
          }
          aria-label={t`主题：${themeLabel}`}
        />
      </Dropdown>
    </Space>
  );
}
