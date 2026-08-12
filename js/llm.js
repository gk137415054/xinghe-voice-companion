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
}
