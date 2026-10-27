const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { compareVersions, validateRelease, sha256, writeJson, RUNTIME_FILES } = require("./release-schema");
const { execute } = require("./update-runner");
const CURRENT_VERSION = require("./version.json").version;
const TERMINAL = new Set(["success", "rolled_back", "failed", "rollback_failed"]);
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

const getLatestRelease = async (repository) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid release repository");
  const response = await fetch("https://api.github.com/repos/" + repository + "/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "valheim-watcher-updater" }, signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("GitHub release check failed (HTTP " + response.status + ")");
  const release = await response.json();
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error("Expected a published stable release");
  const asset = release.assets.find((entry) => entry.name === "valheim-watcher.zip" && entry.state === "uploaded");
  if (!asset || asset.size > 8 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) throw new Error("Release package or GitHub SHA-256 digest is missing");
  const url = new URL(asset.browser_download_url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/" + repository + "/releases/download/" + release.tag_name + "/")) throw new Error("Unexpected release download URL");
  return { version: release.tag_name.slice(1), tag: release.tag_name, url: url.toString(), digest: asset.digest.slice(7) };
};

const downloadPackage = async (release, archive) => {
  let url = release.url;
  let response;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname)) throw new Error("Unexpected release download host");
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel(); url = new URL(response.headers.get("location"), url).toString(); continue;
    }
    break;
  }
  if (!response?.ok) throw new Error("Release package download failed");
  const fd = fs.openSync(archive, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error("Release package exceeds 8 MB");
      fs.writeSync(fd, chunk);
    }
  } finally { fs.closeSync(fd); }
  if (sha256(archive) !== release.digest) throw new Error("Release package SHA-256 mismatch");
};

const prepareRelease = async (release, directory, runtime = {}) => {
  const run = runtime.run || execute;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = path.join(directory, "package.zip");
  await (runtime.download || downloadPackage)(release, archive);
  const names = (await run("unzip", ["-Z1", archive])).stdout.trim().split("\n").sort();
  if (JSON.stringify(names) !== JSON.stringify([...RUNTIME_FILES, "release.json"].sort())) throw new Error("Release ZIP contains unexpected or missing files");
  const details = (await run("unzip", ["-Z", "-l", archive])).stdout;
  if (details.split("\n").some((line) => /^[a-z?][rwxstST-]{9}\s/.test(line))) throw new Error("Release ZIP contains a link or special file");
  const listing = (await run("unzip", ["-l", archive])).stdout.match(/^\s*(\d+)\s+(\d+)\s+files?\s*$/m);
  if (!listing || Number(listing[1]) > 8 * 1024 * 1024) throw new Error("Expanded release package exceeds 8 MB");
  const candidate = path.join(directory, "candidate");
  await run("unzip", ["-o", archive, "-d", candidate]);
  const manifest = validateRelease(candidate);
  if (manifest.version !== release.version || manifest.tag !== release.tag) throw new Error("Package does not match the GitHub release");
  return candidate;
};

const createUpdater = (options = {}, runtime = {}) => {
  const root = options.root || "/app/data/updater";
  const repository = options.repository ?? process.env.WATCHER_RELEASE_REPO ?? "";
  const enabled = options.enabled ?? process.env.WATCHER_AUTO_UPDATE === "true";
  const container = options.container || process.env.WATCHER_CONTAINER || "valheim-watcher";
  const version = options.version || CURRENT_VERSION;
  const notify = options.notify || (async () => {});
  const busy = options.isBusy || (() => false);
  const run = runtime.run || execute;
  const activeFile = path.join(root, "active.json"), stateFile = path.join(root, "state.json");
  const startedAt = Date.now();
  let telegramReady = false, checking = false, reporting = false;
  const health = () => writeJson(path.join(root, "health.json"), { version, startedAt, heartbeatAt: Date.now(), telegramReady });
  const reportCompletion = async () => {
    if (reporting) return;
    reporting = true;
    try {
      const active = readJson(activeFile, null);
      if (!active) return;
      const file = path.join(root, active.id, "status.json");
      let outcome = readJson(file);
      if (!TERMINAL.has(outcome.phase) && Date.now() - active.startedAt > 15 * 60 * 1000) {
        let running = true;
        try { running = (await run("docker", ["inspect", "--format", "{{.State.Running}}", "watcher-update-" + active.id])).stdout.trim() === "true"; }
        catch { running = false; }
        if (!running) {
          outcome = { ...outcome, id: active.id, phase: "rollback_failed", error: "Update runner stopped unexpectedly", updatedAt: Date.now() };
          writeJson(file, outcome);
        }
      }
      if (!TERMINAL.has(outcome.phase)) return;
      const state = readJson(stateFile);
      if (state.lastNotified !== active.id) {
        writeJson(stateFile, { ...state, lastNotified: active.id, lastOutcome: outcome.phase,
          failedVersion: outcome.phase === "success" ? null : outcome.version });
        const message = outcome.phase === "success" ? "✅ Бот обновлён до " + outcome.version :
          outcome.phase === "rolled_back" ? "⚠️ Обновление " + outcome.version + " не запустилось. Вернул предыдущую версию бота." :
            outcome.phase === "rollback_failed" ? "❌ Обновление бота требует проверки: автоматический откат не завершился." : "❌ Обновление бота не выполнено; прежняя версия сохранена.";
        await notify(message, active.chat);
      }
      // Keep the lock for an incomplete rollback; do not apply another release on top of it.
      if (outcome.phase !== "rollback_failed") {
        fs.rmSync(activeFile, { force: true });
        await run("docker", ["rm", "watcher-update-" + active.id]).catch(() => {});
      }
    } finally { reporting = false; }
  };
  const check = async ({ apply = false, manual = false, chat = null } = {}) => {
    if (checking) return { status: "busy", current: version };
    if (!repository) return { status: "disabled", current: version };
    checking = true;
    let owned = null, launched = false;
    try {
      await reportCompletion();
      if (fs.existsSync(activeFile)) return { status: "busy", current: version };
      const release = await (runtime.latest || getLatestRelease)(repository);
      const state = readJson(stateFile);
      writeJson(stateFile, { ...state, latest: release?.version || null, lastChecked: Date.now(), lastError: null });
      if (!release || compareVersions(release.version, version) <= 0) return { status: "current", current: version, latest: release?.version };
      if (!apply) return { status: "available", current: version, latest: release.version };
      if (busy()) return { status: "deferred", current: version, latest: release.version };
      if (!manual && state.failedVersion === release.version) return { status: "failed_version", current: version, latest: release.version };
      const id = randomUUID(), directory = path.join(root, id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(activeFile, JSON.stringify({ id, chat, startedAt: Date.now() }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code === "EEXIST") return { status: "busy", current: version }; throw error; }
      owned = id;
      writeJson(path.join(directory, "status.json"), { id, version: release.version, phase: "preparing", updatedAt: Date.now() });
      const candidate = await (runtime.prepare || prepareRelease)(release, directory);
      if (busy()) return { status: "deferred", current: version, latest: release.version };
      const inspected = JSON.parse((await run("docker", ["inspect", container])).stdout)[0];
      const sourceDir = inspected.Config.Labels["com.docker.compose.project.working_dir"];
      const data = inspected.Mounts.find((mount) => mount.Destination === "/app/data" && mount.Type === "bind" && mount.RW);
      if (!data || !sourceDir || !path.isAbsolute(sourceDir) || inspected.Config.Labels["com.docker.compose.service"] !== "watcher") throw new Error("Unsupported watcher deployment layout");
      const job = { id, root, candidate, version: release.version, previousVersion: version, previousImage: inspected.Image, sourceDir, container };
      const jobFile = path.join(directory, "job.json"); writeJson(jobFile, job);
      await notify("♻️ Обновляю бота " + version + " → " + release.version + "...", chat);
      await run("docker", ["run", "--detach", "--name", "watcher-update-" + id, "--label", "valheim-watcher.update=true",
        "--volume", "/var/run/docker.sock:/var/run/docker.sock", "--volume", data.Source + ":/app/data",
        "--volume", sourceDir + ":" + sourceDir, inspected.Image, "node", "/app/update-runner.js", jobFile]);
      launched = true;
      return { status: "updating", current: version, latest: release.version };
    } catch (error) {
      const state = readJson(stateFile);
      // GitHub and Docker errors are sanitized by the request/command layers.
      const message = error.message;
      writeJson(stateFile, { ...state, lastError: message });
      if (!manual && state.lastError !== message) await notify("⚠️ Не удалось проверить или скачать обновление бота: " + message);
      return { status: "error", current: version, error: message };
    } finally {
      if (owned && !launched && readJson(activeFile).id === owned) fs.rmSync(activeFile, { force: true });
      checking = false;
    }
  };
  const describe = (result) => {
    if (result.status === "updating") return null;
    if (result.status === "available") return "🆕 Доступна версия бота " + result.latest + ". Установить: /bot_update";
    if (result.status === "current") return "✅ Бот " + version + ": новых релизов нет.";
    if (result.status === "busy") return "⏳ Обновление бота уже выполняется.";
    if (result.status === "deferred") return "⏳ Идёт backup/restore или управление сервером. Обновление отложено до завершения операции.";
    if (result.status === "disabled") return "Не настроен WATCHER_RELEASE_REPO.";
    return "❌ Проверка обновления не выполнена: " + (result.error || "эта версия ранее не прошла проверку запуска");
  };
  const handleUpdate = async (update) => {
    const message = update.message;
    const command = String(message?.text || "").trim().replace(/@[A-Za-z0-9_]+$/, "");
    if (!["/bot_update", "/bot_update_check", "/bot_version"].includes(command)) return false;
    const chat = String(message.chat.id);
    if (command === "/bot_version") {
      const state = readJson(stateFile);
      await notify("🤖 Версия бота: " + version + "\nАвтообновление: " + (enabled ? "раз в час" : "выключено") +
        (state.latest ? "\nПоследний найденный релиз: " + state.latest : ""), chat);
    } else if (String(message.from?.id) !== String(options.adminId || "")) await notify("⛔️ Обновление доступно только администратору", chat);
    else { const result = describe(await check({ apply: command === "/bot_update", manual: true, chat })); if (result) await notify(result, chat); }
    return true;
  };
  const start = () => {
    health();
    const heartbeat = setInterval(() => { health(); reportCompletion().catch(() => {}); }, 5000); heartbeat.unref();
    if (enabled && repository) {
      const timer = setInterval(() => { check({ apply: true }).catch(() => {}); }, 3600000); timer.unref();
      const first = setTimeout(() => { check({ apply: true }).catch(() => {}); }, 15000); first.unref();
    }
  };
  return { start, check, handleUpdate, reportCompletion, isApplying: () => fs.existsSync(activeFile), markTelegramReady: () => { telegramReady = true; health(); }, version };
};
module.exports = { createUpdater, prepareRelease, getLatestRelease, downloadPackage };
