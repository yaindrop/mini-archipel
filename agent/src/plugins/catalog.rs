#[path = "desktop_automation.rs"]
mod desktop_automation;
#[path = "fan_control.rs"]
mod fan_control;
#[path = "mini_proxy.rs"]
mod mini_proxy;
#[path = "runners.rs"]
mod runners;
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
    ]
}
