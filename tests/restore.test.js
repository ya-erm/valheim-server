const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { unzipWorlds, install, createRestoreManager } = require("../watcher/restore");
const { validateSegmented, snapshotWorld, replaceWorld, rollbackWorld } = require("../watcher/world-files");

const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "valheim-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const fwl = (name) => {
  const text = Buffer.from(name);
  const b = Buffer.alloc(9 + text.length);
  b.writeUInt32LE(b.length - 4, 0);
  b.writeUInt32LE(41, 4);
  b[8] = text.length;
  text.copy(b, 9);
  return b;
};
const legacy = (root, name = "TestWorld") => {
  fs.mkdirSync(root, { recursive: true });
  const files = { db: { path: path.join(root, name + ".db") }, fwl: { path: path.join(root, name + ".fwl") } };
  fs.writeFileSync(files.db.path, Buffer.alloc(2048, 7));
  fs.writeFileSync(files.fwl.path, fwl(name));
  return files;
};
const segmented = (root, name = "TestWorld", count = 2) => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const header = Buffer.alloc(4); header.writeUInt32LE(41);
  fs.writeFileSync(path.join(directory, "_main.10.db2"), Buffer.concat([header, Buffer.alloc(64, 9)]));
  fs.writeFileSync(path.join(directory, "_main.10.fwl2"), fwl(name));
  fs.writeFileSync(path.join(directory, "_main.10.ok"), header);
  const manifest = Buffer.alloc(10 + count * 11);
  manifest.writeUInt16LE(41, 0); manifest.writeUInt32LE(count, 6);
  for (let i = 0; i < count; i++) {
    const p = 10 + i * 11;
    const low = i % 256, high = Math.floor(i / 256);
    manifest[p] = low; manifest[p + 1] = high; manifest[p + 2] = 1;
    manifest.writeUInt32LE(i + 3, p + 3); manifest.writeUInt32LE(1, p + 7);
    const chunk = high.toString(16).padStart(2, "0") + "_" + low.toString(16).padStart(2, "0") + "__1_" + (i + 3) + ".chunk";
    fs.writeFileSync(path.join(directory, chunk), Buffer.from("synthetic chunk"));
  }
  fs.writeFileSync(path.join(directory, "_main.10.chunks"), manifest);
  return { directory, name };
};
const zip = (root, entries, args = ["-r", "-D", "-q"]) => {
  const archive = path.join(root, "fixture.zip");
  execFileSync("zip", [...args, archive, ...entries], { cwd: root });
  return archive;
};

test("legacy ZIP remains supported, with internal metadata name", async (t) => {
  const root = temporary(t); legacy(root);
  fs.renameSync(path.join(root, "TestWorld.db"), path.join(root, "renamed.db"));
  const worlds = await unzipWorlds(zip(root, ["renamed.db", "TestWorld.fwl"]), path.join(root, "out"));
  assert.equal(worlds.length, 1); assert.equal(worlds[0].name, "TestWorld");
});

test("segmented ZIP preserves directory, checkpoints and all chunk files", async (t) => {
  const root = temporary(t); segmented(root);
  const worlds = await unzipWorlds(zip(root, ["TestWorld"]), path.join(root, "out"));
  assert.equal(worlds[0].format, "segmented"); assert.equal(worlds[0].chunkCount, 2);
  assert.equal(worlds[0].checkpoint, 10);
  assert.equal(fs.readdirSync(worlds[0].files.directory).length, 6);
});

test("worlds with more than the old 200 entry limit can be restored", async (t) => {
  const root = temporary(t); segmented(root, "LargeWorld", 260);
  const [world] = await unzipWorlds(zip(root, ["LargeWorld"]), path.join(root, "out"));
  assert.equal(world.chunkCount, 260);
});

test("mixed multi-world archives and a wrapping folder work", async (t) => {
  const root = temporary(t); segmented(path.join(root, "wrapper"), "NewWorld"); legacy(root, "OldWorld");
  const worlds = await unzipWorlds(zip(root, ["wrapper", "OldWorld.db", "OldWorld.fwl"]), path.join(root, "out"));
  assert.deepEqual(worlds.map((w) => w.name).sort(), ["NewWorld", "OldWorld"]);
});

for (const file of ["_main.10.db2", "_main.10.fwl2", "_main.10.chunks", "_main.10.ok", "00_00__1_3.chunk"]) {
  test("rejects missing segmented component " + file, async (t) => {
    const root = temporary(t); const files = segmented(root);
    fs.rmSync(path.join(files.directory, file));
    await assert.rejects(unzipWorlds(zip(root, ["TestWorld"]), path.join(root, "out")));
  });
}

test("incomplete newest committed save is rejected instead of silently loading an older save", (t) => {
  const files = segmented(temporary(t));
  fs.copyFileSync(path.join(files.directory, "_main.10.ok"), path.join(files.directory, "_main.11.ok"));
  assert.throws(() => validateSegmented(files), /Неполное сохранение/);
});

test("mismatched directory and metadata names are rejected", (t) => {
  const files = segmented(temporary(t)); fs.writeFileSync(path.join(files.directory, "_main.10.fwl2"), fwl("OtherWorld"));
  assert.throws(() => validateSegmented(files), /не совпадает/);
});

test("corrupt manifest and mismatched save versions are rejected", (t) => {
  const files = segmented(temporary(t)); const manifest = path.join(files.directory, "_main.10.chunks");
  const original = fs.readFileSync(manifest); fs.writeFileSync(manifest, original.subarray(0, original.length - 1));
  assert.throws(() => validateSegmented(files), /формат списка чанков/);
  fs.writeFileSync(manifest, original);
  fs.writeFileSync(path.join(files.directory, "_main.10.ok"), Buffer.alloc(4));
  assert.throws(() => validateSegmented(files), /манифест/);
});

test("duplicates of a world across legacy and segmented formats are rejected", async (t) => {
  const root = temporary(t); segmented(root); legacy(root);
  await assert.rejects(unzipWorlds(zip(root, ["TestWorld", "TestWorld.db", "TestWorld.fwl"]), path.join(root, "out")), /несколько версий мира/);
});

test("ZIP symlinks are rejected before extraction", async (t) => {
  const root = temporary(t); segmented(root);
  fs.symlinkSync("/etc/passwd", path.join(root, "TestWorld", "link"));
  await assert.rejects(unzipWorlds(zip(root, ["TestWorld"], ["-r", "-D", "-q", "-y"]), path.join(root, "out")), /запрещены ссылки/);
  assert.equal(fs.existsSync(path.join(root, "out")), false);
});

test("ZIP traversal, absolute paths, wildcards and duplicate paths are rejected", async (t) => {
  const root = temporary(t);
  for (const entries of [["../escape.db"], ["/escape.db"], ["world/*"], ["same.db", "same.db"]]) {
    const archive = path.join(root, "bad.zip");
    execFileSync("python3", ["-c", "import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); [z.writestr(n,b'x') for n in json.loads(sys.argv[2])]; z.close()", archive, JSON.stringify(entries)], { stdio: "pipe" });
    await assert.rejects(unzipWorlds(archive, path.join(root, "out")));
  }
});

test("expanded ZIP size is bounded before any extraction", async (t) => {
  const root = temporary(t); legacy(root); const archive = zip(root, ["TestWorld.db", "TestWorld.fwl"]);
  const b = fs.readFileSync(archive);
  const central = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0); b.writeUInt32LE(0x90000000, central + 24); fs.writeFileSync(archive, b);
  await assert.rejects(unzipWorlds(archive, path.join(root, "out")), /лимит 2 ГБ/);
  assert.equal(fs.existsSync(path.join(root, "out")), false);
});

test("replacement removes competing legacy files and rollback restores both forms", (t) => {
  const root = temporary(t); const worlds = path.join(root, "worlds");
  legacy(worlds); const old = segmented(worlds); fs.writeFileSync(path.join(old.directory, "old-marker"), "old");
  const incoming = segmented(path.join(root, "incoming"));
  const rollback = path.join(root, "rollback"); snapshotWorld(worlds, "TestWorld", rollback);
  replaceWorld(worlds, "TestWorld", incoming);
  assert.equal(fs.existsSync(path.join(worlds, "TestWorld.db")), false);
  assert.equal(fs.existsSync(path.join(worlds, "TestWorld", "old-marker")), false);
  assert.equal(fs.statSync(path.join(worlds, "TestWorld")).mode & 0o777, 0o755);
  rollbackWorld(worlds, "TestWorld", rollback);
  assert.equal(fs.readFileSync(path.join(worlds, "TestWorld", "old-marker"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(worlds, "TestWorld.db")).length, 2048);
});

test("legacy restore removes a competing segmented directory", (t) => {
  const root = temporary(t); const worlds = path.join(root, "worlds"); segmented(worlds);
  replaceWorld(worlds, "TestWorld", legacy(path.join(root, "incoming")));
  assert.equal(fs.existsSync(path.join(worlds, "TestWorld")), false);
  assert.ok(fs.existsSync(path.join(worlds, "TestWorld.db")));
});

for (const running of [true, false]) {
  test("startup failure restores original files and running state=" + running, async (t) => {
    const root = temporary(t); const worldsDir = path.join(root, "worlds");
    const old = segmented(worldsDir); fs.writeFileSync(path.join(old.directory, "marker"), "original");
    const files = segmented(path.join(root, "incoming"));
    const dataDir = path.join(root, "data"); const worldEnvFile = path.join(root, "active.env");
    fs.writeFileSync(worldEnvFile, "WORLD_NAME=PreviousWorld\n");
    let starts = 0, waits = 0, stoppedRecreates = 0;
    const runtime = {
      run: async (cmd, args) => ({ stdout: args.includes("{{.State.Running}}") ? String(running) : args.includes("inspect") ? "WORLD_NAME=PreviousWorld\n" : "", stderr: "" }),
      safetyBackup: async () => "synthetic-backup.zip",
      composeUp: async () => { starts++; },
      composeCreate: async () => { stoppedRecreates++; },
      ready: async () => { if (++waits === 1) throw new Error("synthetic startup failure"); },
    };
    await assert.rejects(install({ worldsDir, dataDir, worldEnvFile, projectDir: root, container: "test", onlinePlayers: new Set(), sendSafetyBackup: async () => {} }, files, async () => {}, runtime), /synthetic startup failure/);
    assert.equal(fs.readFileSync(path.join(worldsDir, "TestWorld", "marker"), "utf8"), "original");
    assert.equal(fs.readFileSync(worldEnvFile, "utf8"), "WORLD_NAME=PreviousWorld\n");
    assert.equal(starts, running ? 2 : 1);
    assert.equal(stoppedRecreates, running ? 0 : 1);
  });
}

test("snapshot failure leaves original target files intact", async (t) => {
  const root = temporary(t); const worldsDir = path.join(root, "worlds");
  const old = segmented(worldsDir); fs.writeFileSync(path.join(old.directory, "marker"), "original");
  const files = segmented(path.join(root, "incoming"));
  const worldEnvFile = path.join(root, "active.env"); fs.writeFileSync(worldEnvFile, "WORLD_NAME=PreviousWorld\n");
  const runtime = {
    run: async (cmd, args) => { if (args.includes("stop")) fs.chmodSync(path.join(old.directory, "marker"), 0); return { stdout: args.includes("{{.State.Running}}") ? "false" : "WORLD_NAME=PreviousWorld\n", stderr: "" }; },
    safetyBackup: async () => "synthetic.zip", composeUp: async () => {}, ready: async () => {},
  };
  const dataDir = path.join(root, "data");
  await assert.rejects(install({ worldsDir, dataDir, worldEnvFile, projectDir: root, container: "test", onlinePlayers: new Set(), sendSafetyBackup: async () => {} }, files, async () => {}, runtime));
  fs.chmodSync(path.join(old.directory, "marker"), 0o600);
  assert.equal(fs.readFileSync(path.join(old.directory, "marker"), "utf8"), "original");
});

test("restore commands reject unauthorized callers", async () => {
  const messages = [];
  const manager = createRestoreManager({ adminId: "123", sendMessage: async (text) => messages.push(text) });
  await manager.handleUpdate({ message: { from: { id: 999 }, chat: { id: 999 }, text: "/restore" } });
  assert.match(messages[0], /только администратору/);
});
