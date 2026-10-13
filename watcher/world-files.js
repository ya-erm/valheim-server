const fs = require("fs");
const path = require("path");
const { execFile } = require("node:child_process");

const statusCommand = (args) => new Promise((resolve, reject) => {
  execFile("docker", args, { timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
    if (error) reject(new Error("Could not read Valheim container status"));
    else resolve(stdout);
  });
});

const getServerStatus = async (container, online, run = statusCommand) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error("Invalid container name");
  const filter = "name=^/" + container.replace(/\./g, "\\.") + "$";
  let status = (await run(["ps", "--filter", filter, "--format", "{{.Status}}"])).trim();
  let world = "не подключена";
  if (status) {
    // Read only WORLD_NAME, never the other container environment variables.
    const format = '{{.State.Running}}{{println}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "WORLD_NAME"}}{{println .}}{{end}}{{end}}';
    const lines = (await run(["inspect", "--format", format, container])).trim().split("\n");
    if (lines[0] === "true") world = lines.find((line) => line.startsWith("WORLD_NAME="))?.slice(11).trim() || "неизвестна";
    else status = "";
  }
  return "📊 Статус: " + (status || "Не запущен") + "\n🗺 Карта: " + world + "\n👥 Онлайн: " + online;
};

const worldName = (name) => {
  if (!name || name.length > 64 || name === "." || name === ".." || /[\\/\x00-\x1f=]/.test(name)) {
    throw new Error("Недопустимое имя мира");
  }
  return name;
};

const metadataName = (file) => {
  const size = fs.statSync(file).size;
  if (size < 12 || size > 1024 * 1024) throw new Error("Некорректный файл метаданных мира");
  const b = fs.readFileSync(file);
  if (b.length < 12 || b.length > 1024 * 1024) throw new Error("Некорректный файл метаданных мира");
  let len = 0, shift = 0, pos = 8;
  for (;;) {
    if (pos >= b.length || shift > 28) throw new Error("Некорректное имя в метаданных мира");
    const x = b[pos++];
    len |= (x & 127) << shift;
    if (!(x & 128)) break;
    shift += 7;
  }
  if (len < 1 || pos + len > b.length) throw new Error("Некорректное имя в метаданных мира");
  return worldName(b.subarray(pos, pos + len).toString("utf8"));
};

const validateSegmented = (files) => {
  const dir = files.directory;
  const names = fs.readdirSync(dir);
  let size = 0;
  for (const name of names) {
    const stat = fs.lstatSync(path.join(dir, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("В каталоге мира разрешены только обычные файлы");
    size += stat.size;
  }
  const versions = names.filter((name) => /^_main\.\d+\.ok$/.test(name))
    .map((name) => Number(name.split(".")[1])).sort((a, b) => b - a);
  if (!versions.length || !Number.isSafeInteger(versions[0])) throw new Error("Нет завершённого сохранения _main.<версия>.ok");
  // Validate the newest committed save; never silently restore an older checkpoint.
  const prefix = "_main." + versions[0];
  for (const suffix of [".db2", ".fwl2", ".chunks", ".ok"]) {
    if (!names.includes(prefix + suffix)) throw new Error("Неполное сохранение: отсутствует " + prefix + suffix);
  }
  const fwl = path.join(dir, prefix + ".fwl2");
  const name = metadataName(fwl);
  if (name !== files.name) throw new Error("Имя каталога мира не совпадает с именем в .fwl2");
  const manifestFile = path.join(dir, prefix + ".chunks");
  const okFile = path.join(dir, prefix + ".ok");
  if (fs.statSync(manifestFile).size > 110010 || fs.statSync(okFile).size !== 4) throw new Error("Некорректный размер манифеста мира");
  const manifest = fs.readFileSync(manifestFile);
  const ok = fs.readFileSync(okFile);
  if (manifest.length < 10 || ok.length !== 4 || manifest.readUInt16LE(0) !== ok.readUInt32LE(0)) {
    throw new Error("Некорректный манифест сегментированного мира");
  }
  const count = manifest.readUInt32LE(6);
  if (count > 10000 || manifest.length !== 10 + count * 11) throw new Error("Неподдерживаемый формат списка чанков");
  const chunkNames = new Set();
  for (let i = 0; i < count; i++) {
    const p = 10 + i * 11;
    // The manifest stores the low coordinate byte first; filenames use high_low.
    const chunk = manifest[p + 1].toString(16).padStart(2, "0") + "_" +
      manifest[p].toString(16).padStart(2, "0") + "__" + manifest[p + 2] + "_" + manifest.readUInt32LE(p + 3) + ".chunk";
    if (chunkNames.has(chunk)) throw new Error("Повторяющийся чанк в манифесте");
    chunkNames.add(chunk);
    if (!names.includes(chunk) || fs.statSync(path.join(dir, chunk)).size === 0) throw new Error("Отсутствует или пустой чанк " + chunk);
  }
  const db = path.join(dir, prefix + ".db2");
  if (fs.statSync(db).size < 4) throw new Error("Пустой .db2");
  const header = Buffer.alloc(4);
  const fd = fs.openSync(db, "r");
  try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (header.readUInt32LE(0) !== ok.readUInt32LE(0) || fs.readFileSync(fwl).readUInt32LE(4) !== ok.readUInt32LE(0)) {
    throw new Error("Версии файлов сегментированного мира не совпадают");
  }
  return { name, format: "segmented", dbSize: size, fwlSize: fs.statSync(fwl).size, chunkCount: count, checkpoint: versions[0] };
};

const worldPaths = (name) => [worldName(name), name + ".db", name + ".fwl", name + ".db.old", name + ".fwl.old"];

const snapshotWorld = (worldsDir, name, rollback) => {
  fs.mkdirSync(rollback, { recursive: true, mode: 0o700 });
  for (const entry of worldPaths(name)) {
    const source = path.join(worldsDir, entry);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(rollback, entry), { recursive: true, errorOnExist: true, force: false });
  }
};

const clearWorld = (worldsDir, name) => {
  for (const entry of worldPaths(name)) fs.rmSync(path.join(worldsDir, entry), { recursive: true, force: true });
};

const normalizePermissions = (dir) => {
  fs.chmodSync(dir, 0o755);
  for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o644);
};

const replaceWorld = (worldsDir, name, files) => {
  const staging = fs.mkdtempSync(path.join(worldsDir, ".restore-"));
  try {
    if (files.directory) {
      const target = path.join(staging, name);
      fs.cpSync(files.directory, target, { recursive: true });
      normalizePermissions(target);
    } else {
      for (const ext of ["db", "fwl"]) {
        const target = path.join(staging, name + "." + ext);
        fs.copyFileSync(files[ext].path, target);
        fs.chmodSync(target, 0o644);
      }
    }
    clearWorld(worldsDir, name);
    for (const entry of fs.readdirSync(staging)) fs.renameSync(path.join(staging, entry), path.join(worldsDir, entry));
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
};

const rollbackWorld = (worldsDir, name, rollback) => {
  clearWorld(worldsDir, name);
  for (const entry of worldPaths(name)) {
    const saved = path.join(rollback, entry);
    if (fs.existsSync(saved)) fs.cpSync(saved, path.join(worldsDir, entry), { recursive: true });
  }
};

module.exports = { worldName, metadataName, validateSegmented, snapshotWorld, replaceWorld, rollbackWorld, getServerStatus };
