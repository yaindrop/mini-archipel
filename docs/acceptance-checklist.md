# 新机验收清单

- [ ] 主机名、短用户名、SSH 别名、runner 名称全局唯一。
- [ ] 公钥 SSH 实际登录；屏幕共享实际显示并能操作。
- [ ] 接电启动、防睡眠、网络唤醒设置生效（`pmset -g custom` 核对）。
- [ ] 重启后核实 FileVault、Wi-Fi、桌面会话与远程恢复全流程。
- [ ] GUI 代理与独立 CI 代理双端口分离；经 CI 代理访问 GitHub 成功。
- [ ] 固定工具 PATH 正确；目标提交的工具链核对脚本返回 0。
- [ ] `pnpm install --frozen-lockfile` 成功；项目所需 SDK 冻结依赖可安装。
- [ ] 原生 Rust、WASM、Playwright Chromium 等项目依赖可运行。
- [ ] runner 只注册一次，名称与标签正确，GitHub 显示 online，实际接到一次验收作业。
- [ ] 作业完成钩子执行成功，日志无 warning，源码未被清理脚本改动。
- [ ] 风扇控制四档实写验证通过；守护进程运行；负载升档/回落行为符合预期。
- [ ] Colima 可启动并运行 ARM64 容器，验收后停止。
- [ ] 壁纸、屏保、Spotlight、小组件、Siri 符合本机用途。
- [ ] 空闲时无遗留 Worker、浏览器、开发服务器或无关 GUI 程序。
- [ ] 记录本机的 APFS 用量、空闲 CPU、footprint、压缩与 swap 基线。
