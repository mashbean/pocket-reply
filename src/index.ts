import { COORDINATOR_INSTANCE, Coordinator } from "./coordinator";
import { CsvError, MAX_CSV_BYTES, csvTable, parseQuestionsCsv } from "./csv";
import { LoopRoom } from "./loop-room";
import type { LoopLanguage } from "./types";

export { Coordinator, LoopRoom };

const ADMIN_TOKEN = /^[0-9a-f]{32}$/;
const MAX_BODY_BYTES = MAX_CSV_BYTES + 32 * 1024;
const DEFAULT_MAX_QUESTIONS = 400;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return health(request, env);
      if (url.pathname === "/api/loops" && request.method === "POST") return createLoop(request, env, url);
      const match = url.pathname.match(/^\/api\/loops\/([a-z0-9]{10})(?:\/(receipt\.json|replies\.csv|retry))?$/);
      if (match) return loopApi(request, env, match[1] as string, match[2]);
      if (url.pathname.startsWith("/api/")) return jsonError("not found", 404);
      if (/^\/r\/[a-z0-9]{10}\/?$/.test(url.pathname)) return servePage(env, url, "/receipt", request);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("unhandled", error instanceof Error ? error.message : error);
      return jsonError("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function servePage(env: Env, url: URL, path: string, request: Request): Promise<Response> {
  let page = await env.ASSETS.fetch(new Request(new URL(path, url.origin), { method: "GET", headers: request.headers }));
  for (let hop = 0; hop < 2 && page.status >= 300 && page.status < 400 && page.headers.get("location"); hop += 1) {
    page = await env.ASSETS.fetch(new Request(new URL(page.headers.get("location") as string, url.origin), { method: "GET", headers: request.headers }));
  }
  return new Response(page.body, { status: page.status, headers: withSecurity(new Headers(page.headers)) });
}

async function health(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return jsonError("method not allowed", 405);
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_INSTANCE));
  return json({ ok: true, aiMode: String(env.AI_MODE) === "fake" ? "fake" : "live", maxQuestions: maxQuestions(env), dailyNeuronsRemaining: Math.floor(await coordinator.dailyRemaining()), sha: typeof env.BUILD_SHA === "string" ? env.BUILD_SHA : "" }, 200);
}

async function createLoop(request: Request, env: Env, url: URL): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return jsonError("request too large", 413);
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (body.confirmed !== true) return jsonError("confirmed must be true: the host has the right to reply publicly in the speaker's name and the pool contains no direct identifiers beyond chosen names", 400);
  const title = cleanLine(body.title, 120);
  const speaker = cleanLine(body.speaker, 80);
  if (!title) return jsonError("title is required", 400);
  if (!speaker) return jsonError("speaker is required: who replies in their own name", 400);
  const standfirst = cleanText(body.standfirst, 1_000);
  const positions = cleanText(body.positions, 6_000);
  const language: LoopLanguage = body.language === "en" ? "en" : "zh-Hant";
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (csv.length > MAX_CSV_BYTES) return jsonError("csv too large", 413);
  let rows;
  try {
    rows = parseQuestionsCsv(csv, maxQuestions(env));
  } catch (error) {
    if (error instanceof CsvError) return jsonError(error.message, 400);
    throw error;
  }
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_INSTANCE));
  if (!(await coordinator.reserveCreation())) return jsonError("creation rate limit reached, try again later", 429);
  const loopId = randomId(10);
  const adminToken = randomHex(16);
  const stub = env.LOOP.get(env.LOOP.idFromName(loopId));
  const created = await stub.create({ loopId, adminHash: await sha256Hex(adminToken), settings: { title, speaker, standfirst, positions, language }, rows });
  if (!created.ok) return jsonError(created.error, 500);
  return json(
    {
      loopId,
      title,
      speaker,
      questions: rows.length,
      status: "queued",
      adminToken,
      urls: { receipt: `${url.origin}/r/${loopId}`, api: `${url.origin}/api/loops/${loopId}`, manage: `${url.origin}/r/${loopId}#admin=${adminToken}` },
      privacy: { storedByService: true, storedFields: ["title", "speaker", "positions", "questions", "beats", "takes", "replies"], adminTokenStored: "sha-256 hash only" },
    },
    201,
  );
}

async function loopApi(request: Request, env: Env, loopId: string, sub: string | undefined): Promise<Response> {
  const stub = env.LOOP.get(env.LOOP.idFromName(loopId));
  if (sub === "retry") {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    const auth = await requireAdmin(request, stub);
    if (auth) return auth;
    return json({ ok: await stub.retry() }, 200);
  }
  if (request.method === "DELETE" && !sub) {
    const auth = await requireAdmin(request, stub);
    if (auth) return auth;
    return json({ ok: await stub.deleteLoop() }, 200);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return jsonError("method not allowed", 405);
  const loop = await stub.publicLoop();
  if (!loop) return jsonError("not found", 404);
  if (loop.progress.status === "deleted") return jsonError("deleted", 410);
  if (sub === "replies.csv") {
    if (!loop.receipt) return jsonError("receipt not ready", 409);
    const rows = await stub.repliesRows();
    const csv = csvTable(["qid", "source_id", "name", "question", "beat", "role", "reply"], rows.map((row) => [row.qid, row.sourceId, row.name, row.question, row.beat, row.role, row.reply]));
    return new Response(csv, { headers: withSecurity(new Headers({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="pocket-reply-${loopId}-replies.csv"` })) });
  }
  if (sub === "receipt.json") {
    if (!loop.receipt) return jsonError("receipt not ready", 409);
    return json({ loopId, title: loop.title, speaker: loop.speaker, standfirst: loop.standfirst, language: loop.language, model: loop.model, ...loop.receipt }, 200);
  }
  return json(loop, 200);
}

async function requireAdmin(request: Request, stub: DurableObjectStub<LoopRoom>): Promise<Response | null> {
  const token = request.headers.get("X-Loop-Admin") ?? "";
  if (!ADMIN_TOKEN.test(token)) return jsonError("missing admin token", 401);
  if (!(await stub.verifyAdmin(await sha256Hex(token)))) return jsonError("admin token does not match", 403);
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return jsonError("send application/json", 400);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return jsonError("request too large", 413);
  try {
    const body = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : jsonError("invalid body", 400);
  } catch {
    return jsonError("invalid JSON", 400);
  }
}

function maxQuestions(env: Env): number {
  const raw = Number(env.MAX_QUESTIONS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_QUESTIONS;
}

function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function randomId(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join("");
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withSecurity(headers: Headers): Headers {
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: withSecurity(new Headers({ "Content-Type": "application/json; charset=utf-8" })) });
}

function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}
