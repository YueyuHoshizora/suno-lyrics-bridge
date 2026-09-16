const $ = id => document.getElementById(id);

const YUMEEW_ORIGIN = "https://ezmusic.yustellar.idv.tw";
const SUBTITLE_EDITOR_URL = `${YUMEEW_ORIGIN}/subtitle-editor.html`;
const SUNO_TOOL_URL = `${YUMEEW_ORIGIN}/suno-tool.html`;

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

function isSunoUrl(rawUrl) {
  try {
    return /(^|\.)suno\.com$/i.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

async function prefillFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // 這裡放寬成只要是 suno.com 網址就預填（含 /s/ 分享短連結），
    // 因為「下載音樂並套用到主畫面」跟網站的 suno-tool.js 一樣兩種格式都支援，
    // 只有「擷取歌詞時間軸」才需要真正的 /song/<id> 網址。
    if (tab?.url && isSunoUrl(tab.url)) $("song-url").value = tab.url;
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

async function waitForTabComplete(tabId) {
  await new Promise(resolve => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function findOrCreateEditorTab() {
  const existing = await chrome.tabs.query({ url: `${SUBTITLE_EDITOR_URL}*` });
  if (existing.length) return existing[0];

  const created = await chrome.tabs.create({ url: SUBTITLE_EDITOR_URL, active: false });
  await waitForTabComplete(created.id);
  return created;
}

// 開啟（或重用）一個 suno-tool.html 分頁並導到指定的 Suno 網址，讓後續的 executeScript
// 直接操作網站原本的表單/按鈕，重用網站上已經寫好、測試過的下載＋解密＋轉檔＋套用邏輯，
// 不在擴充元件這邊重做一份（也避免 model-proxy 的 Origin allowlist 擋掉擴充元件直接呼叫）。
async function openOrFocusSunoToolTab(sunoUrl) {
  const targetUrl = `${SUNO_TOOL_URL}?q=${encodeURIComponent(sunoUrl)}`;
  const [existing] = await chrome.tabs.query({ url: `${SUNO_TOOL_URL}*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { url: targetUrl });
    await waitForTabComplete(existing.id);
    return existing;
  }
  const created = await chrome.tabs.create({ url: targetUrl, active: false });
  await waitForTabComplete(created.id);
  return created;
}

// 這個函式會被注入到 suno-tool.html 分頁裡執行：等同幫使用者按「取得音樂」，
// 等網站自己把音樂下載、解密、轉成 WAV 完成後，再幫忙按「套用到主畫面」。
// 注意：這個函式回傳的 Promise 絕對不 reject —— chrome.scripting.executeScript
// 對「注入函式回傳的 Promise 被 reject」這件事的處理在不同版本不一致，
// 所以一律用 { ok, message } 這種回傳值來傳錯誤，呼叫端只看回傳值不看例外。
function driveSunoToolApply() {
  return new Promise(resolve => {
    const form = document.getElementById("suno-form");
    if (!form) { resolve({ ok: false, message: "找不到 Suno 工具頁面元素，頁面可能還沒載入完成，請稍後再試一次。" }); return; }
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else document.getElementById("suno-fetch")?.click();

    const deadline = Date.now() + 180000;
    (function poll() {
      const badge = document.getElementById("suno-status-badge");
      const errorEl = document.getElementById("suno-error");
      if (errorEl && !errorEl.hidden && errorEl.textContent) {
        resolve({ ok: false, message: errorEl.textContent });
        return;
      }
      if (badge && badge.classList.contains("ready")) {
        document.getElementById("suno-apply")?.click();
        resolve({ ok: true });
        return;
      }
      if (Date.now() > deadline) {
        resolve({ ok: false, message: "等待音樂處理逾時，請切到 YuMeew 分頁手動操作。" });
        return;
      }
      setTimeout(poll, 400);
    })();
  });
}

async function handleApplyAudio() {
  const rawUrl = $("song-url").value.trim();
  const audioStatus = $("audio-status");
  audioStatus.className = "status";
  if (!rawUrl) {
    audioStatus.textContent = "請先貼上 Suno 網址。";
    audioStatus.className = "status error";
    return;
  }

  $("apply-audio-button").disabled = true;
  audioStatus.textContent = "正在前往 YuMeew 下載音樂…";
  try {
    const tab = await openOrFocusSunoToolTab(rawUrl);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: driveSunoToolApply,
    });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (injection?.result?.ok) {
      audioStatus.textContent = "已在 YuMeew 分頁套用音樂到主畫面。";
      audioStatus.className = "status success";
    } else {
      audioStatus.textContent = injection?.result?.message || "無法自動套用音樂，請切到 YuMeew 分頁手動操作。";
      audioStatus.className = "status error";
    }
  } catch (error) {
    audioStatus.textContent = error?.message || "無法自動套用音樂，請切到 YuMeew 分頁手動操作。";
    audioStatus.className = "status error";
  } finally {
    $("apply-audio-button").disabled = false;
  }
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
$("apply-audio-button").addEventListener("click", handleApplyAudio);

prefillFromActiveTab();
