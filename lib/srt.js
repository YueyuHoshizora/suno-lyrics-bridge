// 共用轉檔工具：把 Suno aligned_lyrics/v2 的逐字時間軸資料，轉成好讀的 SRT／LRC／純文字歌詞。
// 資料來源：https://studio-api.prod.suno.com/api/gen/{songId}/aligned_lyrics/v2/
// 回傳格式（已知欄位）：{ aligned_words: [{ word, start_s, end_s }, ...] }
// 這裡不是逐字一句（那樣字幕會閃很快），而是依「字間停頓」與「長度」把單字分組成可讀的句子。
(function (global) {
  "use strict";

  const DEFAULT_GROUPING = {
    maxGapSeconds: 0.6, // 兩字之間停頓超過這個秒數，視為換句
    maxLineChars: 42, // 單句字元數上限（含空白）
    maxLineSeconds: 6, // 單句時長上限
  };

  function normalizeWord(raw) {
    return typeof raw === "string" ? raw : "";
  }

  const BRACKET_PAIRS = { "[": "]", "(": ")" };
  const UNMATCHED_TAG_GIVE_UP = 12; // 開了標籤卻遲遲沒關，視為誤判，最多吞這麼多字就放棄跳過

  // 濾掉 [Chorus]／(Verse 1)／[Instrumental] 這類非歌詞的段落標記。
  // Suno 回傳的 aligned_words 是逐字（token）陣列，標記可能是單一 token（"[Chorus]"），
  // 也可能被拆成好幾個 token（"[Verse", "1]"），所以用「進入/離開標籤」的狀態機處理，
  // 而不是只檢查單一 token 是否被方括號/圓括號包住。
  function stripBracketedAnnotations(alignedWords) {
    const words = Array.isArray(alignedWords) ? alignedWords : [];
    const result = [];
    let closingChar = null;
    let sinceOpen = 0;

    for (const item of words) {
      const word = normalizeWord(item?.word).trim();

      if (closingChar) {
        sinceOpen += 1;
        if (word.includes(closingChar) || sinceOpen > UNMATCHED_TAG_GIVE_UP) closingChar = null;
        continue;
      }

      const opener = word[0];
      const expectedClose = BRACKET_PAIRS[opener];
      if (expectedClose) {
        if (!word.slice(1).includes(expectedClose)) {
          closingChar = expectedClose;
          sinceOpen = 0;
        }
        continue; // 不管是單一 token 關閉還是要繼續找關閉符號，這個 token 本身都不算歌詞
      }

      result.push(item);
    }
    return result;
  }

  // 把 aligned_words 陣列分組成句子（cue）：[{ start, end, text }]
  function groupWordsIntoCues(alignedWords, options = {}) {
    const { maxGapSeconds, maxLineChars, maxLineSeconds } = { ...DEFAULT_GROUPING, ...options };
    const words = stripBracketedAnnotations(alignedWords);
    const cues = [];
    let current = null;

    for (const item of words) {
      const word = normalizeWord(item?.word).trim();
      const start = Number(item?.start_s);
      const end = Number(item?.end_s);
      if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue;

      if (current) {
        const gap = start - current.end;
        const nextText = `${current.text} ${word}`;
        const nextDuration = end - current.start;
        const shouldBreak = gap > maxGapSeconds || nextText.length > maxLineChars || nextDuration > maxLineSeconds;
        if (shouldBreak) {
          cues.push(current);
          current = null;
        }
      }

      if (!current) {
        current = { start, end, text: word };
      } else {
        current.text += ` ${word}`;
        current.end = end;
      }
    }
    if (current) cues.push(current);
    return cues;
  }

  // Suno 的 aligned_lyrics/v2 端點名稱本身就叫「aligned_lyrics」，實際回應除了
  // 逐字的 aligned_words，很可能還有一份「已經照歌詞分段」的資料（很可能就叫
  // aligned_lyrics，內容大概是一行一個物件，有文字跟起訖時間）。字幕優先用這份
  // 官方本來就分好段的資料，比自己用停頓/字數猜的分段準；猜不到欄位名稱或內容
  // 不合理時，安全退回原本 groupWordsIntoCues() 的逐字分組做法，不會整個壞掉。
  // 注意：因為沙盒環境連不到 studio-api.prod.suno.com，這份「有 aligned_lyrics
  // 分段資料」的假設沒辦法實際打 API 驗證，如果之後發現用不到（一直退回逐字分組），
  // 可以照實際回應格式回來調整這裡讀的欄位名稱。
  function normalizeLineText(raw) {
    if (typeof raw === "string") return raw;
    if (typeof raw?.text === "string") return raw.text;
    return "";
  }

  function stripBracketedTextSpans(text) {
    return text
      .replace(/\s*\[[^\]]*\]\s*/g, " ")
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cuesFromAlignedLyricsLines(lines) {
    const cues = [];
    for (const line of Array.isArray(lines) ? lines : []) {
      if (!line || typeof line !== "object") continue;
      const text = normalizeLineText(line.text ?? line.line ?? line.lyric ?? line.word).trim();
      const start = Number(line.start_s ?? line.start ?? line.start_time);
      const end = Number(line.end_s ?? line.end ?? line.end_time);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      const cleaned = stripBracketedTextSpans(text);
      if (cleaned) cues.push({ start, end, text: cleaned });
    }
    return cues;
  }

  // 依 Suno API 回應（{ aligned_words, aligned_lyrics? }）組出字幕用的句子（cue）陣列。
  // 有可用的 aligned_lyrics（歌詞本身的分段）就優先用它，沒有才退回逐字分組。
  function buildCues(data, options = {}) {
    const lineCues = cuesFromAlignedLyricsLines(data?.aligned_lyrics);
    if (lineCues.length) return lineCues;
    return groupWordsIntoCues(data?.aligned_words, options);
  }

  function pad(value, length = 2) {
    return String(value).padStart(length, "0");
  }

  function formatSrtTime(seconds) {
    const total = Math.max(0, Math.round(seconds * 1000));
    const ms = total % 1000;
    const totalSeconds = Math.floor(total / 1000);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }

  function formatLrcTime(seconds) {
    const total = Math.max(0, Math.round(seconds * 100));
    const centis = total % 100;
    const totalSeconds = Math.floor(total / 100);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60);
    return `[${pad(m)}:${pad(s)}.${pad(centis, 2)}]`;
  }

  function cuesToSrt(cues) {
    return cues
      .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`)
      .join("\n\n") + "\n";
  }

  function cuesToLrc(cues) {
    return cues.map(cue => `${formatLrcTime(cue.start)}${cue.text}`).join("\n") + "\n";
  }

  function cuesToPlainLyrics(cues) {
    return cues.map(cue => cue.text).join("\n") + "\n";
  }

  global.SrtLib = { groupWordsIntoCues, stripBracketedAnnotations, cuesFromAlignedLyricsLines, buildCues, cuesToSrt, cuesToLrc, cuesToPlainLyrics, formatSrtTime, formatLrcTime };
})(typeof window !== "undefined" ? window : globalThis);
