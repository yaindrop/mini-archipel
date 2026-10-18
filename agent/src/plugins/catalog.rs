#[path = "fan_control.rs"]
mod fan_control;
#[path = "runners.rs"]
mod runners;
use super::Plugin;
use runners::Runners;
use std::sync::Arc;

/// The composition root is the only place that selects built-in plugins.
pub fn installed() -> Vec<Arc<dyn Plugin>> {
    vec![
        Arc::new(Runners::default()),
        Arc::new(fan_control::FanControl),
    ]
}
