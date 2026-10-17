pub mod catalog;
pub mod cli;

use crate::collectors::Shared;
use crate::config::{Config, PluginConfig};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::{sync::Mutex, task::JoinHandle};

pub type Task<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type Failure = (StatusCode, String);

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Envelope {
    pub version: u32,
    pub enabled: bool,
    pub status: String,
    pub ts: u64,
    pub data: Value,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct Context {
    pub id: String,
    pub state: Shared,
    pub cancelled: Arc<AtomicBool>,
}

impl Context {
    pub async fn publish(&self, data: Value) {
        if self.cancelled.load(Ordering::Relaxed) {
            return;
        }
        if let Some(entry) = self.state.write().await.plugins.get_mut(&self.id) {
            if entry.enabled && !self.cancelled.load(Ordering::Relaxed) {
                entry.data = data;
                entry.status = "ready".into();
                entry.error = None;
                entry.ts = now();
            }
        }
    }
}

pub trait Plugin: Send + Sync {
    fn id(&self) -> &'static str;
    /// Absolute directories whose direct children should appear in disk scans.
    fn disk_expansions(&self) -> Vec<PathBuf> {
        Vec::new()
    }
    fn schema_version(&self) -> u32 {
        1
    }
    fn validate(&self, options: &Value) -> Result<(), String>;
    fn run(&self, context: Context, options: Value) -> Task<'_, Result<(), String>>;
    fn action(
        &self,
        context: Context,
        options: Value,
        action: String,
        body: Value,
    ) -> Task<'_, Result<Value, Failure>>;
}

struct Running {
    task: JoinHandle<()>,
    cancelled: Arc<AtomicBool>,
}

struct Runtime {
    config: Config,
    tasks: BTreeMap<String, Running>,
}

pub struct Manager {
    definitions: BTreeMap<String, Arc<dyn Plugin>>,
    runtime: Mutex<Runtime>,
    state: Shared,
    config_path: PathBuf,
}

impl Drop for Manager {
    fn drop(&mut self) {
        for running in self.runtime.get_mut().tasks.values() {
            running.cancelled.store(true, Ordering::Relaxed);
            running.task.abort();
        }
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Manager {
    pub async fn disk_expansions(&self) -> Vec<PathBuf> {
        let runtime = self.runtime.lock().await;
        self.definitions
            .iter()
            .filter(|(id, _)| {
                runtime.config.plugins.get(*id).is_some_and(|c| c.enabled)
                    && runtime
                        .tasks
                        .get(*id)
                        .is_some_and(|r| !r.task.is_finished())
            })
            .flat_map(|(_, plugin)| plugin.disk_expansions())
            .collect()
    }

    pub async fn new(
        config: Config,
        config_path: PathBuf,
        state: Shared,
        plugins: Vec<Arc<dyn Plugin>>,
    ) -> Result<Self, String> {
        let mut definitions = BTreeMap::new();
        for plugin in plugins {
            let id = plugin.id().to_string();
            if definitions.insert(id, plugin).is_some() {
                return Err("duplicate plugin id".into());
            }
        }
        for (id, setting) in &config.plugins {
            let definition = definitions
                .get(id)
                .ok_or_else(|| format!("plugin not installed: {id}"))?;
            definition
                .validate(&serde_json::to_value(&setting.options).map_err(|e| e.to_string())?)?;
        }
        let manager = Self {
            definitions,
            runtime: Mutex::new(Runtime {
                config,
                tasks: BTreeMap::new(),
            }),
            state,
            config_path,
        };
        let mut runtime = manager.runtime.lock().await;
        for id in manager.definitions.keys() {
            let setting = runtime.config.plugins.get(id).cloned().unwrap_or_default();
            manager.install(&mut runtime, id, setting).await;
        }
        drop(runtime);
        Ok(manager)
    }

    async fn install(&self, runtime: &mut Runtime, id: &str, setting: PluginConfig) {
        self.state.write().await.plugins.insert(
            id.into(),
            Envelope {
                version: self.definitions[id].schema_version(),
                enabled: setting.enabled,
                status: if setting.enabled {
                    "starting"
                } else {
                    "disabled"
                }
                .into(),
                ts: now(),
                data: Value::Null,
                error: None,
            },
        );
        if !setting.enabled {
            return;
        }
        let plugin = Arc::clone(&self.definitions[id]);
        let cancelled = Arc::new(AtomicBool::new(false));
        let context = Context {
            id: id.into(),
            state: Arc::clone(&self.state),
            cancelled: Arc::clone(&cancelled),
        };
        let options = serde_json::to_value(setting.options).unwrap_or_default();
        let task = tokio::spawn(async move {
            let result = plugin.run(context.clone(), options).await;
            if !context.cancelled.load(Ordering::Relaxed) {
                if let Some(entry) = context.state.write().await.plugins.get_mut(&context.id) {
                    entry.status = "error".into();
                    entry.error = Some(
                        result
                            .err()
                            .unwrap_or_else(|| "plugin stopped unexpectedly".into()),
                    );
                    entry.ts = now();
                }
            }
        });
        runtime.tasks.insert(id.into(), Running { task, cancelled });
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), Failure> {
        if !self.definitions.contains_key(id) {
            return Err((StatusCode::NOT_FOUND, "plugin not installed".into()));
        }
        let mut runtime = self.runtime.lock().await;
        let setting = runtime.config.plugins.get(id).cloned().unwrap_or_default();
        if setting.enabled == enabled
            && (!enabled || runtime.tasks.get(id).is_some_and(|r| !r.task.is_finished()))
        {
            return Ok(());
        }
        if enabled {
            self.definitions[id]
                .validate(&serde_json::to_value(&setting.options).unwrap_or_default())
                .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
        }
        let mut updated = runtime.config.clone();
        updated.plugins.entry(id.into()).or_default().enabled = enabled;
        crate::config::save(&self.config_path, &updated).map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not save plugin configuration".into(),
            )
        })?;
        if let Some(running) = runtime.tasks.remove(id) {
            running.cancelled.store(true, Ordering::Relaxed);
            running.task.abort();
            let _ = running.task.await;
        }
        runtime.config = updated;
        let setting = runtime.config.plugins[id].clone();
        self.install(&mut runtime, id, setting).await;
        if !self.definitions[id].disk_expansions().is_empty() {
            self.state
                .read()
                .await
                .disk_rescan_flag
                .store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub async fn action(&self, id: &str, action: String, body: Value) -> Result<Value, Failure> {
        let plugin = self
            .definitions
            .get(id)
            .ok_or((StatusCode::NOT_FOUND, "plugin not installed".into()))?;
        let runtime = self.runtime.lock().await;
        let setting = runtime.config.plugins.get(id).cloned().unwrap_or_default();
        if !setting.enabled {
            return Err((StatusCode::CONFLICT, "plugin is disabled".into()));
        }
        if self
            .state
            .read()
            .await
            .plugins
            .get(id)
            .is_none_or(|entry| entry.status != "ready")
        {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "plugin is not ready".into(),
            ));
        }
        let context = Context {
            id: id.into(),
            state: Arc::clone(&self.state),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        plugin
            .action(
                context,
                serde_json::to_value(setting.options).unwrap_or_default(),
                action,
                body,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collectors::SharedState;
    use serde_json::json;
    use tokio::sync::RwLock;

    struct Probe(&'static str);
    impl Plugin for Probe {
        fn id(&self) -> &'static str {
            self.0
        }
        fn disk_expansions(&self) -> Vec<PathBuf> {
            vec![PathBuf::from("/test").join(self.0)]
        }
        fn schema_version(&self) -> u32 {
            if self.0 == "beta" {
                2
            } else {
                1
            }
        }
        fn validate(&self, _: &Value) -> Result<(), String> {
            Ok(())
        }
        fn run(&self, context: Context, _: Value) -> Task<'_, Result<(), String>> {
            Box::pin(async move {
                context.publish(json!({ "alive": true })).await;
                std::future::pending().await
            })
        }
        fn action(
            &self,
            _: Context,
            _: Value,
            action: String,
            body: Value,
        ) -> Task<'_, Result<Value, Failure>> {
            Box::pin(async move {
                if action == "echo" {
                    Ok(body)
                } else {
                    Err((StatusCode::NOT_FOUND, "unknown action".into()))
                }
            })
        }
    }
    fn fixture() -> (Config, PathBuf, Shared) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "fleet-plugin-test-{}-{}-{}",
            std::process::id(),
            now(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let config = toml::from_str("bind = '127.0.0.1:0'\ntoken = 'test-only'\n[plugins.alpha]\nenabled = true\n[plugins.beta]\nenabled = true\n").unwrap();
        (config, dir, Arc::new(RwLock::new(SharedState::new())))
    }
    async fn ready(state: &Shared, id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if state.read().await.plugins[id].status == "ready" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn plugins_are_independent_and_disabling_is_persistent() {
        let (config, dir, state) = fixture();
        let path = dir.join("agent.toml");
        let definitions = || {
            vec![
                Arc::new(Probe("alpha")) as Arc<dyn Plugin>,
                Arc::new(Probe("beta")),
            ]
        };
        let manager = Manager::new(config, path.clone(), state.clone(), definitions())
            .await
            .unwrap();
        ready(&state, "alpha").await;
        ready(&state, "beta").await;
        assert_eq!(
            manager.disk_expansions().await,
            vec![PathBuf::from("/test/alpha"), PathBuf::from("/test/beta")]
        );
        assert_eq!(state.read().await.plugins["beta"].version, 2);
        assert_eq!(
            manager
                .action("alpha", "echo".into(), json!({"ok": 1}))
                .await
                .unwrap(),
            json!({"ok": 1})
        );
        manager.set_enabled("alpha", false).await.unwrap();
        assert_eq!(
            manager.disk_expansions().await,
            vec![PathBuf::from("/test/beta")]
        );
        assert!(state.read().await.disk_rescan_flag.load(Ordering::Relaxed));
        assert!(!state.read().await.plugins["alpha"].enabled);
        assert!(state.read().await.plugins["alpha"].data.is_null());
        assert_eq!(state.read().await.plugins["beta"].status, "ready");
        assert_eq!(
            manager
                .action("alpha", "echo".into(), Value::Null)
                .await
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            manager.set_enabled("missing", true).await.unwrap_err().0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            manager
                .action("beta", "missing".into(), Value::Null)
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
        let persisted = crate::config::load(path.to_str().unwrap()).unwrap();
        assert!(!persisted.plugins["alpha"].enabled);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(manager);
        let state2 = Arc::new(RwLock::new(SharedState::new()));
        let manager = Manager::new(persisted, path, state2.clone(), definitions())
            .await
            .unwrap();
        assert_eq!(state2.read().await.plugins["alpha"].status, "disabled");
        manager.set_enabled("alpha", true).await.unwrap();
        ready(&state2, "alpha").await;
        assert_eq!(manager.disk_expansions().await.len(), 2);
        assert!(
            crate::config::load(dir.join("agent.toml").to_str().unwrap())
                .unwrap()
                .plugins["alpha"]
                .enabled
        );
        drop(manager);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn persistence_failure_leaves_the_live_plugin_unchanged() {
        let (config, dir, state) = fixture();
        let manager = Manager::new(
            config,
            dir.join("missing/agent.toml"),
            state.clone(),
            vec![Arc::new(Probe("alpha")), Arc::new(Probe("beta"))],
        )
        .await
        .unwrap();
        ready(&state, "alpha").await;
        assert_eq!(
            manager.set_enabled("alpha", false).await.unwrap_err().0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(state.read().await.plugins["alpha"].enabled);
        assert_eq!(
            manager
                .action("alpha", "echo".into(), json!(true))
                .await
                .unwrap(),
            json!(true)
        );
        drop(manager);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
