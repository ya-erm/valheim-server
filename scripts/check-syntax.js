const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
for (const folder of ["watcher", "scripts", "tests"]) {
  for (const name of fs.readdirSync(path.join(root, folder)).filter((name) => name.endsWith(".js"))) {
    execFileSync(process.execPath, ["--check", path.join(root, folder, name)], { stdio: "inherit" });
  }
}
