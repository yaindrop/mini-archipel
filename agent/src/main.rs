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
    disk_roots: Vec<String>,
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
    let mut initial = SharedState::new();
    collectors::disk::restore(&mut initial);
    let core = Arc::new(RwLock::new(initial));
    let plugins = Arc::new(
        plugins::Manager::new(
            config.clone(),
            path.into(),
            Arc::clone(&core),
            plugins::catalog::installed(),
        )
        .await?,
    );
    let disk_roots = config.collectors.disk_roots.clone();
    collectors::spawn_all(Arc::clone(&core), config.collectors, Arc::clone(&plugins)).await;
    let state = AppState {
        core,
        token: config.token,
        plugins,
        disk_roots,
    };
    let app = Router::new()
        .route("/health", get(|| async { AGENT_VERSION }))
        .route("/snapshot", get(snapshot))
        .route("/plugins/{id}", put(set_plugin))
        .route("/plugins/{id}/actions/{action}", post(plugin_action))
        .route("/rescan-disk", post(rescan_disk))
        .route("/cancel-disk-scan", post(cancel_disk_scan))
        .route("/disk-rules", get(disk_rules).put(update_disk_rules))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("mini-archipel-agent {AGENT_VERSION} listening on {bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = term.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
            collectors::disk::shutdown(&state.core).await;
        })
        .await?;
    Ok(())
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok())
        == Some(format!("Bearer {token}").as_str())
}
async fn disk_rules(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    response(Ok(json!(state.plugins.disk_rules().await)))
}
async fn update_disk_rules(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<collectors::disk_rules::RulesUpdate>,
) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    response(
        state
            .plugins
            .update_disk_rules(body)
            .await
            .map(|view| json!(view)),
    )
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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanRequest {
    #[serde(default)]
    path: Option<String>,
}
async fn rescan_disk(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ScanRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    if state.disk_roots.is_empty() {
        return response(Err((
            StatusCode::CONFLICT,
            "disk scanning is disabled".into(),
        )));
    }
    response(
        collectors::disk::request(&state.core, &state.disk_roots, body.path)
            .await
            .map(|job| json!({ "ok": true, "job": job })),
    )
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelScan {
    id: u64,
}

async fn cancel_disk_scan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CancelScan>,
) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return response(Err((StatusCode::UNAUTHORIZED, "unauthorized".into())));
    }
    response(
        collectors::disk::cancel(&state.core, body.id)
            .await
            .map(|job| json!({ "ok": true, "job": job })),
    )
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
