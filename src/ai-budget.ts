/**
 * Workers AI 免費額度的硬契約（@cf/google/gemma-4-26b-a4b-it）：9091 神經元 / 百萬輸入 token、
 * 27273 / 百萬輸出 token，每日免費 10,000（UTC 重置）。輸入以 UTF-8 位元組數加模板額外量當上限，
 * 輸出以強制的 max_tokens 計。每個問題池一本帳（LOOP_NEURON_CEILING）、全部署一本日帳（Coordinator）。
 */
export const MODEL = "@cf/google/gemma-4-26b-a4b-it" as const;
export const NEURONS_PER_M_INPUT = 9091;
export const NEURONS_PER_M_OUTPUT = 27273;
export const DEFAULT_DAILY_CEILING = 9_000;
export const LOOP_NEURON_CEILING = 9_000;
export const CHAT_TEMPLATE_OVERHEAD_TOKENS = 256;

export const CLUSTER_MAX_OUTPUT_TOKENS = 2_048;
export const ARC_MAX_OUTPUT_TOKENS = 2_048;
export const TAKES_MAX_OUTPUT_TOKENS = 1_536;
export const REPLIES_MAX_OUTPUT_TOKENS = 1_536;

export const CLUSTER_PROMPT_MAX_BYTES = 60_000;
export const ARC_PROMPT_MAX_BYTES = 16_000;
export const TAKES_PROMPT_MAX_BYTES = 16_000;
export const REPLIES_PROMPT_MAX_BYTES = 10_000;

export const REPLY_BATCH_SIZE = 5;
export const MIN_BEATS = 4;
export const MAX_BEATS = 10;
export const CALLS_PER_ALARM = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return decoder.decode(bytes.slice(0, end));
}

export function neuronsForPrompts(systemPrompt: string, userPrompt: string, maxOutputTokens: number): number {
  const inputUpper = utf8ByteLength(systemPrompt) + utf8ByteLength(userPrompt) + CHAT_TEMPLATE_OVERHEAD_TOKENS;
  return (inputUpper / 1_000_000) * NEURONS_PER_M_INPUT + (maxOutputTokens / 1_000_000) * NEURONS_PER_M_OUTPUT;
}

/** 每則都保留 id；文字平均分配位元組後截斷。 */
export function packItemsUtf8(items: { id: string; text: string }[], maxBytes: number): string {
  if (items.length === 0) return "";
  const headers = items.map((item) => `[${item.id}] `);
  const newlineBytes = items.length > 1 ? items.length - 1 : 0;
  const headerBytes = headers.reduce((total, header) => total + utf8ByteLength(header), 0) + newlineBytes;
  if (headerBytes > maxBytes) throw new Error(`packItemsUtf8: ${items.length} ids need ${headerBytes} bytes, cap is ${maxBytes}`);
  const per = Math.floor((maxBytes - headerBytes) / items.length);
  return items.map((item, index) => `${headers[index]}${per > 0 ? truncateUtf8(item.text, per) : ""}`).join("\n");
}

export class NeuronLedger {
  readonly ceiling: number;
  reserved: number;

  constructor(ceiling = LOOP_NEURON_CEILING, reserved = 0) {
    this.ceiling = ceiling;
    this.reserved = reserved;
  }

  remaining(): number {
    return this.ceiling - this.reserved;
  }

  tryReserve(neurons: number): boolean {
    if (!Number.isFinite(neurons) || neurons < 0) return false;
    if (this.reserved + neurons > this.ceiling) return false;
    this.reserved += neurons;
    return true;
  }
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcDayStart(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 5, 0, 0);
  return next.getTime();
}
