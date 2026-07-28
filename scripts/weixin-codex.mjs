#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loginWithQr } from "./lib/weixin-api.mjs";
import {
  ensureStateLayout,
  loadConfig,
  loadCredentials,
  normalizeEffort,
  normalizeModel,
  prepareIsolatedCodexHome,
  saveConfig,
  saveCredentials,
} from "./lib/state.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bridgeScript = path.join(scriptDir, "bridge.mjs");

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(paths) {
  try {
    return Number.parseInt(fs.readFileSync(paths.pid, "utf8").trim(), 10);
  } catch {
    return NaN;
  }
}

function requireNode22() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) throw new Error(`需要 Node.js 22+，当前为 ${process.version}`);
}

function codexStatus() {
  const result = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  return {
    available: result.error?.code !== "ENOENT",
    loggedIn: result.status === 0,
    detail: (result.stdout || result.stderr || "").trim(),
  };
}

async function login() {
  requireNode22();
  const existing = loadCredentials();
  const result = await loginWithQr(existing?.token);
  if (result.alreadyConnected) {
    process.stdout.write("该微信已连接，本地凭据继续有效。\n");
    return;
  }
  saveCredentials(result);
  const config = loadConfig();
  if (result.userId) config.ownerUserId = result.userId;
  saveConfig(config);
  process.stdout.write(`微信连接成功，账号：${result.accountId}\n`);
}

function start() {
  requireNode22();
  const paths = ensureStateLayout();
  if (!loadCredentials()?.token) throw new Error("尚未登录微信，请先运行 weixin-codex login");
  prepareIsolatedCodexHome();
  const oldPid = readPid(paths);
  if (isRunning(oldPid)) {
    process.stdout.write(`桥接已在运行，PID ${oldPid}\n`);
    return;
  }
  const logFd = fs.openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [bridgeScript], {
    detached: true,
    cwd: paths.chatWorkspace,
    env: {
      WEIXIN_CODEX_STATE_DIR: paths.stateDir,
      WEIXIN_CODEX_SOURCE_CODEX_HOME:
        process.env.WEIXIN_CODEX_SOURCE_CODEX_HOME || path.join(os.homedir(), ".codex"),
      PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      NO_COLOR: "1",
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(paths.pid, `${child.pid}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`微信直连 Codex 已启动，PID ${child.pid}\n日志：${paths.log}\n`);
}

async function stop() {
  const paths = ensureStateLayout();
  const pid = readPid(paths);
  if (!isRunning(pid)) {
    process.stdout.write("桥接未运行。\n");
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isRunning(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    fs.unlinkSync(paths.pid);
  } catch {
    // Already absent.
  }
  process.stdout.write("微信直连 Codex 已停止。\n");
}

function status() {
  const paths = ensureStateLayout();
  const config = loadConfig();
  const credentials = loadCredentials();
  const pid = readPid(paths);
  const codex = codexStatus();
  process.stdout.write(
    [
      `运行：${isRunning(pid) ? `是（PID ${pid}）` : "否"}`,
      `微信：${credentials?.token ? `已登录（${credentials.accountId || "未知账号"}）` : "未登录"}`,
      `Codex：${codex.loggedIn ? "已登录" : codex.available ? "未登录" : "未安装"}`,
      `模型：${config.model}`,
      `推理：${config.effort}`,
      `模式：独立纯聊天（无 OpenClaw）`,
      `图片：识别与生成回传`,
      `隔离：${process.platform === "darwin" ? "macOS 外层沙箱 + Codex 只读沙箱" : "Codex 只读沙箱"}`,
      `状态目录：${paths.stateDir}`,
    ].join("\n") + "\n",
  );
}

function setModel(args) {
  if (!args[0]) throw new Error("用法：weixin-codex model <model> [effort]");
  const config = loadConfig();
  config.model = normalizeModel(args[0]);
  if (args[1]) config.effort = normalizeEffort(args[1]);
  saveConfig(config);
  process.stdout.write(`默认模型已设为 ${config.model}，推理强度 ${config.effort}。\n`);
}

function showLogs() {
  const paths = ensureStateLayout();
  if (!fs.existsSync(paths.log)) {
    process.stdout.write("尚无日志。\n");
    return;
  }
  const lines = fs.readFileSync(paths.log, "utf8").trimEnd().split("\n");
  process.stdout.write(`${lines.slice(-80).join("\n")}\n`);
}

function doctor() {
  const paths = ensureStateLayout();
  const codex = codexStatus();
  const checks = [
    ["Node.js 22+", Number.parseInt(process.versions.node, 10) >= 22, process.version],
    ["Codex CLI", codex.available, codex.detail || "未找到 codex"],
    ["Codex 登录", codex.loggedIn, codex.detail || "请运行 codex login"],
    ["微信登录", Boolean(loadCredentials()?.token), "请运行 weixin-codex login"],
    ["独立聊天目录", fs.existsSync(paths.chatWorkspace), paths.chatWorkspace],
    [
      "macOS 外层沙箱",
      process.platform !== "darwin" || fs.existsSync("/usr/bin/sandbox-exec"),
      process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "非 macOS，不适用",
    ],
  ];
  for (const [name, ok, detail] of checks) {
    process.stdout.write(`${ok ? "OK" : "FAIL"}  ${name}  ${detail}\n`);
  }
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

function help() {
  process.stdout.write(`
微信直连 Codex（不使用 OpenClaw）

用法：
  weixin-codex login                 扫码登录微信
  weixin-codex start                 后台启动桥接
  weixin-codex run                   前台运行桥接
  weixin-codex stop                  停止桥接
  weixin-codex restart               重启桥接
  weixin-codex status                查看状态
  weixin-codex model <模型> [强度]   修改默认模型
  weixin-codex logs                  查看最近日志
  weixin-codex doctor                检查依赖和登录态
`);
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "login") return login();
  if (command === "start") return start();
  if (command === "run") {
    await import("./bridge.mjs");
    return;
  }
  if (command === "stop") return stop();
  if (command === "restart") {
    await stop();
    return start();
  }
  if (command === "status") return status();
  if (command === "model") return setModel(args);
  if (command === "logs") return showLogs();
  if (command === "doctor") return doctor();
  if (command === "help" || command === "--help" || command === "-h") return help();
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message || String(error)}\n`);
  process.exitCode = 1;
});
