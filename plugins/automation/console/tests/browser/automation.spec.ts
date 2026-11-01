import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { TOKEN } from "../../../../../console/tests/fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
  await page.request.post("/__test/reset");
  await page.request.post("/__test/automation");
  await page.goto("/automation?host=yd-mini-2");
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
  await expect(
    node.locator(".desktop-job-table .ant-table-tbody .ant-table-row"),
  ).toHaveCount(1);
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
      .getByRole("button", { name: "辅助功能 · 重新检查", exact: true }),
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
    path: test.info().outputPath("desktop-automation.png"),
    fullPage: true,
  });
});

test("permission rows expose explicit per-scope requests and actual verification", async ({
  page,
}) => {
  const node = page.locator("#yd-mini-2");
  const row = node.getByRole("row").filter({
    has: page.getByText("Apple Events / System Events", { exact: true }),
  });
  await expect(row.getByText("已验证可用", { exact: true })).toBeVisible();
  const submitted = page.waitForRequest((request) =>
    request.url().endsWith("/api/plugins/automation/actions/submit"),
  );
  await row
    .getByRole("button", {
      name: "Apple Events / System Events · 请求授权",
      exact: true,
    })
    .click();
  const body = (await submitted).postDataJSON() as {
    request: { operation: string; permission: string };
  };
  expect(body.request.operation).toBe("permissions");
  expect(body.request.permission).toBe("automation");
  await expect(node.getByRole("region", { name: "任务结果" })).toContainText(
    "completed",
  );
  await expect(row.getByText("已验证可用", { exact: true })).toBeVisible();
});

test("native input discovery, preflight, activation and STOP never replay", async ({
  page,
}) => {
  const node = page.locator("#yd-mini-2");
  const clickReady = async (name: string) => {
    const button = node.getByRole("button", { name, exact: true });
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveClass(/ant-btn-loading/);
    await button.click();
  };
  const actions: { action: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/plugins/automation/actions/"))
      actions.push({
        action: request.url().split("/").at(-1) ?? "",
        body: request.postDataJSON() as Record<string, unknown>,
      });
  });
  await node
    .getByRole("button", { name: "刷新应用与窗口", exact: true })
    .click();
  await node
    .getByRole("combobox", { name: "目标应用与窗口", exact: true })
    .click();
  await page
    .getByText("Example Editor · PID 42 · 7", { exact: true })
    .last()
    .click();
  expect(actions.some((entry) => entry.action === "submit")).toBe(false);
  await node
    .getByRole("textbox", { name: "单个动作（JSON）", exact: true })
    .fill('{"kind":"click","x":100,"y":200}');
  await clickReady("仅预检输入");
  await expect(node.getByRole("region", { name: "任务结果" })).toContainText(
    '"operation": "input"',
  );
  await expect(
    node.getByRole("button", { name: "显式激活窗口", exact: true }),
  ).toBeEnabled();
  const submitted = actions.find((entry) => entry.action === "submit")?.body
    .request as {
    mode: string;
    request_id: string;
    target: { pid: number; window_id: number };
  };
  expect(submitted.mode).toBe("preflight");
  expect(submitted.target).toMatchObject({ pid: 42, window_id: 7 });
  expect(new URL(page.url()).searchParams.get("job")).toBe(
    submitted.request_id,
  );
  const result = node.getByRole("region", { name: "任务结果" });
  await expect(result).toContainText(`"id": "${submitted.request_id}"`);
  await expect(result).toContainText('"status": "completed"');
  await clickReady("显式激活窗口");
  await expect(
    node.getByRole("button", { name: "执行单个输入", exact: true }),
  ).toBeEnabled();
  const activated = actions.filter((entry) => entry.action === "submit").at(-1)
    ?.body.request as {
    request_id: string;
    mode: string;
    action: { kind: string };
  };
  expect(activated).toMatchObject({
    mode: "execute",
    action: { kind: "activate" },
  });
  // A transient enabled button is not the preceding job's completion receipt.
  await expect(result).toContainText(`"id": "${activated.request_id}"`);
  await expect(result).toContainText('"status": "completed"');
  expect(new URL(page.url()).searchParams.get("job")).toBe(
    activated.request_id,
  );
  await clickReady("执行单个输入");
  await expect
    .poll(() => actions.filter((entry) => entry.action === "submit").length)
    .toBe(3);
  expect(
    actions.filter((entry) => entry.action === "submit").at(-1)?.body.request,
  ).toMatchObject({ mode: "execute", action: { kind: "click" } });

  await expect(
    node.getByRole("button", { name: "等待本次结果", exact: true }),
  ).toBeVisible();
  await clickReady("等待本次结果");
  await expect(node.getByRole("region", { name: "任务结果" })).toContainText(
    '"status": "running"',
  );
  await clickReady("取消任务");
  await expect(node.getByRole("region", { name: "任务结果" })).toContainText(
    '"status": "cancelled"',
  );
  await node.getByRole("button", { name: "新建输入请求", exact: true }).click();
  await clickReady("执行单个输入");
  await expect
    .poll(() => actions.filter((entry) => entry.action === "submit").length)
    .toBe(4);

  await expect(
    node.getByRole("button", { name: "停止原生输入", exact: true }),
  ).toBeEnabled();
  await clickReady("停止原生输入");
  await expect(
    node.getByRole("button", { name: "允许新的原生输入", exact: true }),
  ).toBeVisible();
  await expect(
    node.getByRole("button", { name: "执行单个输入", exact: true }),
  ).toBeDisabled();
  const count = actions.filter((entry) => entry.action === "submit").length;
  await clickReady("允许新的原生输入");
  await expect(
    node.getByRole("button", { name: "停止原生输入", exact: true }),
  ).toBeVisible();
  expect(actions.filter((entry) => entry.action === "submit")).toHaveLength(
    count,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("native-input.png"),
    fullPage: true,
  });
});
