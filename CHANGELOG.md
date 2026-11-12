# Changelog

Notable changes to XCD SSH Client are recorded here.

## [2.0.0] - Unreleased

This is a prepared release candidate. It has not been published; see
[SECURITY_AUDIT.md](SECURITY_AUDIT.md) for remaining release blockers.

### Added

- XCD branding, generated application icon and logo, and English/Russian
  documentation.
- Light and dark themes with saved preference, plus an in-app About dialog.
- Native file picker uploads, safe handling of local and remote symlinks, and
  migration of recognized settings from the old application data directory.
- Electron sandboxing and validation of IPC calls from the trusted main frame.
- Cross-platform packaging targets and gated GitHub Actions workflows.

### Changed

- Updated Electron and electron-builder within their existing compatible major
  versions to remove Critical and High npm audit findings.
- Moved remote `sudo` passwords from shell command arguments to SSH standard
  input.

### Known limitations

- SSH private-key and SSH-agent authentication are not implemented.
- SFTP download is not implemented. VPN profile credentials are not stored in
  the operating system keychain.
- Six Moderate npm audit findings remain in the build-only electron-builder /
  minimatch dependency chain; see the audit report.
- Redistribution terms and notices for bundled sing-box/Cronet binaries remain
  under review. This version is not authorized for public distribution.
- Cross-platform packages and end-to-end SSH behavior have not been verified
  on every target platform.
