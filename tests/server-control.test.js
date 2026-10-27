const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServerControl } = require("../watcher/world-files");
const { createRestoreManager } = require("../watcher/restore");

const startedAt = "2026-01-01T00:00:00.123456789Z";
const state = (running, extra = {}) => JSON.stringify({ Running: running, Status: running ? "running" : "exited", StartedAt: startedAt, ...extra });
const update = (text, user = 42, chat = 100) => ({ message: { text, from: { id: user }, chat: { id: chat } } });
const fixture = (run, options = {}, runtime = {}) => {
  const messages = [], calls = [];
  const control = createServerControl({ adminId: "42", container: "test.valheim", isBusy: () => false,
    sendMessage: async (text, unused, chat) => messages.push({ text, chat }), ...options }, {
    run: async (args) => { calls.push(args); return run(args); }, sleep: async () => {}, attempts: 2, ...runtime,
  });
  return { control, messages, calls, text: () => messages.map((message) => message.text).join("\n") };
};

test("only the configured admin can start or stop, including commands addressed to the bot", async () => {
  const f = fixture(() => { throw new Error("Docker must not be called"); });
  for (const text of ["/server_start", "/server_stop@ExampleBot"]) {
    assert.equal(await f.control.handleUpdate(update(text, 7)), true);
  }
  assert.equal(f.calls.length, 0);
  assert.match(f.text(), /только администратору/);
  for (const adminId of [undefined, ""]) {
    const missing = fixture(() => assert.fail("no configured admin"), { adminId });
    await missing.control.handleUpdate(update("/server_start"));
    assert.match(missing.text(), /только администратору/);
  }
  assert.equal(await f.control.handleUpdate(update("/start")), false);
  assert.equal(await f.control.handleUpdate(update("/stop")), false);
  assert.equal(await f.control.handleUpdate({}), false);
});

test("start waits for the current startup's connection log and replies to the requesting chat", async () => {
  let running = false, logReads = 0;
  const f = fixture((args) => {
    if (args[0] === "inspect") return state(running);
    if (args[0] === "start") { running = true; return "test.valheim"; }
    if (args[0] === "logs") return ++logReads === 2 ? "Game server connected" : "Starting world";
    assert.fail("unexpected command");
  });
  assert.equal(await f.control.handleUpdate(update(" /server_start@ExampleBot ")), true);
  assert.match(f.text(), /игровой мир подключён/);
  assert.equal(logReads, 2);
  assert.deepEqual(f.calls.find((args) => args[0] === "start"), ["start", "test.valheim"]);
  assert.deepEqual(f.calls.find((args) => args[0] === "logs"), ["logs", "--since", startedAt, "--tail", "200", "test.valheim"]);
  assert.ok(f.messages.every((message) => message.chat === "100"));
  assert.equal(f.control.isBusy(), false);
});

test("repeated start and stop never mutate an already matching container", async () => {
  for (const [command, running, reply] of [["/server_start", true, /уже запущен/], ["/server_stop", false, /уже остановлен/]]) {
    const f = fixture(() => state(running));
    await f.control.handleUpdate(update(command));
    assert.match(f.text(), reply);
    assert.equal(f.calls.length, 1);
  }
});

test("stop allows a save grace period and confirms the stopped state", async () => {
  let running = true;
  const f = fixture((args) => {
    if (args[0] === "stop") { running = false; return ""; }
    return state(running, { ExitCode: 0 });
  });
  await f.control.handleUpdate(update("/server_stop"));
  assert.deepEqual(f.calls[1], ["stop", "--time", "120", "test.valheim"]);
  assert.match(f.text(), /⏹ Сервер остановлен/);
  const stuck = fixture(() => state(true));
  await stuck.control.handleUpdate(update("/server_stop"));
  assert.match(stuck.text(), /❌ Сервер продолжает работать/);
});

test("forced shutdown is reported without claiming a clean save", async () => {
  let reads = 0;
  const f = fixture((args) => args[0] === "inspect" ? state(++reads === 1, { ExitCode: 137 }) : "");
  await f.control.handleUpdate(update("/server_stop"));
  assert.match(f.text(), /остановлен принудительно/);
  assert.ok(!f.text().includes("⏹ Сервер остановлен"));
});

test("startup failures and timeout do not report readiness or stop the container", async () => {
  for (const mode of ["timeout", "exited", "restarted", "docker-error"]) {
    let reads = 0;
    const f = fixture((args) => {
      if (mode === "docker-error") throw new Error("Synthetic Docker failure");
      if (args[0] === "inspect") {
        reads++;
        return state(reads > 1 && mode !== "exited", { StartedAt: mode === "restarted" && reads > 2 ? "2026-01-02T00:00:00Z" : startedAt });
      }
      return "Starting world";
    });
    await f.control.handleUpdate(update("/server_start"));
    assert.match(f.text(), /❌/);
    assert.ok(!f.text().includes("✅"));
    assert.ok(!f.calls.some((args) => args[0] === "stop"));
    assert.equal(f.control.isBusy(), false);
    if (mode === "timeout") assert.match(f.text(), /оставлен запущенным/);
  }
});

test("paused, restarting and dead containers are rejected without mutation", async () => {
  for (const extra of [{ Paused: true }, { Restarting: true }, { Status: "dead" }]) {
    const f = fixture(() => state(true, extra));
    await f.control.handleUpdate(update("/server_stop"));
    assert.match(f.text(), /переходном или аварийном/);
    assert.equal(f.calls.length, 1);
  }
});

test("external busy operations and overlapping control requests cannot mutate the server", async () => {
  const blocked = fixture(() => assert.fail("busy"), { isBusy: () => true });
  await blocked.control.handleUpdate(update("/server_start"));
  assert.match(blocked.text(), /Повторите команду/);
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = fixture(async () => { await waiting; return state(true); });
  const first = f.control.handleUpdate(update("/server_start"));
  assert.equal(f.control.isBusy(), true);
  await f.control.handleUpdate(update("/server_stop"));
  assert.equal(f.calls.length, 1);
  assert.match(f.text(), /Повторите команду/);
  release();
  await first;
  assert.equal(f.control.isBusy(), false);
});

test("restore cannot create a session or process documents while server control holds the lock", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-restore-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messages = [];
  const restore = createRestoreManager({ adminId: "42", dataDir: dir, isBusy: () => true,
    sendMessage: async (text) => messages.push(text) });
  assert.equal(await restore.handleUpdate(update("/restore")), true);
  const document = update("");
  document.message.document = { file_name: "world.zip" };
  assert.equal(await restore.handleUpdate(document), true);
  assert.ok(messages.every((text) => text.includes("управление сервером")));
  assert.equal(restore.isBusy(), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("invalid container names are rejected before executing Docker", () => {
  assert.throws(() => fixture(() => "", { container: "bad;name" }), /Invalid container/);
});
