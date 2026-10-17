use serde::Serialize;

use sysinfo::{Disks, ProcessesToUpdate, System};

use super::Shared;

#[derive(Serialize, Clone)]
pub struct SysInfo {
    pub cpu: CpuInfo,
    pub mem: MemInfo,
    pub disks: Vec<DiskInfo>,
    pub procs: Vec<ProcInfo>,
    pub ts: u64,
}

#[derive(Serialize, Clone)]
pub struct CpuInfo {
    pub usage_pct: f32,
    pub cores: Vec<f32>,
}

#[derive(Serialize, Clone)]
pub struct MemInfo {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct DiskInfo {
    pub mount: String,
    pub fs: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_pct: f32,
    pub mem_bytes: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

const TOP_COUNT: usize = 15;

pub async fn run(state: Shared, proc_interval_ms: u64) {
    let mut sys = System::new();
    let mut disks = Disks::new_with_refreshed_list();
    let mut last_proc_refresh = 0u64;
    // CPU usage needs two refresh points; warm up before the first publish.
    sys.refresh_cpu_usage();
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;

    loop {
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        disks.refresh(true);

        let cpu = CpuInfo {
            usage_pct: sys.global_cpu_usage(),
            cores: sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
        };

        let mem = MemInfo {
            total_bytes: sys.total_memory(),
            used_bytes: sys.used_memory(),
            available_bytes: sys.available_memory(),
            swap_total_bytes: sys.total_swap(),
            swap_used_bytes: sys.used_swap(),
        };

        let disk_list: Vec<DiskInfo> = disks
            .list()
            .iter()
            .map(|d| DiskInfo {
                mount: d.mount_point().to_string_lossy().to_string(),
                fs: d.file_system().to_string_lossy().to_string(),
                total_bytes: d.total_space(),
                available_bytes: d.available_space(),
            })
            .collect();

        let now = now_unix();
        let mut procs: Vec<ProcInfo> = Vec::new();
        if now - last_proc_refresh >= proc_interval_ms {
            sys.refresh_processes(ProcessesToUpdate::All, true);
            let mut collected: Vec<ProcInfo> = sys
                .processes()
                .iter()
                .map(|(pid, p)| ProcInfo {
                    pid: pid.as_u32(),
                    name: p.name().to_string_lossy().to_string(),
                    cpu_pct: p.cpu_usage(),
                    mem_bytes: p.memory(),
                })
                .collect();
            collected.sort_by(|a, b| {
                b.cpu_pct
                    .partial_cmp(&a.cpu_pct)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            collected.truncate(TOP_COUNT);
            procs = collected;
            last_proc_refresh = now;
        } else if let Some(existing) = &state.read().await.sys {
            procs = existing.procs.clone();
        }

        state.write().await.sys = Some(SysInfo {
            cpu,
            mem,
            disks: disk_list,
            procs,
            ts: now,
        });

        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
}
