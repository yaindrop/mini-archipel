import { parentPort, workerData } from "node:worker_threads";
import { HistoryDatabase } from "./history-db.ts";
import type { Sample } from "./store.ts";
const db = new HistoryDatabase(String(workerData));
parentPort?.on(
  "message",
  (message: { id: number; action: string; args: unknown[] }) => {
    const { id, action, args } = message;
    try {
      let result: unknown;
      switch (action) {
        case "insert":
          db.insertSamples(args[0] as Sample[]);
          break;
        case "query":
          result = db.queryRange(
            String(args[0]),
            String(args[1]),
            Number(args[2]),
            Number(args[3]),
          );
          break;
        case "prune":
          db.downsampleAndPrune(Number(args[0]));
          break;
        case "latest":
          result = db.latestTimestamp(String(args[0]), String(args[1]));
          break;
        case "close":
          db.close();
          break;
        default:
          throw new Error("invalid history operation");
      }
      parentPort?.postMessage({ id, result });
      if (action === "close") parentPort?.close();
    } catch {
      parentPort?.postMessage({
        id,
        error: "history storage operation failed",
      });
    }
  },
);
