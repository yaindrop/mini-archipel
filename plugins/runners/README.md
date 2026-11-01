# Runners 原生插件

本目录维护 GitHub Actions Runner 的节点采集与控制（`agent/`）、工作台（`console/`）、
安装器、忙闲互斥和作业钩子（`scripts/`）。安装实现不依赖其他自有项目目录。
GitHub Runner 官方归档仍是第三方依赖，安装前核对节点 profile 的 SHA-256。

## 安装与使用

在目标节点准备含 `node`、`owner`、`kind`、`repositories`、`sha256` 的节点 profile、
含仓库访问 token 的私有 JSON 文件，以及对应官方 Runner 归档；不要提交凭据。

```sh
python3 plugins/runners/scripts/install-node-runners.py /path/to/profile.json /path/to/tokens.json /path/to/actions-runner.tar.gz
```

安装器从当前进程获取 PATH 和固定环境白名单，不依赖其他项目的 `.path` 或 `.env`；
执行前检测 Worker，忙碌时拒绝修改。工作台启停会复查仓库身份与 Worker；
中断作业仍需现有明确操作，不属于权限检查。

## 权限与复验

Runner 使用当前用户的执行目录和用户级 LaunchAgent，无通用 TCC 授权需求。
工作台首次进入节点会静默检测目录、服务注册、凭据文件是否存在与忙闲策略工具，
显示“无需额外授权”、检查时间与原因；“查看授权说明”不会申请系统授权。
GitHub token 是仓库访问配置，不是系统权限。普通采样及权限检查不会启停服务或中断 Worker。
配置或安装完成后点击“重新检查”复验；`allow_control` 仅是控制开关。

```sh
python3 -m unittest discover -s plugins/runners/tests -v
```

测试使用临时目录和隔离进程，不访问真实节点或 GitHub Runner。
