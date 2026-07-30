# 微信直连 Codex

这是一个本地常驻桥接器：微信消息通过腾讯 iLink HTTP 接口进入，随后直接发送给
本机 `codex app-server`，回复再由 iLink 接口发回微信。它不安装、不启动也不依赖
OpenClaw。

## 特性

- 微信扫码登录，凭据只保存在本机并以 `0600` 权限写入
- 支持微信图片下载、AES 解密和 Codex 视觉识别
- 支持 Codex 图片生成，经微信 CDN 加密上传后直接回传图片
- 标准图片事件缺失时会从本轮隔离输出目录自动补获生成文件
- 收到请求立即显示微信“正在输入”，图片生成会先发送进度提示
- 每个微信用户对应一个持久 Codex thread
- 独立空白聊天目录，不读取任何项目
- macOS 系统沙箱 + Codex 只读沙箱，默认纯聊天指令
- 默认 `gpt-5.6-luna`，推理强度 `max`
- 微信内支持 `/model`、`/think`、`/new`、`/status`、`/help`

## 使用

```bash
npm install
npm link
weixin-codex login
weixin-codex start
weixin-codex status
```

修改默认模型：

```bash
weixin-codex model gpt-5.6-sol high
```

微信中临时或持久切换：

```text
/model gpt-5.6-terra
/think max
```

直接在微信中发送“生成一张……”即可收到生成图片。

## 回复进度与流式输出

腾讯 iLink 接口支持 `getconfig` + `sendtyping` 输入状态，因此普通请求会立即显示
“正在输入”，并每 5 秒续期；图片生成还会立即回复“正在生成图片…”，完成后再发送
图片。

Codex 上游本身提供文本增量事件，但腾讯当前公开微信通道把普通文本消息作为
`message_state=FINISH` 发送，并明确关闭文本块流式投递。当前没有可靠的同一微信
气泡逐字更新接口，因此本插件不发送可能重复或乱序的伪流式消息。

状态默认保存在 `~/.weixin-codex/`。可通过 `WEIXIN_CODEX_STATE_DIR` 改到其他位置。

## 安全边界

首次扫码的微信用户会被记录为 owner，其他用户的消息不会交给 Codex。桥接器使用
独立 `CODEX_HOME`，把登录凭据复制到权限为 `0600` 的隔离区，不加载你的 Codex
插件、技能或项目配置，也不把真实环境变量传给模型进程。

在 macOS 上，Codex 子进程还运行在独立的系统级 Seatbelt 沙箱中：只允许读写
`~/.weixin-codex/`，读取必要的系统运行库，并为调用 ChatGPT 保留出站网络。
真实用户目录、项目、剪贴板、应用和浏览器均不在白名单中。Codex 内部同时使用
`read-only`、`approvalPolicy: never`，关闭终端、文件修改、网页、浏览器、插件、
技能、MCP、环境和多智能体功能；唯一开放的工具是图片生成。

收到的图片和生成后待发送的图片只暂存在隔离聊天目录，处理或发送完成后会清理。
