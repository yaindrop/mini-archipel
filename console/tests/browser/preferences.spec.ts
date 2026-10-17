import { test, expect } from "@playwright/test";
import { TOKEN } from "../fixtures.ts";
test.use({ locale: "en-US", colorScheme: "dark" });
test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
});
test("system defaults localize every workspace and use the system appearance", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle("Mini Archipel · Node workbench (4/4)");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const languageButton = page.getByRole("button", { name: "Language: System" });
  await expect(languageButton).toBeVisible();
  await expect(languageButton).toHaveText("");
  await expect(page.getByRole("button", { name: "Theme: System" })).toHaveText(
    "",
  );
  for (const path of [
    "/",
    "/nodes/yd-mini",
    "/nodes/yd-mbp-tart",
    "/storage",
    "/history",
    "/plugins",
    "/connections",
    "/runners",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/[\u4e00-\u9fff]/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator(".runner-card-footer code").first()).toHaveText(
    "~/github-runners/flowbit",
  );
  await expect(page.locator(".ant-dropdown:visible")).toHaveCount(0);
  await page.screenshot({
    path: ".preview/mini-archipel-english-dark.png",
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});
test("language and theme have three choices, persist overrides, and resume system tracking", async ({
  page,
}) => {
  await page.goto("/storage");
  await page.getByRole("button", { name: "Language: System" }).click();
  await expect(
    page.locator(".ant-dropdown:visible").getByRole("menuitem"),
  ).toHaveCount(3);
  await page.getByRole("menuitem", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page).toHaveTitle("群岛 · 节点工作台（4/4）");
  await page.getByRole("button", { name: /^主题：/ }).click();
  await expect(
    page.locator(".ant-dropdown:visible").getByRole("menuitem"),
  ).toHaveCount(3);
  await page.getByRole("menuitem", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("h1")).toHaveText("存储空间");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /^主题：/ }).click();
  await page.getByRole("menuitem", { name: "系统", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /^语言：/ }).click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Storage");
  await page.getByRole("button", { name: "Language: English" }).click();
  await page.getByRole("menuitem", { name: "System", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["zh-TW"],
    });
    window.dispatchEvent(new Event("languagechange"));
  });
  await expect(page.locator("h1")).toHaveText("存储空间");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".ant-dropdown:visible")).toHaveCount(0);
  await page.screenshot({
    path: ".preview/mini-archipel-chinese-light.png",
    fullPage: true,
  });
});
test("preferences are available before login and errors follow the selected language", async ({
  page,
}) => {
  await page.request.delete("/api/session");
  await page.goto("/");
  await expect(page.getByLabel("Access token", { exact: true })).toBeVisible();
  await page.getByLabel("Access token", { exact: true }).fill("wrong-token");
  await page
    .getByRole("button", { name: "Open workbench", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Incorrect access token");
  await page.getByRole("button", { name: "Language: System" }).click();
  await page.getByRole("menuitem", { name: "中文", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("访问令牌不正确");
  await expect(page.getByLabel("访问令牌", { exact: true })).toHaveValue(
    "wrong-token",
  );
});
