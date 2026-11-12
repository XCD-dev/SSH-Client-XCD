# Troubleshooting

- **Host key changed:** stop and verify the new fingerprint through a trusted channel. A changed key can indicate server reinstallation or a man-in-the-middle attack.
- **Authentication rejected:** check host, port, username, password, and server password-auth policy. SSH keys are not supported by this version.
- **Upload fails:** check remote write permissions and free space. Uploads refuse symbolic links and require a stable SFTP connection.
- **File preview fails:** only regular text files up to 256 KB can be previewed.
- **VPN engine unavailable:** check the engine status. A system `sing-box` on `PATH` can be used when the bundled engine is unavailable; bundled binary support varies by OS and architecture.
- **Packaging fails:** run `npm ci`, check the platform-specific prerequisites, and keep the full builder error. The four configured targets have not all been validated yet.
