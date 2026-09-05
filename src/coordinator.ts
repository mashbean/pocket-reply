import { DurableObject } from "cloudflare:workers";
import { DEFAULT_DAILY_CEILING, utcDayKey } from "./ai-budget";

export const COORDINATOR_INSTANCE = "app";
const DAY_KEY = "neurons";
const CREATE_PER_HOUR = 10;
const CREATE_PER_DAY = 50;

export type DailyNeuronState = { utcDay: string; reserved: number };

export function parseDailyNeuronState(raw: unknown): DailyNeuronState | "absent" | "malformed" {
  if (raw == null) return "absent";
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return "malformed";
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "malformed";
  const record = value as Record<string, unknown>;
  if (typeof record.utcDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.utcDay)) return "malformed";
  if (typeof record.reserved !== "number" || !Number.isFinite(record.reserved) || record.reserved < 0) return "malformed";
  return { utcDay: record.utcDay, reserved: record.reserved };
}

/** 純函式：UTC 日預留。壞掉的狀態一律拒絕（fail closed），預留不退還。 */
export function tryReserveDailyNeurons(
  raw: unknown,
  neurons: number,
  now: number,
  ceiling: number,
): { ok: true; next: DailyNeuronState } | { ok: false; remaining: number } {
  if (!Number.isFinite(neurons) || neurons < 0) return { ok: false, remaining: 0 };
  const parsed = parseDailyNeuronState(raw);
  if (parsed === "malformed") return { ok: false, remaining: 0 };
  const day = utcDayKey(now);
  const current = parsed === "absent" || parsed.utcDay !== day ? { utcDay: day, reserved: 0 } : parsed;
  if (current.reserved + neurons > ceiling) return { ok: false, remaining: Math.max(0, ceiling - current.reserved) };
  return { ok: true, next: { utcDay: day, reserved: current.reserved + neurons } };
}

/** 全部署共用的一個 Durable Object：每日神經元帳本與建立報告的頻率限制。 */
export class Coordinator extends DurableObject<Env> {
  private migrated = false;

  private sql() {
    if (!this.migrated) {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS creations (created_at INTEGER NOT NULL)`);
      this.migrated = true;
    }
    return this.ctx.storage.sql;
  }

  private ceiling(): number {
    const raw = Number(this.env.DAILY_NEURON_CEILING);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CEILING;
  }

  /** 以協調器自己的時間算帳單日，避免跨午夜的長工作記到前一天。 */
  async reserveNeurons(neurons: number): Promise<{ ok: boolean; remaining: number }> {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const rows = this.sql().exec(`SELECT value FROM meta WHERE key = ?`, DAY_KEY).toArray();
      const raw = rows.length > 0 ? (rows[0]?.value as string) : null;
      const result = tryReserveDailyNeurons(raw, neurons, now, this.ceiling());
      if (!result.ok) return { ok: false, remaining: result.remaining };
      this.sql().exec(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        DAY_KEY,
        JSON.stringify(result.next),
      );
      return { ok: true, remaining: this.ceiling() - result.next.reserved };
    });
  }

  async dailyRemaining(): Promise<number> {
    const rows = this.sql().exec(`SELECT value FROM meta WHERE key = ?`, DAY_KEY).toArray();
    const parsed = parseDailyNeuronState(rows.length > 0 ? (rows[0]?.value as string) : null);
    if (parsed === "absent" || parsed === "malformed") return this.ceiling();
    if (parsed.utcDay !== utcDayKey(Date.now())) return this.ceiling();
    return Math.max(0, this.ceiling() - parsed.reserved);
  }

  /** 全站建立報告的頻率：每小時 10、每日 50。 */
  async reserveCreation(): Promise<boolean> {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      this.sql().exec(`DELETE FROM creations WHERE created_at < ?`, now - 24 * 60 * 60 * 1000);
      const day = Number(this.sql().exec(`SELECT COUNT(*) AS n FROM creations`).one().n);
      const hour = Number(
        this.sql().exec(`SELECT COUNT(*) AS n FROM creations WHERE created_at >= ?`, now - 60 * 60 * 1000).one().n,
      );
      if (day >= CREATE_PER_DAY || hour >= CREATE_PER_HOUR) return false;
      this.sql().exec(`INSERT INTO creations (created_at) VALUES (?)`, now);
      return true;
    });
  }
}
