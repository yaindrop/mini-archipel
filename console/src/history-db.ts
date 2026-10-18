import { DatabaseSync } from "node:sqlite";
import { PointSchema, type Point } from "./contracts.ts";
const DAY = 86_400_000;
export class HistoryDatabase {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS samples_raw (host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS raw_lookup ON samples_raw(host, key, ts);
      CREATE INDEX IF NOT EXISTS raw_time ON samples_raw(ts);
      CREATE TABLE IF NOT EXISTS samples_mid (host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(host,key,ts));
      CREATE TABLE IF NOT EXISTS samples_coarse (host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(host,key,ts));`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS mid_time ON samples_mid(ts); CREATE INDEX IF NOT EXISTS coarse_time ON samples_coarse(ts)",
    );
    for (const table of ["samples_mid", "samples_coarse"]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === "count"))
        this.db.exec(
          `ALTER TABLE ${table} ADD COLUMN count INTEGER NOT NULL DEFAULT 1`,
        );
    }
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
          `SELECT CAST(ts / ? AS INTEGER) * ? AS ts, SUM(value*count)/SUM(count) AS value FROM (
      SELECT ts,value,count FROM samples_coarse WHERE host=? AND key=? AND ts BETWEEN ? AND ?
      UNION ALL SELECT ts,value,count FROM samples_mid WHERE host=? AND key=? AND ts BETWEEN ? AND ?
      UNION ALL SELECT ts,value,1 AS count FROM samples_raw WHERE host=? AND key=? AND ts BETWEEN ? AND ?
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
  latestTimestamp(host: string, key: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT ts FROM samples_raw WHERE host=? AND key=? ORDER BY ts DESC LIMIT 1",
        )
        .get(host, key)?.ts ?? 0,
    );
  }
  downsampleAndPrune(now = Date.now()): void {
    const rawCutoff = Math.floor((now - DAY) / 10_000) * 10_000;
    const midCutoff = Math.floor((now - 30 * DAY) / 60_000) * 60_000;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO samples_mid (host,key,ts,value,count) SELECT host,key,CAST(ts / 10000 AS INTEGER)*10000,AVG(value),COUNT(*) FROM samples_raw WHERE ts < ? GROUP BY host,key,CAST(ts / 10000 AS INTEGER)`,
        )
        .run(rawCutoff);
      this.db.prepare("DELETE FROM samples_raw WHERE ts < ?").run(rawCutoff);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO samples_coarse (host,key,ts,value,count) SELECT host,key,CAST(ts / 60000 AS INTEGER)*60000,SUM(value*count)/SUM(count),SUM(count) FROM samples_mid WHERE ts < ? GROUP BY host,key,CAST(ts / 60000 AS INTEGER)`,
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
