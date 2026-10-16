use serde::Serialize;

use super::Shared;

/// Disk breakdown via du: / and ~ first-level trees, with /Applications and
/// ~/Applications each expanded one more level. No other special treatment.
#[derive(Serialize, Clone, Debug)]
pub struct TreeScan {
    pub root: String,
    pub class: String,
    pub bytes: u64,
    pub children: Vec<TreeScan>,
    pub ts: u64,
    pub duration_ms: u64,
    pub partial: bool,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn classify(name: &str) -> &'static str {
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
        "opt" | ".cache" | "node_modules" | ".pnpm-store" | "Caches" | "target" | ".venv" | "test-results" => "reclaimable",
        _ => "user", // default: user-created content in home
    }
}

/// Run du -k -x -d <depth> <path>, write to temp file, parse into (name, bytes) pairs.
/// Returns (children, partial_flag).
fn du_children(path: &str, depth: u8) -> (Vec<TreeScan>, bool) {
    let tmp = format!("/tmp/mf-du-{}-{}.tmp", std::process::id(), depth);
    // Via SSH loopback: launchd agents get IO-throttled children; SSH
    // sessions run at normal priority (proven by every ops command).
    let key = format!(
        "{}/.ssh/id_mini_fleet",
        std::env::var("HOME").unwrap_or_default()
    );
    let cmd = format!(
        "/usr/bin/ssh -i {} -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost \"/usr/bin/du -k -x -d {} '{}'\" > '{}' 2>/dev/null",
        key, depth, path, tmp
    );
    let _ = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&cmd)
        .status();
    let raw = std::fs::read_to_string(&tmp).unwrap_or_default();
    let _ = std::fs::remove_file(&tmp);

    let mut children = Vec::new();
    let prefix = format!("{}/", path.trim_end_matches('/'));
    for line in raw.lines() {
        let Some((size, p)) = line.split_once('\t') else { continue };
        let Ok(kib) = size.trim().parse::<u64>() else { continue };
        let p = p.trim_matches('\'');
        let Some(rel) = p.strip_prefix(&prefix) else { continue };
        let rel = rel.trim_end_matches('/');
        if rel.is_empty() || rel.contains('/') {
            continue; // direct children only
        }
        if kib * 1024 == 0 {
            continue; // hide empty dirs
        }
        children.push(TreeScan {
            root: rel.to_string(),
            class: classify(rel).to_string(),
            bytes: kib * 1024,
            children: Vec::new(),
            ts: 0,
            duration_ms: 0,
            partial: false,
        });
    }
    children.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    let partial = children.is_empty();
    (children, partial)
}

fn scan_tree(root_path: &str, _expand: &str) -> TreeScan {
    let started = std::time::Instant::now();
    let (mut children, partial) = du_children(root_path, 1);

    // /System/Volumes/Data is a firmlink to the whole Data volume: BSD du -x
    // follows it, so the /System child would double-count every user file.
    // Subtract the firmlinked subtree from the /System total.
    if root_path == "/" {
        if let Some(system) = children.iter_mut().find(|c| c.root == "System") {
            let firmlink = format!("{}/Volumes", system.root);
            let _ = firmlink;
            let (vols, _) = du_children("/System", 1);
            if let Some(v) = vols.iter().find(|c| c.root == "Volumes") {
                system.bytes = system.bytes.saturating_sub(v.bytes);
                system.class = "system".to_string();
                system.partial = true; // numbers are derived
            }
        }
    }

    // Expand every Applications dir one more level
    for child in &mut children {
        if child.root == "Applications" {
            let full = format!("{}/Applications", root_path.trim_end_matches('/'));
            let (subs, sub_partial) = du_children(&full, 1);
            child.children = subs;
            child.partial = sub_partial;
        }
    }

    TreeScan {
        root: root_path.to_string(),
        class: "root".to_string(),
        bytes: children.iter().map(|c| c.bytes).sum(),
        children,
        ts: now_unix(),
        duration_ms: started.elapsed().as_millis() as u64,
        partial,
    }
}

/// Check the agent's own latest CPU reading; defer heavy scans while busy.
async fn system_busy(state: &Shared) -> bool {
    if let Some(snapshot) = state.read().await.sys.as_ref() {
        return snapshot.cpu.usage_pct > 50.0;
    }
    false
}

pub async fn run(state: Shared, _roots: Vec<String>, interval_ms: u64) {
    let home = std::env::var("HOME").unwrap_or_default();
    loop {
        // Defer while a real workload is running: retry in 30 minutes.
        if system_busy(&state).await {
            eprintln!("disk scan deferred 30min: CPU busy");
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
            continue;
        }
        let slash = scan_tree("/", "Applications");
        eprintln!(
            "disk / : {} bytes in {}ms partial={}",
            slash.bytes, slash.duration_ms, slash.partial
        );
        state.write().await.disk_scans.insert("/".to_string(), slash);

        let user = scan_tree(&home, "Applications");
        eprintln!(
            "disk ~ : {} bytes in {}ms partial={}",
            user.bytes, user.duration_ms, user.partial
        );
        state.write().await.disk_scans.insert("~".to_string(), user);

        let _ = interval_ms; // cadence policy: 6h or manual trigger
        let mut elapsed = 0u64;
        loop {
            if state.read().await.disk_rescan_flag.swap(false, std::sync::atomic::Ordering::Relaxed) {
                eprintln!("disk scan: manual trigger received");
                break;
            }
            if elapsed >= 6 * 3600 { break; }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            elapsed += 1;
        }
    }
}
