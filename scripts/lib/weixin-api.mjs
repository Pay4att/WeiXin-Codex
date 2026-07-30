import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline/promises";
import process from "node:process";
import qrcode from "qrcode-terminal";

const API_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const PROTOCOL_VERSION = "2.4.6";
const APP_ID = "bot";
const APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const BOT_TYPE = "3";

function baseInfo() {
  return {
    channel_version: PROTOCOL_VERSION,
    bot_agent: "WeixinCodex/0.1.0",
  };
}

function commonHeaders() {
  return {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": String(APP_CLIENT_VERSION),
  };
}

function authenticatedHeaders(token) {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uint32), "utf8").toString("base64"),
    ...commonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function endpointUrl(baseUrl, endpoint) {
  return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

async function requestText(url, options, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`微信接口 ${response.status}: ${text.slice(0, 500)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

async function postJson({
  baseUrl,
  endpoint,
  token,
  body,
  timeoutMs = 15_000,
  signal,
}) {
  const text = await requestText(
    endpointUrl(baseUrl, endpoint),
    {
      method: "POST",
      headers: authenticatedHeaders(token),
      body: JSON.stringify(body),
    },
    timeoutMs,
    signal,
  );
  return JSON.parse(text);
}

async function getJson({ baseUrl, endpoint, timeoutMs = 35_000 }) {
  const text = await requestText(
    endpointUrl(baseUrl, endpoint),
    { method: "GET", headers: commonHeaders() },
    timeoutMs,
  );
  return JSON.parse(text);
}

export async function loginWithQr(existingToken) {
  let qrRefreshes = 0;
  while (qrRefreshes < 3) {
    const qr = await postJson({
      baseUrl: API_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      body: { local_token_list: existingToken ? [existingToken] : [] },
    });
    if (!qr.qrcode || !qr.qrcode_img_content) {
      throw new Error("微信登录接口未返回二维码");
    }

    process.stdout.write("\n请用手机微信扫描二维码并确认：\n\n");
    qrcode.generate(qr.qrcode_img_content, { small: true });
    process.stdout.write(`\n备用链接：${qr.qrcode_img_content}\n\n`);

    let pollingBaseUrl = API_BASE_URL;
    let verifyCode;
    const deadline = Date.now() + 8 * 60_000;
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (Date.now() < deadline) {
        let status;
        try {
          let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`;
          if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
          status = await getJson({ baseUrl: pollingBaseUrl, endpoint });
        } catch (error) {
          if (error?.name === "AbortError") continue;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (status.status === "wait") continue;
        if (status.status === "scaned") {
          process.stdout.write("已扫描，请在手机上确认。\n");
          verifyCode = undefined;
          continue;
        }
        if (status.status === "need_verifycode") {
          verifyCode = (await input.question("请输入手机微信显示的数字：")).trim();
          continue;
        }
        if (status.status === "verify_code_blocked") {
          process.stdout.write("验证码错误次数过多，正在刷新二维码。\n");
          break;
        }
        if (status.status === "scaned_but_redirect" && status.redirect_host) {
          pollingBaseUrl = `https://${status.redirect_host}`;
          continue;
        }
        if (status.status === "binded_redirect") {
          if (existingToken) {
            return { alreadyConnected: true };
          }
          throw new Error("该微信已绑定，但本地没有可复用的登录凭据");
        }
        if (status.status === "expired") break;
        if (status.status === "confirmed") {
          if (!status.bot_token || !status.ilink_bot_id) {
            throw new Error("微信确认成功，但登录响应缺少 bot token 或 bot id");
          }
          return {
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl || pollingBaseUrl,
            userId: status.ilink_user_id || null,
            savedAt: new Date().toISOString(),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      input.close();
    }
    qrRefreshes += 1;
  }
  throw new Error("二维码多次失效，请稍后重新运行登录");
}

export async function getUpdates({ credentials, cursor, timeoutMs = 35_000, signal }) {
  try {
    return await postJson({
      baseUrl: credentials.baseUrl || API_BASE_URL,
      endpoint: "ilink/bot/getupdates",
      token: credentials.token,
      body: { get_updates_buf: cursor || "", base_info: baseInfo() },
      timeoutMs: timeoutMs + 1000,
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: cursor || "" };
    }
    throw error;
  }
}

function splitText(text, maxLength = 4000) {
  const chunks = [];
  let remaining = String(text || "").trim();
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength / 2) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength / 2) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ["（Codex 没有返回文本）"];
}

export async function sendText({ credentials, to, contextToken, text, runId }) {
  for (const chunk of splitText(text)) {
    const clientId = `weixin-codex-${crypto.randomUUID()}`;
    const response = await postJson({
      baseUrl: credentials.baseUrl || API_BASE_URL,
      endpoint: "ilink/bot/sendmessage",
      token: credentials.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: chunk } }],
          context_token: contextToken || undefined,
          run_id: runId || undefined,
        },
        base_info: baseInfo(),
      },
    });
    if (response.ret && response.ret !== 0) {
      throw new Error(`微信发消息失败: ${response.ret} ${response.errmsg || ""}`.trim());
    }
  }
}

async function sendTypingStatus({ credentials, to, typingTicket, status }) {
  const response = await postJson({
    baseUrl: credentials.baseUrl || API_BASE_URL,
    endpoint: "ilink/bot/sendtyping",
    token: credentials.token,
    body: {
      ilink_user_id: to,
      typing_ticket: typingTicket,
      status,
      base_info: baseInfo(),
    },
    timeoutMs: 10_000,
  });
  if (response.ret && response.ret !== 0) {
    throw new Error(`微信输入状态发送失败: ${response.ret} ${response.errmsg || ""}`.trim());
  }
}

export async function startTyping({
  credentials,
  to,
  contextToken,
  keepaliveMs = 5_000,
}) {
  let timer;
  let stopped = false;
  try {
    const config = await postJson({
      baseUrl: credentials.baseUrl || API_BASE_URL,
      endpoint: "ilink/bot/getconfig",
      token: credentials.token,
      body: {
        ilink_user_id: to,
        context_token: contextToken || undefined,
        base_info: baseInfo(),
      },
      timeoutMs: 10_000,
    });
    if ((config.ret && config.ret !== 0) || !config.typing_ticket) {
      return { supported: false, stop: async () => {} };
    }
    const pulse = (status) =>
      sendTypingStatus({
        credentials,
        to,
        typingTicket: config.typing_ticket,
        status,
      });
    await pulse(1);
    timer = setInterval(() => {
      if (!stopped) void pulse(1).catch(() => {});
    }, keepaliveMs);
    timer.unref?.();
    return {
      supported: true,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        await pulse(2).catch(() => {});
      },
    };
  } catch {
    if (timer) clearInterval(timer);
    return { supported: false, stop: async () => {} };
  }
}

function aesEcbPaddedSize(size) {
  return (Math.floor(size / 16) + 1) * 16;
}

function encryptAesEcb(buffer, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

async function uploadImage({ credentials, to, imagePath }) {
  const plaintext = fs.readFileSync(imagePath);
  if (!plaintext.length || plaintext.length > 25 * 1024 * 1024) {
    throw new Error("待发送图片为空或超过 25 MB");
  }
  const rawsize = plaintext.length;
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const upload = await postJson({
    baseUrl: credentials.baseUrl || API_BASE_URL,
    endpoint: "ilink/bot/getuploadurl",
    token: credentials.token,
    body: {
      filekey,
      media_type: 1,
      to_user_id: to,
      rawsize,
      rawfilemd5: crypto.createHash("md5").update(plaintext).digest("hex"),
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: baseInfo(),
    },
  });
  if ((upload.ret != null && upload.ret !== 0) || (!upload.upload_full_url && !upload.upload_param)) {
    throw new Error(
      `微信获取图片上传地址失败: ${upload.ret ?? ""} ${upload.errmsg || ""}`.trim(),
    );
  }
  const uploadUrl = upload.upload_full_url
    ? new URL(upload.upload_full_url)
    : new URL(
        `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(
          upload.upload_param,
        )}&filekey=${encodeURIComponent(filekey)}`,
      );
  if (uploadUrl.protocol !== "https:" && uploadUrl.hostname !== "127.0.0.1") {
    throw new Error("微信图片上传地址必须使用 HTTPS");
  }
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
  });
  if (!response.ok) {
    throw new Error(`微信 CDN 图片上传失败: HTTP ${response.status}`);
  }
  const encryptedQueryParam = response.headers.get("x-encrypted-param");
  if (!encryptedQueryParam) throw new Error("微信 CDN 未返回图片下载参数");
  return {
    encryptedQueryParam,
    aeskeyHex: aeskey.toString("hex"),
    ciphertextSize: ciphertext.length,
  };
}

export async function sendImage({
  credentials,
  to,
  contextToken,
  imagePath,
  runId,
}) {
  const uploaded = await uploadImage({ credentials, to, imagePath });
  const response = await postJson({
    baseUrl: credentials.baseUrl || API_BASE_URL,
    endpoint: "ilink/bot/sendmessage",
    token: credentials.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `weixin-codex-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: uploaded.encryptedQueryParam,
                aes_key: Buffer.from(uploaded.aeskeyHex).toString("base64"),
                encrypt_type: 1,
              },
              mid_size: uploaded.ciphertextSize,
            },
          },
        ],
        context_token: contextToken || undefined,
        run_id: runId || undefined,
      },
      base_info: baseInfo(),
    },
  });
  if (response.ret && response.ret !== 0) {
    throw new Error(`微信发图片失败: ${response.ret} ${response.errmsg || ""}`.trim());
  }
}

export async function notifyLifecycle(credentials, started) {
  try {
    return await postJson({
      baseUrl: credentials.baseUrl || API_BASE_URL,
      endpoint: started ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop",
      token: credentials.token,
      body: { base_info: baseInfo() },
      timeoutMs: 10_000,
    });
  } catch {
    return null;
  }
}

export function extractText(message) {
  for (const item of message.item_list || []) {
    if (item.type === 1 && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const reference = item.ref_msg;
      if (!reference) return text;
      const quoted = reference.title || reference.message_item?.text_item?.text;
      return quoted ? `[引用: ${quoted}]\n${text}` : text;
    }
    if (item.type === 3 && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

export const __test = {
  APP_CLIENT_VERSION,
  authenticatedHeaders,
  aesEcbPaddedSize,
  baseInfo,
  encryptAesEcb,
  splitText,
};
