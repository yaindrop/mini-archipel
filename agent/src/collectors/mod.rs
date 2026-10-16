pub mod disk;
pub mod fan;
pub mod host;
pub mod runner;
pub mod macmon;
pub mod sys;
pub mod thermal;

use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;

use super::config::CollectorConfig;

#[derive(Default)]
pub struct SharedState {
    pub host: Option<host::HostInfo>,
    pub sys: Option<sys::SysInfo>,
    pub macmon: Option<macmon::MacmonSample>,
    pub thermal: Option<thermal::ThermalInfo>,
    pub fan: Option<serde_json::Value>,
    pub disk_scans: std::collections::HashMap<String, disk::TreeScan>,
    pub disk_rescan_flag: std::sync::atomic::AtomicBool,
    pub runners: Vec<runner::RunnerInstall>,
    pub started_at: u64,
}

impl SharedState {
    pub fn new() -> Self {
        Self {
            started_at: now_unix(),
            disk_rescan_flag: std::sync::atomic::AtomicBool::new(false),
            ..Default::default()
        }
    }

    pub fn render(&self) -> Snapshot {
        Snapshot {
            agent: AgentInfo {
                version: env!("CARGO_PKG_VERSION"),
                started_at: self.started_at,
                ts: now_unix(),
            },
            host: self.host.clone(),
            sys: self.sys.clone(),
            macmon: self.macmon.clone(),
            thermal: self.thermal.clone(),
            fan: self.fan.clone(),
            disk_scans: self.disk_scans.values().cloned().collect(),
            runners: self.runners.clone(),
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
pub struct Snapshot {
    pub agent: AgentInfo,
    pub host: Option<host::HostInfo>,
    pub sys: Option<sys::SysInfo>,
    pub macmon: Option<macmon::MacmonSample>,
    pub thermal: Option<thermal::ThermalInfo>,
    pub fan: Option<serde_json::Value>,
    pub disk_scans: Vec<disk::TreeScan>,
    pub runners: Vec<runner::RunnerInstall>,
}

#[derive(Serialize)]
pub struct AgentInfo {
    pub version: &'static str,
    pub started_at: u64,
    pub ts: u64,
}

pub type Shared = Arc<RwLock<SharedState>>;

pub async fn spawn_all(state: Shared, config: CollectorConfig) {
    let host_state = Arc::clone(&state);
    tokio::spawn(async move { host::run(host_state).await });

    let sys_state = Arc::clone(&state);
    let proc_interval = config.proc_interval_ms;
    tokio::spawn(async move { sys::run(sys_state, proc_interval).await });

    let macmon_state = Arc::clone(&state);
    let macmon_path = config.macmon.clone();
    tokio::spawn(async move { macmon::run(macmon_state, macmon_path).await });

    let thermal_state = Arc::clone(&state);
    let thermal_interval = config.thermal_interval_ms;
    tokio::spawn(async move { thermal::run(thermal_state, thermal_interval).await });

    let fan_state = Arc::clone(&state);
    let fan_interval = config.fan_interval_ms;
    let fanctl = config.fanctl.clone();
    tokio::spawn(async move { fan::run(fan_state, fanctl, fan_interval).await });

    let disk_state = Arc::clone(&state);
    let roots = config.disk_roots.clone();
    let disk_interval = config.disk_interval_ms;
    tokio::spawn(async move { disk::run(disk_state, roots, disk_interval).await });

    let runner_state = Arc::clone(&state);
    let runner_interval = config.runner_interval_ms;
    tokio::spawn(async move { runner::run(runner_state, runner_interval).await });
}
