import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MODEL = "gpt-5.6-luna";
export const DEFAULT_EFFORT = "max";
export const VALID_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function getStateDir() {
  return path.resolve(
    process.env.WEIXIN_CODEX_STATE_DIR || path.join(os.homedir(), ".weixin-codex"),
  );
}

export function getPaths() {
  const stateDir = getStateDir();
  return {
    stateDir,
    config: path.join(stateDir, "config.json"),
    credentials: path.join(stateDir, "credentials.json"),
    sessions: path.join(stateDir, "sessions.json"),
    delivery: path.join(stateDir, "delivery.json"),
    cursor: path.join(stateDir, "get-updates-cursor.txt"),
    pid: path.join(stateDir, "bridge.pid"),
    log: path.join(stateDir, "bridge.log"),
    chatWorkspace: path.join(stateDir, "chat"),
    codexHome: path.join(stateDir, "codex-home"),
    runtimeHome: path.join(stateDir, "runtime-home"),
    runtimeTmp: path.join(stateDir, "runtime-tmp"),
    sandboxProfile: path.join(stateDir, "codex-chat.sb"),
  };
}

export function ensureStateLayout() {
  const paths = getPaths();
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.chatWorkspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.runtimeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.runtimeTmp, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(paths.stateDir, 0o700);
  } catch {
    // Some filesystems do not support POSIX modes.
  }
  return paths;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`无法读取 ${filePath}: ${error.message}`);
  }
}

export function writeJsonSecure(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems do not support POSIX modes.
  }
}

export function loadConfig() {
  const paths = ensureStateLayout();
  const stored = readJson(paths.config, {});
  return {
    version: 1,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    codexBin: "codex",
    ownerUserId: null,
    ...stored,
  };
}

export function saveConfig(config) {
  const paths = ensureStateLayout();
  writeJsonSecure(paths.config, config);
}

export function loadCredentials() {
  return readJson(ensureStateLayout().credentials, null);
}

export function saveCredentials(credentials) {
  writeJsonSecure(ensureStateLayout().credentials, credentials);
}

export function loadSessions() {
  return readJson(ensureStateLayout().sessions, { version: 1, users: {} });
}

export function saveSessions(sessions) {
  writeJsonSecure(ensureStateLayout().sessions, sessions);
}

export function loadDeliveryState() {
  return readJson(ensureStateLayout().delivery, {
    version: 1,
    processedMessageIds: [],
    pendingReplies: {},
  });
}

export function saveDeliveryState(delivery) {
  writeJsonSecure(ensureStateLayout().delivery, delivery);
}

export function loadCursor() {
  try {
    return fs.readFileSync(ensureStateLayout().cursor, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function saveCursor(cursor) {
  const filePath = ensureStateLayout().cursor;
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, cursor, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function normalizeModel(model) {
  const value = String(model || "").trim();
  if (!value) throw new Error("模型不能为空");
  return value.startsWith("openai/") ? value.slice("openai/".length) : value;
}

export function normalizeEffort(effort) {
  const value = String(effort || "").trim().toLowerCase();
  if (!VALID_EFFORTS.has(value)) {
    throw new Error(`无效推理强度: ${value}。可选: ${[...VALID_EFFORTS].join(", ")}`);
  }
  return value;
}

export function prepareIsolatedCodexHome() {
  const paths = ensureStateLayout();
  const sourceCodexHome = path.resolve(
    process.env.WEIXIN_CODEX_SOURCE_CODEX_HOME || path.join(os.homedir(), ".codex"),
  );
  const sourceAuth = path.join(sourceCodexHome, "auth.json");
  const targetAuth = path.join(paths.codexHome, "auth.json");

  if (!fs.existsSync(sourceAuth)) {
    throw new Error(`未找到 Codex 登录凭据 ${sourceAuth}，请先运行 codex login`);
  }
  if (fs.existsSync(targetAuth) && fs.lstatSync(targetAuth).isSymbolicLink()) {
    fs.unlinkSync(targetAuth);
  }
  if (
    !fs.existsSync(targetAuth) ||
    fs.statSync(sourceAuth).mtimeMs > fs.statSync(targetAuth).mtimeMs
  ) {
    fs.copyFileSync(sourceAuth, targetAuth);
    fs.chmodSync(targetAuth, 0o600);
  }

  const minimalConfig = path.join(paths.codexHome, "config.toml");
  fs.writeFileSync(
    minimalConfig,
    [
      `model = "${DEFAULT_MODEL}"`,
      `model_reasoning_effort = "${DEFAULT_EFFORT}"`,
      'model_provider = "weixin_codex_openai"',
      'sandbox_mode = "read-only"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      "",
      "[features]",
      "apps = false",
      "browser_use = false",
      "computer_use = false",
      "goals = false",
      "hooks = false",
      "image_generation = true",
      "in_app_browser = false",
      "multi_agent = false",
      "plugins = false",
      "shell_tool = false",
      "skill_search = false",
      "tool_suggest = false",
      "unified_exec = false",
      "workspace_dependencies = false",
      "",
      "[model_providers.weixin_codex_openai]",
      'name = "OpenAI"',
      "requires_openai_auth = true",
      "supports_websockets = false",
      'wire_api = "responses"',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  return paths;
}
