# Chromium source metadata cross-check

This records upstream README.chromium metadata from the pinned NaiveProxy commit 888e114241c89b05fac4e4ee01482d7bd89ca15a. Source metadata and Shipped fields do not establish which libraries were linked into a particular Cronet binary. All 31 unique license-file paths explicitly referenced by the 37 metadata files were found in this source snapshot.

| Metadata file | Declared licenses | Shipped field | Referenced license files |
|---|---|---|---|
| `src/base/allocator/partition_allocator/src/partition_alloc/third_party/apple_apsl/README.chromium` | APSL-2.0 | yes | [LICENSE](0002/LICENSE) |
| `src/base/third_party/cityhash/README.chromium` | MIT | yes | [COPYING](0003/COPYING) |
| `src/base/third_party/cityhash_v103/README.chromium` | MIT | yes | [COPYING](0004/COPYING) |
| `src/base/third_party/double_conversion/README.chromium` | BSD-3-Clause | yes | [LICENSE](0005/LICENSE) |
| `src/base/third_party/icu/README.chromium` | Unicode-DFS-2016, ICU | no | [LICENSE](0006/LICENSE) |
| `src/base/third_party/nspr/README.chromium` | MPL-2.0 | yes | [LICENSE](0007/LICENSE) |
| `src/base/third_party/superfasthash/README.chromium` | BSD-3-Clause | yes | [LICENSE](0008/LICENSE) |
| `src/base/third_party/symbolize/README.chromium` | BSD-3-Clause | yes | [LICENSE](0009/LICENSE) |
| `src/base/third_party/xdg_user_dirs/README.chromium` | MIT | yes | [LICENSE](0010/LICENSE) |
| `src/build/android/incremental_install/third_party/AndroidHiddenApiBypass/README.chromium` | Apache-2.0 | no | [LICENSE](0011/LICENSE) |
| `src/build/internal/README.chromium` | — | — | — |
| `src/components/cronet/license/tests/target_a/README.chromium` | — | — | — |
| `src/components/cronet/license/tests/target_b/README.chromium` | — | — | — |
| `src/components/cronet/license/tests/target_c/README.chromium` | — | — | — |
| `src/net/third_party/mozilla_security_manager/README.chromium` | MPL-1.1 | yes | [LICENSE](0012/LICENSE) |
| `src/net/third_party/mozilla_win/README.chromium` | MPL-2.0 | yes | [LICENSE](0013/LICENSE) |
| `src/net/third_party/quiche/README.chromium` | BSD-3-Clause | yes | [LICENSE](0014/LICENSE) |
| `src/net/third_party/uri_template/README.chromium` | Apache-2.0 | yes | [LICENSE](0015/LICENSE) |
| `src/third_party/abseil-cpp/README.chromium` | Apache-2.0 | yes | [LICENSE](0016/LICENSE) |
| `src/third_party/apple_apsl/README.chromium` | APSL-2.0 | yes | [LICENSE](0017/LICENSE) |
| `src/third_party/boringssl/README.chromium` | MIT, BSD-3-Clause, OpenSSL, ISC, SSLeay | yes | [LICENSE](0018/LICENSE) |
| `src/third_party/boringssl/src/third_party/fiat/README.chromium` | Apache-2.0 | yes | [LICENSE](0020/LICENSE) |
| `src/third_party/brotli/README.chromium` | MIT | yes | [LICENSE](0021/LICENSE) |
| `src/third_party/cpu_features/README.chromium` | BSD-2-Clause, Apache-2.0 | yes | [LICENSE](0022/LICENSE) |
| `src/third_party/jni_zero/README.chromium` | BSD-3-Clause | yes | [LICENSE](0023/LICENSE) |
| `src/third_party/jni_zero/README.chromium.md` | — | — | — |
| `src/third_party/libc++/README.chromium` | NCSA, Apache-with-LLVM-Exception, MIT | yes | [LICENSE.TXT](0024/LICENSE.TXT) |
| `src/third_party/libc++abi/README.chromium` | NCSA, Apache-with-LLVM-Exception, MIT | yes | [LICENSE.TXT](0025/LICENSE.TXT) |
| `src/third_party/libunwind/README.chromium` | NCSA, Apache-with-LLVM-Exception, MIT | yes | [LICENSE.TXT](0026/LICENSE.TXT) |
| `src/third_party/llvm-libc/README.chromium` | MIT, NCSA | yes | [LICENSE.TXT](0027/LICENSE.TXT) |
| `src/third_party/modp_b64/README.chromium` | BSD-3-Clause | yes | [LICENSE](0028/LICENSE) |
| `src/third_party/nasm/README.chromium` | BSD-2-Clause | no | [LICENSE](0029/LICENSE) |
| `src/third_party/simdutf/README.chromium` | MIT | yes | [LICENSE](0031/LICENSE) |
| `src/third_party/zlib/README.chromium` | Zlib | yes | [LICENSE](0032/LICENSE) |
| `src/third_party/zlib/contrib/minizip/README.chromium` | Zlib | yes | [LICENSE](0032/LICENSE) |
| `src/third_party/zstd/README.chromium` | BSD-3-Clause | yes | [LICENSE](0034/LICENSE) |
| `src/url/third_party/mozilla/README.chromium` | MPL-2.0 | yes | [LICENSE.txt](0035/LICENSE.txt) |
