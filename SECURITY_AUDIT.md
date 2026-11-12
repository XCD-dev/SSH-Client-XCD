# Security and release audit

**Review date:** 2026-11-12
**Scope:** current working tree and local Git history
**Status:** pre-release review; the project has not been published

This report records checks completed in this workspace. It is not a third-party
penetration test or a claim that every platform and workflow has passed. The
release workflow is intentionally gated until the licensing, notice, and
publication checks below are resolved.

## Findings by severity

| Severity | Result | Finding |
|---|---:|---|
| Critical | 0 confirmed | No Critical npm audit finding remains after compatible dependency updates. |
| High | 0 confirmed | No High npm audit finding remains after compatible dependency updates. |
| Medium | 6 npm audit records | `minimatch` GHSA-g3hv-75wg-m249 is reported through `@electron/universal` / `app-builder-lib` / `electron-builder`. This is in the build toolchain, not the packaged runtime dependency set. npm offers a fix by downgrading electron-builder to 25.1.0; that major downgrade was not applied. `npm audit --audit-level=high` passes. |
| Medium | Design limitation | VPN profile secrets are stored in a local JSON file. File permissions are tightened where supported, but OS keychain encryption is not implemented. |
| Low | Release limitation | Windows and macOS signing, macOS notarization, SSH private-key authentication, SSH-agent integration, and SFTP download are not implemented. |

The six npm audit records refer to one moderate advisory propagated through
several packages. The high/critical threshold is clear; a remaining moderate
finding still requires monitoring and review before each release.

## Release blockers

1. **Bundled binary licenses and notices remain unresolved.** The owner confirms
   ownership of the checked-in binary files. Hashes also match official
   SagerNet release payloads, whose code retains its own terms: GPL-3.0-or-later
   plus sing-box's name/association restriction, and GPL-3.0-or-later Cronet
   code based on Chromium 148.0.7778.96. The Chromium base license is included,
   but the full build-specific third-party notice inventory and corresponding
   GPL source or compliant source offer are not. Do not distribute the app
   bundle until those obligations are resolved. See
   [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
2. **Runtime verification is pending.** GitHub CI successfully packaged
   Windows x64, Linux x64, macOS arm64, and the formerly configured macOS x64.
   Intel Macs are no longer supported. Installation and real SSH
   flows have not been verified on every platform. The macOS and Windows
   packages are unsigned; macOS notarization is not configured. Debian packaging
   is disabled until project homepage and maintainer email metadata are available.

The private GitHub repository was initialized from a clean snapshot with a
GitHub no-reply author address. The original local checkout retains its own
history and uncommitted changes; its historical author metadata was not uploaded.

These are release blockers even though no Critical or High npm audit findings
are currently reported.

## Checks completed

- Reviewed Electron window options, preload exposure, navigation and popup
  policy, webview attachment, IPC sender-frame checks, and the renderer CSP.
- Reviewed SSH host-key verification and known-host handling, connection
  retries, terminal/session handling, command construction, remote `sudo`
  password transport, and session teardown.
- Reviewed SFTP upload path handling, native local-file selection, local and
  remote symlink handling, and remote directory creation behavior.
- Ran `npm audit`; it reported 0 Critical, 0 High, 6 Moderate, and 0 Low
  findings. The Moderate entries are described above.
- Re-ran `npm test` (32 passed) and `npm run lint`; both passed.
- `npm audit --audit-level=high` passed; the full audit still reports six
  Moderate findings in the build-only Electron packaging dependency chain.
- Inspected packaged `app.asar` contents for macOS arm64/x64, Linux x64, and
  Windows x64 directory output. Each includes the project and third-party
  license files; `seed.txt` is absent.
- Ran Gitleaks 8.30.1 against a snapshot of the current source tree (including
  untracked files) and all three local commits; both scans reported no leaks.
  A broad directory scan that also included ignored build output found one
  private-key rule match in the raw macOS arm64 `app.asar`; scanning the
  extracted app archive reported no leak. This is an archive-container match,
  not evidence of a credential in the extracted files. The earlier DMG scan
  also reported no leaks. These scans do not establish that no secret has ever
  existed outside the scanned files and Git history. `seed.txt` is excluded
  from the configured package file list.
- The owner confirmed ownership of the original application and checked-in
  binary files. Apache-2.0 applies to original project code; it does not replace
  third-party licenses or notices.
- Verified release archive digests against GitHub release metadata and compared
  the checked-in sing-box and Cronet payload SHA-256 values to the extracted
  official assets. Windows uses sing-box v1.13.12; macOS arm64 and Linux amd64
  use v1.13.14. Details are recorded in `bin/sing-box/README.md`.
- Reviewed the packaged npm runtime dependency closure: eight packages use
  MIT, BSD-3-Clause, or Unlicense. Electron and Chromium license texts are
  present in the built macOS app; electron-builder is build-only. The complete
  third-party notice inventory still needs review for every target package.
- Reviewed dependency license metadata in `package-lock.json`: 291 package
  entries are recorded, including MIT, ISC, BSD, Apache-2.0, and other declared
  licenses. This metadata review does not replace a full license notice
  inventory for the final distributed application.
- Reviewed Git history metadata; Gitleaks found no credential in the three
  commits, but the local author identity finding above must be resolved before
  publishing.
- Verified the app's first-run state, theme switch, and About dialog using an
  isolated test profile. A launch against the standard profile showed existing
  saved connections; it was stopped before connecting. Screenshots were
  captured only from the isolated profile: `docs/screenshots/login-dark.png`,
  `docs/screenshots/login-light.png`, and `docs/screenshots/about-light.png`.
- Built the macOS arm64 DMG from the current source in a temporary path. The
  artifact is unsigned because this machine has no trusted Developer ID
  Application certificate.

## Security controls added or verified in source

- Electron `contextIsolation`, `sandbox`, `webSecurity`, and
  `nodeIntegration: false` are enabled. The preload exposes a bounded API and
  no longer exposes renderer-to-filesystem path resolution.
- Main-process IPC rejects calls from anything except the expected renderer
  main frame. Navigation, new windows, and webview attachment are restricted.
- SSH host fingerprints are checked on first use and compared against stored
  fingerprints on later connections. A changed fingerprint requires explicit
  user confirmation.
- Upload selection is performed by the operating system file dialog. Upload
  rejects symlink sources and does not silently treat arbitrary SFTP errors as
  missing files.
- Remote `sudo` passwords are sent over the active SSH stream's standard input
  rather than embedded in shell command text.
- Legacy settings are copied only when the destination does not exist; legacy
  files are not deleted or overwritten.

## Verification still required

Before making the repository public or creating a release:

- Repeat the secret scan immediately before publication and revoke any
  credential if one is found.
- Complete package-level third-party notices and review the sing-box and
  Cronet/Chromium license obligations for every distributed platform.
- Verify install/launch behavior on Windows, Linux, and macOS arm64.
- Exercise real SSH password login, host-key mismatch, terminal, reconnect,
  multiple sessions, SFTP upload, and app shutdown on supported hosts. SSH key
  authentication and SFTP download remain unsupported features.

GitHub release publication fails closed unless tests and target builds pass,
`LICENSE` and `THIRD_PARTY_NOTICES.md` are reviewed, and repository variable
`XCD_RELEASE_APPROVED` is explicitly set to `true` after that review.
