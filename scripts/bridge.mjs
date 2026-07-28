#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { CodexAppServer } from "./lib/codex-client.mjs";
import { downloadInboundImage, hasInboundImage } from "./lib/weixin-media.mjs";
import {
  extractText,
  getUpdates,
  notifyLifecycle,
  sendImage,
  sendText,
} from "./lib/weixin-api.mjs";
import {
  loadConfig,
  loadCredentials,
  loadCursor,
  loadDeliveryState,
  saveConfig,
  saveCursor,
  saveDeliveryState,
} from "./lib/state.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abortController = new AbortController();
const codex = new CodexAppServer();
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function messageKey(message) {
  return String(
    message.message_id ??
      message.client_id ??
      message.seq ??
      `${message.from_user_id}:${message.create_time_ms}`,
  );
}

function rememberProcessed(delivery, key) {
  delivery.processedMessageIds ||= [];
  delivery.processedMessageIds.push(key);
  if (delivery.processedMessageIds.length > 1000) {
    delivery.processedMessageIds.splice(0, delivery.processedMessageIds.length - 1000);
  }
}

async function commandReply(userId, text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [command, ...args] = trimmed.split(/\s+/);
  if (command === "/help") {
    return [
      "微信直连 Codex 命令：",
      "/status 查看当前模型和会话",
      "/model <模型> 切换模型",
      "/think <强度> 切换推理强度",
      "/new 开始新会话",
      "/help 查看帮助",
    ].join("\n");
  }
  if (command === "/status") {
    const settings = codex.getUserSettings(userId);
    return [
      "微信直连 Codex 正常",
      `模型：${settings.model}`,
      `推理：${settings.effort}`,
      `会话：${settings.threadId ? "已建立" : "尚未建立"}`,
      "运行时：Codex app-server（无 OpenClaw）",
    ].join("\n");
  }
  if (command === "/model") {
    if (!args[0]) {
      return `当前模型：${codex.getUserSettings(userId).model}\n用法：/model gpt-5.6-sol`;
    }
    const model = codex.setUserModel(userId, args[0]);
    return `模型已切换为 ${model}，下一条消息生效。`;
  }
  if (command === "/think") {
    if (!args[0]) {
      return `当前推理强度：${codex.getUserSettings(userId).effort}\n可选：none/minimal/low/medium/high/xhigh/max`;
    }
    const effort = codex.setUserEffort(userId, args[0]);
    return `推理强度已切换为 ${effort}，下一条消息生效。`;
  }
  if (command === "/new" || command === "/reset") {
    await codex.reset(userId);
    return "已开始一个新的 Codex 会话。";
  }
  return "未知命令。发送 /help 查看可用命令。";
}

async function processMessage(message, credentials, config, delivery) {
  if (message.message_type != null && message.message_type !== 1) return;
  const from = message.from_user_id || "";
  if (!from) return;
  if (config.ownerUserId && from !== config.ownerUserId) {
    log(`忽略非 owner 用户消息: ${from.slice(0, 8)}…`);
    return;
  }

  const key = messageKey(message);
  log(`收到微信消息 key=${key} from=${from.slice(0, 8)}…`);
  delivery.pendingReplies ||= {};
  if ((delivery.processedMessageIds || []).includes(key)) return;

  let pending = delivery.pendingReplies[key];
  const contextToken = message.context_token || pending?.contextToken;
  if (!pending) {
    const text = extractText(message);
    try {
      const image = await downloadInboundImage(message, key);
      if (image) log(`微信图片已解密 key=${key} bytes=${image.bytes}`);
      if (!text && !image) {
        pending = {
          result: {
            text: "目前支持文字、图片，以及已带文字转写的语音消息。",
            images: [],
          },
        };
      } else if (text?.startsWith("/") && !image) {
        pending = { result: { text: await commandReply(from, text), images: [] } };
      } else {
        const prompt = text || "用户发送了这张图片。请简要识别并说明图片内容。";
        try {
          pending = { result: await codex.chat(from, prompt, image ? [image.path] : []) };
        } finally {
          if (image?.path) {
            try {
              fs.unlinkSync(image.path);
            } catch {
              // Isolated inbound media cleanup is best effort.
            }
          }
        }
      }
    } catch (error) {
      const label = hasInboundImage(message) ? "图片处理或 Codex 识别失败" : "Codex 暂时无法回复";
      pending = {
        result: { text: `${label}：${error.message || String(error)}`, images: [] },
      };
    }
    pending.contextToken = contextToken;
    pending.to = from;
    pending.textSent = false;
    pending.nextImageIndex = 0;
    delivery.pendingReplies[key] = pending;
    saveDeliveryState(delivery);
  }

  if (pending.reply && !pending.result) {
    pending.result = { text: pending.reply, images: [] };
    delete pending.reply;
  }
  const result = pending.result || { text: "", images: [] };
  const runId = `weixin-codex-${key}`;
  if (!pending.textSent && result.text?.trim()) {
    await sendText({ credentials, to: from, contextToken, text: result.text, runId });
    pending.textSent = true;
    saveDeliveryState(delivery);
  }
  while (pending.nextImageIndex < (result.images || []).length) {
    const image = result.images[pending.nextImageIndex];
    await sendImage({
      credentials,
      to: from,
      contextToken,
      imagePath: image.path,
      runId,
    });
    pending.nextImageIndex += 1;
    try {
      fs.unlinkSync(image.path);
    } catch {
      // Delivery succeeded; stale isolated output cleanup is best effort.
    }
    saveDeliveryState(delivery);
  }
  log(`已发送微信回复 key=${key}`);
  delete delivery.pendingReplies[key];
  rememberProcessed(delivery, key);
  saveDeliveryState(delivery);
}

async function shutdown(credentials) {
  if (shuttingDown) return;
  shuttingDown = true;
  abortController.abort();
  log("正在停止…");
  await notifyLifecycle(credentials, false);
  codex.stop();
}

async function main() {
  const credentials = loadCredentials();
  if (!credentials?.token) {
    throw new Error("尚未登录微信，请先运行 weixin-codex login");
  }
  const config = loadConfig();
  if (!config.ownerUserId && credentials.userId) {
    config.ownerUserId = credentials.userId;
    saveConfig(config);
  }

  process.on("SIGINT", () => void shutdown(credentials));
  process.on("SIGTERM", () => void shutdown(credentials));

  await codex.start();
  await notifyLifecycle(credentials, true);
  log(`桥接已启动，模型=${config.model}，推理=${config.effort}`);

  let cursor = loadCursor();
  let timeoutMs = 35_000;
  let failures = 0;
  while (!abortController.signal.aborted) {
    try {
      const response = await getUpdates({
        credentials,
        cursor,
        timeoutMs,
        signal: abortController.signal,
      });
      if (response.longpolling_timeout_ms > 0) {
        timeoutMs = response.longpolling_timeout_ms;
      }
      const failed =
        (response.ret != null && response.ret !== 0) ||
        (response.errcode != null && response.errcode !== 0);
      if (failed) {
        if (response.ret === -14 || response.errcode === -14) {
          throw new Error("微信登录态已失效，请重新运行 weixin-codex login");
        }
        throw new Error(
          `微信轮询失败: ${response.ret ?? response.errcode} ${response.errmsg || ""}`.trim(),
        );
      }
      failures = 0;
      const delivery = loadDeliveryState();
      for (const message of response.msgs || []) {
        await processMessage(message, credentials, config, delivery);
      }
      if (response.get_updates_buf) {
        cursor = response.get_updates_buf;
        saveCursor(cursor);
      }
    } catch (error) {
      if (abortController.signal.aborted) break;
      failures += 1;
      log(`错误：${error.message || String(error)}`);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
  await shutdown(credentials);
}

main().catch((error) => {
  process.stderr.write(`[weixin-codex] ${error.stack || error}\n`);
  codex.stop();
  process.exitCode = 1;
});
