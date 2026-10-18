import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TOKEN } from "../fixtures.ts";
import { DiskRulesViewSchema } from "../../src/storage-rules.ts";
import { scaledTestTimeout } from "../../scripts/ci-timeout";
test.beforeEach(async ({ page }) => {
  await page.request.post("/api/session", { data: { token: TOKEN } });
  await page.request.post("/__test/reset");
});
test("directory rules: node edits, sources, persistence, reset and conflicts", async ({
  page,
}, info) => {
  test.setTimeout(scaledTestTimeout(120_000));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/storage?host=yd-mini");
  await page.getByRole("button", { name: "目录规则", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "目录规则 · yd-mini",
    exact: true,
  });
  await expect(drawer.getByText("默认", { exact: true })).toHaveCount(2);
  await expect(
    drawer.getByText("插件 · runners", { exact: true }),
  ).toBeVisible();
  await drawer
    .getByRole("combobox", { name: "~/Library 下钻深度", exact: true })
    .click();
  await page.getByRole("option", { name: "3 层", exact: true }).click();
  await drawer
    .getByRole("combobox", { name: "~/Library 分类", exact: true })
    .click();
  await page.getByRole("option", { name: "应用数据", exact: true }).click();
  await expect(drawer.getByText("自定义", { exact: true })).toHaveCount(1);
  await drawer.getByRole("button", { name: "保存到节点" }).click();
  await expect(
    drawer.getByText("目录规则已保存，下次扫描生效。"),
  ).toBeVisible();
  await drawer.getByText("目录规则 · yd-mini", { exact: true }).click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("directory-rules.png") });
  const a11y = await new AxeBuilder({ page })
    .include(".directory-rules-drawer")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await drawer
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.reload();
  await page.getByRole("button", { name: "目录规则", exact: true }).click();
  await expect(
    drawer
      .getByRole("combobox", { name: "~/Library 下钻深度", exact: true })
      .locator(".."),
  ).toContainText("3 层");
  await drawer.getByRole("button", { name: "添加规则", exact: true }).click();
  const add = page.getByRole("dialog", { name: "添加目录规则", exact: true });
  await add.getByRole("textbox", { name: "目录路径" }).fill("~/Library");
  await add.getByRole("button", { name: "添加", exact: true }).click();
  await expect(add.getByText("此路径已有规则，请直接编辑对应行")).toBeVisible();
  await add.getByRole("textbox", { name: "目录路径" }).fill("~/Projects");
  await add.getByRole("button", { name: "添加", exact: true }).click();
  await expect(
    drawer.getByRole("button", { name: "删除 ~/Projects" }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "保存到节点" }).click();
  await expect(
    drawer.getByText("目录规则已保存，下次扫描生效。"),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "目录规则", exact: true }).click();
  await expect(
    drawer.getByRole("button", { name: "删除 ~/Projects" }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "删除 ~/Projects" }).click();
  await drawer.getByRole("button", { name: "恢复 ~/Library" }).click();
  await drawer.getByRole("button", { name: "保存到节点" }).click();
  await expect(
    drawer.getByText("目录规则已保存，下次扫描生效。"),
  ).toBeVisible();
  const route = "/api/hosts/yd-mini/disk-rules";
  const current = DiskRulesViewSchema.parse(
    await (await page.request.get(route)).json(),
  );
  await page.request.put(route, {
    data: {
      revision: current.revision,
      config: { use_defaults: false, rules: [] },
    },
  });
  await drawer
    .getByRole("combobox", { name: "~/Library 下钻深度", exact: true })
    .click();
  await page.getByRole("option", { name: "2 层", exact: true }).click();
  await drawer.getByRole("button", { name: "保存到节点" }).click();
  await expect(
    drawer.getByText("目录规则已变更，请重新载入后再保存"),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "重新载入规则" }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    drawer.getByRole("switch", { name: "启用默认规则" }),
  ).not.toBeChecked();
  await drawer.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await drawer.getByRole("button", { name: "保存到节点" }).click();
  await expect(
    drawer.getByText("目录规则已保存，下次扫描生效。"),
  ).toBeVisible();
  await expect(
    drawer.getByText("插件 · runners", { exact: true }),
  ).toBeVisible();
  const other = DiskRulesViewSchema.parse(
    await (await page.request.get("/api/hosts/yd-mini-2/disk-rules")).json(),
  );
  expect(other.revision).toBe("v1");
  expect(other.config).toEqual({ use_defaults: true, rules: [] });
  expect(errors).toEqual([]);
});

test("directory rules: failed saves keep the draft and reload discards it", async ({
  page,
}) => {
  test.setTimeout(scaledTestTimeout(60_000));
  await page.goto("/storage?host=yd-mini");
  await page.getByRole("button", { name: "目录规则", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "目录规则 · yd-mini",
    exact: true,
  });
  await drawer
    .getByRole("combobox", { name: "~/Library 下钻深度", exact: true })
    .click();
  await page.getByRole("option", { name: "2 层", exact: true }).click();
  const gate = Promise.withResolvers<undefined>();
  await page.route("**/api/hosts/yd-mini/disk-rules", async (route) => {
    if (route.request().method() === "PUT") {
      await gate.promise;
      await route.fulfill({
        status: 503,
        json: { error: "服务暂时无法完成请求" },
      });
    } else await route.continue();
  });
  await drawer.getByRole("button", { name: "保存到节点" }).click();
  try {
    await expect(
      drawer.getByRole("combobox", { name: "~/Library 下钻深度", exact: true }),
    ).toBeDisabled();
  } finally {
    gate.resolve(undefined);
  }
  await expect(drawer.getByText("服务暂时无法完成请求")).toBeVisible();
  await expect(drawer.getByText("有未保存的修改")).toBeVisible();
  await drawer
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "放弃未保存的目录规则？", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await drawer
    .getByRole("button", { name: "重新载入规则", exact: true })
    .click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(drawer.getByText("规则已与节点同步")).toBeVisible();
  await expect(drawer.getByText("自定义", { exact: true })).toHaveCount(0);
});

test("directory rules: English and dark theme remain accessible", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem("mini-archipel.language", "en");
    localStorage.setItem("mini-archipel.theme", "dark");
  });
  await page.goto("/storage?host=yd-mini");
  await page
    .getByRole("button", { name: "Directory rules", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Directory rules · yd-mini",
    exact: true,
  });
  await expect(drawer.getByText("Default", { exact: true })).toHaveCount(2);
  await expect(
    drawer.getByText("Plugin · runners", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    drawer.getByRole("button", { name: "Save to node", exact: true }),
  ).toBeDisabled();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".directory-rules-drawer")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("directory-rules-dark-english.png"),
  });
});
