use serde_json::Value;
use std::io::{Error, ErrorKind};
use std::os::unix::fs::MetadataExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const SOCKET: &str = "/var/run/mini-archipel/fan-control.sock";
const MAX_REPLY: u64 = 4 * 1024 * 1024;

/// Both metrics and controls use the same authenticated local authority.
pub async fn rpc(socket_path: &str, request: Value) -> Result<Value, Error> {
    let call = async {
        let owner = std::fs::metadata(socket_path)?.uid();
        let mut stream = tokio::net::UnixStream::connect(socket_path).await?;
        if stream.peer_cred()?.uid() != owner {
            return Err(ErrorKind::PermissionDenied.into());
        }
        let mut request = serde_json::to_vec(&request).map_err(Error::other)?;
        if request.len() > 65535 {
            return Err(ErrorKind::InvalidInput.into());
        }
        request.push(b'\n');
        stream.write_all(&request).await?;
        let mut response = Vec::new();
        stream
            .take(MAX_REPLY + 1)
            .read_to_end(&mut response)
            .await?;
        if response.len() as u64 > MAX_REPLY {
            return Err(ErrorKind::InvalidData.into());
        }
        serde_json::from_slice::<Value>(&response).map_err(Error::other)
    };
    tokio::time::timeout(std::time::Duration::from_secs(4), call)
        .await
        .map_err(|_| Error::from(ErrorKind::TimedOut))?
}
