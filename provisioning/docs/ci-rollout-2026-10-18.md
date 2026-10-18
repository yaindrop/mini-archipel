# 主动 CI 接入记录 · 2026-10-18

共享实现提交：`2e62bc368836088440e389f75880a0c200fdba36`（分支 `ci/shared-quality`）。
其他三个仓库的入口固定到这一提交。规范见[主动 CI 规范](ci-practice.md)。

## 部署

没有更换节点上的 `ci-lease.py`、`ci-housekeeping.py`、`job-started.sh`、`job-completed.sh`。
租约、维护和本地中断仍走原来的钩子。新流程在作业步骤里运行，Runner 拉到对应提交后即可执行，不需要先给节点装一份脚本。

群岛要显示阶段、环境验收和最近结论，需要发布带这次 Runner 报告读取的 Agent 与 Console。旧 Agent 不读报告文件；旧 Console 会忽略多出来的 `run` 字段。GitHub online/busy 与本地进程状态的来源没有改。

## 升级

只改调用方的 40 位提交。mini-archipel 用仓库内相对路径，先在它自己的 PR 上验收共享流程，再把通过的提交写进另外三个入口。不要改成分支名。

## 回退

把该仓库的 `pr-quality.yml` 恢复到接入前的版本。节点钩子和 Runner 注册不动。已经写在 `~/.local/state/mini-ci/reports/` 的最近报告可以留着，旧 Console 不显示它。

## 本地符合性

在 `~/mini-archipel-dev` 执行：

- `python3 -m unittest discover -s provisioning/scripts/tests -q`：31 项通过。其中生命周期测试覆盖未请求不执行、环境不符不进入检查、项目失败不算通过、提交不符、租约缺失、本机信号中断、后续阶段不再开始、凭据值不进报告。
- `uvx ruff@0.17.0 check --select E,F,I` 与 `format --check` 通过，范围含 `provisioning/scripts` 与 `.github/actions/quality`。
- `actionlint` 检查 `pr-quality.yml` 与 `reusable-quality.yml` 通过。
- Agent 单测 `recovers_an_unfinished_run_after_the_worker_is_gone` 通过：Worker 消失后未完成报告显示为中断，已通过的报告保持通过。
- Console Runner 单测 20 项通过。Chromium 浏览器测试 `preferences.spec.ts` 3 项通过，英文界面能看到 `summary · abcdef123456`、`Matches`、`Passed` 和 `No explicit run yet`，且这一页没有中文。

三个调用方的 `ci/requirements.json` 通过同一份 schema 校验；`ci/callers/*.yml` 的审计确认它们把共享流程固定到上面的提交，且该提交里存在 reusable workflow。

## 尚未在机群上完成的一轮

四个仓库还没有各做一次真实的 `run-ci`，四台节点也还没有分别接过这次新流程的作业。原因：共享提交当时只在本地，标签会启动各仓库现有的完整质量命令并占用节点租约。把 `ci/shared-quality` 推到各仓库并打开 PR 之后，再给 PR 加上 `run-ci` 才是这一轮的证据。环境失败、项目失败和通过要分开记，不能把环境失败或项目失败写成质量通过。
