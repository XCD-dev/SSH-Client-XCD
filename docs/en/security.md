# Security

## Current controls

- Electron renderer runs with context isolation, Node integration disabled, sandbox enabled, a restrictive Content Security Policy, denied popups, and navigation restricted to the app page.
- Main-process IPC rejects calls from other windows and frames.
- SSH host fingerprints are checked and remembered; an unknown or changed key is not accepted silently.
- SSH passwords are held in memory for a live session and are not written to saved server profiles.
- Local upload paths come from a native system dialog. Local and remote symbolic links are not followed for uploads.
- Remote command logs use redacted labels for operations that include credentials.

## Limits

SSH key and SSH-agent authentication are not implemented. VPN credentials are stored in a local JSON file, not an OS credential vault. The original project source is licensed under Apache-2.0; licensing and notices for bundled sing-box/Cronet assets remain under review. Public release is blocked until those issues are closed. See [Security Audit](../../SECURITY_AUDIT.md).

Report security issues through the repository's private vulnerability reporting channel when it is available. Do not post unpatched vulnerabilities in public issues.
