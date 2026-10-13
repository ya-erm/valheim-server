const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const RUNTIME_FILES = [".dockerignore", "Dockerfile", "watcher.js", "restore.js", "world-files.js",
  "release-schema.js", "updater.js", "update-runner.js", "health-check.js", "version.json"];
const versionParts = (version) => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected a stable x.y.z release version");
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error("Release version is out of range");
  return parts;
};
const compareVersions = (a, b) => {
  const aa = versionParts(a), bb = versionParts(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const validateRelease = (dir) => {
  const manifestFile = path.join(dir, "release.json"), stat = fs.lstatSync(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Invalid release manifest file");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  versionParts(manifest.version);
  if (manifest.schema !== 1 || manifest.tag !== "v" + manifest.version || !/^[a-f0-9]{40}$/.test(manifest.commit)) {
    throw new Error("Incompatible release manifest");
  }
  const names = fs.readdirSync(dir).filter((name) => name !== ".git").sort();
  if (JSON.stringify(names) !== JSON.stringify([...RUNTIME_FILES, "release.json"].sort()) ||
      JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify([...RUNTIME_FILES].sort())) {
    throw new Error("Unexpected or missing release files");
  }
  for (const name of RUNTIME_FILES) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || sha256(file) !== manifest.files[name]) {
      throw new Error("Release file checksum/type mismatch: " + name);
    }
  }
  if (JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8")).version !== manifest.version) throw new Error("Runtime and release versions differ");
  return manifest;
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + ".tmp-" + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
};
module.exports = { RUNTIME_FILES, versionParts, compareVersions, sha256, validateRelease, writeJson };
