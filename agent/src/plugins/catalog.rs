#[path = "../../../plugins/automation/agent/mod.rs"]
mod automation;
#[path = "../../../plugins/fan-control/agent/mod.rs"]
mod fan_control;
#[path = "../../../plugins/proxy/agent/mod.rs"]
mod proxy;
#[path = "../../../plugins/runners/agent/mod.rs"]
mod runners;
#[path = "../../../plugins/screen-recording/agent/mod.rs"]
mod screen_recording;
use super::{
    manifest::{validate_catalog, Manifest},
    Plugin,
};
use proxy::Proxy;
use runners::Runners;
use std::sync::Arc;

/// The composition root is the only place that selects built-in plugins.
pub fn installed() -> Result<Vec<Arc<dyn Plugin>>, String> {
    let registrations: Vec<(Arc<dyn Plugin>, &str)> = vec![
        (
            Arc::new(Runners::default()),
            include_str!("../../../plugins/runners/manifest.toml"),
        ),
        (
            Arc::new(fan_control::FanControl),
            include_str!("../../../plugins/fan-control/manifest.toml"),
        ),
        (
            Arc::new(Proxy::default()),
            include_str!("../../../plugins/proxy/manifest.toml"),
        ),
        (
            Arc::new(automation::Automation),
            include_str!("../../../plugins/automation/manifest.toml"),
        ),
        (
            Arc::new(screen_recording::ScreenRecording::default()),
            include_str!("../../../plugins/screen-recording/manifest.toml"),
        ),
    ];
    let mut manifests = Vec::new();
    let mut plugins = Vec::new();
    for (plugin, source) in registrations {
        let manifest = Manifest::parse(source, plugin.id())
            .map_err(|error| format!("invalid plugin manifest {}: {error}", plugin.id()))?;
        for alias in manifest.legacy_ids.iter().flatten() {
            if canonical_id(alias) != manifest.id {
                return Err("manifest and boundary aliases differ".into());
            }
        }
        manifests.push(manifest);
        plugins.push(plugin);
    }
    validate_catalog(&manifests)?;
    Ok(plugins)
}

/// Legacy keys remain accepted at configuration and API boundaries only.
pub fn canonical_id(id: &str) -> &str {
    match id {
        "mini-proxy" => "proxy",
        "desktop-automation" => "automation",
        "screen-recorder" => "screen-recording",
        _ => id,
    }
}
