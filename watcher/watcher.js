// @ts-check

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, exec, execFile } = require("child_process");
const { createRestoreManager } = require("./restore");
const { createUpdater } = require("./updater");
const { getServerStatus } = require("./world-files");

// ======== .env загрузка ========

const ENV_FILE = path.join(__dirname, ".env");

try {
  const lines = fs.readFileSync(ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch { }

const TOKEN = process.env.TG_TOKEN;
const TG_ADMIN_ID = process.env.TG_ADMIN_ID;
const TG_MODE = (process.env.TG_MODE || "polling").toLowerCase(); // "polling" | "webhook"
const TG_WEBHOOK_URL = process.env.TG_WEBHOOK_URL;
const TG_WEBHOOK_PORT = parseInt(process.env.TG_WEBHOOK_PORT || "3000", 10);
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || "";
const TG_API_URL = new URL(process.env.TG_API_URL || "https://api.telegram.org");
const TG_API_FILE_URL = process.env.TG_API_FILE_URL || "";
if (!["http:", "https:"].includes(TG_API_URL.protocol)) throw new Error("TG_API_URL must use http or https");
const TG_API_TRANSPORT = TG_API_URL.protocol === "http:" ? http : https;
const TG_API_PREFIX = TG_API_URL.pathname.replace(/\/$/, "");
const tgRequestOptions = (requestPath, options = {}) => ({
  protocol: TG_API_URL.protocol,
  hostname: TG_API_URL.hostname,
  port: TG_API_URL.port || undefined,
  path: TG_API_PREFIX + requestPath,
  ...options,
});
const VALHEIM_HOOK_PORT = parseInt(process.env.VALHEIM_HOOK_PORT || "3920", 10);
const VALHEIM_HOOK_SECRET = process.env.VALHEIM_HOOK_SECRET || "";
const VALHEIM_HOOK_PATH = process.env.VALHEIM_HOOK_PATH || "/hook";
const VALHEIM_BACKUPS_DIR = process.env.VALHEIM_BACKUPS_DIR;
const VALHEIM_WORLDS_DIR = process.env.VALHEIM_WORLDS_DIR || "/valheim/worlds";
const VALHEIM_PROJECT_DIR = process.env.VALHEIM_PROJECT_DIR;
const VALHEIM_WORLD_ENV_FILE = process.env.VALHEIM_WORLD_ENV_FILE;
const VALHEIM_CONTAINER = process.env.VALHEIM_CONTAINER || "valheim-server";
const TG_MAX_DOCUMENT_BYTES = Number(process.env.TG_MAX_DOCUMENT_BYTES || 50 * 1024 * 1024);

// ======== Яндекс Мессенджер ========
const YM_TOKEN = process.env.YM_TOKEN || "";
const YM_CHAT_IDS = (process.env.YM_CHAT_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
const YM_LOGINS = (process.env.YM_LOGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
const YM_ENABLED = Boolean(YM_TOKEN && (YM_CHAT_IDS.length || YM_LOGINS.length));

const DEBUG = process.argv.includes("--debug");

if (!DEBUG && !TOKEN) {
  console.error("Missing environment variable: TG_TOKEN");
  process.exit(1);
}

if (!DEBUG && TG_MODE === "webhook" && !TG_WEBHOOK_URL) {
  console.error("Missing environment variable: TG_WEBHOOK_URL (required for webhook mode)");
  process.exit(1);
}

console.log(`✅ Наблюдатель запущен (${TG_MODE})`);
if (DEBUG) console.log("🐛 Режим --debug: полные логи, время из логов, без отправки в Telegram");

const CHAT_IDS_FILE = path.join(__dirname, "data", "chats.json");
const HOOKS_CHAT_IDS_FILE = path.join(__dirname, "data", "hooks-chats.json");
const STATS_FILE = path.join(__dirname, "data", "stats.json");

let stats = { players: {} };
const pendingBackupChatIds = new Set();

function loadStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.players && typeof parsed.players === "object") {
      stats = parsed;
    }
  } catch {
    stats = { players: {} };
  }
  console.log(`[stats] игроков в статистике: ${Object.keys(stats.players).length}`);
}

function saveStats() {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf8");
}

const ensurePlayerStats = (name) => {
  if (!stats.players[name]) stats.players[name] = { totalMs: 0, sessions: 0 };
  return stats.players[name];
};

const addPlayerSession = (name, durationMs, endedAtMs = Date.now()) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const player = ensurePlayerStats(name);
  player.totalMs += durationMs;
  player.sessions += 1;
  player.lastSessionMs = durationMs;
  player.lastSeenAt = new Date(endedAtMs).toISOString();
  saveStats();
};

/** Список chat_id для рассылки уведомлений (подписка через /start, отписка через /stop) */
let chatIds = [];
/** Список chat_id для Valheim-хуков (подписка через /hooks_on, отписка через /hooks_off) */
let hooksChatIds = [];

function loadChatIds() {
  try {
    console.log(`📂 Загружаю chat_id из файла: ${CHAT_IDS_FILE}`);
    const data = fs.readFileSync(CHAT_IDS_FILE, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      chatIds = parsed;
      console.log(`✅ Список чатов загружен: ${chatIds.length} шт.`);
    } else {
      chatIds = [];
      console.warn(`⚠️ Не удалось загрузить список чатов: Неверный формат файла`);
    }
  } catch (err) {
    chatIds = [];
    console.warn(`⚠️ Не удалось загрузить список чатов: ${err.message}`);
  }
}

function loadHooksChatIds() {
  try {
    console.log(`📂 Загружаю hooks chat_id из файла: ${HOOKS_CHAT_IDS_FILE}`);
    const data = fs.readFileSync(HOOKS_CHAT_IDS_FILE, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      hooksChatIds = parsed;
      console.log(`✅ Подписчики Valheim-хуков: ${hooksChatIds.length} шт.`);
      return;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`⚠️ Не удалось загрузить hooks chat_id: ${err.message}`);
    }
  }
  hooksChatIds = TG_ADMIN_ID ? [TG_ADMIN_ID] : [];
  saveHooksChatIds();
  console.log(`✅ Подписчики Valheim-хуков (по умолчанию): ${hooksChatIds.length} шт.`);
}

function saveChatIds() {
  const dir = path.dirname(CHAT_IDS_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  fs.writeFileSync(CHAT_IDS_FILE, JSON.stringify(chatIds, null, 2), "utf8");
}

function saveHooksChatIds() {
  const dir = path.dirname(HOOKS_CHAT_IDS_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  fs.writeFileSync(HOOKS_CHAT_IDS_FILE, JSON.stringify(hooksChatIds, null, 2), "utf8");
}

loadChatIds();
loadHooksChatIds();

const onlinePlayers = new Set();
const playerIdToName = new Map(); // id → имя
const playerIdToJoinTime = new Map(); // id → timestamp первого входа
const playerIdToLastSpawnTime = new Map(); // id → timestamp последнего появления (вход или возрождение)
const playerIdToDeathCount = new Map(); // id → количество смертей (возрождений)

loadStats();

const clearPlayerState = () => {
  onlinePlayers.clear();
  playerIdToName.clear();
  playerIdToJoinTime.clear();
  playerIdToLastSpawnTime.clear();
  playerIdToDeathCount.clear();
};

// ======== Утилитарные функции ========

/** Извлечь время из строки лога (MM/DD/YYYY HH:mm:ss), вернуть Date или null */
const parseLogTimestamp = (line) => {
  const match = line.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, month, day, year, h, min, sec] = match.map(Number);
  return new Date(year, month - 1, day, h, min, sec);
};

/** Форматировать длительность в человекочитаемый вид */
const formatDuration = (ms) => {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} сек`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
};

const activeJoinTimeByName = (name) => {
  for (const [id, playerName] of playerIdToName) {
    if (playerName === name) return playerIdToJoinTime.get(id);
  }
  return undefined;
};

const totalWithActiveMs = (name, nowMs = Date.now()) => {
  const saved = stats.players[name]?.totalMs || 0;
  const joinedAt = activeJoinTimeByName(name);
  return saved + (joinedAt ? Math.max(0, nowMs - joinedAt) : 0);
};

const buildOnlineListText = () => {
  if (onlinePlayers.size === 0) return "👤 Сейчас никто не играет";
  const nowMs = Date.now();
  const lines = [...onlinePlayers]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const joinedAt = activeJoinTimeByName(name);
      return `• ${name}${joinedAt ? ` — ${formatDuration(nowMs - joinedAt)}` : ""}`;
    });
  return `👥 Онлайн (${onlinePlayers.size}):\n${lines.join("\n")}`;
};

const buildStatsText = () => {
  const nowMs = Date.now();
  const names = new Set([...Object.keys(stats.players), ...onlinePlayers]);
  const rows = [...names]
    .map((name) => ({ name, totalMs: totalWithActiveMs(name, nowMs), sessions: stats.players[name]?.sessions || 0 }))
    .filter((row) => row.totalMs > 0)
    .sort((a, b) => b.totalMs - a.totalMs);
  if (rows.length === 0) return "📊 Статистика пока пустая";
  const total = rows.reduce((sum, row) => sum + row.totalMs, 0);
  return "📊 Время в Valheim\n" +
    `Всего: ${formatDuration(total)}\n\n` +
    rows.map((row) => `• ${row.name}: ${formatDuration(row.totalMs)}${row.sessions ? ` (${row.sessions} сесс.)` : ""}`).join("\n");
};

const formatBytes = (n) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

/** @type {Record<string, string>} */
const STEAM_UPDATE_STATE_RU = {
  downloading: "Загрузка",
  "verifying install": "Проверка файлов",
  "verifying update": "Проверка обновления",
  preallocating: "Подготовка",
  staging: "Подготовка",
  stopping: "Остановка",
  "download complete": "Загрузка завершена",
  installing: "Установка",
  extracting: "Распаковка",
};

const parseKb = (s) => parseInt(s.replace(/,/g, ""), 10) * 1024;

const UPDATE_PROGRESS_MIN_DELTA = 1;
const UPDATE_PROGRESS_MIN_INTERVAL_MS = 2000;

/** @type {{
 *   messageIds: Map<string, number>,
 *   lastPercent: number,
 *   lastEditAt: number,
 *   lastState: string,
 *   queuedText: string | null,
 *   lastParsed: { state: string, percent: number|null, current: number, total: number } | null,
 * } | null} */
let updateProgress = null;

/**
 * Выполнить POST-запрос к Telegram Bot API
 * @param {string} method
 * @param {object} data
 * @returns {Promise<object>}
 */
const tgPost = (method, data) => {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = tgRequestOptions(`/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    const req = TG_API_TRANSPORT.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Telegram response aborted")));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Telegram request timed out")));
    req.write(body);
    req.end();
  });
};

/**
 * Выполнить GET-запрос к Telegram Bot API
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<object>}
 */
const tgGet = (method, params = {}) => {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const options = tgRequestOptions(`/bot${TOKEN}/${method}${qs ? "?" + qs : ""}`, {
      method: "GET",
    });
    const req = TG_API_TRANSPORT.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Telegram response aborted")));
    });
    req.on("error", reject);
    req.setTimeout(45000, () => req.destroy(new Error("Telegram request timed out")));
    req.end();
  });
};

/** Выполнить POST-запрос к Bot API Яндекс Мессенджера. */
const ymPost = (data) => new Promise((resolve, reject) => {
  const body = JSON.stringify(data);
  const req = https.request({
    hostname: "botapi.messenger.yandex.net",
    path: "/bot/v1/messages/sendText/",
    method: "POST",
    headers: {
      Authorization: "OAuth " + YM_TOKEN,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, (res) => {
    let raw = "";
    res.on("data", (chunk) => (raw += chunk));
    res.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { ok: false, description: raw }; }
      if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) resolve(parsed);
      else reject(new Error(parsed.description || ("HTTP " + res.statusCode)));
    });
  });
  req.on("error", reject);
  req.write(body);
  req.end();
});

/** Отправить уведомление всем настроенным адресатам Яндекс Мессенджера. */
const sendYandexMessage = async (text) => {
  if (DEBUG || !YM_ENABLED) return;
  const targets = [
    ...YM_CHAT_IDS.map((chat_id) => ({ chat_id })),
    ...YM_LOGINS.map((login) => ({ login })),
  ];
  const results = await Promise.allSettled(targets.map((target) =>
    ymPost({ ...target, text, payload_id: "valheim-" + Date.now() + "-" + Math.random().toString(36).slice(2) })
  ));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const target = YM_CHAT_IDS[index] || YM_LOGINS[index - YM_CHAT_IDS.length];
      console.error("[yandex] Ошибка " + target + ": " + result.reason.message);
    }
  });
};

/**
 * Отправить сообщение подписчикам Valheim-хуков
 * @param {string} text
 * @param {string} [eventTime]
 * @param {string} [targetChatId]
 */
const sendHooksMessage = async (text, eventTime, targetChatId) => {
  if (!targetChatId) await sendYandexMessage(text);
  if (DEBUG) {
    console.log(`${eventTime ?? new Date().toLocaleString("ru-RU")} [hooks]: ${text}`);
    return;
  }
  const chats = targetChatId ? [targetChatId] : hooksChatIds;
  if (chats.length === 0) return;
  try {
    console.log(`[hooks] 📤 Отправляем в ${chats.length} чат(ов): ${text}`);
    await Promise.all(
      chats.map((chat_id) => tgPost("sendMessage", { chat_id, text }))
    );
  } catch (err) {
    console.error(`[hooks] ❌ Ошибка sendMessage: ${JSON.stringify(err)}`);
  }
};

/**
 * @param {string} text
 * @returns {Promise<Map<string, number>>}
 */
const sendHooksProgressMessages = async (text) => {
  /** @type {Map<string, number>} */
  const messageIds = new Map();
  if (DEBUG) {
    console.log(`[hooks] ${text.replace(/\n/g, " | ")}`);
    return messageIds;
  }
  for (const chat_id of hooksChatIds) {
    try {
      const res = await tgPost("sendMessage", { chat_id, text });
      if (res.ok) messageIds.set(chat_id, res.result.message_id);
    } catch (err) {
      console.error(`[hooks] ❌ sendMessage ${chat_id}: ${err.message}`);
    }
  }
  return messageIds;
};

/**
 * @param {Map<string, number>} messageIds
 * @param {string} text
 */
const editHooksProgressMessages = async (messageIds, text) => {
  if (DEBUG) {
    console.log(`[hooks] ${text.replace(/\n/g, " | ")}`);
    return;
  }
  for (const [chat_id, message_id] of messageIds) {
    try {
      const res = await tgPost("editMessageText", { chat_id, message_id, text });
      if (!res.ok && !String(res.description || "").includes("message is not modified")) {
        console.error(`[hooks] ❌ editMessage ${chat_id}: ${res.description || JSON.stringify(res)}`);
      }
    } catch (err) {
      console.error(`[hooks] ❌ editMessage ${chat_id}: ${err.message}`);
    }
  }
};

/**
 * Отправить сообщение в Telegram (в --debug только вывод в консоль)
 * @param {string} text - Текст сообщения
 * @param {string} [eventTime] - Время события
 * @param {string} [targetChatId] - Если указан — отправить только в этот чат, иначе — во все подписанные чаты
 */
const sendMessage = async (text, eventTime, targetChatId) => {
  if (!targetChatId) await sendYandexMessage(text);
  if (DEBUG) {
    console.log(`${eventTime ?? new Date().toLocaleString("ru-RU")}: ${text}`);
    return;
  }
  const chats = targetChatId ? [targetChatId] : chatIds;
  if (chats.length === 0) return;
  try {
    console.log(`[sendMessage] 📤 Отправляем сообщение в ${chats.length} чат(ов): ${text}`);
    await Promise.all(
      chats.map((chat_id) => tgPost("sendMessage", { chat_id, text }))
    );
  } catch (err) {
    console.error(`[sendMessage] ❌ Ошибка: ${JSON.stringify(err)}`);
  }
};

/**
 * @param {string} line
 * @returns {{ state: string, percent: number|null, current: number, total: number } | null}
 */
const parseSteamUpdateProgress = (line) => {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "");

  let match = clean.match(
    /Update state \(0x[0-9a-f]+\)\s+([^,]+),\s*progress:\s*([\d.]+)\s*\((\d+)\s*\/\s*(\d+)\)/i
  );
  if (match) {
    return {
      state: match[1].trim(),
      percent: parseFloat(match[2]),
      current: parseInt(match[3], 10),
      total: parseInt(match[4], 10),
    };
  }

  match = clean.match(/\[\s*([\d.]+)%\]\s+Downloading update \(([\d,]+) of ([\d,]+) KB\)/i);
  if (match) {
    return {
      state: "downloading",
      percent: parseFloat(match[1]),
      current: parseKb(match[2]),
      total: parseKb(match[3]),
    };
  }

  if (/\[\s*100%\]\s+Download complete/i.test(clean)) {
    return { state: "download complete", percent: 100, current: 0, total: 0 };
  }
  if (/\[\s*-+\]\s+Verifying installation/i.test(clean)) {
    return { state: "verifying install", percent: null, current: 0, total: 0 };
  }
  if (/\[\s*-+\]\s+Installing update/i.test(clean)) {
    return { state: "installing", percent: null, current: 0, total: 0 };
  }
  if (/\[\s*-+\]\s+Extracting package/i.test(clean)) {
    return { state: "extracting", percent: null, current: 0, total: 0 };
  }

  return null;
};

/**
 * @param {{ state: string, percent: number|null, current: number, total: number }} parsed
 * @param {{ finalize?: boolean }} [opts]
 */
const formatUpdateProgressMessage = (parsed, opts = {}) => {
  const { finalize = false } = opts;
  const stateRu = STEAM_UPDATE_STATE_RU[parsed.state.toLowerCase()] || parsed.state;
  let text = `${VALHEIM_HOOK_LABELS.pre_update_check}\n📁 ${stateRu}`;

  const percent = finalize && parsed.total > 0 ? 100 : parsed.percent;
  const current = finalize && parsed.total > 0 ? parsed.total : parsed.current;

  if (percent != null && parsed.total > 0) {
    const pctStr = finalize ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
    text += `\n📊 ${pctStr} (${formatBytes(current)} / ${formatBytes(parsed.total)})`;
  } else if (percent != null) {
    const pctStr = finalize ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
    text += `\n📊 ${pctStr}`;
  }

  if (finalize) {
    text += `\n${VALHEIM_HOOK_LABELS.post_update_check}`;
  }

  return text;
};

const applyUpdateProgressText = async (text) => {
  if (!updateProgress) return;
  if (updateProgress.messageIds.size === 0) {
    updateProgress.queuedText = text;
    return;
  }
  await editHooksProgressMessages(updateProgress.messageIds, text);
};

const beginUpdateProgress = async () => {
  if (updateProgress) return;

  updateProgress = { messageIds: new Map(), lastPercent: -1, lastEditAt: 0, lastState: "", queuedText: null, lastParsed: null };
  startSteamLogWatcher();
  const messageIds = await sendHooksProgressMessages(VALHEIM_HOOK_LABELS.pre_update_check);
  if (messageIds.size === 0) {
    updateProgress = null;
    return;
  }

  updateProgress.messageIds = messageIds;
  if (updateProgress.queuedText) {
    await editHooksProgressMessages(messageIds, updateProgress.queuedText);
    updateProgress.queuedText = null;
  }
};

const startUpdateProgressTracking = () => beginUpdateProgress();

const finishUpdateProgressTracking = async (timeStr) => {
  stopSteamLogWatcher();
  if (updateProgress && updateProgress.messageIds.size > 0) {
    const text = updateProgress.lastParsed
      ? formatUpdateProgressMessage(updateProgress.lastParsed, { finalize: true })
      : `${VALHEIM_HOOK_LABELS.pre_update_check}\n${VALHEIM_HOOK_LABELS.post_update_check}`;
    await editHooksProgressMessages(updateProgress.messageIds, text);
    updateProgress = null;
    return;
  }
  updateProgress = null;
  await sendHooksMessage(VALHEIM_HOOK_LABELS.post_update_check, timeStr);
};

/**
 * @param {{ state: string, percent: number|null, current: number, total: number }} parsed
 */
const applyUpdateProgressParsed = (parsed) => {
  if (!updateProgress) beginUpdateProgress();
  if (!updateProgress) return;

  const now = Date.now();
  const percent = parsed.percent ?? -1;
  const stateChanged = parsed.state !== updateProgress.lastState;
  const delta = parsed.percent != null ? Math.abs(percent - updateProgress.lastPercent) : 999;

  if (
    !stateChanged &&
    parsed.percent != null &&
    updateProgress.lastPercent >= 0 &&
    delta < UPDATE_PROGRESS_MIN_DELTA &&
    now - updateProgress.lastEditAt < UPDATE_PROGRESS_MIN_INTERVAL_MS
  ) {
    return;
  }

  updateProgress.lastPercent = percent;
  updateProgress.lastState = parsed.state;
  updateProgress.lastEditAt = now;
  updateProgress.lastParsed = parsed;
  const text = formatUpdateProgressMessage(parsed);
  console.log(`[update-progress] ${text.replace(/\n/g, " | ")}`);
  applyUpdateProgressText(text);
};

/** Читать steam stderr с хоста (volume logs/steam) — fallback если docker logs отвалился */
const pollSteamStderrLog = () => {
  if (!updateProgress) return;
  try {
    if (!fs.existsSync(STEAM_STDERR_LOG)) return;
    const stat = fs.statSync(STEAM_STDERR_LOG);
    if (stat.size < steamLogOffset) steamLogOffset = 0;
    if (stat.size === steamLogOffset) return;

    const fd = fs.openSync(STEAM_STDERR_LOG, "r");
    const len = stat.size - steamLogOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, steamLogOffset);
    fs.closeSync(fd);
    steamLogOffset = stat.size;

    processDockerLogLines(buf.toString("utf8"));
  } catch (err) {
    console.warn(`[steam-log] ⚠️ ${err.message}`);
  }
};

const startSteamLogWatcher = () => {
  stopSteamLogWatcher();
  steamLogOffset = 0;
  try {
    if (fs.existsSync(STEAM_STDERR_LOG)) {
      steamLogOffset = fs.statSync(STEAM_STDERR_LOG).size;
    }
  } catch { }
  steamLogWatcher = setInterval(pollSteamStderrLog, 1500);
  console.log(`[steam-log] Слежу за ${STEAM_STDERR_LOG}`);
};

const stopSteamLogWatcher = () => {
  if (steamLogWatcher) {
    clearInterval(steamLogWatcher);
    steamLogWatcher = null;
  }
  steamLogOffset = 0;
};

/**
 * Путь к бэкапу на хосте watcher (hook присылает путь внутри valheim-контейнера: /config/backups/...)
 * @param {string} fileParam
 * @returns {string|null}
 */
const resolveBackupPath = (fileParam) => {
  if (!fileParam) return null;
  return path.join(VALHEIM_BACKUPS_DIR, path.basename(fileParam));
};

/**
 * Отправить файл в Telegram (sendDocument, лимит 50 MB)
 * @param {string} chatId
 * @param {string} filePath
 * @param {string} [caption]
 */
const sendDocument = async (chatId, filePath, caption) => {
  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);

  if (DEBUG) {
    console.log(`[sendDocument] 📎 ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB) → ${chatId}`);
    return;
  }

  if (stat.size > TG_MAX_DOCUMENT_BYTES) {
    throw new Error(`file too large: ${stat.size} bytes (max ${TG_MAX_DOCUMENT_BYTES})`);
  }

  const fileData = fs.readFileSync(filePath);
  const boundary = `----Valheim${Date.now()}${Math.random().toString(36).slice(2)}`;

  /** @param {string} name @param {string} value */
  const fieldPart = (name, value) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

  const parts = [
    Buffer.from(fieldPart("chat_id", chatId)),
  ];
  if (caption) {
    parts.push(Buffer.from(fieldPart("caption", caption)));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
    ),
    fileData,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const options = tgRequestOptions(`/bot${TOKEN}/sendDocument`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    });
    const req = TG_API_TRANSPORT.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed.ok) {
            reject(new Error(parsed.description || raw));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(raw));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
};

/**
 * @param {string} filePath
 * @param {string} [caption]
 */
const sendDocumentToChats = async (chatIdsToNotify, filePath, caption) => {
  if (chatIdsToNotify.length === 0) return;
  let anyOk = false;
  for (const chat_id of chatIdsToNotify) {
    try {
      await sendDocument(chat_id, filePath, caption);
      anyOk = true;
    } catch (err) {
      console.error(`[hooks] ❌ sendDocument ${chat_id}: ${err.message}`);
    }
  }
  if (!anyOk) throw new Error("sendDocument failed for all recipients");
};

const sendDocumentToHooks = (filePath, caption) =>
  sendDocumentToChats(hooksChatIds, filePath, caption);

let manualBackupInProgress = false;

const runFile = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 180000, maxBuffer: 1024 * 1024, ...options }, (err, stdout, stderr) => {
    if (err) {
      err.message += stderr ? "\n" + stderr.trim() : "";
      reject(err);
    } else resolve({ stdout, stderr });
  });
});

const getActiveWorldName = () => {
  const raw = fs.readFileSync(VALHEIM_WORLD_ENV_FILE, "utf8");
  const match = raw.match(/^WORLD_NAME=(.+)$/m);
  if (!match) throw new Error("WORLD_NAME не найден");
  const world = match[1].trim();
  if (!world || world.length > 64 || /[\\/\r\n\0=]/.test(world)) throw new Error("Некорректное имя активного мира");
  return world;
};

/** Создать ZIP только активного мира: legacy .db/.fwl или каталог сегментированного мира. */
const triggerValheimBackup = async (chatId) => {
  if (manualBackupInProgress) {
    await sendMessage("⏳ Бэкап уже создаётся", undefined, chatId);
    return;
  }
  manualBackupInProgress = true;
  try {
    await sendMessage("⏳ Создание бэкапа активного мира...", undefined, chatId);
    const world = getActiveWorldName();
    const db = path.join(VALHEIM_WORLDS_DIR, world + ".db");
    const fwl = path.join(VALHEIM_WORLDS_DIR, world + ".fwl");
    const worldDir = path.join(VALHEIM_WORLDS_DIR, world);
    const hasDb = fs.existsSync(db) && fs.statSync(db).isFile();
    const hasFwl = fs.existsSync(fwl) && fs.statSync(fwl).isFile();
    let zipArgs;
    let zipOptions = {};
    let formatLabel;
    if (hasDb && hasFwl) {
      zipArgs = ["-j", "-q"];
      formatLabel = ".db + .fwl";
    } else if (hasDb || hasFwl) {
      throw new Error("Найдена только часть legacy-мира " + world + ": нужны оба файла .db и .fwl");
    } else if (fs.existsSync(worldDir) && fs.statSync(worldDir).isDirectory()) {
      const names = new Set(fs.readdirSync(worldDir));
      const hasCompleteMain = [...names].some((name) => {
        const match = name.match(/^_main\.(\d+)\.ok$/);
        if (!match) return false;
        const prefix = "_main." + match[1];
        return names.has(prefix + ".db2") && names.has(prefix + ".fwl2") && names.has(prefix + ".chunks");
      });
      if (!hasCompleteMain) throw new Error("Каталог активного мира " + world + " не содержит завершённого набора _main");
      zipArgs = ["-r", "-D", "-q"];
      zipOptions = { cwd: VALHEIM_WORLDS_DIR };
      formatLabel = "сегментированный формат";
    } else {
      throw new Error("Не найден активный мир " + world + " ни в формате .db/.fwl, ни как каталог");
    }
    const dir = path.join(__dirname, "data", "manual-backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = path.join(dir, world + "-" + stamp + ".zip");
    const sources = hasDb && hasFwl ? [db, fwl] : [world];
    await runFile("zip", [...zipArgs, archive, ...sources], zipOptions);
    await sendDocument(chatId, archive, "💾 Бэкап активного мира " + world + " (" + formatLabel + ")");
  } catch (err) {
    console.error("[bot] /backup →", err.message);
    await sendMessage("❌ Не удалось создать бэкап: " + err.message, undefined, chatId);
  } finally {
    manualBackupInProgress = false;
  }
};

// ======== Обработка update от Telegram (общая для обоих режимов) ========

const restoreManager = createRestoreManager({
  token: TOKEN,
  apiUrl: TG_API_URL.toString(),
  apiFileUrl: TG_API_FILE_URL,
  maxFileBytes: TG_MAX_DOCUMENT_BYTES,
  adminId: TG_ADMIN_ID,
  container: VALHEIM_CONTAINER,
  worldsDir: VALHEIM_WORLDS_DIR,
  projectDir: VALHEIM_PROJECT_DIR,
  worldEnvFile: VALHEIM_WORLD_ENV_FILE,
  backupsDir: VALHEIM_BACKUPS_DIR,
  dataDir: path.join(__dirname, "data"),
  onlinePlayers,
  sendMessage,
  sendDocument,
});
const updater = createUpdater({
  adminId: TG_ADMIN_ID,
  notify: (text, chat) => sendMessage(text, undefined, chat || TG_ADMIN_ID),
  isBusy: () => manualBackupInProgress || restoreManager.isBusy(),
});

const handleUpdate = async (update) => {
  if (!update.message) return;

  const userId = update.message.from.id.toString();
  const chatId = update.message.chat.id.toString();
  const rawText = update.message.text;
  const text = typeof rawText === "string"
    ? rawText.trim().replace(/^\/([A-Za-z0-9_]+)@[A-Za-z0-9_]+(?=\s|$)/, "/$1")
    : rawText;
  console.log(`[bot] Команда от ${userId} в чате ${chatId}: ${rawText}`);

  if (await updater.handleUpdate(update)) return;
  if (updater.isApplying() && (update.message.document || String(text).startsWith("/restore") || text === "/backup")) {
    await sendMessage("⏳ Идёт обновление бота. Повторите backup/restore после завершения.", undefined, chatId);
    return;
  }
  if (await restoreManager.handleUpdate(update)) return;

  if (text === "/start") {
    if (!chatIds.includes(chatId)) {
      chatIds.push(chatId);
      saveChatIds();
      console.log(`[bot] ✅ Чат ${chatId} подписан на уведомления`);
    }
    sendMessage("✅ Этот чат подписан на уведомления Valheim", undefined, chatId);
  } else if (text === "/stop") {
    chatIds = chatIds.filter((id) => id !== chatId);
    saveChatIds();
    console.log(`[bot] ⛔️ Чат ${chatId} отписан от событий`);
    sendMessage("⛔️ Чат отписан от событий Valheim", undefined, chatId);
  } else if (text === "/status") {
    try {
      await sendMessage(await getServerStatus(VALHEIM_CONTAINER, onlinePlayers.size), undefined, chatId);
    } catch {
      await sendMessage("❌ Не удалось получить статус сервера", undefined, chatId);
    }
  } else if (text === "/online") {
    console.log("[bot] /online →", onlinePlayers.size);
    if (onlinePlayers.size === 0) {
      sendMessage("👤 Сейчас никто не играет", undefined, chatId);
    } else {
      sendMessage(buildOnlineListText(), undefined, chatId);
    }
  } else if (text === "/stats") {
    console.log("[bot] /stats");
    sendMessage(buildStatsText(), undefined, chatId);
  } else if (text === "/backup") {
    console.log(`[bot] /backup от ${userId}`);
    triggerValheimBackup(chatId);
  } else if (text === "/hooks_on") {
    if (!hooksChatIds.includes(chatId)) {
      hooksChatIds.push(chatId);
      saveHooksChatIds();
      console.log(`[bot] ✅ Чат ${chatId} подписан на Valheim-хуки`);
    }
    sendMessage("✅ Чат подписан на события сервера (хуки)", undefined, chatId);
  } else if (text === "/hooks_off") {
    hooksChatIds = hooksChatIds.filter((id) => id !== chatId);
    saveHooksChatIds();
    console.log(`[bot] ⛔️ Чат ${chatId} отписан от Valheim-хуков`);
    sendMessage("⛔️ Чат отписан от событий сервера (хуки)", undefined, chatId);
  } else if (text === "/help") {
    sendMessage(
      "💡 Список команд:\n" +
      "/start - подписаться на уведомления об игроках\n" +
      "/stop - отписаться от уведомлений об игроках\n" +
      "/hooks_on - подписаться на события сервера (хуки)\n" +
      "/hooks_off - отписаться от событий сервера\n" +
      "/status - статус сервера\n" +
      "/online - игроки онлайн и время текущей сессии\n" +
      "/stats - суммарное время игроков\n" +
      "/backup - бэкап активного мира без .old\n" +
      "/restore - начать восстановление мира (админ)\n" +
      "/restore_url - добавить ссылку Яндекс Диска (админ)\n" +
      "/restore_world_N - выбрать мир из общего ZIP (админ)\n" +
      "/bot_version - версия бота и автообновление\n" +
      "/bot_update_check - проверить релиз бота (админ)\n" +
      "/bot_update - установить свежий релиз бота (админ)",
      undefined, chatId
    );
  } else if (text) {
    sendMessage("❓ Команда не распознана. Напишите /help для списка команд.", undefined, chatId);
  }
};

// ======== Режим: TG Webhook ========

const setupTgWebhook = async () => {
  const params = { url: TG_WEBHOOK_URL };
  if (TG_WEBHOOK_SECRET) params.secret_token = TG_WEBHOOK_SECRET;

  try {
    const res = await tgPost("setWebhook", params);
    if (res.ok) {
      console.log(`🔗 TG webhook зарегистрирован: ${TG_WEBHOOK_URL}`);
      updater.markTelegramReady();
    } else {
      console.error("[tg-webhook] ❌ setWebhook:", JSON.stringify(res));
    }
  } catch (err) {
    console.error("[tg-webhook] ❌ setWebhook:", JSON.stringify(err));
  }

  const webhookPath = new URL(TG_WEBHOOK_URL).pathname;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== webhookPath) {
      res.writeHead(404).end();
      return;
    }

    if (TG_WEBHOOK_SECRET) {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (secret !== TG_WEBHOOK_SECRET) {
        console.warn("[tg-webhook] ⚠️ Неверный secret_token, запрос отклонён");
        res.writeHead(403).end();
        return;
      }
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200).end("ok");
      try {
        handleUpdate(JSON.parse(body)).catch((err) => console.error("[tg-webhook] handleUpdate:", err));
      } catch (err) {
        console.error("[tg-webhook] ❌ Ошибка парсинга:", JSON.stringify(err));
      }
    });
  });

  server.listen(TG_WEBHOOK_PORT, "0.0.0.0", () => {
    console.log(`🌐 TG webhook слушает http://0.0.0.0:${TG_WEBHOOK_PORT}${webhookPath}`);
  });

  return server;
};

// ======== Режим: Polling (getUpdates) ========

const GET_UPDATES_RETRY_MS = 5000;
let lastUpdateId = -1;
let pollTimeoutId = null;

const startPolling = () => {
  const poll = async () => {
    try {
      const res = await tgGet("getUpdates", {
        offset: String(lastUpdateId + 1),
        timeout: "30",
      });
      if (!res.ok) throw new Error("Telegram getUpdates failed");
      updater.markTelegramReady();

      const updates = res.result || [];
      if (updates.length > 0) {
        console.log(`[polling] Обновления получены: ${updates.length} шт.`);
      }

      for (const update of updates) {
        lastUpdateId = update.update_id;
        await handleUpdate(update);
      }

      pollTimeoutId = setTimeout(poll, 0);
    } catch (err) {
      console.error("[polling] Ошибка:", JSON.stringify(err));
      pollTimeoutId = setTimeout(poll, GET_UPDATES_RETRY_MS);
    }
  };

  // Удаляем webhook если он был установлен ранее
  tgPost("deleteWebhook", {}).then(() => {
    console.log("🔄 Polling запущен");
    poll();
  }).catch(() => {
    console.log("🔄 Polling запущен");
    poll();
  });
};

// ======== Valheim hooks (HTTP) ========

/** @type {Record<string, string>} */
const VALHEIM_HOOK_LABELS = {
  post_bootstrap: "🔧 Запуск контейнера...",
  pre_start: "🚀 Запуск...",
  post_start: "🚀 Сервер запущен",
  pre_server_run: "⏳ Запуск сервера...",
  post_server_listening: "✅ Сервер готов к подключению",
  pre_server_shutdown: "⏹️ Остановка сервера...",
  post_server_shutdown: "🛑 Сервер остановлен",
  pre_restart: "🔄 Перезапуск сервера...",
  post_restart: "♻️ Сервер перезапущен",
  pre_update_check: "🔍 Проверка обновлений...",
  post_update_check: "✅ Проверка обновлений завершена",
  pre_backup: "⏳ Создание бэкапа...",
  post_backup: "💾 Бэкап создан",
};

/** @type {Record<string, string[]>} */
const HOOK_SEQUENCES = {
  startup: ["pre_start", "pre_server_run", "post_server_listening"],
  restart: ["pre_restart", "pre_start", "pre_server_run", "post_server_listening"],
};

const HOOK_SEQUENCE_STARTERS = new Set(["pre_restart"]);

/** @type {{ type: string, lines: string[], messageIds: Map<string, number> } | null} */
let hookSequence = null;

/**
 * @param {string} event
 * @returns {string|null}
 */
const resolveHookSequence = (event) => {
  if (event === "pre_restart") return "restart";
  if (hookSequence && HOOK_SEQUENCES[hookSequence.type]?.includes(event)) return hookSequence.type;
  if (["pre_start", "pre_server_run", "post_server_listening"].includes(event)) return "startup";
  return null;
};

/**
 * @param {string} event
 * @returns {Promise<boolean>}
 */
const handleHookSequenceEvent = async (event) => {
  const seqName = resolveHookSequence(event);
  if (!seqName) return false;

  const seqEvents = HOOK_SEQUENCES[seqName];
  if (!seqEvents.includes(event)) return false;

  const label = VALHEIM_HOOK_LABELS[event];
  if (!label) return false;

  const isStarter = HOOK_SEQUENCE_STARTERS.has(event) || (event === "pre_start" && !hookSequence);

  if (isStarter || !hookSequence || hookSequence.type !== seqName) {
    hookSequence = {
      type: seqName,
      lines: [label],
      messageIds: await sendHooksProgressMessages(label),
    };
  } else if (hookSequence.lines[hookSequence.lines.length - 1] !== label) {
    hookSequence.lines.push(label);
    await editHooksProgressMessages(hookSequence.messageIds, hookSequence.lines.join("\n"));
  }

  if (event === seqEvents[seqEvents.length - 1]) {
    hookSequence = null;
  }

  return true;
};

/**
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<Record<string, string>>}
 */
const readValheimHookPayload = (req) => {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(typeof parsed === "object" && parsed ? parsed : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
};

/**
 * @param {Record<string, string>} payload
 * @returns {string|null}
 */
const formatValheimHookMessage = (payload) => {
  const event = payload.event;
  if (!event) return null;

  const label = VALHEIM_HOOK_LABELS[event] || `📣 ${event}`;
  const parts = [label];

  if (payload.file) {
    parts.push(`📁 ${path.basename(payload.file)}`);
  }
  if (payload.message) {
    parts.push(payload.message);
  }

  return parts.join("\n");
};

/**
 * @param {Record<string, string>} payload
 * @param {string} timeStr
 */
const handleValheimHook = async (payload, timeStr) => {
  if (payload.event === "pre_update_check") {
    startUpdateProgressTracking();
    return;
  }

  if (payload.event === "post_update_check") {
    await finishUpdateProgressTracking(timeStr);
    return;
  }

  if (payload.event === "post_backup" && payload.file) {
    const backupPath = resolveBackupPath(payload.file);
    const caption = VALHEIM_HOOK_LABELS.post_backup;
    const requestedChats = [...pendingBackupChatIds];
    pendingBackupChatIds.clear();
    const targetChats = [...new Set([...hooksChatIds, ...requestedChats])];

    if (backupPath && fs.existsSync(backupPath)) {
      console.log(`[valheim-hook] 📤 Загружаем бэкап в ${targetChats.length} чат(ов): ${backupPath}`);
      try {
        await sendDocumentToChats(targetChats, backupPath, caption);
        return;
      } catch (err) {
        console.error(`[valheim-hook] ❌ sendDocument: ${err.message}`);
        await Promise.all(targetChats.map((chatId) =>
          sendHooksMessage(`${caption}\n📁 ${path.basename(backupPath)}\n⚠️ Не удалось отправить файл`, timeStr, chatId)
        ));
        return;
      }
    }

    console.warn(`[valheim-hook] ⚠️ Бэкап не найден: ${backupPath ?? payload.file}`);
    await Promise.all(targetChats.map((chatId) =>
      sendHooksMessage(`${caption}\n📁 ${path.basename(payload.file)}\n⚠️ Файл недоступен`, timeStr, chatId)
    ));
    return;
  }

  if (await handleHookSequenceEvent(payload.event)) return;

  const text = formatValheimHookMessage(payload);
  if (text) await sendHooksMessage(text, timeStr);
};

let valheimHookServer = null;

const setupValheimHookServer = () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${VALHEIM_HOOK_PORT}`);

    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    if (url.pathname !== VALHEIM_HOOK_PATH) {
      res.writeHead(404).end();
      return;
    }

    if (VALHEIM_HOOK_SECRET) {
      const secret = req.headers["x-valheim-hook-secret"];
      if (secret !== VALHEIM_HOOK_SECRET) {
        console.warn("[valheim-hook] ⚠️ Неверный X-Valheim-Hook-Secret");
        res.writeHead(403).end();
        return;
      }
    }

    /** @type {Record<string, string>} */
    let payload = Object.fromEntries(url.searchParams.entries());

    if (req.method === "POST") {
      try {
        const body = await readValheimHookPayload(req);
        payload = { ...payload, ...body };
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }
    }

    const text = formatValheimHookMessage(payload);
    if (!text) {
      res.writeHead(400).end("missing event");
      return;
    }

    const timeStr = new Date().toLocaleString("ru-RU");
    console.log(`${timeStr} [valheim-hook]: ${text.replace(/\n/g, " | ")}`);

    try {
      await handleValheimHook(payload, timeStr);
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    } catch (err) {
      console.error(`[valheim-hook] ❌ ${err.message}`);
      res.writeHead(500).end("error");
    }
  });

  server.listen(VALHEIM_HOOK_PORT, "0.0.0.0", () => {
    console.log(`🪝 Valheim hook: http://0.0.0.0:${VALHEIM_HOOK_PORT}${VALHEIM_HOOK_PATH}`);
  });

  return server;
};

valheimHookServer = setupValheimHookServer();

// ======== Graceful shutdown ========

let tgWebhookServer = null;

const shutdown = (signal) => {
  console.log(`[shutdown] Получен ${signal} — останавливаемся`);
  if (pollTimeoutId) clearTimeout(pollTimeoutId);
  if (dockerLogsReconnectTimer) clearTimeout(dockerLogsReconnectTimer);
  stopSteamLogWatcher();
  if (dockerLogs && !dockerLogs.killed) dockerLogs.kill("SIGTERM");
  const finish = () => {
    if (tgWebhookServer) tgWebhookServer.close();
    if (valheimHookServer) valheimHookServer.close();
    process.exit(0);
  };
  sendMessage("🛑 Наблюдатель остановлен", undefined, TG_ADMIN_ID)
    .then(finish).catch(finish);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ======== Запуск режима Telegram ========

if (!DEBUG) {
  if (TG_MODE === "webhook") {
    setupTgWebhook().then((srv) => { tgWebhookServer = srv; });
  } else {
    startPolling();
  }
}

const DOCKER_LOGS_RECONNECT_MS = 3000;
const DOCKER_LOGS_STOPPED_POLL_MS = 30000;
const STEAM_STDERR_LOG = path.join(__dirname, "..", "logs", "steam", "stderr.txt");

let dockerLogs = null;
let dockerLogsReconnectTimer = null;
/** При true — только обновляем состояние игроков, без уведомлений в Telegram */
let dockerLogsReplayOnly = false;
let steamLogWatcher = null;
let steamLogOffset = 0;

const processDockerLogLines = (chunk) => {
  const notify = !dockerLogsReplayOnly;
  const lines = chunk.split("\n");
  /** @type {{ state: string, percent: number|null, current: number, total: number } | null} */
  let bestProgress = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const parsed = parseSteamUpdateProgress(line);
    if (parsed && (bestProgress === null || (parsed.percent ?? 0) >= (bestProgress.percent ?? 0))) {
      bestProgress = parsed;
    }

    const joinMatch = line.match(/Got character ZDOID from (.+?) :(?:\s*(-?\d+))?/);
    const leaveMatch = line.match(/Destroying abandoned non persistent zdo .* owner (-?\d+)$/);
    const logTime = parseLogTimestamp(line);
    const logTimeStamp = logTime ? logTime.getTime() : Date.now();
    const timeStr = logTime ? logTime.toLocaleString("ru-RU") : "";

    if (joinMatch) {
      const name = joinMatch[1];
      const id = joinMatch[2];
      if (!id || id === "0") continue;
      const alreadyOnline = onlinePlayers.has(name);
      onlinePlayers.add(name);
      playerIdToName.set(id, name);
      if (alreadyOnline) {
        const lastSpawn = playerIdToLastSpawnTime.get(id);
        const livedStr = lastSpawn ? formatDuration(logTimeStamp - lastSpawn) : "?";
        playerIdToLastSpawnTime.set(id, logTimeStamp);
        const deaths = (playerIdToDeathCount.get(id) ?? 0) + 1;
        playerIdToDeathCount.set(id, deaths);
        if (!DEBUG)
          console.log(`${timeStr} [dockerLogs]: 💀 Игрок возродился: ${name}, id: ${id}, прожил: ${livedStr}`);
        if (notify) sendMessage(`💀 Игрок возродился: ${name} (прожил ${livedStr})`, timeStr);
      } else {
        playerIdToJoinTime.set(id, logTimeStamp);
        playerIdToLastSpawnTime.set(id, logTimeStamp);
        if (!DEBUG)
          console.log(`${timeStr} [dockerLogs]: 🟢 Игрок подключился: ${name}, id: ${id}`);
        if (notify) sendMessage(`🟢 Игрок подключился: ${name}`, timeStr);
      }
    }

    if (leaveMatch) {
      const id = leaveMatch[1];
      const name = playerIdToName.get(id);
      if (!name) continue;
      const joinTime = playerIdToJoinTime.get(id);
      const durationStr = joinTime ? formatDuration(logTimeStamp - joinTime) : "?";
      const deaths = playerIdToDeathCount.get(id) ?? 0;
      if (notify && joinTime) addPlayerSession(name, Math.max(0, logTimeStamp - joinTime), logTimeStamp);
      onlinePlayers.delete(name);
      playerIdToName.delete(id);
      playerIdToJoinTime.delete(id);
      playerIdToLastSpawnTime.delete(id);
      playerIdToDeathCount.delete(id);
      const deathsStr = deaths === 0 ? "смертей: 0" : `смертей: ${deaths}`;
      if (!DEBUG)
        console.log(`${timeStr} [dockerLogs]: 🔴 Игрок вышел: ${name}, id: ${id}, время в игре: ${durationStr}, ${deathsStr}`);
      if (notify) sendMessage(`🔴 Игрок вышел: ${name} (время в игре: ${durationStr}, ${deathsStr})`, timeStr);
    }
  }

  if (bestProgress && notify) applyUpdateProgressParsed(bestProgress);
};

const buildDockerLogsArgs = (tail) => {
  if (DEBUG) return ["logs", VALHEIM_CONTAINER];
  return ["logs", "-f", "--tail", String(tail), VALHEIM_CONTAINER];
};

const isValheimContainerRunning = () =>
  new Promise((resolve) => {
    exec(
      `docker inspect -f '{{.State.Running}}' ${VALHEIM_CONTAINER}`,
      (err, stdout) => resolve(!err && stdout.trim() === "true")
    );
  });

/** Прочитать хвост логов без уведомлений — восстановить состояние онлайна после перезапуска */
const catchUpDockerLogs = (tail) =>
  new Promise((resolve) => {
    dockerLogsReplayOnly = true;
    console.log(`[dockerLogs] Догоняем состояние: --tail ${tail} (без уведомлений)`);
    const proc = spawn("docker", ["logs", "--tail", String(tail), VALHEIM_CONTAINER]);
    const onData = (data) => processDockerLogLines(data.toString());
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", () => {
      dockerLogsReplayOnly = false;
      resolve();
    });
  });

const tryReconnectDockerLogs = async () => {
  const running = await isValheimContainerRunning();
  if (!running) {
    console.log(`[dockerLogs] Контейнер остановлен — ждём ${DOCKER_LOGS_STOPPED_POLL_MS / 1000}s`);
    clearPlayerState();
    dockerLogsReconnectTimer = setTimeout(() => {
      dockerLogsReconnectTimer = null;
      tryReconnectDockerLogs();
    }, DOCKER_LOGS_STOPPED_POLL_MS);
    return;
  }
  await catchUpDockerLogs(200);
  startDockerLogs(0);
};

const scheduleDockerLogsReconnect = () => {
  if (DEBUG || dockerLogsReconnectTimer) return;
  console.log(`[dockerLogs] Переподключение через ${DOCKER_LOGS_RECONNECT_MS}ms...`);
  dockerLogsReconnectTimer = setTimeout(() => {
    dockerLogsReconnectTimer = null;
    tryReconnectDockerLogs();
  }, DOCKER_LOGS_RECONNECT_MS);
};

/** @param {number} [tail] */
const startDockerLogs = (tail = 0) => {
  if (dockerLogs && !dockerLogs.killed) {
    dockerLogs.removeAllListeners();
    dockerLogs.kill("SIGTERM");
  }

  const args = buildDockerLogsArgs(tail);
  console.log("[dockerLogs] Подключаемся:", args.join(" "));

  dockerLogs = spawn("docker", args);

  dockerLogs.on("error", (err) => {
    console.error("[dockerLogs] Error:", err.message);
    scheduleDockerLogsReconnect();
  });

  dockerLogs.on("close", (code, signal) => {
    console.log(`[dockerLogs] closed code=${code} signal=${signal}`);
    if (DEBUG) {
      console.log("[dockerLogs] Все логи прочитаны, завершаем работу");
      process.exit(0);
    }
    scheduleDockerLogsReconnect();
  });

  dockerLogs.stderr.on("data", (data) => {
    processDockerLogLines(data.toString());
  });

  dockerLogs.stdout.on("data", (data) => {
    processDockerLogLines(data.toString());
  });
};

sendMessage(`🟢 Наблюдатель запущен`, new Date().toLocaleString("ru-RU"), TG_ADMIN_ID);
tryReconnectDockerLogs();
if (!DEBUG) updater.start();
