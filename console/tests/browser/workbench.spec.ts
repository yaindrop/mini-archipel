import { test as base, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ArchipelSchema } from "../../src/contracts.ts";
import { TOKEN } from "../fixtures.ts";
import { scaledTestTimeout } from "../../scripts/ci-timeout";
const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
  expect((await page.request.post("/__test/reset")).ok()).toBe(true);
});
test("overview, filters, deep links and browser navigation", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("群岛 · 节点工作台（4/4）");
  if (isMobile)
    await page.getByRole("button", { name: "打开导航菜单" }).click();
  await expect(page.locator(".brand strong").first()).toHaveText("群岛");
  expect(
    await page
      .getByRole("navigation", { name: "节点导航" })
      .locator("small")
      .allTextContents(),
  ).toEqual([
    "M6 Mac Mini",
    "M6 Mac Mini",
    "Tart on M4 Max MacBook",
    "Tart on M4 Max MacBook",
  ]);
  if (isMobile)
    await page.getByRole("button", { name: "关闭导航菜单" }).click();
  if (!isMobile) {
    expect(
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("link")
        .allTextContents(),
    ).toEqual(["集群概览", "存储空间", "历史趋势", "插件管理", "Runners4"]);
  }
  const icon = await page.request.get("/archipelago.svg");
  expect(icon.ok()).toBe(true);
  expect(await icon.text()).not.toContain("#15243b");
  await expect(
    page.getByRole("heading", { name: "集群概览", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".nodes-table tbody tr[data-row-key]")).toHaveCount(
    4,
  );
  await expect(
    page.locator(
      '.nodes-table tr[data-row-key="yd-mini"] .host-identity small',
    ),
  ).toHaveText("M6 Mac Mini · 12 核 · 16.0 GiB");
  await expect(
    page.locator(
      '.nodes-table tr[data-row-key="yd-mbp-tart"] .host-identity small',
    ),
  ).toHaveText("Tart on M4 Max MacBook · 6 核 · 16.0 GiB");
  await expect(
    page.getByText("横向比较节点状态，点击名称进入详情。", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("当前运行平稳")).toBeVisible();
  expect(
    await page
      .locator(".metrics-row .metric-tile .ant-flex > .ant-typography")
      .allTextContents(),
  ).toEqual(["在线节点", "集群核心负载", "集群内存负载", "集群可用存储容量"]);
  const trends = page.locator(".overview-columns");
  await expect(trends.locator(".time-chart")).toHaveCount(2);
  await expect(
    trends.getByRole("heading", { name: "CPU 走势", exact: true }),
  ).toBeVisible();
  await expect(
    trends.getByRole("heading", { name: "内存走势", exact: true }),
  ).toBeVisible();
  await expect(trends.getByRole("radiogroup")).toHaveCount(0);
  if (!isMobile) {
    const widths = await trends
      .locator(":scope > .section-card")
      .evaluateAll((cards) =>
        cards.map((card) => card.getBoundingClientRect().width),
      );
    expect(widths).toHaveLength(3);
    const [cpu, memory, attention] = widths;
    if (!cpu || !memory || !attention) throw Error("Missing overview panel");
    expect(cpu / attention).toBeCloseTo(2, 1);
    expect(memory / attention).toBeCloseTo(2, 1);
  }
  const tableFooter = page.locator(".nodes-table .ant-table-footer");
  await expect(tableFooter).toContainText("每秒采集");
  await expect(tableFooter).toContainText("共 4 / 4 台");
  expect(
    await page.locator(".nodes-table").evaluate((table) => {
      const card = table.closest(".section-card")?.getBoundingClientRect(),
        box = table.getBoundingClientRect();
      return card ? Math.min(box.left - card.left, card.right - box.right) : 0;
    }),
  ).toBeGreaterThanOrEqual(15);

  await page.getByLabel("筛选节点类型").click();
  await page.getByRole("option", { name: "虚拟机", exact: true }).click();
  await expect(page.locator(".nodes-table tbody tr[data-row-key]")).toHaveCount(
    2,
  );
  await expect(tableFooter).toContainText("共 2 / 4 台");
  await page.getByLabel("搜索节点").fill("tart-2");
  await expect(page.locator(".nodes-table tbody tr[data-row-key]")).toHaveCount(
    1,
  );
  await page
    .getByRole("link", { name: "查看节点 yd-mbp-tart-2", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "yd-mbp-tart-2", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".page-heading .eyebrow")).toHaveText("虚拟机");
  await expect(page.locator(".page-heading")).toContainText(
    "Tart on M4 Max MacBook",
  );
  await expect(page.locator(".topbar-breadcrumb")).toContainText(
    "yd-mbp-tart-2",
  );
  await expect(page.locator(".main-content .ant-breadcrumb")).toHaveCount(0);
  await expect(page.locator(".node-overview-columns .time-chart")).toHaveCount(
    2,
  );
  const sections = await page.locator(".section-title h2").allTextContents();
  expect(sections.indexOf("节点信息")).toBe(sections.indexOf("各核心占用") + 1);
  expect(sections.at(-1)).toBe("节点 Runners");
  if (!isMobile) await page.setViewportSize({ width: 1512, height: 800 });
  await expect(
    page.locator(".node-heading .ant-typography-secondary"),
  ).toBeVisible();
  const sensors = page.locator(".section-card").filter({
    has: page.getByRole("heading", { name: "传感器", exact: true }),
  });
  await expect(sensors.locator(".section-title .ant-typography")).toHaveCount(
    0,
  );
  await expect(sensors.locator(".ant-empty-description")).toHaveText(
    "虚拟机无硬件传感器",
  );
  await expect(page.getByText("作业运行中", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "活跃进程", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "活跃进程", exact: true }),
  ).toBeVisible();
  await page.getByLabel("搜索进程").fill("node");
  await expect(
    page.locator(".process-table tbody tr[data-row-key]"),
  ).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("搜索进程")).toBeVisible();
  await page.goBack();
  if (isMobile) {
    await page.getByRole("button", { name: "打开导航菜单" }).click();
    await expect(
      page.getByRole("navigation", { name: "主导航" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭导航菜单" }).click();
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
});
test("storage segments and legends highlight each other without tooltips", async ({
  page,
}) => {
  await page.goto("/storage");
  const segments = page.locator(".storage-bar > span");
  const legends = page.locator(".storage-legend > button");
  await legends.first().scrollIntoViewIfNeeded();
  const originalLegend = await legends.first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x + scrollX, y: box.y + scrollY };
  });
  await segments.first().hover();
  await expect(legends.first()).toHaveClass(/is-active/);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await segments.nth(1).hover();
  await expect(legends.first()).not.toHaveClass(/is-active/);
  await expect(legends.nth(1)).toHaveClass(/is-active/);
  await legends.first().hover();
  await expect(segments.first()).toHaveClass(/is-active/);
  await expect(segments.nth(1)).not.toHaveClass(/is-active/);
  await expect(segments.nth(1)).toHaveCSS("opacity", "0.35");
  await expect(legends.first()).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, -2)",
  );
  const highlightedLegend = await legends.first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x + scrollX, y: box.y + scrollY };
  });
  expect(highlightedLegend.x).toBe(originalLegend.x);
  expect(highlightedLegend.y).toBe(originalLegend.y - 2);
  await expect
    .poll(() =>
      legends.first().evaluate((label) => {
        const style = getComputedStyle(label);
        const number = label.querySelector("strong");
        return [
          style.backgroundColor,
          style.color,
          number && getComputedStyle(number).color,
        ];
      }),
    )
    .toEqual(["rgb(35, 52, 74)", "rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
  await page.getByRole("heading", { name: "存储空间", exact: true }).hover();
  await expect(page.locator(".storage-legend > .is-active")).toHaveCount(0);
  await expect(segments.nth(1)).toHaveCSS("opacity", "1");
  await legends.first().focus();
  await expect(legends.first()).toHaveClass(/is-active/);
  await legends.nth(1).focus();
  await expect(segments.nth(1)).toHaveClass(/is-active/);
});
test("repository tabs isolate runners and controls across nodes", async ({
  page,
}) => {
  expect((await page.request.post("/__test/multi-repo")).ok()).toBe(true);
  await page.goto("/runners?repo=yaindrop%2Fflowbit");
  const tabs = page.locator(".runner-repo-tabs");
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".runner-card")).toHaveCount(4);
  await tabs.getByRole("tab", { name: /acme\/flowbit/ }).click();
  await expect(page.locator(".runner-card")).toHaveCount(1);
  await page.getByRole("button", { name: "停止接单", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("acme/flowbit");
  await page.getByRole("button", { name: "确认停止", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "启动接单", exact: true }),
  ).toBeEnabled();
  await tabs.getByRole("tab", { name: /yaindrop\/flowbit/ }).click();
  await expect(page.locator(".runner-card")).toHaveCount(4);
  const original = page.locator(".runner-card").filter({
    has: page.getByRole("heading", { name: "yd-mini", exact: true }),
  });
  await expect(
    original.getByRole("button", { name: "停止接单", exact: true }),
  ).toBeEnabled();
  await page.goto("/nodes/yd-mini?view=runners&repo=acme%2Fflowbit");
  await expect(page.locator(".runner-repo-tabs")).toHaveCount(0);
  await expect(page.locator(".runner-card")).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: "acme/flowbit", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "yaindrop/flowbit", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "启动接单", exact: true }),
  ).toBeEnabled();
});
test("Runner receipts survive reload and directory deltas retain their baseline", async ({
  page,
}) => {
  const sizes: number[] = [];
  const directoryFrames: boolean[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      sizes.push(payload.length);
      directoryFrames.push(String(payload).includes('"disk_scans":'));
    }),
  );
  await page.goto("/nodes/yd-mini?view=runners");
  const runner = page.locator(".runner-card").first();
  const requested = page.waitForRequest((request) =>
    request.url().endsWith("/api/plugins/runners/actions/toggle"),
  );
  await runner.getByRole("button", { name: "停止接单", exact: true }).click();
  await page.getByRole("button", { name: "确认停止", exact: true }).click();
  const body = (await requested).postDataJSON() as { request_id: string };
  expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(
    page.getByText("操作请求已提交，请查看节点操作状态"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".runner-card").first().getByText("操作已完成"),
  ).toBeVisible();
  await page.goto("/storage");
  await expect(
    page.getByRole("rowheader").filter({ hasText: "Library" }),
  ).toBeVisible();
  await expect.poll(() => sizes.length).toBeGreaterThan(2);
  expect(directoryFrames).toContain(true);
  expect(directoryFrames).toContain(false);
  expect(Math.min(...sizes)).toBeLessThan(Math.max(...sizes));
});
test("node runner mutual exclusion persists and reflects job pause and recovery", async ({
  page,
}) => {
  await page.request.post("/__test/multi-repo");
  await page.goto("/runners");
  const toggle = page.getByRole("switch", {
    name: "yd-mini 接单互斥",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(
    page.getByRole("switch", { name: "yd-mini-2 接单互斥", exact: true }),
  ).not.toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await page.request.post("/__test/runner-job", {
    data: { host: "yd-mini", runner: "flowbit" },
  });
  await page.goto("/nodes/yd-mini?view=runners");
  await expect(
    page.getByRole("switch", { name: "yd-mini 接单互斥", exact: true }),
  ).toBeChecked();
  await expect(page.getByText("互斥暂停接单", { exact: true })).toBeVisible();
  await expect(
    page.getByText("yaindrop/flowbit 占用节点，其他 Runner 暂停接单", {
      exact: true,
    }),
  ).toBeVisible();
  await page.request.post("/__test/runner-job", {
    data: { host: "yd-mini", runner: null },
  });
  await expect(page.getByText("互斥暂停接单", { exact: true })).toHaveCount(0);
  await page
    .getByRole("switch", { name: "yd-mini 接单互斥", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "yd-mini 接单互斥", exact: true }),
  ).not.toBeChecked();
});
test("node runner policy reports failures without changing the switch", async ({
  page,
}) => {
  await page.route("**/api/plugins/runners/actions/coordination", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "节点接单互斥不可用，请更新共用作业钩子" },
    }),
  );
  await page.goto("/runners");
  const toggle = page.getByRole("switch", {
    name: "yd-mini 接单互斥",
    exact: true,
  });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(
    page.locator(".runner-coordination-grid").getByRole("alert"),
  ).toContainText("节点接单互斥不可用，请更新共用作业钩子");
  await expect(toggle).not.toBeChecked();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".runner-coordination-grid")
        .analyze()
    ).violations,
  ).toEqual([]);
});
test("runner stop confirmation, cancellation, busy protection and restart", async ({
  page,
}) => {
  await page.goto("/runners");
  const busy = page
    .locator(".runner-card")
    .filter({ hasText: "flowbit-yd-mbp-tart-2" });
  await expect(busy.getByRole("button", { name: "停止接单" })).toBeDisabled();
  await busy.getByRole("button", { name: "中断作业" }).click();
  await expect(page.getByRole("dialog", { name: "中断作业" })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(busy.getByRole("button", { name: "中断作业" })).toBeVisible();
  await busy.getByRole("button", { name: "中断作业" }).click();
  await page.getByRole("button", { name: "确认中断" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(busy.getByRole("button", { name: "中断作业" })).toHaveCount(0);
  await expect(busy.getByRole("button", { name: "停止接单" })).toBeEnabled();
  const runner = page
    .locator(".runner-card")
    .filter({ hasText: "flowbit-yd-mini" })
    .first();
  for (let attempt = 0; attempt < 5; attempt++) {
    await runner.getByRole("button", { name: "停止接单" }).click();
    await expect(page.getByRole("dialog", { name: "停止接单" })).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await runner.getByRole("button", { name: "停止接单" }).click();
  await page.getByRole("button", { name: "确认停止" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(runner.getByRole("button", { name: "启动接单" })).toBeEnabled();
  await runner.getByRole("button", { name: "启动接单" }).click();
  await page.getByRole("button", { name: "确认启动" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(runner.getByRole("button", { name: "停止接单" })).toBeEnabled();
});
test("storage selection works across the entire card and with the keyboard", async ({
  page,
}) => {
  await page.goto("/storage");
  const cards = page.locator(".volume-card");
  await expect(cards).toHaveCount(4);
  await expect(page.getByText("当前节点", { exact: true })).toHaveCount(0);
  await cards.nth(1).locator(".ant-card-body").click();
  await expect(page).toHaveURL(/host=yd-mini-2/);
  await expect(cards.nth(1)).toHaveClass(/selected/);
  await cards.nth(2).click({ position: { x: 70, y: 26 } });
  await expect(page).toHaveURL(/host=yd-mbp-tart(&|$)/);
  const last = cards.nth(3).getByRole("button");
  await last.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/host=yd-mbp-tart-2/);
  await page.reload();
  await expect(cards.nth(3)).toHaveClass(/selected/);
});
test("storage common directories expand in both scopes", async ({ page }) => {
  await page.goto("/storage");
  const table = page.locator(".storage-table");
  const roots = page.getByRole("radiogroup", { name: "扫描范围" });
  const scopes = [
    [
      "用户目录",
      [
        [".local", "share"],
        ["Library", "Caches"],
        [".cache", "uv"],
      ],
    ],
    [
      "系统根目录",
      [
        ["Users", "yd-mini"],
        ["System", "Library"],
        ["private", "var"],
        ["Library", "Updates"],
        ["usr", "lib"],
        ["opt", "homebrew"],
      ],
    ],
  ] as const;
  for (const [scope, directories] of scopes) {
    await roots.getByText(scope, { exact: true }).click();
    for (const [name, child] of directories) {
      const row = table.locator(`tr[data-row-key="/${name}"]`);
      await row.getByRole("button", { name: "展开行" }).click();
      const nested = table.locator(`tr[data-row-key="/${name}/${child}"]`);
      await expect(nested).toBeVisible();
      await row.getByRole("button", { name: "关闭行" }).click();
    }
  }
});
test("storage selected subdirectories drill down again with bounded leaves", async ({
  page,
}) => {
  await page.goto("/storage");
  const table = page.locator(".storage-table"),
    roots = page.getByRole("radiogroup", { name: "扫描范围" });
  for (const [scope, paths] of [
    [
      "用户目录",
      [
        ["Library", "Caches", "Chrome"],
        ["Library", "Application Support", "Code"],
        [".local", "state", "mini-ci"],
        [".local", "share", "mini-archipel"],
      ],
    ],
    [
      "系统根目录",
      [
        ["System", "Library", "Frameworks"],
        ["Library", "Caches", "Desktop Pictures"],
        ["Library", "Application Support", "Apple"],
        ["private", "var", "db"],
        ["opt", "homebrew", "Cellar"],
      ],
    ],
  ] as const) {
    await roots.getByText(scope, { exact: true }).click();
    for (const [parent, directory, child] of paths) {
      const top = table.locator(`tr[data-row-key="/${parent}"]`),
        nested = table.locator(`tr[data-row-key="/${parent}/${directory}"]`);
      await top.getByRole("button", { name: "展开行" }).click();
      await nested.getByRole("button", { name: "展开行" }).click();
      const leaf = table.locator(
        `tr[data-row-key="/${parent}/${directory}/${child}"]`,
      );
      await expect(leaf).toBeVisible();
      if (child === "Desktop Pictures") await expect(leaf).toContainText("0 B");
      await expect(leaf.getByRole("button")).toHaveCount(0);
      await nested.getByRole("button", { name: "关闭行" }).click();
      await top.getByRole("button", { name: "关闭行" }).click();
    }
  }
});
test("storage drill-down, scan acknowledgement and history export", async ({
  page,
}) => {
  await page.goto("/storage");
  await expect(
    page.getByRole("heading", { name: "存储空间", exact: true }),
  ).toBeVisible();
  const table = page.locator(".storage-table");
  const applications = table
    .getByRole("row")
    .filter({ hasText: "Applications" });
  await expect(
    applications.getByRole("button", { name: "Applications" }),
  ).toHaveCount(0);
  const original = page.url();
  await applications.getByText("Applications", { exact: true }).click();
  expect(page.url()).toBe(original);
  await applications.getByRole("button", { name: "展开行" }).click();
  await expect(page.getByText("Tool.app", { exact: true })).toBeVisible();
  const tool = table.getByRole("row").filter({ hasText: "Tool.app" });
  await expect(tool.getByRole("button")).toHaveCount(0);
  const cache = table.getByRole("row").filter({ hasText: ".cache" });
  await cache.getByRole("button", { name: "展开行" }).click();
  await expect(table.getByText("uv", { exact: true })).toBeVisible();
  await expect(
    table
      .getByRole("row")
      .filter({ has: page.getByText("uv", { exact: true }) })
      .getByRole("button"),
  ).toHaveCount(0);
  await cache.getByRole("button", { name: "关闭行" }).click();
  await applications.getByRole("button", { name: "关闭行" }).click();
  await expect(page.getByText("Tool.app", { exact: true })).toHaveCount(0);
  const roots = page.getByRole("radiogroup", { name: "扫描范围" });
  await roots.getByText("系统根目录", { exact: true }).click();
  await expect(page.locator(".storage-root-path")).toHaveText("/");
  await roots.getByText("用户目录", { exact: true }).click();
  await expect(page.locator(".storage-root-path")).toContainText("/Users/");
  expect(await roots.locator(".storage-root-icon").allTextContents()).toEqual([
    "~",
    "/",
  ]);
  await expect(roots.locator("svg")).toHaveCount(0);
  const rootAlignment = await roots
    .locator(".storage-root-label")
    .evaluateAll((labels) =>
      labels.map((label) => {
        const icon = label
            .querySelector(".storage-root-icon")
            ?.getBoundingClientRect(),
          text = label.lastElementChild?.getBoundingClientRect();
        return icon && text
          ? Math.abs(
              (icon.top + icon.bottom) / 2 - (text.top + text.bottom) / 2,
            )
          : Infinity;
      }),
    );
  expect(Math.max(...rootAlignment)).toBeLessThan(1);

  const alignment = await table.locator(".folder-label").evaluateAll((labels) =>
    labels.map((label) => {
      const icon = label.querySelector("svg")?.getBoundingClientRect();
      const text = label
        .querySelector(".ant-space-item:last-child")
        ?.getBoundingClientRect();
      return icon && text
        ? Math.abs((icon.top + icon.bottom) / 2 - (text.top + text.bottom) / 2)
        : Infinity;
    }),
  );
  expect(Math.max(...alignment)).toBeLessThan(1);
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect(page.getByText("正在后台扫描，保留上次结果")).toBeVisible();
  await expect(table.getByText("Applications", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "取消扫描", exact: true }),
  ).toBeVisible();
  await expect(table.getByText("Applications", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消扫描", exact: true }).click();
  await expect(page.getByText("扫描已取消，保留上次结果。")).toBeVisible();
  await expect(table.getByText("Applications", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新扫描", exact: true }),
  ).toBeEnabled();
  await page.goto("/history");
  await page.getByLabel("历史指标").click();
  await page.getByRole("option", { name: "CPU 占用", exact: true }).click();
  await expect(page.getByRole("button", { name: "导出 CSV" })).toBeEnabled();
  const scales = await page.locator(".time-chart > svg").evaluateAll((charts) =>
    charts.map((chart) => {
      if (!(chart instanceof SVGSVGElement)) return Infinity;
      const matrix = chart.getScreenCTM();
      return matrix ? Math.abs(matrix.a - matrix.d) : Infinity;
    }),
  );
  expect(Math.max(...scales)).toBeLessThan(0.01);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("cpu.usage_pct");
  await page
    .getByRole("radiogroup", { name: "历史时间范围" })
    .getByText("7 天", { exact: true })
    .click();
  await expect(page).toHaveURL(/window=604800000/);
});
test("offline data is explicit and operations recover after reconnect", async ({
  page,
}) => {
  await page.request.post("/__test/host/yd-mini-2", {
    data: { offline: true },
  });
  try {
    await page.goto("/nodes/yd-mini-2?view=runners");
    await expect(page.getByText("节点离线", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止接单" })).toBeDisabled();
    await page.request.post("/__test/host/yd-mini-2", {
      data: { offline: false },
    });
    await expect(page.getByText("节点在线", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("button", { name: "停止接单" })).toBeEnabled();
  } finally {
    await page.request.post("/__test/host/yd-mini-2", {
      data: { offline: false },
    });
  }
});
test("pause, resume, dark theme and keyboard focus", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await expect(page.locator(".topbar-actions button")).toHaveCount(3);
  await expect(page.locator(".topbar .ant-avatar")).toHaveCount(0);
  if (!isMobile) {
    const header = await page.locator(".topbar").boundingBox();
    const live = await page.locator(".topbar-live").boundingBox();
    expect(
      header &&
        live &&
        Math.abs(live.x + live.width / 2 - header.x - header.width / 2),
    ).toBeLessThan(1);
  }
  await expect(
    page.getByRole("heading", { name: "集群概览", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂停实时更新" }).click();
  await expect(page.getByText(/实时更新已暂停，当前显示/)).toBeVisible();
  await page.getByRole("button", { name: "恢复实时更新" }).click();
  await expect(
    page.getByRole("button", { name: "暂停实时更新" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^主题：/ }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /^主题：/ }).click();
  await page.getByRole("menuitem", { name: "浅色", exact: true }).click();
  if (!isMobile) {
    await page.keyboard.press("/");
    await expect(page.getByLabel("搜索节点")).toBeFocused();
  }
});
test("session expiry, masked login and credential-free browser state", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/");
  await expect(page.getByLabel("访问令牌")).toHaveAttribute("type", "password");
  await page.getByLabel("访问令牌").fill("wrong");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("alert")).toContainText("访问令牌不正确");
  await page.getByLabel("访问令牌").fill(TOKEN);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "集群概览", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain(TOKEN);
  expect(
    await page.evaluate(() => localStorage.getItem("archipel-token")),
  ).toBeNull();
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "archipel-session",
  );
  await page.getByRole("button", { name: "退出工作台" }).click();
  await expect(page.getByLabel("访问令牌")).toBeVisible();
});
async function settleContent(page: Page) {
  if (new URL(page.url()).pathname === "/history") {
    await expect(page.locator(".history-refresh .spin")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "导出 CSV" })).toBeEnabled();
  }
  await page.locator("body").evaluate(async (root) => {
    await Promise.all(
      root
        .getAnimations({ subtree: true })
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}
for (const path of [
  "/",
  "/runners",
  "/storage",
  "/history",
  "/nodes/yd-mini",
  "/connections",
  "/plugins",
])
  test(`accessible ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator(".main-content h1")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await settleContent(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
  });
test("visual reference", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator(".nodes-table tbody tr[data-row-key]")).toHaveCount(
    4,
  );
  await settleContent(page);
  await page.screenshot({
    path: testInfo.outputPath("overview.png"),
    fullPage: true,
  });
  await page.goto("/nodes/yd-mini");
  await expect(
    page.getByRole("heading", { name: "yd-mini", exact: true, level: 1 }),
  ).toBeVisible();
  await settleContent(page);
  await page.screenshot({
    path: testInfo.outputPath("node.png"),
    fullPage: true,
  });
});

test("four nodes remain visible on a compact desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const rows = page.locator(".nodes-table tbody tr[data-row-key]");
  await expect(rows).toHaveCount(4);
  const lastRow = await rows.last().boundingBox();
  if (!lastRow) throw new Error("第四台节点不可见");
  expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(720);
});

test("dark theme keeps accessible contrast across the workbench", async ({
  page,
}) => {
  test.setTimeout(scaledTestTimeout(90_000)); // Seven full accessibility audits also run on WebKit.
  await page.goto("/");
  await page.getByRole("button", { name: /^主题：/ }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  for (const path of [
    "/",
    "/runners",
    "/storage",
    "/history",
    "/nodes/yd-mini",
    "/connections",
    "/plugins",
  ]) {
    await page.goto(path);
    await expect(page.locator(".main-content h1")).toBeVisible();
    await settleContent(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
  }
});

test("node sorting is reversible and follows the URL", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const rows = page.locator(".nodes-table tbody tr[data-row-key]");
  if (isMobile) {
    await page.getByLabel("节点排序").click();
    await page
      .getByRole("option", { name: "内存从高到低", exact: true })
      .click();
  } else {
    await page.getByRole("columnheader", { name: "内存", exact: true }).click();
  }
  await expect(rows.first()).toContainText("yd-mbp-tart-2");
  await expect(page).toHaveURL(/sort=memory/);
  if (!isMobile) {
    await page.getByRole("columnheader", { name: "内存", exact: true }).click();
    await expect(rows.first()).toContainText("yd-mini");
    await expect(page).toHaveURL(/order=ascend/);
  }
  await page.reload();
  await expect(rows.first()).toContainText(
    isMobile ? "yd-mbp-tart-2" : "yd-mini",
  );
});
test("pending runner commands keep focus and errors stay reviewable", async ({
  page,
}) => {
  const gate = Promise.withResolvers<undefined>();
  await page.route("**/api/plugins/runners/actions/toggle", async (route) => {
    await gate.promise;
    await route.fulfill({
      status: 503,
      json: { error: "节点暂时无法完成操作，请重试" },
    });
  });
  await page.goto("/runners");
  await page
    .locator(".runner-card")
    .filter({ hasText: "flowbit-yd-mini" })
    .first()
    .getByRole("button", { name: "停止接单" })
    .click();
  const dialog = page.getByRole("dialog", { name: "停止接单" });
  await dialog.getByRole("button", { name: "确认停止" }).click();
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  gate.resolve(undefined);
  await expect(dialog.getByRole("alert")).toContainText(
    "节点暂时无法完成操作，请重试",
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("dialog and select popups preserve accessible semantics", async ({
  page,
}) => {
  await page.goto("/runners");
  await page
    .locator(".runner-card")
    .filter({ hasText: "flowbit-yd-mini" })
    .first()
    .getByRole("button", { name: "停止接单" })
    .click();
  await expect(page.getByRole("dialog", { name: "停止接单" })).toBeVisible();
  await settleContent(page);
  const dialogScan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(
    dialogScan.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  ).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto("/");
  await page.getByLabel("筛选节点类型").click();
  await expect(
    page.getByRole("option", { name: "虚拟机", exact: true }),
  ).toBeVisible();
  await settleContent(page);
  const selectScan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(
    selectScan.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  ).toEqual([]);
  await page.keyboard.press("Escape");
});

test("console plugin can be disabled, reloaded and reenabled without losing core monitoring", async ({
  page,
}) => {
  await page.goto("/plugins");
  const control = page.getByRole("switch", {
    name: "控制台 Runners",
    exact: true,
  });
  await expect(control).toBeChecked();
  await page.getByRole("button", { name: "暂停实时更新", exact: true }).click();
  await control.click();
  await expect(control).not.toBeChecked();
  await page.goto("/");
  await expect(page.locator(".nodes-table tbody tr[data-row-key]")).toHaveCount(
    4,
  );
  await expect(
    page.getByRole("columnheader", { name: "Runner", exact: true }),
  ).toHaveCount(0);
  await page.goto("/runners");
  await expect(page.getByText("插件未启用", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("插件未启用", { exact: true })).toBeVisible();
  expect(
    (
      await page.request.post("/api/plugins/runners/actions/toggle", {
        data: {
          host: "yd-mini",
          repo: "yaindrop/flowbit",
          runner: "flowbit",
          enable: false,
        },
      })
    ).status(),
  ).toBe(409);
  await page.goto("/plugins");
  await control.click();
  await expect(control).toBeChecked();
  await page.goto("/runners");
  await expect(
    page.getByRole("heading", { name: "Runners", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".runner-card")).toHaveCount(4);
});

test("node plugin toggles independently while an active Worker remains untouched", async ({
  page,
}) => {
  await page.goto("/plugins");
  const control = page.getByRole("switch", {
    name: "yd-mbp-tart-2 Runners 插件",
    exact: true,
  });
  await control.click();
  await expect(control).not.toBeChecked();
  const state = ArchipelSchema.parse(
    await (await page.request.get("/api/state")).json(),
  );
  const host = state.hosts.find((h) => h.name === "yd-mbp-tart-2");
  expect(host?.online).toBe(true);
  expect(
    host?.snapshot?.sys?.procs.some(
      (p) => p.pid === 999 && p.name === "Runner.Worker",
    ),
  ).toBe(true);
  await page.goto("/nodes/yd-mbp-tart-2?view=runners");
  await expect(
    page.getByText("此节点的 Runner 插件未启用", { exact: true }),
  ).toBeVisible();
  await page.goto("/plugins");
  await control.click();
  await expect(control).toBeChecked();
  await page.goto("/nodes/yd-mbp-tart-2?view=runners");
  await expect(page.getByText("作业运行中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止接单" })).toBeDisabled();
});

test("plugin setting failures keep the original switch state and remain reviewable", async ({
  page,
}) => {
  await page.route("**/api/plugins/runners", (route) =>
    route.fulfill({
      status: 500,
      json: { error: "插件配置未保存，原状态保持不变" },
    }),
  );
  await page.goto("/plugins");
  const control = page.getByRole("switch", {
    name: "控制台 Runners",
    exact: true,
  });
  await control.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "插件配置未保存" }),
  ).toBeVisible();
  await expect(control).toBeChecked();
});

test("node tabs keep equal labels and stable full-width panels", async ({
  page,
}) => {
  await page.goto("/nodes/yd-mini");
  const content = page.locator(".main-content");
  const original = await content.boundingBox();
  expect(original).not.toBeNull();
  const tabs = page.locator(".ant-tabs-tab");
  const widths = await tabs.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  for (const name of ["活跃进程", "存储分析", "Runners", "节点概览"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    const width = (await content.boundingBox())?.width ?? 0;
    expect(Math.abs(width - (original?.width ?? 0))).toBeLessThan(1);
    if (name === "活跃进程") {
      await page.getByLabel("搜索进程").fill("no-such-process");
      await expect(page.getByText("没有匹配的进程")).toBeVisible();
      expect(
        Math.abs(((await content.boundingBox())?.width ?? 0) - width),
      ).toBeLessThan(1);
    }
  }
});
test("page layout and resource bars have no width transitions", async ({
  page,
}) => {
  for (const path of ["/", "/nodes/yd-mini"]) {
    await page.goto(path);
    await expect(page.locator(".main-content h1")).toBeVisible();
    const animated = await page
      .locator(
        ".workspace-shell, .main-content, .ant-layout-sider, .ant-progress-bg",
      )
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = getComputedStyle(element);
            return (
              style.transitionDuration
                .split(",")
                .some((duration) => parseFloat(duration) > 0) &&
              style.transitionProperty
                .split(",")
                .some((property) =>
                  [
                    "all",
                    "width",
                    "max-width",
                    "transform",
                    "flex-basis",
                  ].includes(property.trim()),
                )
            );
          })
          .map((element) => element.getAttribute("class")),
      );
    expect(animated).toEqual([]);
  }
});

test("lazy directory scans survive refresh, cancel, retry and deeper expansion", async ({
  page,
}) => {
  await page.goto("/storage");
  const table = page.locator(".storage-table"),
    row = table.locator('tr[data-row-key="/runners"]');
  await expect(table.locator('tr[data-row-key="/Empty"]')).toContainText("0 B");
  await expect(
    table.locator('tr[data-row-key="/Empty"]').getByRole("button"),
  ).toHaveCount(0);
  const protectedRow = table.locator('tr[data-row-key="/Protected"]');
  await expect(protectedRow).toContainText("不可读取");
  await expect(protectedRow).not.toContainText("0 B");
  const request = page.waitForRequest((request) =>
    request.url().endsWith("/api/disk/rescan"),
  );
  await row.getByRole("button", { name: "展开行" }).click();
  expect((await request).postDataJSON()).toEqual({
    host: "yd-mini",
    path: "/Users/yd-mini/runners",
  });
  await expect(
    page.getByText("正在后台扫描此目录，保留上次结果", { exact: true }),
  ).toBeVisible();
  await expect(table.locator('tr[data-row-key="/.rustup"]')).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("正在后台扫描此目录，保留上次结果", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消扫描", exact: true }).click();
  await expect(
    page.getByText("扫描已取消，保留上次结果。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "扫描此目录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消扫描", exact: true }),
  ).toBeVisible();
  await page.request.post("/__test/scan-complete", {
    data: { host: "yd-mini" },
  });
  const repo = table.locator('tr[data-row-key="/runners/flowbit"]');
  await expect(repo).toBeVisible();
  await repo.getByRole("button", { name: "展开行" }).click();
  await expect(
    page.getByRole("button", { name: "取消扫描", exact: true }),
  ).toBeVisible();
  await page.request.post("/__test/scan-complete", {
    data: { host: "yd-mini" },
  });
  await expect(
    table.locator('tr[data-row-key="/runners/flowbit/_work"]'),
  ).toBeVisible();
  await page.reload();
  await expect(
    table.locator('tr[data-row-key="/runners/flowbit/_work"]'),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
