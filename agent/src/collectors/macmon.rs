use serde::Serialize;

use super::Shared;

/// Streams macmon JSON lines for per-cluster frequency and power draw.
/// The binary is optional: without it the console simply shows no
/// frequency/power series for the host.
#[derive(Serialize, Clone, Default)]
pub struct MacmonSample {
    pub e_cluster_mhz: Option<u64>,
    pub e_cluster_pct: Option<f32>,
    pub p_cluster_mhz: Option<u64>,
    pub p_cluster_pct: Option<f32>,
    pub gpu_mhz: Option<u64>,
    pub gpu_pct: Option<f32>,
    pub cpu_power_w: Option<f32>,
    pub gpu_power_w: Option<f32>,
    pub package_power_w: Option<f32>,
    pub ts: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn f64_field(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|v| v.as_f64())
}

/// macmon usage fields are [freq_mhz, ratio] tuples; report percent.
fn ratio_field(value: &serde_json::Value, key: &str) -> Option<f32> {
    let pair = value.get(key)?.as_array()?;
    let ratio = pair.get(1)?.as_f64()?;
    Some((ratio * 100.0) as f32)
}

fn apply(sample: &mut MacmonSample, value: &serde_json::Value) {
    if let Some(v) = f64_field(value, "ecpu_freq_mhz") {
        sample.e_cluster_mhz = Some(v as u64);
    }
    if let Some(v) = ratio_field(value, "ecpu_usage") {
        sample.e_cluster_pct = Some(v);
    }
    if let Some(v) = f64_field(value, "pcpu_freq_mhz") {
        sample.p_cluster_mhz = Some(v as u64);
    }
    if let Some(v) = ratio_field(value, "pcpu_usage") {
        sample.p_cluster_pct = Some(v);
    }
    if let Some(v) = f64_field(value, "gpu_freq_mhz") {
        sample.gpu_mhz = Some(v as u64);
    }
    if let Some(v) = ratio_field(value, "gpu_usage") {
        sample.gpu_pct = Some(v);
    }
    if let Some(v) = f64_field(value, "cpu_power") {
        sample.cpu_power_w = Some(v as f32);
    }
    if let Some(v) = f64_field(value, "gpu_power") {
        sample.gpu_power_w = Some(v as f32);
    }
    if let Some(v) = f64_field(value, "all_power") {
        sample.package_power_w = Some(v as f32);
    }
}

pub async fn run(state: Shared, binary: String) {
    loop {
        let mut child = match tokio::process::Command::new(&binary)
            .arg("pipe")
            .arg("-i")
            .arg("1000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                eprintln!("macmon spawn failed ({binary}): {error}");
                // Binary absent on this host: retry occasionally in case it
                // gets installed later.
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                continue;
            }
        };

        use tokio::io::{AsyncBufReadExt, BufReader};
        let stdout = child.stdout.take().expect("piped stdout");
        let mut lines = BufReader::new(stdout).lines();
        let mut sample = MacmonSample::default();
        let mut seen_lines = 0u32;

        while let Ok(Some(line)) = lines.next_line().await {
            seen_lines += 1;
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            apply(&mut sample, &value);
            sample.ts = now_unix();
            state.write().await.macmon = Some(sample.clone());
        }

        let status = child.wait().await;
        eprintln!(
            "macmon stream ended after {seen_lines} lines, status={status:?}; respawning"
        );
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
