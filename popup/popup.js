const $ = id => document.getElementById(id);

const YUMEEW_ORIGIN = "https://ezmusic.yustellar.idv.tw";
const SUBTITLE_EDITOR_URL = `${YUMEEW_ORIGIN}/subtitle-editor.html`;

let lastResult = null; // { srtText, lrcText, txtText, fileBase }

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message || "";
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

function setBusy(busy) {
  $("fetch-button").disabled = busy;
  $("fetch-button").textContent = busy ? "擷取中…" : "擷取歌詞時間軸";
}

function parseSongId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)suno\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/\/song\/([0-9a-f-]{20,})\/?$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function prefillFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && parseSongId(tab.url)) $("song-url").value = tab.url;
  } catch {
    // 沒有分頁權限時安靜略過，使用者仍可手動貼網址。
  }
}

async function getSunoSessionToken() {
  const cookie = await chrome.cookies.get({ url: "https://suno.com", name: "__session" });
  return cookie?.value || null;
}

async function fetchAlignedWords(songId, token) {
  const response = await fetch(`https://studio-api.prod.suno.com/api/gen/${songId}/aligned_lyrics/v2/`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (response.status === 401 || response.status === 403) {
    throw Error("Suno 拒絕了這個請求（401/403），登入憑證可能已過期，請重新整理 Suno 分頁再試一次。");
  }
  if (!response.ok) throw Error(`Suno API 回應錯誤（HTTP ${response.status}）。`);
  const data = await response.json().catch(() => null);
  if (!data?.aligned_words?.length) throw Error("這首歌沒有可用的逐字時間軸資料（可能尚未產生對齊資料，或不是 Suno 生成的歌曲）。");
  return data.aligned_words;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function handleFetch() {
  setStatus("");
  $("result").hidden = true;
  lastResult = null;

  const songId = parseSongId($("song-url").value.trim());
  if (!songId) {
    setStatus("網址格式不對，需要 https://suno.com/song/<id> 這種格式。", "error");
    return;
  }

  setBusy(true);
  try {
    const token = await getSunoSessionToken();
    if (!token) throw Error("找不到 Suno 登入憑證，請先在 Chrome 登入 suno.com，並保持分頁開著再試一次。");

    const alignedWords = await fetchAlignedWords(songId, token);
    const cues = SrtLib.groupWordsIntoCues(alignedWords);
    if (!cues.length) throw Error("解析後沒有任何可用的句子，可能是資料格式有變動。");

    const fileBase = `suno-${songId.slice(0, 8)}`;
    lastResult = {
      srtText: SrtLib.cuesToSrt(cues),
      lrcText: SrtLib.cuesToLrc(cues),
      txtText: SrtLib.cuesToPlainLyrics(cues),
      fileBase,
    };

    const duration = cues[cues.length - 1].end;
    $("result-summary").textContent = `共 ${cues.length} 句字幕，總長度約 ${formatDuration(duration)}。`;
    $("result").hidden = false;
    setStatus("擷取成功！", "success");
  } catch (error) {
    setStatus(error?.message || "發生未知錯誤。", "error");
  } finally {
    setBusy(false);
  }
}

function injectSubtitleIntoIndexedDb(srtText, filename) {
  // 這個函式會被 chrome.scripting.executeScript 注入到 YuMeew 網站分頁裡執行，
  // 所以這裡只能用瀏覽器原生 API，不能引用 popup.js 作用域裡的任何東西。
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("yumeew-media-v1", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("files")) request.result.createObjectStore("files");
    };
    request.onerror = () => reject(request.error || Error("無法開啟 YuMeew 本機儲存空間。"));
    request.onsuccess = () => {
      const db = request.result;
      const blob = new Blob([srtText], { type: "text/plain" });
      const record = { blob, name: filename, type: "text/plain", lastModified: Date.now() };
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(record, "subtitle");
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error || Error("寫入字幕失敗。")); };
    };
  });
}

async function findOrCreateEditorTab() {
  const existing = await chrome.tabs.query({ url: `${SUBTITLE_EDITOR_URL}*` });
  if (existing.length) return existing[0];

  const created = await chrome.tabs.create({ url: SUBTITLE_EDITOR_URL, active: false });
  await new Promise(resolve => {
    function onUpdated(tabId, info) {
      if (tabId === created.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  return created;
}

async function handleImport() {
  if (!lastResult) return;
  setStatus("正在匯入到 YuMeew 字幕編輯器…");
  try {
    const tab = await findOrCreateEditorTab();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectSubtitleIntoIndexedDb,
      args: [lastResult.srtText, `${lastResult.fileBase}.srt`],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.reload() });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    setStatus("已匯入，字幕編輯器分頁會重新載入字幕。", "success");
  } catch (error) {
    setStatus(error?.message || "匯入失敗，請確認已允許擴充元件存取 YuMeew 網站。", "error");
  }
}

$("fetch-button").addEventListener("click", handleFetch);
$("download-srt").addEventListener("click", () => lastResult && downloadText(lastResult.srtText, `${lastResult.fileBase}.srt`, "text/plain"));
$("download-lrc").addEventListener("click", () => lastResult && downloadText(lastResult.lrcText, `${lastResult.fileBase}.lrc`, "text/plain"));
$("download-txt").addEventListener("click", () => lastResult && downloadText(lastResult.txtText, `${lastResult.fileBase}.txt`, "text/plain"));
$("import-button").addEventListener("click", handleImport);

prefillFromActiveTab();
