// app.js
// 主流程：状态机、听写→LLM→朗读 自动循环、UI 联动

import {
  PERSONA_SYSTEM_PROMPT,
  FALLBACK_REPLY,
  NO_SPEECH_REPLY,
} from "./persona.js";
import { SpeechManager, isSTTSupported, isTTSSupported } from "./speech.js";
import { DeepSeekClient } from "./llm.js";
import {
  getApiKey,
  initSettingsPanel,
  openSettings,
  setOnKeySaved,
} from "./settings.js";

// 对话历史消息上限（约 10 轮），控制 token 避免溢出
const MAX_HISTORY = 20;

// 各状态对应的提示文字
const STATE_TEXT = {
  idle: "点下面的按钮，我们开始聊天吧",
  listening: "我在听～",
  thinking: "让我想想…",
  speaking: "听我说哦～",
};

class VoiceCompanionApp {
  constructor() {
    this.state = "idle";
    this.sessionActive = false;
    this.history = [];
    this.wakeLock = null;

    this.speech = new SpeechManager();
    this.llm = new DeepSeekClient();

    this._cacheDom();
    this._bindSpeechCallbacks();
    this._bindUI();
    this._bindWakeLock();
    this._checkSupport();

    // 注册 Key 保存回调：会话中重新填入 Key 后自动恢复监听
    setOnKeySaved(() => {
      if (this.sessionActive && this.state !== "listening") {
        this.enterListening();
      }
    });

    this.setState("idle");
  }

  // 缓存 DOM 引用
  _cacheDom() {
    this.appEl = document.getElementById("app");
    this.faceWrap = document.getElementById("faceWrap");
    this.statusEl = document.getElementById("statusText");
    this.interimEl = document.getElementById("interimText");
    this.replyEl = document.getElementById("replyBubble");
    this.startBtn = document.getElementById("startBtn");
    this.endBtn = document.getElementById("endBtn");
    this.supportWarning = document.getElementById("supportWarning");
  }

  // 绑定语音回调
  _bindSpeechCallbacks() {
    this.speech.onInterim = (text) => {
      if (this.state === "listening") {
        this.interimEl.textContent = text;
      }
    };
    this.speech.onFinal = () => {};
    this.speech.onEnd = (finalText) => {
      if (!this.sessionActive || this.state !== "listening") return;
      const text = (finalText || "").trim();
      if (!text) {
        // 没听到有效内容，继续听
        this.enterListening();
        return;
      }
      this.enterThinking(text);
    };
    this.speech.onError = (err) => {
      if (!this.sessionActive) return;
      if (this.state === "listening") {
        this.enterListening(); // 听写出错，稍后重试监听
      }
    };
  }

  // 绑定 UI 事件
  _bindUI() {
    this.startBtn.addEventListener("click", () => this.startChat());
    this.endBtn.addEventListener("click", () => this.endChat());

    // 加分项：说话过程中点击脸，可打断并重新监听
    this.faceWrap.addEventListener("click", () => {
      if (this.sessionActive && this.state === "speaking") {
        this.speech.cancelSpeak();
        this.enterListening();
      }
    });

    initSettingsPanel();
  }

  // 页面切回前台时重新申请 Wake Lock
  _bindWakeLock() {
    document.addEventListener("visibilitychange", () => {
      if (
        this.sessionActive &&
        document.visibilityState === "visible" &&
        !this.wakeLock &&
        "wakeLock" in navigator
      ) {
        this.acquireWakeLock();
      }
    });
  }

  // 能力检测：不支持时给出清晰中文提示而非崩溃
  _checkSupport() {
    const stt = isSTTSupported();
    const tts = isTTSSupported();
    if (!stt || !tts) {
      const parts = [];
      if (!stt) parts.push("语音听写（麦克风识别）");
      if (!tts) parts.push("语音朗读");
      this.supportWarning.textContent =
        "检测到你的浏览器不支持" +
        parts.join("与") +
        "。建议使用最新版安卓 Chrome 打开本页面。";
      this.supportWarning.hidden = false;
    }
    if (!stt || !tts) {
      this.startBtn.disabled = true;
      this.startBtn.textContent = "当前浏览器不支持";
    }
  }

  // 切换状态并联动 UI（脸、状态文字）
  setState(state) {
    this.state = state;
    this.appEl.classList.remove(
      "state-idle",
      "state-listening",
      "state-thinking",
      "state-speaking"
    );
    this.appEl.classList.add("state-" + state);
    this.statusEl.textContent = STATE_TEXT[state] || "";
  }

  // 开始聊天：检查能力/Key → 申请权限与 Wake Lock → 进入监听
  async startChat() {
    if (!isSTTSupported() || !isTTSSupported()) {
      this.supportWarning.hidden = false;
      return;
    }
    if (!getApiKey()) {
      openSettings();
      return;
    }
    this.sessionActive = true;
    this.history = [];
    await this.acquireWakeLock();
    // 兜底：若用户在等待 Wake Lock 期间点了“结束”，sessionActive 已被置否，
    // 此时锁可能刚刚申请成功，必须释放避免残留常亮。
    if (!this.sessionActive) {
      this.releaseWakeLock();
      return;
    }
    this.startBtn.hidden = true;
    this.endBtn.hidden = false;
    this.enterListening();
  }

  // 结束：停止识别/朗读、释放 Wake Lock、回到初始态
  endChat() {
    this.sessionActive = false;
    this.speech.stop();
    this.speech.cancelSpeak();
    this.releaseWakeLock();
    this.setState("idle");
    this.startBtn.hidden = false;
    this.endBtn.hidden = true;
    this.interimEl.textContent = "";
    this.replyEl.textContent = "";
  }

  // 进入监听态
  enterListening() {
    if (!this.sessionActive) return;
    if (this.state === "listening") return; // 防止重复启动
    this.setState("listening");
    this.interimEl.textContent = "我在听～";
    this.replyEl.textContent = "";
    this.speech.start();
  }

  // 进入思考态：调用 DeepSeek
  async enterThinking(userText) {
    this.setState("thinking");
    this.interimEl.textContent = "";

    const messages = [{ role: "system", content: PERSONA_SYSTEM_PROMPT }];
    for (const m of this.history) messages.push(m);
    messages.push({ role: "user", content: userText });

    const key = getApiKey();
    if (!key) {
      openSettings();
      return;
    }

    let reply = "";
    try {
      reply = await this.llm.chat(messages, key);
    } catch (e) {
      reply = FALLBACK_REPLY; // API 报错兜底
    }
    if (!reply) reply = NO_SPEECH_REPLY;

    // 保存历史并裁剪
    this.history.push({ role: "user", content: userText });
    this.history.push({ role: "assistant", content: reply });
    this._trimHistory();

    this.enterSpeaking(reply);
  }

  // 进入说话态：朗读回复，结束后自动回到监听
  enterSpeaking(text) {
    if (!this.sessionActive) return;
    this.setState("speaking");
    this.replyEl.textContent = text;
    this.speech.speak(text, {
      onEnd: () => {
        if (!this.sessionActive) return;
        this.enterListening();
      },
      onError: () => {
        if (!this.sessionActive) return;
        this.enterListening();
      },
    });
  }

  // 裁剪历史，保留最近 MAX_HISTORY 条
  _trimHistory() {
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(this.history.length - MAX_HISTORY);
    }
  }

  // 申请屏幕常亮
  async acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) {
      // 用户拒绝或不支持，不影响聊天
    }
  }

  // 释放屏幕常亮
  releaseWakeLock() {
    if (this.wakeLock) {
      try {
        this.wakeLock.release();
      } catch (e) {
        /* ignore */
      }
      this.wakeLock = null;
    }
  }
}

// 启动应用
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => new VoiceCompanionApp());
} else {
  new VoiceCompanionApp();
}
