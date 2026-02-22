#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capabilities;
mod metrics;
mod node_fallback;
mod protocol;
mod router;

use protocol::{
    error_response, ok_response, HandshakeRequest, HandshakeResponse, JsonRpcRequest,
    PROTOCOL_VERSION,
};
use router::CapabilityRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::{Emitter, Listener, Manager, State};
use tokio::io::AsyncReadExt;

struct ChannelSubscription {
    channel: String,
    event: String,
    arg: Value,
    runtime: SubscriptionRuntime,
}

enum SubscriptionRuntime {
    None,
    ReadFileStream {
        cancel: Arc<AtomicBool>,
        task: Option<tokio::task::JoinHandle<()>>,
    },
    ProfileStorageWatch {
        watch_id: String,
    },
}

struct ChannelRuntimeState {
    subscriptions: HashMap<String, ChannelSubscription>,
}

struct AppState {
    router: CapabilityRouter,
    repo_root: PathBuf,
    channel_runtime: Mutex<ChannelRuntimeState>,
    next_subscription_id: AtomicU64,
    cached_window_config: Mutex<Option<Value>>,
}

impl AppState {
    async fn register_subscription(
        &self,
        channel: String,
        event: String,
        arg: Value,
    ) -> Result<String, String> {
        let id = format!(
            "sub-{}",
            self.next_subscription_id.fetch_add(1, Ordering::Relaxed)
        );

        let runtime = self
            .build_subscription_runtime(&id, channel.as_str(), event.as_str(), &arg)
            .await?;
        let mut guard = self
            .channel_runtime
            .lock()
            .map_err(|_| "channel runtime lock poisoned".to_string())?;
        guard.subscriptions.insert(
            id.clone(),
            ChannelSubscription {
                channel,
                event,
                arg,
                runtime,
            },
        );

        Ok(id)
    }

    async fn remove_subscription(&self, id: &str) -> Result<bool, String> {
        let removed = {
            self.channel_runtime
                .lock()
                .map_err(|_| "channel runtime lock poisoned".to_string())?
                .subscriptions
                .remove(id)
        };

        if let Some(subscription) = removed {
            self.dispose_subscription_runtime(subscription.runtime)
                .await?;
            return Ok(true);
        }

        Ok(false)
    }

    fn window_config(&self) -> Result<Value, String> {
        if let Some(cached) = self
            .cached_window_config
            .lock()
            .map_err(|_| "window config cache lock poisoned".to_string())?
            .clone()
        {
            return Ok(cached);
        }

        let built = build_desktop_window_config(&self.repo_root)?;
        let mut guard = self
            .cached_window_config
            .lock()
            .map_err(|_| "window config cache lock poisoned".to_string())?;
        *guard = Some(built.clone());

        Ok(built)
    }

    async fn build_subscription_runtime(
        &self,
        subscription_id: &str,
        channel: &str,
        event: &str,
        arg: &Value,
    ) -> Result<SubscriptionRuntime, String> {
        if channel == "localFilesystem" && event == "readFileStream" {
            return Self::create_read_file_stream_runtime(subscription_id, arg);
        }
        if channel == "profileStorageListener" && event == "onDidChange" {
            return self
                .create_profile_storage_listener_runtime(subscription_id)
                .await;
        }

        Ok(SubscriptionRuntime::None)
    }

    fn create_read_file_stream_runtime(
        subscription_id: &str,
        arg: &Value,
    ) -> Result<SubscriptionRuntime, String> {
        let args = arg
            .as_array()
            .ok_or_else(|| "localFilesystem.readFileStream expects array argument".to_string())?;
        let resource = args.first().ok_or_else(|| {
            "localFilesystem.readFileStream missing resource argument".to_string()
        })?;
        let path = extract_fs_path(resource).ok_or_else(|| {
            "localFilesystem.readFileStream expects file URI/path resource".to_string()
        })?;

        let cancel = Arc::new(AtomicBool::new(false));
        let stream_cancel = cancel.clone();
        let stream_subscription_id = subscription_id.to_string();
        let task = tokio::spawn(async move {
            AppState::stream_read_file(stream_subscription_id, path, stream_cancel).await;
        });

        Ok(SubscriptionRuntime::ReadFileStream {
            cancel,
            task: Some(task),
        })
    }

    async fn stream_read_file(subscription_id: String, path: PathBuf, cancel: Arc<AtomicBool>) {
        const READ_CHUNK_SIZE: usize = 64 * 1024;
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(file) => file,
            Err(error) => {
                let (name, code) = io_error_name_and_code(&error);
                AppState::emit_channel_event(
                    &subscription_id,
                    "localFilesystem",
                    "readFileStream",
                    json!({
                        "name": name,
                        "code": code,
                        "message": format!("Unable to read file '{}': {error}", path.display())
                    }),
                );
                return;
            }
        };

        let mut buffer = vec![0u8; READ_CHUNK_SIZE];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return;
            }

            match file.read(&mut buffer).await {
                Ok(0) => {
                    AppState::emit_channel_event(
                        &subscription_id,
                        "localFilesystem",
                        "readFileStream",
                        Value::String("end".to_string()),
                    );
                    return;
                }
                Ok(bytes_read) => {
                    let chunk = &buffer[..bytes_read];
                    AppState::emit_channel_event(
                        &subscription_id,
                        "localFilesystem",
                        "readFileStream",
                        json!({
                            "buffer": chunk
                        }),
                    );
                }
                Err(error) => {
                    let (name, code) = io_error_name_and_code(&error);
                    AppState::emit_channel_event(
                        &subscription_id,
                        "localFilesystem",
                        "readFileStream",
                        json!({
                            "name": name,
                            "code": code,
                            "message": format!("Unable to read file '{}': {error}", path.display())
                        }),
                    );
                    return;
                }
            }
        }
    }

    async fn create_profile_storage_listener_runtime(
        &self,
        subscription_id: &str,
    ) -> Result<SubscriptionRuntime, String> {
        let watch_root = self
            .repo_root
            .join(".vscode-tauri")
            .join("user-data")
            .join("User");
        fs::create_dir_all(&watch_root).map_err(|error| {
            format!(
                "profileStorageListener failed to create watch root {}: {error}",
                watch_root.display()
            )
        })?;

        let watch_id = format!("profileStorage:{subscription_id}");
        self.router
            .dispatch(
                "filesystem.watch",
                &json!({
                    "path": watch_root.to_string_lossy(),
                    "recursive": true,
                    "watchId": watch_id
                }),
            )
            .await
            .map_err(|error| format!("profileStorageListener watch failed: {error}"))?;

        Ok(SubscriptionRuntime::ProfileStorageWatch { watch_id })
    }

    async fn dispose_subscription_runtime(
        &self,
        runtime: SubscriptionRuntime,
    ) -> Result<(), String> {
        match runtime {
            SubscriptionRuntime::None => {}
            SubscriptionRuntime::ReadFileStream { cancel, task } => {
                cancel.store(true, Ordering::Relaxed);
                if let Some(task) = task {
                    task.abort();
                }
            }
            SubscriptionRuntime::ProfileStorageWatch { watch_id } => {
                self.router
                    .dispatch(
                        "filesystem.unwatch",
                        &json!({
                            "watchId": watch_id
                        }),
                    )
                    .await
                    .map_err(|error| format!("profileStorageListener unwatch failed: {error}"))?;
            }
        }
        Ok(())
    }

    fn emit_channel_event(subscription_id: &str, channel: &str, event: &str, payload: Value) {
        if let Some(app_handle) = capabilities::window::app_handle() {
            let _ = app_handle.emit(
                "desktop_channel_event",
                json!({
                    "subscriptionId": subscription_id,
                    "channel": channel,
                    "event": event,
                    "payload": payload
                }),
            );
        }
    }

    fn emit_to_subscriptions<F>(
        &self,
        channel: &str,
        event: &str,
        payload: Value,
        predicate: F,
    ) -> Result<(), String>
    where
        F: Fn(&ChannelSubscription) -> bool,
    {
        let subscriptions = self
            .channel_runtime
            .lock()
            .map_err(|_| "channel runtime lock poisoned".to_string())?
            .subscriptions
            .iter()
            .filter_map(|(id, subscription)| {
                if subscription.channel == channel
                    && subscription.event == event
                    && predicate(subscription)
                {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        for subscription_id in subscriptions {
            Self::emit_channel_event(&subscription_id, channel, event, payload.clone());
        }

        Ok(())
    }

    fn handle_filesystem_changed(&self, payload_json: &str) -> Result<(), String> {
        let payload: Value = serde_json::from_str(payload_json)
            .map_err(|error| format!("Invalid filesystem.changed payload: {error}"))?;
        let watch_id = payload
            .get("watchId")
            .and_then(value_to_watch_id)
            .ok_or_else(|| "filesystem.changed payload missing watchId".to_string())?;
        let path = payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "filesystem.changed payload missing path".to_string())?;
        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("changed");

        if let Some(session_id) = watch_id_to_localfs_session_id(&watch_id) {
            let change = json!([{
                "type": file_change_type_from_kind(kind),
                "resource": file_uri_components(Path::new(path))
            }]);

            return self.emit_to_subscriptions(
                "localFilesystem",
                "fileChange",
                change,
                |subscription| {
                    local_filesystem_subscription_matches_session(subscription, session_id)
                },
            );
        }

        if let Some(changes) = self
            .router
            .watcher_changes_from_filesystem_event(&watch_id, path, kind)
        {
            self.emit_to_subscriptions("watcher", "onDidChangeFile", changes, |_| true)?;
            if self.router.watcher_verbose_logging() {
                let _ = self.emit_to_subscriptions(
                    "watcher",
                    "onDidLogMessage",
                    json!({
                        "type": "trace",
                        "message": format!("watcher event: {kind} {path}")
                    }),
                    |_| true,
                );
            }
        }

        if watch_id.starts_with("profileStorage:") {
            if let Some(payload) =
                profile_storage_change_payload(Path::new(path), kind, &self.repo_root)
            {
                self.emit_to_subscriptions(
                    "profileStorageListener",
                    "onDidChange",
                    payload,
                    |_| true,
                )?;
            }
        }

        Ok(())
    }
}

#[tauri::command]
async fn host_invoke(
    request: JsonRpcRequest,
    state: State<'_, AppState>,
) -> Result<protocol::JsonRpcResponse, String> {
    if request.jsonrpc != "2.0" {
        return Ok(error_response(
            request.id,
            -32600,
            "Invalid jsonrpc version",
        ));
    }

    if request.method == "protocol.handshake" {
        let parse = serde_json::from_value::<HandshakeRequest>(request.params.clone());
        let handshake = match parse {
            Ok(value) => value,
            Err(error) => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    format!("Invalid handshake params: {error}"),
                ));
            }
        };

        if handshake.protocol_version != PROTOCOL_VERSION {
            return Ok(error_response(
                request.id,
                1001,
                format!(
                    "Unsupported protocol version {}. Expected {}",
                    handshake.protocol_version, PROTOCOL_VERSION
                ),
            ));
        }

        let response = HandshakeResponse {
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_name: "vscode-tauri-host".to_string(),
            server_version: "0.1.0".to_string(),
            supported_capabilities: vec![
                "host".to_string(),
                "desktop".to_string(),
                "window".to_string(),
                "filesystem".to_string(),
                "terminal".to_string(),
                "clipboard".to_string(),
                "dialogs".to_string(),
                "process".to_string(),
                "power".to_string(),
                "os".to_string(),
                "update".to_string(),
            ],
        };

        return Ok(ok_response(
            request.id,
            serde_json::to_value(response).unwrap_or(Value::Null),
        ));
    }

    if request.method == "host.fallbackCounts" {
        return Ok(ok_response(
            request.id,
            json!(state.router.fallback_counts()),
        ));
    }

    if request.method == "host.cssModules" {
        return match workbench_css_modules() {
            Ok(modules) => Ok(ok_response(request.id, json!({ "modules": modules }))),
            Err(error) => Ok(error_response(request.id, -32603, error)),
        };
    }

    if request.method == "desktop.resolveWindowConfig" {
        return match state.window_config() {
            Ok(config) => Ok(ok_response(request.id, config)),
            Err(error) => Ok(error_response(request.id, -32603, error)),
        };
    }

    if request.method == "desktop.channelCall" {
        let object = match request.params.as_object() {
            Some(value) => value,
            None => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    "desktop.channelCall expects object params",
                ));
            }
        };
        let channel = match required_string_param(object, "channel") {
            Ok(value) => value,
            Err(error) => return Ok(error_response(request.id, -32602, error)),
        };
        let method = match required_string_param(object, "method") {
            Ok(value) => value,
            Err(error) => return Ok(error_response(request.id, -32602, error)),
        };
        let args = object
            .get("args")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));

        return match state
            .router
            .dispatch_channel(&channel, &method, &args)
            .await
        {
            Ok(value) => Ok(ok_response(request.id, value)),
            Err(error) => Ok(error_response(request.id, 1003, error)),
        };
    }

    if request.method == "desktop.channelListen" {
        let object = match request.params.as_object() {
            Some(value) => value,
            None => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    "desktop.channelListen expects object params",
                ));
            }
        };

        let channel = match required_string_param(object, "channel") {
            Ok(value) => value,
            Err(error) => return Ok(error_response(request.id, -32602, error)),
        };
        let event = match required_string_param(object, "event") {
            Ok(value) => value,
            Err(error) => return Ok(error_response(request.id, -32602, error)),
        };
        let arg = object.get("arg").cloned().unwrap_or(Value::Null);

        return match state.register_subscription(channel, event, arg).await {
            Ok(subscription_id) => Ok(ok_response(
                request.id,
                json!({ "subscriptionId": subscription_id }),
            )),
            Err(error) => Ok(error_response(request.id, -32603, error)),
        };
    }

    if request.method == "desktop.channelUnlisten" {
        let object = match request.params.as_object() {
            Some(value) => value,
            None => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    "desktop.channelUnlisten expects object params",
                ));
            }
        };
        let subscription_id = match required_string_param(object, "subscriptionId") {
            Ok(value) => value,
            Err(error) => return Ok(error_response(request.id, -32602, error)),
        };

        return match state.remove_subscription(&subscription_id).await {
            Ok(removed) => Ok(ok_response(request.id, json!({ "removed": removed }))),
            Err(error) => Ok(error_response(request.id, -32603, error)),
        };
    }

    match state
        .router
        .dispatch(&request.method, &request.params)
        .await
    {
        Ok(result) => Ok(ok_response(request.id, result)),
        Err(error) => Ok(error_response(request.id, 1003, error)),
    }
}

fn required_string_param(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("missing string param '{key}'"))
}

fn build_desktop_window_config(repo_root: &Path) -> Result<Value, String> {
    let nls_messages = read_nls_messages(repo_root)?;
    let product = read_json_file(&repo_root.join("product.json"))?;
    let css_modules = workbench_css_modules()?;

    let home_dir = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    let tmp_dir = std::env::temp_dir();
    let user_data_dir = repo_root.join(".vscode-tauri").join("user-data");
    let _ = fs::create_dir_all(&user_data_dir);
    let _ = fs::create_dir_all(user_data_dir.join("User/profiles/default"));
    let builtin_extensions_dir = repo_root.join("extensions");
    let user_extensions_dir = user_data_dir.join("extensions");
    let _ = fs::create_dir_all(&user_extensions_dir);

    let profile_home = user_data_dir.join("User/profiles");
    let profile_location = profile_home.join("default");
    let profile_cache = user_data_dir.join("CachedProfilesData/default");
    let default_profile = json!({
        "id": "default",
        "isDefault": true,
        "name": "Default",
        "location": file_uri_components(&profile_location),
        "globalStorageHome": file_uri_components(&profile_location.join("globalStorage")),
        "settingsResource": file_uri_components(&profile_location.join("settings.json")),
        "keybindingsResource": file_uri_components(&profile_location.join("keybindings.json")),
        "tasksResource": file_uri_components(&profile_location.join("tasks.json")),
        "snippetsHome": file_uri_components(&profile_location.join("snippets")),
        "promptsHome": file_uri_components(&profile_location.join("prompts")),
        "extensionsResource": file_uri_components(&profile_location.join("extensions.json")),
        "mcpResource": file_uri_components(&profile_location.join("mcp.json")),
        "cacheHome": file_uri_components(&profile_cache)
    });

    let mut user_env: BTreeMap<String, String> = std::env::vars().collect();
    user_env
        .entry("VSCODE_CWD".to_string())
        .or_insert_with(|| repo_root.to_string_lossy().to_string());
    user_env.insert(
        "VSCODE_DESKTOP_RUNTIME".to_string(),
        "electrobun".to_string(),
    );
    user_env
        .entry("VSCODE_ELECTROBUN_DISABLE_MESSAGEPORT".to_string())
        .or_insert_with(|| "true".to_string());

    let window_config = json!({
        "windowId": 1,
        "appRoot": repo_root.to_string_lossy(),
        "userEnv": user_env,
        "product": product,
        "zoomLevel": 0,
        "codeCachePath": user_data_dir.join("Code Cache").to_string_lossy(),
        "nls": {
            "messages": nls_messages,
            "language": "en"
        },
        "cssModules": css_modules,
        "_": [],
        "builtin-extensions-dir": builtin_extensions_dir.to_string_lossy(),
        "extensions-dir": user_extensions_dir.to_string_lossy(),

        "mainPid": std::process::id(),
        "machineId": "tauri-machine-id",
        "sqmId": "tauri-sqm-id",
        "devDeviceId": "tauri-dev-device-id",
        "isPortable": false,

        "execPath": std::env::current_exe()
            .unwrap_or_else(|_| PathBuf::from("code-tauri"))
            .to_string_lossy(),
        "backupPath": user_data_dir.join("Backups").to_string_lossy(),

        "profiles": {
            "home": file_uri_components(&profile_home),
            "all": [default_profile.clone()],
            "profile": default_profile
        },

        "homeDir": home_dir,
        "tmpDir": tmp_dir.to_string_lossy(),
        "userDataDir": user_data_dir.to_string_lossy(),

        "workspace": Value::Null,
        "isInitialStartup": true,
        "logLevel": 3,
        "loggers": [],

        "fullscreen": false,
        "maximized": false,
        "accessibilitySupport": false,
        "colorScheme": {
            "dark": false,
            "highContrast": false
        },
        "autoDetectHighContrast": false,
        "autoDetectColorScheme": false,
        "isCustomZoomLevel": false,

        "perfMarks": [],

        "os": {
            "release": os_release(),
            "hostname": std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".to_string()),
            "arch": std::env::consts::ARCH
        },
        "isSessionsWindow": false
    });

    Ok(window_config)
}

fn file_uri_components(path: &Path) -> Value {
    let raw = path.to_string_lossy().replace('\\', "/");
    let path = if raw.starts_with('/') {
        raw
    } else {
        format!("/{raw}")
    };

    json!({
        "scheme": "file",
        "authority": "",
        "path": path
    })
}

fn extract_fs_path(value: &Value) -> Option<PathBuf> {
    if let Some(text) = value.as_str() {
        return Some(normalize_file_uri_path(text));
    }

    let object = value.as_object()?;
    if let Some(fs_path) = object.get("fsPath").and_then(Value::as_str) {
        return Some(PathBuf::from(fs_path));
    }
    if let Some(path) = object.get("path").and_then(Value::as_str) {
        return Some(normalize_file_uri_path(path));
    }

    None
}

fn normalize_file_uri_path(raw: &str) -> PathBuf {
    if let Some(stripped) = raw.strip_prefix("file://") {
        if let Some(without_localhost) = stripped.strip_prefix("localhost/") {
            return PathBuf::from(format!("/{without_localhost}"));
        }
        if stripped.starts_with('/') {
            return PathBuf::from(stripped);
        }
        return PathBuf::from(format!("/{stripped}"));
    }
    PathBuf::from(raw)
}

fn io_error_name_and_code(error: &io::Error) -> (&'static str, &'static str) {
    match error.kind() {
        io::ErrorKind::NotFound => ("EntryNotFound (FileSystemError)", "EntryNotFound"),
        io::ErrorKind::PermissionDenied => ("NoPermissions (FileSystemError)", "NoPermissions"),
        io::ErrorKind::AlreadyExists => ("EntryExists (FileSystemError)", "EntryExists"),
        io::ErrorKind::IsADirectory => ("EntryIsADirectory (FileSystemError)", "EntryIsADirectory"),
        io::ErrorKind::NotADirectory => ("EntryNotADirectory (FileSystemError)", "EntryNotADirectory"),
        _ => ("Unknown (FileSystemError)", "Unknown"),
    }
}

fn value_to_watch_id(value: &Value) -> Option<String> {
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

fn watch_id_to_localfs_session_id(watch_id: &str) -> Option<&str> {
    let remainder = watch_id.strip_prefix("localfs:")?;
    let (session_id, _request_id) = remainder.split_once(':')?;
    Some(session_id)
}

fn file_change_type_from_kind(kind: &str) -> u32 {
    match kind {
        "created" => 1,
        "deleted" => 2,
        _ => 0,
    }
}

fn local_filesystem_subscription_matches_session(
    subscription: &ChannelSubscription,
    session_id: &str,
) -> bool {
    if let Some(arg_session_id) = subscription.arg.as_str() {
        return arg_session_id == session_id;
    }

    if let Some(args) = subscription.arg.as_array() {
        return args
            .first()
            .and_then(Value::as_str)
            .map(|value| value == session_id)
            .unwrap_or(false);
    }

    if let Some(object) = subscription.arg.as_object() {
        return object
            .get("sessionId")
            .and_then(Value::as_str)
            .map(|value| value == session_id)
            .unwrap_or(false);
    }

    false
}

fn profile_storage_change_payload(path: &Path, kind: &str, repo_root: &Path) -> Option<Value> {
    let user_root = repo_root
        .join(".vscode-tauri")
        .join("user-data")
        .join("User");
    if !path.starts_with(&user_root) {
        return None;
    }

    let profiles_root = user_root.join("profiles");
    let (profile_id, key) = if path.starts_with(&profiles_root) {
        let relative = path.strip_prefix(&profiles_root).ok()?;
        let mut components = relative.components();
        let profile_id = components.next()?.as_os_str().to_string_lossy().to_string();
        if profile_id.is_empty() {
            return None;
        }
        let profile_root = profiles_root.join(&profile_id);
        let key = profile_storage_key(path.strip_prefix(&profile_root).ok());
        (profile_id, key)
    } else {
        (
            "default".to_string(),
            profile_storage_key(path.strip_prefix(&user_root).ok()),
        )
    };

    let profile = profile_descriptor(repo_root, &profile_id);
    let target = if kind == "deleted" {
        Value::Null
    } else {
        json!(0)
    };

    Some(json!({
        "targetChanges": [profile.clone()],
        "valueChanges": [{
            "profile": profile,
            "changes": [{
                "key": key,
                "scope": 0,
                "target": target
            }]
        }]
    }))
}

fn profile_storage_key(relative: Option<&Path>) -> String {
    let Some(relative) = relative else {
        return "*".to_string();
    };
    if relative.as_os_str().is_empty() {
        return "*".to_string();
    }
    let mut key = relative.to_string_lossy().replace('\\', "/");
    while key.starts_with('/') {
        key.remove(0);
    }
    if key.is_empty() {
        "*".to_string()
    } else {
        key
    }
}

fn profile_descriptor(repo_root: &Path, profile_id: &str) -> Value {
    let user_root = repo_root
        .join(".vscode-tauri")
        .join("user-data")
        .join("User");
    let profile_root = user_root.join("profiles").join(profile_id);
    let cache_home = repo_root
        .join(".vscode-tauri")
        .join("user-data")
        .join("CachedProfilesData")
        .join(profile_id);

    let profile_name = if profile_id == "default" {
        "Default".to_string()
    } else {
        profile_id.to_string()
    };

    json!({
        "id": profile_id,
        "isDefault": profile_id == "default",
        "name": profile_name,
        "location": file_uri_components(&profile_root),
        "globalStorageHome": file_uri_components(&profile_root.join("globalStorage")),
        "settingsResource": file_uri_components(&profile_root.join("settings.json")),
        "keybindingsResource": file_uri_components(&profile_root.join("keybindings.json")),
        "tasksResource": file_uri_components(&profile_root.join("tasks.json")),
        "snippetsHome": file_uri_components(&profile_root.join("snippets")),
        "promptsHome": file_uri_components(&profile_root.join("prompts")),
        "extensionsResource": file_uri_components(&profile_root.join("extensions.json")),
        "mcpResource": file_uri_components(&profile_root.join("mcp.json")),
        "cacheHome": file_uri_components(&cache_home)
    })
}

fn read_nls_messages(repo_root: &Path) -> Result<Vec<String>, String> {
    let path = repo_root.join("out/nls.messages.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            // Tauri dev mode can run with a transpiled `out` tree that does not
            // include NLS artifacts. Falling back to an empty message table keeps
            // startup alive; UI strings can still render from default literals.
            eprintln!(
                "warning: missing NLS messages at {}: {error}; using empty messages",
                path.display()
            );
            return Ok(Vec::new());
        }
    };
    match serde_json::from_slice::<Vec<String>>(&bytes) {
        Ok(messages) => Ok(messages),
        Err(error) => {
            eprintln!(
                "warning: failed to parse NLS messages at {}: {error}; using empty messages",
                path.display()
            );
            Ok(Vec::new())
        }
    }
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

fn os_release() -> String {
    if cfg!(target_os = "macos") {
        if let Ok(output) = std::process::Command::new("uname").arg("-r").output() {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
        }
    }

    "0.0.0".to_string()
}

fn workbench_css_modules() -> Result<Vec<String>, String> {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR")
            .map_err(|error| format!("Failed to read CARGO_MANIFEST_DIR: {error}"))?,
    );

    let out_root = manifest_dir.join("../../..").join("out");
    let vs_root = out_root.join("vs");
    let cache_path = manifest_dir.join("../ui/.cache/css-modules.json");
    let cache_dependency = out_root.join("vs/workbench/workbench.web.main.internal.js");
    if !vs_root.exists() {
        return Err(format!(
            "Missing VS Code out directory at {}",
            vs_root.display()
        ));
    }

    if let Some(cached) = read_css_module_manifest(&cache_path, &cache_dependency)? {
        return Ok(cached);
    }

    let mut modules = Vec::new();
    collect_css_modules(&vs_root, &out_root, &mut modules)?;
    modules.sort();
    let _ = write_css_module_manifest(&cache_path, &modules);
    Ok(modules)
}

fn collect_css_modules(
    current_dir: &Path,
    out_root: &Path,
    modules: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(current_dir)
        .map_err(|error| format!("Failed to read {}: {error}", current_dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let path = entry.path();

        if path.is_dir() {
            collect_css_modules(&path, out_root, modules)?;
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("css") {
            continue;
        }

        let relative = path.strip_prefix(out_root).map_err(|error| {
            format!(
                "Failed to compute relative CSS path for {}: {error}",
                path.display()
            )
        })?;

        let module = relative
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        modules.push(module);
    }

    Ok(())
}

fn read_css_module_manifest(
    manifest_path: &Path,
    dependency_path: &Path,
) -> Result<Option<Vec<String>>, String> {
    if !manifest_path.exists() {
        return Ok(None);
    }

    let dependency_modified = fs::metadata(dependency_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    let manifest_modified = fs::metadata(manifest_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    if is_stale_manifest(manifest_modified, dependency_modified) {
        return Ok(None);
    }

    let bytes = fs::read(manifest_path).map_err(|error| {
        format!(
            "Failed to read CSS module manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let modules = serde_json::from_slice::<Vec<String>>(&bytes).map_err(|error| {
        format!(
            "Failed to parse CSS module manifest {}: {error}",
            manifest_path.display()
        )
    })?;

    Ok(Some(modules))
}

fn write_css_module_manifest(manifest_path: &Path, modules: &[String]) -> Result<(), String> {
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create CSS module manifest directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let payload = serde_json::to_vec(modules).map_err(|error| {
        format!(
            "Failed to encode CSS module manifest {}: {error}",
            manifest_path.display()
        )
    })?;

    fs::write(manifest_path, payload).map_err(|error| {
        format!(
            "Failed to write CSS module manifest {}: {error}",
            manifest_path.display()
        )
    })
}

fn is_stale_manifest(
    manifest_modified: Option<SystemTime>,
    dependency_modified: Option<SystemTime>,
) -> bool {
    match (manifest_modified, dependency_modified) {
        (Some(manifest), Some(dependency)) => manifest < dependency,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_change_type_mapping_is_stable() {
        assert_eq!(file_change_type_from_kind("changed"), 0);
        assert_eq!(file_change_type_from_kind("created"), 1);
        assert_eq!(file_change_type_from_kind("deleted"), 2);
        assert_eq!(file_change_type_from_kind("unknown"), 0);
    }

    #[test]
    fn localfs_watch_id_extracts_session() {
        assert_eq!(
            watch_id_to_localfs_session_id("localfs:abc123:req1"),
            Some("abc123")
        );
        assert_eq!(watch_id_to_localfs_session_id("watcher:abc123:req1"), None);
        assert_eq!(watch_id_to_localfs_session_id("localfs:onlyonepart"), None);
    }

    #[test]
    fn profile_storage_payload_contains_profile_change() {
        let repo_root = PathBuf::from("/tmp/vscode-tauri-tests");
        let path = repo_root
            .join(".vscode-tauri")
            .join("user-data")
            .join("User")
            .join("profiles")
            .join("default")
            .join("settings.json");

        let payload = profile_storage_change_payload(&path, "changed", &repo_root)
            .expect("profile storage payload should be generated");
        let target_changes = payload
            .get("targetChanges")
            .and_then(Value::as_array)
            .expect("targetChanges should be an array");
        assert_eq!(target_changes.len(), 1);
        assert_eq!(
            target_changes
                .first()
                .and_then(|profile| profile.get("id"))
                .and_then(Value::as_str),
            Some("default")
        );
    }
}

fn main() {
    let fallback_script = PathBuf::from("../node/fallback.mjs");
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));
    let repo_root = manifest_dir
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| manifest_dir.join("../../.."));

    let app_state = AppState {
        router: CapabilityRouter::new(fallback_script),
        repo_root,
        channel_runtime: Mutex::new(ChannelRuntimeState {
            subscriptions: HashMap::new(),
        }),
        next_subscription_id: AtomicU64::new(1),
        cached_window_config: Mutex::new(None),
    };

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.show();
            }
        }))
        .setup(|app| {
            capabilities::window::set_app_handle(app.handle().clone());
            let app_handle = app.handle().clone();
            let listener_handle = app_handle.clone();
            app_handle.listen("filesystem_changed", move |event| {
                let payload = event.payload();
                if payload.is_empty() {
                    return;
                }

                let state = listener_handle.state::<AppState>();
                if let Err(error) = state.handle_filesystem_changed(payload) {
                    eprintln!("[desktop.fs.bridge.error] {error}");
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("host_lifecycle", json!({ "event": "setup" }));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![host_invoke])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
