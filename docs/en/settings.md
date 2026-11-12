# Settings and stored data

The app currently has no separate settings screen. Use the theme button on the connection screen or sidebar to switch between light and dark appearance; the choice is stored in the renderer's local preference storage.

The app stores these files in Electron's application data directory:

- `servers.json`: saved host, port, username, and profile metadata; no SSH password.
- `known-hosts.json`: accepted host key fingerprints.
- `vpn-profiles.json`: VPN endpoint data and credentials.
- `bots.json`: remote bot definitions and timestamps.

VPN credentials are stored in local JSON with restrictive permissions on platforms that support POSIX modes. They are not encrypted by the operating system keychain. Protect the account that owns the app data directory and back up files only to a trusted location.

The XCD rename migration copies recognized files from the prior `desktop-ssh-client` or `Desktop SSH Client` folder when the new location does not already contain them. It does not delete or overwrite the old files.
