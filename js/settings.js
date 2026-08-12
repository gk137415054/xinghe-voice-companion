// settings.js
// DeepSeek Key 设置面板 + localStorage 持久化

const STORAGE_KEY = "voiceCompanion.deepseekApiKey";

// 可选的“Key 已保存”回调（由 app.js 注册），用于会话中重填 Key 后自动恢复
let onKeySaved = null;

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

// 打开设置面板（供 app.js 在缺少 Key 时调用）
export function openSettings() {
  const panel = document.getElementById("settingsPanel");
  const input = document.getElementById("apiKeyInput");
  if (panel) {
    if (input) input.value = getApiKey();
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

// 初始化设置面板交互
export function initSettingsPanel() {
  const panel = document.getElementById("settingsPanel");
  const openBtn = document.getElementById("settingsBtn");
  const closeBtn = document.getElementById("closeSettingsBtn");
  const saveBtn = document.getElementById("saveKeyBtn");
  const input = document.getElementById("apiKeyInput");

  if (input) input.value = getApiKey();

  if (openBtn) {
    openBtn.addEventListener("click", () => {
      if (input) input.value = getApiKey();
      panel.hidden = false;
      if (input) input.focus();
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      panel.hidden = true;
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const value = input ? input.value : "";
      if (setApiKey(value)) {
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
