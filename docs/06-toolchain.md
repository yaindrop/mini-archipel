# 6. 基础工具与固定工具链

分两层：**Homebrew 管常规包**，**固定目录管 CI 要求的精确版本**。全局升级
不改变项目要求，项目要求不污染全局。

## 基础层

```sh
# Apple Command Line Tools（无需完整 Xcode）
xcode-select --install
# Homebrew 装到 /opt/homebrew（Apple Silicon 默认）
brew install docker docker-compose docker-buildx colima gh git-lfs rustup uv libomp
brew analytics off
```

`~/.zprofile` 配置 PATH：Homebrew、固定 CI 工具、Cargo。Lima 随 Colima
依赖安装。

## 固定层（示例布局 `~/.local/ci-pinned/bin`）

由目标项目决定版本——**先读目标提交的版本声明**（`.node-version`、
`.python-version`、`package.json`、`rust-toolchain.toml`、锁文件与项目自
带的工具链核对脚本），再安装对应版本。一次实机对齐后的快照示例：

| 工具                                             | 版本                   |
| ------------------------------------------------ | ---------------------- |
| Node / pnpm / Corepack                           | 26.x / 12.x / 0.36     |
| Python（uv 管理） / uv / Ruff                    | 3.14 / 0.13 / 0.17     |
| Rust stable（含 clippy、rustfmt、wasm32 target） | 1.98                   |
| Rust nightly（另装 rustfmt）                     | 按项目固定日期         |
| wasm-pack / CMake / clang-format                 | 0.15 / 4.4 / 23.1      |
| cargo-about / nextest / llvm-cov / fuzz          | 0.9 / 0.9 / 0.8 / 0.13 |

- Node 用官方 ARM64 包并校验 SHA-256；Python 全部交给 uv。
- runner 的 `.path` **显式保存这份顺序**，不依赖交互 shell 配置。
- libomp 供依赖 OpenMP 的原生库使用。

验收：以目标提交为准运行其工具链核对脚本（如 `scripts/ci-toolchain.sh`）
返回 0；`pnpm install --frozen-lockfile` 成功。

## 可选层（按需）

- AI 编码 CLI/桌面端、项目专用浏览器等按需安装；**登录凭据不跨机复制**，
  新机自行完成认证。
- Playwright/Chromium 归项目安装（`~/Library/Caches/ms-playwright`），与
  Homebrew 浏览器无关。
- 涉及系统权限（辅助功能/屏幕录制/自动化）的远控类工具，完成一次端到端
  验收后再计入基线。
