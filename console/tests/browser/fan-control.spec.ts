import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TOKEN } from "../fixtures.ts";
test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
  await page.request.post("/__test/reset");
  await page.request.post("/__test/fan-control");
});
test("fan curve draft survives refresh and applies only after confirmation", async ({
  page,
}) => {
  await page.goto("/fan-control");
  await expect(
    page.getByRole("heading", { name: "风扇控制", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "风扇阶梯曲线：温度与目标转速" }),
  ).toBeVisible();
  const input = page.getByRole("spinbutton", {
    name: "第 2 档温度",
    exact: true,
  });
  await input.fill("42");
  await input.blur();
  await expect(page.getByText("未应用的草稿", { exact: true })).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue("42");
  await page.getByRole("button", { name: "应用到节点", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("yd-mini");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("与节点一致", { exact: true })).toBeVisible();
  await expect(page.getByText("未应用的草稿", { exact: true })).toHaveCount(0);
});
test("local timed task is visible after reload and cancellable", async ({
  page,
}) => {
  await page.goto("/fan-control");
  await page.getByText("限时控制与服务", { exact: true }).click();
  await page.getByRole("button", { name: "开始限时控制", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true }),
  ).toHaveCount(0);
});
test("virtual nodes, both palettes, accessible layout and invalid drafts", async ({
  page,
}, testInfo) => {
  await page.goto("/fan-control");
  await page
    .getByRole("spinbutton", { name: "第 2 档温度", exact: true })
    .fill("55");
  await expect(
    page.getByRole("button", { name: "应用到节点", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "重新载入节点曲线", exact: true })
    .click();
  const violations = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(violations.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: testInfo.outputPath("fan-light.png"),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".fan-node").first()).toHaveCSS(
    "color",
    "rgb(226, 234, 245)",
  );
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: testInfo.outputPath("fan-dark.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: /yd-mbp-tart Tart/ })
    .first()
    .click();
  await expect(
    page.getByText("虚拟机无硬件风扇", { exact: true }),
  ).toBeVisible();
});

test("curve points support keyboard editing and language switching preserves the draft", async ({
  page,
}) => {
  await page.goto("/fan-control");
  await page
    .getByRole("button", { name: "调整第 2 档：拖动或使用方向键" })
    .press("ArrowRight");
  await expect(
    page.getByRole("spinbutton", { name: "第 2 档温度", exact: true }),
  ).toHaveValue("41");
  await page.evaluate(() => {
    localStorage.setItem("mini-archipel.language", "en");
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Fan control", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply to node", exact: true }),
  ).toBeEnabled();
});
