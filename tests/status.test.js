const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getServerStatus } = require("../watcher/world-files");

test("status includes the world from the exact configured running container", async () => {
  const calls = [];
  const text = await getServerStatus("custom.valheim", 3, async (args) => {
    calls.push(args);
    return args[0] === "ps" ? "Up 2 hours (healthy)\n" : "true\nWORLD_NAME=Test World\n";
  });
  assert.match(text, /Карта: Test World/); assert.match(text, /Онлайн: 3/);
  assert.match(text, /Up 2 hours \(healthy\)/);
  assert.equal(calls[0][2], "name=^/custom\\.valheim$");
  assert.equal(calls[1].at(-1), "custom.valheim");
  assert.ok(calls[1][2].includes('"WORLD_NAME"'));
  assert.ok(!calls[1][2].includes("{{json .Config.Env}}"));
});

test("stopped server does not claim a map is connected", async () => {
  const calls = [];
  const text = await getServerStatus("valheim-server", 0, async (args) => { calls.push(args); return ""; });
  assert.match(text, /Не запущен/); assert.match(text, /Карта: не подключена/);
  assert.equal(calls.length, 1);
});

test("a stop between ps and inspect clears the running map", async () => {
  const text = await getServerStatus("valheim-server", 0, async (args) => args[0] === "ps" ? "Up 1 minute" : "false\nWORLD_NAME=OldWorld\n");
  assert.match(text, /Не запущен/); assert.match(text, /не подключена/); assert.ok(!text.includes("OldWorld"));
});

test("missing world is explicitly unknown and Docker errors are not fake stopped status", async () => {
  const text = await getServerStatus("valheim-server", 0, async (args) => args[0] === "ps" ? "Up 1 minute" : "true\n");
  assert.match(text, /Карта: неизвестна/);
  await assert.rejects(getServerStatus("valheim-server", 0, async () => { throw new Error("synthetic Docker error"); }));
  await assert.rejects(getServerStatus("invalid;name", 0));
});
