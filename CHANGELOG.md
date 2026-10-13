# Changelog

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
