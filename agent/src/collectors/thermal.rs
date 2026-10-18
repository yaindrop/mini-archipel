use serde::Serialize;

use super::Shared;

#[derive(Serialize, Clone)]
pub struct ThermalInfo {
    /// 0 nominal / 1 fair / 2 serious / 3 critical
    pub state: u8,
    pub ts: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn read_state() -> Option<u8> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new("osascript")
            .arg("-l")
            .arg("JavaScript")
            .arg("-e")
            .arg("ObjC.import(\"Foundation\"); $.NSProcessInfo.processInfo.thermalState;")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<u8>()
        .ok()
}

pub async fn run(state: Shared, interval_ms: u64) {
    loop {
        if let Some(state_value) = read_state().await {
            state.write().await.thermal = Some(ThermalInfo {
                state: state_value,
                ts: now_unix(),
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}
