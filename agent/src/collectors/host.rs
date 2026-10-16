use serde::Serialize;
use sysinfo::System;

use super::Shared;

#[derive(Serialize, Clone)]
pub struct HostInfo {
    pub name: String,
    pub model: String,
    pub os: String,
    pub arch: String,
    pub cores: usize,
    pub memory_bytes: u64,
    pub uptime_s: u64,
    pub load: [f32; 3],
    pub ts: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn model_identifier() -> String {
    std::process::Command::new("sysctl")
        .arg("-n")
        .arg("hw.model")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

pub async fn run(state: Shared) {
    let mut sys = System::new();
    loop {
        sys.refresh_memory();
        let load = System::load_average();
        let info = HostInfo {
            name: System::host_name().unwrap_or_else(|| "unknown".into()),
            model: model_identifier(),
            os: System::long_os_version().unwrap_or_else(|| "unknown".into()),
            arch: std::env::consts::ARCH.to_string(),
            cores: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(0),
            memory_bytes: sys.total_memory(),
            uptime_s: System::uptime(),
            load: [load.one as f32, load.five as f32, load.fifteen as f32],
            ts: now_unix(),
        };
        state.write().await.host = Some(info);
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}
