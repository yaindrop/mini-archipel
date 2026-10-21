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
    let mut model = [0u8; 256];
    let mut size = model.len();
    // SAFETY: live output buffer and size; null newp makes this a read-only query.
    let result = unsafe {
        libc::sysctlbyname(
            c"hw.model".as_ptr(),
            model.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return "unknown".into();
    }
    // Avoid subprocess pipes: a concurrently spawned long-lived child can retain them.
    std::ffi::CStr::from_bytes_until_nul(&model)
        .ok()
        .and_then(|name| name.to_str().ok())
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_owned()
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
