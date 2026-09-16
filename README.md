# suno-lyrics-bridge

個人用 Chrome 擴充元件（Manifest V3）：在 Suno 歌曲頁面擷取官方的逐字時間軸歌詞資料，下載成 SRT／LRC／純文字歌詞，或一鍵匯入 [YuMeew Music Studio](https://ezmusic.yustellar.idv.tw) 的字幕編輯器。

這是 [YuMeewMusic](https://github.com/YueyuHoshizora/YuMeewMusic) 專案的週邊工具，獨立成一個 repo 是因為它是瀏覽器擴充元件，部署與發布方式（Chrome 載入 unpacked extension）跟主站/Workers 完全不同。

## 這個擴充元件做什麼

Suno 有一個未公開文件、但登入後可用的內部 API：

```
GET https://studio-api.prod.suno.com/api/gen/{songId}/aligned_lyrics/v2/
Authorization: Bearer <token>
```

會回傳這首歌逐字的時間軸（`aligned_words: [{ word, start_s, end_s }, ...]`）。這個 token 就是你自己登入 Suno 後瀏覽器裡已經有的 session（Clerk 的 `__session` cookie），擴充元件只是讀出這個 token 幫你發送同一個請求 —— **不會另外儲存你的帳號密碼，也不會把任何資料送到 Suno／YuMeew 以外的地方**。

擷取到資料後可以：

- 下載 `.srt`／`.lrc`／純文字歌詞
- 一鍵「匯入到 YuMeew 字幕編輯器」：會找到（或開啟）`subtitle-editor.html` 分頁，把字幕直接寫進該頁使用的本機 IndexedDB（跟 `suno-tool.html` 的「套用到主畫面」用同一個資料庫、只是寫入 `subtitle` 這個欄位而不是 `audio`），然後重新整理該分頁。

另外還有「下載音樂並套用到主畫面」：這個**不是**擴充元件自己重做一套下載/解密邏輯，而是開啟（或切到）YuMeew 的 `suno-tool.html?q=<網址>` 分頁。從 v1.0.1 開始，`suno-tool.html` 自己偵測到 `?q=` 就會自動跑完「取得音樂」＋「套用到主畫面」並導向 `index.html`，擴充元件只需要負責開那個分頁、然後用 `chrome.tabs.onUpdated` 判斷它有沒有離開 `suno-tool.html`（離開＝成功）；失敗的話分頁會停在原地並顯示 `#suno-error`，擴充元件用一次性的 `chrome.scripting.executeScript` 讀出那段錯誤文字顯示給你看。這樣做是刻意的：

- `model-proxy` Worker 的 `/suno/resolve` 端點有 Origin allowlist，只接受 `https://ezmusic.yustellar.idv.tw` 發出的請求，擴充元件（`chrome-extension://...` origin）直接呼叫會被 403 擋掉；讓請求真的從 YuMeew 網站分頁發出就完全不用碰這個限制。
- 音樂的下載／AES-GCM+AES-CTR 解密／WAV 轉檔邏輯已經在 `js/suno-source.js`／`converter-core.js` 寫好且有測試，重新在擴充元件裡實作一份既多工又容易跟網站那邊的邏輯兜不起來，不如讓網站自己處理，擴充元件只負責「開分頁＋等結果」。

（v1.0.0 是用模擬點擊按鈕的方式驅動，v1.0.1 改成上面這個更簡單可靠的做法，因為網站本身已經支援 `?q=` 自動執行。）

這個功能跟字幕擷取互不影響（分開寫進 IndexedDB 的 `audio`／`subtitle` 兩個欄位），兩個都用的話，字幕編輯器分頁重新整理後會同時看到音樂與字幕。

## 為什麼不做在 YuMeewMusic 網站本身／Worker 裡

`aligned_lyrics` 端點需要登入 Suno 帳號才能存取，如果做進 YuMeew 的伺服器端（`model-proxy` Worker），代表要在伺服器上代管使用者的 Suno 登入憑證 —— 這違反 YuMeew 專案一貫「不存放第三方服務帳密、只做匿名/公開資料代理」的安全原則（見主站 `SECURITY.md`／`AGENTS.md`）。瀏覽器擴充元件則是在使用者自己已登入的瀏覽器情境裡執行，用的是使用者自己本來就有權限存取的資料，沒有這個疑慮。

## 安裝方式（僅供個人使用，未上架 Chrome 線上應用程式商店）

1. 打開 `chrome://extensions`
2. 開啟右上角「開發人員模式」
3. 點「載入未封裝項目」，選擇這個資料夾（`suno-lyrics-bridge/`）

## 使用方式

1. 在 Chrome 登入 `suno.com`
2. 打開想要抓字幕的歌曲頁面（網址需要是 `https://suno.com/song/<id>` 格式；分享連結 `https://suno.com/s/<code>` 在瀏覽器打開後網址列通常會變成 `/song/<id>`，等它跳轉完再用擴充元件）
3. 點擴充元件圖示，確認網址已自動帶入，按「擷取歌詞時間軸」
4. 下載檔案，或按「匯入到 YuMeew 字幕編輯器」直接送進字幕編輯器

## 已知限制

- 只支援 `/song/<uuid>` 格式的網址，不支援 `/s/<shareCode>` 分享短連結（Suno 內部 API 要的是實際歌曲 id）。
- 讀取 `__session` cookie 直接當 Bearer token 送出，這是社群已驗證可行的做法，但屬於未公開行為，Suno 未來調整登入機制（例如改回需要走完整的 Clerk token 換發流程）時可能需要更新 `popup/popup.js` 的 `getSunoSessionToken()`／`fetchAlignedWords()`。
- 不是每首歌都一定有逐字對齊資料（例如非 Suno 生成、或尚未產生對齊資料的歌曲），這種情況會顯示錯誤訊息而不是拿到殘缺資料。
- 分句規則（`lib/srt.js` 的 `groupWordsIntoCues`）是依停頓時間／字數／秒數做的簡單啟發式分組，不是語意斷句，需要的話可以之後再調。

## 檔案結構

```
manifest.json       # MV3 設定，宣告 suno.com / studio-api.prod.suno.com / ezmusic.yustellar.idv.tw 的 host permission
popup/popup.html     # 擴充元件彈出視窗
popup/popup.css
popup/popup.js       # 主要邏輯：讀 cookie、打 API、轉檔、下載、匯入 YuMeew
lib/srt.js           # aligned_words → 句子分組 → SRT／LRC／純文字 轉換
icons/               # 圖示
```
