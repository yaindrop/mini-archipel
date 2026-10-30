use crate::plugins::{Context, Failure, Plugin, Task};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    interval_ms: u64,
    allow_control: bool,
    allow_scripts: bool,
    toolkit: PathBuf,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            interval_ms: 2000,
            allow_control: false,
            allow_scripts: false,
            toolkit: PathBuf::from(std::env::var("HOME").unwrap_or_default())
                .join(".local/libexec/mini-archipel-desktop/desktop-automation"),
        }
    }
}
fn options(value: Value) -> Result<Options, String> {
    let result: Options = serde_json::from_value(value).map_err(|_| "invalid desktop options")?;
    if !result.toolkit.is_absolute() || !(1000..=60000).contains(&result.interval_ms) {
        return Err("desktop toolkit must be absolute; interval must be 1000–60000 ms".into());
    }
    Ok(result)
}
fn valid_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && s.len() <= 100
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}
fn authorize(options: &Options, action: &str, body: &Value) -> Result<(), Failure> {
    if ![
        "status",
        "diagnostics",
        "submit",
        "get",
        "cancel",
        "coordinate",
    ]
    .contains(&action)
    {
        return Err((StatusCode::NOT_FOUND, "unknown desktop operation".into()));
    }
    let object = body
        .as_object()
        .ok_or((StatusCode::BAD_REQUEST, "expected object".into()))?;
    if ["get", "cancel"].contains(&action) && (object.len() != 1 || !valid_id(&body["request_id"]))
    {
        return Err((StatusCode::BAD_REQUEST, "invalid desktop request ID".into()));
    }
    if ["status", "diagnostics"].contains(&action) && !object.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "unexpected fields".into()));
    }
    if action == "coordinate" && (object.len() != 1 || !body["paused"].is_boolean()) {
        return Err((StatusCode::BAD_REQUEST, "paused must be a boolean".into()));
    }
    if action == "submit" && !valid_id(&body["request_id"]) {
        return Err((StatusCode::BAD_REQUEST, "invalid desktop request ID".into()));
    }
    let readonly = ["status", "diagnostics", "get"].contains(&action)
        || (action == "submit" && body["operation"] == "doctor");
    if !readonly && !options.allow_control {
        return Err((
            StatusCode::FORBIDDEN,
            "desktop control is not enabled on this node".into(),
        ));
    }
    if action == "submit" && body["operation"] == "script" && !options.allow_scripts {
        return Err((
            StatusCode::FORBIDDEN,
            "script execution is not enabled on this node".into(),
        ));
    }
    Ok(())
}
async fn rpc(options: &Options, action: &str, body: &Value) -> Result<Value, Failure> {
    let mut command = tokio::process::Command::new(&options.toolkit);
    command
        .arg(action)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if ["get", "cancel"].contains(&action) {
        command.arg(body["request_id"].as_str().unwrap_or_default());
    }
    command.stdin(if ["submit", "coordinate"].contains(&action) {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let operation = async {
        let mut child = command.spawn().map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "desktop toolkit not installed or executable".into(),
            )
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(body.to_string().as_bytes())
                .await
                .map_err(|_| (StatusCode::BAD_GATEWAY, "desktop input unavailable".into()))?;
        }
        let output = child
            .wait_with_output()
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "desktop helper exited".into()))?;
        if output.stdout.len() > 2 * 1024 * 1024 {
            return Err((
                StatusCode::BAD_GATEWAY,
                "desktop response exceeded limit".into(),
            ));
        }
        let value: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| (StatusCode::BAD_GATEWAY, "invalid desktop response".into()))?;
        if value["ok"] != true {
            let status = value["status"]
                .as_u64()
                .and_then(|s| u16::try_from(s).ok())
                .and_then(|s| StatusCode::from_u16(s).ok())
                .filter(|s| s.is_client_error() || s.is_server_error())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            return Err((
                status,
                value["error"]
                    .as_str()
                    .unwrap_or("desktop operation failed")
                    .to_owned(),
            ));
        }
        Ok(value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), operation)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                "desktop response timed out; query the original request ID".into(),
            )
        })?
}
async fn read(options: &Options) -> Value {
    let mut state = json!({"availability":"missing", "control_allowed":options.allow_control,
        "scripts_allowed":options.allow_scripts, "interval_ms":options.interval_ms, "toolkit":null, "error":null});
    if !cfg!(target_os = "macos") {
        state["availability"] = json!("unsupported");
    } else {
        match rpc(options, "status", &json!({})).await {
            Ok(result) => {
                state["availability"] = json!("ready");
                state["toolkit"] = result["data"].clone();
            }
            Err((_, error)) => state["error"] = json!(error),
        }
    }
    state
}
pub struct DesktopAutomation;
impl Plugin for DesktopAutomation {
    fn id(&self) -> &'static str {
        "desktop-automation"
    }
    fn validate(&self, value: &Value) -> Result<(), String> {
        options(value.clone()).map(|_| ())
    }
    fn run(&self, context: Context, value: Value) -> Task<'_, Result<(), String>> {
        Box::pin(async move {
            let options = options(value)?;
            while !context.cancelled.load(Ordering::Relaxed) {
                context.publish(read(&options).await).await;
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
        body: Value,
    ) -> Task<'_, Result<Value, Failure>> {
        Box::pin(async move {
            let options = options(value).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            authorize(&options, &action, &body)?;
            let result = rpc(&options, &action, &body).await?;
            context.publish(read(&options).await).await;
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gates_control_scripts_and_request_identifiers() {
        let mut opts = Options::default();
        assert!(authorize(&opts, "get", &json!({"request_id":"valid-1"})).is_ok());
        assert!(authorize(
            &opts,
            "submit",
            &json!({"request_id":"d1","operation":"doctor"})
        )
        .is_ok());
        assert_eq!(
            authorize(
                &opts,
                "submit",
                &json!({"request_id":"s1","operation":"script"})
            )
            .unwrap_err()
            .0,
            StatusCode::FORBIDDEN
        );
        opts.allow_control = true;
        assert!(authorize(
            &opts,
            "submit",
            &json!({"request_id":"s1","operation":"script"})
        )
        .is_err());
        opts.allow_scripts = true;
        assert!(authorize(
            &opts,
            "submit",
            &json!({"request_id":"s1","operation":"script"})
        )
        .is_ok());
        for id in ["../job", "--help", "", "a/b"] {
            assert!(
                authorize(&opts, "get", &json!({"request_id":id})).is_err(),
                "{id}"
            );
        }
    }
    #[test]
    fn validates_options_and_rejects_unsupported_actions() {
        assert!(options(json!({"toolkit":"relative"})).is_err());
        assert!(options(json!({"unknown":true})).is_err());
        assert!(authorize(&Options::default(), "execute-shell", &json!({})).is_err());
        assert!(authorize(&Options::default(), "status", &json!({"extra":true})).is_err());
    }
}
