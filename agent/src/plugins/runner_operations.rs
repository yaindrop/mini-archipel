use super::{Failure, Task};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
pub struct Operation {
    pub id: String,
    pub action: String,
    pub request: Value,
    pub status: String,
    pub requested_at: u64,
    pub finished_at: Option<u64>,
    pub error: Option<String>,
}
impl Operation {
    fn active(&self) -> bool {
        matches!(self.status.as_str(), "queued" | "running")
    }
}
#[derive(Clone, Default)]
pub struct Operations(Arc<Mutex<Option<Vec<Operation>>>>);
fn path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join(".local/state/mini-ci/runner-operations.json")
}
fn failure() -> Failure {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "runner operation journal unavailable".into(),
    )
}
async fn persist(jobs: &[Operation]) -> Result<(), Failure> {
    let jobs = jobs.to_vec();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let path = path();
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let next = path.with_extension(format!(
            "json.next-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&next)?;
        let result = (|| {
            file.write_all(&serde_json::to_vec(&jobs)?)?;
            file.sync_all()?;
            std::fs::rename(&next, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(next);
        }
        result
    })
    .await
    .map_err(|_| failure())?
    .map_err(|_| failure())
}
impl Operations {
    async fn load(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Vec<Operation>>>, Failure> {
        let mut guard = self.0.lock().await;
        if guard.is_none() {
            let mut jobs: Vec<Operation> = match tokio::fs::read(path()).await {
                Ok(raw) => serde_json::from_slice(&raw).map_err(|_| failure())?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
                Err(_) => return Err(failure()),
            };
            let mut recovered = false;
            for job in &mut jobs {
                if job.active() {
                    job.status = "interrupted".into();
                    job.error =
                        Some("operation outcome unknown after restart; inspect local state".into());
                    job.finished_at = Some(super::now());
                    recovered = true;
                }
            }
            if recovered {
                persist(&jobs).await?;
            }
            *guard = Some(jobs);
        }
        Ok(guard)
    }
    pub async fn read(&self) -> Result<Vec<Operation>, Failure> {
        Ok(self.load().await?.as_ref().unwrap().clone())
    }
    pub async fn submit(
        &self,
        id: String,
        action: String,
        request: Value,
        validate: Task<'static, Result<(), Failure>>,
        work: Task<'static, Result<Value, Failure>>,
    ) -> Result<Value, Failure> {
        if id.len() < 8
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "invalid operation request ID".into(),
            ));
        }
        let mut guard = self.load().await?;
        let jobs = guard.as_mut().unwrap();
        if let Some(previous) = jobs.iter().find(|job| job.id == id) {
            if previous.action != action || previous.request != request {
                return Err((
                    StatusCode::CONFLICT,
                    "operation request ID reused with a different command".into(),
                ));
            }
            return Ok(serde_json::json!({"ok":true,"operation":previous}));
        }
        if jobs.iter().any(|job| {
            job.active()
                && job.request.get("runner") == request.get("runner")
                && (job.action == "interrupt") == (action == "interrupt")
        }) {
            return Err((
                StatusCode::CONFLICT,
                "another runner operation is active".into(),
            ));
        }
        while jobs.len() >= 32 {
            if let Some(index) = jobs.iter().position(|job| !job.active()) {
                jobs.remove(index);
            } else {
                return Err((StatusCode::CONFLICT, "too many runner operations".into()));
            }
        }
        validate.await?;
        let job = Operation {
            id: id.clone(),
            action,
            request,
            status: "queued".into(),
            requested_at: super::now(),
            finished_at: None,
            error: None,
        };
        let mut next = jobs.clone();
        next.push(job.clone());
        persist(&next).await?;
        *jobs = next;
        drop(guard);
        let operations = self.clone();
        tokio::spawn(async move {
            {
                let mut guard = operations.0.lock().await;
                let jobs = guard.as_mut().unwrap();
                jobs.iter_mut().find(|job| job.id == id).unwrap().status = "running".into();
                if persist(jobs).await.is_err() {
                    let job = jobs.iter_mut().find(|job| job.id == id).unwrap();
                    job.status = "failed".into();
                    job.error =
                        Some("runner operation journal unavailable; operation not started".into());
                    job.finished_at = Some(super::now());
                    return;
                }
            }
            let result = work.await;
            let mut guard = operations.0.lock().await;
            let jobs = guard.as_mut().unwrap();
            let job = jobs.iter_mut().find(|job| job.id == id).unwrap();
            job.finished_at = Some(super::now());
            match result {
                Ok(_) => job.status = "completed".into(),
                Err((status, error)) => {
                    job.status = if status.is_server_error() {
                        "uncertain"
                    } else {
                        "failed"
                    }
                    .into();
                    job.error = Some(error);
                }
            }
            if persist(jobs).await.is_err() {
                let job = jobs.iter_mut().find(|job| job.id == id).unwrap();
                job.status = "uncertain".into();
                job.error = Some("operation result could not be saved; inspect local state".into());
            }
        });
        Ok(serde_json::json!({"ok":true,"operation":job}))
    }
}
