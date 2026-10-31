// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { i18n } from "@lingui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router";
import type { Host } from "../../src/contracts.ts";
import { MiniProxy } from "../../src/plugins/mini-proxy/workbench.tsx";
import { api } from "../../src/web/api.ts";
import { makeHost } from "../fixtures.ts";

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

function withProxy(index: number, node: string): Host {
  const host = makeHost(index);
  host.snapshot?.plugins &&
    (host.snapshot.plugins["mini-proxy"] = {
      version: 1,
      enabled: true,
      status: "ready",
      ts: Date.now(),
      error: null,
      data: {
        availability: "ready",
        current_node: node,
        nodes: [node],
        probe: {
          status_code: 204,
          latency_ms: 10,
          error: null,
          ts: Date.now(),
        },
        health: {
          [node]: {
            ok: true,
            check_ms: 10,
            ts: Date.now(),
            detail: "latency_ms 10",
          },
        },
        control_allowed: true,
        interval_ms: 30_000,
      },
    });
  return host;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mini-proxy check-all", () => {
  it("keeps the speed-test spinner on the host that started it", async () => {
    const pending = new Map<string, (value: { ok: boolean }) => void>();
    vi.spyOn(api, "pluginAction").mockImplementation(
      (_id, _action, body) =>
        new Promise((resolve) => {
          pending.set((body as { host: string }).host, resolve);
        }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const now = Date.now();
    render(
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AntApp>
              <MiniProxy
                now={now}
                archipel={{
                  ts: now,
                  hosts: [withProxy(0, "akile-de"), withProxy(1, "akile-sg")],
                  plugins: {},
                }}
              />
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );
    const user = userEvent.setup();
    const button = () => screen.getByRole("button", { name: /全部测速/ });
    expect(screen.getByText("akile-de · 出口正常")).toBeVisible();
    await user.click(button());
    expect(button()).toHaveClass("ant-btn-loading");
    expect(screen.getByText("测速中")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "选择 yd-mini-2", exact: true }),
    );
    expect(
      screen.getByRole("heading", { name: "yd-mini-2", exact: true }),
    ).toBeVisible();
    expect(button()).not.toHaveClass("ant-btn-loading");
    await user.click(
      screen.getByRole("button", { name: "选择 yd-mini", exact: true }),
    );
    expect(button()).toHaveClass("ant-btn-loading");
    pending.get("yd-mini")?.({ ok: true });
  });
});
