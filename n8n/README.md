# n8n 流程

後端只做兩件事：**排隊**和**記帳**。真正對外（推 LINE、叫 Claude 看照片）的是這裡的兩條 n8n 流程。
後端不握 LINE 和 Anthropic 的金鑰，n8n 也不碰資料庫，兩邊只透過 `/api/v1/notify/*`、`/api/v1/ocr/*` 對話。

| 檔案 | 做什麼 | 多久跑一次 |
|---|---|---|
| `notify-collector.json` | 領出貨／對帳單通知 → LINE OA 推播 → 回報結果 | 每分鐘；後端出貨時也會打 Webhook 叫醒 |
| `ocr-worker.json` | 領待辨識的照片 → Claude 讀品名與含稅日幣價 → 回寫（售價由後端查表） | 每分鐘，一次最多 5 張 |

兩條都用 `npm run test:n8n` 在本機逐節點跑過：真的後端＋真的資料庫，LINE 和 Claude 用假的伺服器代替。

---

## 匯入步驟

### 1. 建三把憑證（Credentials → Add credential → **Header Auth**）

| 憑證名稱（建議） | Name | Value | 給哪些節點 |
|---|---|---|---|
| `HEEEHABABY 機器金鑰` | `X-Notify-Token` | Vercel 上 `NOTIFY_SHARED_SECRET` 的值 | 領取通知、回報結果、領取待辨識、回寫辨識結果 |
| `LINE OA 推播` | `Authorization` | `Bearer ` ＋ LINE OA 的 Channel access token（long-lived） | LINE 推播 |
| `Anthropic API` | `x-api-key` | Anthropic Console 建立的 API key | Claude 辨識 |

> 金鑰只放在 n8n 的憑證裡。不要貼進流程的欄位、不要貼進任何對話、不要 commit。

### 2. 匯入流程

n8n → **Workflows → Import from File**，分別匯入兩個 `.json`。
匯入後有紅色驚嘆號的節點，就是還沒選憑證：點開，照上表選對應的那把。

### 3. 確認「設定」節點

| 流程 | 欄位 | 預設 | 說明 |
|---|---|---|---|
| 兩條都有 | `api_base` | `https://japan-system-lilac.vercel.app` | 後端網址 |
| 通知收集器 | `liff_url` | 空白 | 填了之後，對帳單通知會附上「查看明細與付款」連結 |
| 拍照辨識 | `model` | `claude-opus-5` | 要換便宜的模型再改這裡 |

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
- **價格只有一個來源。** Claude 只讀日幣含稅價，台幣由後端查 `price_table` 換算。n8n 送台幣過去，後端也不採信。
- **客人贏過 AI。** 客人自己改過的品項，晚到的辨識結果不會蓋掉。
- **Webhook 不驗簽。** 它只負責「叫醒流程去輪詢」，本身不帶任何資料。被亂打最多只是多輪詢一次。
