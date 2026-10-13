const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { RUNTIME_FILES, validateRelease, writeJson } = require("./release-schema");

const execute = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 300000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    // Command arguments and stderr can contain deployment settings; keep them out of status/logs.
    if (error) reject(new Error(command + " failed (exit " + (error.code ?? "timeout") + ")"));
    else resolve({ stdout, stderr });
  });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const applyUpdate = async (job, runtime = {}) => {
  const run = runtime.run || execute, delay = runtime.sleep || sleep;
  if (!/^[a-f0-9-]{36}$/.test(job.id) || !path.isAbsolute(job.sourceDir) || !path.isAbsolute(job.candidate)) throw new Error("Invalid update job");
  const statusFile = path.join(job.root, job.id, "status.json");
  const status = (phase, extra = {}) => writeJson(statusFile, { id: job.id, version: job.version, phase, updatedAt: Date.now(), ...extra });
  const manifest = validateRelease(job.candidate);
  if (manifest.version !== job.version) throw new Error("Update job/version mismatch");
  const inspected = JSON.parse((await run("docker", ["inspect", job.container])).stdout)[0];
  if (inspected.Image !== job.previousImage || inspected.Config.Labels["com.docker.compose.project.working_dir"] !== job.sourceDir) throw new Error("Watcher deployment changed during update preparation");
  const config = inspected.Config.Labels["com.docker.compose.project.config_files"];
  if (config !== path.join(job.sourceDir, "docker-compose.yaml")) throw new Error("Updater requires one docker-compose.yaml in the watcher directory");
  const service = inspected.Config.Labels["com.docker.compose.service"];
  const project = inspected.Config.Labels["com.docker.compose.project"];
  if (service !== "watcher") throw new Error("Update target must be the watcher service");
  if (!project || !/^[a-z0-9_-]+$/.test(project)) throw new Error("Invalid Compose project name");
  const imageTag = inspected.Config.Image;
  const candidateTag = "valheim-watcher:update-" + job.id;
  const backup = path.join(job.sourceDir, "code-backups", "release-" + job.id);
  let snapshotComplete = false, sourceChanged = false, imageChanged = false, recreateAttempted = false;
  const up = () => run("docker", ["compose", "--project-name", project, "--project-directory", job.sourceDir, "-f", config,
    "up", "-d", "--no-deps", "--no-build", "--force-recreate", service]);
  try {
    status("building");
    for (const name of RUNTIME_FILES.filter((name) => name.endsWith(".js"))) await run("node", ["--check", path.join(job.candidate, name)]);
    await run("docker", ["build", "--tag", candidateTag, job.candidate]);
    // The original container remains running until the new image has built successfully.
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const present = [];
    for (const name of RUNTIME_FILES) {
      const original = path.join(job.sourceDir, name);
      if (fs.existsSync(original)) { fs.copyFileSync(original, path.join(backup, name)); present.push(name); }
    }
    writeJson(path.join(backup, "snapshot.json"), { present, image: job.previousImage });
    snapshotComplete = true;
    await run("docker", ["image", "tag", job.previousImage, "valheim-watcher:rollback-" + job.id]);
    status("applying");
    sourceChanged = true;
    for (const name of RUNTIME_FILES) {
      const target = path.join(job.sourceDir, name), temporary = target + ".update-" + job.id;
      fs.copyFileSync(path.join(job.candidate, name), temporary);
      fs.chmodSync(temporary, 0o644);
      fs.renameSync(temporary, target);
    }
    await run("docker", ["image", "tag", candidateTag, imageTag]);
    imageChanged = true;
    const since = Date.now();
    recreateAttempted = true;
    await up();
    status("verifying");
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      try {
        await run("docker", ["exec", job.container, "node", "/app/health-check.js", job.version, String(since)], { timeout: 10000 });
        await delay(10000);
        await run("docker", ["exec", job.container, "node", "/app/health-check.js", job.version, String(since)], { timeout: 10000 });
        healthy = true; break;
      } catch { await delay(3000); }
    }
    if (!healthy) throw new Error("New watcher did not become healthy");
    status("success");
    return "success";
  } catch (error) {
    try {
      if (snapshotComplete && sourceChanged) {
        const snapshot = JSON.parse(fs.readFileSync(path.join(backup, "snapshot.json"), "utf8"));
        for (const name of RUNTIME_FILES) {
          const target = path.join(job.sourceDir, name);
          if (snapshot.present.includes(name)) fs.copyFileSync(path.join(backup, name), target);
          else fs.rmSync(target, { force: true });
          fs.rmSync(target + ".update-" + job.id, { force: true });
        }
      }
      if (imageChanged) await run("docker", ["image", "tag", job.previousImage, imageTag]);
      if (recreateAttempted) {
        const since = Date.now();
        await up();
        let recovered = false;
        for (let i = 0; i < 40; i++) {
          try { await run("docker", ["exec", job.container, "node", "/app/health-check.js", job.previousVersion, String(since)], { timeout: 10000 }); recovered = true; break; }
          catch { await delay(3000); }
        }
        if (!recovered) throw new Error("Previous watcher did not become healthy after rollback");
      }
      status(recreateAttempted ? "rolled_back" : "failed", { error: error.message });
      return recreateAttempted ? "rolled_back" : "failed";
    } catch {
      status("rollback_failed", { error: "Update failed and automatic rollback requires attention" });
      return "rollback_failed";
    }
  }
};

if (require.main === module) {
  const jobFile = process.argv[2];
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  applyUpdate(job).then((result) => { console.log("[updater-runner] " + result); process.exitCode = result === "success" ? 0 : 1; })
    .catch(() => { writeJson(path.join(job.root, job.id, "status.json"), { id: job.id, version: job.version, phase: "failed", error: "Update preparation failed", updatedAt: Date.now() }); process.exitCode = 1; });
}
module.exports = { applyUpdate, execute };
