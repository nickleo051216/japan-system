# japan-system（HEEEHABABY 代購後端）

## 前後端交接
前端與後端由不同的 Claude 對話開發，兩邊互相傳不到訊息，唯一的溝通管道是根目錄的 `.claude_handover.md`。

- **後端對話**：只要新增或修改 API 路由、改動 JSON 回傳形狀、改資料庫 schema（新增 migration）、或改 `n8n/` 流程的節點，都要在同一個 PR 裡更新 `.claude_handover.md` 的「⚙️ 後端最新異動」區塊。原本的內容移到「⚙️ 後端歷史」。merge 之後回報：「後端已更新 API 規範與進度，請提醒前端 Session 讀取。」
- **前端對話**：開工前先讀 `origin/main` 的 `.claude_handover.md`，只改「🖥️ 前端」區塊。
- 欄位的權威定義是 `BUYER_API_CONTRACT.md`。交接檔只寫差異和待辦，不要整份抄一遍。

## 不能碰的
- repo 是公開的：不要 commit 金鑰、連線字串或 token。交接檔裡只寫變數名稱。
- `supabase/migrations/001`～`006` 已經在正式庫執行過，不要修改。要改 schema 就新增 `007_…`。
- 程式碼裡不要建表或改表。

## 驗收
`npm run smoke`（後端 257 項）、`npm run test:contract`（前端 47 項，對真後端）、`npm run test:n8n`（n8n 流程逐節點跑）。三個都只對本機的 PGlite harness 執行，不會碰正式資料庫。
