# Installation

XCD SSH Client 2.0.0 is not published as a public download yet. The original project source is licensed under Apache-2.0; licensing and notices for bundled sing-box/Cronet binaries and cross-platform release checks are still under review. Do not distribute packages from this source tree.

## Run from source

1. Install Node.js 22.12 or newer and npm.
2. Clone or download the source tree.
3. From its root, run `npm ci`.
4. Run `npm start`.

For platform-specific packages, see [Building](building.md). A configured target is not a supported release until its CI build and platform checks pass. macOS and Windows code signing and notarization are not configured.
