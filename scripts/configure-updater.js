const fs = require("node:fs");
const path = require("node:path");

const configure = (directory, repository) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Expected OWNER/REPO");
  const file = path.join(directory, ".env");
  const previous = fs.readFileSync(file, "utf8");
  const keys = /^(?:WATCHER_RELEASE_REPO|WATCHER_AUTO_UPDATE|WATCHER_CONTAINER)\s*=/;
  const lines = previous.split("\n").filter((line) => !keys.test(line.trim()));
  const updated = lines.join("\n").replace(/\n*$/, "\n") +
    "WATCHER_RELEASE_REPO=" + repository + "\nWATCHER_AUTO_UPDATE=true\nWATCHER_CONTAINER=valheim-watcher\n";
  if (updated === previous) return;
  const backup = fs.mkdtempSync(path.join(directory, ".env.before-updater-"));
  fs.chmodSync(backup, 0o700);
  fs.writeFileSync(path.join(backup, ".env"), previous, { mode: 0o600 });
  fs.writeFileSync(file, updated, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};
if (require.main === module) {
  try { configure(process.argv[2], process.argv[3]); console.log("Updater configuration enabled; existing settings preserved."); }
  catch { console.error("Could not configure updater; check the directory and existing .env file."); process.exitCode = 1; }
}
module.exports = { configure };
