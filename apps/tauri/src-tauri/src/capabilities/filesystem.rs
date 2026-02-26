use async_trait::async_trait;
use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, UNIX_EPOCH};
use tauri::Emitter;

#[async_trait]
pub trait FilesystemCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryFilesystemCapability {
    next_watch_id: AtomicU64,
    watchers: Mutex<HashMap<String, WatchRegistration>>,
}

struct WatchRegistration {
    backend: WatchBackend,
}

enum WatchBackend {
    Native {
        _watcher: RecommendedWatcher,
    },
    Polling {
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    },
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct PathSnapshot {
    exists: bool,
    is_directory: bool,
    len: u64,
    modified_ms: Option<u64>,
    directory_fingerprint: Option<u64>,
}

impl PathSnapshot {
    fn missing() -> Self {
        Self {
            exists: false,
            is_directory: false,
            len: 0,
            modified_ms: None,
            directory_fingerprint: None,
        }
    }
}

impl RustPrimaryFilesystemCapability {
    pub fn new() -> Self {
        Self {
            next_watch_id: AtomicU64::new(1),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl FilesystemCapability for RustPrimaryFilesystemCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "filesystem.readFile" => {
                let path = parse_required_path(params, "path")?;
                let bytes = fs::read(&path).map_err(|error| {
                    format!("filesystem.readFile failed for {}: {error}", path.display())
                })?;

                match std::str::from_utf8(&bytes) {
                    Ok(text) => Ok(Some(json!({
                        "path": path,
                        "encoding": "utf8",
                        "contents": text
                    }))),
                    Err(_) => Ok(Some(json!({
                        "path": path,
                        "encoding": "base64",
                        "contents": base64_encode(&bytes)
                    }))),
                }
            }
            "filesystem.writeFile" => {
                let path = parse_required_path(params, "path")?;
                let contents = parse_required_string(params, "contents")?;
                let encoding = params
                    .get("encoding")
                    .and_then(Value::as_str)
                    .unwrap_or("utf8");
                let create_parents = params
                    .get("createParents")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);

                if create_parents {
                    if let Some(parent) = Path::new(&path).parent() {
                        if !parent.as_os_str().is_empty() {
                            fs::create_dir_all(parent).map_err(|error| {
                                format!(
                                    "filesystem.writeFile could not create parent {}: {error}",
                                    parent.display()
                                )
                            })?;
                        }
                    }
                }

                let payload = match encoding {
                    "utf8" => contents.as_bytes().to_vec(),
                    "base64" => base64_decode(contents)?,
                    other => {
                        return Err(format!(
                            "filesystem.writeFile unsupported encoding '{other}'. Use 'utf8' or 'base64'."
                        ));
                    }
                };

                fs::write(&path, &payload).map_err(|error| {
                    format!(
                        "filesystem.writeFile failed for {}: {error}",
                        path.display()
                    )
                })?;

                Ok(Some(json!({
                    "path": path,
                    "bytesWritten": payload.len(),
                    "encoding": encoding
                })))
            }
            "filesystem.stat" => {
                let path = parse_required_path(params, "path")?;
                let metadata = fs::metadata(&path).map_err(|error| {
                    format!("filesystem.stat failed for {}: {error}", path.display())
                })?;
                let modified_ms = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64);

                Ok(Some(json!({
                    "path": path,
                    "isFile": metadata.is_file(),
                    "isDirectory": metadata.is_dir(),
                    "len": metadata.len(),
                    "readonly": metadata.permissions().readonly(),
                    "modifiedMs": modified_ms
                })))
            }
            "filesystem.watch" => {
                let path = parse_required_path(params, "path")?;
                let recursive = params
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let force_polling = params
                    .get("forcePolling")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let poll_interval_ms = params
                    .get("pollIntervalMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(500)
                    .clamp(100, 5_000);

                let Some(app_handle) = crate::capabilities::window::app_handle() else {
                    return Ok(None);
                };

                let watch_id = parse_optional_watch_id(params, "watchId").unwrap_or_else(|| {
                    format!(
                        "watch-{}",
                        self.next_watch_id.fetch_add(1, Ordering::Relaxed)
                    )
                });

                let (registration, backend_name, native_error) = if !force_polling {
                    match start_native_watch(
                        watch_id.clone(),
                        path.clone(),
                        recursive,
                        app_handle.clone(),
                    ) {
                        Ok(watcher) => (
                            WatchRegistration {
                                backend: WatchBackend::Native { _watcher: watcher },
                            },
                            "native",
                            None,
                        ),
                        Err(error) => {
                            let polling = start_polling_watch(
                                watch_id.clone(),
                                path.clone(),
                                recursive,
                                Duration::from_millis(poll_interval_ms),
                                app_handle,
                            );
                            (polling, "polling", Some(error))
                        }
                    }
                } else {
                    let polling = start_polling_watch(
                        watch_id.clone(),
                        path.clone(),
                        recursive,
                        Duration::from_millis(poll_interval_ms),
                        app_handle,
                    );
                    (polling, "polling", None)
                };

                let mut watchers = self
                    .watchers
                    .lock()
                    .map_err(|_| "filesystem watcher registry lock poisoned".to_string())?;
                let previous = watchers.insert(watch_id.clone(), registration);
                if let Some(previous) = previous {
                    stop_watch_registration(previous);
                }

                Ok(Some(json!({
                    "watchId": watch_id,
                    "path": path,
                    "recursive": recursive,
                    "pollIntervalMs": poll_interval_ms,
                    "backend": backend_name,
                    "nativeError": native_error,
                    "handledBy": "rust-primary"
                })))
            }
            "filesystem.unwatch" => {
                let watch_id = parse_required_watch_id(params, "watchId")?;
                let registration = {
                    let mut watchers = self
                        .watchers
                        .lock()
                        .map_err(|_| "filesystem watcher registry lock poisoned".to_string())?;
                    watchers.remove(&watch_id)
                };

                if let Some(registration) = registration {
                    stop_watch_registration(registration);
                    Ok(Some(json!({
                        "watchId": watch_id,
                        "stopped": true,
                        "handledBy": "rust-primary"
                    })))
                } else {
                    Ok(Some(json!({
                        "watchId": watch_id,
                        "stopped": false,
                        "reason": "unknown watch id",
                        "handledBy": "rust-primary"
                    })))
                }
            }
            _ => Ok(None),
        }
    }
}

impl Drop for RustPrimaryFilesystemCapability {
    fn drop(&mut self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            for (_, registration) in watchers.drain() {
                stop_watch_registration(registration);
            }
        }
    }
}

fn parse_required_path(params: &Value, key: &str) -> Result<PathBuf, String> {
    let value = parse_required_string(params, key)?;
    Ok(PathBuf::from(value))
}

fn parse_required_watch_id(params: &Value, key: &str) -> Result<String, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "params must be an object".to_string())?;
    let value = object
        .get(key)
        .ok_or_else(|| format!("missing param '{key}'"))?;
    if let Some(text) = value.as_str() {
        return Ok(text.to_string());
    }
    if let Some(number) = value.as_u64() {
        return Ok(number.to_string());
    }
    Err(format!("param '{key}' must be a string or number"))
}

fn parse_optional_watch_id(params: &Value, key: &str) -> Option<String> {
    let object = params.as_object()?;
    let value = object.get(key)?;
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(number) = value.as_u64() {
        return Some(number.to_string());
    }
    if let Some(number) = value.as_i64() {
        return Some(number.to_string());
    }

    None
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

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut index = 0;
    while index < input.len() {
        let a = input[index];
        let b = if index + 1 < input.len() {
            input[index + 1]
        } else {
            0
        };
        let c = if index + 2 < input.len() {
            input[index + 2]
        } else {
            0
        };

        let triple = ((a as u32) << 16) | ((b as u32) << 8) | (c as u32);
        output.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        output.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);

        if index + 1 < input.len() {
            output.push(TABLE[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            output.push('=');
        }

        if index + 2 < input.len() {
            output.push(TABLE[(triple & 0x3F) as usize] as char);
        } else {
            output.push('=');
        }

        index += 3;
    }

    output
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();
    if trimmed.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }

    let mut output = Vec::with_capacity((trimmed.len() / 4) * 3);
    let bytes = trimmed.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let a = decode_base64_char(bytes[index])?;
        let b = decode_base64_char(bytes[index + 1])?;
        let c = if bytes[index + 2] == b'=' {
            None
        } else {
            Some(decode_base64_char(bytes[index + 2])?)
        };
        let d = if bytes[index + 3] == b'=' {
            None
        } else {
            Some(decode_base64_char(bytes[index + 3])?)
        };

        let triple = ((a as u32) << 18)
            | ((b as u32) << 12)
            | ((c.unwrap_or(0) as u32) << 6)
            | (d.unwrap_or(0) as u32);

        output.push(((triple >> 16) & 0xFF) as u8);
        if c.is_some() {
            output.push(((triple >> 8) & 0xFF) as u8);
        }
        if d.is_some() {
            output.push((triple & 0xFF) as u8);
        }

        index += 4;
    }

    Ok(output)
}

fn decode_base64_char(value: u8) -> Result<u8, String> {
    match value {
        b'A'..=b'Z' => Ok(value - b'A'),
        b'a'..=b'z' => Ok(value - b'a' + 26),
        b'0'..=b'9' => Ok(value - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(format!("invalid base64 character '{}'", value as char)),
    }
}

fn stop_watch_registration(registration: WatchRegistration) {
    match registration.backend {
        WatchBackend::Native { _watcher: _ } => {}
        WatchBackend::Polling { stop, mut handle } => {
            stop.store(true, Ordering::Relaxed);
            if let Some(join_handle) = handle.take() {
                let _ = join_handle.join();
            }
        }
    }
}

fn start_native_watch(
    watch_id: String,
    watch_path: PathBuf,
    recursive: bool,
    app_handle: tauri::AppHandle,
) -> Result<RecommendedWatcher, String> {
    let watch_id_for_cb = watch_id.clone();
    let watch_root_text = watch_path.to_string_lossy().to_string();
    let mut watcher = recommended_watcher(move |event: Result<Event, notify::Error>| {
        let Ok(event) = event else {
            return;
        };

        let kind = map_notify_event_kind(&event.kind);
        if event.paths.is_empty() {
            let _ = app_handle.emit(
                "filesystem_changed",
                json!({
                    "watchId": &watch_id_for_cb,
                    "path": &watch_root_text,
                    "kind": kind
                }),
            );
            return;
        }

        for path in event.paths {
            let _ = app_handle.emit(
                "filesystem_changed",
                json!({
                    "watchId": &watch_id_for_cb,
                    "path": path,
                    "kind": kind
                }),
            );
        }
    })
    .map_err(|error| {
        format!(
            "failed to create native watcher for '{}': {error}",
            watch_path.display()
        )
    })?;

    let recursive_mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher
        .watch(&watch_path, recursive_mode)
        .map_err(|error| {
            format!(
                "failed to start native watcher for '{}': {error}",
                watch_path.display()
            )
        })?;

    Ok(watcher)
}

fn map_notify_event_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "created",
        EventKind::Remove(_) => "deleted",
        EventKind::Modify(_) | EventKind::Access(_) | EventKind::Any | EventKind::Other => {
            "changed"
        }
    }
}

fn start_polling_watch(
    watch_id: String,
    watch_path: PathBuf,
    recursive: bool,
    poll_interval: Duration,
    app_handle: tauri::AppHandle,
) -> WatchRegistration {
    let stop = Arc::new(AtomicBool::new(false));
    let handle = start_watch_loop(
        watch_id,
        watch_path,
        recursive,
        poll_interval,
        stop.clone(),
        app_handle,
    );
    WatchRegistration {
        backend: WatchBackend::Polling {
            stop,
            handle: Some(handle),
        },
    }
}

fn start_watch_loop(
    watch_id: String,
    watch_path: PathBuf,
    recursive: bool,
    poll_interval: Duration,
    stop: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let watch_path_text = watch_path.to_string_lossy().to_string();
        let mut previous_snapshot =
            snapshot_path(&watch_path, recursive).unwrap_or_else(|_| PathSnapshot::missing());
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(poll_interval);
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let current_snapshot = match snapshot_path(&watch_path, recursive) {
                Ok(snapshot) => snapshot,
                Err(_) => continue,
            };
            if current_snapshot == previous_snapshot {
                continue;
            }

            let kind = detect_change_kind(&previous_snapshot, &current_snapshot);
            previous_snapshot = current_snapshot;
            let _ = app_handle.emit(
                "filesystem_changed",
                json!({
                    "watchId": watch_id,
                    "path": watch_path_text,
                    "kind": kind
                }),
            );
        }
    })
}

fn detect_change_kind(previous: &PathSnapshot, current: &PathSnapshot) -> &'static str {
    if !previous.exists && current.exists {
        "created"
    } else if previous.exists && !current.exists {
        "deleted"
    } else {
        "changed"
    }
}

fn snapshot_path(path: &Path, recursive: bool) -> Result<PathSnapshot, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PathSnapshot::missing())
        }
        Err(error) => {
            return Err(format!(
                "filesystem.watch failed to read metadata for {}: {error}",
                path.display()
            ))
        }
    };

    let is_directory = metadata.file_type().is_dir();
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    let len = if is_directory { 0 } else { metadata.len() };
    let directory_fingerprint = if is_directory {
        Some(snapshot_directory(path, recursive)?)
    } else {
        None
    };

    Ok(PathSnapshot {
        exists: true,
        is_directory,
        len,
        modified_ms,
        directory_fingerprint,
    })
}

fn snapshot_directory(path: &Path, recursive: bool) -> Result<u64, String> {
    let mut hasher = DefaultHasher::new();
    let mut pending = vec![path.to_path_buf()];

    while let Some(current) = pending.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(value) => value,
            Err(error) => {
                current.to_string_lossy().hash(&mut hasher);
                format!("{:?}", error.kind()).hash(&mut hasher);
                continue;
            }
        };

        let mut paths = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(value) => value,
                Err(_) => continue,
            };
            paths.push(entry.path());
        }
        paths.sort();

        for entry_path in paths {
            entry_path.to_string_lossy().hash(&mut hasher);
            let metadata = match fs::symlink_metadata(&entry_path) {
                Ok(value) => value,
                Err(_) => {
                    0_u8.hash(&mut hasher);
                    continue;
                }
            };

            let file_type = metadata.file_type();
            file_type.is_dir().hash(&mut hasher);
            file_type.is_symlink().hash(&mut hasher);
            metadata.len().hash(&mut hasher);
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .hash(&mut hasher);

            if recursive && file_type.is_dir() && !file_type.is_symlink() {
                pending.push(entry_path);
            }
        }
    }

    Ok(hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_file_path(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("vscode-tauri-filesystem-{prefix}-{nonce}.txt"))
    }

    #[tokio::test]
    async fn read_write_and_stat_roundtrip() {
        let capability = RustPrimaryFilesystemCapability::new();
        let path = temp_file_path("roundtrip");

        capability
            .invoke(
                "filesystem.writeFile",
                &json!({
                    "path": path.to_string_lossy(),
                    "contents": "hello from tauri"
                }),
            )
            .await
            .expect("writeFile should succeed");

        let read_result = capability
            .invoke(
                "filesystem.readFile",
                &json!({
                    "path": path.to_string_lossy()
                }),
            )
            .await
            .expect("readFile should succeed")
            .expect("readFile should return payload");
        assert_eq!(read_result["contents"], json!("hello from tauri"));

        let stat_result = capability
            .invoke(
                "filesystem.stat",
                &json!({
                    "path": path.to_string_lossy()
                }),
            )
            .await
            .expect("stat should succeed")
            .expect("stat should return payload");
        assert_eq!(stat_result["isFile"], json!(true));

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn watch_requires_app_handle_and_unwatch_unknown_id_is_stable() {
        let capability = RustPrimaryFilesystemCapability::new();
        let path = temp_file_path("watch");

        let watch_result = capability
            .invoke(
                "filesystem.watch",
                &json!({
                    "path": path.to_string_lossy()
                }),
            )
            .await
            .expect("watch should not error without app handle");
        assert!(watch_result.is_none());

        let unwatch_result = capability
            .invoke(
                "filesystem.unwatch",
                &json!({
                    "watchId": "unknown-watch-id"
                }),
            )
            .await
            .expect("unwatch should succeed")
            .expect("unwatch should return payload");
        assert_eq!(unwatch_result["stopped"], json!(false));
    }

    #[tokio::test]
    async fn write_file_rejects_unknown_encoding() {
        let capability = RustPrimaryFilesystemCapability::new();
        let path = temp_file_path("encoding");
        let error = capability
            .invoke(
                "filesystem.writeFile",
                &json!({
                    "path": path.to_string_lossy(),
                    "contents": "hello",
                    "encoding": "utf16"
                }),
            )
            .await
            .expect_err("unsupported encoding should fail");
        assert!(error.contains("unsupported encoding 'utf16'"));
    }

    #[tokio::test]
    async fn write_base64_roundtrips_through_read() {
        let capability = RustPrimaryFilesystemCapability::new();
        let path = temp_file_path("base64");
        let original_base64 = "AP8R";

        capability
            .invoke(
                "filesystem.writeFile",
                &json!({
                    "path": path.to_string_lossy(),
                    "contents": original_base64,
                    "encoding": "base64"
                }),
            )
            .await
            .expect("base64 write should succeed");

        let read_result = capability
            .invoke(
                "filesystem.readFile",
                &json!({
                    "path": path.to_string_lossy()
                }),
            )
            .await
            .expect("base64 read should succeed")
            .expect("read should return payload");
        assert_eq!(read_result["encoding"], json!("base64"));
        assert_eq!(read_result["contents"], json!(original_base64));

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn unwatch_requires_watch_id() {
        let capability = RustPrimaryFilesystemCapability::new();
        let error = capability
            .invoke("filesystem.unwatch", &json!({}))
            .await
            .expect_err("missing watchId should fail");
        assert!(error.contains("missing param 'watchId'"));
    }

    #[tokio::test]
    async fn read_file_missing_path_returns_error() {
        let capability = RustPrimaryFilesystemCapability::new();
        let path = temp_file_path("missing-read");

        let error = capability
            .invoke(
                "filesystem.readFile",
                &json!({
                    "path": path.to_string_lossy()
                }),
            )
            .await
            .expect_err("readFile on missing path should fail");
        assert!(error.contains("filesystem.readFile failed"));
    }

    #[tokio::test]
    async fn stat_missing_path_returns_error() {
        let capability = RustPrimaryFilesystemCapability::new();
        let path = temp_file_path("missing-stat");

        let error = capability
            .invoke(
                "filesystem.stat",
                &json!({
                    "path": path.to_string_lossy()
                }),
            )
            .await
            .expect_err("stat on missing path should fail");
        assert!(error.contains("filesystem.stat failed"));
    }

    #[tokio::test]
    async fn write_file_rejects_invalid_base64() {
        let capability = RustPrimaryFilesystemCapability::new();
        let path = temp_file_path("invalid-base64");

        let error = capability
            .invoke(
                "filesystem.writeFile",
                &json!({
                    "path": path.to_string_lossy(),
                    "contents": "abc",
                    "encoding": "base64"
                }),
            )
            .await
            .expect_err("invalid base64 should fail");
        assert!(error.contains("invalid base64 length"));
    }
}
