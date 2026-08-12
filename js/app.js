// app.js
// 主流程：状态机、流式分句朗读、随时打断（barge-in）、UI 联动

import {
  PERSONA_SYSTEM_PROMPT,
  FALLBACK_REPLY,
  NO_SPEECH_REPLY,
} from "./persona.js";
import { SpeechManager, isSTTSupported, isTTSSupported } from "./speech.js";
import { DeepSeekClient } from "./llm.js";
import { isEcho } from "./echo.js";
import {
  getApiKey,
  getVoice,
  getBargeIn,
  initSettingsPanel,
  openSettings,
  setOnKeySaved,
} from "./settings.js";

// 对话历史消息上限（约 10 轮），控制 token 避免溢出
const MAX_HISTORY = 20;

// 说话时监听的"静默窗"：开播后前 N 毫秒不处理识别结果，规避 AI 自己的外放回声
const BARGE_IN_GRACE_MS = 1200;

// 状态提示文字
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

    // 流式与朗读流水线相关
    this._turnId = 0; // 轮次令牌：打断后旧流回调失效
    this._llmDone = false; // 本轮 LLM 是否已输出完毕
    this._currentReplyText = ""; // 本轮已生成完整回复（用于回声比对）
    this._speakStartTime = 0; // 最近一次开始朗读的时间
    this._bargeInEnabled = false; // 当前是否处于"说话时监听"态
    this._bargeInOn = true; // 用户设置：是否启用随时打断
    this._abortController = null;

    // TTS 预取 + 重叠播放 流水线
    this._ttsTextQueue = []; // 待合成文本数组
    this._ttsReady = []; // 已合成 Blob 数组，元素 { blob, text }
    this._synthesizing = false; // 是否正在（Edge）合成
    this._playing = false; // 是否正在播放某句
    this._currentPlayingText = ""; // 当前正在播放的文本
    this._spokenText = ""; // 已送去 TTS 的累计文本（回声基准之一）
    this._edgePrefetch = true; // 是否启用 Edge 预取；synthesize 失败则置 false 退回顺序 speak

    this.speech = new SpeechManager();
    this.llm = new DeepSeekClient();

    this._cacheDom();
    this._bindSpeechCallbacks();
    this._bindUI();
    this._bindWakeLock();
    this._checkSupport();

    // 会话中重新填入 Key 后自动恢复监听
    setOnKeySaved(() => {
      if (
        this.sessionActive &&
        this.state !== "listening" &&
        this.state !== "speaking"
      ) {
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
      // 仅监听态显示孩子的话；说话态不显示（避免把 AI 自己的回声显示出来）
      if (this.state === "listening") {
        this.interimEl.textContent = text;
      }
    };
    this.speech.onFinal = (finalText) => {
      // 说话态下：判断是否为孩子插话打断
      if (this.state === "speaking" && this._bargeInEnabled && this._bargeInOn) {
        const child = (finalText || "").trim();
        if (this._shouldInterrupt(child)) {
          this._interruptWith(child);
        }
      }
    };
    this.speech.onEnd = (finalText) => {
      if (!this.sessionActive) return;
      if (this.state !== "listening") return; // 说话态由 barge-in 分支处理
      const text = (finalText || "").trim();
      if (!text) {
        this.enterListening(); // 没听到有效内容，继续听
        return;
      }
      this.enterThinking(text);
    };
    this.speech.onError = (err) => {
      if (!this.sessionActive) return;
      if (this.state === "listening") {
        this.enterListening(); // 听写出错，稍后重试监听
      }
      // 说话态下的监听错误忽略（barge-in 会自动重启监听）
    };
  }

  // 绑定 UI 事件
  _bindUI() {
    this.startBtn.addEventListener("click", () => this.startChat());
    this.endBtn.addEventListener("click", () => this.endChat());

    // 说话过程中点击脸：手动打断，停止说话回到监听
    this.faceWrap.addEventListener("click", () => {
      if (this.sessionActive && this.state === "speaking") {
        this._manualStopSpeaking();
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
    this._bargeInOn = getBargeIn(); // 读取"随时打断"开关
    await this.acquireWakeLock();
    // 兜底：若用户在等待 Wake Lock 期间点了"结束"，释放残留常亮
    if (!this.sessionActive) {
      this.releaseWakeLock();
      return;
    }
    this.startBtn.hidden = true;
    this.endBtn.hidden = false;
    this.enterListening();
  }

  // 结束：停止识别/朗读/流、释放 Wake Lock、回到初始态
  endChat() {
    this.sessionActive = false;
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch (e) {}
      this._abortController = null;
    }
    this.speech.stopBargeIn();
    this.speech.stop();
    this.speech.cancelSpeak();
    this._ttsTextQueue = [];
    this._ttsReady = [];
    this._synthesizing = false;
    this._playing = false;
    this._currentPlayingText = "";
    this._bargeInEnabled = false;
    this._currentReplyText = "";
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
    if (this.state === "listening" && this.speech.listening) return;
    // 清理说话态残留
    this._bargeInEnabled = false;
    this.speech.stopBargeIn();
    this._ttsTextQueue = [];
    this._ttsReady = [];
    this._synthesizing = false;
    this._playing = false;
    this._currentPlayingText = "";
    this._currentReplyText = "";
    this.speech.cancelSpeak();
    this.setState("listening");
    this.interimEl.textContent = "我在听～";
    this.replyEl.textContent = "";
    this.speech.start();
  }

  // 进入思考态：流式调用 DeepSeek，句子成型即朗读
  async enterThinking(userText) {
    // 新轮次：让上一轮可能残留的流回调失效
    this._turnId++;
    const turn = this._turnId;

    this.setState("thinking");
    this._ttsTextQueue = [];
    this._ttsReady = [];
    this._synthesizing = false;
    this._playing = false;
    this._currentPlayingText = "";
    this._spokenText = "";
    this._edgePrefetch = true;
    this._llmDone = false;
    this._currentReplyText = "";
    this._bargeInEnabled = false;
    this.interimEl.textContent = "";

    // 记录孩子说的话
    this.history.push({ role: "user", content: userText });
    this._trimHistory();

    const messages = [{ role: "system", content: PERSONA_SYSTEM_PROMPT }];
    for (const m of this.history) messages.push(m);

    const key = getApiKey();
    if (!key) {
      openSettings();
      return;
    }

    // 中止上一轮可能还在跑的流
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch (e) {}
    }
    this._abortController = new AbortController();

    const onSentence = (s) => {
      if (turn !== this._turnId) return;
      if (!this.sessionActive) return;
      if (this.state !== "speaking") this._beginSpeaking();
      this._enqueueSentence(s);
    };
    const onDone = (full) => {
      if (turn !== this._turnId) return;
      this._llmDone = true;
      if (full) {
        this.history.push({ role: "assistant", content: full });
        this._trimHistory();
        this._currentReplyText = full;
      }
      // LLM 完成 且 队列与就绪都空 且 不播放 且不合成 → 本轮回复朗读完毕
      if (
        this._ttsTextQueue.length === 0 &&
        this._ttsReady.length === 0 &&
        !this._playing &&
        !this._synthesizing
      ) {
        this._onReplyFinished();
      }
    };
    const onError = (e) => {
      if (turn !== this._turnId) return;
      this._llmDone = true;
      if (this.state !== "speaking") this._beginSpeaking();
      this._enqueueSentence(FALLBACK_REPLY);
    };

    try {
      await this.llm.streamChat(messages, key, {
        onSentence,
        onDone,
        onError,
        signal: this._abortController.signal,
      });
    } catch (e) {
      if (turn === this._turnId && !this._abortController.signal.aborted) {
        this._llmDone = true;
        if (this.state !== "speaking") this._beginSpeaking();
        this._enqueueSentence(FALLBACK_REPLY);
      }
    }
  }

  // 进入说话态：开启 barge-in 监听，准备边说边听
  _beginSpeaking() {
    if (!this.sessionActive) return;
    this.setState("speaking");
    this._bargeInEnabled = true;
    this._speakStartTime = Date.now();
    this.replyEl.textContent = "";
    if (this._bargeInOn) this.speech.startBargeIn();
  }

  // 把一句放进待合成队列并驱动（预取 + 重叠播放）流水线
  _enqueueSentence(s) {
    const turn = this._turnId;
    const t = (s || "").trim();
    if (!t) return;
    this._spokenText += t; // 累计已送去 TTS 的文本，作为说话中途的回声基准
    this._ttsTextQueue.push(t);
    this._fillSynthesis();
    this._pumpPlayback();
  }

  // 预取合成：从待合成队列取句 → Edge 合成 Blob（预取上限 2，播放期间重叠合成）
  _fillSynthesis() {
    const turn = this._turnId;

    // 顺序兜底模式：Edge 不可用（synthesize 失败过）时，逐句 speak，保证不丢句
    if (!this._edgePrefetch) {
      while (
        this._ttsTextQueue.length > 0 &&
        !this._playing &&
        !this._synthesizing
      ) {
        const t = this._ttsTextQueue.shift();
        this.speech.speak(t, this._ttsHandlers(t));
      }
      return;
    }

    while (
      this._edgePrefetch &&
      !this._synthesizing &&
      this._ttsTextQueue.length > 0 &&
      this._ttsReady.length < 2
    ) {
      const t = this._ttsTextQueue.shift();
      this._synthesizing = true;
      this.speech
        .synthesize(t, getVoice())
        .then((blob) => {
          if (turn !== this._turnId || !this.sessionActive) return; // 陈旧轮次结果丢弃
          if (blob) {
            this._ttsReady.push({ blob, text: t });
          } else {
            // Edge 本次返回 null → 退回顺序 speak，并整体关闭预取
            this._edgePrefetch = false;
            this.speech.speak(t, this._ttsHandlers(t));
          }
          this._synthesizing = false;
          this._fillSynthesis();
          this._pumpPlayback();
        })
        .catch(() => {
          if (turn !== this._turnId || !this.sessionActive) return;
          this._synthesizing = false;
          this._edgePrefetch = false;
          this.speech.speak(t, this._ttsHandlers(t));
          this._fillSynthesis();
          this._pumpPlayback();
        });
    }
  }

  // 顺序兜底的朗读回调（synthesize 失败时使用）；onStart 置 _playing，onEnd/onError 复位并继续流水线
  _ttsHandlers(t) {
    return {
      voice: getVoice(),
      onStart: () => {
        this._playing = true;
        this.replyEl.textContent += t;
        if (this.state !== "speaking") this.setState("speaking");
      },
      onEnd: () => {
        this._playing = false;
        this._currentPlayingText = "";
        this._pumpPlayback();
        this._fillSynthesis();
      },
      onError: () => {
        this._playing = false;
        this._currentPlayingText = "";
        this._pumpPlayback();
        this._fillSynthesis();
      },
    };
  }

  // 播放器：取一个已合成 Blob 播放；就绪为空且 LLM 完成则结束本轮
  _pumpPlayback() {
    const turn = this._turnId;
    if (turn !== this._turnId) return; // 陈旧轮次不动作
    if (this._playing) return;
    if (this._ttsReady.length === 0) {
      if (
        this._llmDone &&
        this.sessionActive &&
        this.state === "speaking" &&
        !this._synthesizing
      ) {
        this._onReplyFinished();
      }
      return;
    }
    const item = this._ttsReady.shift();
    this._playing = true;
    this._currentPlayingText = item.text;
    this.speech.playBlob(item.blob, {
      onStart: () => {
        if (this.state !== "speaking") this.setState("speaking");
        this.replyEl.textContent += item.text;
      },
      onEnd: () => {
        this._playing = false;
        this._currentPlayingText = "";
        this._pumpPlayback();
        this._fillSynthesis();
      },
      onError: () => {
        this._playing = false;
        this._currentPlayingText = "";
        this._pumpPlayback();
        this._fillSynthesis();
      },
    });
    // 启动播放后再预取下一句 → 播放期间合成，句间无空隙
    this._fillSynthesis();
  }

  // 本轮回复朗读完毕：停止 barge-in 监听，回到监听态
  _onReplyFinished() {
    if (!this.sessionActive) return;
    if (this.state !== "speaking") return;
    this.speech.stopBargeIn();
    this._bargeInEnabled = false;
    this.enterListening();
  }

  // 孩子插话打断：取消朗读+监听，带着孩子的话进入新轮次
  _interruptWith(childText) {
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch (e) {}
      this._abortController = null;
    }
    this.speech.stopBargeIn();
    this.speech.cancelSpeak();
    this._ttsTextQueue = [];
    this._ttsReady = [];
    this._synthesizing = false;
    this._playing = false;
    this._currentPlayingText = "";
    this._llmDone = true;
    this._bargeInEnabled = false;
    this._currentReplyText = "";
    this.speech._finalText = "";
    this.enterThinking(childText);
  }

  // 手动打断（点脸）：停止说话回到监听，不触发新回答
  _manualStopSpeaking() {
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch (e) {}
      this._abortController = null;
    }
    this.speech.stopBargeIn();
    this.speech.cancelSpeak();
    this._ttsTextQueue = [];
    this._ttsReady = [];
    this._synthesizing = false;
    this._playing = false;
    this._currentPlayingText = "";
    this._llmDone = true;
    this._bargeInEnabled = false;
    this._currentReplyText = "";
    this.enterListening();
  }

  // 是否应视为孩子插话打断（回声过滤）
  _shouldInterrupt(child) {
    const t = (child || "").trim();
    if (!t) return false;
    if (t.length < 3) return false; // 从 2 提到 3，降低噪声误触
    // 开播前 1.2 秒不处理，规避 AI 自己外放的回声
    if (Date.now() - this._speakStartTime < BARGE_IN_GRACE_MS) return false;
    // 用「已念 + 正念 + 整段」作为回声比对基准（说话中途也能用，不再为空）
    const ai =
      (this._spokenText || "") +
      " " +
      (this._currentPlayingText || "") +
      " " +
      (this._currentReplyText || "");
    if (ai && isEcho(t, ai)) return false; // 是 AI 自己声音 → 忽略，不自我打断
    return true;
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
