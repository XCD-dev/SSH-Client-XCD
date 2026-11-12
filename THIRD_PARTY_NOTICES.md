# Third-party materials and license review

This is a preliminary inventory, not a grant to redistribute the application.
The original application source is licensed under Apache-2.0. That license does
not cover third-party dependencies or bundled binaries. Their redistribution
rights and notice obligations still apply. The project owner confirms ownership
of the checked-in binary files and authorizes their inclusion in the project;
this does not replace the licenses for the code incorporated into those files.
Do not publish or distribute the application bundle until the remaining notice
and source obligations are resolved.

## Bundled application dependencies

The packaged npm runtime dependency closure includes `ssh2` 1.17.0 (MIT),
`asn1` 0.2.6 (MIT), `bcrypt-pbkdf` 1.0.2 (BSD-3-Clause), `buildcheck` 0.0.7
(MIT), `cpu-features` 0.0.10 (MIT), `nan` 2.27.0 (MIT), `safer-buffer` 2.1.2
(MIT), and `tweetnacl` 0.14.5 (Unlicense). Electron 42.11.18 is MIT-licensed;
the app bundle includes Electron and Chromium license texts. `electron-builder`
26.18.0 is build-only. The lockfile contains 291 package entries, including
build-time packages; verify actual notices against every final target package
before distribution. See `package-lock.json` for pinned versions and integrity
hashes.

The app bundle includes the package-provided MIT, BSD-3-Clause, and Unlicense
texts above, plus Electron and Chromium license files. The GPL-3.0 text, the
upstream sing-box license notice, and the cronet-go license text are included
under [`third_party_licenses/`](third_party_licenses/). Cronet's full
Chromium-derived notice inventory is still pending. The Linux and Windows shared
libraries match the Cronet v148.0.7778.96-1 release. The macOS arm64 sing-box
is CGO-enabled and includes a Cronet library module, so it requires its own
notice review. The Chromium BSD-style license is included as
[`Chromium-LICENSE.txt`](third_party_licenses/Chromium-LICENSE.txt), but this
does not cover the separate third-party libraries linked into Cronet. The
upstream version and license are recorded in [NaiveProxy's pinned version
file](https://github.com/SagerNet/naiveproxy/blob/888e114241c89b05fac4e4ee01482d7bd89ca15a/CHROMIUM_VERSION)
and [Chromium source license](https://github.com/SagerNet/naiveproxy/blob/888e114241c89b05fac4e4ee01482d7bd89ca15a/src/LICENSE).
Chromium documents its third-party credits as output generated from dependency
metadata by its license tooling; the required output for this Cronet build is
not present in the release assets.

For review, 35 upstream license, copyright, and notice files found in the pinned
source tree are collected in [the Chromium source license index](third_party_licenses/chromium-source/INDEX.md).
Their upstream Git blob hashes were verified. The [metadata cross-check](third_party_licenses/chromium-source/METADATA.md)
covers 37 upstream metadata files and all 31 unique license paths they reference.
This source-tree collection is not a build-specific dependency inventory and may
omit notices stored under other names.

## Bundled sing-box assets

| Asset | Verified provenance | License and notice status |
|---|---|---|
| `bin/sing-box/macos/sing-box` | Byte-for-byte match to SagerNet sing-box v1.13.14 `darwin-arm64` release archive. Archive and payload hashes are in [`bin/sing-box/README.md`](bin/sing-box/README.md). | GPL-3.0-or-later plus upstream name/association restriction. The CGO-enabled binary includes a Cronet library module and also needs its Chromium-derived notices reviewed. See [`sing-box-LICENSE.txt`](third_party_licenses/sing-box-LICENSE.txt) and [`GPL-3.0.txt`](third_party_licenses/GPL-3.0.txt). |
| `bin/sing-box/linux/sing-box` | Byte-for-byte match to SagerNet sing-box v1.13.14 `linux-amd64` release archive. | Same sing-box license terms as above. |
| `bin/sing-box/win32/sing-box.exe` | Byte-for-byte match to SagerNet sing-box v1.13.12 `windows-amd64` release archive. | Same sing-box license terms as above. |
| `bin/sing-box/{linux,win32}/libcronet.*` | Byte-for-byte match to the Linux v1.13.14 and Windows v1.13.12 sing-box release archives. Both pinned `cronet-go` revisions use Chromium 148.0.7778.96; see [`bin/sing-box/README.md`](bin/sing-box/README.md). | `cronet-go` is GPL-3.0-or-later; its license text is [`cronet-go-LICENSE.txt`](third_party_licenses/cronet-go-LICENSE.txt). Chromium's BSD-style license is included. The official Cronet release assets contain the shared libraries but no generated Chromium third-party credits page. That full, build-specific notice inventory remains outstanding. |

The Windows sing-box executable also embeds Wintun 0.14.1's amd64 DLL through
`github.com/sagernet/sing-tun` v0.8.9. Its embedded bytes match the DLL in the
[official Wintun archive](https://www.wintun.net/builds/wintun-0.14.1.zip)
(archive SHA-256 `07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51`).
Wintun's prebuilt binaries have separate redistribution terms, reproduced
unchanged in [`wintun-0.14.1-LICENSE.txt`](third_party_licenses/wintun-0.14.1-LICENSE.txt).
Review those terms for this distribution; the Go module's MIT notice alone does
not cover the prebuilt DLL. Its upstream GPLv2 source is available at
[Wintun 0.14.1](https://git.zx2c4.com/wintun/tag/?h=0.14.1),
commit `bfef136abfa1665c2592be09a7e383d646cdbe6e`; the release's source archive
was checked against that commit's Git blobs.

The archive digest metadata and each checked-in binary's SHA-256 were verified
against the official release payloads. This proves payload identity and
provenance, not that all redistribution obligations have been completed.

## Pinned upstream source references

- sing-box v1.13.14 (macOS arm64 and Linux x64): [source tag](https://github.com/SagerNet/sing-box/tree/v1.13.14) and [source archive](https://github.com/SagerNet/sing-box/archive/refs/tags/v1.13.14.tar.gz).
- sing-box v1.13.12 (Windows x64): [source tag](https://github.com/SagerNet/sing-box/tree/v1.13.12) and [source archive](https://github.com/SagerNet/sing-box/archive/refs/tags/v1.13.12.tar.gz).
- cronet-go revisions: the macOS/Linux v1.13.14 binaries embed [binding commit 05ab0dc](https://github.com/SagerNet/cronet-go/tree/05ab0dc17597f5473eb60d3864c7072273b1b2cf), and the v1.13.14 release pins [build-source commit 98d539c](https://github.com/SagerNet/cronet-go/tree/98d539ce67568fb911654e66a14cf4247ed833ec). The Windows v1.13.12 binary embeds [binding commit 2faf346](https://github.com/SagerNet/cronet-go/tree/2faf34666c2cc8234f10f2ab6d4c4d6104d34ae2); the Linux and Windows shared libraries match [release commit e7f6f6f](https://github.com/SagerNet/cronet-go/tree/e7f6f6f5b7ce226f686f6cb5d068a63da6657ccd). These source revisions reference [NaiveProxy commit 888e114](https://github.com/SagerNet/naiveproxy/tree/888e114241c89b05fac4e4ee01482d7bd89ca15a).

These references identify source revisions for investigation. They are not yet
verified as a complete corresponding-source package for the distributed
binaries: the recursive dependencies, build scripts, and full build-specific
Chromium third-party notices still need to be collected and checked.

For reproducing the missing target-specific Cronet notice inventory, the
[`v148.0.7778.96-1` build implementation](https://github.com/SagerNet/cronet-go/blob/e7f6f6f5b7ce226f686f6cb5d068a63da6657ccd/cmd/build-naive/cmd_build.go)
generates an architecture-specific GN output directory and builds the `cronet`
target for the Windows DLL and Linux shared library. The macOS static library's
[build-source revision](https://github.com/SagerNet/cronet-go/blob/98d539ce67568fb911654e66a14cf4247ed833ec/cmd/build-naive/cmd_build.go)
uses the `cronet_static` target. The source-tree collection above must be
checked against each matching target's generated GN dependency graph; an Android
or Electron notice list is not a substitute.

The module metadata embedded in the binaries was extracted with `go version -m`
and is recorded in [the dependency inventory](docs/upstream/sing-box-dependencies.txt).
It lists 95 macOS, 104 Linux, and 100 Windows modules; module names and versions
represent 122 unique module versions. All downloaded module checksums matched
the embedded metadata, and their root and identified nested license and notice
files are collected in [the Go module license index](third_party_licenses/go-modules/INDEX.md).
Notices stored under other names and other distribution obligations still need review.

## Required completion before release

- Produce a package-level inventory of all shipped runtime dependencies and
  required license texts/notices.
- Review GPL-3.0-or-later obligations, the upstream sing-box name/association
  restriction, and Cronet's Chromium-derived notices for each distributed
  platform. Provide corresponding source or a compliant source offer for the
  GPL-covered binaries, and obtain the full Chromium third-party notice output
  for the pinned Cronet build before distributing the application bundle.
