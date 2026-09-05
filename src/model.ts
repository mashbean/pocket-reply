import { MODEL, NeuronLedger, neuronsForPrompts } from "./ai-budget";

export type PromptKind = "cluster" | "arc" | "takes" | "replies";

export type ModelCallResult =
  | { ok: true; text: string; neurons: number }
  | { ok: false; reason: "budget"; neurons: number }
  | { ok: false; reason: "error"; error: string };

export type GlobalReserve = (neurons: number) => Promise<boolean>;

export async function runModel(
  env: Env,
  kind: PromptKind,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  ledger: NeuronLedger,
  reserveGlobal: GlobalReserve,
): Promise<ModelCallResult> {
  const neurons = neuronsForPrompts(systemPrompt, userPrompt, maxTokens);
  if (!ledger.tryReserve(neurons)) return { ok: false, reason: "budget", neurons };
  let granted = false;
  try {
    granted = await reserveGlobal(neurons);
  } catch (error) {
    return { ok: false, reason: "error", error: `coordinator: ${describe(error)}` };
  }
  if (!granted) return { ok: false, reason: "budget", neurons };
  if (String(env.AI_MODE) === "fake") return { ok: true, text: fakeResponse(kind, userPrompt), neurons };
  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      chat_template_kwargs: { enable_thinking: false },
    } as never);
    return { ok: true, text: extractText(result), neurons };
  } catch (error) {
    return { ok: false, reason: "error", error: `model: ${describe(error)}` };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

export function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return JSON.stringify(result);
  const record = result as Record<string, unknown>;
  if (typeof record.response === "string" && record.response) return record.response;
  const fromResponse = flattenContent(record.response);
  if (fromResponse) return fromResponse;
  const fromRoot = flattenContent(result);
  if (fromRoot) return fromRoot;
  if (Array.isArray(record.choices) && record.choices.length > 0) {
    const choice = record.choices[0] as Record<string, unknown> | undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string" && message.content) return message.content;
    const fromParts = flattenContent(message?.content);
    if (fromParts) return fromParts;
  }
  return JSON.stringify(result);
}

function flattenContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      if (record.type === "thinking" || record.type === "reasoning") return "";
      return typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
}

export function parseJsonSafe<T>(text: string): T | null {
  if (!text || typeof text !== "string") return null;
  let clean = text.trim();
  if (clean.startsWith("```")) clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  clean = clean.trim();
  const attempt = (slice: string): T | null => {
    try {
      return JSON.parse(slice) as T;
    } catch {
      return null;
    }
  };
  const direct = attempt(clean);
  if (direct !== null) return direct;
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const object = attempt(clean.slice(firstBrace, lastBrace + 1));
    if (object !== null) return object;
  }
  const firstBracket = clean.indexOf("[");
  const lastBracket = clean.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const array = attempt(clean.slice(firstBracket, lastBracket + 1));
    if (array !== null) return array;
  }
  return null;
}

/** 測試用的假模型：依提示詞裡的 id 回傳合乎格式的結果。 */
function fakeResponse(kind: PromptKind, userPrompt: string): string {
  const ids = [...userPrompt.matchAll(/^\[([^\]\n]+)\] /gm)].map((match) => match[1] as string);
  if (kind === "cluster") {
    const half = Math.ceil(ids.length / 2);
    return JSON.stringify({
      beats: [
        { title: "供電與代價", ache: "大家想知道燈會不會亮、帳單會不會漲。", memberQids: ids.slice(0, half), representativeQid: ids[0] ?? "" },
        { title: "風險與核廢", ache: "誰承擔風險、廢料去哪裡。", memberQids: ids.slice(half), representativeQid: ids[half] ?? "" },
      ],
      bridges: ids.length >= 2 ? [{ tension: "供電穩定與核廢責任", qids: [ids[0], ids[ids.length - 1]], resolution: "條件先講清楚，再談要不要。" }] : [],
    });
  }
  if (kind === "arc") {
    const beatIds = [...userPrompt.matchAll(/beatId=(b\d+)/g)].map((match) => match[1] as string);
    return JSON.stringify({
      throughline: "先把條件講清楚，再談要不要。",
      opening: "從大家共同的不安開始。",
      closing: "留下可以追蹤的承諾。",
      order: beatIds.map((beatId, index) => ({ beatId, theTurn: `第 ${index + 1} 段的轉折`, bridgeToNext: index < beatIds.length - 1 ? "接到下一段" : "" })),
    });
  }
  if (kind === "takes") {
    const beatIds = [...userPrompt.matchAll(/beatId=(b\d+)/g)].map((match) => match[1] as string);
    return JSON.stringify({ takes: beatIds.map((beatId) => ({ beatId, take: `${beatId} 的一句話立場`, citations: (userPrompt.match(/https?:\/\/[^\s)]+/) || []).slice(0, 1) })) });
  }
  return JSON.stringify({ replies: ids.map((qid) => ({ qid, reply: `謝謝你問了「${qid}」這個問題，它落在這一段，我們把它帶進了立場：這句話回答你。感謝你把它說出來，我們會繼續追蹤。` })) });
}
