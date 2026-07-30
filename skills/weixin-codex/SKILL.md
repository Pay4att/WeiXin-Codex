---
name: weixin-codex
description: Install, log in, run, stop, inspect, or configure the standalone Weixin-to-Codex bridge. Use when the user asks to connect Weixin/WeChat directly to Codex without OpenClaw, scan a Weixin QR code, check bridge status/logs, or change its default model or reasoning effort.
---

# Weixin Codex

This plugin controls a standalone local bridge. It reuses Tencent's public
Weixin iLink HTTP protocol and connects directly to `codex app-server`.
Never install, invoke, configure, or recommend OpenClaw for this workflow.

Resolve the plugin root as the directory two levels above this `SKILL.md`.
Run the CLI with:

```bash
node <plugin-root>/scripts/weixin-codex.mjs <command>
```

## Workflow

1. For first-time setup, run `npm install` in the plugin root, then run
   `doctor`.
2. If Codex is not logged in, ask the user to complete `codex login`.
3. Run `login` in an interactive terminal for Weixin QR scanning. Do not print
   or expose saved tokens.
4. Run `start`, then `status`.
5. For model changes, run `model <model> [effort]`. The default is
   `gpt-5.6-luna max`.
6. Use `logs` for diagnostics and `restart` after configuration changes when
   needed.
7. Image understanding and image generation are supported. Users can request
   an image naturally in Weixin; generated output is encrypted, uploaded to
   the Weixin CDN, and sent as an image item.
8. Normal requests show the native Weixin typing indicator immediately.
   Image-generation requests also receive an immediate progress message before
   generation begins. Native same-bubble token streaming is not available in
   the current public iLink implementation.

The Weixin chat itself supports `/model`, `/think`, `/new`, `/status`, and
`/help`. Runtime data lives under `~/.weixin-codex/` unless
`WEIXIN_CODEX_STATE_DIR` is set.

Do not read or display `credentials.json`, Codex `auth.json`, or message cursor
contents. It is safe to report whether those files exist.

The runtime is intentionally chat-only. Never weaken or remove the outer macOS
sandbox, isolated environment, host-file allowlist, `approvalPolicy: never`, or
disabled tool configuration. Image generation is the only enabled Codex tool.
