import { CodexAppServer, __test } from "./lib/codex-client.mjs";
import { prepareIsolatedCodexHome } from "./lib/state.mjs";

const server = new CodexAppServer();
try {
  await server.start();
  const models = await server.request("model/list", {
    cursor: null,
    limit: 100,
    includeHidden: true,
  });
  const luna = models.data.find((entry) => entry.model === "gpt-5.6-luna");
  if (!luna) throw new Error("当前 Codex 账号的模型目录中没有 gpt-5.6-luna");
  if (!luna.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === "max")) {
    throw new Error("gpt-5.6-luna 不支持 max 推理强度");
  }

  const paths = prepareIsolatedCodexHome();
  const thread = await server.request("thread/start", {
    model: "gpt-5.6-luna",
    cwd: paths.chatWorkspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: __test.CHAT_INSTRUCTIONS,
    developerInstructions: __test.CHAT_INSTRUCTIONS,
    serviceName: "weixin-codex-smoke",
    ephemeral: true,
    threadSource: "weixin-smoke",
  });
  process.stdout.write(
    `${JSON.stringify({
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
      cwd: thread.cwd,
      approvalPolicy: thread.approvalPolicy,
      sandbox: thread.sandbox?.type,
    })}\n`,
  );
  if (process.env.WEIXIN_CODEX_SMOKE_TURN === "1") {
    const reply = await server.chat("smoke-user", "只回复：微信直连测试通过");
    if (!reply.text.includes("微信直连测试通过")) {
      throw new Error(`Codex 实际回复不符合预期: ${reply.text}`);
    }
    process.stdout.write(`${JSON.stringify({ reply })}\n`);
  }
  if (process.env.WEIXIN_CODEX_SMOKE_IMAGE) {
    const reply = await server.chat(
      "smoke-image-user",
      "请用一句话说明你在这张图片里看到了什么。",
      [process.env.WEIXIN_CODEX_SMOKE_IMAGE],
    );
    if (!reply.text.trim()) throw new Error("Codex 图片识别没有返回文本");
    process.stdout.write(`${JSON.stringify({ imageReply: reply })}\n`);
  }
  if (process.env.WEIXIN_CODEX_SMOKE_GENERATE === "1") {
    const reply = await server.chat(
      "smoke-generate-user",
      "请生成一张极简的绿色圆形图标，纯白背景，不要文字。",
    );
    if (!reply.images.length) throw new Error(`Codex 没有生成图片: ${reply.text}`);
    for (const image of reply.images) {
      if (!image.path.startsWith(`${paths.chatWorkspace}/outbound/`)) {
        throw new Error(`生成图片不在隔离输出目录: ${image.path}`);
      }
    }
    process.stdout.write(`${JSON.stringify({ generated: reply })}\n`);
  }
} finally {
  server.stop();
}
