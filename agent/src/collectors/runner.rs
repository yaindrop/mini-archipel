use serde::Serialize;
use std::path::PathBuf;

use super::Shared;

/// GitHub Actions self-hosted runner discovery under ~/github-runners/<repo>.
#[derive(Serialize, Clone, Debug)]
pub struct RunnerInstall {
    pub repo_dir: String,
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

fn dir_size(path: &PathBuf) -> Option<u64> {
    let mut total = 0u64;
    let mut stack = vec![path.clone()];
    while let Some(dir) = stack.pop() {
        let read = std::fs::read_dir(&dir).ok()?;
        for entry in read.filter_map(|e| e.ok()) {
            let meta = entry.metadata().ok()?;
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Some(total)
}

fn parse_runner_file(path: &PathBuf) -> (Option<String>, Option<u64>, Option<String>) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return (None, None, None);
    };
    // GitHub writes .runner with a UTF-8 BOM; strip it before parsing.
    let trimmed = raw.trim_start_matches('\u{feff}');
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return (None, None, None);
    };
    (
        value.get("agentName").and_then(|v| v.as_str()).map(String::from),
        value.get("agentId").and_then(|v| v.as_u64()),
        value.get("workFolder").and_then(|v| v.as_str()).map(String::from),
    )
}

fn pgrep(pattern: &str) -> Option<u32> {
    let output = std::process::Command::new("pgrep")
        .arg("-f")
        .arg(pattern)
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    text.lines().next().and_then(|line| line.trim().parse().ok())
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

pub async fn run(state: Shared, interval_ms: u64) {
    let base = dirs_home().join("github-runners");
    loop {
        let mut installs: Vec<RunnerInstall> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.filter_map(|e| e.ok()) {
                let repo_dir = entry.path();
                if !repo_dir.is_dir() {
                    continue;
                }
                let repo_name = entry.file_name().to_string_lossy().to_string();
                let (agent_name, agent_id, work_folder) =
                    parse_runner_file(&repo_dir.join(".runner"));
                let listener_pid = pgrep(&format!(
                    "github-runners/{}/bin/Runner.Listener",
                    repo_name
                ));
                let worker_pid = pgrep(&format!(
                    "github-runners/{}/bin/Runner.Worker",
                    repo_name
                ));
                let work_bytes = work_folder
                    .as_ref()
                    .map(|wf| {
                        let p = repo_dir.join(wf);
                        if p.is_dir() { p } else { repo_dir.join(wf.split('/').next_back().unwrap_or(wf)) }
                    })
                    .and_then(|p| dir_size(&p));
                let diag = repo_dir.join("_diag");
                let diag_bytes = dir_size(&diag);
                let diag_latest = latest_diag(&diag);
                installs.push(RunnerInstall {
                    repo_dir: repo_name,
                    agent_name,
                    agent_id,
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
        state.write().await.runners = installs;
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/Users/unknown"))
}
