# Architecture

The app has three Electron layers:

- `src/main/main.js` owns the window, validated IPC handlers, dialogs, persistence setup, and service wiring.
- `src/main/preload.js` exposes a narrow `sshClient` bridge through `contextBridge`.
- `src/renderer/` contains the HTML, CSS, and UI logic. It has no direct Node.js access.

`src/main/services/sshService.js` manages SSH sessions, host verification, terminal streams, commands, and SFTP connections. Modules under `src/main/modules/` implement saved servers, known hosts, file operations, VPN profiles, remote VPN operations, and bot management.

The SFTP upload picker runs in the main process so local paths do not come from renderer input. User configuration is stored under Electron's user data path; a small migration copies known legacy files after the XCD rename.
