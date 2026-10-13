const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { RUNTIME_FILES, sha256, versionParts, validateRelease, writeJson } = require("../watcher/release-schema");

const buildPackage = (root, commit) => {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
  versionParts(version);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a Git commit SHA");
  if (JSON.parse(fs.readFileSync(path.join(root, "watcher/version.json"))).version !== version) throw new Error("package.json and runtime versions must match");
  const directory = path.join(root, "dist", "release");
  fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory, { recursive: true });
  const hashes = {};
  for (const name of RUNTIME_FILES) {
    const source = path.join(root, "watcher", name);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Runtime source must be a regular file");
    fs.copyFileSync(source, path.join(directory, name));
    fs.chmodSync(path.join(directory, name), 0o644);
    hashes[name] = sha256(source);
  }
  writeJson(path.join(directory, "release.json"), { schema: 1, version, tag: "v" + version, commit, files: hashes });
  validateRelease(directory);
  const archive = path.join(root, "dist", "valheim-watcher.zip");
  fs.rmSync(archive, { force: true });
  execFileSync("zip", ["-j", "-q", archive, ...RUNTIME_FILES, "release.json"], { cwd: directory });
  fs.writeFileSync(path.join(root, "dist", "valheim-watcher.zip.sha256"), sha256(archive) + "  valheim-watcher.zip\n");
  return archive;
};
if (require.main === module) {
  const root = path.join(__dirname, "..");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  console.log(buildPackage(root, commit));
}
module.exports = { buildPackage };
