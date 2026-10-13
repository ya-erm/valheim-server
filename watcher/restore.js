// @ts-check
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { worldName, validateSegmented, snapshotWorld, replaceWorld, rollbackWorld } = require("./world-files");

const LIMIT = 20 * 1024 * 1024;
const RESTORE_HELP = (maxFileBytes = LIMIT) => "♻️ Отправьте ZIP с каталогом сегментированного мира (_main.* и чанки), с одной или несколькими парами .db + .fwl либо два legacy-файла отдельно.\nЛимит файла: " + Math.floor(maxFileBytes / 1048576) + " МБ; большой мир также можно отправить публичной ссылкой Яндекс Диска (ZIP, файл или папка).\nВ группе используйте /restore <ссылка>, затем /restore_url <ссылка>.\nСессия: 30 минут.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (file, args, timeout = 180000) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      err.message += stderr ? "\n" + stderr.trim() : "";
      reject(err);
    } else resolve({ stdout, stderr });
  });
});

const fwlName = (file) => {
  const b = fs.readFileSync(file);
  if (b.length < 12 || b.length > 1024 * 1024) throw new Error("Некорректный .fwl");
  let len = 0, shift = 0, pos = 8;
  for (;;) {
    if (pos >= b.length || shift > 28) throw new Error("Некорректное имя в .fwl");
    const x = b[pos++];
    len |= (x & 127) << shift;
    if (!(x & 128)) break;
    shift += 7;
  }
  if (len < 1 || pos + len > b.length) throw new Error("Некорректное имя в .fwl");
  return b.subarray(pos, pos + len).toString("utf8");
};

const validate = (files) => {
  if (files.directory) return validateSegmented(files);
  if (!files.db || !files.fwl) throw new Error("Нужны оба файла: .db и .fwl");
  const db = fs.statSync(files.db.path), fwl = fs.statSync(files.fwl.path);
  if (db.size < 1024 || db.size > 512 * 1024 * 1024) throw new Error("Некорректный размер .db");
  if (fwl.size < 12 || fwl.size > 1024 * 1024) throw new Error("Некорректный размер .fwl");
  const inner = fwlName(files.fwl.path);
  worldName(inner);
  return { name: inner, dbSize: db.size, fwlSize: fwl.size };
};

const telegramUrl = (base, requestPath) => {
  const url = new URL(base || "https://api.telegram.org");
  url.pathname = url.pathname.replace(/\/$/, "") + requestPath;
  url.search = "";
  return url;
};

const download = async (token, doc, dest, apiBase, apiFileBase, maxFileBytes = LIMIT) => {
  if (doc.file_size && doc.file_size > maxFileBytes) throw new Error("Файл превышает лимит " + Math.floor(maxFileBytes / 1048576) + " МБ");
  const body = JSON.stringify({ file_id: doc.file_id });
  const info = await new Promise((resolve, reject) => {
    const url = telegramUrl(apiBase, "/bot" + token + "/getFile");
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let raw = "";
      res.on("data", (c) => raw += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          if (!j.ok || !j.result || !j.result.file_path) reject(new Error(j.description || "getFile failed"));
          else resolve(j.result.file_path);
        } catch { reject(new Error("Некорректный ответ Telegram")); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });

  if (path.isAbsolute(info) && fs.existsSync(info)) {
    const root = fs.realpathSync("/var/lib/telegram-bot-api");
    const source = fs.realpathSync(info);
    if (!source.startsWith(root + path.sep)) throw new Error("Telegram вернул путь вне хранилища Bot API");
    if (fs.statSync(source).size > maxFileBytes) throw new Error("Превышен лимит файла");
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(source);
      const out = fs.createWriteStream(dest, { flags: "wx", mode: 0o600 });
      const fail = (err) => { input.destroy(); out.destroy(); fs.rmSync(dest, { force: true }); reject(err); };
      input.on("error", fail); out.on("error", fail);
      out.on("finish", () => out.close(resolve));
      input.pipe(out);
    });
    return;
  }

  let url;
  if (path.isAbsolute(info) && apiFileBase) {
    const prefix = "/var/lib/telegram-bot-api/";
    if (!info.startsWith(prefix)) throw new Error("Неизвестный путь файла Bot API");
    const relative = info.slice(prefix.length).split("/").map(encodeURIComponent).join("/");
    url = telegramUrl(apiFileBase, "/" + relative);
  } else {
    url = telegramUrl(apiBase, "/file/bot" + token + "/" + info);
  }
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: "wx", mode: 0o600 });
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.get(url, (res) => {
      if (res.statusCode !== 200) {
        out.destroy(); fs.rmSync(dest, { force: true });
        reject(new Error("Telegram download HTTP " + res.statusCode)); return;
      }
      let size = 0;
      res.on("data", (c) => { size += c.length; if (size > maxFileBytes) req.destroy(new Error("Превышен лимит файла")); });
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
    });
    const fail = (err) => { out.destroy(); fs.rmSync(dest, { force: true }); reject(err); };
    req.on("error", fail); out.on("error", fail);
  });
};


const jsonGet = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    let raw = "";
    res.on("data", (c) => raw += c);
    res.on("end", () => {
      try {
        const j = JSON.parse(raw);
        if (res.statusCode < 200 || res.statusCode >= 300 || j.error) reject(new Error(j.message || "Yandex API HTTP " + res.statusCode));
        else resolve(j);
      } catch { reject(new Error("Некорректный ответ Yandex Disk API")); }
    });
  }).on("error", reject);
});

const streamUrl = (url, dest, maxBytes = 2 * 1024 * 1024 * 1024, redirects = 0) => new Promise((resolve, reject) => {
  if (redirects > 5) { reject(new Error("Слишком много перенаправлений")); return; }
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume(); streamUrl(new URL(res.headers.location, url).toString(), dest, maxBytes, redirects + 1).then(resolve, reject); return;
    }
    if (res.statusCode !== 200) { res.resume(); reject(new Error("Скачивание: HTTP " + res.statusCode)); return; }
    const declared = Number(res.headers["content-length"] || 0);
    if (declared > maxBytes) { res.resume(); reject(new Error("Файл больше 2 ГБ")); return; }
    if (fs.statfsSync) {
      const disk = fs.statfsSync(path.dirname(dest)), free = Number(disk.bavail) * Number(disk.bsize);
      if (declared && free < declared + 512 * 1024 * 1024) { res.resume(); reject(new Error("Недостаточно свободного места")); return; }
    }
    const out = fs.createWriteStream(dest, { flags: "wx", mode: 0o600 });
    let size = 0;
    res.on("data", (c) => { size += c.length; if (size > maxBytes) res.destroy(new Error("Файл превысил 2 ГБ")); });
    res.pipe(out); out.on("finish", () => out.close(() => resolve(size)));
    const fail = (err) => { out.destroy(); fs.rmSync(dest, { force: true }); reject(err); };
    res.on("error", fail); out.on("error", fail);
  }).on("error", reject);
});

const yandexResource = async (publicUrl, sessionDir) => {
  let shared; try { shared = new URL(publicUrl); } catch { throw new Error("Некорректная ссылка"); }
  const host = shared.hostname.toLowerCase();
  if (!(host === "yadi.sk" || host.startsWith("disk.yandex."))) throw new Error("Нужна публичная ссылка Яндекс Диска");
  const key = encodeURIComponent(publicUrl);
  const meta = await jsonGet("https://cloud-api.yandex.net/v1/disk/public/resources?public_key=" + key + "&limit=100");
  const link = await jsonGet("https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" + key);
  if (!link.href) throw new Error("Яндекс Диск не разрешил скачивание");
  const originalName = String(meta.name || "yandex-download");
  // Yandex Disk appends a suffix like " [FqOUkw]" after duplicate uploads.
  // It is not part of the Valheim world name.
  const normalizedName = originalName.replace(/ \[[A-Za-z0-9_-]+\](?=\.[^.]+$)/, "");
  const ext = meta.type === "dir" ? ".zip" : path.extname(normalizedName).toLowerCase();
  if (![".zip", ".db", ".fwl"].includes(ext)) throw new Error("Ссылка должна вести на ZIP, .db, .fwl или папку");
  if (meta.size && Number(meta.size) > 2 * 1024 * 1024 * 1024) throw new Error("Ресурс больше 2 ГБ");
  const dest = path.join(sessionDir, "yandex-" + Date.now() + ext);
  await streamUrl(link.href, dest);
  if (ext === ".zip") return { worlds: await unzipWorlds(dest, path.join(sessionDir, "yandex-extracted")), label: originalName };
  return { files: { [ext.slice(1)]: { name: normalizedName, path: dest } }, label: originalName };
};

const unzipWorlds = async (zip, dir) => {
  const list = await run("unzip", ["-Z1", zip]);
  const entries = list.stdout.split("\n").filter(Boolean);
  if (!entries.length || entries.length > 20000 || entries.some((x) =>
    x !== x.trim() || /[\\\x00-\x1f*?\[\]]/.test(x) || x.startsWith("/") || x.startsWith("-") || /^[A-Za-z]:/.test(x) ||
    x.replace(/\/$/, "").split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new Error("Небезопасное или пустое содержимое ZIP");
  }
  if (new Set(entries.map((x) => x.toLowerCase())).size !== entries.length) throw new Error("В ZIP есть одинаковые пути файлов");
  const details = await run("unzip", ["-Z", "-l", zip]);
  const modes = details.stdout.split("\n").filter((line) => /^[a-z?-][rwxstST-]{9}\s/.test(line));
  if (modes.some((line) => !line.startsWith("-") && !line.startsWith("d"))) throw new Error("В ZIP запрещены ссылки и специальные файлы");
  const sizes = await run("unzip", ["-l", zip]);
  const summary = sizes.stdout.match(/^\s*(\d+)\s+(\d+)\s+files?\s*$/m);
  if (!summary || Number(summary[1]) > 2 * 1024 * 1024 * 1024) throw new Error("Распакованный мир превышает лимит 2 ГБ");
  if (fs.statfsSync) {
    const disk = fs.statfsSync(path.dirname(dir));
    if (Number(disk.bavail) * Number(disk.bsize) < Number(summary[1]) + 128 * 1024 * 1024) throw new Error("Недостаточно места для распаковки мира");
  }
  const segmentedDirs = [...new Set(entries.filter((x) => /(?:^|\/)\_main\.\d+\.(?:db2|fwl2|chunks|ok)$/.test(x)).map((x) => path.posix.dirname(x)))];
  const segmentedEntries = entries.filter((x) => segmentedDirs.some((dir) => x.startsWith(dir + "/")));
  const candidates = entries.filter((x) => {
    const lower = x.toLowerCase();
    return (lower.endsWith(".db") || lower.endsWith(".fwl")) && !lower.includes("_backup_auto-");
  });
  const basenames = candidates.map((x) => path.basename(x).toLowerCase());
  if ((!candidates.length && !segmentedDirs.length) || new Set(basenames).size !== basenames.length) {
    throw new Error("В ZIP нет миров или есть одинаковые имена файлов");
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const segmentedWorlds = [];
  if (segmentedDirs.length) {
    if (segmentedDirs.includes(".")) throw new Error("Сегментированный мир должен находиться в каталоге с именем мира");
    const extracted = path.join(dir, "segmented");
    await run("unzip", ["-o", zip, ...segmentedEntries, "-d", extracted]);
    for (const source of segmentedDirs) {
      const files = { directory: path.join(extracted, source), name: worldName(path.posix.basename(source)) };
      fs.chmodSync(files.directory, 0o700);
      segmentedWorlds.push({ ...validate(files), files });
    }
  }
  const legacyDir = path.join(dir, "legacy");
  fs.mkdirSync(legacyDir, { mode: 0o700 });
  if (candidates.length) await run("unzip", ["-jo", zip, ...candidates, "-d", legacyDir]);
  const names = fs.readdirSync(legacyDir);
  const dbNames = names.filter((x) => x.toLowerCase().endsWith(".db"));
  const fwlNames = names.filter((x) => x.toLowerCase().endsWith(".fwl"));
  const pairs = [];
  if (dbNames.length === 1 && fwlNames.length === 1) {
    pairs.push({ db: dbNames[0], fwl: fwlNames[0] });
  } else {
    const dbByStem = new Map(dbNames.map((x) => [x.slice(0, -3).toLowerCase(), x]));
    for (const fwl of fwlNames) {
      const db = dbByStem.get(fwl.slice(0, -4).toLowerCase());
      if (db) pairs.push({ db, fwl });
    }
  }
  if (!pairs.length && !segmentedWorlds.length) throw new Error("В ZIP не найдено ни одной полной пары .db + .fwl");
  const worlds = pairs.map((pair) => {
    const files = {
      db: { name: pair.db, path: path.join(legacyDir, pair.db) },
      fwl: { name: pair.fwl, path: path.join(legacyDir, pair.fwl) },
    };
    return { ...validate(files), files };
  });
  worlds.push(...segmentedWorlds);
  const seen = new Set();
  for (const world of worlds) {
    const key = world.name.toLowerCase();
    if (seen.has(key)) throw new Error("В ZIP найдено несколько версий мира " + world.name);
    seen.add(key);
  }
  return worlds;
};

const activeWorld = async (container) => {
  const r = await run("docker", ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", container]);
  const line = r.stdout.split("\n").find((x) => x.startsWith("WORLD_NAME="));
  if (!line) throw new Error("WORLD_NAME не найден");
  return line.slice(11);
};

const latestBackup = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir)
  .filter((x) => x.endsWith(".zip"))
  .reduce((m, x) => Math.max(m, fs.statSync(path.join(dir, x)).mtimeMs), 0) : 0;

const latestBackupPath = (dir) => fs.readdirSync(dir)
  .filter((x) => x.endsWith(".zip"))
  .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

const safetyBackup = async (o) => {
  const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", o.container]);
  if (state.stdout.trim() !== "true") {
    const world = worldName(await activeWorld(o.container));
    const directory = path.join(o.worldsDir, world);
    const segmented = fs.existsSync(directory) && fs.statSync(directory).isDirectory();
    if (segmented) validateSegmented({ directory, name: world });
    else validate({ db: { path: directory + ".db" }, fwl: { path: directory + ".fwl" } });
    const dest = path.join(o.dataDir, "restore-safety");
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const archive = path.join(dest, "world-" + Date.now() + ".zip");
    // The container is stopped, so the files cannot change during this backup.
    await new Promise((resolve, reject) => execFile("zip", ["-r", "-D", "-q", archive, ...(segmented ? [world] : [world + ".db", world + ".fwl"])],
      { cwd: o.worldsDir, timeout: 180000 }, (err) => err ? reject(err) : resolve()));
    await run("unzip", ["-t", archive]);
    return archive;
  }
  const before = latestBackup(o.backupsDir);
  await run("docker", ["exec", o.container, "supervisorctl", "signal", "HUP", "valheim-backup"]);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (latestBackup(o.backupsDir) > before) {
      const newest = latestBackupPath(o.backupsDir);
      if (newest) return path.join(o.backupsDir, newest.name);
    }
  }
  throw new Error("Контрольный backup не завершился");
};

const ready = async (container, since) => {
  for (let i = 0; i < 200; i++) {
    const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", container]);
    if (state.stdout.trim() !== "true") throw new Error("Контейнер остановился");
    const logs = await run("docker", ["logs", "--since", since, container]);
    if ((logs.stdout + logs.stderr).includes("Game server connected")) return;
    await sleep(3000);
  }
  throw new Error("Сервер не стал готов за 600 секунд");
};


const writeActiveWorld = (file, world) => {
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, "WORLD_NAME=" + world + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
};

const composeUpValheim = (o) => run("docker", [
  "compose", "-f", path.join(o.projectDir, "docker-compose.yaml"),
  "up", "-d", "--force-recreate", "valheim",
], 300000);
const composeCreateValheim = (o) => run("docker", [
  "compose", "-f", path.join(o.projectDir, "docker-compose.yaml"),
  "create", "--force-recreate", "valheim",
], 300000);

const install = async (o, files, say, runtime = {}) => {
  const execute = runtime.run || run;
  const waitReady = runtime.ready || ready;
  const backup = runtime.safetyBackup || safetyBackup;
  const start = runtime.composeUp || composeUpValheim;
  const recreateStopped = runtime.composeCreate || composeCreateValheim;
  const meta = validate(files);
  const inspected = await execute("docker", ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", o.container]);
  const worldLine = inspected.stdout.split("\n").find((x) => x.startsWith("WORLD_NAME="));
  if (!worldLine) throw new Error("WORLD_NAME не найден");
  const previousWorld = worldName(worldLine.slice(11));
  const state = await execute("docker", ["inspect", "-f", "{{.State.Running}}", o.container]);
  const wasRunning = state.stdout.trim() === "true";
  const targetWorld = meta.name;
  if (o.onlinePlayers.size) throw new Error("Сейчас онлайн игроков: " + o.onlinePlayers.size);
  if (!o.projectDir || !o.worldEnvFile) throw new Error("Не настроены VALHEIM_PROJECT_DIR/VALHEIM_WORLD_ENV_FILE");

  await say("🛡 Создаю контрольный backup...");
  const safetyBackupPath = await backup(o);
  try {
    await say("📤 Отправляю контрольный backup в Telegram...");
    await o.sendSafetyBackup(safetyBackupPath);
  } catch (err) {
    await say("⚠️ Контрольный backup создан, но не отправлен: " + err.message);
  }

  const rollback = path.join(o.dataDir, "restore-rollback", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(rollback, { recursive: true, mode: 0o700 });
  let snapshotComplete = false;
  let stopped = false;
  let startAttempted = false;

  const rollbackNow = async () => {
    if (startAttempted) await execute("docker", ["stop", "-t", "120", o.container]);
    if (snapshotComplete) rollbackWorld(o.worldsDir, targetWorld, rollback);
    writeActiveWorld(o.worldEnvFile, previousWorld);
    if (wasRunning && stopped) {
      const since = new Date(Date.now() - 1000).toISOString();
      await start(o);
      await waitReady(o.container, since);
    } else if (!wasRunning && startAttempted) {
      // Restore the stopped container's environment too, so /start uses the previous world.
      await recreateStopped(o);
    }
  };

  try {
    await say("⏹ Останавливаю сервер и переключаю мир " + previousWorld + " → " + targetWorld + "...");
    await execute("docker", ["stop", "-t", "120", o.container]);
    stopped = true;
    snapshotWorld(o.worldsDir, targetWorld, rollback);
    snapshotComplete = true;
    replaceWorld(o.worldsDir, targetWorld, files);

    writeActiveWorld(o.worldEnvFile, targetWorld);
    const since = new Date(Date.now() - 1000).toISOString();
    startAttempted = true;
    await start(o);
    await say("⏳ Проверяю запуск восстановленного мира...");
    await waitReady(o.container, since);
    return { world: targetWorld, previousWorld, rollback };
  } catch (err) {
    await say("⚠️ Ошибка запуска. Возвращаю мир " + previousWorld + "...");
    try {
      await rollbackNow();
    } catch (rollbackError) {
      throw new Error(err.message + "; rollback не удался: " + rollbackError.message);
    }
    throw err;
  }
};

const createRestoreManager = (o) => {
  const sessions = new Map();
  let installing = false;
  const say = (chat, text) => o.sendMessage(text, undefined, chat);
  const key = (chat, user) => chat + ":" + user;
  const session = (chat, user) => {
    const s = sessions.get(key(chat, user));
    if (s && !s.busy && s.expires < Date.now()) { fs.rmSync(s.dir, { recursive: true, force: true }); sessions.delete(key(chat, user)); return null; }
    return s || null;
  };
  const reset = (chat, user) => {
    const dir = path.join(o.dataDir, "restore-staging", chat.replace(/[^0-9-]/g, "_") + "-" + user.replace(/\D/g, "_"));
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const s = { dir, files: {}, worlds: [], expires: Date.now() + 1800000, busy: false }; sessions.set(key(chat, user), s); return s;
  };

  const preparedText = (m) => "✅ Подготовлен мир " + m.name +
    (m.format === "segmented" ? "\nСегментированный формат; сохранение " + m.checkpoint + "; чанков: " + m.chunkCount + "\nРазмер: " + (m.dbSize / 1048576).toFixed(1) + " МБ" :
      "\n.db: " + (m.dbSize / 1048576).toFixed(1) + " МБ\n.fwl: " + m.fwlSize + " байт") +
    "\n\nПодтвердить: /restore_confirm\nОтмена: /restore_cancel";

  const acceptWorlds = async (s, worlds, chat) => {
    s.expires = Date.now() + 1800000;
    if (worlds.length === 1) {
      s.worlds = [];
      s.files = worlds[0].files;
      await say(chat, preparedText(worlds[0]));
      return;
    }
    s.files = {};
    s.worlds = worlds.sort((a, b) => a.name.localeCompare(b.name));
    const list = s.worlds.map((world, i) => (i + 1) + ". " + world.name + " — " + (world.dbSize / 1048576).toFixed(1) + " МБ — /restore_world_" + (i + 1)).join("\n");
    await say(chat, "📚 В архиве найдено миров: " + s.worlds.length + "\n\n" + list + "\n\nНажмите команду нужного мира.\nОтмена: /restore_cancel");
  };

  const document = async (msg, chat, user) => {
    if (user !== String(o.adminId || "")) { await say(chat, "⛔️ Restore доступен только администратору"); return; }
    const s = session(chat, user);
    if (!s) { await say(chat, "Сначала отправьте /restore"); return; }
    if (s.busy) { await say(chat, "⏳ Уже обрабатываю файл"); return; }
    const name = path.basename(String(msg.document.file_name || ""));
    const ext = path.extname(name).toLowerCase();
    if (![".zip", ".db", ".fwl"].includes(ext)) { await say(chat, "Нужен ZIP либо .db/.fwl"); return; }
    s.busy = true;
    try {
      const dest = path.join(s.dir, Date.now() + ext);
      await say(chat, "⬇️ Загружаю " + name + "...");
      await download(o.token, msg.document, dest, o.apiUrl, o.apiFileUrl, o.maxFileBytes);
      if (ext === ".zip") {
        await acceptWorlds(s, await unzipWorlds(dest, path.join(s.dir, "extracted")), chat);
      } else {
        s.worlds = [];
        if (s.files.directory) s.files = {};
        s.files[ext.slice(1)] = { name, path: dest };
        s.expires = Date.now() + 1800000;
        if (s.files.db && s.files.fwl) await say(chat, preparedText(validate(s.files)));
        else await say(chat, "✅ " + name + " принят. Теперь отправьте " + (s.files.db ? ".fwl" : ".db"));
      }
    } catch (e) { await say(chat, "❌ Файл не принят: " + e.message); }
    finally { s.busy = false; }
  };

  const yandex = async (url, chat, user) => {
    if (user !== String(o.adminId || "")) { await say(chat, "⛔️ Restore доступен только администратору"); return; }
    const s = session(chat, user);
    if (!s) { await say(chat, "Сначала отправьте /restore"); return; }
    if (s.busy) { await say(chat, "⏳ Уже обрабатываю загрузку"); return; }
    s.busy = true;
    try {
      const result = await yandexResource(url, s.dir);
      if (result.worlds) {
        await acceptWorlds(s, result.worlds, chat);
      } else {
        s.worlds = [];
        if (s.files.directory) s.files = {};
        s.files = { ...s.files, ...result.files }; s.expires = Date.now() + 1800000;
        if (s.files.db && s.files.fwl) await say(chat, preparedText(validate(s.files)));
        else await say(chat, "✅ " + result.label + " принят. Теперь нужна ссылка или файл " + (s.files.db ? ".fwl" : ".db"));
      }
    } catch (e) { await say(chat, "❌ Не удалось скачать с Яндекс Диска: " + e.message + "\n\n" + RESTORE_HELP(o.maxFileBytes)); }
    finally { s.busy = false; }
  };

  const handleUpdate = async (update) => {
    const msg = update && update.message; if (!msg) return false;
    const user = String((msg.from && msg.from.id) || ""), chat = String(msg.chat && msg.chat.id);
    const cmd = String(msg.text || "").trim().split(/\s+/)[0].replace(/@[A-Za-z0-9_]+$/, "");
    const worldCommand = cmd.match(/^\/restore_world_(\d+)$/);
    const ext = path.extname(String(msg.document && msg.document.file_name || "")).toLowerCase();
    const urlMatch = String(msg.text || "").match(/https?:\/\/[^\s]+/);
    if (urlMatch && cmd !== "/restore" && session(chat, user)) { await yandex(urlMatch[0], chat, user); return true; }
    if (msg.document && [".zip", ".db", ".fwl"].includes(ext)) { await document(msg, chat, user); return true; }
    if (!['/restore', '/restore_url', '/restore_world', '/restore_confirm', '/restore_cancel'].includes(cmd) && !worldCommand) return false;
    if (user !== String(o.adminId || "")) { await say(chat, "⛔️ Restore доступен только администратору"); return true; }
    if (session(chat, user)?.busy) { await say(chat, "⏳ Restore уже выполняется"); return true; }

    if (cmd === "/restore") {
      reset(chat, user);
      if (urlMatch) await yandex(urlMatch[0], chat, user);
      else await say(chat, RESTORE_HELP(o.maxFileBytes));
      return true;
    }
    if (cmd === "/restore_url") {
      if (!urlMatch) await say(chat, "Укажите ссылку: /restore_url https://disk.yandex.ru/...");
      else await yandex(urlMatch[0], chat, user);
      return true;
    }
    if (cmd === "/restore_world" || worldCommand) {
      const s = session(chat, user);
      const number = worldCommand ? Number(worldCommand[1]) : Number(String(msg.text || "").trim().split(/\s+/)[1]);
      if (!s || !s.worlds || !s.worlds.length) { await say(chat, "Нет архива с несколькими мирами. Начните с /restore"); return true; }
      if (!Number.isInteger(number) || number < 1 || number > s.worlds.length) { await say(chat, "Выберите одну из команд в списке миров: /restore_world_1"); return true; }
      const selected = s.worlds[number - 1];
      s.files = selected.files;
      s.worlds = [];
      s.expires = Date.now() + 1800000;
      await say(chat, preparedText(selected));
      return true;
    }
    if (cmd === "/restore_cancel") {
      const s = session(chat, user); if (s) fs.rmSync(s.dir, { recursive: true, force: true });
      sessions.delete(key(chat, user)); await say(chat, "❎ Restore отменён"); return true;
    }
    const s = session(chat, user);
    if (!s || !(s.files.directory || (s.files.db && s.files.fwl))) { await say(chat, s && s.worlds && s.worlds.length ? "Сначала выберите команду нужного мира, например /restore_world_1" : "Нет подготовленного мира. Начните с /restore"); return true; }
    if (installing) { await say(chat, "⏳ Restore уже выполняется в другом чате"); return true; }
    s.busy = true;
    installing = true;
    try {
      const result = await install(
        { ...o, sendSafetyBackup: (file) => o.sendDocument(chat, file, "🛡 Контрольный backup перед restore") },
        s.files,
        (text) => say(chat, text)
      );
      await say(chat, "✅ Мир " + result.world + " восстановлен, сервер готов.\nRollback: " + path.basename(result.rollback));
      fs.rmSync(s.dir, { recursive: true, force: true }); sessions.delete(key(chat, user));
    } catch (e) { await say(chat, "❌ Restore не выполнен: " + e.message); s.busy = false; }
    finally { installing = false; }
    return true;
  };
  return { handleUpdate, isBusy: () => installing || [...sessions.values()].some((s) => s.busy || s.expires > Date.now()) };
};
module.exports = { createRestoreManager, unzipWorlds, install };
