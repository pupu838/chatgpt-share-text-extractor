# ChatGPT 分享对话提取器 · ChatGPT Share Text Extractor

在线体验 / Live demo: **[打开提取工具](https://chatgpt-share-text-extractor-global-zknlm0mo.edgeone.dev/)**

一个轻量的中英双语工具：粘贴公开的 ChatGPT 分享链接，提取干净的用户输入与 ChatGPT 最终回答，并支持复制和下载 `.txt`。

A lightweight bilingual tool that extracts only user messages and final ChatGPT answers from public ChatGPT share links, with copy and `.txt` download support.

## 功能 · Features

- 支持 `https://chatgpt.com/share/...`
- 兼容旧版 `https://chat.openai.com/share/...`
- 纯文字展示
- 一键复制
- 下载 TXT
- 自动过滤工具调用、插件占位、搜索提示和思考时间
- 清晰区分：链接无效、分享失效、非公开、限流、网络错误、解析失败等情况
- 服务端严格限制目标域名，避免成为 SSRF / 任意 URL 代理
- 不需要 OpenAI API Key、ChatGPT Cookie 或登录凭据

## 本地运行 · Local setup

要求 Node.js 20+。

```bash
npm install
npm start
```

然后打开：

```text
http://localhost:3000
```

## 部署 · Deployment

这是一个普通 Node/Express 项目，可部署到 Railway、Render、Fly.io、VPS、Docker 等支持长驻 Node 进程的平台。

最基本的启动命令：

```bash
npm install && npm start
```

环境变量（可选）：

```text
PORT=3000
```

## 工作方式 · How it works

浏览器前端不会直接请求 ChatGPT 分享页，而是请求本站 `/api/extract`。服务端使用 `chatgpt-share-parser` 解析公开分享页。现代 ChatGPT 分享页可能把对话放在 React Server Components / Flight 数据中，而不是简单可读的 HTML，因此这种方式比 DOM 正则抓取更稳健。

The browser calls this site's `/api/extract` endpoint. The server uses `chatgpt-share-parser` to read public share data, including conversations embedded in React Server Components / Flight payloads.

## 限制和失败场景 · Limitations

这个项目只处理“已经公开分享”的链接，不尝试绕过身份验证或读取私人 `/c/...` 对话。

可能失败的情况包括：

- 分享链接已经被创建者删除或关闭
- 链接属于只能由特定工作区成员访问的内容
- ChatGPT 对服务器请求进行限流或反自动化拦截
- OpenAI 改变分享页内部数据结构，第三方解析库尚未更新
- 部署环境无法正常访问 `chatgpt.com`

遇到上述情况，网页会给出错误提示。必要时可直接打开原分享链接并手动复制内容。

## 隐私 · Privacy

默认代码不保存提取结果，也不要求用户登录。需要公开部署时，你可以自行添加访问控制、持久化、审计日志和更严格的限流。

The default implementation does not store extracted content and does not require login. Add access control, persistence, audit logging, and stricter rate limiting if needed.

## License

MIT
