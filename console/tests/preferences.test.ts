import { describe, expect, it } from "vitest";
import { resolveLanguage, resolveTheme } from "../src/web/preferences.tsx";
describe("system preference resolution", () => {
  it("uses the primary system language and respects explicit selections", () => {
    expect(resolveLanguage("system", ["zh-TW", "en-US"])).toBe("zh");
    expect(resolveLanguage("system", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveLanguage("system", ["ja-JP"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("zh", ["en-US"])).toBe("zh");
    expect(resolveLanguage("en", ["zh-CN"])).toBe("en");
  });
  it("tracks system appearance only when the user selects System", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
