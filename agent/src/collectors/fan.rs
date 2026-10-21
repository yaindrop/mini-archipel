use super::Shared;
use serde_json::{json, Value};

/// Base monitoring stays available when the optional control plugin is disabled.
pub async fn run(state: Shared, socket_path: String, interval_ms: u64) {
    if socket_path.is_empty() {
        return;
    }
    loop {
        let result = crate::fan_control::rpc(&socket_path, json!({"op":"read"})).await;
        let value = match result {
            Ok(reply) => {
                let reading = reading(&reply);
                if reading.is_none() {
                    eprintln!("fan sensor telemetry unavailable or stale");
                }
                reading
            }
            Err(error) => {
                eprintln!("fan sensor authority unavailable: {error}");
                None
            }
        };
        {
            let mut shared = state.write().await;
            if let Some(mut value) = value {
                value["error"] = json!(false);
                shared.fan = Some(value);
            } else if let Some(value) = shared.fan.as_mut() {
                value["error"] = json!(true);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}

fn reading(reply: &Value) -> Option<Value> {
    let data = &reply["data"];
    let ts = data["sampled_at"].as_u64()?;
    let age = super::now_unix().checked_sub(ts)?;
    let value = &data["telemetry"]["reading"];
    if reply["ok"] != true
        || data["availability"] != "ready"
        || !data["telemetry_error"].is_null()
        || value["ok"] != true
        || age > 10_000
    {
        return None;
    }
    let mut value = value.clone();
    value["ts"] = json!(ts);
    Some(value)
}
