import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureStateLayout } from "./state.mjs";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function imageMediaItem(message) {
  const items = message.item_list || [];
  const direct = items.find(
    (item) =>
      item.type === 2 &&
      (item.image_item?.media?.encrypt_query_param || item.image_item?.media?.full_url),
  );
  if (direct) return direct;
  return items.find(
    (item) =>
      item.type === 1 &&
      item.ref_msg?.message_item?.type === 2 &&
      (item.ref_msg.message_item.image_item?.media?.encrypt_query_param ||
        item.ref_msg.message_item.image_item?.media?.full_url),
  )?.ref_msg?.message_item;
}

function parseAesKey(image) {
  if (image.aeskey) {
    const key = Buffer.from(image.aeskey, "hex");
    if (key.length === 16) return key;
  }
  const encoded = image.media?.aes_key;
  if (!encoded) return null;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`微信图片 AES key 长度无效：${decoded.length}`);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function detectImage(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { extension: ".jpg", mime: "image/jpeg" };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { extension: ".png", mime: "image/png" };
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: ".webp", mime: "image/webp" };
  }
  if (buffer.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return { extension: ".gif", mime: "image/gif" };
  }
  return { extension: ".img", mime: "application/octet-stream" };
}

function downloadUrl(media) {
  if (media.full_url) {
    const url = new URL(media.full_url);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
      throw new Error("微信图片下载地址必须使用 HTTPS");
    }
    return url;
  }
  return new URL(
    `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(
      media.encrypt_query_param || "",
    )}`,
  );
}

async function downloadBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`微信图片下载失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error("微信图片超过 25 MB 限制");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("微信图片超过 25 MB 限制");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadInboundImage(message, key) {
  const item = imageMediaItem(message);
  if (!item) return null;
  const image = item.image_item;
  const encrypted = await downloadBuffer(downloadUrl(image.media));
  const aesKey = parseAesKey(image);
  const plaintext = aesKey ? decryptAesEcb(encrypted, aesKey) : encrypted;
  const kind = detectImage(plaintext);

  const paths = ensureStateLayout();
  const inboundDir = path.join(paths.chatWorkspace, "inbound");
  fs.mkdirSync(inboundDir, { recursive: true, mode: 0o700 });
  const safeKey = String(key).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  const filePath = path.join(inboundDir, `${safeKey}-${crypto.randomUUID()}${kind.extension}`);
  fs.writeFileSync(filePath, plaintext, { mode: 0o600 });
  return { path: filePath, mime: kind.mime, bytes: plaintext.length };
}

export function hasInboundImage(message) {
  return Boolean(imageMediaItem(message));
}

export const __test = { detectImage, decryptAesEcb, imageMediaItem, parseAesKey };
