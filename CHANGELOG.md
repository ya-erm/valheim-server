# Changelog

## 1.1.3

- Add admin-only `/server_start` and `/server_stop`, preserving notification
  subscriptions under `/start` and `/stop`.
- Verify the current startup's world connection and the stopped container state;
  report Docker failures, startup timeouts, and forced shutdowns.
- Serialize server control and prevent conflicting backup, restore, and bot update
  operations while it runs.

## 1.1.2

- Show the currently configured running world's name in `/status`, alongside the
  existing container status and player count. Read the exact Valheim container
  and only its WORLD_NAME setting; stopped containers show no connected map.
- Make commit, push, release publication and verification on both servers the
  default workflow after each completed local change.

## 1.1.1

- Fix multi-source Docker COPY syntax for the legacy builder used by the running
  watcher's update helper.
- Validate the actual updater build mode in both CI and the release workflow
  before publishing a stable release.

## 1.1.0 (prerelease)

- Add versioned GitHub release packages and hourly self-update checks.
- Add `/bot_version`, `/bot_update_check` and admin-only `/bot_update`.
- Verify archive and source checksums, build before stopping the old watcher, and
  roll back after a failed startup or Telegram readiness check.
- Preserve private configuration and game data and postpone updates during
  backup/restore operations.
- This initial release is marked prerelease because its Dockerfile is incompatible
  with the helper's legacy builder. Use 1.1.1 or a later stable release.
