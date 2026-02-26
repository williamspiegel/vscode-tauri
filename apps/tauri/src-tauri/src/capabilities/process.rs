use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

#[async_trait]
pub trait ProcessCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryProcessCapability {
    managed: Arc<ManagedProcessState>,
}

struct ManagedProcessState {
    running: Mutex<HashMap<u32, RunningProcessInfo>>,
    completed: Mutex<HashMap<u32, CompletedProcessInfo>>,
}

#[derive(Clone)]
struct RunningProcessInfo {
    command: String,
    args: Vec<String>,
    started_ms: u64,
    child: Arc<Mutex<Child>>,
}

#[derive(Clone)]
struct CompletedProcessInfo {
    command: String,
    args: Vec<String>,
    started_ms: u64,
    ended_ms: u64,
    code: i32,
    success: bool,
}

impl RustPrimaryProcessCapability {
    pub fn new() -> Self {
        Self {
            managed: Arc::new(ManagedProcessState {
                running: Mutex::new(HashMap::new()),
                completed: Mutex::new(HashMap::new()),
            }),
        }
    }
}

#[async_trait]
impl ProcessCapability for RustPrimaryProcessCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "process.env" => {
                let env = std::env::vars().collect::<BTreeMap<String, String>>();
                Ok(Some(json!({ "env": env })))
            }
            "process.spawn" => {
                let command_name = parse_required_string(params, "command")?;
                let args = parse_string_array(params.get("args"))?;
                let cwd = params.get("cwd").and_then(Value::as_str);
                let env_overrides = parse_optional_string_map(params.get("env"))?;
                let background = params
                    .get("background")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);

                let mut command = Command::new(command_name);
                command.args(&args);
                if let Some(cwd_path) = cwd {
                    command.current_dir(cwd_path);
                }
                for (key, value) in env_overrides {
                    command.env(key, value);
                }

                if !background {
                    let output = command.output().map_err(|error| {
                        format!("process.spawn failed for '{command_name}': {error}")
                    })?;

                    return Ok(Some(json!({
                        "status": output.status.code(),
                        "success": output.status.success(),
                        "stdout": String::from_utf8_lossy(&output.stdout),
                        "stderr": String::from_utf8_lossy(&output.stderr),
                        "background": false,
                        "handledBy": "rust-primary"
                    })));
                }

                command
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                let mut child = command.spawn().map_err(|error| {
                    format!("process.spawn failed for '{command_name}': {error}")
                })?;
                let pid = child.id();
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                let child = Arc::new(Mutex::new(child));
                let started_ms = epoch_millis();

                {
                    let mut running = self
                        .managed
                        .running
                        .lock()
                        .map_err(|_| "managed process registry lock poisoned".to_string())?;
                    running.insert(
                        pid,
                        RunningProcessInfo {
                            command: command_name.to_string(),
                            args: args.clone(),
                            started_ms,
                            child: child.clone(),
                        },
                    );
                }

                let app_handle = crate::capabilities::window::app_handle();
                if let Some(stream) = stdout {
                    spawn_process_data_pump(pid, "stdout", stream, app_handle.clone());
                }
                if let Some(stream) = stderr {
                    spawn_process_data_pump(pid, "stderr", stream, app_handle.clone());
                }
                spawn_process_exit_watcher(
                    pid,
                    command_name.to_string(),
                    args.clone(),
                    started_ms,
                    child,
                    self.managed.clone(),
                    app_handle,
                );

                Ok(Some(json!({
                    "pid": pid,
                    "background": true,
                    "managed": true,
                    "command": command_name,
                    "args": args,
                    "startedMs": started_ms,
                    "handledBy": "rust-primary"
                })))
            }
            "process.kill" => {
                let pid = parse_required_u64(params, "pid")?;
                let signal = params
                    .get("signal")
                    .and_then(Value::as_str)
                    .unwrap_or("TERM");
                if signal.eq_ignore_ascii_case("KILL") {
                    if let Some(child) = self.get_managed_child(pid as u32)? {
                        let mut guard = child
                            .lock()
                            .map_err(|_| "managed process child lock poisoned".to_string())?;
                        guard.kill().map_err(|error| {
                            format!("process.kill failed for pid {pid}: {error}")
                        })?;
                    } else {
                        kill_process(pid, signal)?;
                    }
                } else {
                    kill_process(pid, signal)?;
                }

                Ok(Some(json!({
                    "pid": pid,
                    "killed": true,
                    "signal": signal,
                    "handledBy": "rust-primary"
                })))
            }
            "process.wait" => {
                let pid = parse_required_u64(params, "pid")? as u32;
                let timeout_ms = params.get("timeoutMs").and_then(Value::as_u64).unwrap_or(0);
                if let Some(completed) = self.get_completed_process(pid)? {
                    return Ok(Some(json!({
                        "pid": pid,
                        "exited": true,
                        "running": false,
                        "code": completed.code,
                        "success": completed.success,
                        "startedMs": completed.started_ms,
                        "endedMs": completed.ended_ms,
                        "handledBy": "rust-primary"
                    })));
                }

                let started = Instant::now();
                loop {
                    if let Some(completed) = self.get_completed_process(pid)? {
                        return Ok(Some(json!({
                            "pid": pid,
                            "exited": true,
                            "running": false,
                            "code": completed.code,
                            "success": completed.success,
                            "startedMs": completed.started_ms,
                            "endedMs": completed.ended_ms,
                            "handledBy": "rust-primary"
                        })));
                    }

                    let running = self.is_running(pid)?;
                    if !running {
                        return Ok(Some(json!({
                            "pid": pid,
                            "exited": false,
                            "running": false,
                            "known": false,
                            "handledBy": "rust-primary"
                        })));
                    }

                    if timeout_ms == 0 || started.elapsed() >= Duration::from_millis(timeout_ms) {
                        return Ok(Some(json!({
                            "pid": pid,
                            "exited": false,
                            "running": true,
                            "known": true,
                            "handledBy": "rust-primary"
                        })));
                    }

                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            "process.list" => {
                let running = self.running_snapshot()?;
                let completed = self.completed_snapshot()?;
                Ok(Some(json!({
                    "running": running,
                    "completed": completed,
                    "handledBy": "rust-primary"
                })))
            }
            _ => Ok(None),
        }
    }
}

impl RustPrimaryProcessCapability {
    fn get_managed_child(&self, pid: u32) -> Result<Option<Arc<Mutex<Child>>>, String> {
        let running = self
            .managed
            .running
            .lock()
            .map_err(|_| "managed process registry lock poisoned".to_string())?;
        Ok(running.get(&pid).map(|entry| entry.child.clone()))
    }

    fn get_completed_process(&self, pid: u32) -> Result<Option<CompletedProcessInfo>, String> {
        let completed = self
            .managed
            .completed
            .lock()
            .map_err(|_| "managed process completed lock poisoned".to_string())?;
        Ok(completed.get(&pid).cloned())
    }

    fn is_running(&self, pid: u32) -> Result<bool, String> {
        let running = self
            .managed
            .running
            .lock()
            .map_err(|_| "managed process registry lock poisoned".to_string())?;
        Ok(running.contains_key(&pid))
    }

    fn running_snapshot(&self) -> Result<Vec<Value>, String> {
        let running = self
            .managed
            .running
            .lock()
            .map_err(|_| "managed process registry lock poisoned".to_string())?;
        let mut rows = running
            .iter()
            .map(|(pid, info)| {
                json!({
                    "pid": pid,
                    "command": info.command,
                    "args": info.args,
                    "startedMs": info.started_ms,
                    "state": "running"
                })
            })
            .collect::<Vec<Value>>();
        rows.sort_by_key(|entry| entry.get("pid").and_then(Value::as_u64).unwrap_or(0));
        Ok(rows)
    }

    fn completed_snapshot(&self) -> Result<Vec<Value>, String> {
        let completed = self
            .managed
            .completed
            .lock()
            .map_err(|_| "managed process completed lock poisoned".to_string())?;
        let mut rows = completed
            .iter()
            .map(|(pid, info)| {
                json!({
                    "pid": pid,
                    "command": info.command,
                    "args": info.args,
                    "startedMs": info.started_ms,
                    "endedMs": info.ended_ms,
                    "code": info.code,
                    "success": info.success,
                    "state": "exited"
                })
            })
            .collect::<Vec<Value>>();
        rows.sort_by_key(|entry| entry.get("pid").and_then(Value::as_u64).unwrap_or(0));
        Ok(rows)
    }
}

impl Drop for RustPrimaryProcessCapability {
    fn drop(&mut self) {
        if let Ok(running) = self.managed.running.lock() {
            for entry in running.values() {
                if let Ok(mut child) = entry.child.lock() {
                    let _ = child.kill();
                }
            }
        }
    }
}

fn spawn_process_data_pump<R>(
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
                "process_data",
                json!({
                    "pid": pid,
                    "stream": stream,
                    "data": chunk
                }),
            );
        }
    });
}

fn spawn_process_exit_watcher(
    pid: u32,
    command: String,
    args: Vec<String>,
    started_ms: u64,
    child: Arc<Mutex<Child>>,
    state: Arc<ManagedProcessState>,
    app_handle: Option<tauri::AppHandle>,
) {
    std::thread::spawn(move || {
        let code = loop {
            let status = {
                let mut guard = match child.lock() {
                    Ok(value) => value,
                    Err(_) => break -1,
                };
                match guard.try_wait() {
                    Ok(result) => result,
                    Err(_) => break -1,
                }
            };

            if let Some(status) = status {
                break status.code().unwrap_or(-1);
            }
            std::thread::sleep(Duration::from_millis(50));
        };

        if let Ok(mut running) = state.running.lock() {
            running.remove(&pid);
        }
        let success = code == 0;
        let ended_ms = epoch_millis();
        if let Ok(mut completed) = state.completed.lock() {
            completed.insert(
                pid,
                CompletedProcessInfo {
                    command,
                    args,
                    started_ms,
                    ended_ms,
                    code,
                    success,
                },
            );
        }

        if let Some(handle) = app_handle {
            let _ = handle.emit(
                "process_exit",
                json!({
                    "pid": pid,
                    "code": code
                }),
            );
        }
    });
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

fn parse_string_array(value: Option<&Value>) -> Result<Vec<String>, String> {
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

fn kill_process(pid: u64, signal: &str) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("failed to invoke taskkill for pid {pid}: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "taskkill failed for pid {pid} with status {status}"
            ))
        }
    } else {
        let signal_flag = format!("-{signal}");
        let status = Command::new("kill")
            .args([&signal_flag, &pid.to_string()])
            .status()
            .map_err(|error| format!("failed to invoke kill for pid {pid}: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("kill failed for pid {pid} with status {status}"))
        }
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn process_env_returns_payload() {
        let capability = RustPrimaryProcessCapability::new();
        let result = capability
            .invoke("process.env", &json!({}))
            .await
            .expect("process.env should succeed")
            .expect("process.env should return payload");
        assert!(result.get("env").is_some());
    }

    #[tokio::test]
    async fn process_spawn_requires_command() {
        let capability = RustPrimaryProcessCapability::new();
        let error = capability
            .invoke("process.spawn", &json!({}))
            .await
            .expect_err("process.spawn without command should fail");
        assert!(error.contains("missing string param 'command'"));
    }

    #[tokio::test]
    async fn process_wait_requires_pid() {
        let capability = RustPrimaryProcessCapability::new();
        let error = capability
            .invoke("process.wait", &json!({}))
            .await
            .expect_err("process.wait without pid should fail");
        assert!(error.contains("missing numeric param 'pid'"));
    }

    #[tokio::test]
    async fn process_spawn_rejects_non_array_args() {
        let capability = RustPrimaryProcessCapability::new();
        let error = capability
            .invoke(
                "process.spawn",
                &json!({
                    "command": "echo",
                    "args": "not-an-array"
                }),
            )
            .await
            .expect_err("non-array args should fail validation");
        assert!(error.contains("args must be an array of strings"));
    }

    #[tokio::test]
    async fn unknown_method_returns_none() {
        let capability = RustPrimaryProcessCapability::new();
        let result = capability
            .invoke("process.notImplemented", &json!({}))
            .await
            .expect("unknown method should not fail");
        assert!(result.is_none());
    }
}
