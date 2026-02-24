use crate::capabilities::clipboard::{ClipboardCapability, RustPrimaryClipboardCapability};
use crate::capabilities::dialogs::{DialogsCapability, RustPrimaryDialogsCapability};
use crate::capabilities::filesystem::{FilesystemCapability, RustPrimaryFilesystemCapability};
use crate::capabilities::os::{OsCapability, RustPrimaryOsCapability};
use crate::capabilities::power::{PowerCapability, RustPrimaryPowerCapability};
use crate::capabilities::process::{ProcessCapability, RustPrimaryProcessCapability};
use crate::capabilities::terminal::{RustPrimaryTerminalCapability, TerminalCapability};
use crate::capabilities::update::{RustPrimaryUpdateCapability, UpdateCapability};
use crate::capabilities::window::{RustPrimaryWindowCapability, WindowCapability};
use crate::protocol::CapabilityDomain;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;

#[derive(Clone)]
pub struct CapabilityRouter {
    window: Arc<dyn WindowCapability>,
    filesystem: Arc<dyn FilesystemCapability>,
    terminal: Arc<dyn TerminalCapability>,
    clipboard: Arc<dyn ClipboardCapability>,
    dialogs: Arc<dyn DialogsCapability>,
    process: Arc<dyn ProcessCapability>,
    power: Arc<dyn PowerCapability>,
    os: Arc<dyn OsCapability>,
    update: Arc<dyn UpdateCapability>,
    local_file_handles: Arc<Mutex<HashMap<u64, File>>>,
    next_local_file_handle: Arc<AtomicU64>,
    watcher_state: Arc<Mutex<WatcherRuntimeState>>,
    next_watcher_watch_id: Arc<AtomicU64>,
    menubar_state: Arc<Mutex<MenubarRuntimeState>>,
}

#[derive(Default)]
struct WatcherRuntimeState {
    verbose_logging: bool,
    watch_requests: HashMap<String, WatcherWatchRequestState>,
}

struct WatcherWatchRequestState {
    correlation_id: Option<i64>,
}

#[derive(Default)]
struct MenubarRuntimeState {
    action_by_menu_item_id: HashMap<String, MenubarAction>,
    next_generated_menu_item_id: u64,
}

#[derive(Clone)]
enum MenubarAction {
    RunAction {
        command_id: String,
        args: Vec<Value>,
    },
}

impl CapabilityRouter {
    pub fn new() -> Self {
        Self {
            window: Arc::new(RustPrimaryWindowCapability),
            filesystem: Arc::new(RustPrimaryFilesystemCapability::new()),
            terminal: Arc::new(RustPrimaryTerminalCapability::new()),
            clipboard: Arc::new(RustPrimaryClipboardCapability),
            dialogs: Arc::new(RustPrimaryDialogsCapability),
            process: Arc::new(RustPrimaryProcessCapability::new()),
            power: Arc::new(RustPrimaryPowerCapability::new()),
            os: Arc::new(RustPrimaryOsCapability),
            update: Arc::new(RustPrimaryUpdateCapability::new()),
            local_file_handles: Arc::new(Mutex::new(HashMap::new())),
            next_local_file_handle: Arc::new(AtomicU64::new(1)),
            watcher_state: Arc::new(Mutex::new(WatcherRuntimeState::default())),
            next_watcher_watch_id: Arc::new(AtomicU64::new(1)),
            menubar_state: Arc::new(Mutex::new(MenubarRuntimeState::default())),
        }
    }

    pub async fn dispatch(&self, method: &str, params: &Value) -> Result<Value, String> {
        let domain = CapabilityDomain::from_method(method)
            .ok_or_else(|| format!("Unknown capability domain for method: {method}"))?;

        let rust_result = match domain {
            CapabilityDomain::Window => self.window.invoke(method, params).await,
            CapabilityDomain::Filesystem => self.filesystem.invoke(method, params).await,
            CapabilityDomain::Terminal => self.terminal.invoke(method, params).await,
            CapabilityDomain::Clipboard => self.clipboard.invoke(method, params).await,
            CapabilityDomain::Dialogs => self.dialogs.invoke(method, params).await,
            CapabilityDomain::Process => self.process.invoke(method, params).await,
            CapabilityDomain::Power => self.power.invoke(method, params).await,
            CapabilityDomain::Os => self.os.invoke(method, params).await,
            CapabilityDomain::Update => self.update.invoke(method, params).await,
        }?;

        if let Some(value) = rust_result {
            return Ok(value);
        }

        Ok(dispatch_capability_rust_default(method, params))
    }

    pub async fn dispatch_channel(
        &self,
        channel: &str,
        method: &str,
        args: &Value,
    ) -> Result<Value, String> {
        if let Some(result) = self
            .dispatch_channel_rust_primary(channel, method, args)
            .await?
        {
            return Ok(result);
        }

        if let Some(result) = dispatch_channel_rust_default(channel, method, args) {
            return Ok(result);
        }

        Ok(default_by_method_name(method))
    }

    pub fn watcher_verbose_logging(&self) -> bool {
        self.watcher_state
            .lock()
            .map(|state| state.verbose_logging)
            .unwrap_or(false)
    }

    pub fn watcher_changes_from_filesystem_event(
        &self,
        watch_id: &str,
        path: &str,
        kind: &str,
    ) -> Option<Value> {
        let correlation_id = self.watcher_state.lock().ok().and_then(|state| {
            state
                .watch_requests
                .get(watch_id)
                .map(|value| value.correlation_id)
        })?;
        let resource = file_uri_value_from_path(&PathBuf::from(path));
        let change_type = file_change_type_from_kind(kind);

        if let Some(correlation_id) = correlation_id {
            return Some(json!([{
                "resource": resource,
                "type": change_type,
                "cId": correlation_id
            }]));
        }

        Some(json!([{
            "resource": resource,
            "type": change_type
        }]))
    }

    async fn handle_local_filesystem_watch(&self, args: &Value) -> Result<(), String> {
        let session_id = parse_watch_id_arg(
            nth_arg(args, 0),
            "localFilesystem.watch expected sessionId argument",
        )?;
        let req_id = parse_watch_id_arg(
            nth_arg(args, 1),
            "localFilesystem.watch expected requestId argument",
        )?;
        let resource = nth_arg(args, 2)
            .ok_or_else(|| "localFilesystem.watch expected resource argument".to_string())?;
        let path = extract_fs_path(resource)
            .ok_or_else(|| "localFilesystem.watch expected file URI/path argument".to_string())?;
        let options = nth_arg(args, 3).and_then(Value::as_object);
        let recursive = options
            .and_then(|opts| opts.get("recursive"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let force_polling = options
            .and_then(|opts| opts.get("forcePolling"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let poll_interval_ms = options
            .and_then(|opts| opts.get("pollInterval"))
            .and_then(Value::as_u64)
            .or_else(|| {
                options
                    .and_then(|opts| opts.get("pollIntervalMs"))
                    .and_then(Value::as_u64)
            });
        let watch_id = local_filesystem_watch_id(&session_id, &req_id);

        let _ = self
            .invoke_filesystem_watch(
                path,
                recursive,
                force_polling,
                poll_interval_ms,
                Some(watch_id),
            )
            .await?;
        Ok(())
    }

    async fn handle_local_filesystem_unwatch(&self, args: &Value) -> Result<(), String> {
        let session_id = parse_watch_id_arg(
            nth_arg(args, 0),
            "localFilesystem.unwatch expected sessionId argument",
        )?;
        let req_id = parse_watch_id_arg(
            nth_arg(args, 1),
            "localFilesystem.unwatch expected requestId argument",
        )?;
        let watch_id = local_filesystem_watch_id(&session_id, &req_id);
        self.invoke_filesystem_unwatch(&watch_id).await?;
        Ok(())
    }

    async fn handle_watcher_watch(&self, args: &Value) -> Result<(), String> {
        let requests = nth_arg(args, 0)
            .and_then(Value::as_array)
            .ok_or_else(|| "watcher.watch expected requests array argument".to_string())?;
        self.unwatch_all_watcher_requests().await?;

        let mut watch_requests = HashMap::new();
        let mut first_error: Option<String> = None;
        for request in requests {
            let request_object = match request.as_object() {
                Some(request) => request,
                None => {
                    if first_error.is_none() {
                        first_error =
                            Some("watcher.watch received an invalid request payload".to_string());
                    }
                    continue;
                }
            };

            let path = match request_object.get("path").and_then(Value::as_str) {
                Some(path) => PathBuf::from(path),
                None => {
                    if first_error.is_none() {
                        first_error =
                            Some("watcher.watch request missing string `path`".to_string());
                    }
                    continue;
                }
            };
            let recursive = request_object
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let polling_interval_ms = request_object
                .get("pollingInterval")
                .and_then(Value::as_u64);
            let force_polling = polling_interval_ms.is_some();
            let correlation_id = request_object.get("correlationId").and_then(Value::as_i64);
            let watch_id = format!(
                "watcher:{}",
                self.next_watcher_watch_id.fetch_add(1, Ordering::Relaxed)
            );

            match self
                .invoke_filesystem_watch(
                    path,
                    recursive,
                    force_polling,
                    polling_interval_ms,
                    Some(watch_id.clone()),
                )
                .await
            {
                Ok(_) => {
                    watch_requests.insert(watch_id, WatcherWatchRequestState { correlation_id });
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }

        if watch_requests.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
        }

        let mut state = self
            .watcher_state
            .lock()
            .map_err(|_| "watcher state lock poisoned".to_string())?;
        state.watch_requests = watch_requests;
        Ok(())
    }

    fn handle_watcher_set_verbose_logging(&self, args: &Value) -> Result<(), String> {
        let enabled = nth_arg(args, 0).and_then(Value::as_bool).unwrap_or(false);
        let mut state = self
            .watcher_state
            .lock()
            .map_err(|_| "watcher state lock poisoned".to_string())?;
        state.verbose_logging = enabled;
        Ok(())
    }

    async fn handle_watcher_stop(&self) -> Result<(), String> {
        self.unwatch_all_watcher_requests().await
    }

    async fn unwatch_all_watcher_requests(&self) -> Result<(), String> {
        let watch_ids = {
            let mut state = self
                .watcher_state
                .lock()
                .map_err(|_| "watcher state lock poisoned".to_string())?;
            let ids = state.watch_requests.keys().cloned().collect::<Vec<_>>();
            state.watch_requests.clear();
            ids
        };

        for watch_id in watch_ids {
            self.invoke_filesystem_unwatch(&watch_id).await?;
        }

        Ok(())
    }

    async fn invoke_filesystem_watch(
        &self,
        path: PathBuf,
        recursive: bool,
        force_polling: bool,
        poll_interval_ms: Option<u64>,
        watch_id: Option<String>,
    ) -> Result<Value, String> {
        let mut payload = json!({
            "path": path,
            "recursive": recursive,
            "forcePolling": force_polling
        });
        if let Some(watch_id) = watch_id {
            payload["watchId"] = json!(watch_id);
        }
        if let Some(poll_interval_ms) = poll_interval_ms {
            payload["pollIntervalMs"] = json!(poll_interval_ms);
        }

        self.filesystem
            .invoke("filesystem.watch", &payload)
            .await?
            .ok_or_else(|| "filesystem.watch returned no result".to_string())
    }

    async fn invoke_filesystem_unwatch(&self, watch_id: &str) -> Result<(), String> {
        self.filesystem
            .invoke("filesystem.unwatch", &json!({ "watchId": watch_id }))
            .await?;
        Ok(())
    }

    async fn dispatch_channel_rust_primary(
        &self,
        channel: &str,
        method: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        let arg0 = first_arg(args);

        match channel {
            "logger" => match method {
                "getRegisteredLoggers" => Ok(Some(json!([]))),
                "createLogger" | "log" | "consoleLog" | "registerLogger" | "deregisterLogger"
                | "setLogLevel" | "setVisibility" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "storage" => match method {
                "getItems" => Ok(Some(json!([]))),
                "isUsed" => Ok(Some(json!(false))),
                "updateItems" | "optimize" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "policy" => match method {
                "updatePolicyDefinitions" => Ok(Some(json!({}))),
                _ => Ok(None),
            },
            "sign" => match method {
                "sign" => Ok(Some(json!(extract_string_arg(arg0).unwrap_or_default()))),
                "createNewMessage" => {
                    let data = extract_string_arg(arg0).unwrap_or_default();
                    let id = stable_short_hex_id(&data);
                    Ok(Some(json!({ "id": id, "data": data })))
                }
                "validate" => Ok(Some(json!(true))),
                _ => Ok(None),
            },
            "userDataProfiles" => match method {
                "createNamedProfile" => {
                    let name = extract_string_arg(arg0).unwrap_or_else(|| "Named".to_string());
                    Ok(Some(fallback_user_data_profile("named", &name)))
                }
                "createProfile" => {
                    let id = extract_string_arg(nth_arg(args, 0))
                        .unwrap_or_else(|| "profile".to_string());
                    let name = extract_string_arg(nth_arg(args, 1))
                        .unwrap_or_else(|| "Profile".to_string());
                    Ok(Some(fallback_user_data_profile(&id, &name)))
                }
                "createTransientProfile" => {
                    Ok(Some(fallback_user_data_profile("transient", "Transient")))
                }
                "updateProfile" => {
                    if let Some(profile) = nth_arg(args, 0) {
                        if profile.is_object() {
                            return Ok(Some(profile.clone()));
                        }
                    }
                    Ok(Some(fallback_user_data_profile("updated", "Updated")))
                }
                "removeProfile"
                | "setProfileForWorkspace"
                | "resetWorkspaces"
                | "cleanUp"
                | "cleanUpTransientProfiles" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "workspaces" => match method {
                "getRecentlyOpened" => Ok(Some(json!({ "workspaces": [], "files": [] }))),
                "getDirtyWorkspaces" => Ok(Some(json!([]))),
                "getWorkspaceIdentifier" => {
                    Ok(Some(fallback_workspace_identifier("tauri-existing")))
                }
                "createUntitledWorkspace" => {
                    Ok(Some(fallback_workspace_identifier("tauri-untitled")))
                }
                "enterWorkspace" => Ok(Some(
                    json!({ "workspace": fallback_workspace_identifier("tauri-entered") }),
                )),
                "addRecentlyOpened"
                | "removeRecentlyOpened"
                | "clearRecentlyOpened"
                | "deleteUntitledWorkspace" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "keyboardLayout" => match method {
                "getKeyboardLayoutData" => Ok(Some(json!({
                    "keyboardLayoutInfo": {
                        "id": "tauri-us",
                        "lang": "en",
                        "layout": "US"
                    },
                    "keyboardMapping": {}
                }))),
                _ => Ok(None),
            },
            "extensionHostStarter" => match method {
                "createExtensionHost" => Ok(Some(json!({ "id": "tauri-extension-host" }))),
                "start" => Ok(Some(json!({ "pid": Value::Null }))),
                "enableInspectPort" => Ok(Some(json!(false))),
                "kill" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "externalTerminal" => match method {
                "openTerminal" => Ok(Some(Value::Null)),
                "runInTerminal" => Ok(Some(Value::Null)),
                "getDefaultTerminalForPlatforms" => Ok(Some(json!({
                    "windows": "cmd.exe",
                    "linux": "xterm",
                    "osx": "Terminal.app"
                }))),
                _ => Ok(None),
            },
            "localPty" => match method {
                "getPerformanceMarks" | "getLatency" | "getProfiles" => Ok(Some(json!([]))),
                "getDefaultSystemShell" => Ok(Some(json!(
                    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
                ))),
                "getEnvironment" | "getShellEnvironment" => Ok(Some(json!({}))),
                "getTerminalLayoutInfo" | "requestDetachInstance" => Ok(Some(Value::Null)),
                "setTerminalLayoutInfo"
                | "reduceConnectionGraceTime"
                | "persistTerminalState"
                | "acceptDetachInstanceReply" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "localFilesystem" => match method {
                "stat" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.stat expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.stat expected file URI/path argument".to_string()
                    })?;
                    let metadata = fs::symlink_metadata(&fs_path).map_err(|error| {
                        format!(
                            "localFilesystem.stat failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;

                    Ok(Some(json!({
                        "type": file_type_from_metadata(&metadata),
                        "ctime": to_epoch_millis(metadata.created().ok().or_else(|| metadata.modified().ok())),
                        "mtime": to_epoch_millis(metadata.modified().ok()),
                        "size": metadata.len()
                    })))
                }
                "realpath" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.realpath expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.realpath expected file URI/path argument".to_string()
                    })?;
                    let resolved = fs::canonicalize(&fs_path).map_err(|error| {
                        format!(
                            "localFilesystem.realpath failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;

                    Ok(Some(json!({
                        "scheme": "file",
                        "authority": "",
                        "path": to_forward_slash_path(&resolved)
                    })))
                }
                "readdir" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.readdir expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.readdir expected file URI/path argument".to_string()
                    })?;
                    let entries = fs::read_dir(&fs_path).map_err(|error| {
                        format!(
                            "localFilesystem.readdir failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;

                    let mut out = Vec::new();
                    for entry in entries {
                        let entry = entry.map_err(|error| {
                            format!(
                                "localFilesystem.readdir failed for {}: {error}",
                                fs_path.display()
                            )
                        })?;
                        let path = entry.path();
                        let metadata = fs::symlink_metadata(&path).map_err(|error| {
                            format!(
                                "localFilesystem.readdir failed for {}: {error}",
                                path.display()
                            )
                        })?;
                        let name = entry.file_name().to_string_lossy().to_string();
                        out.push(json!([name, file_type_from_metadata(&metadata)]));
                    }

                    Ok(Some(Value::Array(out)))
                }
                "readFile" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.readFile expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.readFile expected file URI/path argument".to_string()
                    })?;
                    let bytes = fs::read(&fs_path).map_err(|error| {
                        format!(
                            "localFilesystem.readFile failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;

                    Ok(Some(json!({
                        "buffer": bytes
                    })))
                }
                "open" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.open expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.open expected file URI/path argument".to_string()
                    })?;
                    let options = nth_arg(args, 1).and_then(Value::as_object);
                    let create = options
                        .and_then(|value| value.get("create"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let append = options
                        .and_then(|value| value.get("append"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);

                    let mut open_options = OpenOptions::new();
                    if create {
                        open_options.create(true);
                        if append {
                            open_options.append(true);
                        } else {
                            open_options.write(true).truncate(true);
                        }
                    } else {
                        open_options.read(true);
                    }

                    let file = open_options.open(&fs_path).map_err(|error| {
                        format!(
                            "localFilesystem.open failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;
                    let fd = self.next_local_file_handle.fetch_add(1, Ordering::Relaxed);
                    let mut handles = self.local_file_handles.lock().map_err(|_| {
                        "localFilesystem.open could not lock file handles".to_string()
                    })?;
                    handles.insert(fd, file);

                    Ok(Some(json!(fd)))
                }
                "close" => {
                    let fd = parse_u64_arg(
                        nth_arg(args, 0),
                        "localFilesystem.close expected file descriptor argument",
                    )?;
                    let mut handles = self.local_file_handles.lock().map_err(|_| {
                        "localFilesystem.close could not lock file handles".to_string()
                    })?;
                    if handles.remove(&fd).is_none() {
                        return Err(format!(
                            "localFilesystem.close failed: unknown file descriptor {fd}"
                        ));
                    }
                    Ok(Some(Value::Null))
                }
                "read" => {
                    let fd = parse_u64_arg(
                        nth_arg(args, 0),
                        "localFilesystem.read expected file descriptor argument",
                    )?;
                    let pos = parse_u64_arg(
                        nth_arg(args, 1),
                        "localFilesystem.read expected position argument",
                    )?;
                    let length = parse_usize_arg(
                        nth_arg(args, 2),
                        "localFilesystem.read expected length argument",
                    )?;

                    let mut handles = self.local_file_handles.lock().map_err(|_| {
                        "localFilesystem.read could not lock file handles".to_string()
                    })?;
                    let file = handles.get_mut(&fd).ok_or_else(|| {
                        format!("localFilesystem.read failed: unknown file descriptor {fd}")
                    })?;
                    file.seek(SeekFrom::Start(pos)).map_err(|error| {
                        format!("localFilesystem.read seek failed for descriptor {fd}: {error}")
                    })?;

                    let mut buffer = vec![0u8; length];
                    let bytes_read = file.read(&mut buffer).map_err(|error| {
                        format!("localFilesystem.read failed for descriptor {fd}: {error}")
                    })?;
                    buffer.truncate(bytes_read);

                    Ok(Some(json!([
                        { "buffer": buffer },
                        bytes_read
                    ])))
                }
                "write" => {
                    let fd = parse_u64_arg(
                        nth_arg(args, 0),
                        "localFilesystem.write expected file descriptor argument",
                    )?;
                    let pos = parse_u64_arg(
                        nth_arg(args, 1),
                        "localFilesystem.write expected position argument",
                    )?;
                    let data = nth_arg(args, 2).ok_or_else(|| {
                        "localFilesystem.write expected data argument".to_string()
                    })?;
                    let bytes = decode_byte_array(data)
                        .ok_or_else(|| "localFilesystem.write expected byte content".to_string())?;
                    let offset = nth_arg(args, 3)
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or(0);
                    let length = nth_arg(args, 4)
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or_else(|| bytes.len().saturating_sub(offset));

                    if offset > bytes.len() {
                        return Err(format!(
                            "localFilesystem.write invalid offset {offset} for {} bytes",
                            bytes.len()
                        ));
                    }
                    let end = offset.checked_add(length).ok_or_else(|| {
                        "localFilesystem.write invalid offset/length combination".to_string()
                    })?;
                    if end > bytes.len() {
                        return Err(format!(
                            "localFilesystem.write invalid length {length} for offset {offset} and {} bytes",
                            bytes.len()
                        ));
                    }
                    let payload = &bytes[offset..end];

                    let mut handles = self.local_file_handles.lock().map_err(|_| {
                        "localFilesystem.write could not lock file handles".to_string()
                    })?;
                    let file = handles.get_mut(&fd).ok_or_else(|| {
                        format!("localFilesystem.write failed: unknown file descriptor {fd}")
                    })?;
                    file.seek(SeekFrom::Start(pos)).map_err(|error| {
                        format!("localFilesystem.write seek failed for descriptor {fd}: {error}")
                    })?;
                    file.write_all(payload).map_err(|error| {
                        format!("localFilesystem.write failed for descriptor {fd}: {error}")
                    })?;

                    Ok(Some(json!(payload.len())))
                }
                "writeFile" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.writeFile expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.writeFile expected file URI/path argument".to_string()
                    })?;
                    let content = nth_arg(args, 1).ok_or_else(|| {
                        "localFilesystem.writeFile expected content argument".to_string()
                    })?;
                    let bytes = decode_byte_array(content).ok_or_else(|| {
                        "localFilesystem.writeFile expected byte content".to_string()
                    })?;

                    if let Some(parent) = fs_path.parent() {
                        if !parent.as_os_str().is_empty() {
                            fs::create_dir_all(parent).map_err(|error| {
                                format!(
                                    "localFilesystem.writeFile failed to create parent {}: {error}",
                                    parent.display()
                                )
                            })?;
                        }
                    }

                    fs::write(&fs_path, &bytes).map_err(|error| {
                        format!(
                            "localFilesystem.writeFile failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;

                    Ok(Some(Value::Null))
                }
                "mkdir" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.mkdir expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.mkdir expected file URI/path argument".to_string()
                    })?;
                    fs::create_dir_all(&fs_path).map_err(|error| {
                        format!(
                            "localFilesystem.mkdir failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;
                    Ok(Some(Value::Null))
                }
                "delete" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "localFilesystem.delete expected resource argument".to_string()
                    })?;
                    let fs_path = extract_fs_path(resource).ok_or_else(|| {
                        "localFilesystem.delete expected file URI/path argument".to_string()
                    })?;
                    let recursive = nth_arg(args, 1)
                        .and_then(Value::as_object)
                        .and_then(|opts| opts.get("recursive"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);

                    remove_path_force(&fs_path, recursive).map_err(|error| {
                        format!(
                            "localFilesystem.delete failed for {}: {error}",
                            fs_path.display()
                        )
                    })?;
                    Ok(Some(Value::Null))
                }
                "rename" => {
                    let source = nth_arg(args, 0)
                        .and_then(extract_fs_path)
                        .ok_or_else(|| "localFilesystem.rename expected source path".to_string())?;
                    let target = nth_arg(args, 1)
                        .and_then(extract_fs_path)
                        .ok_or_else(|| "localFilesystem.rename expected target path".to_string())?;
                    let overwrite = nth_arg(args, 2)
                        .and_then(Value::as_object)
                        .and_then(|opts| opts.get("overwrite"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);

                    if overwrite {
                        remove_path_force(&target, true).map_err(|error| {
                            format!(
                                "localFilesystem.rename could not remove existing target {}: {error}",
                                target.display()
                            )
                        })?;
                    }

                    if let Some(parent) = target.parent() {
                        if !parent.as_os_str().is_empty() {
                            fs::create_dir_all(parent).map_err(|error| {
                                format!(
                                    "localFilesystem.rename failed to create parent {}: {error}",
                                    parent.display()
                                )
                            })?;
                        }
                    }

                    fs::rename(&source, &target).map_err(|error| {
                        format!(
                            "localFilesystem.rename failed from {} to {}: {error}",
                            source.display(),
                            target.display()
                        )
                    })?;
                    Ok(Some(Value::Null))
                }
                "copy" => {
                    let source = nth_arg(args, 0)
                        .and_then(extract_fs_path)
                        .ok_or_else(|| "localFilesystem.copy expected source path".to_string())?;
                    let target = nth_arg(args, 1)
                        .and_then(extract_fs_path)
                        .ok_or_else(|| "localFilesystem.copy expected target path".to_string())?;
                    let overwrite = nth_arg(args, 2)
                        .and_then(Value::as_object)
                        .and_then(|opts| opts.get("overwrite"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);

                    copy_path_recursive(&source, &target, overwrite).map_err(|error| {
                        format!(
                            "localFilesystem.copy failed from {} to {}: {error}",
                            source.display(),
                            target.display()
                        )
                    })?;
                    Ok(Some(Value::Null))
                }
                "cloneFile" => {
                    let source = nth_arg(args, 0).and_then(extract_fs_path).ok_or_else(|| {
                        "localFilesystem.cloneFile expected source path".to_string()
                    })?;
                    let target = nth_arg(args, 1).and_then(extract_fs_path).ok_or_else(|| {
                        "localFilesystem.cloneFile expected target path".to_string()
                    })?;

                    if let Some(parent) = target.parent() {
                        if !parent.as_os_str().is_empty() {
                            fs::create_dir_all(parent).map_err(|error| {
                                format!(
                                    "localFilesystem.cloneFile failed to create parent {}: {error}",
                                    parent.display()
                                )
                            })?;
                        }
                    }

                    fs::copy(&source, &target).map_err(|error| {
                        format!(
                            "localFilesystem.cloneFile failed from {} to {}: {error}",
                            source.display(),
                            target.display()
                        )
                    })?;
                    Ok(Some(Value::Null))
                }
                "watch" => self
                    .handle_local_filesystem_watch(args)
                    .await
                    .map(|_| Some(Value::Null)),
                "unwatch" => self
                    .handle_local_filesystem_unwatch(args)
                    .await
                    .map(|_| Some(Value::Null)),
                _ => Ok(None),
            },
            "watcher" => match method {
                "watch" => self
                    .handle_watcher_watch(args)
                    .await
                    .map(|_| Some(Value::Null)),
                "setVerboseLogging" => self
                    .handle_watcher_set_verbose_logging(args)
                    .map(|_| Some(Value::Null)),
                "stop" => self.handle_watcher_stop().await.map(|_| Some(Value::Null)),
                _ => Ok(None),
            },
            "profileStorageListener" => match method {
                "onDidChange" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "telemetryAppender" => match method {
                "log" => {
                    let payload = first_arg(args).unwrap_or(args);
                    let event_name = payload
                        .get("eventName")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let data = payload.get("data").cloned().unwrap_or_else(|| json!({}));
                    if let Some(app_handle) = crate::capabilities::window::app_handle() {
                        let _ = app_handle.emit(
                            "telemetry_log",
                            json!({
                                "eventName": event_name,
                                "data": data
                            }),
                        );
                    }
                    Ok(Some(Value::Null))
                }
                "flush" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "urlHandler" => match method {
                "handleURL" => {
                    let target_arg = nth_arg(args, 0).or_else(|| first_arg(args));
                    if let Some(target) = target_arg.and_then(extract_url_from_any) {
                        let opened = self
                            .os
                            .invoke("os.openExternal", &json!({ "url": target }))
                            .await?
                            .unwrap_or_else(|| json!({ "opened": false }))
                            .get("opened")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        return Ok(Some(json!(opened)));
                    }
                    Ok(Some(json!(false)))
                }
                _ => Ok(None),
            },
            "checksum" => match method {
                "checksum" => {
                    let resource = nth_arg(args, 0).ok_or_else(|| {
                        "checksum.checksum expected resource argument".to_string()
                    })?;
                    let path = extract_fs_path(resource)
                        .ok_or_else(|| "checksum.checksum expected file URI/path".to_string())?;
                    let checksum = checksum_file_sha256_base64(&path)?;
                    Ok(Some(json!(checksum)))
                }
                _ => Ok(None),
            },
            "browserElements" => match method {
                "startDebugSession" | "startConsoleSession" => Ok(Some(Value::Null)),
                "getConsoleLogs" => Ok(Some(Value::Null)),
                "getElementData" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "nativeHost" => match method {
                "notifyReady" => Ok(Some(Value::Null)),
                "openWindow"
                | "openSessionsWindow"
                | "setBackgroundThrottling"
                | "setMinimumSize"
                | "saveWindowSplash"
                | "setRepresentedFilename"
                | "setDocumentEdited"
                | "openDevTools"
                | "toggleDevTools"
                | "reload"
                | "relaunch"
                | "quit"
                | "exit"
                | "updateTouchBar"
                | "updateWindowControls"
                | "pickFileFolderAndOpen"
                | "pickFileAndOpen"
                | "pickFolderAndOpen"
                | "pickWorkspaceAndOpen" => Ok(Some(Value::Null)),
                "focusWindow" => {
                    self.window
                        .invoke("window.focus", &json!({ "target": "main" }))
                        .await?;
                    Ok(Some(Value::Null))
                }
                "isMaximized"
                | "isWindowAlwaysOnTop"
                | "isOnBatteryPower"
                | "hasClipboard"
                | "hasWSLFeatureInstalled"
                | "isAdmin"
                | "isRunningUnderARM64Translation" => Ok(Some(json!(false))),
                "getWindowCount" | "getActiveWindowId" => Ok(Some(json!(1))),
                "getOSVirtualMachineHint" => Ok(Some(json!(0))),
                "getWindows" => Ok(Some(json!([]))),
                "getCursorScreenPoint" => Ok(Some(json!({
                    "point": { "x": 0, "y": 0 },
                    "display": { "x": 0, "y": 0, "width": 0, "height": 0 }
                }))),
                "isFullScreen" => {
                    let state = self
                        .window
                        .invoke("window.getState", &json!({ "target": "main" }))
                        .await?
                        .unwrap_or(json!({}));
                    Ok(Some(json!(state
                        .get("fullscreen")
                        .and_then(Value::as_bool)
                        .unwrap_or(false))))
                }
                "toggleFullScreen" => {
                    let state = self
                        .window
                        .invoke("window.getState", &json!({ "target": "main" }))
                        .await?
                        .unwrap_or(json!({}));
                    let is_fullscreen = state
                        .get("fullscreen")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.window
                        .invoke(
                            "window.setFullscreen",
                            &json!({
                                "target": "main",
                                "enabled": !is_fullscreen
                            }),
                        )
                        .await?;
                    Ok(Some(Value::Null))
                }
                "openExternal" => {
                    if let Some(url) = extract_string_arg(arg0) {
                        let result = self
                            .os
                            .invoke("os.openExternal", &json!({ "url": url }))
                            .await?
                            .unwrap_or(json!({}));
                        let opened = result
                            .get("opened")
                            .and_then(Value::as_bool)
                            .unwrap_or(true);
                        return Ok(Some(json!(opened)));
                    }

                    Ok(Some(json!(false)))
                }
                "showItemInFolder" => {
                    if let Some(path) = extract_string_arg(arg0) {
                        self.os
                            .invoke("os.showItemInFolder", &json!({ "path": path }))
                            .await?;
                    }
                    Ok(Some(Value::Null))
                }
                "showMessageBox" => {
                    let payload = arg0.cloned().unwrap_or_else(|| json!({}));
                    let message = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("VS Code");
                    let title = payload
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Code Tauri");
                    let buttons = payload
                        .get("buttons")
                        .cloned()
                        .unwrap_or_else(|| json!(["OK"]));
                    let response = self
                        .dialogs
                        .invoke(
                            "dialogs.showMessage",
                            &json!({
                                "title": title,
                                "message": message,
                                "buttons": buttons
                            }),
                        )
                        .await?
                        .unwrap_or_else(|| json!({ "selectedIndex": 0 }));
                    let selected_index = response
                        .get("selectedIndex")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    Ok(Some(json!({
                        "response": selected_index,
                        "checkboxChecked": false
                    })))
                }
                "showOpenDialog" => {
                    let payload = arg0.cloned().unwrap_or_else(|| json!({}));
                    let prefers_folders = payload
                        .get("properties")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .any(|item| item == "openDirectory")
                        })
                        .unwrap_or(false);
                    let result = if prefers_folders {
                        self.dialogs.invoke("dialogs.openFolder", &payload).await?
                    } else {
                        self.dialogs.invoke("dialogs.openFile", &payload).await?
                    }
                    .unwrap_or_else(|| json!({ "canceled": true }));

                    if result.get("canceled").and_then(Value::as_bool) == Some(true) {
                        return Ok(Some(json!({
                            "canceled": true,
                            "filePaths": []
                        })));
                    }

                    let path = result
                        .get("path")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    Ok(Some(json!({
                        "canceled": path.is_none(),
                        "filePaths": path.into_iter().collect::<Vec<String>>()
                    })))
                }
                "showSaveDialog" => {
                    let payload = arg0.cloned().unwrap_or_else(|| json!({}));
                    let result = self
                        .dialogs
                        .invoke("dialogs.saveFile", &payload)
                        .await?
                        .unwrap_or_else(|| json!({ "canceled": true }));
                    let file_path = result.get("path").and_then(Value::as_str);
                    Ok(Some(json!({
                        "canceled": file_path.is_none(),
                        "filePath": file_path
                    })))
                }
                "readClipboardText" => {
                    let result = self
                        .clipboard
                        .invoke("clipboard.readText", &json!({}))
                        .await?
                        .unwrap_or_else(|| json!({ "text": "" }));
                    Ok(Some(json!(result
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(""))))
                }
                "readClipboardFindText" => {
                    let result = self
                        .clipboard
                        .invoke("clipboard.readText", &json!({}))
                        .await?
                        .unwrap_or_else(|| json!({ "text": "" }));
                    Ok(Some(json!(result
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(""))))
                }
                "writeClipboardText" => {
                    if let Some(text) = extract_string_arg(arg0) {
                        self.clipboard
                            .invoke("clipboard.writeText", &json!({ "text": text }))
                            .await?;
                    }
                    Ok(Some(Value::Null))
                }
                "writeClipboardFindText" => {
                    if let Some(text) = extract_string_arg(arg0) {
                        self.clipboard
                            .invoke("clipboard.writeText", &json!({ "text": text }))
                            .await?;
                    }
                    Ok(Some(Value::Null))
                }
                "readImage" => Ok(Some(json!([]))),
                "getProcessId" => Ok(Some(json!(std::process::id()))),
                "getOSColorScheme" => Ok(Some(json!({
                    "dark": false,
                    "highContrast": false
                }))),
                "getOSProperties" => {
                    let info = self
                        .os
                        .invoke("os.systemInfo", &json!({}))
                        .await?
                        .unwrap_or_else(|| json!({}));
                    Ok(Some(json!({
                        "type": std::env::consts::OS,
                        "release": "0.0.0",
                        "arch": info.get("arch").and_then(Value::as_str).unwrap_or(std::env::consts::ARCH),
                        "platform": info.get("os").and_then(Value::as_str).unwrap_or(std::env::consts::OS),
                        "cpus": []
                    })))
                }
                "getOSStatistics" => Ok(Some(json!({
                    "totalmem": 0,
                    "freemem": 0,
                    "loadavg": [0, 0, 0]
                }))),
                "getSystemIdleState" => Ok(Some(json!("active"))),
                "getSystemIdleTime" => Ok(Some(json!(0))),
                "getCurrentThermalState" => Ok(Some(json!("nominal"))),
                "startPowerSaveBlocker" => Ok(Some(json!(1))),
                "isPowerSaveBlockerStarted" => Ok(Some(json!(false))),
                "stopPowerSaveBlocker" => Ok(Some(json!(true))),
                "resolveProxy" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "menubar" => match method {
                "updateMenubar" => self.handle_menubar_update(args).map(|_| Some(Value::Null)),
                _ => Ok(None),
            },
            "extensionhostdebugservice" => match method {
                "reload" | "close" | "attach" | "terminate" => Ok(Some(Value::Null)),
                "openExtensionDevelopmentHostWindow" | "attachToCurrentWindowRenderer" => {
                    Ok(Some(json!({ "success": false })))
                }
                _ => Ok(None),
            },
            "extensionTipsService" => match method {
                "getConfigBasedTips"
                | "getImportantExecutableBasedTips"
                | "getOtherExecutableBasedTips" => Ok(Some(json!([]))),
                _ => Ok(None),
            },
            "userDataSyncAccount" => match method {
                "_getInitialData" | "updateAccount" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "userDataAutoSync" => match method {
                "triggerSync" | "turnOn" | "turnOff" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "userDataSyncMachines" => match method {
                "getMachines" => Ok(Some(json!([]))),
                "addCurrentMachine"
                | "removeCurrentMachine"
                | "renameMachine"
                | "setEnablements" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "NativeMcpDiscoveryHelper" => match method {
                "load" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "mcpGalleryManifest" => match method {
                "setMcpGalleryManifest" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "extensionGalleryManifest" => match method {
                "setExtensionGalleryManifest" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "remoteTunnel" => match method {
                "getMode" => Ok(Some(json!({ "active": false }))),
                "getTunnelStatus" | "initialize" | "startTunnel" => {
                    Ok(Some(json!({ "type": "disconnected" })))
                }
                "stopTunnel" => Ok(Some(Value::Null)),
                "getTunnelName" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "languagePacks" => match method {
                "getAvailableLanguages" | "getInstalledLanguages" => Ok(Some(json!([
                    {
                        "id": "en",
                        "label": "English"
                    }
                ]))),
                "getBuiltInExtensionTranslationsUri" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "customEndpointTelemetry" => match method {
                "publicLog" | "publicLogError" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "sharedWebContentExtractor" => match method {
                "readImage" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "playwright" => match method {
                "initialize" => Ok(Some(Value::Null)),
                _ => Ok(None),
            },
            "url" => match method {
                "open" | "handleURL" => {
                    if let Some(target) = arg0 {
                        let url = extract_url_from_any(target);
                        if let Some(url) = url {
                            let opened = self
                                .os
                                .invoke("os.openExternal", &json!({ "url": url }))
                                .await?
                                .unwrap_or_else(|| json!({ "opened": false }))
                                .get("opened")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            return Ok(Some(json!(opened)));
                        }
                    }

                    Ok(Some(json!(false)))
                }
                _ => Ok(None),
            },
            _ => Ok(None),
        }
    }

    pub fn fallback_counts(&self) -> std::collections::BTreeMap<String, u64> {
        std::collections::BTreeMap::new()
    }

    pub fn menubar_action_payload(&self, menu_item_id: &str) -> Option<Value> {
        let state = self.menubar_state.lock().ok()?;
        let action = state.action_by_menu_item_id.get(menu_item_id)?.clone();
        match action {
            MenubarAction::RunAction { command_id, args } => {
                let mut request = json!({
                    "id": command_id,
                    "from": "menu"
                });
                if !args.is_empty() {
                    request["args"] = Value::Array(args);
                }
                Some(request)
            }
        }
    }

    fn handle_menubar_update(&self, args: &Value) -> Result<(), String> {
        let menubar_data = nth_arg(args, 1)
            .or_else(|| nth_arg(args, 0))
            .ok_or_else(|| "menubar.updateMenubar expected menubar data argument".to_string())?;
        let menus = menubar_data
            .get("menus")
            .and_then(Value::as_object)
            .ok_or_else(|| "menubar.updateMenubar missing menus object".to_string())?;
        let keybindings = menubar_data.get("keybindings").and_then(Value::as_object);
        let app_handle = crate::capabilities::window::app_handle()
            .ok_or_else(|| "tauri app handle not initialized".to_string())?;

        let mut runtime_state = MenubarRuntimeState::default();

        #[cfg(target_os = "macos")]
        {
            let menu =
                build_macos_native_menu(&app_handle, menus, keybindings, &mut runtime_state)?;
            menu.set_as_app_menu().map_err(|error| {
                format!("menubar.updateMenubar failed to set app menu: {error}")
            })?;
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (&app_handle, menus, keybindings);
        }

        let mut state = self
            .menubar_state
            .lock()
            .map_err(|_| "menubar state lock poisoned".to_string())?;
        *state = runtime_state;
        Ok(())
    }
}

fn dispatch_channel_rust_default(channel: &str, method: &str, _args: &Value) -> Option<Value> {
    match channel {
        "extensions" => match method {
            "getInstalled" => Some(json!([])),
            "getExtensionsControlManifest" => Some(json!({
                "malicious": [],
                "deprecated": {},
                "search": {},
                "autoUpdate": {}
            })),
            _ => Some(default_by_method_name(method)),
        },
        "mcpManagement" => match method {
            "getInstalled" => Some(json!([])),
            _ => Some(default_by_method_name(method)),
        },
        "userDataSync" => match method {
            "_getInitialData" => Some(json!(["uninitialized", [], Value::Null])),
            _ => Some(default_by_method_name(method)),
        },
        "userDataSyncStoreManagement" => match method {
            "getPreviousUserDataSyncStore" => {
                let fallback_store =
                    json!({ "scheme": "file", "authority": "", "path": "/tmp/vscode-tauri/sync" });
                Some(json!({
                    "url": fallback_store,
                    "type": "stable",
                    "defaultUrl": fallback_store,
                    "insidersUrl": fallback_store,
                    "stableUrl": fallback_store,
                    "canSwitch": false,
                    "authenticationProviders": {}
                }))
            }
            _ => Some(default_by_method_name(method)),
        },
        "update" => match method {
            "_getInitialState" => Some(json!({ "type": "uninitialized" })),
            _ => Some(default_by_method_name(method)),
        },
        _ => Some(default_by_method_name(method)),
    }
}

fn dispatch_capability_rust_default(method: &str, _params: &Value) -> Value {
    default_by_method_name(method)
}

fn default_by_method_name(method: &str) -> Value {
    if method.starts_with("is") || method.starts_with("has") {
        return json!(false);
    }
    if method.starts_with("get") {
        return Value::Null;
    }
    Value::Null
}

#[cfg(target_os = "macos")]
const MENUBAR_TOP_LEVEL_ORDER: [&str; 9] = [
    "File",
    "Edit",
    "Selection",
    "View",
    "Go",
    "Run",
    "Terminal",
    "Window",
    "Help",
];

#[cfg(target_os = "macos")]
fn build_macos_native_menu<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    menus: &serde_json::Map<String, Value>,
    keybindings: Option<&serde_json::Map<String, Value>>,
    runtime_state: &mut MenubarRuntimeState,
) -> Result<Menu<R>, String> {
    let menu = Menu::new(app_handle)
        .map_err(|error| format!("menubar.updateMenubar failed to create root menu: {error}"))?;

    let app_name = app_handle.package_info().name.clone();
    let app_submenu = Submenu::new(app_handle, app_name, true)
        .map_err(|error| format!("menubar.updateMenubar failed to create app submenu: {error}"))?;
    app_submenu
        .append(
            &PredefinedMenuItem::about(app_handle, None, None).map_err(|error| {
                format!("menubar.updateMenubar failed to create About menu item: {error}")
            })?,
        )
        .map_err(|error| {
            format!("menubar.updateMenubar failed to append About menu item: {error}")
        })?;
    app_submenu
        .append(&PredefinedMenuItem::separator(app_handle).map_err(|error| {
            format!("menubar.updateMenubar failed to create separator: {error}")
        })?)
        .map_err(|error| format!("menubar.updateMenubar failed to append separator: {error}"))?;

    if let Some(preferences_menu) = menus.get("Preferences") {
        append_top_level_menu_entries(
            app_handle,
            &app_submenu,
            preferences_menu,
            keybindings,
            runtime_state,
        )?;
        app_submenu
            .append(&PredefinedMenuItem::separator(app_handle).map_err(|error| {
                format!("menubar.updateMenubar failed to create separator: {error}")
            })?)
            .map_err(|error| {
                format!("menubar.updateMenubar failed to append separator: {error}")
            })?;
    }

    app_submenu
        .append(
            &PredefinedMenuItem::services(app_handle, None).map_err(|error| {
                format!("menubar.updateMenubar failed to create Services menu item: {error}")
            })?,
        )
        .map_err(|error| {
            format!("menubar.updateMenubar failed to append Services menu item: {error}")
        })?;
    app_submenu
        .append(&PredefinedMenuItem::separator(app_handle).map_err(|error| {
            format!("menubar.updateMenubar failed to create separator: {error}")
        })?)
        .map_err(|error| format!("menubar.updateMenubar failed to append separator: {error}"))?;
    app_submenu
        .append(
            &PredefinedMenuItem::hide(app_handle, None).map_err(|error| {
                format!("menubar.updateMenubar failed to create Hide menu item: {error}")
            })?,
        )
        .map_err(|error| {
            format!("menubar.updateMenubar failed to append Hide menu item: {error}")
        })?;
    app_submenu
        .append(
            &PredefinedMenuItem::hide_others(app_handle, None).map_err(|error| {
                format!("menubar.updateMenubar failed to create Hide Others menu item: {error}")
            })?,
        )
        .map_err(|error| {
            format!("menubar.updateMenubar failed to append Hide Others menu item: {error}")
        })?;
    app_submenu
        .append(
            &PredefinedMenuItem::show_all(app_handle, None).map_err(|error| {
                format!("menubar.updateMenubar failed to create Show All menu item: {error}")
            })?,
        )
        .map_err(|error| {
            format!("menubar.updateMenubar failed to append Show All menu item: {error}")
        })?;
    app_submenu
        .append(&PredefinedMenuItem::separator(app_handle).map_err(|error| {
            format!("menubar.updateMenubar failed to create separator: {error}")
        })?)
        .map_err(|error| format!("menubar.updateMenubar failed to append separator: {error}"))?;
    app_submenu
        .append(
            &PredefinedMenuItem::quit(app_handle, None).map_err(|error| {
                format!("menubar.updateMenubar failed to create Quit menu item: {error}")
            })?,
        )
        .map_err(|error| {
            format!("menubar.updateMenubar failed to append Quit menu item: {error}")
        })?;

    menu.append(&app_submenu)
        .map_err(|error| format!("menubar.updateMenubar failed to append app submenu: {error}"))?;

    let mut consumed_top_level = std::collections::HashSet::new();
    consumed_top_level.insert("Preferences".to_string());

    for top_level in MENUBAR_TOP_LEVEL_ORDER {
        let Some(menu_value) = menus.get(top_level) else {
            continue;
        };
        append_named_top_level_menu(
            app_handle,
            &menu,
            top_level,
            menu_value,
            keybindings,
            runtime_state,
        )?;
        consumed_top_level.insert(top_level.to_string());
    }

    for (top_level, menu_value) in menus {
        if consumed_top_level.contains(top_level) {
            continue;
        }
        append_named_top_level_menu(
            app_handle,
            &menu,
            top_level,
            menu_value,
            keybindings,
            runtime_state,
        )?;
    }

    Ok(menu)
}

#[cfg(target_os = "macos")]
fn append_named_top_level_menu<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    menu: &Menu<R>,
    top_level_label: &str,
    menu_value: &Value,
    keybindings: Option<&serde_json::Map<String, Value>>,
    runtime_state: &mut MenubarRuntimeState,
) -> Result<(), String> {
    let submenu = Submenu::new(app_handle, strip_menu_mnemonics(top_level_label), true).map_err(
        |error| {
            format!(
                "menubar.updateMenubar failed to create top-level submenu '{top_level_label}': {error}"
            )
        },
    )?;

    append_top_level_menu_entries(app_handle, &submenu, menu_value, keybindings, runtime_state)?;

    if submenu
        .items()
        .map_err(|error| {
            format!(
                "menubar.updateMenubar failed to inspect top-level submenu '{top_level_label}': {error}"
            )
        })?
        .is_empty()
    {
        return Ok(());
    }

    menu.append(&submenu).map_err(|error| {
        format!(
            "menubar.updateMenubar failed to append top-level submenu '{top_level_label}': {error}"
        )
    })
}

#[cfg(target_os = "macos")]
fn append_top_level_menu_entries<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    submenu: &Submenu<R>,
    menu_value: &Value,
    keybindings: Option<&serde_json::Map<String, Value>>,
    runtime_state: &mut MenubarRuntimeState,
) -> Result<(), String> {
    let items = menu_value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "menubar.updateMenubar expected menu.items array".to_string())?;

    for item in items {
        let Some(item_object) = item.as_object() else {
            continue;
        };

        if item_object.get("id").and_then(Value::as_str) == Some("vscode.menubar.separator") {
            submenu
                .append(&PredefinedMenuItem::separator(app_handle).map_err(|error| {
                    format!("menubar.updateMenubar failed to create separator: {error}")
                })?)
                .map_err(|error| {
                    format!("menubar.updateMenubar failed to append separator: {error}")
                })?;
            continue;
        }

        if let Some(nested_menu) = item_object.get("submenu") {
            let label = item_object
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Submenu");
            let nested =
                Submenu::new(app_handle, strip_menu_mnemonics(label), true).map_err(|error| {
                    format!("menubar.updateMenubar failed to create nested submenu: {error}")
                })?;

            append_top_level_menu_entries(
                app_handle,
                &nested,
                nested_menu,
                keybindings,
                runtime_state,
            )?;

            if !nested
                .items()
                .map_err(|error| {
                    format!("menubar.updateMenubar failed to inspect nested submenu: {error}")
                })?
                .is_empty()
            {
                submenu.append(&nested).map_err(|error| {
                    format!("menubar.updateMenubar failed to append nested submenu: {error}")
                })?;
            }
            continue;
        }

        let command_id = match item_object.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };

        let enabled = item_object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let checked = item_object
            .get("checked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let base_label = item_object
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(command_id);
        let display_label = append_non_native_keybinding_label(
            strip_menu_mnemonics(base_label),
            command_id,
            keybindings,
        );
        let accelerator = resolve_native_keybinding(command_id, keybindings);

        let menu_item_id = next_menubar_item_id(runtime_state, command_id);

        if checked {
            let menu_item = CheckMenuItem::with_id(
                app_handle,
                menu_item_id.clone(),
                display_label,
                enabled,
                checked,
                accelerator.as_deref(),
            )
            .map_err(|error| {
                format!("menubar.updateMenubar failed to create check item: {error}")
            })?;
            submenu.append(&menu_item).map_err(|error| {
                format!("menubar.updateMenubar failed to append check item: {error}")
            })?;
        } else {
            let menu_item = MenuItem::with_id(
                app_handle,
                menu_item_id.clone(),
                display_label,
                enabled,
                accelerator.as_deref(),
            )
            .map_err(|error| {
                format!("menubar.updateMenubar failed to create menu item: {error}")
            })?;
            submenu.append(&menu_item).map_err(|error| {
                format!("menubar.updateMenubar failed to append menu item: {error}")
            })?;
        }

        runtime_state.action_by_menu_item_id.insert(
            menu_item_id,
            MenubarAction::RunAction {
                command_id: command_id.to_string(),
                args: vec![],
            },
        );
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn next_menubar_item_id(runtime_state: &mut MenubarRuntimeState, command_id: &str) -> String {
    runtime_state.next_generated_menu_item_id += 1;
    format!(
        "vscode-menubar::{command_id}::{}",
        runtime_state.next_generated_menu_item_id
    )
}

#[cfg(target_os = "macos")]
fn resolve_native_keybinding(
    command_id: &str,
    keybindings: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    let binding = keybindings
        .and_then(|bindings| bindings.get(command_id))
        .and_then(Value::as_object)?;
    let label = binding.get("label").and_then(Value::as_str)?;
    if label.trim().is_empty() {
        return None;
    }
    if binding.get("isNative").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    Some(label.to_string())
}

#[cfg(target_os = "macos")]
fn append_non_native_keybinding_label(
    label: String,
    command_id: &str,
    keybindings: Option<&serde_json::Map<String, Value>>,
) -> String {
    let binding = match keybindings
        .and_then(|bindings| bindings.get(command_id))
        .and_then(Value::as_object)
    {
        Some(binding) => binding,
        None => return label,
    };
    if binding.get("isNative").and_then(Value::as_bool) != Some(false) {
        return label;
    }
    let binding_label = match binding.get("label").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => value.trim(),
        _ => return label,
    };

    if label.contains('[') {
        label
    } else {
        format!("{label} [{binding_label}]")
    }
}

#[cfg(target_os = "macos")]
fn strip_menu_mnemonics(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }

        if matches!(chars.peek(), Some('&')) {
            out.push('&');
            chars.next();
        }
    }

    out
}

fn first_arg(args: &Value) -> Option<&Value> {
    args.as_array().and_then(|items| items.first())
}

fn nth_arg(args: &Value, index: usize) -> Option<&Value> {
    args.as_array().and_then(|items| items.get(index))
}

fn parse_u64_arg(value: Option<&Value>, message: &str) -> Result<u64, String> {
    let value = value.ok_or_else(|| message.to_string())?;
    value
        .as_u64()
        .or_else(|| {
            value.as_i64().and_then(|number| {
                if number >= 0 {
                    Some(number as u64)
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| message.to_string())
}

fn parse_usize_arg(value: Option<&Value>, message: &str) -> Result<usize, String> {
    let parsed = parse_u64_arg(value, message)?;
    usize::try_from(parsed).map_err(|_| message.to_string())
}

fn parse_watch_id_arg(value: Option<&Value>, message: &str) -> Result<String, String> {
    let value = value.ok_or_else(|| message.to_string())?;
    if let Some(text) = value.as_str() {
        return Ok(text.to_string());
    }
    if let Some(number) = value.as_u64() {
        return Ok(number.to_string());
    }
    if let Some(number) = value.as_i64() {
        return Ok(number.to_string());
    }

    Err(message.to_string())
}

fn local_filesystem_watch_id(session_id: &str, request_id: &str) -> String {
    format!("localfs:{session_id}:{request_id}")
}

fn extract_string_arg(value: Option<&Value>) -> Option<String> {
    let Some(value) = value else {
        return None;
    };

    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }

    value
        .get("path")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
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
        return Some(PathBuf::from(path));
    }

    None
}

fn normalize_file_uri_path(raw: &str) -> PathBuf {
    if let Some(stripped) = raw.strip_prefix("file://") {
        return PathBuf::from(stripped);
    }
    PathBuf::from(raw)
}

fn file_uri_value_from_path(path: &Path) -> Value {
    json!({
        "scheme": "file",
        "authority": "",
        "path": to_forward_slash_path(path)
    })
}

fn file_change_type_from_kind(kind: &str) -> u32 {
    match kind {
        "created" => 1,
        "deleted" => 2,
        _ => 0,
    }
}

fn to_forward_slash_path(path: &Path) -> String {
    let mut normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        normalized.push('/');
    }
    if !normalized.starts_with('/') {
        normalized.insert(0, '/');
    }
    normalized
}

fn to_epoch_millis(time: Option<std::time::SystemTime>) -> u64 {
    time.and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn file_type_from_metadata(metadata: &fs::Metadata) -> u32 {
    let file_type = metadata.file_type();
    let base = if file_type.is_dir() { 2 } else { 1 };
    if file_type.is_symlink() {
        base | 64
    } else {
        base
    }
}

fn value_to_u8(value: &Value) -> Option<u8> {
    if let Some(number) = value.as_u64() {
        return Some((number & 0xff) as u8);
    }
    if let Some(number) = value.as_i64() {
        return Some((number as i128 & 0xff) as u8);
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() {
            return Some((number as i128 & 0xff) as u8);
        }
    }
    if let Some(text) = value.as_str() {
        if let Ok(parsed) = text.parse::<i128>() {
            return Some((parsed & 0xff) as u8);
        }
    }
    None
}

fn decode_byte_array(value: &Value) -> Option<Vec<u8>> {
    match value {
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(value_to_u8(item)?);
            }
            Some(out)
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("Buffer") {
                if let Some(data) = object.get("data") {
                    return decode_byte_array(data);
                }
            }

            if let Some(data) = object.get("data") {
                if let Some(decoded) = decode_byte_array(data) {
                    return Some(decoded);
                }
            }

            if let Some(buffer) = object.get("buffer") {
                if let Some(mut decoded) = decode_byte_array(buffer) {
                    if let Some(byte_length) = object.get("byteLength").and_then(Value::as_u64) {
                        decoded.truncate(byte_length as usize);
                    }
                    return Some(decoded);
                }
            }

            let mut indexed = Vec::<(usize, u8)>::new();
            for (key, value) in object {
                if let Ok(index) = key.parse::<usize>() {
                    if let Some(byte) = value_to_u8(value) {
                        indexed.push((index, byte));
                    }
                }
            }

            if indexed.is_empty() {
                return None;
            }

            indexed.sort_by_key(|(index, _)| *index);
            let max_index = indexed.last().map(|(index, _)| *index).unwrap_or(0);
            let mut out = vec![0u8; max_index + 1];
            for (index, value) in indexed {
                out[index] = value;
            }
            Some(out)
        }
        _ => None,
    }
}

fn base64_encode_bytes(input: &[u8]) -> String {
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

fn checksum_file_sha256_base64(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| {
        format!(
            "checksum.checksum failed to open {}: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            format!(
                "checksum.checksum failed to read {}: {error}",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let digest = hasher.finalize();
    let mut encoded = base64_encode_bytes(&digest);
    while encoded.ends_with('=') {
        encoded.pop();
    }
    Ok(encoded)
}

fn remove_path_force(path: &Path, recursive: bool) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)
    } else if recursive {
        fs::remove_dir_all(path)
    } else {
        fs::remove_dir(path)
    }
}

fn copy_path_recursive(source: &Path, target: &Path, overwrite: bool) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;

    if target.exists() {
        if !overwrite {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("target {} already exists", target.display()),
            ));
        }
        remove_path_force(target, true)?;
    }

    if metadata.is_dir() {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let from = entry.path();
            let to = target.join(entry.file_name());
            copy_path_recursive(&from, &to, false)?;
        }
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    fs::copy(source, target)?;
    Ok(())
}

fn stable_short_hex_id(input: &str) -> String {
    let mut hash: i32 = 0;
    hash = (((hash << 5) - hash) + 149_417) | 0;
    for byte in input.bytes() {
        hash = (((hash << 5) - hash) + i32::from(byte)) | 0;
    }
    format!("{:08x}", hash as u32)
}

fn fallback_workspace_identifier(seed: &str) -> Value {
    json!({
        "id": format!("{seed}-id"),
        "configPath": format!("{seed}.code-workspace")
    })
}

fn fallback_user_data_profile(id: &str, name: &str) -> Value {
    let base = "/tmp/vscode-tauri/profiles";
    json!({
        "id": id,
        "isDefault": id == "default",
        "name": name,
        "location": { "scheme": "file", "authority": "", "path": format!("{base}/{id}") },
        "globalStorageHome": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/globalStorage") },
        "settingsResource": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/settings.json") },
        "keybindingsResource": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/keybindings.json") },
        "tasksResource": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/tasks.json") },
        "snippetsHome": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/snippets") },
        "promptsHome": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/prompts") },
        "extensionsResource": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/extensions.json") },
        "mcpResource": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/mcp.json") },
        "cacheHome": { "scheme": "file", "authority": "", "path": format!("{base}/{id}/cache") }
    })
}

fn extract_url_from_any(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }

    let scheme = value.get("scheme").and_then(Value::as_str)?;
    let authority = value
        .get("authority")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path = value.get("path").and_then(Value::as_str).unwrap_or("/");
    let query = value
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fragment = value
        .get("fragment")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let mut url = format!("{scheme}://{authority}{path}");
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    if !fragment.is_empty() {
        url.push('#');
        url.push_str(fragment);
    }
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn checksum_sha256_base64_matches_expected() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vscode-tauri-checksum-{nonce}.txt"));
        fs::write(&path, b"hello world").expect("write test file");

        let checksum = checksum_file_sha256_base64(&path).expect("checksum should succeed");
        fs::remove_file(&path).expect("cleanup checksum file");

        assert_eq!(checksum, "uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek");
    }

    #[test]
    fn file_change_type_mapping_is_stable() {
        assert_eq!(file_change_type_from_kind("changed"), 0);
        assert_eq!(file_change_type_from_kind("created"), 1);
        assert_eq!(file_change_type_from_kind("deleted"), 2);
        assert_eq!(file_change_type_from_kind("anything-else"), 0);
    }
}
