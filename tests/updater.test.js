const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { RUNTIME_FILES, compareVersions, validateRelease, sha256, writeJson } = require("../watcher/release-schema");
const { createUpdater, prepareRelease, getLatestRelease, downloadPackage } = require("../watcher/updater");
const { applyUpdate } = require("../watcher/update-runner");
const { checkHealth } = require("../watcher/health-check");
const { buildPackage } = require("../scripts/package-release");

const temp = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-update-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const fixture = (root, version = "1.1.0") => {
  fs.mkdirSync(path.join(root, "watcher"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  for (const name of RUNTIME_FILES) fs.writeFileSync(path.join(root, "watcher", name), name.endsWith(".js") ? "module.exports = {};\n" : "synthetic\n");
  fs.writeFileSync(path.join(root, "watcher", "version.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "watcher", ".env"), "SYNTHETIC_SETTING=private-test-only\n");
  fs.mkdirSync(path.join(root, "watcher", "data"), { recursive: true }); fs.writeFileSync(path.join(root, "watcher", "data", "chat.json"), "synthetic private data");
  buildPackage(root, "a".repeat(40));
  return path.join(root, "dist", "release");
};
const deployment = (t) => {
  const root = temp(t), sourceDir = path.join(root, "deployed");
  fs.mkdirSync(sourceDir);
  for (const name of RUNTIME_FILES) fs.writeFileSync(path.join(sourceDir, name), "old " + name);
  fs.writeFileSync(path.join(sourceDir, ".env"), "synthetic private setting");
  const candidate = fixture(path.join(root, "incoming"));
  const job = { id: randomUUID(), root: path.join(root, "updater"), candidate, sourceDir, container: "valheim-watcher", version: "1.1.0", previousVersion: "1.0.0", previousImage: "sha256:previous" };
  const inspected = { Image: job.previousImage, Config: { Image: "watcher-watcher", Labels: {
    "com.docker.compose.project.working_dir": sourceDir,
    "com.docker.compose.project.config_files": path.join(sourceDir, "docker-compose.yaml"),
    "com.docker.compose.service": "watcher",
    "com.docker.compose.project": "watcher",
  } }, Mounts: [{ Type: "bind", Destination: "/app/data", Source: path.join(root, "data"), RW: true }] };
  return { root, job, inspected };
};

test("stable release versions are compared numerically and downgrades are detected", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
  for (const version of ["01.0.0", "v1.0.0", "1.0.0-beta", "999999999999999999.0.0"]) assert.throws(() => compareVersions(version, "1.0.0"));
});

test("release packaging includes only allowlisted runtime source, never configuration/data", (t) => {
  const root = temp(t), candidate = fixture(root);
  const manifest = validateRelease(candidate);
  assert.equal(manifest.version, "1.1.0");
  const entries = execFileSync("unzip", ["-Z1", path.join(root, "dist/valheim-watcher.zip")], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(entries.sort(), [...RUNTIME_FILES, "release.json"].sort());
  assert.equal(fs.readFileSync(path.join(root, "dist/valheim-watcher.zip.sha256"), "utf8").split(" ")[0], sha256(path.join(root, "dist/valheim-watcher.zip")));
});

test("modified files, private extra files, and symlink manifests fail validation", (t) => {
  const root = temp(t), candidate = fixture(root);
  fs.writeFileSync(path.join(candidate, "watcher.js"), "tampered");
  assert.throws(() => validateRelease(candidate), /checksum/);
  fixture(root); fs.writeFileSync(path.join(candidate, ".env"), "synthetic");
  assert.throws(() => validateRelease(candidate), /Unexpected/);
  fixture(root); fs.renameSync(path.join(candidate, "release.json"), path.join(root, "manifest.json"));
  fs.symlinkSync(path.join(root, "manifest.json"), path.join(candidate, "release.json"));
  assert.throws(() => validateRelease(candidate), /manifest file/);
});

test("real ZIP preparation validates metadata and source checksums", async (t) => {
  const root = temp(t); fixture(root);
  const release = { version: "1.1.0", tag: "v1.1.0" };
  const candidate = await prepareRelease(release, path.join(root, "download"), { download: async (r, target) => fs.copyFileSync(path.join(root, "dist/valheim-watcher.zip"), target) });
  assert.equal(validateRelease(candidate).version, "1.1.0");
  await assert.rejects(prepareRelease({ ...release, version: "1.2.0", tag: "v1.2.0" }, path.join(root, "bad"), { download: async (r, target) => fs.copyFileSync(path.join(root, "dist/valheim-watcher.zip"), target) }), /does not match/);
});

test("download checksum mismatch and untrusted redirect are rejected", async (t) => {
  const root = temp(t), previous = global.fetch; t.after(() => { global.fetch = previous; });
  const release = { url: "https://github.com/example/repository/releases/download/v1.1.0/valheim-watcher.zip", digest: "0".repeat(64) };
  global.fetch = async () => new Response(Buffer.from("synthetic download"));
  await assert.rejects(downloadPackage(release, path.join(root, "bad-digest.zip")), /SHA-256 mismatch/);
  global.fetch = async () => new Response(null, { status: 302, headers: { location: "https://example.org/file.zip" } });
  await assert.rejects(downloadPackage(release, path.join(root, "redirect.zip")), /download host/);
  global.fetch = async () => new Response(Buffer.alloc(9 * 1024 * 1024));
  await assert.rejects(downloadPackage(release, path.join(root, "oversize.zip")), /exceeds 8 MB/);
});

test("health requires a fresh heartbeat, new process and Telegram readiness", (t) => {
  const root = temp(t); const now = Date.now();
  const healthy = { version: "1.1.0", startedAt: now, heartbeatAt: now, telegramReady: true };
  writeJson(path.join(root, "health.json"), healthy); assert.equal(checkHealth(root, "1.1.0", now - 1, now).version, "1.1.0");
  for (const change of [{ telegramReady: false }, { heartbeatAt: now - 31000 }, { version: "1.0.0" }, { startedAt: now - 1000 }]) {
    writeJson(path.join(root, "health.json"), { ...healthy, ...change }); assert.throws(() => checkHealth(root, "1.1.0", now - 1, now));
  }
});

test("successful helper update rebuilds/recreates only watcher and preserves private settings", async (t) => {
  const { root, job, inspected } = deployment(t); const calls = [];
  const run = async (command, args) => { calls.push([command, ...args]); return { stdout: args[0] === "inspect" ? JSON.stringify([inspected]) : "", stderr: "" }; };
  assert.equal(await applyUpdate(job, { run, sleep: async () => {} }), "success");
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.sourceDir, "version.json"))).version, "1.1.0");
  assert.equal(fs.readFileSync(path.join(job.sourceDir, ".env"), "utf8"), "synthetic private setting");
  assert.equal(fs.existsSync(path.join(job.sourceDir, "code-backups", "release-" + job.id, ".env")), false);
  const compose = calls.filter((call) => call[1] === "compose");
  assert.equal(compose.length, 1); assert.equal(compose[0].at(-1), "watcher"); assert.ok(compose[0].includes("--no-deps"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "updater", job.id, "status.json"))).phase, "success");
});

test("failed new health restores previous source/image and verifies the old watcher", async (t) => {
  const { job, inspected } = deployment(t); const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("/app/health-check.js") && args.includes("1.1.0")) throw new Error("synthetic health failure");
    return { stdout: args[0] === "inspect" ? JSON.stringify([inspected]) : "", stderr: "" };
  };
  assert.equal(await applyUpdate(job, { run, sleep: async () => {} }), "rolled_back");
  for (const name of RUNTIME_FILES) assert.equal(fs.readFileSync(path.join(job.sourceDir, name), "utf8"), "old " + name);
  assert.ok(calls.some((call) => call.slice(1, 3).join(" ") === "image tag" && call.includes("sha256:previous") && call.at(-1) === "watcher-watcher"));
  assert.equal(calls.filter((call) => call[1] === "compose").length, 2);
});

test("failed build never stops/recreates the current watcher or modifies its source", async (t) => {
  const { job, inspected } = deployment(t); const calls = [];
  const run = async (command, args) => { calls.push(args); if (args[0] === "build") throw new Error("synthetic build failure"); return { stdout: JSON.stringify([inspected]), stderr: "" }; };
  assert.equal(await applyUpdate(job, { run, sleep: async () => {} }), "failed");
  assert.ok(!calls.some((args) => args[0] === "compose"));
  assert.equal(fs.readFileSync(path.join(job.sourceDir, "watcher.js"), "utf8"), "old watcher.js");
});

test("hourly checks stay quiet for unchanged releases and never downgrade", async (t) => {
  const root = temp(t), notices = [];
  const updater = createUpdater({ root, repository: "example/repository", version: "1.1.0", notify: async (text) => notices.push(text) }, { latest: async () => ({ version: "1.0.0" }) });
  assert.equal((await updater.check({ apply: true })).status, "current"); assert.equal(notices.length, 0);
});

test("backup/restore defers application, and check-only never downloads/builds", async (t) => {
  const root = temp(t); let prepared = false;
  const updater = createUpdater({ root, repository: "example/repository", version: "1.0.0", isBusy: () => true }, {
    latest: async () => ({ version: "1.1.0" }), prepare: async () => { prepared = true; },
  });
  assert.equal((await updater.check()).status, "available");
  assert.equal((await updater.check({ apply: true })).status, "deferred"); assert.equal(prepared, false);
});

test("new release hands off to an independent helper container", async (t) => {
  const { root, inspected, job } = deployment(t); const calls = [];
  const updater = createUpdater({ root: path.join(root, "state"), repository: "example/repository", version: "1.0.0" }, {
    latest: async () => ({ version: "1.1.0" }), prepare: async () => job.candidate,
    run: async (command, args) => { calls.push(args); return { stdout: args[0] === "inspect" ? JSON.stringify([inspected]) : "helper-id", stderr: "" }; },
  });
  assert.equal((await updater.check({ apply: true })).status, "updating");
  assert.ok(calls.some((args) => args[0] === "run" && args.includes("--detach") && args.includes("/app/update-runner.js")));
  assert.equal((await updater.check({ apply: true })).status, "busy");
});

test("failed installed versions are not repeatedly attempted hourly; manual retry is allowed", async (t) => {
  const { root, inspected, job } = deployment(t); const state = path.join(root, "state");
  writeJson(path.join(state, "state.json"), { failedVersion: "1.1.0" });
  const updater = createUpdater({ root: state, repository: "example/repository", version: "1.0.0" }, {
    latest: async () => ({ version: "1.1.0" }), prepare: async () => job.candidate,
    run: async (command, args) => ({ stdout: args[0] === "inspect" ? JSON.stringify([inspected]) : "", stderr: "" }),
  });
  assert.equal((await updater.check({ apply: true })).status, "failed_version");
  assert.equal((await updater.check({ apply: true, manual: true })).status, "updating");
});

test("result notification is sent once across restarts and unlocks the updater", async (t) => {
  const root = temp(t), id = randomUUID(), notices = [];
  writeJson(path.join(root, "active.json"), { id, chat: "123", startedAt: Date.now() });
  writeJson(path.join(root, id, "status.json"), { id, version: "1.1.0", phase: "success" });
  const options = { root, version: "1.1.0", notify: async (text) => notices.push(text) };
  const runtime = { run: async () => ({ stdout: "", stderr: "" }) };
  await createUpdater(options, runtime).reportCompletion(); await createUpdater(options, runtime).reportCompletion();
  assert.equal(notices.length, 1); assert.equal(fs.existsSync(path.join(root, "active.json")), false);
});

test("an interrupted helper is reported and locked for manual recovery", async (t) => {
  const root = temp(t), id = randomUUID(), notices = [];
  writeJson(path.join(root, "active.json"), { id, startedAt: Date.now() - 16 * 60 * 1000 });
  writeJson(path.join(root, id, "status.json"), { id, version: "1.1.0", phase: "applying" });
  const updater = createUpdater({ root, notify: async (text) => notices.push(text) }, { run: async () => { throw new Error("no helper"); } });
  await updater.reportCompletion(); await updater.reportCompletion();
  assert.equal(notices.length, 1); assert.equal(fs.existsSync(path.join(root, "active.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, id, "status.json"))).phase, "rollback_failed");
});

test("only the administrator can check or apply through Telegram", async (t) => {
  const messages = []; let checked = false;
  const updater = createUpdater({ root: temp(t), repository: "example/repository", adminId: "123", notify: async (text) => messages.push(text) }, { latest: async () => { checked = true; return null; } });
  await updater.handleUpdate({ message: { from: { id: 999 }, chat: { id: 999 }, text: "/bot_update@ExampleBot" } });
  assert.equal(checked, false); assert.match(messages[0], /только администратору/);
  await updater.handleUpdate({ message: { from: { id: 123 }, chat: { id: 123 }, text: "/bot_update_check" } });
  assert.equal(checked, true); assert.match(messages[1], /новых релизов нет/);
});

test("GitHub metadata must point to a stable release with its asset digest", async (t) => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; });
  const good = { draft: false, prerelease: false, tag_name: "v1.1.0", assets: [{ name: "valheim-watcher.zip", state: "uploaded", size: 100, digest: "sha256:" + "a".repeat(64), browser_download_url: "https://github.com/example/repository/releases/download/v1.1.0/valheim-watcher.zip" }] };
  global.fetch = async () => ({ ok: true, status: 200, json: async () => good });
  assert.equal((await getLatestRelease("example/repository")).version, "1.1.0");
  for (const bad of [{ ...good, prerelease: true }, { ...good, assets: [{ ...good.assets[0], digest: null }] }, { ...good, assets: [{ ...good.assets[0], browser_download_url: "https://example.org/package.zip" }] }]) {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => bad }); await assert.rejects(getLatestRelease("example/repository"));
  }
});
