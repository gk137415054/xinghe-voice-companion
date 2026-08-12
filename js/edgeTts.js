// edgeTts.js
// 微软 Edge 神经 TTS 客户端（免费、无需任何 Key）。
// 通过 WebSocket 直连微软在线合成接口，返回自然真人般的中文嗓音（MP3）。
// 协议已根据 rany2/edge-tts 最新实现核实（含 Sec-MS-GEC 校验算法）。
//
// 设计约定：本模块只负责"成功返回音频"或"上报失败"，失败后的兜底（回退原生 SpeechSynthesis）
// 由 speech.js 负责，这里不自己兜底，避免重复播放。

export const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural"; // 温柔女声，最像大姐姐

// 可识别的取消错误：cancel() 会 reject 进行中的 synthesize/speak，但不应被当作真实错误
export class CancelError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelError";
    this.isCancel = true;
  }
}

// ---- 微软接口常量（公开、无需密钥） ----
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" +
  TRUSTED_CLIENT_TOKEN;
const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

// 超时阈值（毫秒）
const CONNECT_TIMEOUT_MS = 15000; // 连接建立超时
const AUDIO_FIRST_TIMEOUT_MS = 15000; // 首包音频到达超时

// Windows 时间戳纪元差（秒）：1970-01-01 与 1601-01-01 之差
const WIN_EPOCH = 11644473600;

// SHA256 → 十六进制大写（Web Crypto）
async function sha256hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

// 计算 Sec-MS-GEC 校验值（与 edge-tts drm.py 逐字一致）：
// unix 秒 + WIN_EPOCH，向下取整到 5 分钟，再 ×1e7 转成 100 纳秒刻度的 Windows filetime，拼 token 后 SHA256
async function computeGec() {
  let ticks = Date.now() / 1000; // Unix 秒(UTC)
  ticks += WIN_EPOCH; // 11644473600
  ticks -= ticks % 300; // 向下取整到 5 分钟
  ticks = Math.floor(ticks * 1e7); // 转 100ns 刻度的 Windows filetime
  const str = ticks.toString() + TRUSTED_CLIENT_TOKEN;
  return sha256hex(str);
}

// 当前时间的 ISO 字符串（精确到秒 + 'Z'），如 2026-08-12T06:00:00Z
function isoNow() {
  return new Date().toISOString().split(".")[0] + "Z";
}

// 对 SSML 文本做 XML 转义，避免标签被破坏
function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 构造 SSML（Microsoft 要求固定格式）
function buildSsml(text, voice) {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    "<voice name='" + voice + "'>" +
    "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
    escapeXml(text) +
    "</prosody></voice></speak>"
  );
}

export class EdgeTtsClient {
  constructor() {
    this._ws = null;
    this._audioChunks = [];
    this._finished = false;
    this._cancelled = false;
    this._audioEl = null;
    this._url = null;
    this._onStart = () => {};
    this._onEnd = () => {};
    this._onError = () => {};
    this._timers = [];
    // 进行中的 synthesize 的 reject（用于 cancel 时通知外层已取消）
    this._pendingReject = null;
  }

  /**
   * 朗读文本（兼容旧用法 / 兜底路径）。
   * 内部 = synthesize().then(play)，复用同一套 WS 逻辑。
   * @param {string} text 待朗读文本
   * @param {Object} handlers { voice, onStart, onEnd, onError }
   */
  speak(text, handlers = {}) {
    this._onStart = handlers.onStart || (() => {});
    this._onEnd = handlers.onEnd || (() => {});
    this._onError = handlers.onError || (() => {});

    const clean = (text || "").trim();
    if (!clean) {
      this._onEnd();
      return;
    }

    this.synthesize(clean, handlers.voice || DEFAULT_EDGE_VOICE)
      .then((blob) => {
        if (this._cancelled || this._finished) return;
        this._play(blob);
      })
      .catch((e) => {
        // 取消属于正常打断，静默处理；其余错误上报给上层兜底
        if (e instanceof CancelError || this._cancelled) return;
        console.warn("[EdgeTTS] 合成失败：", e);
        this._onError(e);
      });
  }

  /**
   * 合成文本为 MP3 Blob（不播放）。
   * @param {string} text 待合成文本
   * @param {string} [voice] 嗓音名
   * @returns {Promise<Blob>} 成功 resolve MP3 Blob；失败/取消 reject
   */
  synthesize(text, voice) {
    const clean = (text || "").trim();
    if (!clean) return Promise.reject(new Error("empty text"));
    this._resetRunState();
    return this._runToBlob(clean, voice || DEFAULT_EDGE_VOICE);
  }

  // 重置一次合成/朗读的运行态，便于同实例多次 synthesize
  _resetRunState() {
    this._finished = false;
    this._cancelled = false;
    this._ws = null;
    this._audioChunks = [];
    this._timers = [];
    this._pendingReject = null;
    this._url = null;
    this._audioEl = null;
  }

  /**
   * 内部：建立 WS、握手、收音频，收到 turn.end 时合并为 Blob 并 resolve。
   * 不播放 —— 由 speak() 在拿到 Blob 后自行 _play()，从而复用同一套 WS 逻辑。
   * @param {string} text
   * @param {string} voice
   * @returns {Promise<Blob>}
   */
  _runToBlob(text, voice) {
    return new Promise((resolve, reject) => {
      this._pendingReject = reject;

      computeGec()
        .then((gec) => {
          if (this._cancelled || this._finished) {
            reject(new CancelError());
            return;
          }

          const url =
            WSS_BASE +
            "&ConnectionId=" + crypto.randomUUID().replace(/-/g, "") +
            "&Sec-MS-GEC=" + gec +
            "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION;

          const ws = new WebSocket(url);
          ws.binaryType = "arraybuffer";
          this._ws = ws;

          const audioBuffer = [];
          let firstAudioReceived = false;

          const connectTimer = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
              this._fail(new Error("connect timeout"));
            }
          }, CONNECT_TIMEOUT_MS);
          this._timers.push(connectTimer);

          const audioTimer = setTimeout(() => {
            if (!firstAudioReceived) {
              this._fail(new Error("no audio received in time"));
            }
          }, AUDIO_FIRST_TIMEOUT_MS);
          this._timers.push(audioTimer);

          ws.onopen = () => {
            clearTimeout(connectTimer);
            // ① speech.config
            const config =
              "X-Timestamp:" + isoNow() + "\r\n" +
              "Content-Type:application/json; charset=utf-8\r\n" +
              "Path:speech.config\r\n" +
              "\r\n" +
              JSON.stringify({
                context: {
                  synthesis: {
                    audio: {
                      metadataoptions: {
                        sentenceBoundaryEnabled: "false",
                        wordBoundaryEnabled: "false",
                      },
                      outputFormat: OUTPUT_FORMAT,
                    },
                  },
                },
              });
            ws.send(config);

            // ② ssml
            const requestId = crypto.randomUUID().replace(/-/g, "");
            const ssml =
              "X-RequestId:" + requestId + "\r\n" +
              "Content-Type:application/ssml+xml\r\n" +
              "X-Timestamp:" + isoNow() + "\r\n" +
              "Path:ssml\r\n" +
              "\r\n" +
              buildSsml(text, voice);
            ws.send(ssml);
          };

          ws.onmessage = (event) => {
            if (this._cancelled || this._finished) return;
            if (typeof event.data === "string") {
              this._handleText(event.data, () => {
                // 收到 turn.end → 收尾并合并为 Blob resolve
                this._finishToBlob(audioBuffer, resolve);
              });
            } else {
              // 二进制帧：音频数据
              firstAudioReceived = true;
              clearTimeout(audioTimer);
              const bytes = new Uint8Array(event.data);
              const headerLen = (bytes[0] << 8) | bytes[1]; // 前 2 字节大端 = 头长度
              const audioData = bytes.slice(2 + headerLen); // 跳过头，剩余为 MP3
              if (audioData.length > 0) audioBuffer.push(audioData);
            }
          };

          ws.onerror = () => {
            this._fail(new Error("websocket error"));
          };

          ws.onclose = () => {
            // 若尚未通过 turn.end 收尾（异常关闭前已收到部分音频），尝试合并
            if (this._finished || this._cancelled) return;
            if (audioBuffer.length > 0) {
              this._finishToBlob(audioBuffer, resolve);
            } else {
              this._fail(new Error("websocket closed before audio"));
            }
          };
        })
        .catch((e) => {
          reject(e);
        });
    });
  }

  // 解析文本帧头，识别 Path
  _handleText(data, onTurnEnd) {
    const sep = data.indexOf("\r\n\r\n");
    const head = sep >= 0 ? data.slice(0, sep) : data;
    const lines = head.split("\r\n");
    let path = "";
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === "path") path = val;
    }
    if (path === "turn.end") {
      onTurnEnd();
    }
    // 其他 Path（如 audio.metadata）忽略
  }

  // 收尾：合并音频为 Blob 并 resolve（不播放）
  _finishToBlob(audioBuffer, resolve) {
    if (this._finished || this._cancelled) return;
    this._finished = true;
    this._clearTimers();

    let total = 0;
    for (const c of audioBuffer) total += c.length;
    if (total === 0) {
      this._fail(new Error("empty audio"));
      return;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of audioBuffer) {
      merged.set(c, off);
      off += c.length;
    }
    const blob = new Blob([merged], { type: "audio/mpeg" });
    this._pendingReject = null;
    resolve(blob);
  }

  // 用 <audio> 元素播放 MP3 Blob
  _play(blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    this._url = url;
    this._audioEl = audio;
    audio.src = url;

    let started = false;
    audio.onplaying = () => {
      if (!started) {
        started = true;
        this._onStart();
      }
    };
    audio.onended = () => {
      this._cleanupAudio();
      this._onEnd();
    };
    audio.onerror = () => {
      this._cleanupAudio();
      this._onError(new Error("audio playback error"));
    };

    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((e) => {
        // 自动播放被拦截或解码失败
        this._cleanupAudio();
        this._onError(e);
      });
    }
  }

  // 释放音频与连接资源
  _cleanupAudio() {
    if (this._audioEl) {
      try {
        this._audioEl.pause();
      } catch (e) {
        /* ignore */
      }
      this._audioEl = null;
    }
    if (this._url) {
      try {
        URL.revokeObjectURL(this._url);
      } catch (e) {
        /* ignore */
      }
      this._url = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch (e) {
        /* ignore */
      }
      this._ws = null;
    }
  }

  // 上报失败（仅触发一次）：reject 进行中的 synthesize/speak promise
  _fail(err) {
    if (this._finished || this._cancelled) return;
    this._finished = true;
    this._clearTimers();
    this._cleanupAudio();
    if (this._pendingReject) {
      this._pendingReject(err);
      this._pendingReject = null;
    }
  }

  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }

  // 取消当前合成/朗读（用于打断）：reject 进行中的 promise 并关闭 ws、清理
  cancel() {
    this._cancelled = true;
    this._clearTimers();
    if (this._pendingReject) {
      this._pendingReject(new CancelError());
      this._pendingReject = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch (e) {
        /* ignore */
      }
      this._ws = null;
    }
    this._cleanupAudio();
  }
}
