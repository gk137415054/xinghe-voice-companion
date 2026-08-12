// speech.js
// 语音能力封装：听写(STT) 与 朗读(TTS)
// 依赖浏览器原生 Web Speech API，无外部依赖。

// 兼容不同浏览器前缀（Chrome/Edge 使用 webkit 前缀）
const SpeechRecognitionImpl =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

// 是否支持语音听写
export function isSTTSupported() {
  return SpeechRecognitionImpl !== null;
}

// 是否支持语音合成
export function isTTSSupported() {
  return typeof window.speechSynthesis !== "undefined";
}

export class SpeechManager {
  constructor() {
    this.recognition = null;
    this.listening = false;
    this._finalText = "";
    this._manualStop = false;

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

  // 选择最合适的中文嗓音（优先女性化名称，语气温暖）
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

  // 朗读文本
  speak(text, handlers = {}) {
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

  // 取消当前朗读（用于打断）
  cancelSpeak() {
    if (isTTSSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {
        /* ignore */
      }
    }
  }
}
