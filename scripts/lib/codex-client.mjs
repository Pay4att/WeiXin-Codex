import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  loadConfig,
  loadSessions,
  normalizeEffort,
  normalizeModel,
  prepareIsolatedCodexHome,
  saveSessions,
} from "./state.mjs";

const CHAT_INSTRUCTIONS = [
  "You are a general-purpose conversational assistant speaking with the user through Weixin.",
  "This is a normal chat, not a software project or coding task.",
  "Answer the user's actual question directly and naturally.",
  "The only tool you may use is image generation, and only when the user asks to create or edit an image.",
  "Do not inspect files, run shell commands, edit files, browse, use MCP tools, access environments, or create subagents.",
  "Never claim to have access to the host computer, its files, clipboard, applications, browser, terminal, or environment.",
  "Do not mention Codex internals unless the user asks.",
  "Use concise Simplified Chinese by default, matching the user's language.",
].join("\n");

function sandboxString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function writeMacSandboxProfile(paths) {
  const realStateDir = fs.realpathSync(paths.stateDir);
  const profile = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow network-outbound)",
    '(allow file-read-metadata (literal "/"))',
    '(allow file-read-metadata (literal "/Users"))',
    `(allow file-read-metadata (literal "${sandboxString(path.dirname(paths.stateDir))}"))`,
    `(allow file-read-metadata (literal "${sandboxString(path.dirname(realStateDir))}"))`,
    '(allow file-read-metadata (literal "/opt"))',
    `(allow file-read* (subpath "${sandboxString(paths.stateDir)}"))`,
    `(allow file-write* (subpath "${sandboxString(paths.stateDir)}"))`,
    `(allow file-read* (subpath "${sandboxString(realStateDir)}"))`,
    `(allow file-write* (subpath "${sandboxString(realStateDir)}"))`,
    '(allow file-read* (subpath "/opt/homebrew"))',
    '(allow file-read* (subpath "/usr/local"))',
    '(allow file-read* (subpath "/Library/Apple"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/private/var/db/timezone"))',
    "",
  ].join("\n");
  fs.writeFileSync(paths.sandboxProfile, profile, { encoding: "utf8", mode: 0o600 });
  return paths.sandboxProfile;
}

export function isolatedEnvironment(paths) {
  return {
    CODEX_HOME: paths.codexHome,
    HOME: paths.runtimeHome,
    TMPDIR: paths.runtimeTmp,
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    NO_COLOR: "1",
  };
}

export class CodexAppServer {
  constructor(options = {}) {
    this.spawnImpl = options.spawnImpl || spawn;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.completedTurns = new Map();
    this.sessions = loadSessions();
    this.queues = new Map();
  }

  async start() {
    if (this.process) return;
    const paths = prepareIsolatedCodexHome();
    const config = loadConfig();
    let executable = config.codexBin || "codex";
    let args = ["app-server", "--stdio", "--strict-config"];
    if (process.platform === "darwin") {
      executable = "/usr/bin/sandbox-exec";
      args = ["-f", writeMacSandboxProfile(paths), config.codexBin || "codex", ...args];
    }
    this.process = this.spawnImpl(executable, args, {
      cwd: paths.chatWorkspace,
      env: isolatedEnvironment(paths),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server 已退出 (${code ?? signal ?? "unknown"})`);
      for (const pending of this.pending.values()) pending.reject(error);
      for (const turn of this.turns.values()) turn.reject(error);
      this.pending.clear();
      this.turns.clear();
      this.process = null;
    });
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) process.stderr.write(`[codex] ${text}\n`);
    });
    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.#onMessage(line));

    await this.request("initialize", {
      clientInfo: { name: "weixin-codex", title: "Weixin Codex", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  stop() {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = null;
  }

  request(method, params) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server 未运行"));
    }
    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params) {
    if (this.process?.stdin?.writable) {
      const message = params === undefined ? { method } : { method, params };
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  async reset(userId) {
    const user = this.#user(userId);
    delete user.threadId;
    saveSessions(this.sessions);
  }

  getUserSettings(userId) {
    const config = loadConfig();
    const user = this.#user(userId);
    return {
      model: normalizeModel(user.model || config.model),
      effort: normalizeEffort(user.effort || config.effort),
      threadId: user.threadId || null,
    };
  }

  setUserModel(userId, model) {
    const user = this.#user(userId);
    user.model = normalizeModel(model);
    saveSessions(this.sessions);
    return user.model;
  }

  setUserEffort(userId, effort) {
    const user = this.#user(userId);
    user.effort = normalizeEffort(effort);
    saveSessions(this.sessions);
    return user.effort;
  }

  chat(userId, text, imagePaths = []) {
    const previous = this.queues.get(userId) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.#chatNow(userId, text, imagePaths));
    this.queues.set(userId, current);
    return current.finally(() => {
      if (this.queues.get(userId) === current) this.queues.delete(userId);
    });
  }

  async #chatNow(userId, text, imagePaths) {
    await this.start();
    const paths = prepareIsolatedCodexHome();
    const settings = this.getUserSettings(userId);
    const threadId = await this.#ensureThread(userId, settings, paths.chatWorkspace);
    const response = await this.request("turn/start", {
      threadId,
      input: [
        { type: "text", text, text_elements: [] },
        ...imagePaths.map((imagePath) => ({ type: "localImage", path: imagePath })),
      ],
      cwd: paths.chatWorkspace,
      runtimeWorkspaceRoots: [paths.chatWorkspace],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      environments: [],
      model: settings.model,
      effort: settings.effort,
      summary: "none",
    });
    return this.#waitForTurn(response.turn.id);
  }

  async #ensureThread(userId, settings, cwd) {
    const user = this.#user(userId);
    if (user.threadId) {
      try {
        await this.request("thread/resume", {
          threadId: user.threadId,
          model: settings.model,
          cwd,
          runtimeWorkspaceRoots: [cwd],
          approvalPolicy: "never",
          sandbox: "read-only",
          environments: [],
          baseInstructions: CHAT_INSTRUCTIONS,
          developerInstructions: CHAT_INSTRUCTIONS,
        });
        return user.threadId;
      } catch {
        delete user.threadId;
      }
    }
    const response = await this.request("thread/start", {
      model: settings.model,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config: {
        web_search: "disabled",
        "features.apps": false,
        "features.browser_use": false,
        "features.computer_use": false,
        "features.image_generation": true,
        "features.in_app_browser": false,
        "features.multi_agent": false,
        "features.plugins": false,
        "features.shell_tool": false,
        "features.skill_search": false,
        "features.unified_exec": false,
        "features.workspace_dependencies": false,
      },
      baseInstructions: CHAT_INSTRUCTIONS,
      developerInstructions: CHAT_INSTRUCTIONS,
      serviceName: "weixin-codex",
      ephemeral: false,
      threadSource: "weixin",
    });
    user.threadId = response.thread.id;
    saveSessions(this.sessions);
    return user.threadId;
  }

  #waitForTurn(turnId) {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(this.#finalResponse(completed));
    }
    return new Promise((resolve, reject) => {
      this.turns.set(turnId, {
        items: [],
        resolve: (turn) => {
          try {
            resolve(this.#finalResponse(turn));
          } catch (error) {
            reject(error);
          }
        },
        reject,
      });
    });
  }

  #finalResponse(turn) {
    if (turn.status === "failed") {
      throw new Error(turn.error?.message || "Codex 本轮失败");
    }
    const messages = (turn.items || []).filter((item) => item.type === "agentMessage");
    const final = [...messages].reverse().find((item) => item.phase === "final") || messages.at(-1);
    const images = (turn.items || [])
      .filter((item) => item.type === "imageGeneration" && item.status !== "failed")
      .map((item) => this.#materializeGeneratedImage(item))
      .filter(Boolean);
    if (!final?.text && images.length === 0) throw new Error("Codex 没有返回内容");
    return { text: final?.text || "", images };
  }

  #materializeGeneratedImage(item) {
    const paths = prepareIsolatedCodexHome();
    const outboundDir = path.join(paths.chatWorkspace, "outbound");
    fs.mkdirSync(outboundDir, { recursive: true, mode: 0o700 });
    let bytes;
    if (item.savedPath) {
      const resolved = fs.realpathSync(String(item.savedPath));
      const allowedRoots = [paths.codexHome, paths.chatWorkspace].map(
        (root) => `${fs.realpathSync(root)}${path.sep}`,
      );
      if (!allowedRoots.some((root) => `${resolved}${path.sep}`.startsWith(root))) {
        throw new Error("图片生成结果位于隔离目录之外，已拒绝读取");
      }
      bytes = fs.readFileSync(resolved);
      const generatedRoot = path.join(paths.codexHome, "generated_images");
      if (`${resolved}${path.sep}`.startsWith(`${generatedRoot}${path.sep}`)) {
        try {
          fs.unlinkSync(resolved);
        } catch {
          // The copied isolated output remains available for delivery.
        }
      }
    } else if (item.result) {
      const encoded = String(item.result).replace(/^data:image\/[^;]+;base64,/, "");
      bytes = Buffer.from(encoded, "base64");
    } else {
      return null;
    }
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) {
      throw new Error("生成图片为空或超过 25 MB");
    }
    let extension = ".png";
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) extension = ".jpg";
    else if (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) extension = ".webp";
    const destination = path.join(outboundDir, `${crypto.randomUUID()}${extension}`);
    fs.writeFileSync(destination, bytes, { mode: 0o600 });
    return { path: destination, bytes: bytes.length };
  }

  #user(userId) {
    this.sessions.users ||= {};
    this.sessions.users[userId] ||= {};
    return this.sessions.users[userId];
  }

  #onMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id != null && message.method) {
      this.#declineServerRequest(message);
      return;
    }
    if (message.method === "item/completed") {
      const turn = this.turns.get(message.params?.turnId);
      if (turn) turn.items.push(message.params.item);
      return;
    }
    if (message.method === "turn/completed") {
      const completed = message.params.turn;
      const waiter = this.turns.get(completed.id);
      if (waiter) {
        this.turns.delete(completed.id);
        const merged = {
          ...completed,
          items: completed.items?.length ? completed.items : waiter.items,
        };
        waiter.resolve(merged);
      } else {
        this.completedTurns.set(completed.id, completed);
      }
    }
  }

  #declineServerRequest(message) {
    let result;
    if (message.method === "item/commandExecution/requestApproval") {
      result = { decision: "decline" };
    } else if (message.method === "item/fileChange/requestApproval") {
      result = { decision: "decline" };
    } else if (message.method === "execCommandApproval" || message.method === "applyPatchApproval") {
      result = { decision: { denied: { rejection: "微信纯聊天模式禁止工具执行" } } };
    } else if (message.method === "mcpServer/elicitation/request") {
      result = { action: "decline", content: null, _meta: null };
    } else {
      this.process.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32000, message: "微信纯聊天模式不支持该请求" } })}\n`,
      );
      return;
    }
    this.process.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }
}

export const __test = { CHAT_INSTRUCTIONS };
