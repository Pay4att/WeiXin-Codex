import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { writeMacSandboxProfile } from "../scripts/lib/codex-client.mjs";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  loadConfig,
  normalizeEffort,
  normalizeModel,
  saveConfig,
  ensureStateLayout,
} from "../scripts/lib/state.mjs";
import { __test, extractText, sendImage } from "../scripts/lib/weixin-api.mjs";
import { downloadInboundImage } from "../scripts/lib/weixin-media.mjs";

test("default configuration is Luna with max reasoning", () => {
  const original = process.env.WEIXIN_CODEX_STATE_DIR;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-test-"));
  process.env.WEIXIN_CODEX_STATE_DIR = temporary;
  try {
    const config = loadConfig();
    assert.equal(config.model, DEFAULT_MODEL);
    assert.equal(config.effort, DEFAULT_EFFORT);
    saveConfig({ ...config, model: "gpt-5.6-sol", effort: "high" });
    assert.equal(loadConfig().model, "gpt-5.6-sol");
    assert.equal(fs.statSync(path.join(temporary, "config.json")).mode & 0o777, 0o600);
  } finally {
    if (original === undefined) delete process.env.WEIXIN_CODEX_STATE_DIR;
    else process.env.WEIXIN_CODEX_STATE_DIR = original;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("model and effort normalization", () => {
  assert.equal(normalizeModel("openai/gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(normalizeEffort("MAX"), "max");
  assert.throws(() => normalizeEffort("extreme"), /无效推理强度/);
});

test("Weixin protocol headers and base info match the public iLink contract", () => {
  const headers = __test.authenticatedHeaders("secret-token");
  assert.equal(headers.AuthorizationType, "ilink_bot_token");
  assert.equal(headers.Authorization, "Bearer secret-token");
  assert.equal(headers["iLink-App-Id"], "bot");
  assert.equal(headers["iLink-App-ClientVersion"], String(__test.APP_CLIENT_VERSION));
  assert.match(headers["X-WECHAT-UIN"], /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(__test.baseInfo(), {
    channel_version: "2.4.6",
    bot_agent: "WeixinCodex/0.1.0",
  });
});

test("Weixin text extraction supports text, references, and voice transcript", () => {
  assert.equal(
    extractText({ item_list: [{ type: 1, text_item: { text: "你好" } }] }),
    "你好",
  );
  assert.equal(
    extractText({
      item_list: [
        {
          type: 1,
          text_item: { text: "继续" },
          ref_msg: { title: "上一条" },
        },
      ],
    }),
    "[引用: 上一条]\n继续",
  );
  assert.equal(
    extractText({ item_list: [{ type: 3, voice_item: { text: "语音转写" } }] }),
    "语音转写",
  );
});

test("long replies are split at Weixin's 4000-character boundary", () => {
  const chunks = __test.splitText(`${"a".repeat(3000)}\n${"b".repeat(3000)}`);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  assert.equal(chunks.join("").length, 6000);
});

test("encrypted Weixin images are downloaded and decrypted into the chat workspace", async () => {
  const original = process.env.WEIXIN_CODEX_STATE_DIR;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-image-test-"));
  process.env.WEIXIN_CODEX_STATE_DIR = temporary;
  const plaintext = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("standalone-weixin-image"),
  ]);
  const key = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": encrypted.length,
    });
    response.end(encrypted);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const media = await downloadInboundImage(
      {
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                full_url: `http://127.0.0.1:${address.port}/image`,
                aes_key: key.toString("base64"),
              },
            },
          },
        ],
      },
      "message-1",
    );
    assert.equal(media.mime, "image/jpeg");
    assert.deepEqual(fs.readFileSync(media.path), plaintext);
    assert.ok(media.path.startsWith(path.join(temporary, "chat", "inbound")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (original === undefined) delete process.env.WEIXIN_CODEX_STATE_DIR;
    else process.env.WEIXIN_CODEX_STATE_DIR = original;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("outbound images use getuploadurl, encrypted CDN upload, and type=2 message", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-upload-test-"));
  const imagePath = path.join(temporary, "generated.png");
  const plaintext = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("generated-image"),
  ]);
  fs.writeFileSync(imagePath, plaintext);
  const requests = [];
  let ciphertext;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/upload") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      ciphertext = Buffer.concat(chunks);
      response.writeHead(200, { "x-encrypted-param": "download-token" });
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ url: request.url, body });
    if (request.url === "/ilink/bot/getuploadurl") {
      const address = server.address();
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ upload_full_url: `http://127.0.0.1:${address.port}/upload` }),
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ret: 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await sendImage({
      credentials: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "test-token",
      },
      to: "owner",
      contextToken: "context",
      imagePath,
      runId: "run-1",
    });
    const uploadRequest = requests.find((entry) => entry.url === "/ilink/bot/getuploadurl");
    assert.equal(uploadRequest.body.media_type, 1);
    assert.equal(uploadRequest.body.rawsize, plaintext.length);
    assert.equal(
      uploadRequest.body.rawfilemd5,
      crypto.createHash("md5").update(plaintext).digest("hex"),
    );
    assert.equal(uploadRequest.body.filesize, __test.aesEcbPaddedSize(plaintext.length));
    const key = Buffer.from(uploadRequest.body.aeskey, "hex");
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), plaintext);

    const sendRequest = requests.find((entry) => entry.url === "/ilink/bot/sendmessage");
    const item = sendRequest.body.msg.item_list[0];
    assert.equal(item.type, 2);
    assert.equal(item.image_item.media.encrypt_query_param, "download-token");
    assert.equal(
      Buffer.from(item.image_item.media.aes_key, "base64").toString("ascii"),
      uploadRequest.body.aeskey,
    );
    assert.equal(item.image_item.mid_size, ciphertext.length);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test(
  "macOS outer sandbox denies host files and permits only the isolated state",
  { skip: process.platform !== "darwin" },
  () => {
    const original = process.env.WEIXIN_CODEX_STATE_DIR;
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-sandbox-state-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-sandbox-host-"));
    process.env.WEIXIN_CODEX_STATE_DIR = isolated;
    try {
      const paths = ensureStateLayout();
      const allowed = path.join(paths.chatWorkspace, "allowed.txt");
      const denied = path.join(outside, "private.txt");
      fs.writeFileSync(allowed, "isolated");
      fs.writeFileSync(denied, "host-private");
      const profile = writeMacSandboxProfile(paths);
      const allowedRead = spawnSync("/usr/bin/sandbox-exec", [
        "-f",
        profile,
        "/bin/cat",
        allowed,
      ]);
      const deniedRead = spawnSync("/usr/bin/sandbox-exec", [
        "-f",
        profile,
        "/bin/cat",
        denied,
      ]);
      assert.equal(allowedRead.status, 0);
      assert.equal(allowedRead.stdout.toString(), "isolated");
      assert.notEqual(deniedRead.status, 0);
      assert.match(deniedRead.stderr.toString(), /Operation not permitted/);
    } finally {
      if (original === undefined) delete process.env.WEIXIN_CODEX_STATE_DIR;
      else process.env.WEIXIN_CODEX_STATE_DIR = original;
      fs.rmSync(isolated, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);
