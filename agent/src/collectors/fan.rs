use super::Shared;

/// Reads the mac-mini-fan-control daemon status; absent binary leaves fan empty.
pub async fn run(state: Shared, fanctl: String, interval_ms: u64) {
    let status_path = format!("{fanctl} -c /Library/MacMiniFanControl/fanctl.conf -j status");
    loop {
        if let Ok(output) = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&status_path)
            .output()
            .await
        {
            if output.status.success() {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                    state.write().await.fan = Some(value);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}
