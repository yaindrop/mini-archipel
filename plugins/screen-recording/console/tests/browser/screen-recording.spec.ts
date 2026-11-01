import { test, expect } from "@playwright/test";
import { TOKEN } from "../../../../../console/tests/fixtures.ts";
test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
  await page.request.post("/__test/reset");
  await page.request.post("/__test/screen-recording");
  await page.goto("/screen-recording?host=yd-mini-2");
});
test("quiet permission checks and explicit requests stay separate", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { level: 1, name: "屏幕录制" }),
  ).toBeVisible();
  const environment = page.locator(".section-card").filter({
    has: page.getByRole("heading", { name: "环境与权限", exact: true }),
  });
  await expect(
    environment.getByText("未检查", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    environment.getByText("输入监控（鼠标轨道）", { exact: true }),
  ).toHaveCount(0);
  await environment
    .getByRole("button", { name: "屏幕录制 · 重新检查", exact: true })
    .click();
  await expect(
    environment.getByText("已验证可用", { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "单独保存真实鼠标轨道" }).check();
  const request = page.waitForRequest((r) =>
    r.url().includes("/api/plugins/screen-recording/actions/pointer-authorize"),
  );
  await environment
    .getByRole("button", {
      name: "输入监控（鼠标轨道） · 请求授权",
      exact: true,
    })
    .click();
  expect((await request).postDataJSON()).toEqual({
    host: "yd-mini-2",
    interactive: true,
  });
  await expect(
    environment.getByText("等待本人确认", { exact: true }),
  ).toBeVisible();
});
test("start uses the selected window and stopping does not claim completion", async ({
  page,
}) => {
  await page.getByRole("button", { name: "刷新目标", exact: true }).click();
  await page.getByRole("combobox", { name: "录制目标", exact: true }).click();
  await page
    .getByText("Fixture editor · test.fixture", { exact: true })
    .click();
  const request = page.waitForRequest((r) =>
    r.url().includes("/api/plugins/screen-recording/actions/start"),
  );
  await page.getByRole("button", { name: /开始录制/ }).click();
  expect((await request).postDataJSON()).toMatchObject({
    host: "yd-mini-2",
    request: { window: 238, duration: 18, tail: 1 },
  });
  await page.getByRole("button", { name: "停止并保存", exact: true }).click();
  await expect(
    page.locator(".section-card").filter({
      has: page.getByRole("heading", { name: "环境与权限", exact: true }),
    }),
  ).toContainText("正在收尾");
  await expect(
    page.getByRole("button", { name: "下载录像", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/screen-recording-" + test.info().project.name + ".png",
    fullPage: true,
  });
});
