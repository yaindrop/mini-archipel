#[path = "../../../plugins/automation/agent/mod.rs"]
mod desktop_automation;
#[path = "../../../plugins/fan-control/agent/mod.rs"]
mod fan_control;
#[path = "../../../plugins/proxy/agent/mod.rs"]
mod mini_proxy;
#[path = "../../../plugins/runners/agent/mod.rs"]
mod runners;
#[path = "../../../plugins/screen-recording/agent/mod.rs"]
mod screen_recorder;
use super::Plugin;
use mini_proxy::MiniProxy;
use runners::Runners;
use std::sync::Arc;

/// The composition root is the only place that selects built-in plugins.
pub fn installed() -> Vec<Arc<dyn Plugin>> {
    vec![
        Arc::new(Runners::default()),
        Arc::new(fan_control::FanControl),
        Arc::new(MiniProxy::default()),
        Arc::new(desktop_automation::DesktopAutomation),
        Arc::new(screen_recorder::ScreenRecorder::default()),
    ]
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
