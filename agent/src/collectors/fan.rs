use super::Shared;

/// Reads the mini-fan-control daemon status; absent binary leaves fan empty.
pub async fn run(state: Shared, fanctl: String, interval_ms: u64) {
    if fanctl.is_empty() {
        return;
    }
    loop {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::process::Command::new(&fanctl)
                .args([
                    "-c",
                    "/Library/MacMiniFanControl/fanctl.conf",
                    "-j",
                    "status",
                ])
                .kill_on_drop(true)
                .output(),
        )
        .await;
        match result {
            Ok(Ok(output)) if output.status.success() => {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                    state.write().await.fan = Some(value);
                } else {
                    eprintln!("fan sensor status returned invalid JSON");
                }
            }
            Ok(Ok(output)) => eprintln!(
                "fan sensor status failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Ok(Err(error)) => eprintln!("fan sensor status could not start: {error}"),
            Err(_) => eprintln!("fan sensor status timed out"),
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}
