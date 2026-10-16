mod collectors;
mod config;

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use tokio::sync::RwLock;

use collectors::SharedState;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "agent.toml".to_string());
    let config = config::load(&config_path)?;
    let bind = config.bind.clone();
    let token = config.token.clone();

    let state = Arc::new(RwLock::new(SharedState::new()));
    collectors::spawn_all(Arc::clone(&state), config.collectors).await;

    let app = Router::new()
        .route("/health", get(health))
        .route("/snapshot", get(snapshot))
        .route("/runner-service", post(runner_service))
        .route("/rescan-disk", post(rescan_disk))
        .with_state((state, token));

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("mini-fleet-agent {AGENT_VERSION} listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, AGENT_VERSION)
}

#[derive(serde::Deserialize)]
struct RunnerServiceRequest {
    runner: String,
    enable: bool,
}

/// Enables or disables the launchd job of one installed runner.
/// macOS only; uses launchctl enable/disable + bootout/bootstrap.
async fn runner_service(
    State((state, token)): State<(Arc<RwLock<SharedState>>, String)>,
    headers: HeaderMap,
    Json(body): Json<RunnerServiceRequest>,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if auth != format!("Bearer {token}") {
        return (StatusCode::UNAUTHORIZED, String::new());
    }
    if std::env::var("MINIFLEET_ALLOW_RUNNER_CONTROL").is_err() {
        return (
            StatusCode::FORBIDDEN,
            "runner control disabled; set MINIFLEET_ALLOW_RUNNER_CONTROL=1 to enable".to_string(),
        );
    }
    // Refuse while a job is active.
    {
        let shared = state.read().await;
        let active = shared.runners.iter().any(|r| {
            (r.agent_name.as_deref() == Some(body.runner.as_str())
                || r.repo_dir == body.runner)
                && r.worker_pid.is_some()
        });
        if active {
            return (StatusCode::CONFLICT, "runner is running a job".to_string());
        }
    }

    let label = format!("actions.runner.yaindrop-flow-bit.{}", body.runner);
    let domain = format!("gui/{}", libc_getuid());
    let plist = format!(
        "{}/Library/LaunchAgents/{label}.plist",
        std::env::var("HOME").unwrap_or_default()
    );
    let result = if body.enable {
        run("launchctl", &["enable", &format!("{domain}/{label}")])
            .and_then(|_| run("launchctl", &["bootstrap", &domain, &plist]))
    } else {
        let _ = run("launchctl", &["bootout", &format!("{domain}/{label}")]);
        run("launchctl", &["disable", &format!("{domain}/{label}")])
    };
    match result {
        Ok(()) => (StatusCode::OK, "{\"ok\":true}".to_string()),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{{\"ok\":false,\"error\":\"{error}\"}}"),
        ),
    }
}

fn libc_getuid() -> u32 {
    unsafe { u32::try_from(libc::getuid()).unwrap_or(0) }
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("spawn {program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

/// Trigger an immediate disk-tree rescan (fire-and-forget; token required).
async fn rescan_disk(
    State((state, token)): State<(Arc<RwLock<SharedState>>, String)>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if auth != format!("Bearer {token}") {
        return (StatusCode::UNAUTHORIZED, String::new());
    }
    // Tell the disk collector to run now by bumping a generation counter.
    state.read().await.disk_rescan_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    (StatusCode::OK, "{\"ok\":true}".to_string())
}

async fn snapshot(
    State((state, token)): State<(Arc<RwLock<SharedState>>, String)>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if auth != format!("Bearer {token}") {
        return (StatusCode::UNAUTHORIZED, String::new());
    }
    let snapshot = state.read().await.render();
    (StatusCode::OK, serde_json::to_string(&snapshot).unwrap())
}
