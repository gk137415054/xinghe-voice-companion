// speech.js
// 语音能力封装：听写(STT) 与 朗读(TTS)
// TTS 优先使用微软 Edge 神经嗓音（edgeTts.js），任何失败自动回退浏览器原生 SpeechSynthesis。

import { EdgeTtsClient, DEFAULT_EDGE_VOICE } from "./edgeTts.js";

// 兼容不同浏览器前缀（Chrome/Edge 使用 webkit 前缀）
const SpeechRecognitionImpl =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

// 是否支持语音听写
export function isSTTSupported() {
  return SpeechRecognitionImpl !== null;
}

// 是否支持语音合成（原生兜底所需）
export function isTTSSupported() {
  return typeof window.speechSynthesis !== "undefined";
}

export class SpeechManager {
  constructor() {
    this.recognition = null;
    this.listening = false;
    this._finalText = "";
    this._manualStop = false;
    this._bargeIn = false; // 旁路监听（说话时监听，用于随时打断）

    // 当前 Edge TTS 客户端实例（用于取消）
    this._currentEdge = null;

    // 是否正在进行 Edge 合成（防止重叠调用 synthesize）
    this._synthing = false;

    // 当前正在用 playBlob 播放的 Audio 元素（用于取消时暂停）
    this._currentAudio = null;

    // 外部回调（由 app.js 赋值）
    this.onInterim = () => {};
    this.onFinal = () => {};
    this.onEnd = () => {};
    this.onError = () => {};

    this._initRecognition();
    this._initVoices();
  }

  // 初始化听写识别器
  _initRecognition() {
    if (!isSTTSupported()) return;
    const rec = new SpeechRecognitionImpl();
    rec.lang = "zh-CN";
    rec.interimResults = true; // 实时返回 interim 文本
    rec.continuous = false; // 一句话结束后自动停止
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) this.onInterim(interim);
      if (final) {
        this._finalText += final;
        this.onFinal(final);
      }
    };

    rec.onerror = (event) => {
      // no-speech / aborted 属正常流程，交给 onend 处理
      if (event.error === "no-speech" || event.error === "aborted") return;
      this.onError(event.error || "speech-error");
    };

    rec.onend = () => {
      this.listening = false;
      const finalText = this._finalText;
      if (this._bargeIn) {
        // barge-in（说话时监听）：仍在对话中，延迟重启监听继续听
        // （延迟规避安卓 Chrome 在 onend 内立即 start 抛 InvalidStateError）
        this._manualStop = false;
        if (this._bargeIn) {
          setTimeout(() => {
            if (!this._bargeIn) return;
            try {
              this.recognition.start();
              this.listening = true;
            } catch (e) {
              /* 重启失败则静默，由上层超时或下一轮处理 */
            }
          }, 120);
        }
        return;
      }
      if (this._manualStop) {
        this._manualStop = false;
        return;
      }
      // 自然结束（静音）→ 通知上层（延迟一点等引擎复位，提升移动端稳定性）
      setTimeout(() => this.onEnd(finalText), 120);
    };

    this.recognition = rec;
  }

  // 预加载可用嗓音（部分浏览器异步加载）
  _initVoices() {
    if (!isTTSSupported()) return;
    if (typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
      window.speechSynthesis.onvoiceschanged = () => {
        this.getChineseVoice(); // 预热缓存
      };
    }
  }

  // 选择最合适的中文嗓音（优先女性化名称，语气温暖）—— 仅用于原生兜底
  getChineseVoice() {
    if (!isTTSSupported()) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;
    const zhVoices = voices.filter(
      (v) =>
        /^(zh|cmn|zh-CN|zh-TW|zh-HK)/i.test(v.lang) ||
        /中文|普通话|国语|Chinese/i.test(v.name)
    );
    if (zhVoices.length === 0) return null;
    const female = zhVoices.find((v) =>
      /female|女|婷|美|欣|雅|莹|雯|娜|Yue|Ya|Ting|Mei/i.test(v.name)
    );
    return female || zhVoices[0];
  }

  // 开始听写，返回是否成功启动
  start() {
    if (!this.recognition) return false;
    if (this.listening) return true;
    this._finalText = "";
    this._manualStop = false;
    this.listening = true;
    try {
      this.recognition.start();
      return true;
    } catch (e) {
      // 已在启动中，忽略异常
      this.listening = false;
      return false;
    }
  }

  // 主动停止听写（用于结束会话）
  stop() {
    if (this.recognition && this.listening) {
      this._manualStop = true;
      try {
        this.recognition.stop();
      } catch (e) {
        /* ignore */
      }
    }
  }

  // 开启"旁路监听"：AI 说话时也听，用于随时打断（barge-in）
  startBargeIn() {
    if (!this.recognition) return false;
    if (this.listening) return true;
    this._bargeIn = true;
    this._finalText = "";
    this._manualStop = false;
    this.listening = true;
    try {
      this.recognition.start();
      return true;
    } catch (e) {
      this.listening = false;
      return false;
    }
  }

  // 停止旁路监听
  stopBargeIn() {
    this._bargeIn = false;
    if (this.recognition && this.listening) {
      this._manualStop = true;
      try {
        this.recognition.stop();
      } catch (e) {
        /* ignore */
      }
    }
  }

  /**
   * 朗读文本。
   * 优先使用 Edge 神经 TTS；任何失败（连接/协议/超时/解析/播放）自动回退原生 SpeechSynthesis。
   * @param {string} text 待朗读文本
   * @param {Object} [handlers] { voice, onStart, onEnd, onError }
   */
  speak(text, handlers = {}) {
    const voice = handlers.voice || DEFAULT_EDGE_VOICE;
    // 优先 Edge 神经 TTS；环境不支持 WebSocket 时直接走原生兜底
    if (typeof window !== "undefined" && "WebSocket" in window) {
      this._speakWithEdge(text, voice, handlers);
    } else {
      this._fallbackSpeak(text, handlers);
    }
  }

  /**
   * 合成文本为 MP3 Blob（不播放）。一次只允许一个进行中（_synthing 双保险，app.js 也会限制数量）。
   * 任何失败/取消都 resolve(null)，绝不抛出，交由上层决定是否回退顺序 speak。
   * @param {string} text
   * @param {string} [voice]
   * @returns {Promise<Blob|null>}
   */
  synthesize(text, voice) {
    if (this._synthing) return Promise.resolve(null); // 已有进行中，跳过（双保险）
    this._synthing = true;
    const client = new EdgeTtsClient();
    this._currentEdge = client;
    return client
      .synthesize(text, voice)
      .then((blob) => {
        this._synthing = false;
        if (client === this._currentEdge) this._currentEdge = null;
        return blob;
      })
      .catch(() => {
        this._synthing = false;
        if (client === this._currentEdge) this._currentEdge = null;
        return null; // 任何失败/取消都 resolve(null)
      });
  }

  /**
   * 播放已合成的 Blob（与 edgeTts._play 行为一致：onplaying→onStart，onended→revoke+onEnd，onerror→revoke+onError）。
   * @param {Blob} blob
   * @param {Object} [handlers] { onStart, onEnd, onError }
   */
  playBlob(blob, handlers = {}) {
    const onStart = handlers.onStart || (() => {});
    const onEnd = handlers.onEnd || (() => {});
    const onError = handlers.onError || (() => {});

    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    this._currentAudio = audio;
    audio.src = url;

    let started = false;
    audio.onplaying = () => {
      if (!started) {
        started = true;
        onStart();
      }
    };
    audio.onended = () => {
      this._cleanupCurrentAudio(url, audio);
      onEnd();
    };
    audio.onerror = () => {
      this._cleanupCurrentAudio(url, audio);
      onError(new Error("audio playback error"));
    };

    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((e) => {
        this._cleanupCurrentAudio(url, audio);
        onError(e);
      });
    }
  }

  // 释放当前 Blob 播放的 Audio 与 url
  _cleanupCurrentAudio(url, audio) {
    if (audio) {
      try {
        audio.pause();
      } catch (e) {
        /* ignore */
      }
      if (this._currentAudio === audio) this._currentAudio = null;
    }
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /**
   * 用 Edge TTS 朗读；失败只回退一次（fellBack 守卫），避免死循环。
   * @param {string} text
   * @param {string} voice
   * @param {Object} handlers
   */
  _speakWithEdge(text, voice, handlers) {
    const client = new EdgeTtsClient();
    this._currentEdge = client;
    let fellBack = false;

    const doFallback = () => {
      if (fellBack) return;
      fellBack = true;
      this._currentEdge = null;
      console.warn(
        "[TTS] Edge 神经 TTS 不可用，回退到浏览器原生语音合成（SpeechSynthesis）。"
      );
      this._fallbackSpeak(text, handlers);
    };

    try {
      client.speak(text, {
        voice,
        onStart: () => {
          if (handlers.onStart) handlers.onStart();
        },
        onEnd: () => {
          this._currentEdge = null;
          if (handlers.onEnd) handlers.onEnd();
        },
        onError: () => {
          doFallback();
        },
      });
    } catch (e) {
      doFallback();
    }
  }

  /**
   * 浏览器原生 SpeechSynthesis 兜底朗读。
   * @param {string} text
   * @param {Object} handlers
   */
  _fallbackSpeak(text, handlers) {
    if (!isTTSSupported()) {
      if (handlers.onError) handlers.onError("TTS_UNSUPPORTED");
      return;
    }
    window.speechSynthesis.cancel(); // 清空之前队列
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.getChineseVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = "zh-CN";
    utterance.rate = 0.95; // 稍慢，适合孩子
    utterance.pitch = 1.15; // 音调略高，温暖
    utterance.onstart = () => {
      if (handlers.onStart) handlers.onStart();
    };
    utterance.onend = () => {
      if (handlers.onEnd) handlers.onEnd();
    };
    utterance.onerror = (e) => {
      if (handlers.onError) handlers.onError(e);
    };
    window.speechSynthesis.speak(utterance);
  }

  // 取消当前朗读（用于打断）：同时取消进行中的 Edge 合成、暂停正在播放的 Blob 音频、取消原生
  cancelSpeak() {
    if (this._currentEdge) {
      try {
        this._currentEdge.cancel(); // 取消进行中的 synthesize（promise 会 reject → app.js 的 .catch 处理）
      } catch (e) {
        /* ignore */
      }
      this._currentEdge = null;
    }
    if (this._currentAudio) {
      try {
        this._currentAudio.pause();
      } catch (e) {
        /* ignore */
      }
      if (this._currentAudio.src) {
        try {
          URL.revokeObjectURL(this._currentAudio.src);
        } catch (err) {
          /* ignore */
        }
      }
      this._currentAudio = null;
    }
    if (isTTSSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {
        /* ignore */
      }
    }
  }
}
