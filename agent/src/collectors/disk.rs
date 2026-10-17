use super::{Shared, SharedState};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::io::AsyncReadExt;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TreeScan {
    pub root: String,
    pub class: String,
    pub bytes: u64,
    pub children: Vec<TreeScan>,
    pub ts: u64,
    pub duration_ms: u64,
    pub partial: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScanStatus {
    #[default]
    Idle,
    Queued,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ScanJob {
    pub id: u64,
    pub status: ScanStatus,
    pub requested_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub current_root: Option<String>,
    pub error: Option<String>,
}
impl ScanJob {
    fn active(&self) -> bool {
        matches!(
            self.status,
            ScanStatus::Queued | ScanStatus::Running | ScanStatus::Cancelling
        )
    }
}

#[derive(Serialize, Deserialize)]
struct Cache {
    job: ScanJob,
    scans: HashMap<String, TreeScan>,
}
fn cache_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join(".local/share/mini-archipel/disk-scan.json")
}
fn save(job: &ScanJob, scans: &HashMap<String, TreeScan>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = cache_path();
    let temp = path.with_extension("json.next");
    let result = (|| {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec(&Cache {
            job: job.clone(),
            scans: scans.clone(),
        })?)?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)
    })();
    result.map_err(|_: std::io::Error| "could not save disk scan state".to_string())
}
pub fn restore(state: &mut SharedState) {
    if let Ok(raw) = std::fs::read(cache_path()) {
        if let Ok(mut cache) = serde_json::from_slice::<Cache>(&raw) {
            if cache.job.active() {
                cache.job.status = ScanStatus::Interrupted;
                cache.job.finished_at = Some(now());
                cache.job.current_root = None;
            }
            state.disk_scans = cache.scans;
            state.disk_scan = cache.job;
            if let Err(error) = save(&state.disk_scan, &state.disk_scans) {
                eprintln!("{error}");
            }
        }
    }
}
fn now() -> u64 {
    crate::plugins::now()
}
fn queued() -> ScanJob {
    ScanJob {
        id: now(),
        status: ScanStatus::Queued,
        requested_at: now(),
        ..Default::default()
    }
}
pub async fn request(state: &Shared) -> Result<ScanJob, String> {
    let mut shared = state.write().await;
    if shared.disk_stopping {
        return Err("agent is shutting down".into());
    }
    if shared.disk_scan.active() {
        return Ok(shared.disk_scan.clone());
    }
    let mut job = queued();
    job.id = job.id.max(shared.disk_scan.id.saturating_add(1));
    save(&job, &shared.disk_scans)?;
    shared.disk_cancel.store(false, Ordering::Relaxed);
    shared.disk_rescan_flag.store(true, Ordering::Relaxed);
    shared.disk_scan = job.clone();
    Ok(job)
}
pub async fn cancel(state: &Shared, id: u64) -> Result<ScanJob, crate::plugins::Failure> {
    let mut shared = state.write().await;
    if shared.disk_scan.id != id {
        return Err((
            StatusCode::CONFLICT,
            "scan changed; refresh before cancelling".into(),
        ));
    }
    if !shared.disk_scan.active() {
        return Ok(shared.disk_scan.clone());
    }
    let mut job = shared.disk_scan.clone();
    job.status = ScanStatus::Cancelling;
    save(&job, &shared.disk_scans).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    shared.disk_cancel.store(true, Ordering::Relaxed);
    shared.disk_scan = job.clone();
    Ok(job)
}

fn classify(name: &str) -> &'static str {
    if name.to_ascii_lowercase().ends_with(".app") {
        return "apps";
    }
    match name {
        // System: OS components, untouchable
        "System" | "usr" | "bin" | "sbin" | "private" | "etc" | "var" | "Volumes" | "dev"
        | ".resolve" | ".vol" | ".nofollow" | "cores" | "pkg" | "home" | "tmp" => "system",
        // Apps: installed software
        "Applications" => "apps",
        // Agentic: AI assistant data (same color as toolchain)
        ".codex" | ".zcode" => "agentic",
        // Toolchain: re-downloadable but slow
        ".rustup" | ".cargo" | ".local" => "toolchain",
        // User config/infra: deliberate user-created dirs in home
        ".ssh" | ".config" | ".zsh_sessions" | ".docker" | ".colima" => "user",
        // Library: mixed system/user
        "Library" => "library",
        // Reclaimable: purely rebuildable caches
        "opt" | ".cache" | "node_modules" | ".pnpm-store" | "Caches" | "target" | ".venv"
        | "test-results" => "reclaimable",
        _ => "user", // default: user-created content in home
    }
}

#[derive(Debug)]
enum ScanError {
    Cancelled,
    Failed(String),
}
async fn du_children(
    path: &str,
    cancelled: &AtomicBool,
) -> Result<(Vec<TreeScan>, bool), ScanError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(ScanError::Cancelled);
    }
    let mut child = tokio::process::Command::new("/usr/bin/du")
        .args(["-k", "-x", "-d", "1", path])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| ScanError::Failed(e.to_string()))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let output = tokio::spawn(async move {
        let mut raw = Vec::new();
        stdout.read_to_end(&mut raw).await.map(|_| raw)
    });
    let errors = tokio::spawn(async move {
        let mut raw = Vec::new();
        stderr.read_to_end(&mut raw).await.map(|_| raw)
    });
    let cancelled_wait = async {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    };
    let status = tokio::select! {
        result = child.wait() => result.map_err(|e| ScanError::Failed(e.to_string()))?,
        _ = cancelled_wait => {
            let _ = child.kill().await;
            let _ = output.await;
            let _ = errors.await;
            return Err(ScanError::Cancelled);
        }
    };
    let raw = output
        .await
        .map_err(|e| ScanError::Failed(e.to_string()))?
        .map_err(|e| ScanError::Failed(e.to_string()))?;
    let _ = errors.await;
    if raw.is_empty() {
        return Err(ScanError::Failed(
            "directory scan returned no readable data".into(),
        ));
    }
    let children = parse_children(path, &String::from_utf8_lossy(&raw));
    if !status.success() && children.is_empty() {
        return Err(ScanError::Failed(
            "directory scan returned no readable directories".into(),
        ));
    }
    Ok((children, !status.success()))
}
fn parse_children(path: &str, raw: &str) -> Vec<TreeScan> {
    let prefix = format!("{}/", path.trim_end_matches('/'));
    let mut children = Vec::new();
    for line in raw.lines() {
        let Some((size, full)) = line.split_once('\t') else {
            continue;
        };
        let Ok(kib) = size.parse::<u64>() else {
            continue;
        };
        let Some(name) = full.strip_prefix(&prefix) else {
            continue;
        };
        if name.is_empty() || name.contains('/') || kib == 0 {
            continue;
        }
        children.push(TreeScan {
            root: name.into(),
            class: classify(name).into(),
            bytes: kib.saturating_mul(1024),
            children: Vec::new(),
            ts: 0,
            duration_ms: 0,
            partial: false,
        });
    }
    children.sort_by_key(|c| std::cmp::Reverse(c.bytes));
    children
}
fn expand_child(root: &Path, name: &str, expansions: &[PathBuf]) -> bool {
    name == "Applications" || expansions.contains(&root.join(name))
}
async fn scan_tree(
    root: &str,
    expansions: &[PathBuf],
    cancelled: &AtomicBool,
) -> Result<TreeScan, ScanError> {
    let started = std::time::Instant::now();
    let (mut children, mut partial) = du_children(root, cancelled).await?;
    if root == "/" {
        if let Some(system) = children.iter_mut().find(|c| c.root == "System") {
            let (volumes, sub_partial) = du_children("/System", cancelled).await?;
            if let Some(volume) = volumes.iter().find(|c| c.root == "Volumes") {
                system.bytes = system.bytes.saturating_sub(volume.bytes);
                system.partial = true;
            }
            partial |= sub_partial;
        }
    }
    for child in &mut children {
        if expand_child(Path::new(root), &child.root, expansions) {
            let full = Path::new(root).join(&child.root);
            let (sub, sub_partial) = du_children(&full.to_string_lossy(), cancelled).await?;
            child.children = sub;
            child.partial = sub_partial;
            partial |= sub_partial;
        }
    }
    Ok(TreeScan {
        root: root.into(),
        class: "root".into(),
        bytes: children.iter().map(|c| c.bytes).sum(),
        children,
        ts: now(),
        duration_ms: started.elapsed().as_millis() as u64,
        partial,
    })
}
async fn execute(state: &Shared, roots: &[String], expansions: &[PathBuf]) {
    let (id, cancelled) = {
        let mut shared = state.write().await;
        if shared.disk_stopping {
            return;
        }
        if shared.disk_scan.status == ScanStatus::Cancelling {
            shared.disk_scan.status = ScanStatus::Cancelled;
            shared.disk_scan.finished_at = Some(now());
            if let Err(error) = save(&shared.disk_scan, &shared.disk_scans) {
                eprintln!("{error}");
            }
            return;
        }
        if shared.disk_scan.status != ScanStatus::Queued {
            shared.disk_scan = queued();
        }
        shared.disk_cancel.store(false, Ordering::Relaxed);
        shared.disk_scan.status = ScanStatus::Running;
        shared.disk_scan.started_at = Some(now());
        if let Err(error) = save(&shared.disk_scan, &shared.disk_scans) {
            eprintln!("{error}");
        }
        (shared.disk_scan.id, Arc::clone(&shared.disk_cancel))
    };
    let mut result = Ok(HashMap::new());
    for root in roots {
        {
            let mut shared = state.write().await;
            shared.disk_scan.current_root = Some(root.clone());
            if let Err(error) = save(&shared.disk_scan, &shared.disk_scans) {
                eprintln!("{error}");
            }
        }
        match scan_tree(root, expansions, &cancelled).await {
            Ok(scan) => {
                result.as_mut().unwrap().insert(root.clone(), scan);
            }
            Err(error) => {
                result = Err(error);
                break;
            }
        }
    }
    let mut shared = state.write().await;
    if shared.disk_scan.id != id {
        return;
    }
    shared.disk_scan.finished_at = Some(now());
    shared.disk_scan.current_root = None;
    let mut job = shared.disk_scan.clone();
    let replacement = match result {
        Ok(scans) if !cancelled.load(Ordering::Relaxed) => {
            job.status = ScanStatus::Completed;
            Some(scans)
        }
        Ok(_) | Err(ScanError::Cancelled) => {
            job.status = ScanStatus::Cancelled;
            None
        }
        Err(ScanError::Failed(error)) => {
            job.status = ScanStatus::Failed;
            job.error = Some(error);
            None
        }
    };
    match save(&job, replacement.as_ref().unwrap_or(&shared.disk_scans)) {
        Ok(()) => {
            if let Some(scans) = replacement {
                shared.disk_scans = scans;
            }
        }
        Err(error) => {
            job.status = ScanStatus::Failed;
            job.error = Some(error);
        }
    }
    shared.disk_scan = job;
}
pub async fn shutdown(state: &Shared) {
    let id = {
        let mut shared = state.write().await;
        shared.disk_stopping = true;
        if !shared.disk_scan.active() {
            return;
        }
        shared.disk_cancel.store(true, Ordering::Relaxed);
        shared.disk_scan.id
    };
    // Let the owned child be killed and reaped before the runtime exits.
    for _ in 0..40 {
        if !state.read().await.disk_scan.active() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let mut shared = state.write().await;
    if shared.disk_scan.id == id {
        shared.disk_scan.status = ScanStatus::Interrupted;
        shared.disk_scan.finished_at = Some(now());
        shared.disk_scan.current_root = None;
        if let Err(error) = save(&shared.disk_scan, &shared.disk_scans) {
            eprintln!("{error}");
        }
    }
}
pub async fn run(
    state: Shared,
    roots: Vec<String>,
    interval_ms: u64,
    plugins: Arc<crate::plugins::Manager>,
) {
    if roots.is_empty() {
        return;
    }
    let latest = state
        .read()
        .await
        .disk_scans
        .values()
        .map(|s| s.ts)
        .max()
        .unwrap_or(0);
    let mut next = latest.saturating_add(interval_ms);
    loop {
        if state.read().await.disk_stopping {
            return;
        }
        let requested = state
            .read()
            .await
            .disk_rescan_flag
            .swap(false, Ordering::Relaxed);
        if requested || now() >= next {
            let expansions = plugins.disk_expansions().await;
            execute(&state, &roots, &expansions).await;
            next = now().saturating_add(interval_ms);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_bundles_are_applications() {
        for name in ["ChatGPT.app", "Tool.APP", "Mixed.aPp", "Applications"] {
            assert_eq!(classify(name), "apps");
        }
    }
    #[test]
    fn plugin_expansions_apply_only_to_declared_directories() {
        let home = Path::new("/Users/test");
        let declared = vec![home.join("workspaces")];
        assert!(expand_child(home, "workspaces", &declared));
        assert!(!expand_child(Path::new("/"), "workspaces", &declared));
        assert!(!expand_child(
            &home.join("workspaces"),
            "project",
            &declared
        ));
        assert!(!expand_child(home, "workspaces", &[]));
        assert!(expand_child(home, "Applications", &[]));
    }
    #[tokio::test]
    async fn native_scans_are_cancellable_and_do_not_need_ssh() {
        let root = std::env::temp_dir().join(format!("disk-scan-{}", std::process::id()));
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(root.join("data/file"), [1u8; 4096]).unwrap();
        let flag = AtomicBool::new(false);
        let (children, partial) = du_children(root.to_str().unwrap(), &flag).await.unwrap();
        assert!(!partial && children.iter().any(|c| c.root == "data"));
        flag.store(true, Ordering::Relaxed);
        assert!(matches!(
            du_children(root.to_str().unwrap(), &flag).await,
            Err(ScanError::Cancelled)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
