#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capabilities;
mod protocol;
mod router;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protocol::{
    error_response, ok_response, HandshakeRequest, HandshakeResponse, JsonRpcRequest,
    PROTOCOL_VERSION,
};
use router::CapabilityRouter;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::LogicalPosition;
use tauri::{Emitter, Listener, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as AsyncMutex;

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

#[derive(Default)]
struct ExtensionHostRuntimeState {
    sessions_by_id: HashMap<String, ExtensionHostSession>,
    id_by_nonce: HashMap<String, String>,
}

struct ExtensionHostSession {
    nonce: Option<String>,
    pid: Option<u32>,
    stdin: Option<Arc<AsyncMutex<tokio::process::ChildStdin>>>,
}

impl ExtensionHostSession {
    fn new() -> Self {
        Self {
            nonce: None,
            pid: None,
            stdin: None,
        }
    }
}

#[derive(Default)]
struct ContextMenuRuntimeState {
    active_by_context_menu_id: HashMap<i64, ActiveContextMenu>,
    item_by_native_menu_id: HashMap<String, ActiveContextMenuItem>,
}

struct ActiveContextMenu {
    native_menu_item_ids: Vec<String>,
}

#[derive(Clone)]
struct ActiveContextMenuItem {
    context_menu_id: i64,
    on_click_channel: String,
    item_id: i64,
}

struct AppState {
    router: CapabilityRouter,
    repo_root: PathBuf,
    channel_runtime: Arc<Mutex<ChannelRuntimeState>>,
    extension_host_runtime: Arc<Mutex<ExtensionHostRuntimeState>>,
    next_extension_host_id: AtomicU64,
    context_menu_runtime: Mutex<ContextMenuRuntimeState>,
    next_subscription_id: AtomicU64,
    cached_window_config: Mutex<Option<Value>>,
}

static INTEGRATION_STARTUP_RENDERED: AtomicBool = AtomicBool::new(false);
static INTEGRATION_STARTUP_LAST_PROGRESS: Mutex<Option<String>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostHttpRequestParams {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: Option<HashMap<String, Value>>,
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostHttpResponsePayload {
    status_code: u16,
    headers: BTreeMap<String, Value>,
    body_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionHostBridgeConfig {
    entry_point: String,
    args: Vec<String>,
    exec_argv: Vec<String>,
    env: Vec<ExtensionHostBridgeEnvEntry>,
    vscode_version: String,
}

#[derive(Serialize)]
struct ExtensionHostBridgeEnvEntry {
    key: String,
    value: Option<String>,
}

impl AppState {
    fn handle_ipc_send(&self, method: &str, args: &Value) -> Result<Value, String> {
        match method {
            IPC_CONTEXT_MENU_CHANNEL => {
                self.handle_ipc_context_menu(args)?;
                Ok(Value::Null)
            }
            _ => Ok(Value::Null),
        }
    }

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

        if is_integration_startup_watchdog_enabled() && channel == "extensionHostStarter" {
            eprintln!(
                "[host.desktop.channelListen] channel={} event={} arg={}",
                channel, event, arg
            );
        }

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
            let envelope = json!({
                "subscriptionId": subscription_id,
                "channel": channel,
                "event": event,
                "payload": payload
            });

            if let Some(window) = app_handle.get_webview_window("main") {
                if let Ok(envelope_json) = serde_json::to_string(&envelope) {
                    if let Ok(envelope_literal) = serde_json::to_string(&envelope_json) {
                        let script = format!(
                            "window.dispatchEvent(new CustomEvent('desktop_channel_event', {{ detail: JSON.parse({}) }}));",
                            envelope_literal
                        );
                        if window.eval(script.as_str()).is_ok() {
                            if is_integration_startup_watchdog_enabled()
                                && channel == "extensionHostStarter"
                                && matches!(
                                    event,
                                    "onDynamicStdout" | "onDynamicStderr" | "onDynamicExit"
                                )
                            {
                                eprintln!(
                                    "[host.desktop.channelEvent.emit] via=eval channel={} event={} subscriptionId={}",
                                    channel, event, subscription_id
                                );
                            }
                            return;
                        } else if is_integration_startup_watchdog_enabled()
                            && channel == "extensionHostStarter"
                            && matches!(
                                event,
                                "onDynamicStdout" | "onDynamicStderr" | "onDynamicExit"
                            )
                        {
                            eprintln!(
                                "[host.desktop.channelEvent.emit] via=eval-failed channel={} event={} subscriptionId={}",
                                channel, event, subscription_id
                            );
                        }
                    }
                }

                if is_integration_startup_watchdog_enabled()
                    && channel == "extensionHostStarter"
                    && matches!(event, "onDynamicStdout" | "onDynamicStderr" | "onDynamicExit")
                {
                    eprintln!(
                        "[host.desktop.channelEvent.emit] via=window.emit channel={} event={} subscriptionId={}",
                        channel, event, subscription_id
                    );
                }
                let _ = window.emit("desktop_channel_event", envelope);
                return;
            }

            let _ = app_handle.emit("desktop_channel_event", envelope);
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

    fn subscription_arg_matches(arg: &Value, expected: &str) -> bool {
        if let Some(value) = arg.as_str() {
            return value == expected;
        }
        if let Some(value) = arg.as_u64() {
            return value.to_string() == expected;
        }
        if let Some(value) = arg.as_i64() {
            return value.to_string() == expected;
        }
        if let Some(items) = arg.as_array() {
            return items
                .first()
                .map(|value| Self::subscription_arg_matches(value, expected))
                .unwrap_or(false);
        }
        if let Some(object) = arg.as_object() {
            for key in ["id", "nonce", "sessionId"] {
                if let Some(value) = object.get(key) {
                    if Self::subscription_arg_matches(value, expected) {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn emit_dynamic_subscription_event(
        channel_runtime: &Arc<Mutex<ChannelRuntimeState>>,
        channel: &str,
        event: &str,
        dynamic_arg: &str,
        payload: Value,
    ) {
        let subscription_ids = match channel_runtime.lock() {
            Ok(guard) => guard
                .subscriptions
                .iter()
                .filter_map(|(id, subscription)| {
                    if subscription.channel == channel
                        && subscription.event == event
                        && Self::subscription_arg_matches(&subscription.arg, dynamic_arg)
                    {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };

        if is_integration_startup_watchdog_enabled()
            && channel == "extensionHostStarter"
            && matches!(event, "onDynamicStdout" | "onDynamicStderr" | "onDynamicExit")
        {
            eprintln!(
                "[host.desktop.channelEvent.match] channel={} event={} arg={} subscriptions={}",
                channel,
                event,
                dynamic_arg,
                subscription_ids.len()
            );
        }

        for subscription_id in subscription_ids {
            Self::emit_channel_event(&subscription_id, channel, event, payload.clone());
        }
    }

    fn default_extensions_profile_location(&self) -> Value {
        file_uri_components(
            &self
                .repo_root
                .join(".vscode-tauri")
                .join("user-data")
                .join("User")
                .join("profiles")
                .join("default")
                .join("extensions.json"),
        )
    }

    fn profile_location_from_extension_args(
        &self,
        args: &Value,
        options_index: usize,
        profile_index: usize,
    ) -> Value {
        if let Some(options_path) = nth_arg(args, options_index)
            .and_then(Value::as_object)
            .and_then(|value| value.get("profileLocation"))
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
        {
            return file_uri_components(Path::new(options_path));
        }
        if let Some(profile_path) = nth_arg(args, profile_index)
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
        {
            return file_uri_components(Path::new(profile_path));
        }
        self.default_extensions_profile_location()
    }

    fn extension_identifier_from_value(value: &Value) -> Value {
        if let Some(identifier) = value.get("identifier").cloned() {
            return identifier;
        }
        let manifest = value.get("manifest").and_then(Value::as_object);
        let publisher = manifest
            .and_then(|entry| entry.get("publisher"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let name = manifest
            .and_then(|entry| entry.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        json!({ "id": format!("{publisher}.{name}") })
    }

    async fn emit_extension_management_events(
        &self,
        method: &str,
        args: &Value,
        result: &Value,
    ) -> Result<(), String> {
        match method {
            "install" | "installFromLocation" | "installFromGallery" => {
                let profile_location = self.profile_location_from_extension_args(args, 1, 1);
                let identifier = Self::extension_identifier_from_value(result);
                let source = nth_arg(args, 0).cloned().unwrap_or(Value::Null);
                let application_scoped = result
                    .get("isApplicationScoped")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let install_event = json!({
                    "identifier": identifier,
                    "source": source,
                    "profileLocation": profile_location,
                    "applicationScoped": application_scoped,
                    "workspaceScoped": false
                });
                self.emit_to_subscriptions(
                    "extensions",
                    "onInstallExtension",
                    install_event.clone(),
                    |_| true,
                )?;
                self.emit_to_subscriptions(
                    "extensions",
                    "onDidInstallExtensions",
                    json!([{
                        "identifier": install_event["identifier"].clone(),
                        "operation": 2,
                        "source": install_event["source"].clone(),
                        "local": result.clone(),
                        "profileLocation": install_event["profileLocation"].clone(),
                        "applicationScoped": application_scoped,
                        "workspaceScoped": false
                    }]),
                    |_| true,
                )?;
            }
            "installGalleryExtensions" | "installExtensionsFromProfile" => {
                let profile_location = self.default_extensions_profile_location();
                let mut install_results = Vec::new();
                if let Some(items) = result.as_array() {
                    for entry in items {
                        let local = entry.get("local").cloned().unwrap_or_else(|| entry.clone());
                        let identifier = entry
                            .get("identifier")
                            .cloned()
                            .unwrap_or_else(|| Self::extension_identifier_from_value(&local));
                        let source = entry.get("source").cloned().unwrap_or(Value::Null);
                        let application_scoped = local
                            .get("isApplicationScoped")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        self.emit_to_subscriptions(
                            "extensions",
                            "onInstallExtension",
                            json!({
                                "identifier": identifier,
                                "source": source,
                                "profileLocation": profile_location,
                                "applicationScoped": application_scoped,
                                "workspaceScoped": false
                            }),
                            |_| true,
                        )?;
                        install_results.push(json!({
                            "identifier": identifier,
                            "operation": 2,
                            "source": source,
                            "local": local,
                            "profileLocation": profile_location,
                            "applicationScoped": application_scoped,
                            "workspaceScoped": false
                        }));
                    }
                }
                if !install_results.is_empty() {
                    self.emit_to_subscriptions(
                        "extensions",
                        "onDidInstallExtensions",
                        Value::Array(install_results),
                        |_| true,
                    )?;
                }
            }
            "uninstall" => {
                let profile_location = self.profile_location_from_extension_args(args, 1, 1);
                let extension = nth_arg(args, 0).cloned().unwrap_or(Value::Null);
                let identifier = Self::extension_identifier_from_value(&extension);
                let application_scoped = extension
                    .get("isApplicationScoped")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.emit_to_subscriptions(
                    "extensions",
                    "onUninstallExtension",
                    json!({
                        "identifier": identifier,
                        "profileLocation": profile_location,
                        "applicationScoped": application_scoped,
                        "workspaceScoped": false
                    }),
                    |_| true,
                )?;
                self.emit_to_subscriptions(
                    "extensions",
                    "onDidUninstallExtension",
                    json!({
                        "identifier": identifier,
                        "profileLocation": profile_location,
                        "applicationScoped": application_scoped,
                        "workspaceScoped": false
                    }),
                    |_| true,
                )?;
            }
            "uninstallExtensions" => {
                if let Some(items) = nth_arg(args, 0).and_then(Value::as_array) {
                    for entry in items {
                        let extension = entry
                            .get("extension")
                            .cloned()
                            .unwrap_or_else(|| Value::Null);
                        let identifier = Self::extension_identifier_from_value(&extension);
                        let application_scoped = extension
                            .get("isApplicationScoped")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let profile_location = entry
                            .get("options")
                            .and_then(Value::as_object)
                            .and_then(|value| value.get("profileLocation"))
                            .cloned()
                            .unwrap_or_else(|| self.default_extensions_profile_location());
                        self.emit_to_subscriptions(
                            "extensions",
                            "onUninstallExtension",
                            json!({
                                "identifier": identifier,
                                "profileLocation": profile_location,
                                "applicationScoped": application_scoped,
                                "workspaceScoped": false
                            }),
                            |_| true,
                        )?;
                        self.emit_to_subscriptions(
                            "extensions",
                            "onDidUninstallExtension",
                            json!({
                                "identifier": identifier,
                                "profileLocation": profile_location,
                                "applicationScoped": application_scoped,
                                "workspaceScoped": false
                            }),
                            |_| true,
                        )?;
                    }
                }
            }
            "updateMetadata"
            | "toggleApplicationScope"
            | "resetPinnedStateForAllUserExtensions" => {
                if method == "resetPinnedStateForAllUserExtensions" {
                    if let Some(installed) = self
                        .router
                        .dispatch_channel("extensions", "getInstalled", &json!([1, Value::Null]))
                        .await
                        .ok()
                        .and_then(|value| value.as_array().cloned())
                    {
                        for local in installed {
                            self.emit_to_subscriptions(
                                "extensions",
                                "onDidUpdateExtensionMetadata",
                                json!({
                                    "profileLocation": self.default_extensions_profile_location(),
                                    "local": local
                                }),
                                |_| true,
                            )?;
                        }
                    }
                } else {
                    self.emit_to_subscriptions(
                        "extensions",
                        "onDidUpdateExtensionMetadata",
                        json!({
                            "profileLocation": self.profile_location_from_extension_args(args, 2, 1),
                            "local": result.clone()
                        }),
                        |_| true,
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_extension_host_debug_channel_call(
        &self,
        method: &str,
        args: &Value,
    ) -> Result<Value, String> {
        match method {
            "reload" => {
                let session_id = nth_arg(args, 0).and_then(Value::as_str).unwrap_or_default();
                self.emit_to_subscriptions(
                    "extensionhostdebugservice",
                    "reload",
                    json!({ "sessionId": session_id }),
                    |_| true,
                )?;
                Ok(Value::Null)
            }
            "close" => {
                let session_id = nth_arg(args, 0).and_then(Value::as_str).unwrap_or_default();
                self.emit_to_subscriptions(
                    "extensionhostdebugservice",
                    "close",
                    json!({ "sessionId": session_id }),
                    |_| true,
                )?;
                Ok(Value::Null)
            }
            "attach" => {
                let session_id = nth_arg(args, 0).and_then(Value::as_str).unwrap_or_default();
                let port = nth_arg(args, 1).and_then(Value::as_u64).unwrap_or(0);
                let sub_id = nth_arg(args, 2).and_then(Value::as_str);
                self.emit_to_subscriptions(
                    "extensionhostdebugservice",
                    "attach",
                    json!({
                        "sessionId": session_id,
                        "port": port,
                        "subId": sub_id
                    }),
                    |_| true,
                )?;
                Ok(Value::Null)
            }
            "terminate" => {
                let session_id = nth_arg(args, 0).and_then(Value::as_str).unwrap_or_default();
                let sub_id = nth_arg(args, 1).and_then(Value::as_str);
                self.emit_to_subscriptions(
                    "extensionhostdebugservice",
                    "terminate",
                    json!({
                        "sessionId": session_id,
                        "subId": sub_id
                    }),
                    |_| true,
                )?;
                Ok(Value::Null)
            }
            "openExtensionDevelopmentHostWindow" | "attachToCurrentWindowRenderer" => {
                Ok(json!({ "success": false }))
            }
            _ => Err(format!(
                "Unsupported extensionhostdebugservice method '{method}'"
            )),
        }
    }

    async fn handle_extension_host_starter_channel_call(
        &self,
        method: &str,
        args: &Value,
    ) -> Result<Value, String> {
        match method {
            "createExtensionHost" => {
                let id = format!(
                    "tauri-extension-host-{}",
                    self.next_extension_host_id.fetch_add(1, Ordering::Relaxed)
                );
                let mut runtime = self
                    .extension_host_runtime
                    .lock()
                    .map_err(|_| "extension host runtime lock poisoned".to_string())?;
                runtime
                    .sessions_by_id
                    .entry(id.clone())
                    .or_insert_with(ExtensionHostSession::new);
                Ok(json!({ "id": id }))
            }
            "start" => self.start_extension_host_bridge(args).await,
            "enableInspectPort" => Ok(json!(false)),
            "kill" => self.kill_extension_host_bridge(args).await,
            "writeMessagePortFrame" => self.write_extension_host_message_port_frame(args).await,
            "closeMessagePortFrame" => self.close_extension_host_message_port_frame(args),
            _ => Err(format!(
                "Unsupported extensionHostStarter method '{method}'"
            )),
        }
    }

    async fn start_extension_host_bridge(&self, args: &Value) -> Result<Value, String> {
        let id = nth_arg(args, 0)
            .and_then(Value::as_str)
            .ok_or_else(|| "extensionHostStarter.start expected extension host id".to_string())?;
        let opts = nth_arg(args, 1)
            .and_then(Value::as_object)
            .ok_or_else(|| "extensionHostStarter.start expected options object".to_string())?;
        let response_nonce = opts
            .get("responseNonce")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "extensionHostStarter.start options.responseNonce is required".to_string()
            })?;
        let exec_argv = opts
            .get("execArgv")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let env_entries = opts
            .get("env")
            .and_then(Value::as_object)
            .map(|entries| {
                entries
                    .iter()
                    .map(|(key, value)| ExtensionHostBridgeEnvEntry {
                        key: key.clone(),
                        value: value.as_str().map(ToOwned::to_owned),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let entry_point = [
            self.repo_root
                .join("out/vs/workbench/api/node/extensionHostProcess.js"),
            self.repo_root
                .join("out-vscode-min/vs/workbench/api/node/extensionHostProcess.js"),
        ]
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "extensionHostStarter.start could not find extensionHostProcess.js output".to_string()
        })?;
        let bridge_script = self
            .repo_root
            .join("apps/tauri/node/extension-host-bridge.mjs");
        if !bridge_script.is_file() {
            return Err(format!(
                "extensionHostStarter.start missing bridge script {}",
                bridge_script.display()
            ));
        }

        let config = ExtensionHostBridgeConfig {
            entry_point: entry_point.to_string_lossy().to_string(),
            args: vec!["--skipWorkspaceStorageLock".to_string()],
            exec_argv,
            env: env_entries,
            vscode_version: read_json_file(&self.repo_root.join("product.json"))
                .ok()
                .and_then(|value| {
                    value
                        .get("version")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .or_else(|| {
                    read_json_file(&self.repo_root.join("package.json"))
                        .ok()
                        .and_then(|value| {
                            value
                                .get("version")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned)
                        })
                })
                .unwrap_or_else(|| "0.0.0".to_string()),
        };
        let encoded =
            BASE64_STANDARD.encode(serde_json::to_vec(&config).map_err(|error| error.to_string())?);
        let node_binary =
            std::env::var("VSCODE_TAURI_NODE_BINARY").unwrap_or_else(|_| "node".to_string());

        let mut command = if should_force_arm64_node_bridge() {
            let mut command = TokioCommand::new("/usr/bin/arch");
            command.arg("-arm64").arg(&node_binary);
            command
        } else {
            TokioCommand::new(&node_binary)
        };
        command
            .arg(bridge_script)
            .arg("--config-base64")
            .arg(encoded)
            .current_dir(&self.repo_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            format!("extensionHostStarter.start failed to spawn bridge: {error}")
        })?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "extensionHostStarter.start missing bridge stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "extensionHostStarter.start missing bridge stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "extensionHostStarter.start missing bridge stderr".to_string())?;

        {
            let mut runtime = self
                .extension_host_runtime
                .lock()
                .map_err(|_| "extension host runtime lock poisoned".to_string())?;
            let existing_nonce = runtime
                .sessions_by_id
                .get(id)
                .and_then(|session| session.nonce.clone());
            if let Some(existing_nonce) = existing_nonce {
                runtime.id_by_nonce.remove(&existing_nonce);
            }
            let session = runtime
                .sessions_by_id
                .entry(id.to_string())
                .or_insert_with(ExtensionHostSession::new);
            session.nonce = Some(response_nonce.to_string());
            session.pid = pid;
            session.stdin = Some(Arc::new(AsyncMutex::new(stdin)));
            runtime
                .id_by_nonce
                .insert(response_nonce.to_string(), id.to_string());
        }

        let channel_runtime_for_frames = self.channel_runtime.clone();
        let channel_runtime_for_stderr = self.channel_runtime.clone();
        let channel_runtime_for_exit = self.channel_runtime.clone();
        let extension_runtime_for_exit = self.extension_host_runtime.clone();
        let id_for_frames = id.to_string();
        let id_for_stderr = id.to_string();
        let id_for_exit = id.to_string();
        let nonce_for_frames = response_nonce.to_string();
        let nonce_for_exit = response_nonce.to_string();

        tokio::spawn(async move {
            Self::forward_extension_host_frames(
                channel_runtime_for_frames,
                id_for_frames,
                nonce_for_frames,
                stdout,
            )
            .await;
        });
        tokio::spawn(async move {
            Self::forward_extension_host_stderr_lines(
                channel_runtime_for_stderr,
                id_for_stderr,
                stderr,
            )
            .await;
        });
        tokio::spawn(async move {
            Self::wait_for_extension_host_exit(
                channel_runtime_for_exit,
                extension_runtime_for_exit,
                id_for_exit,
                nonce_for_exit,
                child,
            )
            .await;
        });

        if is_integration_startup_watchdog_enabled() {
            eprintln!(
                "[host.extensionHostStarter.start] id={} pid={:?} responseNonce={}",
                id, pid, response_nonce
            );
        }

        Ok(json!({ "pid": pid }))
    }

    async fn kill_extension_host_bridge(&self, args: &Value) -> Result<Value, String> {
        let id = nth_arg(args, 0)
            .and_then(Value::as_str)
            .ok_or_else(|| "extensionHostStarter.kill expected extension host id".to_string())?;
        let pid = {
            let mut runtime = self
                .extension_host_runtime
                .lock()
                .map_err(|_| "extension host runtime lock poisoned".to_string())?;
            let session = runtime.sessions_by_id.get_mut(id);
            if let Some(session) = session {
                session.stdin = None;
                session.pid
            } else {
                None
            }
        };
        if let Some(pid) = pid {
            let _ = TokioCommand::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status()
                .await;
        }
        Ok(Value::Null)
    }

    async fn write_extension_host_message_port_frame(&self, args: &Value) -> Result<Value, String> {
        let nonce = nth_arg(args, 0)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "extensionHostStarter.writeMessagePortFrame expected nonce argument".to_string()
            })?
            .to_string();
        let frame_value = nth_arg(args, 1).ok_or_else(|| {
            "extensionHostStarter.writeMessagePortFrame expected frame argument".to_string()
        })?;
        let stdin = {
            let runtime = self
                .extension_host_runtime
                .lock()
                .map_err(|_| "extension host runtime lock poisoned".to_string())?;
            let id = runtime.id_by_nonce.get(&nonce).ok_or_else(|| {
                format!("extensionHostStarter.writeMessagePortFrame unknown nonce '{nonce}'")
            })?;
            runtime
                .sessions_by_id
                .get(id)
                .and_then(|session| session.stdin.clone())
                .ok_or_else(|| {
                    format!(
                        "extensionHostStarter.writeMessagePortFrame no stdin for extension host '{id}'"
                    )
                })?
        };

        let frame = decode_message_port_frame_payload(frame_value);
        let frame_length = u32::try_from(frame.len()).map_err(|_| {
            "extensionHostStarter.writeMessagePortFrame frame too large".to_string()
        })?;
        let mut packet = Vec::with_capacity(frame.len() + 4);
        packet.extend_from_slice(&frame_length.to_le_bytes());
        packet.extend_from_slice(&frame);

        let mut guard = stdin.lock().await;
        guard.write_all(&packet).await.map_err(|error| {
            format!("extensionHostStarter.writeMessagePortFrame failed to write frame: {error}")
        })?;
        guard.flush().await.map_err(|error| {
            format!("extensionHostStarter.writeMessagePortFrame failed to flush frame: {error}")
        })?;
        Ok(Value::Null)
    }

    fn close_extension_host_message_port_frame(&self, args: &Value) -> Result<Value, String> {
        let nonce = nth_arg(args, 0)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "extensionHostStarter.closeMessagePortFrame expected nonce argument".to_string()
            })?
            .to_string();
        let mut runtime = self
            .extension_host_runtime
            .lock()
            .map_err(|_| "extension host runtime lock poisoned".to_string())?;
        if let Some(id) = runtime.id_by_nonce.remove(&nonce) {
            if let Some(session) = runtime.sessions_by_id.get_mut(&id) {
                if session.nonce.as_deref() == Some(nonce.as_str()) {
                    session.nonce = None;
                }
                session.stdin = None;
            }
        }
        Ok(Value::Null)
    }

    async fn forward_extension_host_frames(
        channel_runtime: Arc<Mutex<ChannelRuntimeState>>,
        _extension_host_id: String,
        nonce: String,
        mut stdout: tokio::process::ChildStdout,
    ) {
        let mut raw_buffer = Vec::<u8>::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = match stdout.read(&mut chunk).await {
                Ok(read) => read,
                Err(_) => break,
            };
            if read == 0 {
                break;
            }
            raw_buffer.extend_from_slice(&chunk[..read]);

            loop {
                if raw_buffer.len() < 4 {
                    break;
                }
                let frame_length = u32::from_le_bytes([
                    raw_buffer[0],
                    raw_buffer[1],
                    raw_buffer[2],
                    raw_buffer[3],
                ]) as usize;
                if raw_buffer.len() < frame_length + 4 {
                    break;
                }
                let frame = raw_buffer[4..(4 + frame_length)].to_vec();
                raw_buffer.drain(..(4 + frame_length));

                Self::emit_dynamic_subscription_event(
                    &channel_runtime,
                    "extensionHostStarter",
                    "onDynamicMessagePortFrame",
                    &nonce,
                    json!(frame),
                );
            }
        }
    }

    async fn forward_extension_host_stderr_lines(
        channel_runtime: Arc<Mutex<ChannelRuntimeState>>,
        extension_host_id: String,
        stderr: tokio::process::ChildStderr,
    ) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if is_integration_startup_watchdog_enabled() {
                eprintln!(
                    "[host.extensionHostStarter.stderr] id={} line={}",
                    extension_host_id, line
                );
            }
            if let Some(stripped) = line.strip_prefix("[ext-host:stdout] ") {
                Self::emit_dynamic_subscription_event(
                    &channel_runtime,
                    "extensionHostStarter",
                    "onDynamicStdout",
                    &extension_host_id,
                    Value::String(stripped.to_string()),
                );
                continue;
            }
            if let Some(stripped) = line.strip_prefix("[ext-host:stderr] ") {
                Self::emit_dynamic_subscription_event(
                    &channel_runtime,
                    "extensionHostStarter",
                    "onDynamicStderr",
                    &extension_host_id,
                    Value::String(stripped.to_string()),
                );
                continue;
            }

            Self::emit_dynamic_subscription_event(
                &channel_runtime,
                "extensionHostStarter",
                "onDynamicStderr",
                &extension_host_id,
                Value::String(line),
            );
        }
    }

    async fn wait_for_extension_host_exit(
        channel_runtime: Arc<Mutex<ChannelRuntimeState>>,
        extension_runtime: Arc<Mutex<ExtensionHostRuntimeState>>,
        extension_host_id: String,
        nonce: String,
        mut child: tokio::process::Child,
    ) {
        let exit_payload = match child.wait().await {
            Ok(status) => {
                #[cfg(unix)]
                let signal = std::os::unix::process::ExitStatusExt::signal(&status)
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                #[cfg(not(unix))]
                let signal = String::new();
                json!({
                    "code": status.code().unwrap_or(0),
                    "signal": signal
                })
            }
            Err(error) => json!({
                "code": 1,
                "signal": "",
                "error": error.to_string()
            }),
        };

        if is_integration_startup_watchdog_enabled() {
            eprintln!(
                "[host.extensionHostStarter.exit] id={} nonce={} payload={}",
                extension_host_id, nonce, exit_payload
            );
        }

        Self::emit_dynamic_subscription_event(
            &channel_runtime,
            "extensionHostStarter",
            "onDynamicExit",
            &extension_host_id,
            exit_payload,
        );

        if let Ok(mut runtime) = extension_runtime.lock() {
            runtime.sessions_by_id.remove(&extension_host_id);
            if runtime.id_by_nonce.get(&nonce).map(|value| value.as_str())
                == Some(extension_host_id.as_str())
            {
                runtime.id_by_nonce.remove(&nonce);
            }
        }
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

    fn handle_terminal_data(&self, payload_json: &str) -> Result<(), String> {
        let payload: Value = serde_json::from_str(payload_json)
            .map_err(|error| format!("Invalid terminal.data payload: {error}"))?;
        let terminal_id = payload
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| "terminal.data payload missing id".to_string())?;
        let data = payload
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "terminal.data payload missing data".to_string())?;

        self.emit_to_subscriptions(
            "localPty",
            "onProcessData",
            json!({
                "id": terminal_id,
                "event": {
                    "data": data,
                    "trackCommit": false
                }
            }),
            |_| true,
        )
    }

    fn emit_ipc_event(&self, channel: &str, args: Vec<Value>) -> Result<(), String> {
        self.emit_to_subscriptions(
            IPC_EVENT_CHANNEL,
            IPC_EVENT_NAME,
            json!({
                "channel": channel,
                "args": args
            }),
            |_| true,
        )
    }

    fn close_context_menu(&self, context_menu_id: i64) -> Result<bool, String> {
        let removed = {
            let mut state = self
                .context_menu_runtime
                .lock()
                .map_err(|_| "context menu runtime lock poisoned".to_string())?;
            remove_context_menu_runtime_entries(&mut state, context_menu_id)
        };
        Ok(removed)
    }

    fn clear_context_menus(&self) -> Result<Vec<i64>, String> {
        let stale_context_ids = {
            let mut state = self
                .context_menu_runtime
                .lock()
                .map_err(|_| "context menu runtime lock poisoned".to_string())?;
            let ids = state
                .active_by_context_menu_id
                .keys()
                .copied()
                .collect::<Vec<_>>();
            state.active_by_context_menu_id.clear();
            state.item_by_native_menu_id.clear();
            ids
        };

        Ok(stale_context_ids)
    }

    fn handle_ipc_context_menu(&self, args: &Value) -> Result<(), String> {
        let args = args
            .as_array()
            .ok_or_else(|| "vscode:contextmenu expects args array".to_string())?;
        let context_menu_id = args
            .first()
            .and_then(value_as_i64)
            .ok_or_else(|| "vscode:contextmenu missing numeric context menu id".to_string())?;
        let items = args
            .get(1)
            .and_then(Value::as_array)
            .ok_or_else(|| "vscode:contextmenu missing items array".to_string())?;
        let on_click_channel = args
            .get(2)
            .and_then(Value::as_str)
            .ok_or_else(|| "vscode:contextmenu missing onClick channel".to_string())?;
        let popup_options = args.get(3).and_then(Value::as_object);

        for stale_id in self.clear_context_menus()? {
            let _ = self.emit_ipc_event(IPC_CONTEXT_MENU_CLOSE_CHANNEL, vec![json!(stale_id)]);
        }

        let app_handle = capabilities::window::app_handle()
            .ok_or_else(|| "tauri app handle not initialized".to_string())?;
        let window = app_handle
            .get_webview_window("main")
            .ok_or_else(|| "main webview window unavailable".to_string())?;

        let mut item_bindings = Vec::new();
        let menu = build_context_menu(
            &app_handle,
            items,
            context_menu_id,
            on_click_channel,
            &mut item_bindings,
        )?;

        let native_menu_item_ids = item_bindings
            .iter()
            .map(|(native_id, _)| native_id.clone())
            .collect::<Vec<_>>();

        {
            let mut runtime = self
                .context_menu_runtime
                .lock()
                .map_err(|_| "context menu runtime lock poisoned".to_string())?;
            runtime.active_by_context_menu_id.insert(
                context_menu_id,
                ActiveContextMenu {
                    native_menu_item_ids,
                },
            );
            for (native_id, binding) in item_bindings {
                runtime.item_by_native_menu_id.insert(native_id, binding);
            }
        }

        let popup_result = if let Some(position) = context_menu_position(popup_options) {
            window.popup_menu_at(&menu, position)
        } else {
            window.popup_menu(&menu)
        };

        if let Err(error) = popup_result {
            let _ = self.close_context_menu(context_menu_id);
            let _ =
                self.emit_ipc_event(IPC_CONTEXT_MENU_CLOSE_CHANNEL, vec![json!(context_menu_id)]);
            return Err(format!("vscode:contextmenu failed to show popup: {error}"));
        }

        Ok(())
    }

    fn handle_context_menu_event(&self, menu_item_id: &str) -> Result<bool, String> {
        let resolved = {
            let mut state = self
                .context_menu_runtime
                .lock()
                .map_err(|_| "context menu runtime lock poisoned".to_string())?;
            let item = match state.item_by_native_menu_id.remove(menu_item_id) {
                Some(item) => item,
                None => return Ok(false),
            };
            remove_context_menu_runtime_entries(&mut state, item.context_menu_id);
            item
        };

        self.emit_ipc_event(
            &resolved.on_click_channel,
            vec![json!(resolved.item_id), json!({})],
        )?;
        self.emit_ipc_event(
            IPC_CONTEXT_MENU_CLOSE_CHANNEL,
            vec![json!(resolved.context_menu_id)],
        )?;

        Ok(true)
    }

    fn handle_native_menu_event(&self, menu_item_id: &str) -> Result<(), String> {
        if self.handle_context_menu_event(menu_item_id)? {
            return Ok(());
        }
        self.handle_menubar_event(menu_item_id)
    }

    fn handle_menubar_event(&self, menu_item_id: &str) -> Result<(), String> {
        let Some(payload) = self.router.menubar_action_payload(menu_item_id) else {
            return Ok(());
        };

        self.emit_to_subscriptions("menubar", "runAction", payload, |_| true)
    }
}

fn should_force_arm64_node_bridge() -> bool {
    #[cfg(target_os = "macos")]
    {
        if std::env::consts::ARCH != "x86_64" {
            return false;
        }

        return std::process::Command::new("sysctl")
            .args(["-in", "hw.optional.arm64"])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|value| value.trim() == "1")
            .unwrap_or(false);
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

fn should_forward_host_request_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length" | "host"
    )
}

fn append_response_header_value(headers: &mut BTreeMap<String, Value>, key: String, value: String) {
    match headers.get_mut(&key) {
        Some(existing) => match existing {
            Value::String(current) => {
                let first = std::mem::take(current);
                *existing = Value::Array(vec![Value::String(first), Value::String(value)]);
            }
            Value::Array(values) => values.push(Value::String(value)),
            _ => {
                *existing = Value::String(value);
            }
        },
        None => {
            headers.insert(key, Value::String(value));
        }
    }
}

fn should_trace_host_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("marketplace.visualstudio.com")
        || lower.contains("/_apis/public/gallery")
        || lower.contains("extensionquery")
        || lower.contains("open-vsx.org")
}

async fn perform_host_http_request(params: HostHttpRequestParams) -> Result<Value, String> {
    let trace = should_trace_host_http_url(&params.url);
    let started_at = Instant::now();
    let header_count = params
        .headers
        .as_ref()
        .map(|headers| headers.len())
        .unwrap_or(0);
    let has_body = params
        .body_base64
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    if trace {
        eprintln!(
            "[host.httpRequest] request method={} url={} timeoutMs={:?} headerCount={} hasBody={}",
            params.method.as_deref().unwrap_or("GET"),
            params.url,
            params.timeout_ms,
            header_count,
            has_body
        );
    }

    let parsed_url = match reqwest::Url::parse(&params.url) {
        Ok(value) => value,
        Err(error) => {
            if trace {
                eprintln!("[host.httpRequest] invalid url error={error}");
            }
            return Err(format!(
                "host.httpRequest invalid url '{}': {error}",
                params.url
            ));
        }
    };
    if !matches!(parsed_url.scheme(), "http" | "https") {
        if trace {
            eprintln!(
                "[host.httpRequest] unsupported scheme scheme={}",
                parsed_url.scheme()
            );
        }
        return Err(format!(
            "host.httpRequest supports only http/https urls (got '{}')",
            parsed_url.scheme()
        ));
    }

    let method_raw = params.method.unwrap_or_else(|| "GET".to_string());
    let method = match reqwest::Method::from_bytes(method_raw.as_bytes()) {
        Ok(value) => value,
        Err(error) => {
            if trace {
                eprintln!(
                    "[host.httpRequest] invalid method method={} error={error}",
                    method_raw
                );
            }
            return Err(format!(
                "host.httpRequest invalid method '{}': {error}",
                method_raw
            ));
        }
    };

    let mut client_builder = reqwest::Client::builder();
    if let Some(timeout_ms) = params.timeout_ms {
        if timeout_ms > 0 {
            client_builder = client_builder.timeout(Duration::from_millis(timeout_ms));
        }
    }
    let client = match client_builder.build() {
        Ok(value) => value,
        Err(error) => {
            if trace {
                eprintln!("[host.httpRequest] failed to create client error={error}");
            }
            return Err(format!("host.httpRequest failed to create client: {error}"));
        }
    };

    let mut request_builder = client.request(method, parsed_url);
    if let Some(headers) = params.headers {
        for (name, raw_value) in headers {
            if !should_forward_host_request_header(&name) {
                continue;
            }
            let header_name = match reqwest::header::HeaderName::from_bytes(name.as_bytes()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            match raw_value {
                Value::String(value) => {
                    if let Ok(header_value) = reqwest::header::HeaderValue::from_str(&value) {
                        request_builder = request_builder.header(header_name.clone(), header_value);
                    }
                }
                Value::Array(values) => {
                    for entry in values {
                        let Some(value) = entry.as_str() else {
                            continue;
                        };
                        if let Ok(header_value) = reqwest::header::HeaderValue::from_str(value) {
                            request_builder =
                                request_builder.header(header_name.clone(), header_value);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(body_base64) = params.body_base64 {
        if !body_base64.is_empty() {
            let bytes = match BASE64_STANDARD.decode(body_base64.as_bytes()) {
                Ok(value) => value,
                Err(error) => {
                    if trace {
                        eprintln!("[host.httpRequest] invalid bodyBase64 error={error}");
                    }
                    return Err(format!("host.httpRequest invalid bodyBase64: {error}"));
                }
            };
            request_builder = request_builder.body(bytes);
        }
    }

    let response = match request_builder.send().await {
        Ok(value) => value,
        Err(error) => {
            if trace {
                eprintln!(
                    "[host.httpRequest] request failed elapsedMs={} error={error}",
                    started_at.elapsed().as_millis()
                );
            }
            return Err(format!("host.httpRequest request failed: {error}"));
        }
    };

    let status_code = response.status().as_u16();
    let mut response_headers = BTreeMap::new();
    for (name, value) in response.headers() {
        let Ok(value) = value.to_str() else {
            continue;
        };
        append_response_header_value(
            &mut response_headers,
            name.as_str().to_string(),
            value.to_string(),
        );
    }
    let body_bytes = match response.bytes().await {
        Ok(value) => value,
        Err(error) => {
            if trace {
                eprintln!("[host.httpRequest] failed to read response body error={error}");
            }
            return Err(format!(
                "host.httpRequest failed to read response body: {error}"
            ));
        }
    };
    if trace {
        eprintln!(
            "[host.httpRequest] response status={} bodyBytes={} elapsedMs={}",
            status_code,
            body_bytes.len(),
            started_at.elapsed().as_millis()
        );
    }
    let payload = HostHttpResponsePayload {
        status_code,
        headers: response_headers,
        body_base64: BASE64_STANDARD.encode(body_bytes),
    };

    match serde_json::to_value(payload) {
        Ok(value) => Ok(value),
        Err(error) => {
            if trace {
                eprintln!("[host.httpRequest] failed to serialize response error={error}");
            }
            Err(format!(
                "host.httpRequest failed to serialize response: {error}"
            ))
        }
    }
}

fn is_integration_startup_watchdog_enabled() -> bool {
    std::env::var("VSCODE_TAURI_INTEGRATION").ok().as_deref() == Some("1")
}

fn reset_integration_startup_watchdog_state() {
    INTEGRATION_STARTUP_RENDERED.store(false, Ordering::Relaxed);
    if let Ok(mut progress) = INTEGRATION_STARTUP_LAST_PROGRESS.lock() {
        *progress = None;
    }
}

fn update_integration_startup_watchdog_progress(source: &str, message: &str) {
    if !is_integration_startup_watchdog_enabled() || source != "ui.startup" {
        return;
    }

    if let Ok(mut progress) = INTEGRATION_STARTUP_LAST_PROGRESS.lock() {
        *progress = Some(message.to_string());
    }

    if message == "render complete" {
        INTEGRATION_STARTUP_RENDERED.store(true, Ordering::Relaxed);
    }
}

fn spawn_integration_startup_watchdog() {
    if !is_integration_startup_watchdog_enabled() {
        return;
    }

    reset_integration_startup_watchdog_state();
    std::thread::spawn(|| {
        // Keep this comfortably above the renderer-side first-render timeout so the
        // UI can report the concrete startup failure instead of being preempted here.
        std::thread::sleep(Duration::from_secs(35));
        if INTEGRATION_STARTUP_RENDERED.load(Ordering::Relaxed) {
            return;
        }

        let last_progress = INTEGRATION_STARTUP_LAST_PROGRESS
            .lock()
            .ok()
            .and_then(|progress| progress.clone())
            .unwrap_or_else(|| "<no ui.startup progress recorded>".to_string());
        eprintln!(
            "[integration.startup.timeout] renderer did not report first render within 35s; lastProgress={}",
            last_progress
        );
        std::process::exit(1);
    });
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

    if std::env::var("VSCODE_TAURI_INTEGRATION").ok().as_deref() == Some("1") {
        match request.method.as_str() {
            "protocol.handshake"
            | "desktop.resolveWindowConfig"
            | "host.log"
            | "host.automationExit"
            | "window.close" => {
                eprintln!("[host.invoke] method={}", request.method);
            }
            _ => {}
        }
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
        return match workbench_css_modules(&state.repo_root) {
            Ok(modules) => Ok(ok_response(request.id, json!({ "modules": modules }))),
            Err(error) => Ok(error_response(request.id, -32603, error)),
        };
    }

    if request.method == "host.log" {
        let object = match request.params.as_object() {
            Some(value) => value,
            None => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    "host.log expects object params",
                ));
            }
        };
        let level = match required_string_param(object, "level") {
            Ok(value) => value,
            Err(error) => return Ok(error_response(request.id, -32602, error)),
        };
        let message = match required_string_param(object, "message") {
            Ok(value) => value,
            Err(error) => return Ok(error_response(request.id, -32602, error)),
        };
        let source = object
            .get("source")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("ui");
        let detail = object
            .get("detail")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("");

        update_integration_startup_watchdog_progress(&source, &message);

        let prefix = format!("[host.log] level={} source={}", level, source);
        if detail.is_empty() {
            if level.eq_ignore_ascii_case("error") || level.eq_ignore_ascii_case("warn") {
                eprintln!("{prefix} message={message}");
            } else {
                println!("{prefix} message={message}");
            }
        } else if level.eq_ignore_ascii_case("error") || level.eq_ignore_ascii_case("warn") {
            eprintln!("{prefix} message={message}\n{detail}");
        } else {
            println!("{prefix} message={message}\n{detail}");
        }

        return Ok(ok_response(request.id, json!({ "logged": true })));
    }

    if request.method == "host.automationExit" {
        let object = match request.params.as_object() {
            Some(value) => value,
            None => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    "host.automationExit expects object params",
                ));
            }
        };
        let code = match object
            .get("code")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
        {
            Some(value) => value,
            None => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    "host.automationExit requires an integer code",
                ));
            }
        };
        let log_count = object
            .get("logs")
            .and_then(Value::as_array)
            .map(|value| value.len())
            .unwrap_or(0);

        println!(
            "[host.automationExit] code={} logs={}",
            code, log_count
        );

        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            std::process::exit(code);
        });

        return Ok(ok_response(request.id, json!({ "accepted": true })));
    }

    if request.method == "host.httpRequest" {
        let params = match serde_json::from_value::<HostHttpRequestParams>(request.params.clone()) {
            Ok(value) => value,
            Err(error) => {
                return Ok(error_response(
                    request.id,
                    -32602,
                    format!("Invalid host.httpRequest params: {error}"),
                ));
            }
        };
        if params.url.trim().is_empty() {
            return Ok(error_response(
                request.id,
                -32602,
                "host.httpRequest requires a non-empty url",
            ));
        }
        return match perform_host_http_request(params).await {
            Ok(response) => Ok(ok_response(request.id, response)),
            Err(error) => Ok(error_response(request.id, -32603, error)),
        };
    }

    if request.method == "desktop.resolveWindowConfig" {
        return match state.window_config() {
            Ok(config) => Ok(ok_response(request.id, config)),
            Err(error) => {
                eprintln!("[host.desktop.resolveWindowConfig.error] {error}");
                Ok(error_response(request.id, -32603, error))
            }
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

        if is_integration_startup_watchdog_enabled()
            && channel == "extensionHostStarter"
            && method != "writeMessagePortFrame"
        {
            eprintln!(
                "[host.desktop.channelCall] channel={} method={}",
                channel, method
            );
        }

        if channel == "__ipcSend__" {
            return match state.handle_ipc_send(&method, &args) {
                Ok(value) => Ok(ok_response(request.id, value)),
                Err(error) => Ok(error_response(request.id, 1003, error)),
            };
        }

        if channel == "extensionHostStarter" {
            return match state
                .handle_extension_host_starter_channel_call(&method, &args)
                .await
            {
                Ok(value) => Ok(ok_response(request.id, value)),
                Err(error) => Ok(error_response(request.id, 1003, error)),
            };
        }

        if channel == "extensionhostdebugservice" {
            return match state
                .handle_extension_host_debug_channel_call(&method, &args)
                .await
            {
                Ok(value) => Ok(ok_response(request.id, value)),
                Err(error) => Ok(error_response(request.id, 1003, error)),
            };
        }

        if channel == "extensions" {
            return match state
                .router
                .dispatch_channel(&channel, &method, &args)
                .await
            {
                Ok(value) => {
                    if let Err(error) = state
                        .emit_extension_management_events(&method, &args, &value)
                        .await
                    {
                        eprintln!(
                            "[desktop.channelCall.extensions.events.error] method={} error={}",
                            method, error
                        );
                    }
                    Ok(ok_response(request.id, value))
                }
                Err(error) => Ok(error_response(request.id, 1003, error)),
            };
        }

        return match state.router.dispatch_channel(&channel, &method, &args).await {
            Ok(value) => Ok(ok_response(request.id, value)),
            Err(error) => {
                if is_integration_startup_watchdog_enabled()
                    && channel == "extensionHostStarter"
                    && method != "writeMessagePortFrame"
                {
                    eprintln!(
                        "[host.desktop.channelCall.error] channel={} method={} error={}",
                        channel, method, error
                    );
                }
                Ok(error_response(request.id, 1003, error))
            }
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

fn nth_arg(args: &Value, index: usize) -> Option<&Value> {
    args.as_array().and_then(|items| items.get(index))
}

fn decode_message_port_frame_payload(value: &Value) -> Vec<u8> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_u64().unwrap_or(0) as u8)
            .collect::<Vec<_>>(),
        Value::Object(object) => {
            if let Some(data) = object.get("data").and_then(Value::as_array) {
                return data
                    .iter()
                    .map(|item| item.as_u64().unwrap_or(0) as u8)
                    .collect::<Vec<_>>();
            }
            if let Some(buffer) = object.get("buffer") {
                return decode_message_port_frame_payload(buffer);
            }
            if let Some(base64) = object.get("base64").and_then(Value::as_str) {
                return BASE64_STANDARD.decode(base64).unwrap_or_default();
            }
            Vec::new()
        }
        Value::String(text) => BASE64_STANDARD.decode(text).unwrap_or_default(),
        _ => Vec::new(),
    }
}

const IPC_CONTEXT_MENU_CHANNEL: &str = "vscode:contextmenu";
const IPC_CONTEXT_MENU_CLOSE_CHANNEL: &str = "vscode:onCloseContextMenu";
const IPC_EVENT_CHANNEL: &str = "__ipc";
const IPC_EVENT_NAME: &str = "event";

const DEFAULT_EXTENSIONS_GALLERY_SERVICE_URL: &str = "https://open-vsx.org/vscode/gallery";
const DEFAULT_EXTENSIONS_GALLERY_ITEM_URL: &str = "https://open-vsx.org/extension";
const DEFAULT_EXTENSIONS_GALLERY_PUBLISHER_URL: &str = "https://open-vsx.org/publisher";
const DEFAULT_EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE: &str =
    "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}";

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|value| value as f64))
        .or_else(|| value.as_u64().map(|value| value as f64))
}

fn context_menu_position(
    options: Option<&serde_json::Map<String, Value>>,
) -> Option<LogicalPosition<f64>> {
    let options = options?;
    let x = options.get("x").and_then(value_as_f64)?;
    let y = options.get("y").and_then(value_as_f64)?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(LogicalPosition::new(x, y))
}

fn build_context_menu<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    items: &[Value],
    context_menu_id: i64,
    on_click_channel: &str,
    item_bindings: &mut Vec<(String, ActiveContextMenuItem)>,
) -> Result<Menu<R>, String> {
    let menu = Menu::new(app_handle)
        .map_err(|error| format!("vscode:contextmenu failed to create menu: {error}"))?;
    let mut append_to_menu = |item: &dyn IsMenuItem<R>| {
        menu.append(item)
            .map_err(|error| format!("vscode:contextmenu failed to append menu item: {error}"))
    };
    append_context_menu_entries(
        app_handle,
        items,
        context_menu_id,
        on_click_channel,
        item_bindings,
        &mut append_to_menu,
    )?;
    Ok(menu)
}

fn append_context_menu_entries<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    items: &[Value],
    context_menu_id: i64,
    on_click_channel: &str,
    item_bindings: &mut Vec<(String, ActiveContextMenuItem)>,
    append_item: &mut dyn FnMut(&dyn IsMenuItem<R>) -> Result<(), String>,
) -> Result<(), String> {
    for item in items {
        let Some(item_object) = item.as_object() else {
            continue;
        };

        if item_object.get("visible").and_then(Value::as_bool) == Some(false) {
            continue;
        }

        let item_type = item_object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("normal");

        if item_type == "separator" {
            let separator = PredefinedMenuItem::separator(app_handle).map_err(|error| {
                format!("vscode:contextmenu failed to create separator menu item: {error}")
            })?;
            append_item(&separator)?;
            continue;
        }

        if let Some(submenu_items) = item_object.get("submenu").and_then(Value::as_array) {
            let label = item_object
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Submenu");
            let submenu = Submenu::new(app_handle, label, true).map_err(|error| {
                format!("vscode:contextmenu failed to create submenu '{label}': {error}")
            })?;
            let mut append_to_submenu = |item: &dyn IsMenuItem<R>| {
                submenu.append(item).map_err(|error| {
                    format!("vscode:contextmenu failed to append submenu item '{label}': {error}")
                })
            };
            append_context_menu_entries(
                app_handle,
                submenu_items,
                context_menu_id,
                on_click_channel,
                item_bindings,
                &mut append_to_submenu,
            )?;
            if !submenu
                .items()
                .map_err(|error| {
                    format!("vscode:contextmenu failed to inspect submenu '{label}': {error}")
                })?
                .is_empty()
            {
                append_item(&submenu)?;
            }
            continue;
        }

        let context_item_id = match item_object.get("id").and_then(value_as_i64) {
            Some(id) => id,
            None => continue,
        };
        let label = item_object
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let enabled = item_object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let checked = item_object
            .get("checked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let accelerator = item_object.get("accelerator").and_then(Value::as_str);

        let native_menu_item_id =
            format!("vscode-contextmenu::{context_menu_id}::{context_item_id}");

        if item_type == "checkbox" || item_type == "radio" {
            let check_item = create_context_check_menu_item(
                app_handle,
                &native_menu_item_id,
                label,
                enabled,
                checked,
                accelerator,
            )?;
            append_item(&check_item)?;
        } else {
            let menu_item = create_context_menu_item(
                app_handle,
                &native_menu_item_id,
                label,
                enabled,
                accelerator,
            )?;
            append_item(&menu_item)?;
        }

        item_bindings.push((
            native_menu_item_id,
            ActiveContextMenuItem {
                context_menu_id,
                on_click_channel: on_click_channel.to_string(),
                item_id: context_item_id,
            },
        ));
    }

    Ok(())
}

fn create_context_menu_item<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
    label: &str,
    enabled: bool,
    accelerator: Option<&str>,
) -> Result<MenuItem<R>, String> {
    if let Some(accelerator) = accelerator {
        if let Ok(item) = MenuItem::with_id(
            app_handle,
            id.to_string(),
            label,
            enabled,
            Some(accelerator),
        ) {
            return Ok(item);
        }
    }
    MenuItem::with_id(
        app_handle,
        id.to_string(),
        label,
        enabled,
        Option::<&str>::None,
    )
    .map_err(|error| {
        format!("vscode:contextmenu failed to create menu item '{label}' ({id}): {error}")
    })
}

fn create_context_check_menu_item<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
    label: &str,
    enabled: bool,
    checked: bool,
    accelerator: Option<&str>,
) -> Result<CheckMenuItem<R>, String> {
    if let Some(accelerator) = accelerator {
        if let Ok(item) = CheckMenuItem::with_id(
            app_handle,
            id.to_string(),
            label,
            enabled,
            checked,
            Some(accelerator),
        ) {
            return Ok(item);
        }
    }
    CheckMenuItem::with_id(
        app_handle,
        id.to_string(),
        label,
        enabled,
        checked,
        Option::<&str>::None,
    )
    .map_err(|error| {
        format!("vscode:contextmenu failed to create check menu item '{label}' ({id}): {error}")
    })
}

fn remove_context_menu_runtime_entries(
    state: &mut ContextMenuRuntimeState,
    context_menu_id: i64,
) -> bool {
    let Some(menu_state) = state.active_by_context_menu_id.remove(&context_menu_id) else {
        return false;
    };
    for native_menu_id in menu_state.native_menu_item_ids {
        state.item_by_native_menu_id.remove(&native_menu_id);
    }
    true
}

fn env_flag_true(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn apply_default_extensions_gallery_config(product: &mut Value) {
    let Some(product_object) = product.as_object_mut() else {
        return;
    };

    let has_gallery = product_object
        .get("extensionsGallery")
        .and_then(Value::as_object)
        .and_then(|value| value.get("serviceUrl"))
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if has_gallery {
        return;
    }

    if env_flag_true("VSCODE_TAURI_DISABLE_DEFAULT_EXTENSIONS_GALLERY") {
        eprintln!(
            "[tauri.extensionsGallery] default gallery injection disabled by VSCODE_TAURI_DISABLE_DEFAULT_EXTENSIONS_GALLERY"
        );
        return;
    }

    let service_url = std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_SERVICE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EXTENSIONS_GALLERY_SERVICE_URL.to_string());
    let item_url = std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_ITEM_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EXTENSIONS_GALLERY_ITEM_URL.to_string());
    let publisher_url = std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_PUBLISHER_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EXTENSIONS_GALLERY_PUBLISHER_URL.to_string());
    let resource_url_template =
        std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE.to_string());
    let extension_url_template =
        std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_EXTENSION_URL_TEMPLATE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| resource_url_template.clone());
    let control_url = std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_CONTROL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| service_url.clone());
    let nls_base_url = std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_NLS_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| service_url.clone());

    product_object.insert(
        "extensionsGallery".to_string(),
        json!({
            "serviceUrl": service_url,
            "itemUrl": item_url,
            "publisherUrl": publisher_url,
            "resourceUrlTemplate": resource_url_template,
            "extensionUrlTemplate": extension_url_template,
            "controlUrl": control_url,
            "nlsBaseUrl": nls_base_url
        }),
    );
    eprintln!("[tauri.extensionsGallery] injected default extensionsGallery config");
}

#[derive(Default)]
struct ParsedDesktopCliArgs {
    args: serde_json::Map<String, Value>,
    positional_args: Vec<String>,
    workspace: Option<Value>,
    user_data_dir: Option<PathBuf>,
}

fn stable_short_hex_id(input: &str) -> String {
    let mut hash: i32 = 0;
    hash = hash
        .wrapping_shl(5)
        .wrapping_sub(hash)
        .wrapping_add(149_417);
    for byte in input.bytes() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(byte));
    }
    format!("{:08x}", hash as u32)
}

fn to_forward_slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn absolutize_cli_path(value: &str) -> PathBuf {
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        return candidate;
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("/"))
        .join(candidate)
}

fn workspace_value_from_cli_target(value: &str) -> Value {
    let path = absolutize_cli_path(value);
    let normalized = to_forward_slash_path(&path);
    let workspace_id = stable_short_hex_id(&normalized);

    if normalized.to_ascii_lowercase().ends_with(".code-workspace") {
        json!({
            "id": workspace_id,
            "configPath": file_uri_components(&path)
        })
    } else {
        json!({
            "id": workspace_id,
            "uri": file_uri_components(&path)
        })
    }
}

fn parse_desktop_cli_args_from_iter<I>(args: I) -> ParsedDesktopCliArgs
where
    I: IntoIterator<Item = String>,
{
    let mut parsed = ParsedDesktopCliArgs::default();
    let mut iter = args.into_iter().peekable();

    while let Some(arg) = iter.next() {
        if let Some(raw_name) = arg.strip_prefix("--") {
            let (name, inline_value) = match raw_name.split_once('=') {
                Some((key, value)) => (key, Some(value.to_string())),
                None => (raw_name, None),
            };

            let next_value = inline_value.or_else(|| {
                if matches!(iter.peek(), Some(next) if !next.starts_with("--")) {
                    iter.next()
                } else {
                    None
                }
            });

            match name {
                "extensionDevelopmentPath" => {
                    if let Some(value) = next_value {
                        let entry = parsed
                            .args
                            .entry("extensionDevelopmentPath".to_string())
                            .or_insert_with(|| Value::Array(Vec::new()));
                        if let Some(array) = entry.as_array_mut() {
                            array.push(Value::String(
                                absolutize_cli_path(&value).to_string_lossy().to_string(),
                            ));
                        }
                    }
                }
                "extensionTestsPath" | "logsPath" | "crash-reporter-directory" => {
                    if let Some(value) = next_value {
                        parsed.args.insert(
                            name.to_string(),
                            Value::String(absolutize_cli_path(&value).to_string_lossy().to_string()),
                        );
                    }
                }
                "user-data-dir" => {
                    if let Some(value) = next_value {
                        let path = absolutize_cli_path(&value);
                        parsed.user_data_dir = Some(path.clone());
                        parsed.args.insert(
                            "user-data-dir".to_string(),
                            Value::String(path.to_string_lossy().to_string()),
                        );
                    }
                }
                "enable-proposed-api" => {
                    let entry = parsed
                        .args
                        .entry("enable-proposed-api".to_string())
                        .or_insert_with(|| Value::Array(Vec::new()));
                    if let Some(array) = entry.as_array_mut() {
                        if let Some(value) = next_value {
                            array.push(Value::String(value));
                        }
                    }
                }
                "disable-extensions"
                | "skip-welcome"
                | "skip-release-notes"
                | "disable-workspace-trust"
                | "disable-telemetry"
                | "disable-experiments"
                | "disable-updates"
                | "use-inmemory-secretstorage"
                | "no-cached-data" => {
                    parsed.args.insert(name.to_string(), Value::Bool(true));
                }
                _ => {
                    if let Some(value) = next_value {
                        parsed
                            .args
                            .insert(name.to_string(), Value::String(value));
                    } else {
                        parsed.args.insert(name.to_string(), Value::Bool(true));
                    }
                }
            }

            continue;
        }

        parsed.positional_args.push(arg);
    }

    if let Some(first_positional) = parsed.positional_args.first() {
        parsed.workspace = Some(workspace_value_from_cli_target(first_positional));
    }

    parsed
}

fn parse_desktop_cli_args() -> ParsedDesktopCliArgs {
    parse_desktop_cli_args_from_iter(std::env::args().skip(1))
}

fn build_desktop_window_config(repo_root: &Path) -> Result<Value, String> {
    let cli = parse_desktop_cli_args();
    let cli_args = cli.args.clone();
    let nls_messages = read_nls_messages(repo_root)?;
    let mut product = read_json_file(&repo_root.join("product.json"))?;
    apply_default_extensions_gallery_config(&mut product);
    let css_modules = workbench_css_modules(repo_root)?;
    let workbench_bootstrap = resolve_workbench_bootstrap_config(repo_root, &product);

    let home_dir = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    let tmp_dir = std::env::temp_dir();
    let user_data_dir = cli
        .user_data_dir
        .clone()
        .unwrap_or_else(|| repo_root.join(".vscode-tauri").join("user-data"));
    let _ = fs::create_dir_all(&user_data_dir);
    let _ = fs::create_dir_all(user_data_dir.join("User/profiles/default"));
    let builtin_extensions_dir = repo_root.join("extensions");
    let user_extensions_dir = user_data_dir.join("extensions");
    let _ = fs::create_dir_all(&user_extensions_dir);

    let profile_home = user_data_dir.join("User/profiles");
    let profile_location = profile_home.join("default");
    let profile_cache = user_data_dir.join("CachedProfilesData/default");
    let _ = fs::create_dir_all(&profile_cache);
    let _ = fs::create_dir_all(profile_location.join("globalStorage"));
    let _ = fs::create_dir_all(profile_location.join("snippets"));
    let _ = fs::create_dir_all(profile_location.join("prompts"));
    let _ = fs::create_dir_all(profile_location.join("workspaceStorage"));

    ensure_user_data_default_file(&profile_location.join("settings.json"), "{}\n");
    ensure_user_data_default_file(&profile_location.join("keybindings.json"), "[]\n");
    ensure_user_data_default_file(
        &profile_location.join("tasks.json"),
        "{\"version\":\"2.0.0\",\"tasks\":[]}\n",
    );
    ensure_user_data_default_file(&profile_location.join("extensions.json"), "[]\n");
    ensure_user_data_default_file(&profile_location.join("mcp.json"), "{}\n");
    ensure_user_data_default_file(&profile_location.join("chatLanguageModels.json"), "[]\n");

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
    user_env.insert(
        "VSCODE_ELECTROBUN_DISABLE_MESSAGEPORT".to_string(),
        "true".to_string(),
    );

    let mut window_config = json!({
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
        "args": cli_args,
        "_": cli.positional_args,
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

        "workspace": cli.workspace.unwrap_or(Value::Null),
        "isInitialStartup": true,
        "logLevel": 3,
        "loggers": [],
        "workbenchBootstrap": workbench_bootstrap,

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
            "platform": node_platform(),
            "arch": node_arch()
        },
        "isSessionsWindow": false
    });

    if let Some(object) = window_config.as_object_mut() {
        object.extend(cli.args);
    }

    Ok(window_config)
}

fn ensure_user_data_default_file(path: &Path, contents: &str) {
    if path.exists() {
        return;
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, contents);
}

const LEGACY_WORKBENCH_BOOTSTRAP_PATH: &str =
    "/out/vs/code/electron-browser/workbench/workbench.js";
const MIN_WORKBENCH_BOOTSTRAP_PATH: &str =
    "/out-vscode-min/vs/code/electron-browser/workbench/workbench.js";

fn resolve_workbench_bootstrap_config(repo_root: &Path, product: &Value) -> Value {
    let preference = std::env::var("VSCODE_TAURI_WORKBENCH_BUNDLE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "legacy".to_string());
    let legacy_exists = repo_root
        .join("out/vs/code/electron-browser/workbench/workbench.js")
        .is_file();
    let min_exists = repo_root
        .join("out-vscode-min/vs/code/electron-browser/workbench/workbench.js")
        .is_file();

    let preferred_bundle = if preference == "min" && min_exists {
        "min"
    } else if legacy_exists {
        "legacy"
    } else if min_exists {
        "min"
    } else {
        "legacy"
    };
    let (primary_path, fallback_path) = if preferred_bundle == "min" {
        (
            MIN_WORKBENCH_BOOTSTRAP_PATH,
            LEGACY_WORKBENCH_BOOTSTRAP_PATH,
        )
    } else {
        (
            LEGACY_WORKBENCH_BOOTSTRAP_PATH,
            MIN_WORKBENCH_BOOTSTRAP_PATH,
        )
    };
    let build_id = product
        .get("commit")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| product.get("version").and_then(Value::as_str))
        .unwrap_or("dev");

    json!({
        "primaryPath": primary_path,
        "fallbackPath": fallback_path,
        "preferredBundle": preferred_bundle,
        "buildId": build_id
    })
}

fn file_uri_components(path: &Path) -> Value {
    let raw = path.to_string_lossy().replace('\\', "/");
    let path = if raw.starts_with('/') {
        raw
    } else {
        format!("/{raw}")
    };

    json!({
        "$mid": 1,
        "scheme": "file",
        "authority": "",
        "path": path,
        "query": "",
        "fragment": ""
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
        io::ErrorKind::NotADirectory => {
            ("EntryNotADirectory (FileSystemError)", "EntryNotADirectory")
        }
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
    let candidate_paths = [
        repo_root.join("out/nls.messages.json"),
        repo_root.join("out-vscode-min/nls.messages.json"),
    ];

    for path in candidate_paths {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!(
                    "warning: missing NLS messages at {}: {error}",
                    path.display()
                );
                continue;
            }
        };

        match serde_json::from_slice::<Vec<String>>(&bytes) {
            Ok(messages) => return Ok(messages),
            Err(error) => {
                eprintln!(
                    "warning: failed to parse NLS messages at {}: {error}",
                    path.display()
                );
            }
        }
    }

    // Keep startup alive when neither NLS table is available.
    eprintln!("warning: no readable NLS messages found; using empty messages");
    Ok(Vec::new())
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

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        _ => std::env::consts::OS,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" | "amd64" => "x64",
        "aarch64" => "arm64",
        "armv7l" | "armhf" => "arm",
        value => value,
    }
}

fn workbench_css_modules(repo_root: &Path) -> Result<Vec<String>, String> {
    let out_root = repo_root.join("out");
    let vs_root = out_root.join("vs");
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
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

    #[test]
    fn parse_desktop_cli_args_preserves_extension_test_and_workspace_flags() {
        let parsed = parse_desktop_cli_args_from_iter(vec![
            "/tmp/workspace".to_string(),
            "--extensionDevelopmentPath=/tmp/ext-dev".to_string(),
            "--extensionTestsPath".to_string(),
            "/tmp/ext-tests".to_string(),
            "--enable-proposed-api".to_string(),
            "vscode.vscode-api-tests".to_string(),
            "--disable-extensions".to_string(),
            "--logsPath".to_string(),
            "/tmp/logs".to_string(),
            "--user-data-dir".to_string(),
            "/tmp/user-data".to_string(),
        ]);

        assert_eq!(parsed.positional_args, vec!["/tmp/workspace".to_string()]);
        assert_eq!(
            parsed
                .args
                .get("extensionDevelopmentPath")
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .and_then(Value::as_str),
            Some("/tmp/ext-dev")
        );
        assert_eq!(
            parsed
                .args
                .get("extensionTestsPath")
                .and_then(Value::as_str),
            Some("/tmp/ext-tests")
        );
        assert_eq!(
            parsed
                .args
                .get("enable-proposed-api")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            parsed
                .args
                .get("disable-extensions")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            parsed.user_data_dir,
            Some(PathBuf::from("/tmp/user-data"))
        );
        assert_eq!(
            parsed
                .workspace
                .as_ref()
                .and_then(|workspace| workspace.get("uri"))
                .and_then(|uri| uri.get("path"))
                .and_then(Value::as_str),
            Some("/tmp/workspace")
        );
        assert_eq!(
            parsed
                .workspace
                .as_ref()
                .and_then(|workspace| workspace.get("uri"))
                .and_then(|uri| uri.get("scheme"))
                .and_then(Value::as_str),
            Some("file")
        );
    }

    #[test]
    fn parse_desktop_cli_args_treats_workspace_files_as_config_workspaces() {
        let parsed = parse_desktop_cli_args_from_iter(vec![
            "/tmp/project.code-workspace".to_string(),
            "--skip-welcome".to_string(),
        ]);

        assert_eq!(
            parsed
                .workspace
                .as_ref()
                .and_then(|workspace| workspace.get("configPath"))
                .and_then(|uri| uri.get("path"))
                .and_then(Value::as_str),
            Some("/tmp/project.code-workspace")
        );
        assert_eq!(
            parsed.args.get("skip-welcome").and_then(Value::as_bool),
            Some(true)
        );
    }
}

fn main() {
    fn is_repo_root_candidate(path: &Path) -> bool {
        path.join("product.json").is_file()
            && path
                .join("out/vs/code/electron-browser/workbench/workbench.js")
                .is_file()
    }

    fn normalize_path(path: PathBuf) -> PathBuf {
        path.canonicalize().unwrap_or(path)
    }

    fn discover_repo_root() -> PathBuf {
        let mut candidates: Vec<PathBuf> = Vec::new();

        if let Ok(explicit_root) = std::env::var("VSCODE_TAURI_REPO_ROOT") {
            candidates.push(PathBuf::from(explicit_root));
        }

        let compiled_repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        candidates.push(compiled_repo_root.clone());

        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.clone());
            for ancestor in cwd.ancestors().skip(1) {
                candidates.push(ancestor.to_path_buf());
            }
        }

        if let Ok(current_exe) = std::env::current_exe() {
            for ancestor in current_exe.ancestors().skip(1) {
                candidates.push(ancestor.to_path_buf());
            }
        }

        for candidate in candidates {
            let normalized = normalize_path(candidate);
            if is_repo_root_candidate(&normalized) {
                return normalized;
            }
        }

        normalize_path(compiled_repo_root)
    }

    let repo_root = discover_repo_root();

    let app_state = AppState {
        router: CapabilityRouter::new(repo_root.clone()),
        repo_root,
        channel_runtime: Arc::new(Mutex::new(ChannelRuntimeState {
            subscriptions: HashMap::new(),
        })),
        extension_host_runtime: Arc::new(Mutex::new(ExtensionHostRuntimeState::default())),
        next_extension_host_id: AtomicU64::new(1),
        context_menu_runtime: Mutex::new(ContextMenuRuntimeState::default()),
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
            spawn_integration_startup_watchdog();
            capabilities::window::set_app_handle(app.handle().clone());
            let app_handle = app.handle().clone();
            let listener_handle = app_handle.clone();
            let menu_listener_handle = app_handle.clone();
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
            let terminal_listener_handle = app_handle.clone();
            app_handle.listen("terminal_data", move |event| {
                let payload = event.payload();
                if payload.is_empty() {
                    return;
                }

                let state = terminal_listener_handle.state::<AppState>();
                if let Err(error) = state.handle_terminal_data(payload) {
                    eprintln!("[desktop.terminal.bridge.error] {error}");
                }
            });
            app_handle.on_menu_event(move |_app, event| {
                let menu_item_id = event.id().0.clone();
                let state = menu_listener_handle.state::<AppState>();
                if let Err(error) = state.handle_native_menu_event(&menu_item_id) {
                    eprintln!("[desktop.menubar.bridge.error] {error}");
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
