import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseQuestionsCsv } from "../src/csv";
import { assignRoles, detectLanguage, ingest, normalizeCluster, normalizeReplies, normalizeTakes, verify } from "../src/pipeline";

const csv = [
  "id,interview,comment,upvotes,lens",
  "a1,阿德 · keeper,我家離核二廠不到五公里，演習從來沒真的演過怎麼撤。,16,keeper",
  "a2,Vivian · chorus,去年廠區兩次跳電，基載電力不能只靠天然氣船準時到港。,3,chorus",
  "a3,,魚塭被光電板圍住之後，我們沒有比較乾淨，只有比較窮。,5,",
  "a4,小魚,核廢料到現在連中期貯存場都選不出來。,9,keeper",
  "a5,老陳,工業電價三年漲了快五成。,2,clarify",
  "a6,Ing-ying,1982 年他們跟我們的長輩說那是罐頭工廠。四十年了，核廢料還在島上。,11,keeper",
  "a7,秀珍,我沒有立場，我只是不相信任何一邊的數字。給我一個獨立的第三方，我就相信。,16,bridge",
  "",
].join("\n");

async function create(body: Record<string, unknown>) {
  const response = await SELF.fetch("https://example.com/api/loops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function runUntilReady(loopId: string) {
  const stub = env.LOOP.get(env.LOOP.idFromName(loopId));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ran = await runDurableObjectAlarm(stub);
    const loop = (await (await SELF.fetch(`https://example.com/api/loops/${loopId}`)).json()) as Record<string, any>;
    if (loop.progress.status === "ready") return loop;
    if (!ran) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error("loop did not become ready");
}

describe("pipeline", () => {
  it("ingests tttc.csv-shaped pools with language tags and duplicate flags", () => {
    const rows = parseQuestionsCsv(`${csv}a8,someone,Should Taiwan restart nuclear power?,1,\na9,dup,我家離核二廠不到五公里，演習從來沒真的演過怎麼撤。,0,\n`, 100);
    const questions = ingest(rows);
    expect(questions).toHaveLength(9);
    expect(questions[0]).toMatchObject({ qid: "q001", sourceId: "a1", name: "阿德 · keeper", lang: "zh", upvotes: 16, lens: "keeper", dupGroup: "" });
    expect(questions[7]?.lang).toBe("en");
    expect(questions[8]?.dupGroup).toBe("q001");
    expect(detectLanguage("混合 mixed 文字")).toBe("zh");
    expect(() => parseQuestionsCsv("statement_id,text\n1,x\n", 10)).toThrow(/需要 id 與 comment/);
    expect(() => parseQuestionsCsv(csv, 3)).toThrow(/最多 3 則/);
  });

  it("normalizes beats so every qid is placed exactly once, with leftovers in an extra beat", () => {
    const questions = ingest(parseQuestionsCsv(csv, 100));
    const cluster = normalizeCluster({
      beats: [
        { title: "供電", ache: "燈會不會亮", memberQids: ["q001", "q002", "q005", "q002"], representativeQid: "q002" },
        { title: "核廢", ache: "廢料去哪", memberQids: ["q004", "q006", "zzz"], representativeQid: "nope" },
      ],
      bridges: [{ tension: "供電與核廢", qids: ["q001", "q006"], resolution: "先講條件" }],
    }, questions);
    expect(cluster?.beats.map((beat) => beat.memberQids)).toEqual([["q001", "q002", "q005"], ["q004", "q006"], ["q003", "q007"]]);
    expect(cluster?.beats[1]?.representativeQid).toBe("q004");
    expect(cluster?.beats[2]?.title).toBe("其他聲音");
    expect(cluster?.bridges[0]).toMatchObject({ beatIds: ["b1", "b2"], qids: ["q001", "q006"] });
    const roles = assignRoles(cluster!.beats, cluster!.bridges);
    expect(roles.get("q002")?.role).toBe("crystalliser");
    expect(roles.get("q001")?.role).toBe("bridge");
    expect(roles.get("q005")?.role).toBe("chorus");
    expect(roles.get("q004")?.role).toBe("crystalliser");
    expect(roles.get("q003")?.role).toBe("keeper");
  });

  it("marks takes ungrounded unless they cite a URL from the supplied positions, and gates replies", () => {
    const beats = [{ beatId: "b1", order: 1, title: "t", ache: "", theTurn: "", memberQids: ["q001"], representativeQid: "q001", bridgeToNext: "" }];
    const positions = "我主張先做國際同儕審查（https://example.org/statement-2026）。";
    const takes = normalizeTakes({ takes: [{ beatId: "b1", take: "先審查，再談延役 — 這是底線", citations: ["https://example.org/statement-2026", "https://fake.example/x"] }] }, beats, positions);
    expect(takes[0]).toMatchObject({ grounded: true, citations: ["https://example.org/statement-2026"] });
    expect(takes[0]?.take).not.toContain("—");
    expect(normalizeTakes({ takes: [] }, beats, "")[0]?.grounded).toBe(false);
    const questions = ingest(parseQuestionsCsv(csv, 100)).slice(0, 2);
    const batch = questions.map((question) => ({ question, beat: beats[0]!, role: "keeper" as const }));
    const replies = normalizeReplies({ replies: [{ qid: "q001", reply: "太短" }, { qid: "q002", reply: "你問了跳電與基載的事，這一段就是從供電穩定出發的；我們的立場是先講條件再談要不要。謝謝你把它問出來。" }] }, batch);
    expect(replies.map((reply) => reply.qid)).toEqual(["q002"]);
    const report = verify(questions, beats, takes, replies);
    expect(report).toMatchObject({ pool: 2, replies: 1, coverage: false, empty: ["q001"], ungroundedTakes: 0, beatsCoverAllQids: false });
  });
});

describe("Pocket Reply worker", () => {
  it("serves health and rejects bad input", async () => {
    const health = (await (await SELF.fetch("https://example.com/api/health")).json()) as Record<string, any>;
    expect(health).toMatchObject({ ok: true, aiMode: "fake", maxQuestions: 50 });
    expect((await create({ title: "x", speaker: "主持人", csv, confirmed: false })).status).toBe(400);
    expect((await create({ title: "x", speaker: "", csv, confirmed: true })).status).toBe(400);
    expect((await create({ title: "x", speaker: "主持人", csv: "nope", confirmed: true })).status).toBe(400);
    expect((await SELF.fetch("https://example.com/api/loops/zzzzzzzzzz")).status).toBe(404);
  });

  it("closes the loop: beats, arc, takes, one reply per questioner, receipt with verification", async () => {
    const created = await create({ title: "核電審議叩應", speaker: "主持人", standfirst: "第一輪叩應的閉環", positions: "主持人的立場：先做國際同儕審查與事實清單。https://delib.mashbean.net/r/9e51c5ab00deea31", csv, confirmed: true });
    expect(created.status).toBe(201);
    expect(created.body.questions).toBe(7);
    const loop = await runUntilReady(created.body.loopId);
    const receipt = loop.receipt;
    expect(receipt.beats.length).toBeGreaterThanOrEqual(2);
    expect(receipt.throughline).toContain("條件");
    expect(receipt.takes).toHaveLength(receipt.beats.length);
    expect(receipt.takes[0].grounded).toBe(true);
    expect(receipt.loopbacks).toHaveLength(7);
    expect(receipt.verification).toMatchObject({ pool: 7, replies: 7, coverage: true, beatsCoverAllQids: true, cloneGroups: 0 });
    expect(new Set(receipt.loopbacks.map((item: any) => item.role)).size).toBeGreaterThanOrEqual(2);
    expect(loop.progress.neuronsReserved).toBeGreaterThan(0);

    const json = (await (await SELF.fetch(`${created.body.urls.api}/receipt.json`)).json()) as Record<string, any>;
    expect(json.loopbacks).toHaveLength(7);
    const repliesCsv = (await (await SELF.fetch(`${created.body.urls.api}/replies.csv`)).text()).trimEnd().split("\n");
    expect(repliesCsv[0]).toBe("qid,source_id,name,question,beat,role,reply");
    expect(repliesCsv).toHaveLength(8);
    expect(repliesCsv[1]).toContain("q001,a1,阿德 · keeper,");
    const page = await SELF.fetch(created.body.urls.receipt, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pocket Reply");

    expect((await SELF.fetch(created.body.urls.api, { method: "DELETE" })).status).toBe(401);
    expect((await SELF.fetch(created.body.urls.api, { method: "DELETE", headers: { "X-Loop-Admin": created.body.adminToken } })).status).toBe(200);
    expect((await SELF.fetch(created.body.urls.api)).status).toBe(410);
  });
});
