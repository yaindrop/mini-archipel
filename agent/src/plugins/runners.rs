use crate::plugins::{Context, Failure, Plugin, Task};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// GitHub Actions self-hosted runner discovery under ~/github-runners/<repo>.
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
    pub diag_bytes: Option<u64>,
    pub diag_latest: Option<String>,
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
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return None;
        }
        let read = std::fs::read_dir(&dir).ok()?;
        for entry in read.filter_map(|e| e.ok()) {
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
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("Worker_") || name.starts_with("Runner_")
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());
    entries
        .pop()
        .map(|e| e.file_name().to_string_lossy().to_string())
}

fn discover(cancelled: &AtomicBool) -> Vec<RunnerInstall> {
    let base = dirs_home().join("github-runners");
    let mut installs: Vec<RunnerInstall> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.filter_map(|e| e.ok()) {
            if cancelled.load(Ordering::Relaxed) {
                return Vec::new();
            }
            let repo_dir = entry.path();
            if !repo_dir.is_dir() || !repo_dir.join(".runner").is_file() {
                continue;
            }
            let repo_name = entry.file_name().to_string_lossy().to_string();
            let registration = parse_runner_file(&repo_dir.join(".runner"));
            let repo = registration.github_url.as_deref().and_then(repository);
            let work_folder = registration.work_folder;
            let listener_pid = pgrep(&process_pattern(&repo_dir, "Runner.Listener"));
            let worker_pid = pgrep(&process_pattern(&repo_dir, "Runner.Worker"));
            let work_bytes = work_folder
                .as_ref()
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
            let diag_bytes = dir_size(&diag, cancelled);
            let diag_latest = latest_diag(&diag);
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
                diag_bytes,
                diag_latest,
                ts: now_unix(),
            });
        }
    }
    installs
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

pub struct Runners;
impl Plugin for Runners {
    fn id(&self) -> &'static str {
        "runners"
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
            loop {
                let cancelled = Arc::clone(&context.cancelled);
                let runners = tokio::task::spawn_blocking(move || discover(&cancelled))
                    .await
                    .map_err(|_| "runner discovery failed")?;
                context
                    .publish(
                        json!({ "runners": runners, "interval_ms": settings.interval_ms,
                    "control_allowed": settings.allow_control }),
                    )
                    .await;
                tokio::time::sleep(std::time::Duration::from_millis(settings.interval_ms)).await;
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
            if action != "toggle" {
                return Err((StatusCode::NOT_FOUND, "plugin action not found".into()));
            }
            let settings = options(value).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            if !settings.allow_control {
                return Err((StatusCode::FORBIDDEN, "runner control is disabled".into()));
            }
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Request {
                repo: String,
                runner: String,
                enable: bool,
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
                .find(|r| {
                    r.repo.as_deref() == Some(request.repo.as_str()) && r.repo_dir == request.runner
                })
                .ok_or((StatusCode::NOT_FOUND, "runner not found".into()))?;
            tokio::task::spawn_blocking(move || toggle_service(&runner, request.enable))
                .await
                .map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "runner operation failed".into(),
                    )
                })??;
            Ok(json!({ "ok": true }))
        })
    }
}

fn toggle_service(runner: &RunnerInstall, enable: bool) -> Result<(), Failure> {
    let home = dirs_home();
    let directory = home.join("github-runners").join(&runner.repo_dir);
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
    let service = std::fs::read_to_string(
        home.join("github-runners")
            .join(&runner.repo_dir)
            .join(".service"),
    )
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
#[cfg(test)]
mod runner_service_tests {
    use super::{process_pattern, repository, runner_service_location};
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
            process_pattern(
                Path::new("/Users/ci/github-runners/repo.one"),
                "Runner.Worker"
            ),
            "/Users/ci/github-runners/repo\\.one/bin/Runner\\.Worker"
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
}
