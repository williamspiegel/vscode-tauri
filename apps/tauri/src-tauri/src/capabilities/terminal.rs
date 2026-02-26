use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

#[async_trait]
pub trait TerminalCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryTerminalCapability {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, TerminalSession>>,
}

struct TerminalSession {
    child: Child,
}

impl RustPrimaryTerminalCapability {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl TerminalCapability for RustPrimaryTerminalCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "terminal.create" => {
                let shell = parse_required_string(params, "shell")?;
                let args = parse_optional_string_array(params.get("args"))?;
                let cwd = params.get("cwd").and_then(Value::as_str);
                let env_overrides = parse_optional_string_map(params.get("env"))?;

                let mut command = Command::new(shell);
                command
                    .args(&args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                if let Some(cwd_path) = cwd {
                    command.current_dir(cwd_path);
                }
                for (key, value) in env_overrides {
                    command.env(key, value);
                }

                let mut child = command
                    .spawn()
                    .map_err(|error| format!("terminal.create failed for '{shell}': {error}"))?;
                let pid = child.id();
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                let session_id = self.next_id.fetch_add(1, Ordering::Relaxed);
                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal session mutex poisoned".to_string())?;
                sessions.insert(session_id, TerminalSession { child });
                drop(sessions);

                let app_handle = crate::capabilities::window::app_handle();
                if let Some(pipe) = stdout {
                    spawn_terminal_data_pump(session_id, pid, "stdout", pipe, app_handle.clone());
                }
                if let Some(pipe) = stderr {
                    spawn_terminal_data_pump(session_id, pid, "stderr", pipe, app_handle);
                }

                Ok(Some(json!({
                    "id": session_id,
                    "pid": pid,
                    "shell": shell,
                    "args": args,
                    "handledBy": "rust-primary"
                })))
            }
            "terminal.resize" => {
                let id = parse_required_u64(params, "id")?;
                let cols = parse_required_u64(params, "cols")?;
                let rows = parse_required_u64(params, "rows")?;
                let sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal session mutex poisoned".to_string())?;
                if !sessions.contains_key(&id) {
                    return Err(format!("terminal.resize unknown session id {id}"));
                }

                // PTY-specific resize is pending. Keep command contract stable for now.
                Ok(Some(json!({
                    "id": id,
                    "cols": cols,
                    "rows": rows,
                    "applied": false,
                    "note": "PTY resize not yet wired in rust-primary",
                    "handledBy": "rust-primary"
                })))
            }
            "terminal.write" => {
                let id = parse_required_u64(params, "id")?;
                let data = parse_required_string(params, "data")?;

                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal session mutex poisoned".to_string())?;
                let session = sessions
                    .get_mut(&id)
                    .ok_or_else(|| format!("terminal.write unknown session id {id}"))?;

                use std::io::Write;
                let stdin = session
                    .child
                    .stdin
                    .as_mut()
                    .ok_or_else(|| format!("terminal.write session {id} has no stdin"))?;
                stdin
                    .write_all(data.as_bytes())
                    .map_err(|error| format!("terminal.write failed for session {id}: {error}"))?;

                Ok(Some(json!({
                    "id": id,
                    "bytesWritten": data.len(),
                    "handledBy": "rust-primary"
                })))
            }
            "terminal.kill" => {
                let id = parse_required_u64(params, "id")?;
                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal session mutex poisoned".to_string())?;
                let mut session = sessions
                    .remove(&id)
                    .ok_or_else(|| format!("terminal.kill unknown session id {id}"))?;

                let _ = session.child.kill();
                let _ = session.child.wait();
                Ok(Some(json!({
                    "id": id,
                    "killed": true,
                    "handledBy": "rust-primary"
                })))
            }
            _ => Ok(None),
        }
    }
}

fn parse_required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "params must be an object".to_string())?;
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string param '{key}'"))
}

fn parse_required_u64(params: &Value, key: &str) -> Result<u64, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "params must be an object".to_string())?;
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing numeric param '{key}'"))
}

fn parse_optional_string_array(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(array) = value.as_array() else {
        return Err("args must be an array of strings".to_string());
    };

    array
        .iter()
        .map(|item| {
            item.as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "args must contain only strings".to_string())
        })
        .collect()
}

fn parse_optional_string_map(value: Option<&Value>) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let Some(map) = value.as_object() else {
        return Err("env must be an object of string values".to_string());
    };

    let mut output = BTreeMap::new();
    for (key, item) in map {
        let value = item
            .as_str()
            .ok_or_else(|| format!("env override '{key}' must be a string"))?;
        output.insert(key.clone(), value.to_string());
    }

    Ok(output)
}

fn spawn_terminal_data_pump<R>(
    id: u64,
    pid: u32,
    stream: &'static str,
    mut reader: R,
    app_handle: Option<tauri::AppHandle>,
) where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let Some(app_handle) = app_handle else {
            return;
        };

        let mut buffer = [0_u8; 4096];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(size) => size,
                Err(_) => break,
            };
            if read == 0 {
                break;
            }

            let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
            let _ = app_handle.emit(
                "terminal_data",
                json!({
                    "id": id,
                    "pid": pid,
                    "stream": stream,
                    "data": chunk
                }),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_requires_shell() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke("terminal.create", &json!({}))
            .await
            .expect_err("missing shell should return an error");
        assert!(error.contains("missing string param 'shell'"));
    }

    #[tokio::test]
    async fn resize_unknown_session_id_fails() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.resize",
                &json!({
                    "id": 999,
                    "cols": 80,
                    "rows": 24
                }),
            )
            .await
            .expect_err("unknown session id should fail");
        assert!(error.contains("terminal.resize unknown session id"));
    }

    #[tokio::test]
    async fn create_rejects_non_array_args() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.create",
                &json!({
                    "shell": "/bin/sh",
                    "args": "not-an-array"
                }),
            )
            .await
            .expect_err("non-array args should fail validation");
        assert!(error.contains("args must be an array of strings"));
    }

    #[tokio::test]
    async fn create_rejects_non_string_args() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.create",
                &json!({
                    "shell": "/bin/sh",
                    "args": ["-lc", 1]
                }),
            )
            .await
            .expect_err("non-string args should fail validation");
        assert!(error.contains("args must contain only strings"));
    }

    #[tokio::test]
    async fn create_rejects_non_object_env() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.create",
                &json!({
                    "shell": "/bin/sh",
                    "env": "not-an-object"
                }),
            )
            .await
            .expect_err("non-object env should fail validation");
        assert!(error.contains("env must be an object of string values"));
    }

    #[tokio::test]
    async fn resize_requires_cols_and_rows() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.resize",
                &json!({
                    "id": 1
                }),
            )
            .await
            .expect_err("missing cols/rows should fail");
        assert!(error.contains("missing numeric param 'cols'"));
    }

    #[tokio::test]
    async fn write_unknown_session_id_fails() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.write",
                &json!({
                    "id": 999,
                    "data": "echo hello\n"
                }),
            )
            .await
            .expect_err("unknown session id should fail");
        assert!(error.contains("terminal.write unknown session id"));
    }

    #[tokio::test]
    async fn write_requires_data() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.write",
                &json!({
                    "id": 1
                }),
            )
            .await
            .expect_err("missing data should fail");
        assert!(error.contains("missing string param 'data'"));
    }

    #[tokio::test]
    async fn kill_unknown_session_id_fails() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke(
                "terminal.kill",
                &json!({
                    "id": 999
                }),
            )
            .await
            .expect_err("unknown session id should fail");
        assert!(error.contains("terminal.kill unknown session id"));
    }

    #[tokio::test]
    async fn kill_requires_id() {
        let capability = RustPrimaryTerminalCapability::new();
        let error = capability
            .invoke("terminal.kill", &json!({}))
            .await
            .expect_err("missing id should fail");
        assert!(error.contains("missing numeric param 'id'"));
    }

    #[tokio::test]
    async fn unknown_method_returns_none() {
        let capability = RustPrimaryTerminalCapability::new();
        let result = capability
            .invoke("terminal.notImplemented", &json!({}))
            .await
            .expect("unknown method should not fail");
        assert!(result.is_none());
    }
}
