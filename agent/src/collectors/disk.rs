use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::Shared;

/// Disk breakdown via du: / and ~ first-level trees, with /Applications and
/// ~/Applications each expanded one more level, plus directories declared by plugins.
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

fn du_output(path: &str, depth: u8, key: &Path) -> std::io::Result<std::process::Output> {
    // Loopback SSH avoids launchd I/O throttling when configured. It is optional:
    // missing keys or SSH failures must never turn a readable directory into 0 B.
    if key.is_file() {
        let quoted = path.replace('\'', "'\\''");
        let output = std::process::Command::new("/usr/bin/ssh")
            .arg("-i")
            .arg(key)
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "localhost",
            ])
            .arg(format!("/usr/bin/du -k -x -d {depth} '{quoted}'"))
            .output();
        if let Ok(output) = output {
            if output.status.code() != Some(255) && !output.stdout.is_empty() {
                return Ok(output);
            }
        }
        eprintln!("disk scan: loopback SSH unavailable; using local du");
    }
    std::process::Command::new("/usr/bin/du")
        .args(["-k", "-x", "-d", &depth.to_string(), path])
        .output()
}

/// Parse only direct children; an unsuccessful du marks partial results.
fn du_children(path: &str, depth: u8) -> (Vec<TreeScan>, bool) {
    let key =
        PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".ssh/id_mini_archipel");
    let output = match du_output(path, depth, &key) {
        Ok(output) => output,
        Err(error) => {
            eprintln!("disk scan: du could not start: {error}");
            return (Vec::new(), true);
        }
    };
    let raw = String::from_utf8_lossy(&output.stdout);

    let mut children = Vec::new();
    let prefix = format!("{}/", path.trim_end_matches('/'));
    for line in raw.lines() {
        let Some((size, p)) = line.split_once('\t') else {
            continue;
        };
        let Ok(kib) = size.trim().parse::<u64>() else {
            continue;
        };
        let p = p.trim_matches('\'');
        let Some(rel) = p.strip_prefix(&prefix) else {
            continue;
        };
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
    children.sort_by_key(|entry| std::cmp::Reverse(entry.bytes));
    let partial = !output.status.success();
    (children, partial)
}

fn expand_child(root: &Path, name: &str, expansions: &[PathBuf]) -> bool {
    name == "Applications" || expansions.contains(&root.join(name))
}

fn scan_tree(root_path: &str, expansions: &[PathBuf]) -> TreeScan {
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

    // Built-in application directories and plugin declarations expand exactly one level.
    for child in &mut children {
        if expand_child(Path::new(root_path), &child.root, expansions) {
            let full = Path::new(root_path).join(&child.root);
            let full = full.to_string_lossy();
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

pub async fn run(
    state: Shared,
    roots: Vec<String>,
    interval_ms: u64,
    plugins: Arc<crate::plugins::Manager>,
) {
    if roots.is_empty() {
        return;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    loop {
        // Defer while a real workload is running: retry in 30 minutes.
        if system_busy(&state).await {
            eprintln!("disk scan deferred 30min: CPU busy");
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
            continue;
        }
        let expansions = plugins.disk_expansions().await;
        let slash = scan_tree("/", &expansions);
        eprintln!(
            "disk / : {} bytes in {}ms partial={}",
            slash.bytes, slash.duration_ms, slash.partial
        );
        state
            .write()
            .await
            .disk_scans
            .insert("/".to_string(), slash);

        let user = scan_tree(&home, &expansions);
        eprintln!(
            "disk ~ : {} bytes in {}ms partial={}",
            user.bytes, user.duration_ms, user.partial
        );
        state.write().await.disk_scans.insert("~".to_string(), user);

        let _ = interval_ms; // cadence policy: 6h or manual trigger
        let mut elapsed = 0u64;
        loop {
            if state
                .read()
                .await
                .disk_rescan_flag
                .swap(false, std::sync::atomic::Ordering::Relaxed)
            {
                eprintln!("disk scan: manual trigger received");
                break;
            }
            if elapsed >= 6 * 3600 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            elapsed += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classify, du_output, expand_child};
    use std::path::{Path, PathBuf};

    #[test]
    fn readable_directories_are_scanned_without_a_loopback_ssh_key() {
        let root = std::env::temp_dir().join(format!("disk-scan-{}", std::process::id()));
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(root.join("data/file"), [1u8; 4096]).unwrap();
        let output = du_output(root.to_str().unwrap(), 1, &root.join("missing-key")).unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("/data"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_expansions_apply_only_to_the_declared_directory() {
        let home = Path::new("/Users/test");
        let expansions = vec![home.join("workspaces")];
        assert!(expand_child(home, "workspaces", &expansions));
        assert!(!expand_child(Path::new("/"), "workspaces", &expansions));
        assert!(!expand_child(
            &home.join("workspaces"),
            "project",
            &expansions
        ));
        assert!(!expand_child(home, "workspaces", &[]));
        assert!(expand_child(Path::new("/"), "Applications", &[]));
        assert!(expand_child(home, "Applications", &Vec::<PathBuf>::new()));
    }

    #[test]
    fn app_bundles_are_applications() {
        for name in [
            "ChatGPT.app",
            "ZCode.app",
            "v2rayN.app",
            "Tool.APP",
            "Mixed.aPp",
            "Applications",
        ] {
            assert_eq!(classify(name), "apps", "{name}");
        }
        for name in ["app", "app-data", "app.backup"] {
            assert_eq!(classify(name), "user", "{name}");
        }
    }
}
