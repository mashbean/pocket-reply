// 唯讀煙霧測試：不建立問題池、不呼叫模型。用法：node scripts/smoke.mjs https://your-worker.example [--expect-sha abc1234]
const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const expectSha = process.argv.includes("--expect-sha") ? process.argv[process.argv.indexOf("--expect-sha") + 1] : "";
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

const health = await fetch(`${base}/api/health`);
const healthBody = await health.json().catch(() => null);
check("GET /api/health", health.status === 200 && healthBody?.ok === true, `status ${health.status}`);
check("health reports the question cap and remaining neurons", Number.isFinite(healthBody?.maxQuestions) && Number.isFinite(healthBody?.dailyNeuronsRemaining));
if (expectSha) check("health reports the expected build", healthBody?.sha === expectSha, `sha ${healthBody?.sha} !== ${expectSha}`);
const home = await fetch(`${base}/`);
check("GET / serves the create page", home.status === 200 && (await home.text()).includes("口袋回覆"));
check("GET /api/loops/<unknown> is a JSON 404", (await fetch(`${base}/api/loops/zzzzzzzzzz`)).status === 404);
check("GET /r/<unknown> renders the receipt shell", (await fetch(`${base}/r/zzzzzzzzzz`)).status === 200);
const rejected = await fetch(`${base}/api/loops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", speaker: "y", csv: "id,comment\n1,hello\n" }) });
check("POST /api/loops without confirmation is rejected", rejected.status === 400);

for (const item of checks) console.log(`${item.ok ? "✓" : "✗"} ${item.name}${item.ok || !item.detail ? "" : ` — ${item.detail}`}`);
const failed = checks.filter((item) => !item.ok).length;
console.log(`\n${checks.length - failed} passed, ${failed} failed against ${base}`);
process.exit(failed > 0 ? 1 : 0);
