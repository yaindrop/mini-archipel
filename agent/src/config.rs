use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Config {
    pub bind: String,
    pub token: String,
    #[serde(default)]
    pub collectors: CollectorConfig,
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginConfig>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
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
        }
    }
}

fn default_proc_interval() -> u64 {
    2000
}
fn default_thermal_interval() -> u64 {
    5000
}
fn default_fan_interval() -> u64 {
    2000
}
fn default_macmon() -> String {
    "/opt/homebrew/bin/macmon".to_string()
}
fn default_fanctl() -> String {
    "/Library/MacMiniFanControl/fanctl".to_string()
}
fn default_disk_interval() -> u64 {
    21_600_000
}
fn default_disk_roots() -> Vec<String> {
    // One tree from home: first-level breakdown, with known-worthwhile
    // larger workspace subtrees classified deeper by the scanner.
    vec![std::env::var("HOME").unwrap_or_else(|_| "/Users/unknown".to_string())]
}

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

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct PluginConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub options: BTreeMap<String, toml::Value>,
}

pub fn save(path: &std::path::Path, config: &Config) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(
            toml::to_string_pretty(config)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}
