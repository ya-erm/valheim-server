# Valheim server watcher

Canonical source for the Telegram/Yandex Messenger watcher and world backup/restore
tools. Requires Node.js 22+, `zip`, `unzip`, and Docker with Compose on deployment
hosts. The watcher itself has no npm dependencies.

## Local checks

```sh
npm run check
npm test
```

Tests use synthetic worlds, temporary directories and simulated Docker operations.
They never start or stop a game server. Python 3 is required by the unsafe-ZIP tests.
To validate an existing backup without installing it or contacting Telegram:

```sh
node scripts/check-archive.js /path/to/world.zip
```

This command extracts into a temporary directory, prints only world metadata,
and removes the temporary files. Keep real archives outside this repository.

## World restoration

`/restore` accepts ZIP archives containing one or more legacy `.db` + `.fwl` pairs
or segmented world directories. A segmented world must retain its directory name,
`_main.<checkpoint>.db2`, `.fwl2`, `.chunks`, `.ok`, and every chunk referenced by
the newest completed checkpoint. Wrapping folders and mixed-format archives work.
Standalone uploads remain limited to the two legacy files; use ZIP for segmented
worlds. Public Yandex Disk links use the same ZIP validation.

The bot validates archive paths, duplicates, file types, expanded size, metadata,
save versions and referenced chunks before offering `/restore_confirm`. Nothing
is installed until the administrator confirms. The current chunk-manifest layout
is checked against its declared count; incompatible layouts are rejected.

Before replacement the bot creates a safety backup and snapshots the target world.
Replacement removes competing representations of that target, installs the entire
selected world, sets usable directory/file permissions, and checks server startup.
On failure it restores the target files, previous active-world selection and
previous running/stopped state. A stopped server is backed up directly from disk.
Partial snapshots never replace the original data.

## Deployment and updates

Copy `watcher/.env.example` and `watcher/docker-compose.example.yaml` to private
deployment configuration files and fill them in on the server. The real game
Compose project, credentials and `active-world.env` stay outside this repository.
Keep host-specific settings there; do not put deployment hostnames, chat IDs,
account identifiers or credentials into source files.

For an existing deployment, back up its code and image, then copy all runtime
files listed in `watcher/release-schema.js` together.
Preserve existing `.env`, Compose files and `data/`. Build and recreate only the
watcher service:

```sh
docker compose build watcher
docker compose up -d --no-deps watcher
```

Check the container logs and compare hashes of the deployed source with the files
inside `/app`. Updating the watcher does not restart Valheim or restore a world.
After updating, start a new `/restore` session; in-memory sessions do not survive
a watcher restart. Future code changes should be made and committed here before
deploying to either server.

## GitHub releases and automatic updates

Set `WATCHER_RELEASE_REPO=OWNER/REPO` and `WATCHER_AUTO_UPDATE=true` in the private
deployment `.env`. The repository is public; no GitHub token is required. The bot
checks the latest published stable release every hour, and once shortly after
startup. Drafts, prereleases and older versions are never installed. Unchanged
checks are silent. Backup and active restore sessions postpone installation.

Telegram commands:

- `/bot_version`: show the installed version and automatic-update status.
- `/bot_update_check`: check for a newer release, without installing (admin).
- `/bot_update`: download and install a newer release immediately (admin).

The release workflow runs checks and tests, packages the runtime allowlist, and
attaches `valheim-watcher.zip` and its SHA-256 file to the GitHub release. No
configuration, game worlds, logs or player data are included. To publish:

1. Update both `package.json` and `watcher/version.json` to the same stable version.
2. Run `npm run check` and `npm test`, commit, and push the code.
3. Create and push the matching `vX.Y.Z` tag. The release workflow handles packaging
   and publication after validation succeeds.

The updater checks GitHub's asset SHA-256 digest, file allowlist, per-file hashes,
manifest version and syntax. It builds the candidate image while the old watcher
continues running. A separate helper container mounts the watcher source directory
and its data directory and recreates **only** the watcher service. Valheim is not
restarted. The helper survives replacement of the original bot.

Readiness requires the expected version, a fresh process/heartbeat, and a successful
Telegram polling/webhook response. If readiness fails, the helper restores the
previous source files and image and verifies the rolled-back watcher. A release
that failed installation is not attempted every hour again; `/bot_update` permits
an explicit admin retry. An interrupted helper or failed rollback stops subsequent
updates and sends an alert for manual inspection.

Update state and job logs live under `watcher/data/updater`; source backups remain
in `watcher/code-backups/release-*` and previous images have `valheim-watcher:rollback-*`
tags. Keep these private and retain them until an update is verified. For manual
recovery, inspect the job status and helper Docker logs, restore the recorded image
and code, recreate only the watcher, then clear the active job lock. Do not clear a
lock while its helper is still running. Disable hourly installation by setting
`WATCHER_AUTO_UPDATE=false` and recreating the watcher.

## Data boundaries

Only source, synthetic tests, documentation, and configuration examples belong in
Git. `.gitignore` and Docker ignore files exclude environment files, runtime data,
logs, worlds, player profiles, backups and archives. Inspect the staged file list
and diff before every commit; never add production dumps or a real world as a
test fixture. Repository commits use a generic automation identity.
