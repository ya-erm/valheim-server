# Source and deployment rules

- Maintain the watcher source in this repository. Make changes locally, run
  `npm run check` and `npm test`, review the diff, and commit before deploying.
- After each completed change, immediately commit and push it and publish a new
  patch release by default. This is the user's standing authorization; do not ask
  for confirmation again. Keep both version files in sync, push the matching tag,
  and wait for CI and the release workflow to succeed. Never release failing
  checks or include unrelated changes or private data in the commit.
- Let both servers install the published release through their updater. Verify
  installed versions and readiness on both servers. If hourly checks are not yet
  due, an admin update check can trigger installation after confirming no active
  backup/restore operation. Avoid copying runtime files directly after bootstrap.
- Never commit production environment files, deployment hostnames, chat IDs,
  credentials, player data, game worlds, logs, or backups. Use synthetic fixtures
  and neutral configuration examples. Review all staged files before pushing.
- Keep machine-specific `.env` and Compose configuration on deployment hosts.
  Update the runtime files listed in `watcher/release-schema.js` together and
  recreate only the watcher service.
- Before deployment, retain a copy of the previous runtime files and the previous
  watcher image for rollback. Verify file hashes inside the running container.
- Updating code does not authorize restoring a world. World replacement remains
  an explicit administrator operation through `/restore_confirm`.
- Use logged file editing tools for authored source changes. Keep unrelated mods
  and data in the parent directory outside this repository.
- Use a generic automation author for generated commits; do not expose a private
  email address or real name through Git metadata.
- For releases, keep `package.json` and `watcher/version.json` in sync, run the
  checks, commit and push, then push the matching `vX.Y.Z` tag. GitHub Actions
  packages only the runtime allowlist and publishes it after tests pass.
- The hourly updater and Telegram update commands consume published stable
  GitHub Releases only. Keep GitHub credentials out of deployments; this repository
  is public and downloads do not need authentication. Preserve update/rollback
  state under the ignored `data/updater` directory.
