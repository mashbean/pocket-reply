// 純函式：問題池整理、提示詞、模型輸出正規化、角色判定、驗證。不碰儲存與網路。
import { MAX_BEATS, MIN_BEATS, packItemsUtf8, utf8ByteLength } from "./ai-budget";
import type { Beat, Bridge, Loopback, LoopLanguage, Question, Receipt, Role, Take, Verification } from "./types";

export const OTHER_BEAT_TITLE = "其他聲音";

const OUTPUT_LANGUAGE: Record<LoopLanguage, string> = {
  "zh-Hant": "Traditional Chinese as used in Taiwan (zh-Hant-TW)",
  en: "English",
};

export type Settings = { title: string; speaker: string; standfirst: string; positions: string; language: LoopLanguage };

// ---- ingest ----

/** 語言標記與近似重複偵測（只標記，不刪除）。 */
export function ingest(rows: { id: string; name: string; text: string; upvotes: number; lens: string }[]): Question[] {
  const seen = new Map<string, string>();
  return rows.map((row, index) => {
    const qid = `q${String(index + 1).padStart(3, "0")}`;
    const key = row.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const dup = key.length >= 12 ? (seen.get(key) ?? "") : "";
    if (!dup && key.length >= 12) seen.set(key, qid);
    return { qid, sourceId: row.id, name: row.name, text: row.text, lang: detectLanguage(row.text), upvotes: row.upvotes, lens: row.lens, dupGroup: dup };
  });
}

export function detectLanguage(text: string): "zh" | "en" | "other" {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (han > 0 && han >= latin / 4) return "zh";
  if (latin > 0) return "en";
  return "other";
}

// ---- prompts ----

export function systemPrompt(settings: Settings): string {
  return [
    "You help a speaker close the loop on an audience question pool: every questioner should be able to find themselves and the reply they earned.",
    `Speaker who will answer in their own name: ${settings.speaker}.`,
    "Honesty rules: never invent what a questioner asked; never invent positions the speaker has not stated in the material you are given; when a beat cannot be grounded, say so instead of fabricating.",
    `Write all output in ${OUTPUT_LANGUAGE[settings.language]}. Plain words, conviction, no em dashes. Reply with a single JSON object only: no prose, no markdown fences.`,
  ].join("\n");
}

export function clusterPrompt(settings: Settings, questions: Question[], maxBytes: number): string {
  const head =
    `Event: ${settings.title}\n${settings.standfirst ? `Context: ${settings.standfirst}\n` : ""}` +
    `Group ALL the questions below into ${MIN_BEATS}-${Math.min(MAX_BEATS, Math.max(MIN_BEATS, Math.ceil(questions.length / 6)))} beats for one coherent talk. Every question id must appear in exactly one beat. For each beat give an evocative title (2-8 words), the "ache" (the human need behind these questions, one sentence), the member ids, and the id of the question the beat should be built on. ` +
    'Also list 1-4 "bridges": tensions between two groups of questioners that a good talk must reconcile, with the ids on each side and a one-sentence resolution (uncommon ground, not lowest common denominator).\n' +
    'Return {"beats":[{"title":string,"ache":string,"memberQids":[string],"representativeQid":string}],"bridges":[{"tension":string,"qids":[string],"resolution":string}]}\n\nQuestions (id, then upvotes and the text):\n';
  const budget = Math.max(2_000, maxBytes - utf8ByteLength(head));
  return head + packItemsUtf8(questions.map((question) => ({ id: question.qid, text: `(${question.upvotes}) ${question.text}` })), budget);
}

export function arcPrompt(settings: Settings, beats: Beat[], bridges: Bridge[], maxBytes: number): string {
  const head =
    `Event: ${settings.title}\nSpeaker: ${settings.speaker}\n` +
    "Order the beats below into one satisfying arc: open on the shared ache almost everyone stands on, put the sharpest tension in the middle resolved by a bridge, place the most human beat near the close, close warm with agency. For each beat give \"theTurn\" (the reframe or bridge this beat performs, one sentence) and \"bridgeToNext\" (one line handing off to the next beat; empty for the last). Also give a one-sentence throughline, an opening note and a closing note.\n" +
    'Return {"throughline":string,"opening":string,"closing":string,"order":[{"beatId":string,"theTurn":string,"bridgeToNext":string}]}\n\nBeats:\n' +
    beats.map((beat) => `beatId=${beat.beatId} title=${beat.title} ache=${beat.ache} members=${beat.memberQids.length}`).join("\n") +
    (bridges.length > 0 ? `\n\nBridges to resolve:\n${bridges.map((bridge) => `- ${bridge.tension}: ${bridge.resolution}`).join("\n")}` : "");
  return truncateBytes(head, maxBytes);
}

export function takesPrompt(settings: Settings, beats: Beat[], questions: Question[], maxBytes: number): string {
  const byQid = new Map(questions.map((question) => [question.qid, question]));
  const grounded = settings.positions.trim().length > 0;
  const head =
    `Speaker: ${settings.speaker}\n` +
    (grounded
      ? `The speaker's real public positions (the ONLY source you may ground a take in; cite the URLs that appear here when relevant):\n${settings.positions}\n\n`
      : "No public positions were supplied. Every take must then be phrased as an honest commitment to look into the question, and marked ungrounded.\n\n") +
    "For each beat write one quotable line (under 40 words) in the speaker's own voice that answers the beat's ache. " +
    'Return {"takes":[{"beatId":string,"take":string,"citations":[string]}]} where citations are URLs copied from the positions above, or an empty list.\n\nBeats:\n';
  const body = beats
    .map((beat) => {
      const representative = byQid.get(beat.representativeQid);
      return `beatId=${beat.beatId} title=${beat.title} ache=${beat.ache}${representative ? ` representative question: ${representative.text}` : ""}`;
    })
    .join("\n");
  return truncateBytes(head + body, maxBytes);
}

export function repliesPrompt(settings: Settings, batch: { question: Question; beat: Beat; take: Take; role: Role; chorusSize: number }[], maxBytes: number): string {
  const head =
    `Speaker replying in their own name: ${settings.speaker}\n` +
    "Write a personal reply (50-110 words) to each questioner below. Each reply must: open by quoting or faithfully paraphrasing their actual words; say concretely how their question moved the talk, honest to the stated role (crystalliser: the beat was built on it; chorus: one of N who asked this, and that weight made it a beat; bridge: connected two concerns the arc had to reconcile; keeper: a lone voice that kept the arc honest); carry the beat's take so they leave with the answer; close warm and specific. No two replies may share sentences. Use warm second person.\n" +
    'Return {"replies":[{"qid":string,"reply":string}]}\n\nQuestioners:\n';
  const budget = Math.max(1_500, maxBytes - utf8ByteLength(head));
  return head + packItemsUtf8(
    batch.map((item) => ({
      id: item.question.qid,
      text: `name=${item.question.name || "(anonymous)"} role=${item.role}${item.role === "chorus" ? ` (one of ${item.chorusSize})` : ""} beat="${item.beat.title}" take="${item.take.take}"${item.take.grounded ? "" : " (ungrounded: phrase as a commitment to find out)"} question="${item.question.text}"`,
    })),
    budget,
  );
}

function truncateBytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const bytes = new TextEncoder().encode(text).slice(0, maxBytes);
  return new TextDecoder().decode(bytes);
}

// ---- normalizers ----

export function normalizeCluster(raw: unknown, questions: Question[]): { beats: Beat[]; bridges: Bridge[] } | null {
  const record = raw as { beats?: unknown; bridges?: unknown } | null;
  const list = Array.isArray(record?.beats) ? record.beats : null;
  if (!list) return null;
  const valid = new Set(questions.map((question) => question.qid));
  const placed = new Set<string>();
  const beats: Beat[] = [];
  for (const item of list.slice(0, MAX_BEATS)) {
    if (typeof item !== "object" || item === null) continue;
    const beat = item as Record<string, unknown>;
    const title = sanitize(beat.title, 80);
    if (!title) continue;
    const members: string[] = [];
    for (const raw of Array.isArray(beat.memberQids) ? beat.memberQids : []) {
      const qid = sanitize(raw, 20);
      if (valid.has(qid) && !placed.has(qid) && !members.includes(qid)) members.push(qid);
    }
    if (members.length === 0) continue;
    for (const qid of members) placed.add(qid);
    const representative = sanitize(beat.representativeQid, 20);
    beats.push({
      beatId: `b${beats.length + 1}`,
      order: beats.length + 1,
      title,
      ache: sanitize(beat.ache, 300),
      theTurn: "",
      memberQids: members,
      representativeQid: members.includes(representative) ? representative : (members[0] as string),
      bridgeToNext: "",
    });
  }
  if (beats.length === 0) return null;
  const leftovers = questions.map((question) => question.qid).filter((qid) => !placed.has(qid));
  if (leftovers.length > 0) {
    beats.push({ beatId: `b${beats.length + 1}`, order: beats.length + 1, title: OTHER_BEAT_TITLE, ache: "沒有被歸進主要段落，但同樣值得回覆的提問。", theTurn: "", memberQids: leftovers, representativeQid: leftovers[0] as string, bridgeToNext: "" });
  }
  const beatOf = new Map<string, string>();
  for (const beat of beats) for (const qid of beat.memberQids) beatOf.set(qid, beat.beatId);
  const bridges: Bridge[] = [];
  for (const item of Array.isArray(record?.bridges) ? record.bridges.slice(0, 4) : []) {
    if (typeof item !== "object" || item === null) continue;
    const bridge = item as Record<string, unknown>;
    const tension = sanitize(bridge.tension, 200);
    const qids = (Array.isArray(bridge.qids) ? bridge.qids : []).map((qid) => sanitize(qid, 20)).filter((qid) => valid.has(qid));
    if (!tension || qids.length === 0) continue;
    bridges.push({ tension, qids: [...new Set(qids)], beatIds: [...new Set(qids.map((qid) => beatOf.get(qid) as string))], resolution: sanitize(bridge.resolution, 300) });
  }
  return { beats, bridges };
}

export function normalizeArc(raw: unknown, beats: Beat[]): { throughline: string; opening: string; closing: string; beats: Beat[] } {
  const record = (raw ?? {}) as Record<string, unknown>;
  const byId = new Map(beats.map((beat) => [beat.beatId, beat]));
  const ordered: Beat[] = [];
  for (const item of Array.isArray(record.order) ? record.order : []) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const beat = byId.get(sanitize(entry.beatId, 20));
    if (!beat || ordered.includes(beat)) continue;
    ordered.push({ ...beat, theTurn: sanitize(entry.theTurn, 300), bridgeToNext: sanitize(entry.bridgeToNext, 300) });
  }
  for (const beat of beats) if (!ordered.some((candidate) => candidate.beatId === beat.beatId)) ordered.push({ ...beat });
  // 「其他聲音」永遠放最後
  ordered.sort((left, right) => (left.title === OTHER_BEAT_TITLE ? 1 : right.title === OTHER_BEAT_TITLE ? -1 : 0));
  return {
    throughline: sanitize(record.throughline, 300),
    opening: sanitize(record.opening, 400),
    closing: sanitize(record.closing, 400),
    beats: ordered.map((beat, index) => ({ ...beat, order: index + 1 })),
  };
}

export function normalizeTakes(raw: unknown, beats: Beat[], positions: string): Take[] {
  const record = raw as { takes?: unknown } | null;
  const list = Array.isArray(record?.takes) ? record.takes : [];
  const urls = new Set((positions.match(/https?:\/\/[^\s)]+/g) ?? []).map((url) => url.replace(/[.,;:]+$/, "")));
  const byId = new Map<string, Take>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const beatId = sanitize(entry.beatId, 20);
    const take = sanitize(entry.take, 400).replace(/[—–]/g, ",");
    if (!beats.some((beat) => beat.beatId === beatId) || !take) continue;
    const citations = (Array.isArray(entry.citations) ? entry.citations : []).map((url) => sanitize(url, 500)).filter((url) => urls.has(url));
    byId.set(beatId, { beatId, take, grounded: citations.length > 0, citations });
  }
  return beats.map((beat) => byId.get(beat.beatId) ?? { beatId: beat.beatId, take: "這一段我還沒有可以引用的公開立場；我會把它列入追蹤，並在回覆裡說明。", grounded: false, citations: [] });
}

/** 角色由結構決定：代表提問＝Crystalliser；橋接對＝Bridge；段內 ≥3 人＝Chorus；否則 Keeper。 */
export function assignRoles(beats: Beat[], bridges: Bridge[]): Map<string, { beatId: string; role: Role; chorusSize: number }> {
  const bridged = new Set(bridges.flatMap((bridge) => bridge.qids));
  const out = new Map<string, { beatId: string; role: Role; chorusSize: number }>();
  for (const beat of beats) {
    for (const qid of beat.memberQids) {
      let role: Role;
      if (qid === beat.representativeQid && beat.title !== OTHER_BEAT_TITLE) role = "crystalliser";
      else if (bridged.has(qid)) role = "bridge";
      else if (beat.memberQids.length >= 3 && beat.title !== OTHER_BEAT_TITLE) role = "chorus";
      else role = "keeper";
      out.set(qid, { beatId: beat.beatId, role, chorusSize: beat.memberQids.length });
    }
  }
  return out;
}

export function normalizeReplies(raw: unknown, batch: { question: Question; beat: Beat; role: Role }[]): Loopback[] {
  const record = raw as { replies?: unknown } | null;
  const list = Array.isArray(record?.replies) ? record.replies : [];
  const byQid = new Map(batch.map((item) => [item.question.qid, item]));
  const out: Loopback[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const qid = sanitize(entry.qid, 20);
    const target = byQid.get(qid);
    const reply = sanitize(entry.reply, 1_200).replace(/[—–]/g, ",");
    if (!target || reply.length < 40 || out.some((existing) => existing.qid === qid)) continue;
    out.push({ qid, beatId: target.beat.beatId, role: target.role, reply });
  }
  return out;
}

// ---- verify（Uncommon Ground 的硬門檻，內建） ----

export function verify(questions: Question[], beats: Beat[], takes: Take[], loopbacks: Loopback[]): Verification {
  const pool = questions.length;
  const byQid = new Map(loopbacks.map((loopback) => [loopback.qid, loopback]));
  const empty = questions.filter((question) => (byQid.get(question.qid)?.reply ?? "").replace(/\s+/g, " ").trim().length < 40).map((question) => question.qid);
  const groups = new Map<string, number>();
  for (const loopback of loopbacks) {
    const key = loopback.reply.replace(/\s+/g, " ").trim().slice(0, 120);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const cloneGroups = [...groups.values()].filter((count) => count > 1).length;
  const placed = new Set(beats.flatMap((beat) => beat.memberQids));
  return {
    pool,
    replies: loopbacks.length,
    coverage: pool > 0 && empty.length === 0 && loopbacks.length >= pool,
    empty,
    cloneGroups,
    ungroundedTakes: takes.filter((take) => !take.grounded).length,
    beatsCoverAllQids: questions.every((question) => placed.has(question.qid)),
  };
}

export function buildReceipt(input: { throughline: string; opening: string; closing: string; beats: Beat[]; bridges: Bridge[]; takes: Take[]; loopbacks: Loopback[]; questions: Question[]; generatedAt: number }): Receipt {
  return { ...input, verification: verify(input.questions, input.beats, input.takes, input.loopbacks) };
}

export function sanitize(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
