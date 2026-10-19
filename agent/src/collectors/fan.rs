use super::Shared;

/// Reads the fan-control daemon status; absent binary leaves fan empty.
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
                    "/Library/MiniArchipel/FanControl/fanctl.conf",
                    "-j",
                    "status",
                ])
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let value = match result {
            Ok(Ok(output)) if output.status.success() => {
                serde_json::from_slice::<serde_json::Value>(&output.stdout)
                    .ok()
                    .filter(|value| value.is_object() && value["ok"] == true)
            }
            Ok(Ok(output)) => {
                eprintln!(
                    "fan sensor status failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                None
            }
            Ok(Err(error)) => {
                eprintln!("fan sensor status could not start: {error}");
                None
            }
            Err(_) => {
                eprintln!("fan sensor status timed out");
                None
            }
        };
        {
            let mut shared = state.write().await;
            if let Some(mut value) = value {
                value["ts"] = serde_json::json!(super::now_unix());
                value["error"] = serde_json::json!(false);
                shared.fan = Some(value);
            } else if let Some(value) = shared.fan.as_mut() {
                value["error"] = serde_json::json!(true);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}
