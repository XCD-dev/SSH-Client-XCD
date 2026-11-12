# SSH connections

Enter a host name or IP address, port (default 22), username, and password. The connection is created by the main process with `ssh2`.

## Host key checks

The first connection to a host displays its SSH fingerprint. Verify it independently before trusting it. The fingerprint is saved locally. A changed fingerprint triggers a warning and requires a deliberate decision; do not accept an unexpected change.

## Saved servers and sessions

Saved profiles hold a name, host, port, username, and timestamps. Passwords are not saved. While connected, the password remains in memory so the app can reconnect after a network interruption; it is cleared when the session closes. Several sessions can remain active at once.

Authentication by private key or SSH agent is not implemented yet. See [SSH keys](ssh-keys.md).
