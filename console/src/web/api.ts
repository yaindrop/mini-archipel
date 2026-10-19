import { type Translate, remoteText } from "../messages.ts";
import { t } from "@lingui/core/macro";
import type { z } from "zod";
import {
  ArchipelSchema,
  HistorySchema,
  OkSchema,
  SessionSchema,
  ConfigViewSchema,
} from "../contracts.ts";
import { DiskRulesViewSchema, type DiskRulesUpdate } from "../storage-rules.ts";
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : t`请求失败（${String(response.status)}）`;
    throw new ApiError(response.status, message);
  }
  const result = schema.safeParse(payload);
  if (!result.success)
    throw new ApiError(502, t`收到的数据不符合接口约定，请刷新后重试`);
  return result.data;
}
export const api = {
  session: () => request("/api/session", SessionSchema),
  login: (token: string) =>
    request("/api/session", OkSchema, {
      method: "POST",
      body: JSON.stringify({
        token,
      }),
    }),
  logout: () =>
    request("/api/session", OkSchema, {
      method: "DELETE",
    }),
  archipel: (signal?: AbortSignal) =>
    request(
      "/api/state",
      ArchipelSchema,
      signal
        ? {
            signal,
          }
        : {},
    ),
  config: () => request("/api/config", ConfigViewSchema),
  history: (host: string, key: string, windowMs: number, signal: AbortSignal) =>
    request(
      `/api/history?${new URLSearchParams({
        host,
        key,
        windowMs: String(windowMs),
      }).toString()}`,
      HistorySchema,
      {
        signal,
      },
    ),
  pluginAction: (id: string, action: string, body: unknown) =>
    request(
      `/api/plugins/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
      OkSchema,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  setPlugin: (id: string, enabled: boolean) =>
    request(`/api/plugins/${encodeURIComponent(id)}`, OkSchema, {
      method: "PUT",
      body: JSON.stringify({
        enabled,
      }),
    }),
  agentPlugin: (host: string, id: string, enabled: boolean) =>
    request(
      `/api/hosts/${encodeURIComponent(host)}/plugins/${encodeURIComponent(id)}`,
      OkSchema,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled,
        }),
      },
    ),
  diskRules: (host: string) =>
    request(
      `/api/hosts/${encodeURIComponent(host)}/disk-rules`,
      DiskRulesViewSchema,
    ),
  saveDiskRules: (host: string, update: DiskRulesUpdate) =>
    request(
      `/api/hosts/${encodeURIComponent(host)}/disk-rules`,
      DiskRulesViewSchema,
      { method: "PUT", body: JSON.stringify(update) },
    ),
  rescan: (host: string, path?: string) =>
    request("/api/disk/rescan", OkSchema, {
      method: "POST",
      body: JSON.stringify({
        host,
        path,
      }),
    }),
  cancelScan: (host: string, id: number) =>
    request("/api/disk/cancel", OkSchema, {
      method: "POST",
      body: JSON.stringify({ host, id }),
    }),
};
export function message(error: unknown, translate?: Translate): string {
  return error instanceof Error
    ? remoteText(error.message, translate)
    : t`请求未完成，请重试`;
}
