import { Worker } from "node:worker_threads";
import { PointSchema } from "./contracts.ts";
export interface Sample {
  host: string;
  key: string;
  ts: number;
  value: number;
}
export class Store {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private next = 0;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private failure: Error | null = null;
  constructor(path: string) {
    this.worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./store-worker.ts"
          : "./store-worker.cjs",
        import.meta.url,
      ),
      { workerData: path },
    );
    this.worker.on(
      "message",
      (message: { id: number; result?: unknown; error?: string }) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      },
    );
    this.worker.on("error", () => {
      this.fail(new Error("history worker unavailable"));
    });
    this.worker.on("exit", (code) => {
      if (!this.closing || code !== 0 || this.pending.size > 0)
        this.fail(new Error("history worker stopped"));
    });
  }
  private fail(error: Error) {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private call(action: string, args: unknown[] = []): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && action !== "close")
      return Promise.reject(new Error("history store is closing"));
    if (action !== "close" && this.pending.size >= 256)
      return Promise.reject(new Error("history queue is full"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, args });
    });
  }
  async insertSamples(rows: Sample[]): Promise<void> {
    if (rows.length) await this.call("insert", [rows]);
  }
  async queryRange(host: string, key: string, from: number, to: number) {
    return PointSchema.array().parse(
      await this.call("query", [host, key, from, to]),
    );
  }
  async latestTimestamp(host: string, key: string): Promise<number> {
    return Number(await this.call("latest", [host, key]));
  }
  async downsampleAndPrune(now = Date.now()): Promise<void> {
    await this.call("prune", [now]);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await this.call("close");
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closePromise;
  }
}
