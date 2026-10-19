use crate::plugins::{Context, Failure, Plugin, Task};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Latest explicit CI summary written by the shared quality lifecycle.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RunReport {
    pub schema: u64,
    pub phase: String,
    pub conclusion: String,
    pub sha: String,
    #[serde(default)]
    pub pr: Option<u64>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub run_attempt: Option<u64>,
    #[serde(default)]
    pub requester: Option<String>,
    #[serde(default)]
    pub shared_ref: Option<String>,
    #[serde(default)]
    pub env_ok: Option<bool>,
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default)]
    pub diagnostics: Option<String>,
}

/// GitHub Actions self-hosted runner discovery under ~/runners/<repo>.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RunnerInstall {
    pub repo_dir: String,
    pub repo: Option<String>,
    pub agent_name: Option<String>,
    pub agent_id: Option<u64>,
    pub labels: Vec<String>,
    pub work_folder: Option<String>,
    pub listener_pid: Option<u32>,
    pub worker_pid: Option<u32>,
    pub work_bytes: Option<u64>,
    pub sizes_ts: Option<u64>,
    pub diag_bytes: Option<u64>,
    pub diag_latest: Option<String>,
    pub run: Option<RunReport>,
    pub ts: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn dir_size(path: &Path, cancelled: &AtomicBool) -> Option<u64> {
    let mut total = 0u64;
    let started = std::time::Instant::now();
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return None;
        }
        let read = std::fs::read_dir(&dir).ok()?;
        for entry in read.filter_map(|e| e.ok()) {
            if started.elapsed() > std::time::Duration::from_secs(2)
                || cancelled.load(Ordering::Relaxed)
            {
                return None;
            }
            let meta = entry.path().symlink_metadata().ok()?;
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Some(total)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    agent_name: Option<String>,
    agent_id: Option<u64>,
    work_folder: Option<String>,
    #[serde(rename = "gitHubUrl")]
    github_url: Option<String>,
}

fn repository(url: &str) -> Option<String> {
    let slug = url
        .trim()
        .strip_prefix("https://github.com/")?
        .trim_end_matches('/');
    let parts: Vec<_> = slug.split('/').collect();
    (parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        }))
    .then(|| slug.to_ascii_lowercase())
}

fn parse_runner_file(path: &Path) -> Registration {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Registration::default();
    };
    // GitHub writes .runner with a UTF-8 BOM; strip it before parsing.
    let trimmed = raw.trim_start_matches('\u{feff}');
    serde_json::from_str(trimmed).unwrap_or_default()
}

fn process_pattern(directory: &Path, executable: &str) -> String {
    let path = directory
        .join("bin")
        .join(executable)
        .to_string_lossy()
        .into_owned();
    let mut pattern = String::new();
    for c in path.chars() {
        if matches!(
            c,
            '\\' | '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
        ) {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern
}

fn pgrep(pattern: &str) -> Option<u32> {
    let output = std::process::Command::new("pgrep")
        .arg("-f")
        .arg(pattern)
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    text.lines()
        .next()
        .and_then(|line| line.trim().parse().ok())
}

fn latest_diag(dir: &PathBuf) -> Option<String> {
    let entries = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("Worker_") || name.starts_with("Runner_")
        })
        .max_by_key(|e| e.file_name());
    entries.map(|e| e.file_name().to_string_lossy().to_string())
}

fn read_run(path: &Path, worker_pid: Option<u32>) -> Option<RunReport> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut report: RunReport = serde_json::from_str(&text).ok()?;
    if report.schema != 1
        || report.sha.is_empty()
        || !matches!(
            report.conclusion.as_str(),
            "passed" | "environment" | "check" | "infrastructure" | "interrupted" | "incomplete"
        )
    {
        return None;
    }
    if let Some(failure) = report.failure.as_mut() {
        if failure.chars().count() > 500 {
            *failure = failure.chars().take(500).collect();
        }
    }
    // A dead Worker cannot still be inside a stage. Keep finished conclusions.
    if report.conclusion == "incomplete" && worker_pid.is_none() {
        report.conclusion = "interrupted".into();
        if report.failure.as_deref().unwrap_or("").is_empty() {
            report.failure = Some("worker exited before the run finished".into());
        }
    }
    Some(report)
}

fn discover(cancelled: &AtomicBool, include_sizes: bool) -> Result<Vec<RunnerInstall>, Failure> {
    let table = processes()?;
    let base = dirs_home().join("runners");
    let mut installs: Vec<RunnerInstall> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.filter_map(|e| e.ok()) {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(Vec::new());
            }
            let repo_dir = entry.path();
            if !repo_dir.is_dir() || !repo_dir.join(".runner").is_file() {
                continue;
            }
            let repo_name = entry.file_name().to_string_lossy().to_string();
            let registration = parse_runner_file(&repo_dir.join(".runner"));
            let repo = registration.github_url.as_deref().and_then(repository);
            let work_folder = registration.work_folder;
            let listener_pid = table
                .iter()
                .find(|p| {
                    p.uid == libc_getuid()
                        && p.command == repo_dir.join("bin/Runner.Listener").to_string_lossy()
                })
                .map(|p| p.pid);
            let worker_pid = table
                .iter()
                .find(|p| {
                    p.uid == libc_getuid()
                        && p.command == repo_dir.join("bin/Runner.Worker").to_string_lossy()
                })
                .map(|p| p.pid);
            let work_bytes = include_sizes
                .then_some(work_folder.as_ref())
                .flatten()
                .map(|wf| {
                    let p = repo_dir.join(wf);
                    if p.is_dir() {
                        p
                    } else {
                        repo_dir.join(wf.split('/').next_back().unwrap_or(wf))
                    }
                })
                .and_then(|p| dir_size(&p, cancelled));
            let diag = repo_dir.join("_diag");
            let diag_bytes = if include_sizes {
                dir_size(&diag, cancelled)
            } else {
                None
            };
            let diag_latest = if include_sizes {
                latest_diag(&diag)
            } else {
                None
            };
            let run = read_run(
                &dirs_home()
                    .join(".local/state/mini-archipel/ci/reports")
                    .join(format!("{repo_name}.json")),
                worker_pid,
            );
            installs.push(RunnerInstall {
                repo_dir: repo_name,
                repo,
                agent_name: registration.agent_name,
                agent_id: registration.agent_id,
                labels: Vec::new(),
                work_folder,
                listener_pid,
                worker_pid,
                work_bytes,
                sizes_ts: include_sizes.then(now_unix),
                diag_bytes,
                diag_latest,
                run,
                ts: now_unix(),
            });
        }
    }
    Ok(installs)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    #[serde(default = "default_interval")]
    interval_ms: u64,
    #[serde(default)]
    allow_control: bool,
}
fn default_interval() -> u64 {
    5000
}
fn options(value: Value) -> Result<Options, String> {
    let value: Options = serde_json::from_value(value).map_err(|_| "invalid runners options")?;
    if !(1000..=60000).contains(&value.interval_ms) {
        return Err("runners interval_ms must be 1000..60000".into());
    }
    Ok(value)
}

fn lease_helper() -> PathBuf {
    dirs_home().join(".local/libexec/mini-archipel/ci/ci-lease.py")
}

async fn lease_command(action: &str, body: Option<Value>) -> Result<Value, Failure> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let unavailable = || {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "node runner policy unavailable; check shared job hooks".into(),
        )
    };
    let mut child = tokio::process::Command::new("/usr/bin/python3")
        .arg(lease_helper())
        .arg(action)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| unavailable())?;
    if let Some(body) = body {
        let mut input = child.stdin.take().ok_or_else(unavailable)?;
        input
            .write_all(body.to_string().as_bytes())
            .await
            .map_err(|_| unavailable())?;
    } else {
        drop(child.stdin.take());
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(if action == "state" { 6 } else { 45 }),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| unavailable())?
    .map_err(|_| unavailable())?;
    if !output.status.success() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "node runner policy rejected the command; inspect local state before retrying".into(),
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| unavailable())
}

#[derive(Default)]
pub struct Runners {
    operations: crate::plugins::runner_operations::Operations,
    policy_generation: Arc<std::sync::atomic::AtomicU64>,
}
impl Plugin for Runners {
    fn id(&self) -> &'static str {
        "runners"
    }
    fn disk_expansions(&self) -> Vec<PathBuf> {
        vec![dirs_home().join("runners")]
    }
    fn schema_version(&self) -> u32 {
        2
    }
    fn validate(&self, value: &Value) -> Result<(), String> {
        options(value.clone()).map(|_| ())
    }
    fn run(&self, context: Context, value: Value) -> Task<'_, Result<(), String>> {
        Box::pin(async move {
            let settings = options(value)?;
            let mut sizes: std::collections::HashMap<String, RunnerInstall> =
                std::collections::HashMap::new();
            let mut size_task: Option<
                tokio::task::JoinHandle<Result<Vec<RunnerInstall>, Failure>>,
            > = None;
            let mut policy_task: Option<tokio::task::JoinHandle<Result<Value, Failure>>> = None;
            let mut generation = self.policy_generation.load(Ordering::Relaxed);
            let mut last_sizes = std::time::Instant::now() - std::time::Duration::from_secs(60);
            let mut last_policy = std::time::Instant::now() - std::time::Duration::from_secs(60);
            let mut coordination = json!({"available":false,"enabled":false,"active_repo":null,"paused":[],"waiting":[],"error":null});
            loop {
                let current = self.policy_generation.load(Ordering::Relaxed);
                if current != generation {
                    let shared = context.state.read().await;
                    if let Some(value) = shared
                        .plugins
                        .get("runners")
                        .map(|entry| entry.data["coordination"].clone())
                        .filter(Value::is_object)
                    {
                        coordination = value;
                    }
                    generation = current;
                    if let Some(task) = policy_task.take() {
                        task.abort();
                    }
                    last_policy = std::time::Instant::now() - std::time::Duration::from_secs(60);
                }
                if size_task.as_ref().is_some_and(|task| task.is_finished()) {
                    if let Ok(Ok(rows)) = size_task.take().unwrap().await {
                        sizes = rows.into_iter().map(|r| (r.repo_dir.clone(), r)).collect();
                    }
                }
                if size_task.is_none() && last_sizes.elapsed() >= std::time::Duration::from_secs(60)
                {
                    let cancelled = Arc::clone(&context.cancelled);
                    size_task = Some(tokio::task::spawn_blocking(move || {
                        discover(&cancelled, true)
                    }));
                    last_sizes = std::time::Instant::now();
                }
                if let Some(task) = policy_task.as_ref() {
                    let task: &tokio::task::JoinHandle<Result<Value, Failure>> = task;
                    if task.is_finished() {
                        match policy_task.take().unwrap().await {
                            Ok(Ok(value)) => coordination = value,
                            _ => {
                                coordination["available"] = json!(false);
                                coordination["error"] =
                                    json!("node runner policy temporarily unavailable");
                            }
                        }
                    }
                }
                if policy_task.is_none()
                    && last_policy.elapsed()
                        >= std::time::Duration::from_millis(settings.interval_ms)
                {
                    policy_task = Some(tokio::spawn(lease_command("state", None)));
                    last_policy = std::time::Instant::now();
                }
                let cancelled = Arc::clone(&context.cancelled);
                let rows = tokio::task::spawn_blocking(move || discover(&cancelled, false))
                    .await
                    .map_err(|_| "runner discovery failed")?;
                match rows {
                    Ok(mut runners) => {
                        for runner in &mut runners {
                            if let Some(stats) = sizes.get(&runner.repo_dir) {
                                runner.work_bytes = stats.work_bytes;
                                runner.diag_bytes = stats.diag_bytes;
                                runner.diag_latest = stats.diag_latest.clone();
                                runner.sizes_ts = stats.sizes_ts;
                            }
                        }
                        let data = json!({"runners":runners,"operations":self.operations.read().await.map_err(|(_,e)|e)?,"interval_ms":1000,"control_allowed":settings.allow_control,"coordination":coordination});
                        let mut shared = context.state.write().await;
                        if generation == self.policy_generation.load(Ordering::Relaxed) {
                            if let Some(entry) = shared.plugins.get_mut("runners") {
                                if entry.enabled && !context.cancelled.load(Ordering::Relaxed) {
                                    entry.data = data;
                                    entry.status = "ready".into();
                                    entry.error = None;
                                    entry.ts = now_unix();
                                }
                            }
                        }
                    }
                    Err(_) => {
                        if let Some(entry) = context.state.write().await.plugins.get_mut("runners")
                        {
                            entry.status = "error".into();
                            entry.error = Some("local process inspection unavailable".into());
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
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
            if !matches!(action.as_str(), "toggle" | "interrupt" | "coordination") {
                return Err((StatusCode::NOT_FOUND, "plugin action not found".into()));
            }
            let settings = options(value.clone()).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            if !settings.allow_control {
                return Err((StatusCode::FORBIDDEN, "runner control is disabled".into()));
            }
            let mut body = body;
            let object = body
                .as_object_mut()
                .ok_or((StatusCode::BAD_REQUEST, "invalid runner command".into()))?;
            let id = object
                .remove("request_id")
                .and_then(|v| v.as_str().map(str::to_owned))
                .ok_or((
                    StatusCode::BAD_REQUEST,
                    "operation request ID is required".into(),
                ))?;
            let allowed = match action.as_str() {
                "coordination" => vec!["enable"],
                "toggle" => vec!["repo", "runner", "enable"],
                _ => vec!["repo", "runner", "worker_pid"],
            };
            if object.len() != allowed.len()
                || object.keys().any(|key| !allowed.contains(&key.as_str()))
                || (action != "interrupt" && !body["enable"].is_boolean())
                || (action != "coordination"
                    && (body["repo"].as_str().is_none() || body["runner"].as_str().is_none()))
                || (action == "interrupt"
                    && body["worker_pid"]
                        .as_u64()
                        .is_none_or(|id| id == 0 || id > u32::MAX as u64))
            {
                return Err((StatusCode::BAD_REQUEST, "invalid runner command".into()));
            }
            let check_context = context.clone();
            let check_body = body.clone();
            let check_action = action.clone();
            let validate = Box::pin(async move {
                if check_action != "coordination" {
                    let shared = check_context.state.read().await;
                    let runners: Vec<RunnerInstall> = serde_json::from_value(
                        shared
                            .plugins
                            .get("runners")
                            .map(|p| p.data["runners"].clone())
                            .unwrap_or(Value::Null),
                    )
                    .map_err(|_| {
                        (
                            StatusCode::CONFLICT,
                            "plugin has no current snapshot".into(),
                        )
                    })?;
                    let runner = runners
                        .into_iter()
                        .find(|r| {
                            r.repo.as_deref() == check_body["repo"].as_str()
                                && Some(r.repo_dir.as_str()) == check_body["runner"].as_str()
                        })
                        .ok_or((StatusCode::NOT_FOUND, "runner not found".into()))?;
                    drop(shared);
                    let expected = check_body["worker_pid"].as_u64();
                    let interrupt = check_action == "interrupt";
                    tokio::task::spawn_blocking(move || {
                        let directory = dirs_home().join("runners").join(&runner.repo_dir);
                        let table = processes()?;
                        let worker = table.iter().find(|p| {
                            p.uid == libc_getuid()
                                && p.command
                                    == directory.join("bin/Runner.Worker").to_string_lossy()
                        });
                        if interrupt {
                            if worker.is_none_or(|p| Some(u64::from(p.pid)) != expected) {
                                return Err((
                                    StatusCode::CONFLICT,
                                    "active job changed; refresh before interrupting".into(),
                                ));
                            }
                        } else if worker.is_some() {
                            return Err((StatusCode::CONFLICT, "runner is running a job".into()));
                        }
                        Ok(())
                    })
                    .await
                    .map_err(|_| {
                        (
                            StatusCode::SERVICE_UNAVAILABLE,
                            "could not inspect local processes".into(),
                        )
                    })??;
                }
                Ok(())
            });
            let request = body.clone();
            let context_for_receipt = context.clone();
            let receipt = self
                .operations
                .submit(
                    id,
                    action.clone(),
                    request,
                    validate,
                    Box::pin(execute_action(
                        context,
                        value,
                        action,
                        body,
                        Arc::clone(&self.policy_generation),
                    )),
                )
                .await?;
            let jobs = self.operations.read().await?;
            if let Some(entry) = context_for_receipt
                .state
                .write()
                .await
                .plugins
                .get_mut("runners")
            {
                entry.data["operations"] = json!(jobs);
            }
            Ok(receipt)
        })
    }
}

async fn execute_action(
    context: Context,
    value: Value,
    action: String,
    body: Value,
    generation: Arc<std::sync::atomic::AtomicU64>,
) -> Result<Value, Failure> {
    if action != "toggle" && action != "interrupt" && action != "coordination" {
        return Err((StatusCode::NOT_FOUND, "plugin action not found".into()));
    }
    let settings = options(value).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    if !settings.allow_control {
        return Err((StatusCode::FORBIDDEN, "runner control is disabled".into()));
    }
    if action == "coordination" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PolicyRequest {
            enable: bool,
        }
        let request: PolicyRequest = serde_json::from_value(body).map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "invalid runner policy command".into(),
            )
        })?;
        let coordination = lease_command("policy", Some(json!({"enable": request.enable}))).await?;
        let mut shared = context.state.write().await;
        if let Some(entry) = shared.plugins.get_mut("runners") {
            entry.data["coordination"] = coordination;
            entry.ts = now_unix();
        }
        generation.fetch_add(1, Ordering::Relaxed);
        return Ok(json!({"ok": true}));
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        repo: String,
        runner: String,
        enable: Option<bool>,
        worker_pid: Option<u32>,
    }
    let request: Request = serde_json::from_value(body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid runner command".into()))?;
    let installs: Vec<RunnerInstall> = {
        let shared = context.state.read().await;
        let data = shared
            .plugins
            .get("runners")
            .map(|p| p.data["runners"].clone())
            .unwrap_or(Value::Null);
        serde_json::from_value(data).map_err(|_| {
            (
                StatusCode::CONFLICT,
                "plugin has no current snapshot".into(),
            )
        })?
    };
    let runner = installs
        .into_iter()
        .find(|r| r.repo.as_deref() == Some(request.repo.as_str()) && r.repo_dir == request.runner)
        .ok_or((StatusCode::NOT_FOUND, "runner not found".into()))?;
    if action == "toggle" && lease_helper().is_file() {
        let enable = request
            .enable
            .ok_or((StatusCode::BAD_REQUEST, "enable is required".into()))?;
        if request.worker_pid.is_some() {
            return Err((StatusCode::BAD_REQUEST, "invalid service command".into()));
        }
        lease_command(
            "service",
            Some(json!({"repo": request.repo, "runner": request.runner, "enable": enable})),
        )
        .await?;
        return Ok(json!({"ok": true}));
    }
    let operation = action.clone();
    tokio::task::spawn_blocking(move || {
        if operation == "interrupt" {
            let pid = request.worker_pid.ok_or((
                StatusCode::BAD_REQUEST,
                "expected Worker PID is required".into(),
            ))?;
            if request.enable.is_some() {
                return Err((StatusCode::BAD_REQUEST, "invalid interrupt command".into()));
            }
            interrupt_worker(&runner, pid)
        } else {
            let enable = request
                .enable
                .ok_or((StatusCode::BAD_REQUEST, "enable is required".into()))?;
            if request.worker_pid.is_some() {
                return Err((StatusCode::BAD_REQUEST, "invalid service command".into()));
            }
            toggle_service(&runner, enable)
        }
    })
    .await
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "runner operation failed".into(),
        )
    })??;
    Ok(json!({ "ok": true }))
}

fn toggle_service(runner: &RunnerInstall, enable: bool) -> Result<(), Failure> {
    let home = dirs_home();
    let directory = home.join("runners").join(&runner.repo_dir);
    let registered_repo = parse_runner_file(&directory.join(".runner"))
        .github_url
        .as_deref()
        .and_then(repository);
    if registered_repo.is_none() || registered_repo != runner.repo {
        return Err((
            StatusCode::CONFLICT,
            "registered repository changed; refresh before retrying".into(),
        ));
    }
    // Recheck the live Worker at the operation boundary, not only the cached snapshot.
    let output = std::process::Command::new("/usr/bin/pgrep")
        .args(["-f", &process_pattern(&directory, "Runner.Worker")])
        .output()
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "could not verify active jobs".into(),
            )
        })?;
    match output.status.code() {
        Some(0) => return Err((StatusCode::CONFLICT, "runner is running a job".into())),
        Some(1) => {}
        _ => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "could not verify active jobs".into(),
            ))
        }
    }
    if enable && pgrep(&process_pattern(&directory, "Runner.Listener")).is_some() {
        return Ok(());
    }
    let service =
        std::fs::read_to_string(home.join("runners").join(&runner.repo_dir).join(".service"))
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "could not read registered runner service".into(),
                )
            })?;
    let (label, plist) = runner_service_location(&home, &service)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;
    let domain = format!("gui/{}", libc_getuid());
    let target = format!("{domain}/{label}");
    let result = if enable {
        run("/bin/launchctl", &["enable", &target])
            .and_then(|_| run("/bin/launchctl", &["bootstrap", &domain, &plist]))
    } else {
        run("/bin/launchctl", &["disable", &target]).and_then(|_| {
            if std::process::Command::new("/bin/launchctl")
                .args(["print", &target])
                .output()
                .is_ok_and(|r| r.status.success())
            {
                run("/bin/launchctl", &["bootout", &target])
            } else {
                Ok(())
            }
        })
    };
    result.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "launchd could not change runner service state".into(),
        )
    })
}

fn runner_service_location(
    home: &std::path::Path,
    service: &str,
) -> Result<(String, String), &'static str> {
    let agents = home.join("Library/LaunchAgents");
    let path = std::path::Path::new(service.trim());
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        agents.join(path)
    };
    let label = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("invalid runner service")?;
    if path.parent() != Some(agents.as_path())
        || path.extension().and_then(|s| s.to_str()) != Some("plist")
        || !label.starts_with("actions.runner.")
    {
        return Err("runner service must be an Actions LaunchAgent in the user's Library");
    }
    Ok((label.to_string(), path.to_string_lossy().into_owned()))
}

fn libc_getuid() -> u32 {
    unsafe { libc::getuid() }
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("spawn {program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/Users/unknown"))
}

#[derive(Clone)]
struct Process {
    pid: u32,
    parent: u32,
    uid: u32,
    started: String,
    command: String,
    stopped: bool,
}
fn processes() -> Result<Vec<Process>, Failure> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,uid=,stat=,lstart=,comm="])
        .output()
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "could not inspect local processes".into(),
            )
        })?;
    if !output.status.success() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "could not inspect local processes".into(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3].starts_with('Z') {
                return None;
            }
            Some(Process {
                pid: fields[0].parse().ok()?,
                parent: fields[1].parse().ok()?,
                uid: fields[2].parse().ok()?,
                started: fields[4..9].join(" "),
                command: fields[9..].join(" "),
                stopped: fields[3].contains('T'),
            })
        })
        .collect())
}
fn same_process(left: &Process, right: &Process) -> bool {
    left.pid == right.pid
        && left.uid == right.uid
        && left.started == right.started
        && left.command == right.command
}
struct FrozenTree(Vec<Process>);
impl Drop for FrozenTree {
    fn drop(&mut self) {
        // A failure before termination must not leave a running job suspended.
        if let Ok(live) = processes() {
            for process in &self.0 {
                if live.iter().any(|p| same_process(process, p)) {
                    unsafe {
                        libc::kill(process.pid as i32, libc::SIGCONT);
                    }
                }
            }
        }
    }
}
fn interrupt_worker(runner: &RunnerInstall, expected_pid: u32) -> Result<(), Failure> {
    let directory = dirs_home().join("runners").join(&runner.repo_dir);
    let registered = parse_runner_file(&directory.join(".runner"))
        .github_url
        .as_deref()
        .and_then(repository);
    if registered.is_none() || registered != runner.repo {
        return Err((
            StatusCode::CONFLICT,
            "registered repository changed; refresh before retrying".into(),
        ));
    }
    let all = processes()?;
    let worker = all
        .iter()
        .find(|p| {
            p.pid == expected_pid
                && p.uid == libc_getuid()
                && p.command == directory.join("bin/Runner.Worker").to_string_lossy()
        })
        .ok_or((
            StatusCode::CONFLICT,
            "active job changed; refresh before interrupting".into(),
        ))?;
    let mut frozen = FrozenTree(vec![]);
    let mut tree = vec![worker.clone()];
    let started = std::time::Instant::now();
    loop {
        let live = processes()?;
        for process in &tree {
            if !frozen.0.iter().any(|p| same_process(p, process))
                && live.iter().any(|p| same_process(p, process))
            {
                if unsafe { libc::kill(process.pid as i32, libc::SIGSTOP) } != 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        "could not suspend local job process tree".into(),
                    ));
                }
                frozen.0.push(process.clone());
            }
        }
        let live = processes()?;
        let added: Vec<_> = live
            .iter()
            .filter(|p| {
                p.uid == worker.uid
                    && !tree.iter().any(|t| same_process(t, p))
                    && tree.iter().any(|t| {
                        t.pid == p.parent && live.iter().any(|parent| same_process(t, parent))
                    })
            })
            .cloned()
            .collect();
        if added.is_empty()
            && tree.iter().all(|p| {
                live.iter()
                    .find(|q| same_process(p, q))
                    .is_none_or(|p| p.stopped)
            })
        {
            break;
        }
        tree.extend(added);
        if tree.len() > 4096 || started.elapsed() > std::time::Duration::from_secs(10) {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "could not quiesce local job process tree".into(),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // Quiesce before killing: children cannot fork between discovery and termination.
    let live = processes()?;
    for process in tree.iter().rev() {
        if live.iter().any(|p| same_process(p, process))
            && unsafe { libc::kill(process.pid as i32, libc::SIGKILL) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not interrupt a local job process".into(),
            ));
        }
    }
    for _ in 0..30 {
        let live = processes()?;
        if !tree.iter().any(|t| live.iter().any(|p| same_process(t, p))) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err((
        StatusCode::SERVICE_UNAVAILABLE,
        "local job processes have not stopped".into(),
    ))
}
#[cfg(test)]
mod runner_service_tests {
    use super::{process_pattern, read_run, repository, runner_service_location};
    use std::path::Path;

    #[test]
    fn identifies_full_repositories_and_escapes_installation_process_paths() {
        assert_eq!(
            repository("https://github.com/Owner/Project/"),
            Some("owner/project".into())
        );
        assert_ne!(
            repository("https://github.com/owner-a/project"),
            repository("https://github.com/owner-b/project")
        );
        for value in [
            "https://github.com/owner",
            "https://example.com/owner/project",
            "https://github.com/owner/../project",
            "https://github.com/owner/project?x=1",
        ] {
            assert_eq!(repository(value), None);
        }
        assert_eq!(
            process_pattern(Path::new("/Users/ci/runners/repo.one"), "Runner.Worker"),
            "/Users/ci/runners/repo\\.one/bin/Runner\\.Worker"
        );
    }

    #[test]
    fn uses_registered_service_for_old_and_renamed_repositories() {
        let home = Path::new("/Users/runner");
        for label in [
            "actions.runner.yaindrop-flow-bit.mini",
            "actions.runner.yaindrop-flowbit.tart",
        ] {
            let full = format!("/Users/runner/Library/LaunchAgents/{label}.plist");
            assert_eq!(
                runner_service_location(home, &format!("{full}\n")).unwrap(),
                (label.to_string(), full.clone())
            );
            assert_eq!(
                runner_service_location(home, &format!("{label}.plist"))
                    .unwrap()
                    .1,
                full
            );
        }
    }

    #[test]
    fn rejects_unrelated_services_and_paths_outside_launch_agents() {
        let home = Path::new("/Users/runner");
        for value in [
            "",
            "local.miniarchipel.agent.plist",
            "../actions.runner.other.plist",
            "/tmp/actions.runner.other.plist",
        ] {
            assert!(runner_service_location(home, value).is_err());
        }
    }

    #[test]
    fn recovers_an_unfinished_run_after_the_worker_is_gone() {
        let dir = std::env::temp_dir().join(format!("mini-archipel-ci-run-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("report.json");
        std::fs::write(
            &path,
            r#"{"schema":1,"phase":"check:unit","conclusion":"incomplete","sha":"abc","env_ok":null,"failure":null}"#,
        )
        .unwrap();
        let recovered = read_run(&path, None).unwrap();
        assert_eq!(recovered.conclusion, "interrupted");
        assert!(recovered.failure.unwrap().contains("worker"));
        let live = read_run(&path, Some(7)).unwrap();
        assert_eq!(live.conclusion, "incomplete");
        std::fs::write(
            &path,
            r#"{"schema":1,"phase":"summary","conclusion":"passed","sha":"abc","env_ok":true}"#,
        )
        .unwrap();
        assert_eq!(read_run(&path, None).unwrap().conclusion, "passed");
        std::fs::write(&path, "{").unwrap();
        assert!(read_run(&path, None).is_none());
        std::fs::write(
            &path,
            r#"{"schema":2,"phase":"summary","conclusion":"passed","sha":"abc"}"#,
        )
        .unwrap();
        assert!(read_run(&path, None).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
