// llm.js
// DeepSeek API 客户端（浏览器直连，Key 来自 localStorage，不在源码硬编码）

const DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-chat";

export class DeepSeekClient {
  constructor(endpoint = DEFAULT_ENDPOINT, model = DEFAULT_MODEL) {
    this.endpoint = endpoint;
    this.model = model;
  }

  /**
   * 调用 DeepSeek 对话接口
   * @param {Array<{role:string, content:string}>} messages 对话消息
   * @param {string} apiKey 用户的 DeepSeek API Key
   * @returns {Promise<string>} 助手回复文本
   */
  async chat(messages, apiKey) {
    if (!apiKey) throw new Error("MISSING_API_KEY");

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.9,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`DeepSeek API ${response.status}: ${detail}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return (content || "").trim();
  }

  /**
   * 流式对话：一边生成一边按"句"回调，显著降低首字延迟。
   * @param {Array<{role:string, content:string}>} messages 对话消息
   * @param {string} apiKey 用户的 DeepSeek API Key
   * @param {Object} handlers
   *   onSentence(text) 每成型一句回调（按句末标点 / 最大句长切分）
   *   onDone(fullText) 整段生成完成
   *   onError(err)     出错（非主动中断）
   *   signal           AbortSignal，用于打断时中止后台流
   */
  async streamChat(messages, apiKey, handlers = {}) {
    if (!apiKey) throw new Error("MISSING_API_KEY");

    const onSentence = handlers.onSentence || (() => {});
    const onDone = handlers.onDone || (() => {});
    const onError = handlers.onError || (() => {});

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.9,
        max_tokens: 200,
        stream: true,
      }),
      signal: handlers.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`DeepSeek API ${response.status}: ${detail}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let acc = ""; // 已生成完整文本
    let processedLen = 0; // 已切分出的长度

    // 从 processedLen 之后切出一句（遇到句末标点，或超长强制切分）
    const flushSentence = (force) => {
      if (processedLen >= acc.length) return;
      let end = -1;
      for (let i = processedLen; i < acc.length; i++) {
        const ch = acc[i];
        if (ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?" || ch === "\n") {
          end = i;
          break;
        }
      }
      // 超长保护：距上次切分超过阈值仍无句末，找最近标点或强制切
      if (end < 0 && acc.length - processedLen >= MAX_SENTENCE_LEN) {
        let cut = processedLen + MAX_SENTENCE_LEN;
        for (let i = processedLen; i < cut; i++) {
          const ch = acc[i];
          if (ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?" || ch === "\n") {
            cut = i;
            break;
          }
        }
        end = cut - 1;
      }
      if (force && end < 0 && acc.length > processedLen) end = acc.length - 1;
      if (end >= processedLen) {
        const sentence = acc.slice(processedLen, end + 1).trim();
        processedLen = end + 1;
        if (sentence) onSentence(sentence);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content || "";
            if (delta) {
              acc += delta;
              flushSentence(false);
            }
          } catch (e) {
            /* 单行解析失败忽略 */
          }
        }
      }
      flushSentence(true);
      onDone(acc.trim());
    } catch (e) {
      if (handlers.signal && handlers.signal.aborted) return; // 主动中断，非错误
      onError(e);
    }
  }
}

// 流式分句：单句最大长度保护（字符），避免一句话太长迟迟不朗读
const MAX_SENTENCE_LEN = 48;
