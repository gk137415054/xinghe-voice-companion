// echo.js
// 回声判定纯函数（无 DOM 依赖，可被 node 直接 import 单测）。
// 用于判断"孩子说的话"是否其实是 AI 自己正在/已经/将要念出的声音（麦克风回声），
// 以避免 AI 在说话中途把自己的回声当成孩子插话而打断自己。

// 最长公共连续子串长度（动态规划，O(n*m)）。
// @param {string} a
// @param {string} b
// @returns {number}
export function longestCommonSubstringLen(a, b) {
  if (!a || !b) return 0;
  let max = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev + 1;
      else dp[j] = 0;
      if (dp[j] > max) max = dp[j];
      prev = tmp;
    }
  }
  return max;
}

// 归一化：去掉所有空白与标点符号（\p{P} 覆盖中英文标点，需 u 标志）。
function normalize(s) {
  return (s || "").replace(/[\s\p{P}]/gu, "");
}

// 回声判定阈值：最长公共子串占较短串的比例超过该值即判为回声。
// 取值 0.30（比原 0.5 更灵敏，因麦克风回声带噪声、匹配度偏低）。
// 注：示例 "我们去公园吧" vs "今天天气真好我们出去玩吧" 实测 LCS=2，
// 占 child 长度 6 的 0.333，须在 0.35 下不命中的情况下仍判为 true，故取 0.30 满足契约。
const ECHO_LCS_THRESHOLD = 0.3;

/**
 * 判定 child 是否为 AI 声音的回声。
 * 判定策略：
 *  1) child 归一化后为空 → 不是有效输入，返回 false；
 *  2) child 归一化串是 aiText 归一化串的"子串" → 命中，返回 true；
 *  3) 否则算最长公共子串比例，lcs / min(childLen, aiLen) 超过阈值 → 命中。
 * 阈值比原 0.5 更灵敏（0.35），因为麦克风回声带有噪声、匹配度会偏低。
 *
 * @param {string} child 孩子（识别到）的话
 * @param {string} aiText AI 已念/正念/整段 的文本（拼接后的回声比对基准）
 * @returns {boolean}
 */
export function isEcho(child, aiText) {
  const c = normalize(child);
  const a = normalize(aiText);
  if (!c) return false; // 空输入不当回声
  if (!a) return false; // 无基准时不误判

  // 子串命中（如孩子复述了 AI 刚说过的半句）
  if (a.includes(c)) return true;

  // 否则用最长公共子串比例判定（对噪声更鲁棒）
  const minLen = Math.min(c.length, a.length);
  if (minLen === 0) return false;
  const lcs = longestCommonSubstringLen(c, a);
  return lcs / minLen > ECHO_LCS_THRESHOLD;
}
