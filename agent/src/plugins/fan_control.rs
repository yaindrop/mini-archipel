use crate::plugins::{Context, Failure, Plugin, Task};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::Ordering;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SOCKET: &str = "/var/run/mini-archipel/fan-control.sock";
const MAX_REPLY: u64 = 4 * 1024 * 1024;
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
            socket_path: SOCKET.into(),
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
    let call = async {
        let owner = std::fs::metadata(&options.socket_path)
            .map_err(|_| ())?
            .uid();
        let mut stream = tokio::net::UnixStream::connect(&options.socket_path)
            .await
            .map_err(|_| ())?;
        if stream.peer_cred().map_err(|_| ())?.uid() != owner {
            return Err(());
        }
        let mut request = serde_json::to_vec(&request).map_err(|_| ())?;
        if request.len() > 65535 {
            return Err(());
        }
        request.push(b'\n');
        stream.write_all(&request).await.map_err(|_| ())?;
        let mut response = Vec::new();
        stream
            .take(MAX_REPLY + 1)
            .read_to_end(&mut response)
            .await
            .map_err(|_| ())?;
        if response.len() as u64 > MAX_REPLY {
            return Err(());
        }
        serde_json::from_slice::<Value>(&response).map_err(|_| ())
    };
    tokio::time::timeout(std::time::Duration::from_secs(4), call)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                "fan-control helper timed out".into(),
            )
        })?
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "fan-control helper unavailable".into(),
            )
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
