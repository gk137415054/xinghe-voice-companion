# 星河的小姐姐 · 语音聊天 App

一个纯前端、无构建步骤的手机网页版 AI 语音聊天应用，专为 4 岁孩子设计。
只用浏览器原生免费能力 + 最省钱的国产大模型 **DeepSeek**，陪孩子聊天、讲故事、唱儿歌，
人格是温柔耐心的大姐姐，并内置**儿童安全护栏**。

## 功能特性

- **语音聊天闭环**：听写（Web Speech API）→ 大模型（DeepSeek）→ 朗读 自动循环。
- **真人般的自然嗓音**：朗读优先使用**微软 Edge 神经 TTS**（如"晓晓 XiaoxiaoNeural"，温柔女声，像大姐姐），免费、无需任何 Key；任何异常自动回退浏览器原生 SpeechSynthesis。
- **屏幕常亮**：使用 Screen Wake Lock API，聊天时尽量不真正息屏。
- **状态可视化**：纯 CSS/SVG 卡通脸随状态变化（监听=侧耳、思考=眨眼转圈、说话=嘴巴动）。
- **儿童安全护栏**：系统提示词中明确不展开危险/不健康内容、不询问/复述隐私、先安抚情绪、回复简短适合朗读。
- **本地保存 Key**：DeepSeek Key 存于浏览器 localStorage，不写进源码、不上传任何服务器。
- **打断（加分项）**：AI 说话时点击脸，可取消朗读并重新监听（不支持的浏览器自动跳过）。

## 本地运行方式

项目是纯静态站点，无需安装依赖、无需构建。

1. 进入项目目录：
   ```bash
   cd voice-companion
   ```
2. 起一个本地静态服务（任选其一）：
   ```bash
   # Python（推荐，绝大多数系统自带）
   python -m http.server 8000

   # 或 Node
   npx serve .
   ```
3. 浏览器打开 `http://localhost:8000`（**localhost 属于安全上下文，麦克风可用**）。

> 直接双击 `index.html` 用 `file://` 打开通常无法使用麦克风，请务必通过 http(s) 服务访问。

## 部署到手机访问（静态托管）

麦克风需要在**安全上下文**下才能使用：**必须是 https，或 localhost**。
局域网用 `http://192.168.x.x:8000` 这种 IP 地址是**不安全上下文，安卓 Chrome 会拒绝麦克风**，请勿这样用。

推荐免费 https 静态托管（都支持自定义域名或默认 https 子域）：

- **GitHub Pages**：把整个 `voice-companion` 目录推到仓库，开启 Pages 即可获得 `https://<用户名>.github.io/...`。
- **Vercel**：`vercel` 导入仓库或拖拽目录，自动分配 `https://xxx.vercel.app`。
- **Netlify**：`netlify deploy` 或拖拽目录，自动分配 `https://xxx.netlify.app`。

部署后在**安卓 Chrome** 打开对应的 https 地址即可让孩子用。

## 如何填入 DeepSeek Key

1. 打开 https://platform.deepseek.com 注册并创建 API Key。
2. 在应用内点击右下角「设置」，把 Key 粘贴进输入框，点「保存」。
3. Key 仅保存在本机浏览器（localStorage），不会出现在源码或网络请求之外的地方。

> 注意：浏览器会**直接**用该 Key 调用 `https://api.deepseek.com`，请勿在公共/他人设备上保存 Key。

## 浏览器兼容说明

| 能力 | 推荐 | 说明 |
| --- | --- | --- |
| 语音听写 STT | 安卓 Chrome / Edge | 使用 `webkitSpeechRecognition`，需联网、需麦克风权限 |
| 语音朗读 TTS | Chrome / Edge（推荐安卓 Chrome） | 优先 **Edge 神经 TTS**（在线，最自然）；失败自动回退 `SpeechSynthesis` |
| 屏幕常亮 | Chrome / Edge 较新版本 | `Wake Lock API`，不支持时自动跳过，不影响聊天 |

- **强烈建议用最新版安卓 Chrome** 体验最佳（也是目标平台）。
- 若浏览器不支持听写或朗读，页面会给出清晰中文提示，不会崩溃。
- iOS Safari 对 `webkitSpeechRecognition` 支持不稳定，可能无法听写。

## 成本估算

DeepSeek `deepseek-chat` 非常便宜（约 ¥1/百万输入 token、¥2/百万输出 token 量级，以官网为准）。
孩子一次对话通常只有几十~两百 token，按每天聊几十次估算，月成本通常只有**几分钱到几毛钱**，
几乎可忽略。本应用单次 `max_tokens` 限制为 200，进一步控制开销。

## 儿童安全说明

- 系统提示词内置护栏：**不展开危险/暴力/成人内容，不主动询问或复述真实姓名、住址、幼儿园、电话等隐私**，
  孩子不开心先安抚，回复简短口语化、适合朗读。
- 但这只是软件层约束，**不能替代家长看护**。建议家长陪同使用，并留意：
  - 不要让孩子透露真实隐私信息；
  - 遇到身体不适等表述，引导询问家长/医生；
  - 定期检查并妥善保管设备上的 DeepSeek Key。

## 朗读嗓音（微软 Edge 神经 TTS）

为让声音自然、像真人，朗读环节默认走微软在线神经语音（无需 Key、免费）：

- 在应用「设置」里可选择嗓音：`晓晓`（温柔女声·默认）、`云希`（阳光男声）、`晓伊`（甜美女声）、`云扬`（沉稳男声）。
- 需要联网；首次连接会有一个很短的握手延迟。
- **若网络或微软接口异常，会自动回退到手机自带嗓音（SpeechSynthesis）**，聊天不中断，只是声音会偏"机器"一些。
- 该接口为微软公共服务，儿童使用建议在家长陪同下、网络环境正常时进行。

## 文件结构

```
voice-companion/
├── index.html          # 页面结构
├── css/
│   └── styles.css      # 温暖配色、动画、移动端布局
├── js/
│   ├── persona.js      # 人格设定 + 系统提示词 + 儿童护栏常量
│   ├── speech.js       # STT 与 TTS 封装（优先 Edge 神经 TTS，含降级回退）
│   ├── edgeTts.js      # 微软 Edge 神经 TTS 客户端（WebSocket）
│   ├── llm.js          # DeepSeek API 客户端
│   ├── settings.js     # Key / 嗓音设置面板 + localStorage
│   └── app.js          # 主流程：状态机、自动循环、UI 联动
└── README.md
```
