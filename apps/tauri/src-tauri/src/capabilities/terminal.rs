use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
#[cfg(not(unix))]
use std::process::Stdio;
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use libc::winsize;

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
    writer: Box<dyn Write + Send>,
    #[cfg(unix)]
    pty_master_fd: std::os::fd::RawFd,
}

struct SpawnedTerminal {
    child: Child,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    stream: &'static str,
    #[cfg(unix)]
    pty_master_fd: std::os::fd::RawFd,
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
                let cols = parse_optional_u16(params.get("cols"));
                let rows = parse_optional_u16(params.get("rows"));
                let env_overrides = parse_optional_string_map(params.get("env"))?;
                let initial_size = cols.zip(rows);
                if std::env::var("VSCODE_TAURI_INTEGRATION").ok().as_deref() == Some("1") {
                    eprintln!(
                        "[host.terminal.create] shell={} cwd={} args={:?} cols={:?} rows={:?} envKeys={}",
                        shell,
                        cwd.unwrap_or_default(),
                        args,
                        cols,
                        rows,
                        env_overrides.len()
                    );
                }
                let SpawnedTerminal {
                    child,
                    reader,
                    writer,
                    stream,
                    #[cfg(unix)]
                    pty_master_fd,
                } = spawn_terminal_process(shell, &args, cwd, &env_overrides, initial_size)
                    .map_err(|error| format!("terminal.create failed for '{shell}': {error}"))?;
                let pid = child.id();

                let session_id = self.next_id.fetch_add(1, Ordering::Relaxed);
                #[cfg(unix)]
                if let Some((cols, rows)) = initial_size {
                    resize_pty(pty_master_fd, cols, rows)
                        .map_err(|error| format!("terminal.create failed to size PTY: {error}"))?;
                }
                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal session mutex poisoned".to_string())?;
                sessions.insert(
                    session_id,
                    TerminalSession {
                        child,
                        writer,
                        #[cfg(unix)]
                        pty_master_fd,
                    },
                );
                drop(sessions);

                let app_handle = crate::capabilities::window::app_handle();
                spawn_terminal_data_pump(session_id, pid, stream, reader, app_handle);

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
                let session = sessions
                    .get(&id)
                    .ok_or_else(|| format!("terminal.resize unknown session id {id}"))?;
                #[cfg(unix)]
                resize_pty(session.pty_master_fd, cols as u16, rows as u16)
                    .map_err(|error| format!("terminal.resize failed for session {id}: {error}"))?;
                #[cfg(not(unix))]
                if session.child.id() == 0 {
                    return Err(format!("terminal.resize unknown session id {id}"));
                }

                Ok(Some(json!({
                    "id": id,
                    "cols": cols,
                    "rows": rows,
                    "applied": true,
                    "handledBy": "rust-primary"
                })))
            }
            "terminal.write" => {
                let id = parse_required_u64(params, "id")?;
                let data = parse_required_string(params, "data")?;
                let normalized_input = normalize_terminal_input(data);

                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal session mutex poisoned".to_string())?;
                let session = sessions
                    .get_mut(&id)
                    .ok_or_else(|| format!("terminal.write unknown session id {id}"))?;

                session
                    .writer
                    .write_all(normalized_input.as_bytes())
                    .map_err(|error| format!("terminal.write failed for session {id}: {error}"))?;
                session
                    .writer
                    .flush()
                    .map_err(|error| format!("terminal.write flush failed for session {id}: {error}"))?;
                if std::env::var("VSCODE_TAURI_INTEGRATION").ok().as_deref() == Some("1") {
                    let preview = normalized_input.replace('\n', "\\n").replace('\r', "\\r");
                    eprintln!(
                        "[host.terminal.write] id={id} bytes={} data={preview}",
                        normalized_input.len()
                    );
                }

                Ok(Some(json!({
                    "id": id,
                    "bytesWritten": normalized_input.len(),
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

fn spawn_terminal_process(
    shell: &str,
    args: &[String],
    cwd: Option<&str>,
    env_overrides: &BTreeMap<String, String>,
    initial_size: Option<(u16, u16)>,
) -> Result<SpawnedTerminal, String> {
    #[cfg(unix)]
    {
        spawn_terminal_process_with_pty(shell, args, cwd, env_overrides, initial_size)
    }

    #[cfg(not(unix))]
    {
        spawn_terminal_process_with_pipes(shell, args, cwd, env_overrides)
    }
}

#[cfg(unix)]
fn spawn_terminal_process_with_pty(
    shell: &str,
    args: &[String],
    cwd: Option<&str>,
    env_overrides: &BTreeMap<String, String>,
    initial_size: Option<(u16, u16)>,
) -> Result<SpawnedTerminal, String> {
    let mut master_fd = 0;
    let mut slave_fd = 0;
    let mut initial_winsize = initial_size.map(|(cols, rows)| winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    });
    let openpty_result = unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            initial_winsize
                .as_mut()
                .map(|winsize| winsize as *mut winsize)
                .unwrap_or(std::ptr::null_mut()),
        )
    };
    if openpty_result != 0 {
        return Err(format!("openpty failed: {}", std::io::Error::last_os_error()));
    }

    let master = unsafe { File::from_raw_fd(master_fd) };
    let slave = unsafe { File::from_raw_fd(slave_fd) };

    let cloexec_result = unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    if cloexec_result == -1 {
        return Err(format!(
            "fcntl(FD_CLOEXEC) failed for pty master: {}",
            std::io::Error::last_os_error()
        ));
    }

    let tty_fd = slave.as_raw_fd();

    let mut command = Command::new(shell);
    command.args(args);
    if let Some(cwd_path) = cwd {
        command.current_dir(cwd_path);
    }
    for (key, value) in env_overrides {
        command.env(key, value);
    }
    unsafe {
        command.pre_exec(move || {
            if libc::login_tty(tty_fd) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let child = command
        .spawn()
        .map_err(|error| format!("failed to spawn PTY-backed process: {error}"))?;
    drop(slave);
    let reader = master
        .try_clone()
        .map_err(|error| format!("failed to clone pty master: {error}"))?;

    Ok(SpawnedTerminal {
        child,
        reader: Box::new(reader),
        writer: Box::new(master),
        stream: "pty",
        pty_master_fd: master_fd,
    })
}

#[cfg(not(unix))]
fn spawn_terminal_process_with_pipes(
    shell: &str,
    args: &[String],
    cwd: Option<&str>,
    env_overrides: &BTreeMap<String, String>,
) -> Result<SpawnedTerminal, String> {
    let mut command = Command::new(shell);
    command
        .args(args)
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
        .map_err(|error| format!("failed to spawn pipe-backed process: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pipe-backed process is missing stdout".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pipe-backed process is missing stdin".to_string())?;

    Ok(SpawnedTerminal {
        child,
        reader: Box::new(stdout),
        writer: Box::new(stdin),
        stream: "stdout",
    })
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

fn normalize_terminal_input(data: &str) -> String {
    let mut normalized = String::with_capacity(data.len());
    let mut chars = data.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                normalized.push('\r');
            } else {
                normalized.push('\n');
            }
        } else {
            normalized.push(ch);
        }
    }
    normalized
}

fn parse_optional_u16(value: Option<&Value>) -> Option<u16> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
}

#[cfg(unix)]
fn resize_pty(fd: std::os::fd::RawFd, cols: u16, rows: u16) -> Result<(), String> {
    let winsize = winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &winsize) };
    if result == -1 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
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
            if std::env::var("VSCODE_TAURI_INTEGRATION").ok().as_deref() == Some("1") {
                let preview = chunk.replace('\n', "\\n").replace('\r', "\\r");
                eprintln!(
                    "[host.terminal.data] id={id} stream={stream} bytes={read} data={preview}"
                );
            }
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
    use std::time::Duration;

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

    #[cfg(unix)]
    #[test]
    fn pty_spawn_round_trips_interactive_shell_output() {
        let shell = if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        let mut env_overrides = BTreeMap::new();
        env_overrides.insert("A".to_string(), "~a2~".to_string());

        let SpawnedTerminal {
            mut child,
            reader,
            writer,
            ..
        } = spawn_terminal_process_with_pty(shell, &[], None, &env_overrides, Some((80, 24)))
            .expect("pty-backed shell should spawn");

        let (output_tx, output_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut output = String::new();
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(size) if size > 0 => {
                        output.push_str(&String::from_utf8_lossy(&buffer[..size]));
                        if output.contains("~a2~") {
                            let _ = output_tx.send(output);
                            return;
                        }
                    }
                    Ok(_) => {
                        let _ = output_tx.send(output);
                        return;
                    }
                    Err(error) => {
                        let _ = output_tx.send(format!("read error: {error}; output={output}"));
                        return;
                    }
                }
            }
        });

        std::thread::sleep(Duration::from_millis(200));
        let (write_tx, write_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut writer = writer;
            let result = writer
                .write_all(b"echo \"$A\"\n")
                .and_then(|_| writer.flush())
                .map(|_| ());
            let _ = write_tx.send(result);
        });
        let write_result = write_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("writing to the PTY should not block");
        write_result.expect("writing to the PTY should succeed");

        let output = output_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("PTY output should arrive");

        let _ = child.kill();
        let _ = child.wait();

        assert!(
            output.contains("~a2~"),
            "interactive PTY shell should expose the inherited environment, got {output:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pty_spawn_executes_command_sent_with_carriage_return() {
        let shell = if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        let mut env_overrides = BTreeMap::new();
        env_overrides.insert("A".to_string(), "~a2~".to_string());

        let SpawnedTerminal {
            mut child,
            reader,
            writer,
            ..
        } = spawn_terminal_process_with_pty(shell, &[], None, &env_overrides, Some((80, 24)))
            .expect("pty-backed shell should spawn");

        let (output_tx, output_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut output = String::new();
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(size) if size > 0 => {
                        output.push_str(&String::from_utf8_lossy(&buffer[..size]));
                        if output.contains("~a2~") {
                            let _ = output_tx.send(output);
                            return;
                        }
                    }
                    Ok(_) => {
                        let _ = output_tx.send(output);
                        return;
                    }
                    Err(error) => {
                        let _ = output_tx.send(format!("read error: {error}; output={output}"));
                        return;
                    }
                }
            }
        });

        std::thread::sleep(Duration::from_millis(200));
        let (write_tx, write_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut writer = writer;
            let input = normalize_terminal_input("echo \"$A\"\r");
            let result = writer
                .write_all(input.as_bytes())
                .and_then(|_| writer.flush())
                .map(|_| ());
            let _ = write_tx.send(result);
        });
        let write_result = write_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("writing carriage-return terminated input should not block");
        write_result.expect("writing carriage-return terminated input should succeed");

        let output = output_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("PTY output should arrive for carriage-return terminated input");

        let _ = child.kill();
        let _ = child.wait();

        assert!(
            output.contains("~a2~"),
            "interactive PTY shell should execute carriage-return terminated input, got {output:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_and_resize_apply_pty_dimensions() {
        let capability = RustPrimaryTerminalCapability::new();
        let create_result = capability
            .invoke(
                "terminal.create",
                &json!({
                    "shell": if std::path::Path::new("/bin/zsh").exists() { "/bin/zsh" } else { "/bin/sh" },
                    "cols": 91,
                    "rows": 33
                }),
            )
            .await
            .expect("terminal.create should succeed")
            .expect("terminal.create should return a payload");
        let session_id = create_result
            .get("id")
            .and_then(Value::as_u64)
            .expect("terminal.create should return an id");

        {
            let sessions = capability
                .sessions
                .lock()
                .expect("terminal sessions lock should succeed");
            let session = sessions
                .get(&session_id)
                .expect("terminal session should exist after create");
            let mut current_size = winsize {
                ws_row: 0,
                ws_col: 0,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            let result = unsafe { libc::ioctl(session.pty_master_fd, libc::TIOCGWINSZ, &mut current_size) };
            assert_ne!(result, -1, "initial TIOCGWINSZ should succeed");
            assert_eq!(current_size.ws_col, 91);
            assert_eq!(current_size.ws_row, 33);
        }

        capability
            .invoke(
                "terminal.resize",
                &json!({
                    "id": session_id,
                    "cols": 120,
                    "rows": 40
                }),
            )
            .await
            .expect("terminal.resize should succeed");

        {
            let sessions = capability
                .sessions
                .lock()
                .expect("terminal sessions lock should succeed");
            let session = sessions
                .get(&session_id)
                .expect("terminal session should exist after resize");
            let mut current_size = winsize {
                ws_row: 0,
                ws_col: 0,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            let result = unsafe { libc::ioctl(session.pty_master_fd, libc::TIOCGWINSZ, &mut current_size) };
            assert_ne!(result, -1, "resized TIOCGWINSZ should succeed");
            assert_eq!(current_size.ws_col, 120);
            assert_eq!(current_size.ws_row, 40);
        }

        capability
            .invoke("terminal.kill", &json!({ "id": session_id }))
            .await
            .expect("terminal.kill should succeed");
    }
}
