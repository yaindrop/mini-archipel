use crate::plugins::{Context, Failure, Plugin, Task};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    interval_ms: u64,
    allow_control: bool,
    cli: PathBuf,
    package: PathBuf,
    output_directory: PathBuf,
}
fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}
impl Default for Options {
    fn default() -> Self {
        Self {
            interval_ms: 3000,
            allow_control: false,
            cli: home().join(".local/bin/agent-screen-recorder"),
            package: home().join(".local/libexec/mini-archipel-screen-recorder"),
            output_directory: home().join("Movies/Mini Archipel"),
        }
    }
}
fn options(value: Value) -> Result<Options, String> {
    let o: Options =
        serde_json::from_value(value).map_err(|_| "invalid screen-recorder options")?;
    if !(1000..=60000).contains(&o.interval_ms)
        || [&o.cli, &o.package, &o.output_directory]
            .iter()
            .any(|p| !p.is_absolute() || p.as_os_str().len() > 4096)
    {
        return Err(
            "screen-recorder paths must be absolute; interval must be 1000–60000 ms".into(),
        );
    }
    Ok(o)
}
fn bad(message: &str) -> Failure {
    (StatusCode::BAD_REQUEST, message.into())
}
fn empty(body: &Value) -> Result<(), Failure> {
    if body.as_object().is_none_or(|m| !m.is_empty()) {
        return Err(bad("unexpected recorder fields"));
    }
    Ok(())
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    request_id: String,
    window: Option<u32>,
    display: Option<u32>,
    duration: f64,
    #[serde(default)]
    tail: f64,
    pointer_source: Option<String>,
}
fn start_args(o: &Options, body: Value) -> Result<(String, Vec<String>), Failure> {
    let r: Start =
        serde_json::from_value(body).map_err(|_| bad("invalid recorder start request"))?;
    if !valid_id(&r.request_id)
        || r.window.is_some_and(|n| n == 0)
        || r.display.is_some_and(|n| n == 0)
        || (r.window.is_some() && r.display.is_some())
        || !r.duration.is_finite()
        || !(0.1..=86400.).contains(&r.duration)
        || !r.tail.is_finite()
        || !(0.0..=30.).contains(&r.tail)
        || r.pointer_source.as_ref().is_some_and(|s| s != "native")
    {
        return Err(bad("invalid recorder target, duration or pointer source"));
    }
    let output = o
        .output_directory
        .join(format!("{}.mp4", r.request_id))
        .to_string_lossy()
        .into_owned();
    let mut args = vec![
        "start".into(),
        "--output".into(),
        output.clone(),
        "--duration".into(),
        r.duration.to_string(),
        "--tail".into(),
        r.tail.to_string(),
        "--fps".into(),
        "60".into(),
        "--timeout".into(),
        "20".into(),
    ];
    if let Some(id) = r.window {
        args.extend(["--window".into(), id.to_string()]);
    }
    if let Some(id) = r.display {
        args.extend(["--display".into(), id.to_string()]);
    }
    if let Some(source) = r.pointer_source {
        args.extend([
            "--pointer-source".into(),
            source,
            "--pointer-output".into(),
            o.output_directory
                .join(format!("{}.pointer.json", r.request_id))
                .to_string_lossy()
                .into_owned(),
        ]);
    }
    Ok((output, args))
}
fn claim_start(o: &Options, args: &[String], output: &str) -> Result<(), Failure> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&o.output_directory)
        .map_err(|_| bad("cannot prepare recording directory"))?;
    let receipt = Path::new(output).with_extension("request.json");
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&receipt)
    {
        Ok(file) => serde_json::to_writer(file, args)
            .map_err(|_| bad("cannot preserve recorder request parameters")),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let previous: Vec<String> = serde_json::from_reader(
                std::fs::File::open(receipt)
                    .map_err(|_| bad("recorder request receipt unavailable"))?,
            )
            .map_err(|_| bad("recorder request receipt invalid"))?;
            if previous != args {
                return Err((
                    StatusCode::CONFLICT,
                    "recording request ID already has different parameters".into(),
                ));
            }
            Ok(())
        }
        Err(_) => Err(bad("cannot reserve recorder request parameters")),
    }
}
async fn submit_stop(o: &Options) -> Result<Value, Failure> {
    let mut child = tokio::process::Command::new(&o.cli)
        .args(["stop", "--timeout", "120"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "recorder stop command unavailable".into(),
            )
        })?;
    // Reap the CLI without tying an accepted native finalization to HTTP or plugin lifetime.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(
        json!({"schemaVersion":1,"ok":true,"code":"stop_requested","message":"Stop request submitted; poll status for actual finalization. No completed file is claimed.","state":"pending"}),
    )
}
async fn command(program: &Path, args: &[String]) -> Result<std::process::Output, Failure> {
    tokio::time::timeout(
        std::time::Duration::from_secs(31),
        tokio::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            "recorder response timed out; inspect status before retrying".into(),
        )
    })?
    .map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "recorder executable unavailable".into(),
        )
    })
}
async fn rpc(o: &Options, args: Vec<String>) -> Result<Value, Failure> {
    let output = command(&o.cli, &args).await?;
    if output.stdout.len() > 4 * 1024 * 1024 {
        return Err((
            StatusCode::BAD_GATEWAY,
            "recorder response exceeded limit".into(),
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "recorder returned invalid JSON".into(),
        )
    })?;
    if value["schemaVersion"] != 1
        || !value["ok"].is_boolean()
        || !value["code"].is_string()
        || !value["message"].is_string()
    {
        return Err((StatusCode::BAD_GATEWAY, "invalid recorder protocol".into()));
    }
    Ok(value)
}
fn backups() -> Vec<String> {
    let root = home().join("Library/Application Support/Agent Screen Recorder/backups");
    let mut entries: Vec<_> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("installer-backup-v1").is_file())
        .map(|e| {
            (
                e.metadata().and_then(|m| m.modified()).ok(),
                e.path().to_string_lossy().into_owned(),
            )
        })
        .collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    entries.into_iter().take(50).map(|(_, p)| p).collect()
}
async fn read(o: &Options) -> Value {
    let mut data = json!({"availability":"not_installed","control_allowed":o.allow_control,"interval_ms":o.interval_ms,"output_directory":o.output_directory,"package_available":o.package.join("scripts/install.sh").is_file(),"backups":backups(),"recorder":null,"error":null});
    if !cfg!(target_os = "macos") {
        data["availability"] = json!("unsupported");
        return data;
    }
    if o.cli.is_file() {
        match rpc(o, vec!["status".into(), "--timeout".into(), "3".into()]).await {
            Ok(reply) => {
                data["availability"] = json!("ready");
                data["recorder"] = reply;
            }
            Err((_, error)) => {
                data["availability"] = json!("error");
                data["error"] = json!(error);
            }
        }
    }
    data
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    recording_id: String,
    kind: String,
    #[serde(default)]
    offset: u64,
}
async fn artifact(o: &Options, body: Value) -> Result<Value, Failure> {
    use std::fmt::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let r: Artifact =
        serde_json::from_value(body).map_err(|_| bad("invalid recording artifact request"))?;
    if !valid_id(&r.recording_id) || !["video", "pointer", "snapshot"].contains(&r.kind.as_str()) {
        return Err(bad("invalid recording artifact ID"));
    }
    let suffix = if r.kind == "video" {
        "mp4"
    } else if r.kind == "snapshot" {
        "snapshot.png"
    } else {
        "pointer.json"
    };
    let name = format!("{}.{}", r.recording_id, suffix);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(o.output_directory.join(&name))
        .map_err(|_| {
            (
                StatusCode::NOT_FOUND,
                "recording artifact unavailable".into(),
            )
        })?;
    let meta = file
        .metadata()
        .map_err(|_| bad("cannot inspect recording artifact"))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 512 * 1024 * 1024 || r.offset > meta.len()
    {
        return Err(bad("invalid recording artifact size or offset"));
    }
    let mut file = tokio::fs::File::from_std(file);
    file.seek(std::io::SeekFrom::Start(r.offset))
        .await
        .map_err(|_| bad("cannot seek recording artifact"))?;
    let mut bytes = vec![0; (meta.len() - r.offset).min(1024 * 1024) as usize];
    file.read_exact(&mut bytes)
        .await
        .map_err(|_| bad("cannot read recording artifact"))?;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in &bytes {
        write!(&mut hex, "{byte:02x}").expect("writing into String");
    }
    Ok(
        json!({"ok":true,"name":name,"encoding":"hex","data":hex,"offset":r.offset,"total_bytes":meta.len(),"next_offset":r.offset+bytes.len() as u64,"mime":if r.kind=="video" {"video/mp4"} else if r.kind=="snapshot" {"image/png"} else {"application/json"}}),
    )
}
#[derive(Default)]
pub struct ScreenRecorder {
    operations: tokio::sync::Mutex<()>,
    permissions: tokio::sync::Mutex<std::collections::BTreeMap<String, Value>>,
}
impl ScreenRecorder {
    async fn permission_result(&self, action: &str, reply: &Value, waiting: bool) {
        let key = if action.starts_with("pointer-") {
            "input"
        } else {
            "screen"
        };
        let verified = reply["ok"] == true
            && if key == "input" {
                reply["code"] == "pointer_listener_usable"
            } else {
                reply["probe"] == "real_stream" || reply["completeFrames"].as_u64().unwrap_or(0) > 0
            };
        let denied = [
            "permission_required",
            "permission_not_granted",
            "pointer_permission_required",
        ]
        .contains(&reply["code"].as_str().unwrap_or_default());
        let status = if verified {
            "verified"
        } else if waiting {
            "waiting"
        } else if denied {
            "required"
        } else {
            "error"
        };
        let now = crate::plugins::now();
        let mut permissions = self.permissions.lock().await;
        let requested = permissions
            .get(key)
            .and_then(|v| v["requested_at"].as_u64());
        permissions.insert(key.into(),json!({"status":status,"checked_at":now,"requested_at":requested,"message":reply["message"]}));
    }
    async fn snapshot(&self, o: &Options) -> Value {
        let mut data = read(o).await;
        let now = crate::plugins::now();
        if data["recorder"]["state"] != "processing" {
            for (key, action) in [("screen", "doctor"), ("input", "pointer-doctor")] {
                let pending = self.permissions.lock().await.get(key).cloned();
                if let Some(pending) = pending.filter(|v| v["status"] == "waiting") {
                    let within =
                        now.saturating_sub(pending["requested_at"].as_u64().unwrap_or(0)) < 120_000;
                    if within && data["availability"] == "ready" {
                        if let Ok(reply) =
                            rpc(o, vec![action.into(), "--timeout".into(), "5".into()]).await
                        {
                            let denied = [
                                "permission_required",
                                "permission_not_granted",
                                "pointer_permission_required",
                            ]
                            .contains(&reply["code"].as_str().unwrap_or_default());
                            self.permission_result(action, &reply, denied).await;
                        }
                    } else if !within {
                        self.permission_result(action,&json!({"ok":false,"code":"permission_check_timeout","message":"Permission confirmation was not verified before the bounded wait; check again explicitly."}),false).await;
                    }
                }
            }
        }
        let permissions = self.permissions.lock().await;
        data["permissions"] = json!({"screen":permissions.get("screen").cloned().unwrap_or(json!({"status":"unchecked","checked_at":null,"requested_at":null,"message":null})),"input":permissions.get("input").cloned().unwrap_or(json!({"status":"unchecked","checked_at":null,"requested_at":null,"message":null}))});
        data
    }
}
impl Plugin for ScreenRecorder {
    fn id(&self) -> &'static str {
        "screen-recording"
    }
    fn validate(&self, value: &Value) -> Result<(), String> {
        options(value.clone()).map(|_| ())
    }
    fn run(&self, context: Context, value: Value) -> Task<'_, Result<(), String>> {
        Box::pin(async move {
            let o = options(value)?;
            while !context.cancelled.load(Ordering::Relaxed) {
                context.publish(self.snapshot(&o).await).await;
                tokio::time::sleep(std::time::Duration::from_millis(o.interval_ms)).await;
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
            let o = options(value).map_err(|e| bad(&e))?;
            let readonly = [
                "status",
                "doctor",
                "pointer-doctor",
                "windows",
                "displays",
                "artifact",
            ]
            .contains(&action.as_str());
            if !readonly && !o.allow_control {
                return Err((
                    StatusCode::FORBIDDEN,
                    "screen recording control is disabled".into(),
                ));
            }
            if !cfg!(target_os = "macos") {
                return Err((
                    StatusCode::CONFLICT,
                    "screen recording requires macOS".into(),
                ));
            }
            if action == "artifact" {
                return artifact(&o, body).await;
            }
            let _guard = if readonly {
                None
            } else {
                Some(self.operations.lock().await)
            };
            if context
                .state
                .read()
                .await
                .plugins
                .get("screen-recording")
                .is_none_or(|p| !p.enabled)
            {
                return Err((
                    StatusCode::CONFLICT,
                    "screen-recorder plugin disabled".into(),
                ));
            }
            let is_permission_request =
                ["authorize", "pointer-authorize"].contains(&action.as_str());
            if is_permission_request && body == json!({"interactive":true}) {
                let key = if action.starts_with("pointer-") {
                    "input"
                } else {
                    "screen"
                };
                self.permissions.lock().await.insert(key.into(),json!({"status":"waiting","checked_at":null,"requested_at":crate::plugins::now(),"message":null}));
                context.publish(self.snapshot(&o).await).await;
            }
            let reply = match action.as_str() {
                "start" => {
                    let (output, args) = start_args(&o, body)?;
                    claim_start(&o, &args, &output)?;
                    let state =
                        rpc(&o, vec!["status".into(), "--timeout".into(), "3".into()]).await?;
                    if state["output"] == output
                        && ["recording", "stopping", "completed", "failed"]
                            .contains(&state["state"].as_str().unwrap_or_default())
                    {
                        return Ok(state);
                    }
                    rpc(&o, args).await?
                }
                "snapshot" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct SnapshotRequest {
                        request_id: String,
                        recording_id: String,
                    }
                    let request: SnapshotRequest = serde_json::from_value(body)
                        .map_err(|_| bad("invalid snapshot request"))?;
                    if !valid_id(&request.request_id) || !valid_id(&request.recording_id) {
                        return Err(bad("snapshot and recording IDs must be UUIDs"));
                    }
                    let output = o
                        .output_directory
                        .join(format!("{}.snapshot.png", request.request_id))
                        .to_string_lossy()
                        .into_owned();
                    let recording = o
                        .output_directory
                        .join(format!("{}.mp4", request.recording_id))
                        .to_string_lossy()
                        .into_owned();
                    claim_start(
                        &o,
                        &["snapshot".into(), recording.clone(), output.clone()],
                        &output,
                    )?;
                    let metadata = Path::new(&output).with_extension("json");
                    use std::os::unix::fs::OpenOptionsExt;
                    if let Ok(file) = std::fs::OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_NOFOLLOW)
                        .open(&metadata)
                    {
                        use std::io::Read;
                        let cached: Value = serde_json::from_reader(file.take(1024 * 1024))
                            .map_err(|_| bad("snapshot receipt invalid"))?;
                        if cached["ok"] == true
                            && cached["recordingOutput"] == recording
                            && cached["snapshotOutput"] == output
                        {
                            return Ok(cached);
                        }
                        return Err(bad(
                            "snapshot receipt does not match the requested recording",
                        ));
                    }
                    let state =
                        rpc(&o, vec!["status".into(), "--timeout".into(), "3".into()]).await?;
                    if state["state"] != "recording" || state["output"] != recording {
                        return Err((
                            StatusCode::CONFLICT,
                            "the requested recording is not actively receiving frames".into(),
                        ));
                    }
                    rpc(
                        &o,
                        vec![
                            "snapshot".into(),
                            "--video".into(),
                            recording,
                            "--output".into(),
                            output,
                            "--timeout".into(),
                            "15".into(),
                        ],
                    )
                    .await?
                }
                "stop" => {
                    empty(&body)?;
                    let state =
                        rpc(&o, vec!["status".into(), "--timeout".into(), "3".into()]).await?;
                    if state["state"] != "recording" {
                        return Ok(state);
                    }
                    submit_stop(&o).await?
                }
                "authorize" | "pointer-authorize" => {
                    if body != json!({"interactive":true}) {
                        return Err(bad("explicit interactive:true required"));
                    }
                    rpc(
                        &o,
                        vec![
                            action.clone(),
                            "--interactive".into(),
                            "--timeout".into(),
                            "25".into(),
                        ],
                    )
                    .await?
                }
                "install" | "upgrade" | "rollback" => {
                    let mut args = vec![];
                    if action == "rollback" {
                        if body.as_object().is_none_or(|m| m.len() != 1) {
                            return Err(bad("rollback requires backup"));
                        }
                        let path = body["backup"]
                            .as_str()
                            .ok_or_else(|| bad("rollback requires backup"))?;
                        let real = Path::new(path)
                            .canonicalize()
                            .map_err(|_| bad("backup directory unavailable"))?;
                        let root = home()
                            .join("Library/Application Support/Agent Screen Recorder/backups")
                            .canonicalize()
                            .map_err(|_| bad("backup root unavailable"))?;
                        if !real.starts_with(root) {
                            return Err(bad("backup must belong to this recorder installation"));
                        }
                        args.extend(["--rollback".into(), real.to_string_lossy().into_owned()]);
                    } else {
                        empty(&body)?;
                        if action == "upgrade" {
                            args.push("--upgrade".into());
                        }
                    }
                    let output = command(&o.package.join("scripts/install.sh"), &args).await?;
                    json!({"schemaVersion":1,"ok":output.status.success(),"code":if output.status.success(){"installation_completed"}else{"installation_failed"},"message":String::from_utf8_lossy(if output.status.success(){&output.stdout}else{&output.stderr})})
                }
                "status" | "doctor" | "pointer-doctor" | "windows" | "displays" => {
                    empty(&body)?;
                    rpc(
                        &o,
                        vec![
                            action.clone(),
                            "--timeout".into(),
                            if readonly { "15" } else { "28" }.into(),
                        ],
                    )
                    .await?
                }
                _ => {
                    return Err((
                        StatusCode::NOT_FOUND,
                        "unknown screen-recorder action".into(),
                    ))
                }
            };
            if ["doctor", "authorize", "pointer-doctor", "pointer-authorize"]
                .contains(&action.as_str())
            {
                let waiting = is_permission_request
                    && reply["ok"] != true
                    && [
                        "permission_required",
                        "permission_not_granted",
                        "pointer_permission_required",
                        "restart_required",
                        "command_timeout",
                        "operation_timeout",
                    ]
                    .contains(&reply["code"].as_str().unwrap_or_default());
                self.permission_result(&action, &reply, waiting).await;
            }
            context.publish(self.snapshot(&o).await).await;
            Ok(reply)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_targets_paths_and_stable_output_identity() {
        let o = Options::default();
        let id = "c112f2f2-3a32-4511-8f19-a847cb3c6f0c";
        let (output, args) = start_args(
            &o,
            json!({"request_id":id,"window":42,"duration":18,"tail":1,"pointer_source":"native"}),
        )
        .unwrap();
        assert!(output.ends_with(&format!("{id}.mp4")));
        assert!(args.contains(&"--window".into()));
        assert!(args.contains(&"--pointer-output".into()));
        for bad in [
            json!({"request_id":"../x","duration":18}),
            json!({"request_id":id,"duration":18,"window":1,"display":2}),
            json!({"request_id":id,"duration":18,"shell":"id"}),
            json!({"request_id":id,"duration":18,"pointer_source":"keyboard"}),
        ] {
            assert!(start_args(&o, bad).is_err());
        }
        assert!(options(json!({"cli":"relative"})).is_err());
    }
    #[tokio::test]
    async fn result_chunks_are_confined_and_do_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let directory =
            std::env::temp_dir().join(format!("recorder-artifact-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let o = Options {
            output_directory: directory.clone(),
            ..Options::default()
        };
        let id = "c112f2f2-3a32-4511-8f19-a847cb3c6f0c";
        std::fs::write(directory.join(format!("{id}.mp4")), [0, 1, 254, 255]).unwrap();
        let reply = artifact(&o, json!({"recording_id":id,"kind":"video","offset":1}))
            .await
            .unwrap();
        assert_eq!(reply["data"], "01feff");
        assert_eq!(reply["next_offset"], 4);
        symlink(
            directory.join(format!("{id}.mp4")),
            directory.join(format!("{id}.pointer.json")),
        )
        .unwrap();
        assert!(artifact(&o, json!({"recording_id":id,"kind":"pointer"}))
            .await
            .is_err());
        assert!(artifact(&o, json!({"recording_id":"../x","kind":"video"}))
            .await
            .is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn snapshots_reuse_receipts_without_recapturing_and_bind_the_recording() {
        let directory =
            std::env::temp_dir().join(format!("recorder-snapshot-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let id = "c112f2f2-3a32-4511-8f19-a847cb3c6f0c";
        let recording_id = "d112f2f2-3a32-4511-8f19-a847cb3c6f0c";
        let output = directory.join(format!("{id}.snapshot.png"));
        let recording = directory.join(format!("{recording_id}.mp4"));
        let reply = json!({"schemaVersion":1,"ok":true,"code":"snapshot_saved","message":"fixture","snapshotOutput":output,"recordingOutput":recording,"mediaTimeSeconds":2.0});
        std::fs::write(
            output.with_extension("json"),
            serde_json::to_vec(&reply).unwrap(),
        )
        .unwrap();
        std::fs::write(&output, [137, 80, 78, 71]).unwrap();
        let state = std::sync::Arc::new(tokio::sync::RwLock::new(
            crate::collectors::SharedState::new(),
        ));
        state.write().await.plugins.insert(
            "screen-recording".into(),
            crate::plugins::Envelope {
                version: 1,
                enabled: true,
                status: "ready".into(),
                ts: 0,
                data: Value::Null,
                error: None,
            },
        );
        let context = Context {
            id: "screen-recording".into(),
            state,
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let plugin = ScreenRecorder::default();
        let options =
            json!({"allow_control":true,"cli":"/missing/recorder","output_directory":directory});
        let result = plugin
            .action(
                context.clone(),
                options.clone(),
                "snapshot".into(),
                json!({"request_id":id,"recording_id":recording_id}),
            )
            .await
            .unwrap();
        assert_eq!(result, reply);
        assert_eq!(
            plugin
                .action(
                    context,
                    options,
                    "snapshot".into(),
                    json!({"request_id":id,"recording_id":id})
                )
                .await
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        let o = Options {
            output_directory: directory.clone(),
            ..Options::default()
        };
        let png = artifact(&o, json!({"recording_id":id,"kind":"snapshot"}))
            .await
            .unwrap();
        assert_eq!(png["mime"], "image/png");
        assert_eq!(png["data"], "89504e47");
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn duplicate_ids_compare_normalized_parameters_and_stop_survives_short_wait() {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!("recorder-retry-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let marker = directory.join("finalized");
        let cli = directory.join("fake-recorder");
        std::fs::write(&cli,format!("#!/bin/sh\n[ \"$1\" = stop ] && [ \"$2\" = --timeout ] && [ \"$3\" = 120 ] || exit 1\nsleep 1\nprintf completed > '{}'\n",marker.display())).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let o = Options {
            cli,
            output_directory: directory.clone(),
            ..Options::default()
        };
        let id = "c112f2f2-3a32-4511-8f19-a847cb3c6f0c";
        let (output, args) =
            start_args(&o, json!({"request_id":id,"duration":18,"window":42})).unwrap();
        claim_start(&o, &args, &output).unwrap();
        let (_, same) = start_args(
            &o,
            json!({"request_id":id,"duration":18.0,"window":42,"tail":0}),
        )
        .unwrap();
        claim_start(&o, &same, &output).unwrap();
        for change in [
            json!({"request_id":id,"duration":19,"window":42}),
            json!({"request_id":id,"duration":18,"window":43}),
            json!({"request_id":id,"duration":18,"window":42,"pointer_source":"native"}),
        ] {
            let (_, different) = start_args(&o, change).unwrap();
            assert_eq!(
                claim_start(&o, &different, &output).unwrap_err().0,
                StatusCode::CONFLICT
            );
        }
        let began = std::time::Instant::now();
        assert_eq!(submit_stop(&o).await.unwrap()["code"], "stop_requested");
        assert!(began.elapsed() < std::time::Duration::from_millis(500));
        assert!(!marker.exists());
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !marker.exists() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "completed");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
