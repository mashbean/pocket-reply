import { DurableObject } from "cloudflare:workers";
import {
  ARC_MAX_OUTPUT_TOKENS,
  ARC_PROMPT_MAX_BYTES,
  CALLS_PER_ALARM,
  CLUSTER_MAX_OUTPUT_TOKENS,
  CLUSTER_PROMPT_MAX_BYTES,
  LOOP_NEURON_CEILING,
  MODEL,
  NeuronLedger,
  REPLIES_MAX_OUTPUT_TOKENS,
  REPLIES_PROMPT_MAX_BYTES,
  REPLY_BATCH_SIZE,
  TAKES_MAX_OUTPUT_TOKENS,
  TAKES_PROMPT_MAX_BYTES,
  nextUtcDayStart,
} from "./ai-budget";
import { COORDINATOR_INSTANCE } from "./coordinator";
import { parseJsonSafe, runModel, type PromptKind } from "./model";
import {
  arcPrompt,
  assignRoles,
  buildReceipt,
  clusterPrompt,
  ingest,
  normalizeArc,
  normalizeCluster,
  normalizeReplies,
  normalizeTakes,
  repliesPrompt,
  systemPrompt,
  takesPrompt,
  type Settings,
} from "./pipeline";
import type { Beat, Bridge, Loopback, LoopStatus, Progress, PublicLoop, Question, Receipt, Take } from "./types";
import type { SourceRow } from "./csv";

type LoopMeta = Settings & { loopId: string; createdAt: number; updatedAt: number; adminHash: string };
export type CreateLoopInput = { loopId: string; adminHash: string; settings: Settings; rows: SourceRow[] };

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 20_000;

/** 一個問題池一個 Durable Object：提問、段落、弧線、立場、回覆與收據。alarm 驅動，進度落盤。 */
export class LoopRoom extends DurableObject<Env> {
  private migrated = false;

  private sql() {
    if (!this.migrated) {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS loopbacks (qid TEXT PRIMARY KEY, beat_id TEXT NOT NULL, role TEXT NOT NULL, reply TEXT NOT NULL)`);
      this.migrated = true;
    }
    return this.ctx.storage.sql;
  }

  private getMeta<T>(key: string): T | null {
    const rows = this.sql().exec(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    if (rows.length === 0) return null;
    try {
      return JSON.parse(String(rows[0]?.value)) as T;
    } catch {
      return null;
    }
  }

  private setMeta(key: string, value: unknown): void {
    this.sql().exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, JSON.stringify(value));
  }

  async create(input: CreateLoopInput): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.getMeta<LoopMeta>("loop")) return { ok: false, error: "loop already exists" };
    const now = Date.now();
    const questions = ingest(input.rows);
    this.ctx.storage.transactionSync(() => {
      this.setMeta("loop", { ...input.settings, loopId: input.loopId, createdAt: now, updatedAt: now, adminHash: input.adminHash });
      this.setMeta("questions", questions);
      this.setMeta("progress", initialProgress(questions.length));
      this.setMeta("ledger", 0);
    });
    await this.ctx.storage.setAlarm(now + 250);
    return { ok: true };
  }

  async publicLoop(): Promise<PublicLoop | null> {
    const meta = this.getMeta<LoopMeta>("loop");
    if (!meta) return null;
    const progress = this.getMeta<Progress>("progress") ?? initialProgress(0);
    return {
      loopId: meta.loopId,
      title: meta.title,
      speaker: meta.speaker,
      standfirst: meta.standfirst,
      language: meta.language,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      questions: (this.getMeta<Question[]>("questions") ?? []).length,
      progress,
      model: String(this.env.AI_MODE) === "fake" ? "fake" : MODEL,
      receipt: progress.status === "ready" ? this.getMeta<Receipt>("receipt") : null,
    };
  }

  async verifyAdmin(hash: string): Promise<boolean> {
    const meta = this.getMeta<LoopMeta>("loop");
    return Boolean(meta) && timingSafeEqual(meta?.adminHash ?? "", hash);
  }

  async deleteLoop(): Promise<boolean> {
    const meta = this.getMeta<LoopMeta>("loop");
    if (!meta) return false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.migrated = false;
    this.sql();
    this.setMeta("loop", { ...meta, title: "", speaker: "", standfirst: "", positions: "" });
    this.setMeta("progress", { ...initialProgress(0), status: "deleted" satisfies LoopStatus });
    return true;
  }

  async retry(): Promise<boolean> {
    const progress = this.getMeta<Progress>("progress");
    if (!progress || !["failed", "waiting-budget"].includes(progress.status)) return false;
    this.setMeta("progress", { ...progress, status: progress.step === "clustering" ? "queued" : (progress.step as LoopStatus), attempts: 0, lastError: "", nextAttemptAt: null });
    await this.ctx.storage.setAlarm(Date.now() + 250);
    return true;
  }

  async repliesRows(): Promise<{ qid: string; sourceId: string; name: string; question: string; beat: string; role: string; reply: string }[]> {
    const receipt = this.getMeta<Receipt>("receipt");
    if (!receipt) return [];
    const beats = new Map(receipt.beats.map((beat) => [beat.beatId, beat.title]));
    const byQid = new Map(receipt.loopbacks.map((loopback) => [loopback.qid, loopback]));
    return receipt.questions.map((question) => {
      const loopback = byQid.get(question.qid);
      return { qid: question.qid, sourceId: question.sourceId, name: question.name, question: question.text, beat: beats.get(loopback?.beatId ?? "") ?? "", role: loopback?.role ?? "", reply: loopback?.reply ?? "" };
    });
  }

  // ---- 管線 ----

  async alarm(): Promise<void> {
    const meta = this.getMeta<LoopMeta>("loop");
    const progress = this.getMeta<Progress>("progress");
    if (!meta || !progress) return;
    if (["ready", "failed", "deleted"].includes(progress.status)) return;
    if (progress.status === "waiting-budget" && progress.nextAttemptAt && Date.now() < progress.nextAttemptAt) {
      await this.ctx.storage.setAlarm(progress.nextAttemptAt);
      return;
    }
    const questions = this.getMeta<Question[]>("questions") ?? [];
    const ledger = new NeuronLedger(LOOP_NEURON_CEILING, this.getMeta<number>("ledger") ?? 0);
    const coordinator = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName(COORDINATOR_INSTANCE));
    const reserveGlobal = async (neurons: number) => (await coordinator.reserveNeurons(neurons)).ok;
    const system = systemPrompt(meta);
    let calls = 0;
    let current: Progress = progress.status === "waiting-budget" || progress.status === "queued"
      ? { ...progress, status: progress.step === "clustering" ? "clustering" : (progress.step as LoopStatus), nextAttemptAt: null }
      : progress;
    const call = async (kind: PromptKind, user: string, maxTokens: number) => {
      calls += 1;
      const result = await runModel(this.env, kind, system, user, maxTokens, ledger, reserveGlobal);
      this.setMeta("ledger", ledger.reserved);
      return result;
    };
    const save = (next: Partial<Progress>) => {
      current = { ...current, ...next, neuronsReserved: ledger.reserved };
      this.setMeta("progress", current);
      this.setMeta("loop", { ...meta, updatedAt: Date.now() });
    };

    try {
      while (calls < CALLS_PER_ALARM) {
        if (current.status === "clustering") {
          const result = await call("cluster", clusterPrompt(meta, questions, CLUSTER_PROMPT_MAX_BYTES), CLUSTER_MAX_OUTPUT_TOKENS);
          if (!result.ok) return await this.fail(result, current, save);
          const cluster = normalizeCluster(parseJsonSafe(result.text), questions);
          if (!cluster) return await this.fail({ ok: false, reason: "error", error: "clustering returned no usable beats" }, current, save);
          this.setMeta("beats", cluster.beats);
          this.setMeta("bridges", cluster.bridges);
          save({ status: "arcing", step: "arcing", done: 0, total: 1, attempts: 0, lastError: "" });
          continue;
        }
        if (current.status === "arcing") {
          const beats = this.getMeta<Beat[]>("beats") ?? [];
          const bridges = this.getMeta<Bridge[]>("bridges") ?? [];
          const result = await call("arc", arcPrompt(meta, beats, bridges, ARC_PROMPT_MAX_BYTES), ARC_MAX_OUTPUT_TOKENS);
          if (!result.ok) return await this.fail(result, current, save);
          const arc = normalizeArc(parseJsonSafe(result.text), beats);
          this.setMeta("beats", arc.beats);
          this.setMeta("arc", { throughline: arc.throughline, opening: arc.opening, closing: arc.closing });
          save({ status: "forging", step: "forging", done: 0, total: 1, attempts: 0, lastError: "" });
          continue;
        }
        if (current.status === "forging") {
          const beats = this.getMeta<Beat[]>("beats") ?? [];
          const result = await call("takes", takesPrompt(meta, beats, questions, TAKES_PROMPT_MAX_BYTES), TAKES_MAX_OUTPUT_TOKENS);
          if (!result.ok) return await this.fail(result, current, save);
          this.setMeta("takes", normalizeTakes(parseJsonSafe(result.text), beats, meta.positions));
          this.setMeta("replyCursor", 0);
          save({ status: "replying", step: "replying", done: 0, total: questions.length, attempts: 0, lastError: "" });
          continue;
        }
        if (current.status === "replying") {
          const beats = this.getMeta<Beat[]>("beats") ?? [];
          const bridges = this.getMeta<Bridge[]>("bridges") ?? [];
          const takes = this.getMeta<Take[]>("takes") ?? [];
          const roles = assignRoles(beats, bridges);
          const pending = questions.filter((question) => !this.hasReply(question.qid));
          if (pending.length === 0) {
            const arc = this.getMeta<{ throughline: string; opening: string; closing: string }>("arc") ?? { throughline: "", opening: "", closing: "" };
            const receipt = buildReceipt({ ...arc, beats, bridges, takes, loopbacks: this.allReplies(), questions, generatedAt: Date.now() });
            this.setMeta("receipt", receipt);
            save({ status: "ready", step: "ready", done: questions.length, attempts: 0, lastError: "", nextAttemptAt: null });
            return;
          }
          const batch = pending.slice(0, REPLY_BATCH_SIZE).map((question) => {
            const assignment = roles.get(question.qid) ?? { beatId: beats[0]?.beatId ?? "b1", role: "keeper" as const, chorusSize: 1 };
            const beat = beats.find((candidate) => candidate.beatId === assignment.beatId) ?? (beats[0] as Beat);
            const take = takes.find((candidate) => candidate.beatId === beat.beatId) ?? { beatId: beat.beatId, take: "", grounded: false, citations: [] };
            return { question, beat, take, role: assignment.role, chorusSize: assignment.chorusSize };
          });
          const result = await call("replies", repliesPrompt(meta, batch, REPLIES_PROMPT_MAX_BYTES), REPLIES_MAX_OUTPUT_TOKENS);
          if (!result.ok) {
            if (result.reason === "error" && current.attempts + 1 >= MAX_ATTEMPTS) {
              // 連續失敗的一批：寫入誠實的保底回覆（不假裝），繼續往前
              for (const item of batch) this.storeReply({ qid: item.question.qid, beatId: item.beat.beatId, role: item.role, reply: fallbackReply(item.question, item.beat, item.take) });
              save({ done: questions.length - pending.length + batch.length, attempts: 0, lastError: `fallback replies for ${batch.length} questions after repeated failures: ${result.error}` });
              continue;
            }
            return await this.fail(result, current, save);
          }
          const replies = normalizeReplies(parseJsonSafe(result.text), batch);
          const got = new Set(replies.map((reply) => reply.qid));
          for (const reply of replies) this.storeReply(reply);
          // 模型漏掉的提問：下一輪再試；連續三次還漏就給保底回覆
          const missed = batch.filter((item) => !got.has(item.question.qid));
          if (missed.length > 0 && missed.length === batch.length) {
            const attempts = current.attempts + 1;
            if (attempts >= MAX_ATTEMPTS) {
              for (const item of missed) this.storeReply({ qid: item.question.qid, beatId: item.beat.beatId, role: item.role, reply: fallbackReply(item.question, item.beat, item.take) });
              save({ done: questions.length - pending.length + batch.length, attempts: 0, lastError: "fallback replies after the model returned none" });
            } else {
              save({ attempts, lastError: "model returned no usable replies for a batch; retrying" });
            }
            continue;
          }
          save({ done: questions.length - pending.length + replies.length, attempts: 0 });
          continue;
        }
        save({ status: "clustering", step: "clustering" });
      }
      await this.ctx.storage.setAlarm(Date.now() + 500);
    } catch (error) {
      await this.fail({ ok: false, reason: "error", error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, current, save);
    }
  }

  private async fail(
    result: { ok: false; reason: "budget"; neurons: number } | { ok: false; reason: "error"; error: string },
    current: Progress,
    save: (next: Partial<Progress>) => void,
  ): Promise<void> {
    if (result.reason === "budget") {
      const ledger = this.getMeta<number>("ledger") ?? 0;
      if (ledger + result.neurons > LOOP_NEURON_CEILING) {
        save({ status: "failed", lastError: `這個問題池需要的神經元超過單池上限 ${LOOP_NEURON_CEILING}；請減少提問數或提高上限後重試。`, nextAttemptAt: null });
        return;
      }
      const next = nextUtcDayStart(Date.now());
      save({ status: "waiting-budget", lastError: "今日的 Workers AI 免費額度已用完，明天（UTC）自動續跑。", nextAttemptAt: next });
      await this.ctx.storage.setAlarm(next);
      return;
    }
    const attempts = current.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      save({ status: "failed", attempts, lastError: result.error, nextAttemptAt: null });
      return;
    }
    const next = Date.now() + RETRY_BASE_MS * attempts;
    save({ attempts, lastError: result.error, nextAttemptAt: next });
    await this.ctx.storage.setAlarm(next);
  }

  private hasReply(qid: string): boolean {
    return this.sql().exec(`SELECT 1 FROM loopbacks WHERE qid = ?`, qid).toArray().length > 0;
  }

  private storeReply(reply: Loopback): void {
    this.sql().exec(`INSERT OR REPLACE INTO loopbacks (qid, beat_id, role, reply) VALUES (?, ?, ?, ?)`, reply.qid, reply.beatId, reply.role, reply.reply);
  }

  private allReplies(): Loopback[] {
    return this.sql()
      .exec(`SELECT qid, beat_id, role, reply FROM loopbacks ORDER BY qid`)
      .toArray()
      .map((row) => ({ qid: String(row.qid), beatId: String(row.beat_id), role: String(row.role) as Loopback["role"], reply: String(row.reply) }));
  }
}

function fallbackReply(question: Question, beat: Beat, take: Take): string {
  const who = question.name || "你";
  return `${who}，你問的是「${question.text.slice(0, 80)}」。這個問題落在「${beat.title}」這一段。我這裡還沒有能好好回答你的一句話${take.take ? `，目前的立場是：${take.take}` : ""}；這不是敷衍，而是我還沒準備好。我會把它列入追蹤，補上回覆。謝謝你把它問出來。`;
}

function initialProgress(total: number): Progress {
  return { status: "queued", step: "clustering", done: 0, total, attempts: 0, lastError: "", nextAttemptAt: null, neuronsReserved: 0 };
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
