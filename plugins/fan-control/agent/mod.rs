use crate::plugins::{Context, Failure, Plugin, Task};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    interval_ms: u64,
    allow_control: bool,
    socket_path: String,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            interval_ms: 2000,
            allow_control: false,
            socket_path: crate::fan_control::SOCKET.into(),
        }
    }
}
fn options(value: Value) -> Result<Options, String> {
    let options: Options =
        serde_json::from_value(value).map_err(|_| "invalid fan-control options")?;
    if !(1000..=10000).contains(&options.interval_ms)
        || !options.socket_path.starts_with('/')
        || options.socket_path.len() > 100
    {
        return Err("invalid fan-control polling interval or socket path".into());
    }
    Ok(options)
}
async fn rpc(options: &Options, request: Value) -> Result<Value, Failure> {
    crate::fan_control::rpc(&options.socket_path, request)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    "fan-control helper timed out".into(),
                )
            } else {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "fan-control helper unavailable".into(),
                )
            }
        })
}
async fn read(context: &Context, options: &Options) -> Value {
    let (virtual_machine, reading) = {
        let core = context.state.read().await;
        (
            core.host
                .as_ref()
                .is_some_and(|h| h.model.starts_with("VirtualMac")),
            core.fan.clone(),
        )
    };
    let mut data = if virtual_machine {
        json!({"availability":"unsupported","reason":"virtual_machine","reading":null})
    } else {
        match rpc(options, json!({"op":"read"})).await {
            Ok(reply) if reply["ok"] == true && reply["data"].is_object() => reply["data"].clone(),
            _ => {
                json!({"availability":"helper_missing","reason":"installation_required","reading":reading})
            }
        }
    };
    data["permissions"] = permissions(context).await;
    data["control_allowed"] = json!(options.allow_control);
    data["interval_ms"] = json!(options.interval_ms);
    data
}
pub struct FanControl;
impl Plugin for FanControl {
    fn id(&self) -> &'static str {
        "fan-control"
    }
    fn validate(&self, value: &Value) -> Result<(), String> {
        options(value.clone()).map(|_| ())
    }
    fn run(&self, context: Context, value: Value) -> Task<'_, Result<(), String>> {
        Box::pin(async move {
            let options = options(value)?;
            while !context.cancelled.load(Ordering::Relaxed) {
                context.publish(read(&context, &options).await).await;
                tokio::time::sleep(std::time::Duration::from_millis(options.interval_ms)).await;
            }
            Ok(())
        })
    }
    fn action(
        &self,
        context: Context,
        value: Value,
        action: String,
        mut body: Value,
    ) -> Task<'_, Result<Value, Failure>> {
        Box::pin(async move {
            let options = options(value).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            if matches!(action.as_str(), "permission-check" | "permission-request") {
                return permission_action(
                    &context,
                    &body,
                    action == "permission-request",
                    &options,
                )
                .await;
            }
            if !options.allow_control {
                return Err((StatusCode::FORBIDDEN, "fan control is read-only".into()));
            }
            if !["command", "cancel"].contains(&action.as_str()) {
                return Err((StatusCode::NOT_FOUND, "unknown fan-control action".into()));
            }
            let map = body.as_object_mut().ok_or((
                StatusCode::BAD_REQUEST,
                "invalid fan-control request".into(),
            ))?;
            if map.contains_key("op") {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "invalid fan-control request".into(),
                ));
            }
            map.insert("op".into(), json!(action));
            let reply = rpc(&options, body).await?;
            context.publish(read(&context, &options).await).await;
            Ok(reply)
        })
    }
}

fn unchecked_permissions() -> Value {
    json!({"privileged-service":{"status":"unchecked","checked_at":null,"requested_at":null,"message":"尚未检查节点能力"}})
}
async fn permissions(context: &Context) -> Value {
    context
        .state
        .read()
        .await
        .plugins
        .get("fan-control")
        .map(|entry| entry.data["permissions"].clone())
        .filter(Value::is_object)
        .unwrap_or_else(unchecked_permissions)
}
async fn permission_action(
    context: &Context,
    body: &Value,
    request: bool,
    options: &Options,
) -> Result<Value, Failure> {
    if body.as_object().is_none_or(|object| object.len() != 1)
        || body["permission"] != "privileged-service"
    {
        return Err((StatusCode::BAD_REQUEST, "invalid permission request".into()));
    }
    let services = [
        "local.miniarchipel.fan-control",
        "local.miniarchipel.fanctl",
    ];
    let virtual_machine = context
        .state
        .read()
        .await
        .host
        .as_ref()
        .is_some_and(|host| host.model.starts_with("VirtualMac"));
    let mut healthy = true;
    if !virtual_machine {
        for service in services {
            healthy &= tokio::process::Command::new("/bin/launchctl")
                .args(["print", &format!("system/{service}")])
                .output()
                .await
                .is_ok_and(|output| output.status.success());
        }
        let reply = rpc(options, json!({"op":"read"})).await;
        healthy &= reply
            .as_ref()
            .is_ok_and(|reply| reply["ok"] == true && reply["data"]["availability"] == "ready");
    }
    let mut status = if virtual_machine {
        "not-required"
    } else if healthy {
        "verified"
    } else {
        "required"
    };
    let mut message = if virtual_machine {
        "虚拟机无硬件风扇，无需额外授权；不安装特权服务。"
    } else if healthy {
        "双 LaunchDaemon 与本机 socket/RPC 已验证；无需 TCC 授权。"
    } else {
        "特权服务未就绪。请在目标节点的插件目录先运行 ./build.sh，再由管理员运行 sudo ./install-plugin.sh。安装后重新检查；此操作不会后台执行 sudo。"
    };
    let installer = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
        .join(".local/share/mini-archipel/plugins/fan-control/install.command");
    if request && !virtual_machine {
        if installer.is_absolute() && installer.is_file() {
            match tokio::process::Command::new("/usr/bin/open")
                .arg(&installer)
                .output()
                .await
            {
                Ok(output) if output.status.success() => {
                    status = "waiting";
                    message = "已打开目标节点的安装程序。普通用户构建完成后，macOS 将请求管理员确认；完成后请重新检查能力。";
                }
                _ => {
                    status = "error";
                    message =
                        "无法打开目标节点的安装程序，请检查图形登录会话；没有执行安装或后台 sudo。";
                }
            }
        } else {
            status = "required";
            message = "此节点缺少随插件分发的图形安装入口，请重新安装或升级节点 Agent；没有执行安装或后台 sudo。";
        }
    }
    let result = json!({"privileged-service":{"status":status,"checked_at":crate::plugins::now(),"requested_at":if request {Some(crate::plugins::now())} else {None},"message":message,"entrypoint":if virtual_machine {None} else {installer.to_str()}}});
    if let Some(entry) = context.state.write().await.plugins.get_mut("fan-control") {
        entry.data["permissions"] = result.clone();
    }
    Ok(json!({"ok":true,"permissions":result}))
}

#[cfg(test)]
mod permission_tests {
    use super::*;
    #[tokio::test]
    async fn rejects_unknown_permission_without_running_commands() {
        let context = Context {
            id: "fan-control".into(),
            state: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::collectors::SharedState::default(),
            )),
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        assert_eq!(
            unchecked_permissions()["privileged-service"]["status"],
            "unchecked"
        );
        let error = permission_action(
            &context,
            &json!({"permission":"other"}),
            true,
            &Options::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(context.state.read().await.plugins.is_empty());
    }
}
