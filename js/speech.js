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
        // barge-in（说话时监听）：仍在对话中，自动重启监听继续听
        this._manualStop = false;
        if (this._bargeIn) {
          try {
            this.recognition.start();
            this.listening = true;
          } catch (e) {
            /* 重启失败则静默，由上层超时或下一轮处理 */
          }
        }
        return;
      }
      if (this._manualStop) {
        this._manualStop = false;
        return;
      }
      // 自然结束（静音）→ 通知上层
      this.onEnd(finalText);
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

  // 取消当前朗读（用于打断）：同时取消 Edge 与 原生
  cancelSpeak() {
    if (this._currentEdge) {
      try {
        this._currentEdge.cancel();
      } catch (e) {
        /* ignore */
      }
      this._currentEdge = null;
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
