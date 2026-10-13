const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configure } = require("../scripts/configure-updater");

test("updater configuration preserves existing settings, backs them up privately and is idempotent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-config-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = "# Keep this comment\nEXISTING_SETTING=synthetic-value\nWATCHER_AUTO_UPDATE=false\n";
  fs.writeFileSync(path.join(root, ".env"), previous);
  configure(root, "example/repository");
  const updated = fs.readFileSync(path.join(root, ".env"), "utf8");
  assert.match(updated, /EXISTING_SETTING=synthetic-value/); assert.match(updated, /WATCHER_AUTO_UPDATE=true/);
  const backup = fs.readdirSync(root).find((name) => name.startsWith(".env.before-updater-"));
  assert.equal(fs.readFileSync(path.join(root, backup, ".env"), "utf8"), previous);
  assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
  configure(root, "example/repository");
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), updated);
  assert.equal(fs.readdirSync(root).filter((name) => name.startsWith(".env.before-updater-")).length, 1);
});

test("invalid updater repository leaves configuration untouched", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-config-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".env"), "EXISTING_SETTING=synthetic\n");
  assert.throws(() => configure(root, "invalid\nrepository"));
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "EXISTING_SETTING=synthetic\n");
});
