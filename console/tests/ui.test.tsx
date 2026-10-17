import { I18nProvider } from "@lingui/react";
import { i18n } from "@lingui/core";
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App, ErrorBoundary } from "../src/web/App.tsx";
import { api } from "../src/web/api.ts";
import { csvCell } from "../src/web/history.tsx";
import { withLivePlugins } from "../src/web/useFleet.ts";
import { current } from "../src/plugins/runners/domain.ts";
import { makeHost } from "./fixtures.ts";
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
describe("workbench recovery", () => {
  it("keeps connection health and operations current through a long resource pause", () => {
    const frozenHost = makeHost(),
      liveHost = makeHost();
    frozenHost.lastTs -= 60_000;
    if (!frozenHost.snapshot?.sys || !liveHost.snapshot?.sys)
      throw Error("fixture");
    frozenHost.snapshot.sys.cpu.usage_pct = 1;
    liveHost.snapshot.sys.cpu.usage_pct = 99;
    liveHost.snapshot.disk_scan.status = "running";
    const frozen = { ts: frozenHost.lastTs, plugins: {}, hosts: [frozenHost] };
    const updated = withLivePlugins(frozen, {
      ts: Date.now(),
      plugins: {},
      hosts: [liveHost],
    });
    const host = updated.hosts[0];
    if (!host) throw Error("fixture");
    expect(current(host)).toBe(true);
    expect(host.snapshot?.disk_scan.status).toBe("running");
    expect(host.snapshot?.sys?.cpu.usage_pct).toBe(1);
    expect(frozenHost.snapshot.disk_scan.status).toBe("completed");
    liveHost.online = false;
    const offline = withLivePlugins(frozen, { ...updated, hosts: [liveHost] })
      .hosts[0];
    if (!offline) throw Error("fixture");
    expect(current(offline)).toBe(false);
  });
  it("keeps token fields masked and gives an actionable error on rejected login", async () => {
    vi.spyOn(api, "session").mockResolvedValue({
      authenticated: false,
      required: true,
    });
    vi.spyOn(api, "login").mockRejectedValue(Error("访问令牌不正确"));
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    localStorage.setItem("mini-archipel.language", "zh");
    render(
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );
    const field = await screen.findByLabelText("访问令牌");
    expect(field).toHaveAttribute("type", "password");
    const user = userEvent.setup();
    await user.type(field, "wrong-secret");
    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "访问令牌不正确",
    );
    client.clear();
  });
  it("shows a recovery screen instead of leaving a blank console after render failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Broken(): never {
      throw Error("test render failure");
    }
    localStorage.setItem("mini-archipel.language", "zh");
    render(
      <I18nProvider i18n={i18n}>
        <ErrorBoundary>
          <Broken />
        </ErrorBoundary>
      </I18nProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "工作台暂时无法显示" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
  });
  it("escapes CSV spreadsheet formulas and quotes", () => {
    expect(csvCell("=SUM(A1)")).toBe('"\'=SUM(A1)"');
    expect(csvCell('a"b')).toBe('"a""b"');
  });
});
