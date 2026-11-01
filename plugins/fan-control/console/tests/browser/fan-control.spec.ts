import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TOKEN } from "../../../../../console/tests/fixtures.ts";
test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
  await page.request.post("/__test/reset");
  await page.request.post("/__test/fan-control");
});
test("fan curve draft survives refresh and applies only after confirmation", async ({
  page,
}) => {
  await page.goto("/fan-control");
  const node = page.locator("#yd-mini");
  await expect(
    page.getByRole("heading", { name: "风扇控制", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    node.getByRole("group", { name: "风扇阶梯曲线：温度与目标转速" }),
  ).toBeVisible();
  await expect(
    node.getByRole("textbox", { name: "第 1 档转速", exact: true }),
  ).toHaveValue("系统默认");
  await expect(
    node.getByRole("spinbutton", { name: "第 1 档转速", exact: true }),
  ).toHaveCount(0);
  const baseline = await node
    .locator(".fan-curve .chart-grid")
    .first()
    .getAttribute("y1");
  if (baseline === null) throw Error("Missing zero grid line");
  await expect(node.locator(".fan-curve-point").first()).toHaveAttribute(
    "cy",
    baseline,
  );
  await expect(node.locator(".fan-curve-live")).toHaveAttribute("cy", baseline);
  await expect(node.locator(".fan-curve-draft")).toHaveAttribute("d", /Q/);
  await expect(
    node.getByText("波浪线：系统默认（转速由系统决定）", { exact: true }),
  ).toBeVisible();
  const input = node.getByRole("spinbutton", {
    name: "第 2 档温度",
    exact: true,
  });
  await input.fill("42");
  await input.blur();
  await expect(node.getByText("未应用的草稿", { exact: true })).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue("42");
  await node.getByRole("button", { name: "应用到节点", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("yd-mini");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(node.getByText("与节点一致", { exact: true })).toBeVisible();
  await expect(node.getByText("未应用的草稿", { exact: true })).toHaveCount(0);
});
test("local timed task is visible after reload and cancellable", async ({
  page,
}) => {
  await page.goto("/fan-control");
  const node = page.locator("#yd-mini");
  await node.getByText("限时控制与服务", { exact: true }).click();
  await node.getByRole("button", { name: "开始限时控制", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    node.getByRole("button", { name: "取消任务", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    node.getByRole("button", { name: "取消任务", exact: true }),
  ).toBeVisible();
  await node.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(
    node.getByRole("button", { name: "取消任务", exact: true }),
  ).toHaveCount(0);
});
test("the 20–100°C chart edits a fixed-speed protection point and persists it", async ({
  page,
}) => {
  await page.goto("/fan-control");
  const node = page.locator("#yd-mini");
  await expect(
    node.locator(".fan-curve text").filter({ hasText: /°C$/ }),
  ).toHaveText(["20 °C", "40 °C", "60 °C", "80 °C", "100 °C"]);
  const temperature = node.getByRole("spinbutton", {
    name: "保护温度",
    exact: true,
  });
  const rpm = node.getByRole("spinbutton", {
    name: "第 5 档转速",
    exact: true,
  });
  await expect(rpm).toBeDisabled();
  await expect(rpm).toHaveValue("4900");
  await expect(node.locator(".fan-point").last()).toContainText("100%");
  await temperature.fill("75");
  await temperature.blur();
  const handle = node.getByRole("button", {
    name: "调整保护温度：拖动或使用左右方向键",
    exact: true,
  });
  await handle.press("ArrowRight");
  await expect(temperature).toHaveValue("76");
  await handle.press("ArrowDown");
  await expect(rpm).toHaveValue("4900");
  const x = await node.locator(".fan-curve-point").last().getAttribute("cx");
  if (x === null) throw Error("Missing protection point");
  await expect(node.locator(".fan-danger-zone")).toHaveAttribute("x", x);
  await page.reload();
  await expect(temperature).toHaveValue("76");
  await node.getByRole("button", { name: "应用到节点", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(node.getByText("与节点一致", { exact: true })).toBeVisible();
  await page.reload();
  await expect(temperature).toHaveValue("76");
  await expect(rpm).toHaveValue("4900");
});
test("virtual nodes, both palettes, accessible layout and invalid drafts", async ({
  page,
}, testInfo) => {
  await page.goto("/fan-control");
  const node = page.locator("#yd-mini");
  await node
    .getByRole("spinbutton", { name: "第 2 档温度", exact: true })
    .fill("55");
  await expect(
    node.getByRole("button", { name: "应用到节点", exact: true }),
  ).toBeDisabled();
  await node
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
  await page.evaluate(() => {
    const bar = document.querySelector(".topbar");
    if (bar instanceof HTMLElement) bar.style.position = "static";
  });
  await expect(page.locator(".volume-card.selected .volume-name")).toHaveCSS(
    "color",
    "rgb(226, 234, 245)",
  );
  expect(
    (
      await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
    ).violations.filter((item) => item.id !== "color-contrast"),
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
    .getByRole("button", { name: "选择 yd-mbp-tart", exact: true })
    .click();
  await expect(page.locator("#yd-mbp-tart")).toContainText("虚拟机无硬件风扇");
});

test("curve points support keyboard editing and language switching preserves the draft", async ({
  page,
}) => {
  await page.goto("/fan-control");
  const node = page.locator("#yd-mini");
  await node
    .getByRole("button", { name: "调整第 2 档：拖动或使用方向键" })
    .press("ArrowRight");
  await expect(
    node.getByRole("spinbutton", { name: "第 2 档温度", exact: true }),
  ).toHaveValue("41");
  await page.evaluate(() => {
    localStorage.setItem("mini-archipel.language", "en");
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Fan control", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    node.getByRole("textbox", { name: "Step 1 speed", exact: true }),
  ).toHaveValue("System default");
  await expect(
    node.getByRole("button", { name: "Apply to node", exact: true }),
  ).toBeEnabled();
});
