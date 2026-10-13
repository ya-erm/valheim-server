const fs = require("node:fs");
const path = require("node:path");

const checkHealth = (root, version, since, now = Date.now()) => {
  const health = JSON.parse(fs.readFileSync(path.join(root, "health.json"), "utf8"));
  if (health.version !== version || !health.telegramReady || health.startedAt < since || now - health.heartbeatAt > 30000) {
    throw new Error("Watcher has not become ready");
  }
  return health;
};
if (require.main === module) {
  try { checkHealth("/app/data/updater", process.argv[2], Number(process.argv[3])); }
  catch { process.exitCode = 1; }
}
module.exports = { checkHealth };
