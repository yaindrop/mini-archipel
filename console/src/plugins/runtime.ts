import type { ConsoleConfig } from "../config.ts";
import type { Host } from "../contracts.ts";
import { UpstreamError, type Transport } from "../fleet.ts";
import type { PluginView } from "./contracts.ts";
export interface PluginContext {
  hosts: () => Host[];
  pollHost: (host: string) => Promise<void>;
  command: (
    host: string,
    path: string,
    body: unknown,
    method?: "POST" | "PUT",
  ) => Promise<unknown>;
  transport: Transport;
}
export interface PluginInstance {
  read: () => unknown;
  action: (action: string, body: unknown) => Promise<unknown>;
  start: () => void;
  stop: () => void;
}
export interface PluginDefinition {
  id: string;
  label: string;
  description: string;
  version: string;
  create: (
    context: PluginContext,
    options: Record<string, unknown>,
  ) => PluginInstance;
}
export class PluginManager {
  private readonly definitions = new Map<string, PluginDefinition>();
  private readonly instances = new Map<string, PluginInstance>();
  private readonly failures = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private config: ConsoleConfig;
  private readonly context: PluginContext;
  private readonly persist: (config: ConsoleConfig) => void;
  constructor(
    config: ConsoleConfig,
    context: PluginContext,
    definitions: PluginDefinition[],
    persist: (config: ConsoleConfig) => void = () => undefined,
  ) {
    this.config = config;
    this.context = context;
    this.persist = persist;
    for (const definition of definitions) {
      if (this.definitions.has(definition.id))
        throw new Error("Duplicate plugin id");
      this.definitions.set(definition.id, definition);
      const setting = config.plugins[definition.id];
      if (setting?.enabled) {
        try {
          this.instances.set(
            definition.id,
            definition.create(context, setting.options),
          );
        } catch {
          this.failures.set(definition.id, /*i18n*/ "插件配置无效或初始化失败");
        }
      }
    }
    for (const id of Object.keys(config.plugins))
      if (!this.definitions.has(id))
        throw new Error(`Plugin not installed: ${id}`);
  }
  views(): Record<string, PluginView> {
    return Object.fromEntries(
      [...this.definitions].map(([id, definition]) => {
        let data: unknown = null,
          error = this.failures.get(id) ?? null;
        try {
          const serialized: unknown = JSON.stringify(
            this.instances.get(id)?.read() ?? null,
          );
          if (typeof serialized !== "string")
            throw new Error("Plugin state is not JSON");
          data = JSON.parse(serialized) as unknown;
        } catch {
          error = /*i18n*/ "插件状态暂不可用";
        }
        return [
          id,
          {
            id,
            label: definition.label,
            description: definition.description,
            version: definition.version,
            enabled: this.config.plugins[id]?.enabled ?? false,
            data,
            error,
          },
        ];
      }),
    );
  }
  start() {
    if (this.running) return;
    this.running = true;
    for (const [id, instance] of this.instances) {
      try {
        instance.start();
      } catch {
        instance.stop();
        this.failures.set(id, /*i18n*/ "插件启动失败");
      }
    }
  }
  stop() {
    this.running = false;
    for (const instance of this.instances.values()) instance.stop();
  }
  private serial<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.serial(() => {
      const definition = this.definitions.get(id);
      if (!definition) throw new UpstreamError(404, /*i18n*/ "插件未安装");
      const setting = this.config.plugins[id] ?? {
        enabled: false,
        options: {},
      };
      if (setting.enabled === enabled && !this.failures.has(id)) return;
      let instance: PluginInstance | undefined;
      try {
        if (enabled)
          instance = definition.create(this.context, setting.options);
      } catch {
        throw new UpstreamError(400, /*i18n*/ "插件配置无效，请检查配置后重试");
      }
      const updated = {
        ...this.config,
        plugins: {
          ...this.config.plugins,
          [id]: {
            ...setting,
            enabled,
          },
        },
      };
      try {
        if (this.running) instance?.start();
        this.persist(updated);
      } catch {
        instance?.stop();
        throw new UpstreamError(500, /*i18n*/ "插件配置未保存，原状态保持不变");
      }
      this.instances.get(id)?.stop();
      this.instances.delete(id);
      this.failures.delete(id);
      if (instance) this.instances.set(id, instance);
      this.config = updated;
    });
  }
  action(id: string, action: string, body: unknown): Promise<unknown> {
    return this.serial(async () => {
      if (!this.definitions.has(id))
        throw new UpstreamError(404, /*i18n*/ "插件未安装");
      const instance = this.instances.get(id);
      if (!this.config.plugins[id]?.enabled)
        throw new UpstreamError(409, /*i18n*/ "插件未启用");
      if (!instance || this.failures.has(id))
        throw new UpstreamError(503, /*i18n*/ "插件暂不可用，请检查插件状态");
      return instance.action(action, body);
    });
  }
  setAgentEnabled(
    host: string,
    id: string,
    enabled: boolean,
  ): Promise<unknown> {
    return this.serial(async () => {
      if (!this.definitions.has(id))
        throw new UpstreamError(404, /*i18n*/ "插件未安装");
      const result = await this.context.command(
        host,
        `plugins/${encodeURIComponent(id)}`,
        {
          enabled,
        },
        "PUT",
      );
      await this.context.pollHost(host);
      return result;
    });
  }
}
