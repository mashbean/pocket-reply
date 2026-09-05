# Pocket Reply · 口袋回覆

正式站：https://reply.mashbean.net

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/pocket-reply)

**Broad listening with a receipt.** 把一池觀眾提問（Call-in、Pocket Polis、Pocket Form 或任何 `id,interview,comment` CSV）變成：一條有開場與收尾的演講弧線、每一段一句落地的立場、**每位提問者一則親筆回覆**、一張公開的收據。方法來自 [Uncommon Ground](https://github.com/audreyt/uncommon-ground)（唐鳳與協作者，CC0）；這裡把八段流程做成**一個 Cloudflare Worker**：一個問題池一個 SQLite Durable Object，alarm 驅動四類 Workers AI 呼叫，不用跑腳本、不用帳號、不用金鑰。

## 流程與誠實規則

| 段 | 做什麼 | 誰做 |
|---|---|---|
| Ingest | 語言標記、近似重複標記（只標不刪）、每則一個 qid | 純函式 |
| Cluster | 4–10 段：標題、ache、成員、代表提問、橋接張力 | 模型 1 次；未被歸段的提問進「其他聲音」，沒有人被丟掉 |
| Arc | 排序、每段的轉折與過橋句、一句 throughline、開場與收尾 | 模型 1 次 |
| Takes | 每段一句可引用的立場 | 模型 1 次；**只能引用你提供的公開立場**（網址要在你貼的文字裡），否則標「未落地」 |
| Roles | Crystalliser／Chorus／Bridge／Keeper | **結構決定**：段落代表提問＝Crystalliser、橋接對＝Bridge、同段 ≥3 人＝Chorus、其餘＝Keeper |
| Loopback | 每位提問者 50–110 字：引用原話、說明角色、帶著那段的立場、具體的收尾 | 模型，每批 5 則；連續失敗給誠實的保底回覆（承認還沒準備好），不假裝 |
| Verify | N/N 覆蓋、無空白、無複製貼上、每段有立場、每則提問都在某一段 | 內建，結果印在收據上 |

沒有做的：reception-test（模擬提問者施壓）、雙語翻譯、askit-hono 自動 grounding。這些在 Uncommon Ground 的腳本裡有，這裡以「回覆者自己貼公開立場」取代 grounding，其餘留待下一版。

## 額度

50 則提問 ≈ 1,100 神經元、266 則 ≈ 4,500；每池上限 9,000、全部署每日 9,000（`DAILY_NEURON_CEILING`），額度用完自動隔日續跑、已完成的步驟不重做。預設每池最多 400 則（`MAX_QUESTIONS`）。

## API

```
POST   /api/loops                      {title, speaker, standfirst?, positions?, language?, csv, confirmed:true}
                                       → 201 {loopId, adminToken, urls:{receipt, api, manage}}
GET    /api/loops/:id                  進度與（完成後的）收據
GET    /api/loops/:id/receipt.json     完整收據（questions/beats/bridges/takes/loopbacks/verification）
GET    /api/loops/:id/replies.csv      qid,source_id,name,question,beat,role,reply
POST   /api/loops/:id/retry            X-Loop-Admin
DELETE /api/loops/:id                  X-Loop-Admin
GET    /api/health
```

`receipt.json` 的形狀對應 Uncommon Ground 的 questions／arc／takes／loopbacks／meta，可以再交給它的 `assemble.py` 做雙語 HTML。

## 部署與開發

```bash
npm install
npm test            # vitest（AI_MODE=fake，讀 wrangler.test.jsonc）
npm run check
npm run deploy               # workers.dev
npm run deploy:production    # 自訂網域放在 env.production.routes；Worker 名稱不可改
```

CI（`.github/workflows/deploy.yml`）需要 repository secrets `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`。MIT 授權；方法致謝 Uncommon Ground（CC0）。回覆以回覆者名義發出，公開前請逐則檢查。
