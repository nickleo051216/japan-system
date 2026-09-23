# 買家 API 合約（Buyer API Contract）v1.2

LIFF 買家前台（獨立 repo `japan-front-end-system`）與 japan-system 後端之間的**唯一邊界**。
前台照這份呼叫，後端照這份實作。兩邊任何一邊要改，先改這份文件。

- 參考實作：`scripts/buyer-contract-server.js`（記憶體版，供前台開發）
- 合約測試：`scripts/buyer-contract.test.js`（47 項，換網址即可驗證真後端）

---

## 1. 共通規則（沿用 japan-system I-02）

| 項目 | 規則 |
|---|---|
| 路徑 | `/api/v1/{resource}/{action}`，只用 GET（讀）與 POST（寫） |
| 網域 | 前台部署在 `japan-front-end-system.vercel.app`，以相對路徑呼叫 `/api/v1`，由前台的 `vercel.json` rewrites **反向代理**到後端。瀏覽器視為同網域，**後端不需開 CORS** |
| 回應 | 一律 `{ "ok": bool, "data": any, "error": { "code", "message" } \| null }` |
| 身分 | `Authorization: Bearer <liff.getIDToken()>`（`/health` 除外，公開），後端向 LINE 驗證後取 `sub` 當 `line_user_id`。**前端不傳 userId** |
| 冪等 | 所有 POST 帶 `Idempotency-Key`；同一把 key 重送回傳第一次的結果，不重複執行 |
| 錯誤 | `message` 是可直接顯示給客人的繁中句子；5xx 一律「系統忙碌中，稍後再試」，不外露技術細節 |
| 時間 | ISO 8601 字串（UTC） |
| 金額 | 台幣整數；日幣稅込為數字，可為 `null`（待報價） |

### HTTP 狀態與錯誤碼

| 狀態 | 用途 | 錯誤碼 |
|---|---|---|
| 400 | 輸入格式錯 | `BAD_NAME` `BAD_QTY` `BAD_IMAGE` `BAD_FILE_NAME` `BAD_SRC` `BAD_URL` `BAD_INVOICE` `BAD_TAX_ID` `BAD_PICKUP` `BAD_LAST5` `BAD_PAYWAY` `BAD_PHONE` `BAD_CARRIER` `BAD_NICKNAME` `EMPTY_CART` `BAD_JSON` |
| 401 | 未登入／token 失效 | `UNAUTHENTICATED` |
| 403 | 無權限 | `SUSPENDED`（棄單達 3 次）`FORBIDDEN` |
| 404 | 找不到 | `NOT_FOUND` `CART_NOT_FOUND` `ORDER_NOT_FOUND` `STATEMENT_NOT_FOUND` |
| 409 | 業務規則不允許 | `SOLD_OUT` `DEADLINE_PASSED` `NOT_EDITABLE` `NOT_CONFIRMED` `NOT_QUOTED` `NOT_SPLITTABLE` `ILLEGAL_TRANSITION` `ALREADY_PAID` |
| 5xx | 伺服器錯誤 | `INTERNAL`（前台只對 5xx 與網路錯誤自動重試） |

---

## 2. 端點一覽（27 個）

| # | 方法 | 路徑 | 用途 | 備註 |
|---|---|---|---|---|
| 0 | GET | `/health` | 後端健康狀態 | **公開、不需 token**。回 `{ status: "ok\|degraded\|down", db:{up,latency_ms}, detail }`；前台啟動時先打，`down` 顯示維護畫面不再打其他 API。`detail` 對外應為 `null` |


| # | 方法 | 路徑 | 用途 | 對應資料表 |
|---|---|---|---|---|
| 1 | GET | `/me/profile` | 會員資料 | members |
| 2 | POST | `/me/update` | 改暱稱、電話、取貨門市、地址、載具 | members |
| 3 | GET | `/home/summary` | 首頁一次取回：店家、團次、價目表、喊單、待辦 | settings, batches, price_table, broadcast |
| 4 | GET | `/cart/list` | 購物車（pending＋confirmed） | cart_items |
| 5 | POST | `/cart/add-text` | 文字下單 | cart_items |
| 6 | POST | `/cart/add-image` | 拍照下單（交給 n8n OCR） | cart_items |
| 7 | POST | `/cart/confirm` | 確認品項（可多筆） | cart_items |
| 8 | POST | `/cart/update` | 修改品項並確認 | cart_items |
| 9 | POST | `/cart/set-qty` | 改數量 | cart_items, broadcast |
| 10 | POST | `/cart/remove` | 移除（喊單品項記棄單） | cart_items, members, broadcast |
| 11 | POST | `/broadcast/shout` | 喊單（呼叫 DB 函式 `shout()`） | broadcast, cart_items |
| 12 | POST | `/broadcast/waitlist` | 排／取消候補 | restock_watch |
| 13 | GET | `/wishes/list` | 許願清單 | wishlist |
| 14 | POST | `/wishes/create` | 許願（照片／連結／文字） | wishlist |
| 15 | POST | `/wishes/to-cart` | 已報價許願加入購物車 | wishlist, cart_items |
| 16 | POST | `/wishes/keep` | 保留到下一團 | wishlist |
| 17 | POST | `/wishes/remove` | 刪除許願 | wishlist |
| 18 | POST | `/orders/checkout` | 結帳成立訂單 | orders, order_items, cart_items |
| 19 | GET | `/orders/list` | 我的訂單（**既有端點，買家只看自己的**） | orders, order_items |
| 20 | GET | `/orders/detail` | 訂單明細（既有端點） | orders… |
| 21 | POST | `/orders/split-request` | 申請／取消先出貨 | orders.split_shipped |
| 22 | POST | `/orders/received` | 我已收到 | orders（已出貨→已送達） |
| 23 | GET | `/shipments/track` | 物流貨態 | shipments |
| 24 | GET | `/statements/list` | 對帳單＋未結算彙總 | statements, orders |
| 25 | POST | `/statements/report-transfer` | 銀行轉帳回報末五碼 | statements |
| 26 | POST | `/statements/pay-init` | 信用卡／ATM／LINE Pay 付款初始化 | statements, payments |

所有端點**只回傳該 `line_user_id` 自己的資料**，不能透過參數查別人的。

---

## 3. 資料形狀

### CartItem
```json
{ "cart_id": "C-…", "source": "text|image|broadcast|wish|reorder", "ref": "BC-0913-002 | ocr_temp_… | W-104 | null",
  "name": "Pigeon 奶瓶", "name_ja": "", "jpy_taxed": 1000, "price_twd": 400, "qty": 2,
  "ai_confidence": "high|medium|low", "status": "pending|confirmed",
  "note": "", "file_name": null, "image_url": null, "created_at": "…" }
```
- `price_twd` 由後端依 `price_table` 級距換算；`jpy_taxed` 為 `null` 或超出級距時為 `null`（待現場報價）
- `source=broadcast` 建立時即為 `confirmed`；其餘建立時為 `pending`

### Order
```json
{ "order_id": "ORD-…", "batch": "T-260913", "status": "待確認|已報價|已到貨|已出貨|已送達|缺貨|已取消",
  "payment_status": "待付款|待官方確認|已核對", "paid": false,
  "total_twd": 1940, "ship_fee_twd": 70, "split_shipped": false, "statement_id": null,
  "pickup": "7-11 板橋文化門市", "pickup_addr": "…", "invoice": "手機載具 /AB12+3C", "note": "", "created_at": "…",
  "items": [ { "item_id": "…", "name": "…", "qty": 1, "jpy_taxed": 2519, "unit_price_twd": 890,
               "item_status": "待採買|採買中|已到貨|缺貨", "source": "text" } ],
  "status_log": [ { "to_status": "待確認", "ts": "…" } ],
  "shipments": [ { "shipment_id": "…", "carrier": "tcat|cvs711|cvsfami", "tracking_no": "…", "shipped_at": "…", "eta": "…" } ] }
```

### Statement
```json
{ "statement_id": "STMT-…", "order_ids": ["ORD-…"], "total_amount": 1940,
  "payment_status": "待付款|待官方確認|已核對", "payway": "credit|atm|linepay|bank|null",
  "last_five_matched": null, "created_at": "…", "paid_at": null,
  "invoice_no": null, "invoice_at": null, "v_account": null }
```

---

## 4. 逐項規格

### 1. `GET /me/profile`
回 members 一列：`member_no line_user_id nickname display_name status role phone cvs_brand cvs_store_id cvs_store_name cvs_addr home_addr carrier shout_drops bound_at created_at`
- `member_no` = 會員編號，格式 `HB-` 加 5 位數字（例：`HB-00012`），照加入順序由資料庫自動配號，超過 99999 照樣往上長（`HB-100000`）。**畫面上顯示會員編號，不要顯示 `line_user_id`**（2026-09-24 新增）

### 2. `POST /me/update`
可更新欄位：`nickname phone cvs_brand cvs_store_id cvs_store_name cvs_addr home_addr carrier`（未帶的不動）
- `nickname` 空白 → `BAD_NICKNAME`；重複 → DB 唯一索引擋下
- `phone` 不符 `^09\d{2}-?\d{3}-?\d{3}$` → `BAD_PHONE`
- `carrier` 不符 `^/[0-9A-Z.+-]{7}$` → `BAD_CARRIER`
- 回：更新後的會員資料

### 3. `GET /home/summary`
```json
{ "shop": { "name", "bank_name", "bank_code", "bank_account", "bank_holder", "bank_ready", "payment_deadline_days", "bulky_add_min", "bulky_add_max", "statement_days",
            "ship_fee": { "cvs": 70, "home": 120 } },
  "batch": { "batch", "name", "region", "close_at", "buy_at", "back_at", "ship_at", "stage" },
  "price_table": [ { "jpy_taxed_max": 429, "twd": 180 } ],
  "broadcast": [ { "send_id", "name", "jpy_taxed", "price_twd", "quantity", "remaining", "deadline_at", "note", "image_url",
                   "open": true, "waitlisted": false } ],
  "todo": { "unpaid_statements": 1, "pending_cart": 0 } }
```
- `open` = 尚有餘量 且 未過截止時間
- `waitlisted` = 此會員是否已排該項候補
- `bank_holder` = 收款戶名，店主在後台設定；空字串時前台不顯示戶名（新增欄位）
- `bank_ready` = 銀行名稱、代碼、帳號三者都有值才是 `true`；`false` 時前台引導改用信用卡／ATM（見 §8 #5）
- `ship_fee` = 台灣端運費（台幣），店主在後台設定；結帳實收用同一個來源。前台結帳頁請顯示這個值，不要寫死（新增欄位，舊前台忽略即可）

### 5. `POST /cart/add-text`
請求 `{ name, jpy_taxed?, qty, note?, source?: "reorder" }` → 回 CartItem（pending）

### 0. `GET /health`
公開端點。前台在 `boot()` 第一步呼叫；`status==="down"` 時顯示維護畫面並中止其餘請求。
**`detail` 對外必須為 `null`**——它會揭露「後台密碼未設定」「尚無成員」等內部狀態。

### 6. `POST /cart/add-image`
請求 `{ file_name, orig_name, mime, data }`（data 為 base64 data URL）
- `file_name` 必須符合 `^ocr_temp_[0-9a-z]{8}_\d{15}\.(jpg|png|webp|heic)$`（userId 末 8 碼＋15 碼時間戳），否則 `BAD_FILE_NAME`
- 圖片上限 3 MB（前台先壓縮；Vercel 單一請求 4.5 MB，base64 會膨脹約 1.33 倍）
- 後端存 Supabase Storage 的**私有** bucket（照片可能含個資），交給 n8n 辨識；**先回 pending、低信心、價格 null 的 CartItem**，辨識完成由 n8n 回寫。`image_url` 是 15 分鐘有效的簽名網址
- **辨識完成的通知方式：輪詢（已定案 2026-09-22，前端已實作）**
  - 前台在收到回應後，若 `ocr_done == false`，每 **4 秒**重打 `GET /cart/list`，最多 **40 次（約 2.5 分鐘）**（2026-09-24 由 15 次放寬：n8n 每分鐘領一次工作）
  - 判定完成：`ocr_done == true`（後端已提供）。`ocr_done == true` 但 `price_twd == null` 代表 AI 認不出來或重試用完，請客人自行填寫
  - 頁面切到背景時暫停輪詢；品項被移除或已下單則停止；超過上限提示客人自行填寫，不再輪詢
  - 後端不需要推播管線

### 7. `POST /cart/confirm`
請求 `{ cart_ids: [] }` → 回 `{ confirmed: [] }`（只有 pending 的會被改）

### 8. `POST /cart/update`
請求 `{ cart_id, name?, jpy_taxed?, qty?, note? }` → 重算 `price_twd`，狀態改 confirmed、信心改 high
- 喊單品項 → `409 NOT_EDITABLE`

### 9. `POST /cart/set-qty`
請求 `{ cart_id, qty }`；喊單品項增量需扣 `broadcast.remaining`（不足 → `409 SOLD_OUT`），減量回補

### 10. `POST /cart/remove`
請求 `{ cart_id }` → 回 `{ cart_id, shout_drops }`
- 喊單品項：餘量回補 ＋ `members.shout_drops + 1`（同一交易）

### 11. `POST /broadcast/shout`
請求 `{ send_id, qty }` → 回 `{ granted, remaining, rank, cart_item }`
- **必須呼叫資料庫函式 `shout()`**（列鎖＋原子扣量），不得在程式端讀→算→寫
- 餘量 0 → `409 SOLD_OUT`；過截止 → `409 DEADLINE_PASSED`；棄單 ≥ 3 → `403 SUSPENDED`
- 同一會員同一喊單已在購物車 → 數量累加到同一筆

### 12. `POST /broadcast/waitlist`
請求 `{ send_id, on: bool }` → 回 `{ send_id, waitlisted }`

### 14. `POST /wishes/create`
請求 `{ src: "photo|link|text", item_name?, ref_url?, quantity, note?, file_name?, data? }`
- `link` 需 `http(s)://` 開頭 → 否則 `BAD_URL`；`text` 需 `item_name`；`photo` 需 `file_name`＋`data`
- 建立時 `wish_status = 待處理`

### 15. `POST /wishes/to-cart`
請求 `{ wish_id }` → 回 `{ wish, cart_item }`；非「已報價」→ `409 NOT_QUOTED`；許願改為「已下單」

### 18. `POST /orders/checkout`
請求：
```json
{ "cart_ids": ["C-…"], "pickup": { "type": "cvs|home" },
  "invoice": { "type": "carrier|donate|tax", "carrier": "/AB12+3C", "tax_id": "12345678" }, "note": "" }
```
- 任一品項非 confirmed → `409 NOT_CONFIRMED`；統編非 8 碼 → `BAD_TAX_ID`
- 台灣端運費：由店主在後台「店家與收款設定」填（`settings.ship_fee_cvs` / `ship_fee_home`），未填時暫定超商 70、宅配 120（金額 `[待確認]`，業主決定）
- 取貨地址從會員資料帶入（前台不傳地址，避免竄改）
- 成立：`status=待確認`、`payment_status=待付款`、品項 `item_status=待採買`、購物車品項移出
- **同一 Idempotency-Key 重送只成立一張**

### 21. `POST /orders/split-request`
請求 `{ order_id, on }`；僅「已報價／已到貨」且**部分品項已到貨**時可申請 → 否則 `409 NOT_SPLITTABLE`

### 22. `POST /orders/received`
請求 `{ order_id }`；僅「已出貨」可改為「已送達」，否則 `409 ILLEGAL_TRANSITION`（由 DB trigger 擋）

### 23. `GET /shipments/track?order_id=`
回 shipments 陣列，每筆附 `events: [{ ts, status, place }]`
- `[待確認]` 貨態來源：物流商 API 或人工輸入

### 24. `GET /statements/list`
回 `{ statements: [Statement], unbilled: { count, amount } }`
- `unbilled` = 已報價以上、尚未歸入對帳單的訂單

### 25. `POST /statements/report-transfer`
請求 `{ statement_id, last5 }`；5 碼數字 → 否則 `BAD_LAST5`；已核對 → `409 ALREADY_PAID`
- 改為「待官方確認」，由後端排程比對入帳

### 26. `POST /statements/pay-init`
請求 `{ statement_id, payway: "credit|atm", invoice: { type, carrier, tax_id } }`（LINE Pay 不在綠界內，第二波另外串接，第一波不送）
- ATM：回 `{ flow: "vacc", v_account, v_bank, v_expire_at }`，**同一張對帳單重複取號回同一組**
- 信用卡／LINE Pay：回 `{ flow: "redirect", action, fields }`，前台以**表單 POST** 導向綠界
- 已核對 → `409 ALREADY_PAID`
- 綠界 CheckMacValue 與發票參數在後端產生，**HashKey／HashIV 不得出現在前端**
- `[待確認]` 付款成功後綠界回調端點（ReturnURL）

---

## 5. 驗證方式

```bash
# 對參考實作（前台開發用）
node scripts/buyer-contract-server.js 4011 &
node scripts/buyer-contract.test.js

# 對真後端（後端完成後驗收）
BASE=https://<部署網址>/api/v1 node scripts/buyer-contract.test.js
```
對真後端跑時，測試帳號需有與參考實作相同的種子資料（喊單 BC-0913-001～004、許願 W-104、訂單 ORD-20260901-014／ORD-20260828-007、對帳單 STMT-20260916-0032）。

**47/47 通過 = 前台可直接接上。**

---

## 6. v1.2 變更（2026-09-22 晚）

| # | 變更 | 後端影響 |
|---|---|---|
| 1 | 新增 `GET /health`（公開） | 已上線。請確認 `detail` 對外收斂為 `null` |
| 2 | 拍照辨識採輪詢，規格見第 4 節第 6 項 | 不需推播管線；辨識完成時把 `price_twd`、`ai_confidence`、`name` 寫回該筆 cart_item 即可 |
| 3 | 參考實作新增 `/health` 與「延遲 5 秒完成辨識」模擬（可用 `OCR_DELAY_MS` 調整） | 便於雙方測輪詢 |
| 4 | 檔名規則放寬為 `ocr_temp_[0-9a-z]{8}_\d{15}.(jpg\|png\|webp\|heic)` | 原本只收十六進位，示範帳號會被擋 |

## 7. v1.1 變更（2026-09-22）

| # | 變更 | 後端影響 |
|---|---|---|
| 1 | 前台獨立部署，`/api/v1/*` 經 Vercel rewrites 代理 | 不需 CORS；請求來源 IP 會是 Vercel 代理，記錄客人 IP 請讀 `x-forwarded-for`。`Authorization`、`Idempotency-Key` 會原樣轉送 |
| 2 | `pay-init` 的 `payway` 第一波只有 `credit`、`atm` | 收到 `linepay` 回 `400 BAD_PAYWAY` |
| 3 | 訂單 `status` 為「缺貨」「已取消」時，前台歸入「已完成」並顯示對應說明 | `/orders/list` 請照常回傳這兩種狀態，不要過濾掉 |
| 4 | 訂單 `items` 可為空陣列 | 前台會顯示「品項整理中」，不會當機 |
| 5 | `home.shop.bank_account` 為空時，前台顯示「匯款帳號暫時無法顯示」並引導改用信用卡／ATM | 仍建議後端在缺值時於 `/home/summary` 回 `shop.bank_ready: false`，方便日後前台判斷 |

## 8. 待確認事項

| # | 事項 | 影響端點 |
|---|---|---|
| 1 | ~~拍照辨識完成通知方式~~ **已定案：輪詢**，前端已實作 | 6 |
| 2 | 台灣端運費改由 settings 讀取 | 18 |
| 3 | 物流貨態來源（物流商 API 或人工） | 23 |
| 4 | 綠界付款回調端點與付款後前台返回頁 | 26 |
| 5 | ~~LINE Login channel ID~~ 已取得：`2011699944`（LIFF ID `2011699944-c5n725TF` 的前段） | 全部 |
