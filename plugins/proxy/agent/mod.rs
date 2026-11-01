use crate::plugins::{Context, Failure, Plugin, Task};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    interval_ms: u64,
    allow_control: bool,
    select_cmd: String,
    nodes_path: String,
    config_path: String,
    proxy_url: String,
    probe_url: String,
    probe_timeout_s: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            interval_ms: 30_000,
            allow_control: false,
            select_cmd: dirs_home()
                .join(".local/bin/mini-proxy-select")
                .to_string_lossy()
                .into(),
            nodes_path: dirs_home()
                .join(".local/mini-proxy/nodes.json")
                .to_string_lossy()
                .into(),
            config_path: dirs_home()
                .join(".config/mini-proxy/config.json")
                .to_string_lossy()
                .into(),
            proxy_url: "http://127.0.0.1:10808".into(),
            probe_url: "https://www.google.com/generate_204".into(),
            probe_timeout_s: 12,
        }
    }
}

fn options(value: Value) -> Result<Options, String> {
    let options: Options =
        serde_json::from_value(value).map_err(|_| "invalid mini-proxy options")?;
    if !(5_000..=300_000).contains(&options.interval_ms)
        || !(1..=60).contains(&options.probe_timeout_s)
        || !options.select_cmd.starts_with('/')
        || !options.nodes_path.starts_with('/')
        || !options.config_path.starts_with('/')
        || options.proxy_url.len() > 200
        || !options.probe_url.starts_with("https://")
    {
        return Err("invalid mini-proxy interval, timeout or path options".into());
    }
    Ok(options)
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/Users/unknown"))
}

/// Node names come from the local nodes.json and reach the select CLI as a
/// single argv entry; the pattern keeps them strictly lowercase slugs.
fn valid_node_name(node: &str) -> bool {
    let mut chars = node.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    node.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The proxy never exposes credentials: only the object keys of nodes.json.
fn node_names(document: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(document).ok()?;
    value
        .as_object()?
        .keys()
        .filter(|name| valid_node_name(name))
        .cloned()
        .collect::<Vec<_>>()
        .into()
}

/// The active exit node is recorded as the outbound user email by the select CLI.
fn current_node(document: &str) -> Option<String> {
    let value: Value = serde_json::from_str(document).ok()?;
    let outbound = value["outbounds"]
        .as_array()?
        .iter()
        .find(|outbound| outbound["tag"] == "proxy")?;
    let name = outbound["settings"]["vnext"][0]["users"][0]["email"]
        .as_str()?
        .to_owned();
    valid_node_name(&name).then_some(name)
}

/// The select CLI prints `latency_ms 144` for the generate_204 request itself.
fn reported_latency(stdout: &str) -> Option<u64> {
    stdout.lines().rev().find_map(|line| {
        line.trim()
            .strip_prefix("latency_ms ")
            .and_then(|ms| ms.parse().ok())
    })
}

/// curl -w "%{http_code} %{time_total}" on success prints e.g. `204 0.144`.
fn parse_probe_output(text: &str) -> Option<(u16, u64)> {
    let mut parts = text.split_whitespace();
    let code: u16 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some((code, (seconds * 1000.0) as u64))
}

fn truncate(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.len() <= limit {
        text.to_owned()
    } else {
        text[text.len() - limit..].trim_start().to_owned()
    }
}

struct Probe {
    status_code: Option<u16>,
    latency_ms: Option<u64>,
    error: Option<String>,
    /// false only when the local proxy port refused the connection, i.e. the
    /// service is down rather than the exit node being unhealthy.
    reachable: bool,
}

async fn probe(options: &Options) -> Probe {
    let timeout = std::time::Duration::from_secs(options.probe_timeout_s);
    let attempt = tokio::time::timeout(
        timeout,
        tokio::process::Command::new("/usr/bin/curl")
            .arg("-sS")
            .arg("-o")
            .arg("/dev/null")
            .arg("-w")
            .arg("%{http_code} %{time_total}")
            .arg("--max-time")
            .arg(options.probe_timeout_s.to_string())
            .arg("--proxy")
            .arg(&options.proxy_url)
            .arg(&options.probe_url)
            .output(),
    )
    .await;
    let output = match attempt {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Probe {
                status_code: None,
                latency_ms: None,
                error: Some(truncate(&error.to_string(), 200)),
                reachable: false,
            }
        }
        Err(_) => {
            // The local port accepted the connection; the exit request did not
            // finish. That is a degraded exit, not a stopped service.
            return Probe {
                status_code: None,
                latency_ms: None,
                error: Some("probe timed out".into()),
                reachable: true,
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        if let Some((code, latency_ms)) = parse_probe_output(&stdout) {
            return Probe {
                status_code: Some(code),
                latency_ms: Some(latency_ms),
                error: None,
                reachable: true,
            };
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Probe {
        status_code: None,
        latency_ms: None,
        error: Some(if stderr.is_empty() {
            format!("curl exit {:?}", output.status.code())
        } else {
            truncate(&stderr, 200)
        }),
        reachable: output.status.code() != Some(7),
    }
}

async fn read_nodes(options: &Options) -> Option<Vec<String>> {
    let document = tokio::fs::read_to_string(&options.nodes_path).await.ok()?;
    node_names(&document)
}

#[derive(Clone, serde::Serialize)]
struct HealthEntry {
    ok: bool,
    check_ms: u64,
    ts: u64,
    detail: String,
}

/// Last check result per node, shared between the poll loop and actions.
type Health = Arc<Mutex<BTreeMap<String, HealthEntry>>>;

async fn run_command(
    program: &str,
    args: &[&str],
    timeout_s: u64,
) -> Result<(Option<i32>, String, String, u64), Failure> {
    let started = std::time::Instant::now();
    let attempt = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_s),
        tokio::process::Command::new(program).args(args).output(),
    )
    .await;
    let output = attempt.map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            "mini-proxy-select timed out".into(),
        )
    })?;
    let output = output.map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "mini-proxy-select is not executable".into(),
        )
    })?;
    Ok((
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        started.elapsed().as_millis() as u64,
    ))
}

/// Collect the publishable state; callers own the publish so actions can
/// refresh the envelope before returning.
async fn snapshot(context: &Context, options: &Options, health: &Health) -> Value {
    let nodes = read_nodes(options).await;
    let current = tokio::fs::read_to_string(&options.config_path)
        .await
        .ok()
        .and_then(|document| current_node(&document));
    let probe = probe(options).await;
    let availability = match (&nodes, probe.status_code, probe.reachable) {
        (None, _, _) => "not_installed",
        (Some(_), Some(code), _) if (200..300).contains(&code) => "ready",
        (Some(_), _, false) => "service_down",
        _ => "degraded",
    };
    let health_snapshot = health.lock().await.clone();
    json!({
        "permissions": permissions(context).await,
        "availability": availability,
        "current_node": current,
        "nodes": nodes.unwrap_or_default(),
        "probe": {
            "status_code": probe.status_code,
            "latency_ms": probe.latency_ms,
            "error": probe.error,
            "ts": crate::plugins::now(),
        },
        "health": health_snapshot,
        "control_allowed": options.allow_control,
        "interval_ms": options.interval_ms,
    })
}

fn body_node(body: &Value) -> Result<String, Failure> {
    let object = body
        .as_object()
        .ok_or((StatusCode::BAD_REQUEST, "invalid mini-proxy request".into()))?;
    if object.len() != 1 || !object.contains_key("node") {
        return Err((StatusCode::BAD_REQUEST, "invalid mini-proxy request".into()));
    }
    let node = object["node"]
        .as_str()
        .ok_or((StatusCode::BAD_REQUEST, "invalid mini-proxy request".into()))?;
    if !valid_node_name(node) {
        return Err((
            StatusCode::BAD_REQUEST,
            "invalid mini-proxy node name".into(),
        ));
    }
    Ok(node.to_owned())
}

#[derive(Default)]
pub struct MiniProxy {
    health: Health,
}

impl Plugin for MiniProxy {
    fn id(&self) -> &'static str {
        "proxy"
    }
    fn disk_expansions(&self) -> Vec<PathBuf> {
        vec![dirs_home().join(".local/mini-proxy")]
    }
    fn validate(&self, value: &Value) -> Result<(), String> {
        options(value.clone()).map(|_| ())
    }
    fn run(&self, context: Context, value: Value) -> Task<'_, Result<(), String>> {
        let health = Arc::clone(&self.health);
        Box::pin(async move {
            let options = options(value)?;
            while !context.cancelled.load(Ordering::Relaxed) {
                let data = snapshot(&context, &options, &health).await;
                context.publish(data).await;
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
        let health = Arc::clone(&self.health);
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
            let node = body_node(&body)?;
            let known = read_nodes(&options)
                .await
                .ok_or((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "mini-proxy is not installed on this node".into(),
                ))?
                .into_iter()
                .any(|name| name == node);
            if !known {
                return Err((StatusCode::NOT_FOUND, "unknown mini-proxy node".into()));
            }
            let arguments: Vec<&str> = match action.as_str() {
                "switch" => {
                    if !options.allow_control {
                        return Err((
                            StatusCode::FORBIDDEN,
                            "mini-proxy control is disabled".into(),
                        ));
                    }
                    vec![node.as_str()]
                }
                "check" => vec!["--check", node.as_str()],
                _ => return Err((StatusCode::NOT_FOUND, "unknown mini-proxy action".into())),
            };
            let (code, stdout, stderr, elapsed) =
                run_command(&options.select_cmd, &arguments, 600).await?;
            let output = truncate(
                if stderr.trim().is_empty() {
                    &stdout
                } else {
                    &stderr
                },
                400,
            );
            let ok = code == Some(0);
            let check_ms = reported_latency(&stdout).unwrap_or(elapsed);
            health.lock().await.insert(
                node.clone(),
                HealthEntry {
                    ok,
                    check_ms,
                    ts: crate::plugins::now(),
                    detail: output.clone(),
                },
            );
            let state = snapshot(&context, &options, &health).await;
            context.publish(state.clone()).await;
            let mut result =
                json!({"ok": ok, "output": output, "check_ms": check_ms, "state": state});
            if !ok {
                result["error"] = json!(format!("mini-proxy-select exited with {code:?}"));
            }
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_names_reject_documents_that_are_not_node_maps() {
        assert_eq!(
            node_names(r#"{"akile-de":{},"akile-sg":{}}"#),
            Some(vec!["akile-de".into(), "akile-sg".into()])
        );
        assert_eq!(node_names("[]"), None);
        assert_eq!(node_names("not json"), None);
        assert_eq!(
            node_names(r#"{"Bad Name":{},"ok-node":{}}"#),
            Some(vec!["ok-node".into()])
        );
    }

    #[test]
    fn current_node_reads_the_proxy_outbound_email() {
        let document = r#"{"outbounds":[
            {"tag":"proxy","settings":{"vnext":[{"users":[{"email":"akile-sg"}]},{"users":[{"email":"ignored"}]}]}},
            {"tag":"direct","protocol":"freedom"}
        ]}"#;
        assert_eq!(current_node(document), Some("akile-sg".into()));
        assert_eq!(current_node(r#"{"outbounds":[]}"#), None);
        assert_eq!(current_node("{}"), None);
    }

    #[test]
    fn reported_latency_reads_the_generate_204_sample() {
        assert_eq!(
            reported_latency("akile-de: delay ok\nlatency_ms 144\n"),
            Some(144)
        );
        assert_eq!(reported_latency("latency_ms 0"), Some(0));
        assert_eq!(reported_latency("no sample"), None);
    }

    #[test]
    fn probe_output_parses_code_and_milliseconds() {
        assert_eq!(parse_probe_output("200 0.648\n"), Some((200, 648)));
        assert_eq!(parse_probe_output("403 1"), Some((403, 1000)));
        assert_eq!(parse_probe_output(""), None);
        assert_eq!(parse_probe_output("200"), None);
    }

    #[test]
    fn node_names_follow_the_slug_pattern() {
        assert!(valid_node_name("akile-de"));
        assert!(valid_node_name("a"));
        assert!(!valid_node_name("-akile"));
        assert!(!valid_node_name("Akile"));
        assert!(!valid_node_name("akile_de"));
        assert!(!valid_node_name(&"x".repeat(33)));
    }

    #[test]
    fn options_validate_intervals_and_absolute_paths() {
        assert!(options(json!({})).is_ok());
        assert!(options(json!({"interval_ms": 1000})).is_err());
        assert!(options(json!({"interval_ms": 300_001})).is_err());
        assert!(options(json!({"select_cmd": "mini-proxy-select"})).is_err());
        assert!(options(json!({"nodes_path": "~/mini-proxy"})).is_err());
        assert!(options(json!({"probe_url": "http://insecure"})).is_err());
        assert!(options(json!({"probe_timeout_s": 0})).is_err());
        assert!(options(json!({"unknown": true})).is_err());
    }

    #[test]
    fn action_bodies_carry_exactly_one_valid_node() {
        assert_eq!(body_node(&json!({"node": "akile-sg"})).unwrap(), "akile-sg");
        assert!(body_node(&json!({"node": "akile-sg", "extra": 1})).is_err());
        assert!(body_node(&json!({})).is_err());
        assert!(body_node(&json!({"node": "../etc"})).is_err());
        assert!(body_node(&json!({"node": 7})).is_err());
        assert!(body_node(&json!("akile-sg")).is_err());
    }

    #[test]
    fn truncate_keeps_the_informative_tail() {
        assert_eq!(truncate("  ok  \n", 10), "ok");
        assert_eq!(truncate(&"x".repeat(50), 20).len(), 20);
    }
}

fn unchecked_permissions() -> Value {
    json!({"user-service":{"status":"unchecked","checked_at":null,"requested_at":null,"message":"尚未检查节点能力"}})
}
async fn permissions(context: &Context) -> Value {
    context
        .state
        .read()
        .await
        .plugins
        .get("proxy")
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
        || body["permission"] != "user-service"
    {
        return Err((StatusCode::BAD_REQUEST, "invalid permission request".into()));
    }
    let installed = tokio::fs::metadata(&options.select_cmd).await.is_ok()
        && tokio::fs::read_to_string(&options.nodes_path)
            .await
            .ok()
            .and_then(|text| node_names(&text))
            .is_some();
    let service = tokio::process::Command::new("/bin/launchctl")
        .args([
            "print",
            &format!("gui/{}/com.mini.proxy", unsafe { libc::getuid() }),
        ])
        .output()
        .await
        .is_ok_and(|output| output.status.success());
    let status = "not-required";
    let message = format!("无需额外授权；仅使用用户级 LaunchAgent，不请求 TCC、TUN 或系统代理权限。安装文件：{}；用户服务：{}。缺失时在目标节点运行 python3 plugins/proxy/install.py；凭据与控制开关不是系统权限。", if installed {"已检测"} else {"未就绪"}, if service {"已加载"} else {"未加载"});
    let result = json!({"user-service":{"status":status,"checked_at":crate::plugins::now(),"requested_at":if request {Some(crate::plugins::now())} else {None},"message":message,"entrypoint":"plugins/proxy/README.md"}});
    if let Some(entry) = context.state.write().await.plugins.get_mut("proxy") {
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
            id: "proxy".into(),
            state: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::collectors::SharedState::default(),
            )),
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        assert_eq!(
            unchecked_permissions()["user-service"]["status"],
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
