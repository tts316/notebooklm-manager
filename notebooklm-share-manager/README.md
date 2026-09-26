# NotebookLM Share Manager

Chrome 擴充程式，用於管理 NotebookLM 筆記本的分享用戶。

## v2.0 重點（2026-09-26）

- **分享名單改走 NotebookLM 內部 API**：`inject-main.js`（MAIN world）讀頁面 `WIZ_global_data` 的 CSRF／session，直接呼叫 `/_/LabsTailwindUi/data/batchexecute`：
  - `JFMDGd` 讀取分享狀態：一次回傳全部使用者（email、權限 1擁有者/2編輯者/3檢視者、姓名）
  - `QDyure` 新增／改權限／移除（權限 4＝移除）；新增一次最多 50 筆、改權限一次送出、移除逐筆送
  - 送出後一律**回讀名單判定成敗**（伺服器對無效請求常回空結果不報錯、成功時也可能回錯誤碼）
  - v2.0.1：整包被拒（回 `[3]`，實測 20 筆新增全數未生效）時逐筆重送找出問題帳號；前 3 筆逐筆也全失敗視為格式問題，未生效的列改走畫面模擬。另在 console 記錄網頁版分享框實際送出的 `QDyure`（`[NLM-SM] 介面送出的 QDyure`），供比對修正參數格式
  - 不必開分享框、不必保持畫面；API 在尚未改動任何資料前失敗時，自動退回舊的畫面模擬流程（讀取完成的提示會標示是哪種模式）
  - RPC 代號與參數參考 [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py) `docs/rpc-reference.md`；Google 改版若失效，先比對該文件
- **浮動視窗**（比照 CAAC 名單通知）：右緣「分享管理」頁籤開闔、可上下拖曳；視窗標題列拖曳移動、右下角拉大小、「—」縮成標題列、「⟳」重新整理、「✕」收回頁籤；位置／大小／開闔狀態記在 `chrome.storage.local`
- 測試：`node test/api_batch.test.js`（以假伺服器驗證讀取與批次判定邏輯）
- NotebookLM 分享只剩檢視者／編輯者兩級，CSV 的 `commenter` 視同檢視者

## 功能

- **檢視**所有分享用戶及其權限
- **新增**分享用戶（自動發送 Google 通知信）
- **修改**用戶權限（檢視者 / 留言者 / 編輯者）
- **刪除**分享用戶
- **搜尋**分享用戶（即時過濾）
- **CSV 批次匯入**：上傳 .csv 一次新增/更新/刪除多位用戶
- **下載 CSV 範本**

---

## 安裝步驟

### 第一步：建立 Google Cloud 專案與 OAuth Client ID

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立新專案（或選擇既有專案）
3. 左側選單 → **API 和服務** → **已啟用的 API 和服務** → 搜尋並啟用 **Google Drive API**
4. 左側選單 → **憑證** → **建立憑證** → **OAuth 2.0 用戶端 ID**
5. 應用程式類型選 **Chrome 應用程式**
6. 名稱填入 `NotebookLM Share Manager`
7. **應用程式 ID**（Extension ID）先暫留，等載入擴充程式後再填（見下方）
8. 建立後複製 **用戶端 ID**（格式：`xxxxxxxx.apps.googleusercontent.com`）

### 第二步：填入 Client ID

開啟 `manifest.json`，找到：

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
```

將 `YOUR_CLIENT_ID.apps.googleusercontent.com` 替換為您的用戶端 ID。

### 第三步：產生圖示

1. 用瀏覽器開啟 `generate-icons.html`
2. 點擊「產生並下載圖示」
3. 將下載的 `icon16.png`、`icon48.png`、`icon128.png` 放入 `icons/` 資料夾

### 第四步：載入擴充程式

1. 開啟 Chrome，前往 `chrome://extensions/`
2. 右上角開啟「開發人員模式」
3. 點擊「載入未封裝項目」
4. 選擇 `notebooklm-share-manager` 資料夾

### 第五步：回填 Extension ID

1. 載入後，在 `chrome://extensions/` 頁面複製擴充程式的 **ID**（32 個字元）
2. 回到 Google Cloud Console → 憑證 → 編輯剛才的 OAuth Client
3. 在「應用程式 ID」填入 Extension ID → 儲存

---

## 使用方式

1. 前往 [NotebookLM](https://notebooklm.google.com/) 並開啟任一筆記本
2. 點擊 Chrome 工具列的擴充程式圖示
3. 首次使用會彈出 Google 登入授權視窗，請同意授權

### 分享用戶管理

| 操作 | 說明 |
|------|------|
| 新增 | 點擊「+ 新增」，輸入 email 並選擇權限後確認 |
| 修改 | 點擊用戶列的鉛筆圖示，選擇新權限後儲存 |
| 刪除 | 點擊用戶列的垃圾桶圖示後確認 |
| 搜尋 | 在搜尋框輸入 email 或姓名即時過濾 |

### CSV 批次匯入

**CSV 格式：**

```csv
email,role,action
alice@example.com,reader,add
bob@example.com,writer,update
charlie@example.com,,remove
```

| 欄位 | 說明 |
|------|------|
| email | Google 帳號電子郵件 |
| role | `reader`（檢視）/ `commenter`（留言）/ `writer`（編輯）|
| action | `add`（新增）/ `update`（更新）/ `remove`（移除）|

> `remove` 操作的 role 欄位可以留空。

**操作步驟：**
1. 切換到「CSV 匯入/匯出」頁籤
2. 拖曳 .csv 檔案至上傳區，或點擊「選擇檔案」
3. 確認預覽表格中的資料無誤（錯誤列會標示紅色）
4. 點擊「套用變更」執行批次操作
5. 完成後顯示逐列執行結果

---

## 權限說明

| 權限 | 用途 |
|------|------|
| `identity` | Google OAuth2 登入授權 |
| `storage` | 儲存暫存設定 |
| `activeTab` | 讀取目前分頁 URL 以取得筆記本 ID |
| `drive` scope | 透過 Google Drive API 管理分享權限 |

---

## 注意事項

- 只有筆記本的**擁有者**才能管理分享用戶
- 擁有者本身不可被刪除或修改
- 新增用戶時 Google 會自動發送分享通知信給對方
- CSV 批次匯入遇到錯誤會跳過該列繼續執行，並在結果中顯示原因
