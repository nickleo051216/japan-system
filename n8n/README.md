# n8n 流程

後端只做兩件事：**排隊**和**記帳**。真正對外（推 LINE、叫 AI 看照片）的是這裡的兩條 n8n 流程。
後端不握 LINE 和 AI 服務的金鑰，n8n 也不碰資料庫，兩邊只透過 `/api/v1/notify/*`、`/api/v1/ocr/*` 對話。

| 檔案 | 做什麼 | 多久跑一次 |
|---|---|---|
| `notify-collector.json` | 領出貨／對帳單通知 → LINE OA 推播 → 回報結果 | 每分鐘；後端出貨時也會打 Webhook 叫醒 |
| `ocr-worker.json` | 領待辨識的照片 → OpenRouter（`anthropic/claude-sonnet-5`）讀品名與含稅日幣價 → 回寫（售價由後端查表）。2026-11-19 起也替**照片許願**取名（只取品名，寫回許願） | 每分鐘，一次最多 5 張 |

兩條都用 `npm run test:n8n` 在本機逐節點跑過：真的後端＋真的資料庫，LINE 和 OpenRouter 用假的伺服器代替。

**2026-11-26 更新（還沒上線）**：`ocr-worker.json` 改 3 個節點，讓拍照辨識不會默默失敗：
- 「解析結果」：OpenRouter 失敗、拒絕、回的不是 JSON 時，也回寫 `{ failed: true, reason }`。後端會記下原因（後台首頁「AI 拍照辨識」燈號）並馬上放回佇列。
- 「組請求」：重試時換模型（第 3 次起輪流用「設定」的 `fallback_models`）；提示詞要求看不清楚也要給最可能的品名。
- 「設定」：多 `fallback_models`（逗號分隔）。

**順序**：後端要先 merge 上線，再更新線上流程。舊後端不認得 `failed`，會把失敗當成辨識結果。

**2026-11-25 更新（PR #47，還沒上線）**：`notify-collector.json` 的「組訊息」改成：後端有附 `payload.text` 就直接用（v1.7 起對帳單也由後端組好文案，連結帶 `?path=stmt`）。舊的對帳單通知沒有 `text`，才照原本的範本組。線上那條不更新也能正常發，因為對帳單會用 `liff_url`。要更新的話，跟拍照辨識一樣：先備份，再只換這一個節點，憑證沿用。

**2026-11-25 更新（PR #43，已在 11/25 用 n8n API 更新線上並啟用）**：`ocr-worker.json` 再改 3 個節點，讓它也會辨識**多張照片上架**的商品照。
- 「領取待辨識」多帶 `include_listings: true`。
- 「組請求」認得 `kind: listing`：讀品名和照片上的**台幣售價**（price_twd）。
- 「解析結果」回寫時帶 `listing_id`。

merge、017 跑完之後，要用 n8n API 把線上的「拍照辨識」更新成這一版（憑證沿用）。舊版流程沒帶 `include_listings`，所以在更新之前，上架照片會一直停在「正在辨識」。這段時間店主可以自己填品名和價錢刊登。

**2026-11-19 更新**：`ocr-worker.json` 改了 3 個節點（「領取待辨識」多帶 `include_wishes: true`、「組請求」「解析結果」認得許願）。線上的「拍照辨識」已在 11/19 用 n8n API 更新並啟用，憑證沿用原本的。

**⚠️ 2026-11-19 發現**：兩條流程從 9/23 之後其實都是**關著的**（n8n 2.x 顯示未發布），當天已重新啟用。通知收集器的 `liff_url` 也已填 `https://liff.line.me/2011699944-c5n725TF?path=stmt`。以後回報上線狀態，要直接查 n8n（`GET /api/v1/workflows/<id>` 看 `active`），不要只看這份文件。

**目前狀態（2026-09-24）**：兩條都已在正式環境啟用，並用真的 LINE 與 OpenRouter 實測過。這兩個檔案是從線上的 n8n 匯出的，線上有改動請重新匯出同步回來。

---

## 匯入步驟

### 1. 準備三把憑證

| 憑證名稱 | 類型 | 內容 | 給哪些節點 |
|---|---|---|---|
| `HEEEHABABY 機器金鑰` | Header Auth | Name `X-Notify-Token`，Value 是 Vercel 上 `NOTIFY_SHARED_SECRET` 的值 | 領取通知、回報結果、領取待辨識、回寫辨識結果 |
| `代購小幫手` | Line Messaging API（n8n 內建類型） | LINE OA 的 Channel access token | LINE 推播 |
| `nickleo3` | OpenRouter（n8n 內建類型） | OpenRouter API key | Claude 辨識 |

> 金鑰只放在 n8n 的憑證裡。不要貼進流程的欄位、不要貼進任何對話、不要 commit。

### 2. 匯入流程

n8n → **Workflows → Import from File**，分別匯入兩個 `.json`。
匯入後有紅色驚嘆號的節點，就是還沒選憑證：點開，照上表選對應的那把。

### 3. 確認「設定」節點

| 流程 | 欄位 | 預設 | 說明 |
|---|---|---|---|
| 兩條都有 | `api_base` | `https://japan-system-lilac.vercel.app` | 後端網址 |
| 通知收集器 | `liff_url` | 空白 | 填了之後，對帳單通知會附上「查看明細與付款」連結 |
| 拍照辨識 | `model` | `anthropic/claude-sonnet-5` | OpenRouter 的模型名稱。要換便宜的再改這裡（例如 `google/gemini-3.5-flash`） |

> ⚠️ 辨識請求**不要加 `temperature`、`top_p`、`top_k`**。Claude Sonnet 5 不接受自訂取樣參數，加上請求裡的 `provider.require_parameters: true`，OpenRouter 會找不到任何供應商而回 404，每一張照片都會靜靜地辨識失敗（2026-09-24 正式環境實際發生過）。

### 4. 手動跑一次，再啟用

先按 **Execute workflow** 跑一次。佇列是空的也沒關係，只要「領取通知」／「領取待辨識」是綠的，就代表金鑰對了。
接著右上角切成 **Active**。

### 5.（可選）讓出貨通知秒到

到 Vercel 加 `NOTIFY_HOOK_URL` = `https://nickleo9.zeabur.app/webhook/heeehababy-notify`，然後 Redeploy。
不設也會送，只是最慢要等一分鐘，等下一次輪詢。

---

## 出事時看哪裡

- 兩條流程都設成**成功的執行不存紀錄**（每分鐘一次，存下來會把 Zeabur 的空間吃光），**失敗的執行一定會存**。
  所以只要 Executions 裡出現紅色的，就是真的有問題。
- LINE 推播失敗不會讓流程變紅。失敗會回報給後端，後端依 1→5→15→60→360 分鐘退避重試，
  6 次都失敗會出現在**店主儀表板的待辦**，附上 LINE 的原話（例如額度用完）。
- 照片辨識失敗也不會變紅。照片 10 分鐘後自動回到佇列，同一張最多試 5 次。
  5 次都失敗，前台會停止顯示「辨識中」，請客人自己填。

## 設計上刻意的選擇

- **同一則通知永遠只推一次。** 每次重試都用同一把 `X-Line-Retry-Key`（由通知編號算出）。
  就算 n8n 在推完、還沒回報的那一刻掛掉，下一輪重推時 LINE 也會認出來、不再發。
- **價格只有一個來源。** AI 只讀日幣含稅價，台幣由後端查 `price_table` 換算。n8n 送台幣過去，後端也不採信。
- **客人贏過 AI。** 客人自己改過的品項，晚到的辨識結果不會蓋掉。
- **Webhook 不驗簽。** 它只負責「叫醒流程去輪詢」，本身不帶任何資料。被亂打最多只是多輪詢一次。
