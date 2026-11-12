# Bundled sing-box binaries

The desktop app detects and starts the bundled engine in local mixed
SOCKS/HTTP proxy mode. Remote Linux installation uploads the Linux bundle
over the active SSH session.

Expected layout:

```text
bin/sing-box/win32/sing-box.exe
bin/sing-box/linux/sing-box
bin/sing-box/macos/sing-box
```

The app prefers the bundled binary and falls back to `sing-box` from `PATH`.
If neither is usable, the VPN screen reports it in the engine status block.

The checked-in binaries were compared byte-for-byte with official SagerNet
release archives. Archive digests match the GitHub release metadata; the
payload digests below match the files in this directory.

| Platform | Upstream release archive | Archive SHA-256 | Bundled payload SHA-256 |
|---|---|---|---|
| macOS arm64 | [sing-box v1.13.14](https://github.com/SagerNet/sing-box/releases/tag/v1.13.14), `sing-box-1.13.14-darwin-arm64.tar.gz` | `73e8967b0fc08e17bce4263ca56ebc394822401a16497a1c4e02316c888202ab` | `sing-box`: `813d8effd02a19572a8d75aef29fc073101404ca535b2496be86f21827c7684d` |
| Linux amd64 | [sing-box v1.13.14](https://github.com/SagerNet/sing-box/releases/tag/v1.13.14), `sing-box-1.13.14-linux-amd64.tar.gz` | `f48703461a15476951ac4967cdad339d986f4b8096b4eb3ff0829a500502d697` | `sing-box`: `68aeab83cc4ab2659a5b92232261a20746ccdafc3b3d1e19b2d63247eec3bbf7`; `libcronet.so`: `dc7293a929dffa695aae1a89555e7366158fa0a3f40bbe3012d445bc05c99672` |
| Windows amd64 | [sing-box v1.13.12](https://github.com/SagerNet/sing-box/releases/tag/v1.13.12), `sing-box-1.13.12-windows-amd64.zip` | `e93fc531134eb1beb4efa3c74990a24e48456098a31c03b60d5ddf17f223cf98` | `sing-box.exe`: `64b1dfaed6fa758295233fd0bec8b32cf2115f29773adbf38e0f026c3c7986f2`; `libcronet.dll`: `c7434cfa93c3041321dd19111c4de6c52b8a9531a65661ba45425d3c51ec69e2` |

The sing-box v1.13.14 release pins [`cronet-go` commit
`98d539ce67568fb911654e66a14cf4247ed833ec`](https://github.com/SagerNet/cronet-go/tree/98d539ce67568fb911654e66a14cf4247ed833ec); v1.13.12 pins
[`2faf34666c2cc8234f10f2ab6d4c4d6104d34ae2`](https://github.com/SagerNet/cronet-go/tree/2faf34666c2cc8234f10f2ab6d4c4d6104d34ae2). The upstream sing-box LICENSE
includes GPL-3.0-or-later terms and an additional restriction on using its
name or implying association without prior consent. The `cronet-go` project is
also GPL-3.0-or-later. Both pinned `cronet-go` revisions reference [NaiveProxy
Chromium `148.0.7778.96`](https://github.com/SagerNet/naiveproxy/blob/888e114241c89b05fac4e4ee01482d7bd89ca15a/CHROMIUM_VERSION) at commit
[`888e114241c89b05fac4e4ee01482d7bd89ca15a`](https://github.com/SagerNet/naiveproxy/tree/888e114241c89b05fac4e4ee01482d7bd89ca15a). The Cronet release assets contain
the libraries but not a generated Chromium third-party credits page. See
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) for the remaining
license and notice review.
