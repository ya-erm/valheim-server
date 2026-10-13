# Source and deployment rules

- Maintain the watcher source in this repository. Make changes locally, run
  `npm run check` and `npm test`, review the diff, and commit before deploying.
- Never commit production environment files, deployment hostnames, chat IDs,
  credentials, player data, game worlds, logs, or backups. Use synthetic fixtures
  and neutral configuration examples. Review all staged files before pushing.
- Keep machine-specific `.env` and Compose configuration on deployment hosts.
  Update the four runtime files together and recreate only the watcher service.
- Before deployment, retain a copy of the previous runtime files and the previous
  watcher image for rollback. Verify file hashes inside the running container.
- Updating code does not authorize restoring a world. World replacement remains
  an explicit administrator operation through `/restore_confirm`.
- Use logged file editing tools for authored source changes. Keep unrelated mods
  and data in the parent directory outside this repository.
- Use a generic automation author for generated commits; do not expose a private
  email address or real name through Git metadata.
