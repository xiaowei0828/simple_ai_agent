# Bundled ripgrep

预置官方 ripgrep **15.2.0**，供 `run_command` 直接使用。

| 目录 | 平台 | 文件 |
| --- | --- | --- |
| `darwin-x64` | macOS Intel | `rg` |
| `darwin-arm64` | macOS Apple Silicon | `rg` |
| `win32-x64` | Windows x64 | `rg.exe` |
| `win32-arm64` | Windows ARM64 | `rg.exe` |

来源：[ripgrep 15.2.0 官方发布](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0)。
`manifest.json` 记录每个平台的原始下载地址、官方压缩包 SHA-256 和解压后二进制 SHA-256。
四个压缩包均已对照官方发布的 SHA-256 校验。

此目录随源码和 npm 包分发。运行时按 Node.js 的 `process.platform` / `process.arch` 选择子目录，并将其加入命令子进程的 `PATH`。
升级时从官方 Release 重新下载这四个平台的压缩包，校验并替换二进制、许可证和 manifest，同时更新版本说明与搜索集成测试；macOS 的 `rg` 需要保留可执行权限。

原始发行包中的许可证保留为 `COPYING`、`LICENSE-MIT` 和 `UNLICENSE`。
