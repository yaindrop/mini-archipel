mod collectors;
mod config;
mod plugins;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use collectors::{Shared, SharedState};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
struct AppState {
    core: Shared,
    token: String,
    plugins: Arc<plugins::Manager>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "configure-plugin") {
        if args.len() != 5 {
            return Err("usage: mini-archipel-agent configure-plugin <config> <plugin-id> <true|false>; options JSON on stdin".into());
        }
        return plugins::cli::configure(&args[2], &args[3], &args[4]);
    }
    if args.get(1).is_some_and(|arg| arg == "check-config") {
        return plugins::cli::check(args.get(2).ok_or("missing config path")?);
    }
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{AGENT_VERSION}");
        return Ok(());
    }
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "agent.toml".into());
    let config = config::load(&path)?;
    let bind = config.bind.clone();
    let core = Arc::new(RwLock::new(SharedState::new()));
    let plugins = Arc::new(
        plugins::Manager::new(
            config.clone(),
            path.into(),
            Arc::clone(&core),
            plugins::catalog::installed(),
        )
        .await?,
    );
    collectors::spawn_all(Arc::clone(&core), config.collectors, Arc::clone(&plugins)).await;
    let state = AppState {
        core,
        token: config.token,
        plugins,
    };
    let app = Router::new()
        .route("/health", get(|| async { AGENT_VERSION }))
        .route("/snapshot", get(snapshot))
        .route("/plugins/{id}", put(set_plugin))
        .route("/plugins/{id}/actions/{action}", post(plugin_action))
        .route("/rescan-disk", post(rescan_disk))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("mini-archipel-agent {AGENT_VERSION} listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok())
        == Some(format!("Bearer {token}").as_str())
}
fn response(result: Result<Value, plugins::Failure>) -> (StatusCode, Json<Value>) {
    match result {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err((status, error)) => (status, Json(json!({ "error": error }))),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Enabled {
    enabled: bool,
}

async fn set_plugin(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Enabled>,
) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    response(
        state
            .plugins
            .set_enabled(&id, body.enabled)
            .await
            .map(|_| json!({ "ok": true })),
    )
}

async fn plugin_action(
    State(state): State<AppState>,
    Path((id, action)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    response(state.plugins.action(&id, action, body).await)
}

async fn rescan_disk(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    state
        .core
        .read()
        .await
        .disk_rescan_flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    response(Ok(json!({ "ok": true })))
}

async fn snapshot(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    response(
        serde_json::to_value(state.core.read().await.render()).map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "snapshot serialization failed".into(),
            )
        }),
    )
}
