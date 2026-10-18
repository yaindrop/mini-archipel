use super::{
    disk_rules::{self, DiskRulesConfig, Rules},
    Shared, SharedState,
};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
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
    #[serde(default)]
    pub children_status: ChildrenStatus,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChildrenStatus {
    #[default]
    Unscanned,
    Complete,
    Partial,
    Unreadable,
    Excluded,
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
    #[serde(default)]
    pub target: Option<String>,
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
pub async fn request(
    state: &Shared,
    roots: &[String],
    target: Option<String>,
) -> Result<ScanJob, crate::plugins::Failure> {
    let target = if let Some(target) = target {
        let roots = roots.to_vec();
        Some(
            tokio::task::spawn_blocking(move || validate_target(&target, &roots))
                .await
                .map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "directory validation failed".into(),
                    )
                })?
                .map_err(|error| (StatusCode::BAD_REQUEST, error))?,
        )
    } else {
        None
    };
    let mut shared = state.write().await;
    if shared.disk_stopping {
        return Err((StatusCode::CONFLICT, "agent is shutting down".into()));
    }
    if shared.disk_scan.active() {
        if shared.disk_scan.target == target {
            return Ok(shared.disk_scan.clone());
        }
        return Err((
            StatusCode::CONFLICT,
            "another directory scan is active".into(),
        ));
    }
    if target.as_ref().is_some_and(|path| {
        !shared
            .disk_scans
            .iter()
            .any(|(base, tree)| find_node(tree, Path::new(base), Path::new(path)).is_some())
    }) {
        return Err((
            StatusCode::BAD_REQUEST,
            "directory is not in the cached tree; scan its parent first".into(),
        ));
    }
    let mut job = queued();
    job.id = job.id.max(shared.disk_scan.id.saturating_add(1));
    job.target = target;
    save(&job, &shared.disk_scans).map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
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

// macOS firmlinks expose the writable Data volume at normal system paths.
// They are part of the configured / view, unlike other mounted filesystems.
fn data_volume(path: &Path) -> bool {
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::statfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
        return false;
    }
    let info = unsafe { info.assume_init() };
    unsafe { std::ffi::CStr::from_ptr(info.f_mntonname.as_ptr()) }.to_bytes()
        == b"/System/Volumes/Data"
}
fn find_node<'a>(tree: &'a TreeScan, base: &Path, target: &Path) -> Option<&'a TreeScan> {
    if base == target {
        return Some(tree);
    }
    tree.children.iter().find_map(|child| {
        let path = base.join(&child.root);
        if target.starts_with(&path) {
            find_node(child, &path, target)
        } else {
            None
        }
    })
}
fn validate_target(target: &str, roots: &[String]) -> Result<String, String> {
    if !target.starts_with('/') || target.len() > 4096 {
        return Err("scan target must be an absolute directory path".into());
    }
    let path = disk_rules::expand(target, Path::new("/"))?;
    if !roots.iter().any(|root| path.starts_with(root)) || path.starts_with("/System/Volumes") {
        return Err("directory is outside the configured scan roots".into());
    }
    let mut current = PathBuf::from("/");
    for component in path.components().skip(1) {
        current.push(component);
        let meta = std::fs::symlink_metadata(&current).map_err(|_| "directory is unavailable")?;
        if meta.file_type().is_symlink() || !meta.is_dir() || disk_rules::bundle(&current) {
            return Err("symlinks, files and bundles cannot be expanded".into());
        }
        if let Some(parent) = current.parent() {
            if std::fs::metadata(parent).is_ok_and(|m| m.dev() != meta.dev())
                && !roots
                    .iter()
                    .any(|root| Path::new(root).starts_with(&current))
                && !data_volume(&current)
            {
                return Err("directory crosses a filesystem mount".into());
            }
        }
    }
    Ok(path.to_string_lossy().into())
}
#[derive(Debug)]
enum ScanError {
    Cancelled,
    Failed(String),
}
async fn du_tree(
    root: &str,
    depth: usize,
    rules: &Rules,
    cancelled: &AtomicBool,
) -> Result<TreeScan, ScanError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(ScanError::Cancelled);
    }
    let started = std::time::Instant::now();
    let mut child = tokio::process::Command::new("/usr/bin/du")
        .args(["-k", "-P", "-x", "-d", &depth.to_string(), root])
        .env("LC_ALL", "C")
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
    let wait_cancelled = async {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    };
    let status = tokio::select! {
        result = child.wait() => result.map_err(|e| ScanError::Failed(e.to_string()))?,
        _ = wait_cancelled => {
            let _ = child.kill().await;
            let _ = output.await; let _ = errors.await;
            return Err(ScanError::Cancelled);
        }
    };
    let raw = output
        .await
        .map_err(|e| ScanError::Failed(e.to_string()))?
        .map_err(|e| ScanError::Failed(e.to_string()))?;
    let errors = errors
        .await
        .map_err(|e| ScanError::Failed(e.to_string()))?
        .map_err(|e| ScanError::Failed(e.to_string()))?;
    if raw.is_empty() {
        return Err(ScanError::Failed(
            "directory scan returned no readable data".into(),
        ));
    }
    let parse_root = root.to_string();
    let parse_rules = rules.clone();
    let mut tree = tokio::task::spawn_blocking(move || {
        parse_tree(
            &parse_root,
            &String::from_utf8_lossy(&raw),
            &String::from_utf8_lossy(&errors),
            depth,
            &parse_rules,
        )
    })
    .await
    .map_err(|e| ScanError::Failed(e.to_string()))??;
    tree.partial |= !status.success();
    if tree.partial && tree.children_status == ChildrenStatus::Complete {
        tree.children_status = ChildrenStatus::Partial;
    }
    tree.duration_ms = started.elapsed().as_millis() as u64;
    Ok(tree)
}
fn parse_tree(
    root: &str,
    raw: &str,
    errors: &str,
    depth: usize,
    rules: &Rules,
) -> Result<TreeScan, ScanError> {
    let root_path = Path::new(root);
    let ts = now();
    let mut entries = HashMap::<PathBuf, TreeScan>::new();
    for line in raw.lines() {
        let Some((size, full)) = line.split_once('\t') else {
            continue;
        };
        let Ok(kib) = size.parse::<u64>() else {
            continue;
        };
        let path = PathBuf::from(full);
        let Ok(relative) = path.strip_prefix(root_path) else {
            continue;
        };
        let level = relative.components().count();
        if level > depth {
            continue;
        }
        let class = rules.class(&path);
        entries.insert(
            path.clone(),
            TreeScan {
                root: if level == 0 {
                    root.into()
                } else {
                    path.file_name().unwrap().to_string_lossy().into()
                },
                class: class.into(),
                bytes: kib.saturating_mul(1024),
                children: Vec::new(),
                ts,
                duration_ms: 0,
                partial: false,
                children_status: if level < depth {
                    ChildrenStatus::Complete
                } else {
                    ChildrenStatus::Unscanned
                },
                error: None,
            },
        );
    }
    if !entries.contains_key(root_path) {
        return Err(ScanError::Failed(
            "directory scan returned no root total".into(),
        ));
    }
    // Attribute errors to the affected path and its ancestors; permission failure is never an empty directory.
    for line in errors.lines() {
        let Some((full, error)) = line.strip_prefix("du: ").and_then(|s| s.rsplit_once(": "))
        else {
            continue;
        };
        let path = PathBuf::from(full);
        if !path.starts_with(root_path) {
            continue;
        }
        if path.strip_prefix(root_path).unwrap().components().count() <= depth
            && !entries.contains_key(&path)
        {
            entries.insert(
                path.clone(),
                TreeScan {
                    root: path
                        .file_name()
                        .map_or_else(|| root.into(), |s| s.to_string_lossy().into()),
                    class: rules.class(&path).into(),
                    bytes: 0,
                    children: vec![],
                    ts,
                    duration_ms: 0,
                    partial: true,
                    children_status: ChildrenStatus::Unreadable,
                    error: Some(error.into()),
                },
            );
        }
        for ancestor in path.ancestors().take_while(|a| a.starts_with(root_path)) {
            if let Some(node) = entries.get_mut(ancestor) {
                node.partial = true;
                node.children_status = if ancestor == path {
                    ChildrenStatus::Unreadable
                } else {
                    ChildrenStatus::Partial
                };
                if ancestor == path {
                    node.error = Some(error.into());
                }
            }
        }
    }
    // APFS's Data-volume view duplicates /Users, /Library, etc. Keep one representation.
    let volumes = Path::new("/System/Volumes");
    if let Some(duplicate) = entries.get(volumes).map(|n| n.bytes) {
        for ancestor in volumes.ancestors().skip(1) {
            if let Some(node) = entries.get_mut(ancestor) {
                node.bytes = node.bytes.saturating_sub(duplicate);
            }
        }
        entries.retain(|path, _| !path.starts_with(volumes));
    }
    let mut paths = entries.keys().cloned().collect::<Vec<_>>();
    paths.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for path in paths {
        if path == root_path {
            continue;
        }
        let mut entry = entries.remove(&path).unwrap();
        if disk_rules::bundle(&path) {
            entry.children.clear();
            entry.children_status = ChildrenStatus::Excluded;
        } else if rules.depth(&path) == 0 {
            entry.children.clear();
            if !matches!(entry.children_status, ChildrenStatus::Unreadable) {
                entry.children_status = ChildrenStatus::Unscanned;
            }
        }
        if let Some(parent) = path.parent().and_then(|p| entries.get_mut(p)) {
            parent.children.push(entry);
        }
    }
    let mut tree = entries.remove(root_path).unwrap();
    sort_tree(&mut tree);
    Ok(tree)
}
fn sort_tree(tree: &mut TreeScan) {
    tree.children
        .sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.root.cmp(&b.root)));
    for child in &mut tree.children {
        sort_tree(child);
    }
}
fn reclassify(tree: &mut TreeScan, path: &Path, rules: &Rules) {
    tree.class = rules.class(path).into();
    for child in &mut tree.children {
        reclassify(child, &path.join(&child.root), rules);
    }
}
fn preserve_children(new: &mut TreeScan, old: &TreeScan) {
    if matches!(
        new.children_status,
        ChildrenStatus::Unscanned | ChildrenStatus::Unreadable
    ) && !matches!(
        old.children_status,
        ChildrenStatus::Unscanned | ChildrenStatus::Excluded
    ) {
        new.children = old.children.clone();
        if new.children_status == ChildrenStatus::Unreadable {
            new.bytes = old.bytes;
        } else {
            new.children_status = old.children_status.clone();
        }
        // Child listings keep their original timestamps until their own scan completes.
    } else {
        for child in &mut new.children {
            if let Some(previous) = old.children.iter().find(|n| n.root == child.root) {
                preserve_children(child, previous);
            }
        }
    }
}
fn replace_subtree(
    tree: &mut TreeScan,
    base: &Path,
    target: &Path,
    replacement: &TreeScan,
) -> bool {
    if base == target {
        let mut fresh = replacement.clone();
        fresh.root = tree.root.clone();
        preserve_children(&mut fresh, tree);
        *tree = fresh;
        return true;
    }
    for child in &mut tree.children {
        let path = base.join(&child.root);
        if target.starts_with(&path) {
            let old_size = child.bytes;
            if replace_subtree(child, &path, target, replacement) {
                tree.bytes = tree
                    .bytes
                    .saturating_sub(old_size)
                    .saturating_add(child.bytes);
                return true;
            }
        }
    }
    false
}
async fn execute(state: &Shared, roots: &[String], rules: &Rules) {
    let (id, target, cancelled) = {
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
        (
            shared.disk_scan.id,
            shared.disk_scan.target.clone(),
            Arc::clone(&shared.disk_cancel),
        )
    };
    let selected = target
        .clone()
        .map_or_else(|| roots.to_vec(), |path| vec![path]);
    let mut result = Ok(HashMap::new());
    for root in &selected {
        {
            let mut shared = state.write().await;
            shared.disk_scan.current_root = Some(root.clone());
            if let Err(error) = save(&shared.disk_scan, &shared.disk_scans) {
                eprintln!("{error}");
            }
        }
        let depth = if target.is_some() {
            1
        } else {
            rules.output_depth(Path::new(root), roots)
        };
        match du_tree(root, depth, rules, &cancelled).await {
            Ok(scan) if scan.children_status == ChildrenStatus::Unreadable => {
                result = Err(ScanError::Failed(
                    "directory is not readable; previous results retained".into(),
                ));
                break;
            }
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
    let mut job = shared.disk_scan.clone();
    job.finished_at = Some(now());
    job.current_root = None;
    let replacement = match result {
        Ok(scans) if !cancelled.load(Ordering::Relaxed) => {
            let mut replacement = shared.disk_scans.clone();
            for (path, scan) in scans {
                if target.is_some() {
                    let mut found = false;
                    for (base, tree) in &mut replacement {
                        found |= replace_subtree(tree, Path::new(base), Path::new(&path), &scan);
                    }
                    if !found {
                        job.error = Some(
                            "directory is no longer in the cached tree; rescan its parent".into(),
                        );
                    }
                } else {
                    let mut scan = scan;
                    if let Some(old) = replacement.get(&path) {
                        preserve_children(&mut scan, old);
                    }
                    replacement.insert(path, scan);
                }
            }
            for (base, tree) in &mut replacement {
                reclassify(tree, Path::new(base), rules);
            }
            job.status = if job.error.is_some() {
                ScanStatus::Failed
            } else {
                ScanStatus::Completed
            };
            if job.error.is_some() {
                None
            } else {
                Some(replacement)
            }
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
    config: DiskRulesConfig,
    plugins: Arc<crate::plugins::Manager>,
) {
    if roots.is_empty() {
        return;
    }
    let latest = {
        let shared = state.read().await;
        roots
            .iter()
            .map(|root| shared.disk_scans.get(root).map_or(0, |scan| scan.ts))
            .min()
            .unwrap_or(0)
    };
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
            let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
            let rules = Rules::new(&config, &home, &plugins.disk_expansions().await)
                .expect("validated directory rules");
            execute(&state, &roots, &rules).await;
            if state.read().await.disk_scan.target.is_none() {
                next = now().saturating_add(interval_ms);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rules() -> Rules {
        Rules::new(&DiskRulesConfig::default(), Path::new("/Users/test"), &[]).unwrap()
    }
    #[test]
    fn scoped_classes_empty_directories_errors_and_apfs_are_distinct() {
        let tree = parse_tree("/", "80\t/System/Volumes\n20\t/System/Library\n100\t/System\n0\t/Library/Caches/Empty\n0\t/Library/Caches\n8\t/Library/Application Support\n8\t/Library\n80\t/Users/test\n80\t/Users\n12\t/opt/homebrew/Cellar\n12\t/opt/homebrew\n12\t/opt\n200\t/\n", "du: /Library/Caches/Protected: Operation not permitted\n", 3, &rules()).unwrap();
        let system = tree.children.iter().find(|n| n.root == "System").unwrap();
        assert_eq!(system.bytes, 20 * 1024);
        assert!(system.children.iter().all(|n| n.root != "Volumes"));
        assert_eq!(tree.bytes, 120 * 1024);
        let library = tree.children.iter().find(|n| n.root == "Library").unwrap();
        let caches = library
            .children
            .iter()
            .find(|n| n.root == "Caches")
            .unwrap();
        assert!(caches.partial);
        assert_eq!(
            caches
                .children
                .iter()
                .find(|n| n.root == "Protected")
                .unwrap()
                .children_status,
            ChildrenStatus::Unreadable
        );
        assert_eq!(
            caches
                .children
                .iter()
                .find(|n| n.root == "Empty")
                .unwrap()
                .bytes,
            0
        );
        assert!(!system.partial);
        assert_eq!(
            tree.children
                .iter()
                .find(|n| n.root == "opt")
                .unwrap()
                .children[0]
                .class,
            "toolchain"
        );
        assert_eq!(
            library
                .children
                .iter()
                .find(|n| n.root == "Application Support")
                .unwrap()
                .class,
            "appdata"
        );
    }
    #[tokio::test]
    async fn native_subtree_scan_is_cancellable_and_preserves_deeper_cache() {
        let root = std::env::temp_dir().join(format!("disk-lazy-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Library/Caches/item/deeper")).unwrap();
        std::fs::create_dir_all(root.join("Applications/Tool.app/Contents")).unwrap();
        std::fs::write(root.join("Library/Caches/item/deeper/file"), [1u8; 4096]).unwrap();
        let root = root.canonicalize().unwrap();
        let rules = Rules::new(&DiskRulesConfig::default(), &root, &[]).unwrap();
        let flag = AtomicBool::new(false);
        let mut tree = du_tree(root.to_str().unwrap(), 3, &rules, &flag)
            .await
            .unwrap();
        let caches = root.join("Library/Caches");
        let lazy = du_tree(caches.to_str().unwrap(), 1, &rules, &flag)
            .await
            .unwrap();
        assert!(replace_subtree(&mut tree, &root, &caches, &lazy));
        let mut denied = lazy.clone();
        denied.bytes = 0;
        denied.children.clear();
        denied.partial = true;
        denied.children_status = ChildrenStatus::Unreadable;
        preserve_children(&mut denied, &lazy);
        assert_eq!(denied.children_status, ChildrenStatus::Unreadable);
        assert_eq!(denied.bytes, lazy.bytes);
        assert_eq!(denied.children.len(), lazy.children.len());
        let item = caches.join("item");
        let deeper = du_tree(item.to_str().unwrap(), 1, &rules, &flag)
            .await
            .unwrap();
        assert!(replace_subtree(&mut tree, &root, &item, &deeper));
        let mut refreshed = du_tree(root.to_str().unwrap(), 3, &rules, &flag)
            .await
            .unwrap();
        preserve_children(&mut refreshed, &tree);
        let app = refreshed
            .children
            .iter()
            .find(|n| n.root == "Applications")
            .unwrap();
        assert_eq!(app.children[0].children_status, ChildrenStatus::Excluded);
        assert!(app.children[0].children.is_empty());
        assert_eq!(
            refreshed
                .children
                .iter()
                .find(|n| n.root == "Library")
                .unwrap()
                .children[0]
                .children[0]
                .children[0]
                .root,
            "deeper"
        );
        let roots = vec![root.to_string_lossy().into()];
        assert!(validate_target(item.to_str().unwrap(), &roots).is_ok());
        assert!(validate_target("/etc", &roots).is_err());
        std::os::unix::fs::symlink(&item, root.join("link")).unwrap();
        assert!(validate_target(root.join("link").to_str().unwrap(), &roots).is_err());
        assert!(
            validate_target(root.join("Applications/Tool.app").to_str().unwrap(), &roots).is_err()
        );
        flag.store(true, Ordering::Relaxed);
        assert!(matches!(
            du_tree(root.to_str().unwrap(), 1, &rules, &flag).await,
            Err(ScanError::Cancelled)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
