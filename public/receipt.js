const loopId = (location.pathname.match(/^\/r\/([a-z0-9]{10})/) || [])[1];
const adminToken = (location.hash.match(/admin=([0-9a-f]{32})/) || [])[1] || "";
const el = (id) => document.getElementById(id);
const STATUS_TEXT = { queued: "排隊中", clustering: "第一步：把提問歸成段落", arcing: "第二步：排成一條弧線", forging: "第三步：為每段鍛一句立場", replying: "第四步：逐一回覆每位提問者", "waiting-budget": "今日模型額度用完，等待隔天（UTC）續跑", failed: "處理失敗", deleted: "已刪除", ready: "完成" };
const ROLE_TEXT = { crystalliser: "Crystalliser · 這一段由你的問題建成", chorus: "Chorus · 你和許多人一起讓它成為一段", bridge: "Bridge · 你連起了兩種關切", keeper: "Keeper · 你讓弧線保持誠實" };
let receipt = null;
let timer = null;

if (!loopId) showError("網址不完整。");
else load();

async function load() {
  const response = await fetch(`/api/loops/${loopId}`, { cache: "no-store" });
  if (response.status === 404) return showError("找不到這份收據。");
  if (response.status === 410) return showError("這份收據已被刪除。");
  render(await response.json());
}

function render(loop) {
  document.title = `${loop.title} · Pocket Reply`;
  el("title").textContent = loop.title;
  el("standfirst").textContent = loop.standfirst;
  el("model").textContent = loop.model === "fake" ? "測試模型" : loop.model;
  el("kicker").textContent = `收據 · ${loop.speaker} 回覆 · ${loop.questions} 則提問`;
  el("admin").classList.toggle("hidden", !adminToken);
  const progress = loop.progress;
  if (progress.status === "ready" && loop.receipt) {
    clearInterval(timer);
    el("pending").classList.add("hidden");
    el("ready").classList.remove("hidden");
    receipt = loop.receipt;
    renderReceipt(receipt, loop);
    el("dl-json").href = `/api/loops/${loopId}/receipt.json`;
    el("dl-csv").href = `/api/loops/${loopId}/replies.csv`;
    return;
  }
  el("pending").classList.remove("hidden");
  el("pending-title").textContent = STATUS_TEXT[progress.status] || progress.status;
  const ratio = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  el("progress-bar").style.width = `${Math.round(ratio * 100)}%`;
  el("pending-text").textContent = `${progress.total ? `${progress.done} / ${progress.total} · ` : ""}已預留 ${Math.round(progress.neuronsReserved)} 神經元${progress.nextAttemptAt ? ` · 下次嘗試 ${new Date(progress.nextAttemptAt).toLocaleString("zh-TW")}` : ""}`;
  el("pending-error").classList.toggle("hidden", !progress.lastError);
  el("pending-error").textContent = progress.lastError;
  el("admin-actions").classList.toggle("hidden", !(adminToken && (progress.status === "failed" || progress.status === "waiting-budget")));
  if (!timer && !["failed", "deleted"].includes(progress.status)) timer = setInterval(load, 4000);
}

function renderReceipt(data, loop, filter = "") {
  const query = filter.trim().toLowerCase();
  const byQid = new Map(data.questions.map((question) => [question.qid, question]));
  const loopbackByQid = new Map(data.loopbacks.map((item) => [item.qid, item]));
  const takeByBeat = new Map(data.takes.map((take) => [take.beatId, take]));
  el("stats").replaceChildren(...[[data.questions.length, "位提問者"], [data.beats.length, "段"], [data.questions.length - data.loopbacks.filter((item) => byQid.has(item.qid)).length, "位被落下"], [data.bridges.length, "座橋"]].map(([value, label]) => {
    const node = document.createElement("div");
    node.className = "stat";
    const b = document.createElement("b");
    b.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    node.append(b, span);
    return node;
  }));
  el("throughline").textContent = data.throughline;
  el("opening").textContent = data.opening;
  el("closing").textContent = data.closing;
  el("arc").replaceChildren(...data.beats.map((beat) => {
    const section = document.createElement("section");
    section.className = "beat";
    section.id = beat.beatId;
    const order = document.createElement("div");
    order.className = "order";
    order.textContent = `第 ${beat.order} 段 · ${beat.memberQids.length} 位`;
    const h3 = document.createElement("h3");
    h3.textContent = beat.title;
    const ache = document.createElement("p");
    ache.className = "ache";
    ache.textContent = beat.ache;
    section.append(order, h3, ache);
    if (beat.theTurn) {
      const turn = document.createElement("p");
      turn.textContent = beat.theTurn;
      section.append(turn);
    }
    const take = takeByBeat.get(beat.beatId);
    if (take) {
      const box = document.createElement("div");
      box.className = `take${take.grounded ? "" : " ungrounded"}`;
      box.textContent = `「${take.take}」`;
      const small = document.createElement("small");
      if (take.grounded) {
        small.append("引用：");
        take.citations.forEach((url, index) => {
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = url;
          small.append(index ? "、" : "", a);
        });
      } else small.textContent = "未落地：沒有可引用的公開立場，回覆會如實說明。";
      box.append(small);
      section.append(box);
    }
    const voices = document.createElement("p");
    voices.className = "voices";
    voices.textContent = `聲音：${beat.memberQids.map((qid) => byQid.get(qid)?.name || qid).join("、")}`;
    section.append(voices);
    if (beat.bridgeToNext) {
      const bridge = document.createElement("p");
      bridge.className = "bridge";
      bridge.textContent = beat.bridgeToNext;
      section.append(bridge);
    }
    return section;
  }));
  el("bridges-title").classList.toggle("hidden", data.bridges.length === 0);
  el("bridges").replaceChildren(...data.bridges.map((bridge) => {
    const node = document.createElement("div");
    node.className = "tension";
    const strong = document.createElement("strong");
    strong.textContent = bridge.tension;
    const p = document.createElement("p");
    p.textContent = bridge.resolution;
    const who = document.createElement("p");
    who.className = "voices";
    who.textContent = `兩邊：${bridge.qids.map((qid) => byQid.get(qid)?.name || qid).join("、")}`;
    node.append(strong, p, who);
    return node;
  }));
  const beatTitle = new Map(data.beats.map((beat) => [beat.beatId, beat.title]));
  const matches = (question, loopback) => !query || question.text.toLowerCase().includes(query) || question.name.toLowerCase().includes(query) || (loopback?.reply ?? "").toLowerCase().includes(query);
  const voices = data.questions.filter((question) => matches(question, loopbackByQid.get(question.qid)));
  el("voices-title").textContent = `每一個聲音（${voices.length}${query ? ` / ${data.questions.length}` : ""}）`;
  el("voices").replaceChildren(...voices.map((question) => {
    const loopback = loopbackByQid.get(question.qid);
    const node = document.createElement("article");
    node.className = "voice";
    node.id = question.qid;
    const q = document.createElement("p");
    q.className = "q";
    q.textContent = question.text;
    const who = document.createElement("p");
    who.className = "who";
    who.textContent = `${question.name || question.qid}${question.upvotes ? ` · ${question.upvotes} 人也想問` : ""}${loopback ? ` · ${beatTitle.get(loopback.beatId) ?? ""}` : ""}`;
    if (loopback) {
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = ROLE_TEXT[loopback.role] || loopback.role;
      who.append(role);
    }
    const reply = document.createElement("p");
    reply.className = "reply";
    reply.textContent = loopback ? loopback.reply : "（尚無回覆）";
    node.append(q, who, reply);
    return node;
  }));
  const v = data.verification;
  el("verify").replaceChildren(...[
    [`覆蓋 ${v.replies}/${v.pool}`, v.coverage],
    [`空白回覆 ${v.empty.length}`, v.empty.length === 0],
    [`複製貼上群 ${v.cloneGroups}`, v.cloneGroups === 0],
    [`未落地立場 ${v.ungroundedTakes}/${data.takes.length}`, v.ungroundedTakes === 0],
    [`每則提問都在某一段`, v.beatsCoverAllQids],
  ].map(([label, ok]) => {
    const span = document.createElement("span");
    span.className = ok ? "ok" : "bad";
    span.textContent = `${ok ? "✓" : "✗"} ${label}　`;
    return span;
  }));
}

el("filter").addEventListener("input", (event) => {
  if (receipt) renderReceipt(receipt, null, event.target.value);
});
el("retry").addEventListener("click", async () => {
  const response = await fetch(`/api/loops/${loopId}/retry`, { method: "POST", headers: { "X-Loop-Admin": adminToken } });
  el("pending-text").textContent = response.ok ? "已重新排程。" : `無法重新排程（${response.status}）`;
  setTimeout(load, 1500);
});
el("delete").addEventListener("click", async () => {
  if (!confirm("確定刪除整份收據與所有回覆？無法復原。")) return;
  const response = await fetch(`/api/loops/${loopId}`, { method: "DELETE", headers: { "X-Loop-Admin": adminToken } });
  el("admin-status").textContent = response.ok ? "已刪除。" : `刪除失敗（${response.status}）`;
  if (response.ok) setTimeout(load, 800);
});

function showError(message) {
  clearInterval(timer);
  el("error").textContent = message;
  el("error").classList.remove("hidden");
  el("title").textContent = "無法顯示收據";
}
