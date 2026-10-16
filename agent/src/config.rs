use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub bind: String,
    pub token: String,
    #[serde(default)]
    pub collectors: CollectorConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CollectorConfig {
    /// Top-process refresh cadence; sysinfo cpu/mem/disk run at 1s.
    #[serde(default = "default_proc_interval")]
    pub proc_interval_ms: u64,
    #[serde(default = "default_thermal_interval")]
    pub thermal_interval_ms: u64,
    #[serde(default = "default_fan_interval")]
    pub fan_interval_ms: u64,
    /// macmon binary path; frequency/power metrics are omitted when absent.
    #[serde(default = "default_macmon")]
    pub macmon: String,
    #[serde(default = "default_fanctl")]
    pub fanctl: String,
    #[serde(default = "default_disk_interval")]
    pub disk_interval_ms: u64,
    #[serde(default = "default_disk_roots")]
    pub disk_roots: Vec<String>,
    #[serde(default = "default_runner_interval")]
    pub runner_interval_ms: u64,
}

impl Default for CollectorConfig {
    fn default() -> Self {
        Self {
            proc_interval_ms: default_proc_interval(),
            thermal_interval_ms: default_thermal_interval(),
            fan_interval_ms: default_fan_interval(),
            macmon: default_macmon(),
            fanctl: default_fanctl(),
            disk_interval_ms: default_disk_interval(),
            disk_roots: default_disk_roots(),
            runner_interval_ms: default_runner_interval(),
        }
    }
}

fn default_proc_interval() -> u64 { 2000 }
fn default_thermal_interval() -> u64 { 5000 }
fn default_fan_interval() -> u64 { 2000 }
fn default_macmon() -> String { "/opt/homebrew/bin/macmon".to_string() }
fn default_fanctl() -> String { "/Library/MacMiniFanControl/fanctl".to_string() }
fn default_disk_interval() -> u64 { 21_600_000 }
fn default_disk_roots() -> Vec<String> {
    // One tree from home: first-level breakdown, with known-worthwhile
    // subtrees (github-runners workspaces) classified deeper by the scanner.
    vec![std::env::var("HOME").unwrap_or_else(|_| "/Users/unknown".to_string())]
}
fn default_runner_interval() -> u64 { 5000 }

pub fn load(path: &str) -> Result<Config, Box<dyn std::error::Error>> {
    let raw = std::fs::read_to_string(path)?;
    let mut config: Config = toml::from_str(&raw)?;
    let home = std::env::var("HOME").unwrap_or_default();
    for root in &mut config.collectors.disk_roots {
        if let Some(rest) = root.strip_prefix("~/") {
            if !home.is_empty() {
                *root = format!("{home}/{rest}");
            }
        }
    }
    Ok(config)
}
