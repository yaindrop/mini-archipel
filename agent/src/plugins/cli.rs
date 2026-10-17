use super::{catalog, Plugin};
use crate::config;
use std::collections::BTreeMap;
use std::sync::Arc;

fn validate(config: &config::Config, definitions: &[Arc<dyn Plugin>]) -> Result<(), String> {
    for (id, setting) in &config.plugins {
        let plugin = definitions
            .iter()
            .find(|plugin| plugin.id() == id)
            .ok_or_else(|| format!("plugin not installed: {id}"))?;
        plugin.validate(&serde_json::to_value(&setting.options).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

/// Offline bootstrap only. Runtime changes use the authenticated plugin settings endpoint.
pub fn configure(path: &str, id: &str, enabled: &str) -> Result<(), Box<dyn std::error::Error>> {
    let definitions = catalog::installed();
    let mut config = config::load(path)?;
    if !definitions.iter().any(|plugin| plugin.id() == id) {
        return Err("plugin not installed".into());
    }
    let patch: BTreeMap<String, toml::Value> =
        serde_json::from_str(&std::io::read_to_string(std::io::stdin())?)?;
    let setting = config.plugins.entry(id.into()).or_default();
    setting.enabled = enabled.parse()?;
    setting.options.extend(patch);
    validate(&config, &definitions)?;
    config::save(std::path::Path::new(path), &config)?;
    println!("Plugin {id} configured; restart the agent to apply offline changes.");
    Ok(())
}

pub fn check(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let config = config::load(path)?;
    validate(&config, &catalog::installed())?;
    // Only the public bind address is printed, never tokens or plugin options.
    println!("{}", config.bind);
    Ok(())
}
