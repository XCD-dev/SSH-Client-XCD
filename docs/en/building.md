# Building

Use Node.js 22.12 or newer. From the repository root:

```sh
npm ci
npm test
npm run lint
```

Start the development app with `npm start`. The package scripts configure these targets:

```sh
npm run dist:win       # Windows x64 EXE installers
npm run dist:linux     # Linux x64 AppImage
npm run dist:mac:arm64 # macOS arm64 DMG
npm run dist:mac:x64   # macOS x64 DMG
```

Artifacts are written to `release/`. The Debian package target is disabled until the project homepage and public maintainer email are configured. macOS/Windows signing and notarization are not configured. The bundled sing-box/Cronet license and notice review is still in progress; do not distribute packages until it is complete.
