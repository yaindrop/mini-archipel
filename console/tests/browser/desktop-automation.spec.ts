import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { TOKEN } from "../fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
  await page.request.post("/__test/reset");
  await page.request.post("/__test/desktop-automation");
  await page.goto("/desktop-automation?host=yd-mini-2");
});
test("desktop task results survive reload and repeated submit reuses a job", async ({
  page,
}) => {
  const node = page.locator("#yd-mini-2");
  await expect(
    page.getByRole("heading", { level: 1, name: "桌面自动化" }),
  ).toBeVisible();
  await node
    .getByRole("textbox", { name: "对话 ID", exact: true })
    .fill("01a18bdd-af80-7bd0-b5c7-a70bc5463735");
  await node.getByRole("button", { name: "提交任务", exact: true }).click();
  await expect(node.getByRole("region", { name: "任务结果" })).toContainText(
    "FIXTURE_REPLY",
  );
  await expect(
    node.getByRole("button", { name: "提交任务", exact: true }),
  ).toBeEnabled();
  await node.getByRole("button", { name: "提交任务", exact: true }).click();
  await expect(node.locator(".ant-table-tbody .ant-table-row")).toHaveCount(1);
  await page.reload();
  await expect(
    page.locator("#yd-mini-2").getByRole("region", { name: "任务结果" }),
  ).toContainText("FIXTURE_REPLY");
});
test("pause gates new work, resume restores it and diagnostics download", async ({
  page,
}) => {
  const node = page.locator("#yd-mini-2");
  await node.getByRole("button", { name: "暂停接单", exact: true }).click();
  await expect(
    node.getByRole("button", { name: "恢复接单", exact: true }),
  ).toBeVisible();
  await expect(
    node.getByRole("button", { name: "提交任务", exact: true }),
  ).toBeDisabled();
  const downloadEvent = page.waitForEvent("download");
  await node.getByRole("button", { name: "下载诊断包", exact: true }).click();
  const download = await downloadEvent,
    path = await download.path();
  if (!path) throw Error("missing download");
  const report = await readFile(path, "utf8");
  expect(report).toContain('"paused": true');
  expect(report).not.toContain(TOKEN);
  await node.getByRole("button", { name: "恢复接单", exact: true }).click();
  await expect(
    node.getByRole("button", { name: "提交任务", exact: true }),
  ).toBeEnabled();
});
test("desktop page has no accessibility violations or horizontal overflow", async ({
  page,
}) => {
  await expect(
    page
      .locator("#yd-mini-2")
      .getByRole("button", { name: "检查环境与权限", exact: true }),
  ).toBeVisible();
  await expect(async () => {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations).toEqual([]);
  }).toPass();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path:
      "test-results/desktop-automation-" + test.info().project.name + ".png",
    fullPage: true,
  });
});
