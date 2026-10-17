import { DatabaseSync } from "node:sqlite";
import { PointSchema, type Point } from "./contracts.ts";
const DAY = 86_400_000;
export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples_raw (host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS raw_lookup ON samples_raw(host, key, ts);
      CREATE TABLE IF NOT EXISTS samples_mid (host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(host,key,ts));
      CREATE TABLE IF NOT EXISTS samples_coarse (host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(host,key,ts));`);
  }
  insertSamples(
    rows: { host: string; key: string; ts: number; value: number }[],
  ): void {
    if (!rows.length) return;
    const insert = this.db.prepare(
      "INSERT INTO samples_raw (host,key,ts,value) VALUES (?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) insert.run(row.host, row.key, row.ts, row.value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  queryRange(host: string, key: string, fromTs: number, toTs: number): Point[] {
    // Include every retention tier: a 7-day query still needs the last day of raw samples.
    const bucket = Math.max(1, Math.ceil((toTs - fromTs) / 1200));
    return PointSchema.array().parse(
      this.db
        .prepare(
          `SELECT CAST(ts / ? AS INTEGER) * ? AS ts, AVG(value) AS value FROM (
      SELECT ts,value FROM samples_coarse WHERE host=? AND key=? AND ts BETWEEN ? AND ?
      UNION ALL SELECT ts,value FROM samples_mid WHERE host=? AND key=? AND ts BETWEEN ? AND ?
      UNION ALL SELECT ts,value FROM samples_raw WHERE host=? AND key=? AND ts BETWEEN ? AND ?
    ) GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts`,
        )
        .all(
          bucket,
          bucket,
          host,
          key,
          fromTs,
          toTs,
          host,
          key,
          fromTs,
          toTs,
          host,
          key,
          fromTs,
          toTs,
          bucket,
        ),
    );
  }
  downsampleAndPrune(now = Date.now()): void {
    const rawCutoff = Math.floor((now - DAY) / 10_000) * 10_000;
    const midCutoff = Math.floor((now - 30 * DAY) / 60_000) * 60_000;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO samples_mid SELECT host,key,CAST(ts / 10000 AS INTEGER)*10000,AVG(value) FROM samples_raw WHERE ts < ? GROUP BY host,key,CAST(ts / 10000 AS INTEGER)`,
        )
        .run(rawCutoff);
      this.db.prepare("DELETE FROM samples_raw WHERE ts < ?").run(rawCutoff);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO samples_coarse SELECT host,key,CAST(ts / 60000 AS INTEGER)*60000,AVG(value) FROM samples_mid WHERE ts < ? GROUP BY host,key,CAST(ts / 60000 AS INTEGER)`,
        )
        .run(midCutoff);
      this.db.prepare("DELETE FROM samples_mid WHERE ts < ?").run(midCutoff);
      this.db
        .prepare("DELETE FROM samples_coarse WHERE ts < ?")
        .run(now - 365 * DAY);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
