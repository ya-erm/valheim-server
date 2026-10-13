const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { unzipWorlds } = require("../watcher/restore");

const main = async () => {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/check-archive.js /path/to/world.zip");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "valheim-archive-check-"));
  try {
    const worlds = await unzipWorlds(path.resolve(process.argv[2]), path.join(temp, "extracted"));
    console.log(JSON.stringify(worlds.map(({ files, ...meta }) => meta), null, 2));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
};

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
