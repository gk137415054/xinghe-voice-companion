// settings.js
// DeepSeek Key 设置面板 + 嗓音选择 + localStorage 持久化

import { DEFAULT_EDGE_VOICE } from "./edgeTts.js";

const STORAGE_KEY = "voiceCompanion.deepseekApiKey";
const VOICE_STORAGE_KEY = "voiceCompanion.edgeVoice";

// 可选的"Key 已保存"回调（由 app.js 注册），用于会话中重填 Key 后自动恢复
let onKeySaved = null;

// 中文神经嗓音选项（微软 Edge TTS）
export const VOICE_OPTIONS = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓（温柔女声 · 默认）" },
  { id: "zh-CN-YunxiNeural", label: "云希（阳光男声）" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊（甜美女声）" },
  { id: "zh-CN-YunyangNeural", label: "云扬（沉稳男声）" },
];

// 注册 Key 保存成功后的回调（供主流程联动恢复监听）
export function setOnKeySaved(cb) {
  onKeySaved = cb;
}

// 读取已保存的 Key（不硬编码任何真实密钥）
export function getApiKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch (e) {
    return "";
  }
}

// 保存 Key
export function setApiKey(key) {
  try {
    localStorage.setItem(STORAGE_KEY, (key || "").trim());
    return true;
  } catch (e) {
    return false;
  }
}

// 读取已保存的嗓音（默认晓晓）
export function getVoice() {
  try {
    const v = localStorage.getItem(VOICE_STORAGE_KEY);
    if (!v) return DEFAULT_EDGE_VOICE;
    // 校验是否为已知选项，避免脏数据
    return VOICE_OPTIONS.some((o) => o.id === v) ? v : DEFAULT_EDGE_VOICE;
  } catch (e) {
    return DEFAULT_EDGE_VOICE;
  }
}

// 保存嗓音选择
export function setVoice(voice) {
  try {
    localStorage.setItem(
      VOICE_STORAGE_KEY,
      voice && VOICE_OPTIONS.some((o) => o.id === voice)
        ? voice
        : DEFAULT_EDGE_VOICE
    );
    return true;
  } catch (e) {
    return false;
  }
}

// 打开设置面板（供 app.js 在缺少 Key 时调用）
export function openSettings() {
  const panel = document.getElementById("settingsPanel");
  const input = document.getElementById("apiKeyInput");
  const select = document.getElementById("voiceSelect");
  if (panel) {
    if (input) input.value = getApiKey();
    if (select) select.value = getVoice();
    panel.hidden = false;
    if (input) input.focus();
  }
}

// 简单的轻提示
function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

// 填充嗓音下拉选项
function populateVoiceSelect() {
  const select = document.getElementById("voiceSelect");
  if (!select) return;
  select.innerHTML = "";
  for (const opt of VOICE_OPTIONS) {
    const el = document.createElement("option");
    el.value = opt.id;
    el.textContent = opt.label;
    select.appendChild(el);
  }
  select.value = getVoice();
}

// 初始化设置面板交互
export function initSettingsPanel() {
  const panel = document.getElementById("settingsPanel");
  const openBtn = document.getElementById("settingsBtn");
  const closeBtn = document.getElementById("closeSettingsBtn");
  const saveBtn = document.getElementById("saveKeyBtn");
  const input = document.getElementById("apiKeyInput");
  const select = document.getElementById("voiceSelect");

  populateVoiceSelect();
  if (input) input.value = getApiKey();

  if (openBtn) {
    openBtn.addEventListener("click", () => {
      if (input) input.value = getApiKey();
      if (select) select.value = getVoice();
      panel.hidden = false;
      if (input) input.focus();
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      panel.hidden = true;
    });
  }
  if (select) {
    // 切换嗓音即时保存（下次朗读生效，不中断当前会话）
    select.addEventListener("change", () => {
      setVoice(select.value);
      showToast("嗓音已切换");
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const value = input ? input.value : "";
      const voice = select ? select.value : getVoice();
      const keyOk = setApiKey(value);
      const voiceOk = setVoice(voice);
      if (keyOk && voiceOk) {
        showToast("已保存，可以开始聊天啦");
        panel.hidden = true;
        // 通知主流程：会话中重新填入 Key 后自动恢复监听
        if (onKeySaved) onKeySaved();
      } else {
        showToast("保存失败，请检查浏览器隐私设置");
      }
    });
  }
}
