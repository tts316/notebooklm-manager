# NotebookLM Share Manager

Chrome 擴充程式（v2.0.7），在 NotebookLM 筆記本頁面上直接讀取／修改真正的分享名單。

> 權威規格在 repo 根目錄 `系統架構與規格.md` §五之一；本檔只列安裝與操作。規則（僅限「聯成人AI」筆記本、依標籤同步、300 人上限）以規格為準。

## 運作方式

- **僅限「聯成人AI」筆記本**：側欄以 `rLM1Ne` API 取筆記本標題，不含「聯成人AI」就拒絕載入名單與操作。
- **分享名單走 NotebookLM 內部 API**：`inject-main.js`（MAIN world）讀頁面 `WIZ_global_data` 的 CSRF／session，直接呼叫 `/_/LabsTailwindUi/data/batchexecute`：
  - `JFMDGd` 讀取分享狀態：一次回傳全部使用者（email、權限 1擁有者/2編輯者/3檢視者、姓名）
  - `QDyure` 新增／改權限／移除（權限 4＝移除）；新增每批 50 筆、改權限一次送出、移除逐筆送
  - 送出後一律**回讀名單判定成敗**（伺服器對無效請求常回空結果不報錯、成功時也可能回錯誤碼）
  - 整包被拒（回 `[3]`）時逐筆重送找出問題帳號；前 3 筆逐筆也全失敗視為格式問題，未生效的列改走畫面模擬
  - API 在尚未改動任何資料前失敗時，自動退回畫面模擬流程（讀取完成的提示會標示是哪種模式）
  - RPC 代號與參數參考 [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py) `docs/rpc-reference.md`；Google 改版若失效，先比對該文件
- **浮動視窗**（比照 CAAC 名單通知）：右緣「分享管理」頁籤開闔、可上下拖曳；標題列拖曳移動、右下角拉大小、「—」縮成標題列、「⟳」重新整理、「✕」收回頁籤；位置／大小／開闔狀態記在 `chrome.storage.local`
- 不需 Google Cloud 專案、OAuth 或 Drive API：manifest 權限只有 `storage`、`activeTab`、`scripting`、`tabs`，用的是瀏覽器已登入的 Google 帳號。

## 安裝

1. Chrome 前往 `chrome://extensions/`，右上角開啟「開發人員模式」
2. 「載入未封裝項目」→ 選 `D:\AI-SYS\NotebookLM管理工具\notebooklm-share-manager`
3. 開啟「聯成人AI」筆記本頁面，點右緣「分享管理」頁籤

manifest 沒有 `key`，換目錄載入＝新擴充 ID，`chrome.storage.local` 的通訊錄對照與視窗位置不會帶過去，需重新上傳 Google 通訊錄 CSV。

⑮ 排程維運每晚 20:00 的 `nlm_sync.py` 也載入這個目錄，改程式碼後當晚的正式同步就會用新版。

## 功能

- **檢視**分享名單與權限，**搜尋**（即時過濾）
- **新增**分享對象（Google 會寄分享通知信給對方）
- **修改**權限、**移除**分享對象（擁有者不可修改或移除）
- **CSV 批次匯入**：上傳 .csv 一次新增／更新／移除多人，可下載範本
- **Google 通訊錄**：上傳學管下載的 Google 通訊錄 CSV，名單帶入姓名與標籤；資料存在本機
- **依標籤同步**：依通訊錄標籤產生同步預覽（「0待刪除名單」移除、其他標籤以檢視者加入、超過 300 人依規則暫緩），確認後套用

### CSV 格式

```csv
email,role,action
alice@example.com,reader,add
bob@example.com,writer,update
charlie@example.com,,remove
```

| 欄位 | 說明 |
|------|------|
| email | Google 帳號電子郵件 |
| role | `reader`（檢視者）/ `writer`（編輯者）。NotebookLM 分享只剩這兩級，`commenter` 仍可填但視同檢視者 |
| action | `add`（新增）/ `update`（更新）/ `remove`（移除）；`remove` 的 role 可留空 |

## 權限說明

| 權限 | 用途 |
|------|------|
| `storage` | 存通訊錄對照、視窗位置與開闔狀態 |
| `activeTab`、`tabs` | 找到開著的 NotebookLM 筆記本分頁，轉送側欄指令給 content script |
| `scripting` | manifest 有宣告，但程式目前沒有呼叫 `chrome.scripting`（content script 由 manifest 的 `content_scripts` 注入） |
| host：`notebooklm.google.com`、`notebook.google.com` | 讀寫該網域的分享名單 |

## 測試

```
node test/api_batch.test.js     # 假伺服器驗證讀取、批次判定、回讀優先、失敗退回
node test/sync_labels.test.js   # 依標籤同步與 300 人上限排除
```

## 注意事項

- 只有筆記本**擁有者**能讀到完整名單、管理分享
- 新增時 Google 會寄分享通知信，誤加的人也會收到
- CSV 批次匯入遇到錯誤會跳過該列繼續執行，並在結果中顯示原因
