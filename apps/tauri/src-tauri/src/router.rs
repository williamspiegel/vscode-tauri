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
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;

#[derive(Clone)]
pub struct CapabilityRouter {
    repo_root: Arc<PathBuf>,
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
    storage_state: Arc<Mutex<StorageRuntimeState>>,
    workspaces_state: Arc<Mutex<WorkspacesRuntimeState>>,
    user_data_profiles_state: Arc<Mutex<UserDataProfilesRuntimeState>>,
    local_pty_state: Arc<Mutex<LocalPtyRuntimeState>>,
    next_extension_host_id: Arc<AtomicU64>,
    fallback_telemetry: Arc<Mutex<FallbackTelemetryState>>,
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

#[derive(Default)]
struct StorageRuntimeState {
    scopes: HashMap<String, BTreeMap<String, String>>,
}

#[derive(Default)]
struct WorkspacesRuntimeState {
    recent_workspaces: Vec<Value>,
    recent_files: Vec<Value>,
    next_untitled_id: u64,
}

#[derive(Default)]
struct UserDataProfilesRuntimeState {
    profiles: BTreeMap<String, Value>,
    workspace_profiles: BTreeMap<String, String>,
    next_profile_id: u64,
    next_transient_id: u64,
}

#[derive(Default)]
struct LocalPtyRuntimeState {
    layout_by_workspace: HashMap<String, Value>,
}

struct FallbackTelemetryState {
    counts: BTreeMap<String, u64>,
    metrics_path: PathBuf,
    events_path: PathBuf,
}

#[derive(Clone)]
enum MenubarAction {
    RunAction {
        command_id: String,
        args: Vec<Value>,
    },
}

impl CapabilityRouter {
    pub fn new(repo_root: PathBuf) -> Self {
        let user_data_dir = repo_root.join(".vscode-tauri").join("user-data");
        let _ = fs::create_dir_all(user_data_dir.join("User/profiles/default"));
        let _ = fs::create_dir_all(user_data_dir.join("CachedProfilesData/default"));

        let mut workspaces_state = WorkspacesRuntimeState::default();
        workspaces_state.next_untitled_id = 1;

        let mut user_data_profiles_state = UserDataProfilesRuntimeState::default();
        user_data_profiles_state.profiles.insert(
            "default".to_string(),
            profile_descriptor(&user_data_dir, "default", "Default", true, false),
        );
        user_data_profiles_state.next_profile_id = 1;
        user_data_profiles_state.next_transient_id = 1;

        let metrics_path = repo_root.join("apps/tauri/logs/fallback-metrics.json");
        let events_path = repo_root.join("apps/tauri/logs/fallback-metrics.events.jsonl");
        let fallback_counts = read_fallback_counts(&metrics_path).unwrap_or_default();

        Self {
            repo_root: Arc::new(repo_root),
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
            storage_state: Arc::new(Mutex::new(StorageRuntimeState::default())),
            workspaces_state: Arc::new(Mutex::new(workspaces_state)),
            user_data_profiles_state: Arc::new(Mutex::new(user_data_profiles_state)),
            local_pty_state: Arc::new(Mutex::new(LocalPtyRuntimeState::default())),
            next_extension_host_id: Arc::new(AtomicU64::new(1)),
            fallback_telemetry: Arc::new(Mutex::new(FallbackTelemetryState {
                counts: fallback_counts,
                metrics_path,
                events_path,
            })),
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

        let domain_name = capability_domain_name(domain);
        let method_name = method
            .split_once('.')
            .map(|(_, value)| value)
            .unwrap_or(method);
        self.record_fallback("capability", domain_name, method_name);

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
            self.record_fallback("channel", channel, method);
            return Ok(result);
        }

        if let Some(result) = self.dispatch_channel_rust_default(channel, method, args) {
            self.record_fallback("channel", channel, method);
            return Ok(result);
        }

        self.record_fallback("channel", channel, method);
        Ok(default_by_method_name(method))
    }

    fn record_fallback(&self, class: &str, domain: &str, method: &str) {
        let key = format!("{class}:{domain}:{method}");
        let at_ms = epoch_millis();
        let mut state = match self.fallback_telemetry.lock() {
            Ok(state) => state,
            Err(_) => return,
        };

        let count = state.counts.entry(key.clone()).or_insert(0);
        *count += 1;
        let next_count = *count;

        if let Err(error) = persist_fallback_metrics(&state.metrics_path, at_ms, &state.counts) {
            eprintln!(
                "[fallback.telemetry.error] failed to persist {}: {error}",
                state.metrics_path.display()
            );
        }
        if let Err(error) = append_fallback_event(
            &state.events_path,
            at_ms,
            &key,
            class,
            domain,
            method,
            next_count,
        ) {
            eprintln!(
                "[fallback.telemetry.error] failed to append {}: {error}",
                state.events_path.display()
            );
        }
        drop(state);

        if !should_emit_fallback_event(next_count) {
            return;
        }

        if let Some(app_handle) = crate::capabilities::window::app_handle() {
            let _ = app_handle.emit(
                "fallback_used",
                json!({
                    "domain": domain,
                    "method": method,
                    "count": next_count,
                    "class": class,
                    "key": key
                }),
            );
        }
    }

    fn user_data_dir(&self) -> PathBuf {
        self.repo_root.join(".vscode-tauri").join("user-data")
    }

    fn user_extensions_dir(&self) -> PathBuf {
        self.user_data_dir().join("extensions")
    }

    fn builtin_extensions_dir(&self) -> PathBuf {
        self.repo_root.join("extensions")
    }

    fn extensions_cache_dir(&self) -> PathBuf {
        self.user_data_dir().join("CachedExtensionVSIXs")
    }

    fn default_extensions_profile_location(&self) -> Value {
        file_uri_value_from_path(
            &self
                .user_data_dir()
                .join("User")
                .join("profiles")
                .join("default")
                .join("extensions.json"),
        )
    }

    fn extensions_profile_location_from_arg(
        &self,
        options: Option<&Value>,
        fallback: Option<&Value>,
    ) -> Value {
        if let Some(path) = options
            .and_then(Value::as_object)
            .and_then(|value| value.get("profileLocation"))
            .and_then(extract_fs_path)
        {
            return file_uri_value_from_path(&path);
        }
        if let Some(path) = fallback.and_then(extract_fs_path) {
            return file_uri_value_from_path(&path);
        }
        self.default_extensions_profile_location()
    }

    async fn handle_extensions_channel(&self, method: &str, args: &Value) -> Result<Value, String> {
        let user_extensions_dir = self.user_extensions_dir();
        let builtin_extensions_dir = self.builtin_extensions_dir();
        fs::create_dir_all(&user_extensions_dir).map_err(|error| {
            format!(
                "extensions failed to create user extensions dir {}: {error}",
                user_extensions_dir.display()
            )
        })?;

        match method {
            "getInstalled" => {
                let extension_type = nth_arg(args, 0).and_then(Value::as_u64);
                let extensions = collect_installed_extensions(
                    &builtin_extensions_dir,
                    &user_extensions_dir,
                    extension_type,
                )?;
                Ok(Value::Array(extensions))
            }
            "getManifest" => {
                let archive = nth_arg(args, 0).and_then(extract_fs_path).ok_or_else(|| {
                    "extensions.getManifest expected archive URI/path".to_string()
                })?;
                read_manifest_from_archive(&archive)
            }
            "zip" => {
                let extension_location = nth_arg(args, 0)
                    .and_then(|value| value.get("location"))
                    .and_then(extract_fs_path)
                    .ok_or_else(|| "extensions.zip expected extension.location".to_string())?;
                let zip_path = zip_extension_directory(
                    &extension_location,
                    &self.extensions_cache_dir(),
                    "extension",
                )?;
                Ok(file_uri_value_from_path(&zip_path))
            }
            "install" => {
                let archive = nth_arg(args, 0)
                    .and_then(extract_fs_path)
                    .ok_or_else(|| "extensions.install expected archive URI/path".to_string())?;
                let metadata = json!({
                    "source": "vsix",
                    "installedTimestamp": epoch_millis(),
                    "targetPlatform": current_target_platform()
                });
                install_from_archive(
                    &archive,
                    &user_extensions_dir,
                    &self.extensions_cache_dir(),
                    &metadata,
                )
            }
            "installFromLocation" => {
                let location = nth_arg(args, 0).and_then(extract_fs_path).ok_or_else(|| {
                    "extensions.installFromLocation expected location URI/path".to_string()
                })?;
                let metadata = json!({
                    "source": "resource",
                    "installedTimestamp": epoch_millis(),
                    "targetPlatform": current_target_platform()
                });
                if location.is_file() {
                    install_from_archive(
                        &location,
                        &user_extensions_dir,
                        &self.extensions_cache_dir(),
                        &metadata,
                    )
                } else {
                    install_from_directory(&location, &user_extensions_dir, &metadata)
                }
            }
            "installFromGallery" => {
                let gallery = nth_arg(args, 0).ok_or_else(|| {
                    "extensions.installFromGallery expected extension payload".to_string()
                })?;
                let download_url = gallery_download_url(gallery).ok_or_else(|| {
                    "extensions.installFromGallery missing download url in extension assets"
                        .to_string()
                })?;
                let identifier = gallery
                    .get("identifier")
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("gallery-extension");
                let archive_path = self.extensions_cache_dir().join(format!(
                    "{}-{}-{}.vsix",
                    sanitize_extension_segment(identifier),
                    epoch_millis(),
                    stable_short_hex_id(identifier)
                ));
                download_to_file(&download_url, &archive_path).await?;
                let metadata = gallery_extension_metadata(gallery);
                install_from_archive(
                    &archive_path,
                    &user_extensions_dir,
                    &self.extensions_cache_dir(),
                    &metadata,
                )
            }
            "installGalleryExtensions" => {
                let mut results = Vec::new();
                let Some(installs) = nth_arg(args, 0).and_then(Value::as_array) else {
                    return Ok(Value::Array(results));
                };
                for install in installs {
                    let extension = install.get("extension").ok_or_else(|| {
                        "extensions.installGalleryExtensions expected extension payload".to_string()
                    })?;
                    let download_url = gallery_download_url(extension).ok_or_else(|| {
                        "extensions.installGalleryExtensions missing download url".to_string()
                    })?;
                    let identifier = extension
                        .get("identifier")
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("gallery-extension");
                    let archive_path = self.extensions_cache_dir().join(format!(
                        "{}-{}-{}.vsix",
                        sanitize_extension_segment(identifier),
                        epoch_millis(),
                        stable_short_hex_id(identifier)
                    ));
                    download_to_file(&download_url, &archive_path).await?;
                    let local = install_from_archive(
                        &archive_path,
                        &user_extensions_dir,
                        &self.extensions_cache_dir(),
                        &gallery_extension_metadata(extension),
                    )?;
                    let local_identifier = local
                        .get("identifier")
                        .cloned()
                        .unwrap_or_else(|| json!({ "id": identifier }));
                    let profile_location =
                        self.extensions_profile_location_from_arg(install.get("options"), None);
                    results.push(json!({
                        "identifier": local_identifier,
                        "operation": 2,
                        "source": extension.clone(),
                        "local": local,
                        "profileLocation": profile_location
                    }));
                }
                Ok(Value::Array(results))
            }
            "installExtensionsFromProfile" => {
                let requested = nth_arg(args, 0)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let installed = collect_installed_extensions(
                    &builtin_extensions_dir,
                    &user_extensions_dir,
                    Some(1),
                )?;
                let mut requested_ids = requested
                    .iter()
                    .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                    .map(|value| value.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                requested_ids.sort();
                requested_ids.dedup();
                let mut result = Vec::new();
                for local in installed {
                    let Some(id) = local
                        .get("identifier")
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("id"))
                        .and_then(Value::as_str)
                    else {
                        continue;
                    };
                    if requested_ids
                        .binary_search(&id.to_ascii_lowercase())
                        .is_ok()
                    {
                        result.push(local);
                    }
                }
                Ok(Value::Array(result))
            }
            "download" => {
                let extension = nth_arg(args, 0)
                    .ok_or_else(|| "extensions.download expected extension payload".to_string())?;
                let download_url = gallery_download_url(extension)
                    .ok_or_else(|| "extensions.download missing download url".to_string())?;
                let identifier = extension
                    .get("identifier")
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("gallery-extension");
                let archive_path = self.extensions_cache_dir().join(format!(
                    "{}-{}-download.vsix",
                    sanitize_extension_segment(identifier),
                    stable_short_hex_id(identifier)
                ));
                download_to_file(&download_url, &archive_path).await?;
                Ok(file_uri_value_from_path(&archive_path))
            }
            "uninstall" => {
                let extension = nth_arg(args, 0).ok_or_else(|| {
                    "extensions.uninstall expected local extension payload".to_string()
                })?;
                uninstall_local_extension(extension, &user_extensions_dir)?;
                Ok(Value::Null)
            }
            "uninstallExtensions" => {
                if let Some(items) = nth_arg(args, 0).and_then(Value::as_array) {
                    for entry in items {
                        if let Some(extension) = entry.get("extension") {
                            uninstall_local_extension(extension, &user_extensions_dir)?;
                        }
                    }
                }
                Ok(Value::Null)
            }
            "toggleApplicationScope" => {
                let extension = nth_arg(args, 0).ok_or_else(|| {
                    "extensions.toggleApplicationScope expected local extension payload".to_string()
                })?;
                let updated = update_local_extension_metadata(
                    extension,
                    &json!({ "isApplicationScoped": !extension.get("isApplicationScoped").and_then(Value::as_bool).unwrap_or(false) }),
                )?;
                Ok(updated)
            }
            "updateMetadata" => {
                let extension = nth_arg(args, 0).ok_or_else(|| {
                    "extensions.updateMetadata expected local extension payload".to_string()
                })?;
                let metadata = nth_arg(args, 1).cloned().unwrap_or_else(|| json!({}));
                update_local_extension_metadata(extension, &metadata)
            }
            "resetPinnedStateForAllUserExtensions" => {
                let pinned = nth_arg(args, 0).and_then(Value::as_bool).unwrap_or(false);
                for extension in collect_installed_extensions(
                    &builtin_extensions_dir,
                    &user_extensions_dir,
                    Some(1),
                )? {
                    let _ =
                        update_local_extension_metadata(&extension, &json!({ "pinned": pinned }));
                }
                Ok(Value::Null)
            }
            "copyExtensions" => Ok(Value::Null),
            "cleanUp" => {
                let cache_dir = self.extensions_cache_dir();
                let _ = fs::remove_dir_all(&cache_dir);
                let _ = fs::create_dir_all(&cache_dir);
                Ok(Value::Null)
            }
            "getTargetPlatform" => Ok(json!(current_target_platform())),
            "getExtensionsControlManifest" => {
                load_extensions_control_manifest(&self.repo_root).await
            }
            _ => Ok(default_by_method_name(method)),
        }
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
                "getItems" => {
                    let scope_key = storage_scope_key(arg0);
                    let items = {
                        let state = self
                            .storage_state
                            .lock()
                            .map_err(|_| "storage state lock poisoned".to_string())?;
                        state.scopes.get(&scope_key).cloned().unwrap_or_default()
                    };
                    let mut serialized = Vec::with_capacity(items.len());
                    for (key, value) in items {
                        serialized.push(json!([key, value]));
                    }
                    Ok(Some(Value::Array(serialized)))
                }
                "isUsed" => {
                    let target = arg0
                        .and_then(|value| value.get("payload"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if target.is_empty() {
                        return Ok(Some(json!(false)));
                    }
                    let is_used = self
                        .storage_state
                        .lock()
                        .map_err(|_| "storage state lock poisoned".to_string())?
                        .scopes
                        .values()
                        .any(|scope| scope.contains_key(target));
                    Ok(Some(json!(is_used)))
                }
                "updateItems" => {
                    let scope_key = storage_scope_key(arg0);
                    let request = arg0.and_then(Value::as_object);
                    let mut state = self
                        .storage_state
                        .lock()
                        .map_err(|_| "storage state lock poisoned".to_string())?;
                    let scope = state.scopes.entry(scope_key).or_insert_with(BTreeMap::new);

                    if let Some(insert) = request
                        .and_then(|value| value.get("insert"))
                        .and_then(Value::as_array)
                    {
                        for item in insert {
                            let Some(tuple) = item.as_array() else {
                                continue;
                            };
                            if tuple.len() < 2 {
                                continue;
                            }
                            let Some(key) = tuple[0].as_str() else {
                                continue;
                            };
                            let Some(value) = tuple[1].as_str() else {
                                continue;
                            };
                            scope.insert(key.to_string(), value.to_string());
                        }
                    }

                    if let Some(delete) = request
                        .and_then(|value| value.get("delete"))
                        .and_then(Value::as_array)
                    {
                        for key in delete {
                            let Some(key) = key.as_str() else {
                                continue;
                            };
                            scope.remove(key);
                        }
                    }

                    Ok(Some(Value::Null))
                }
                "optimize" => Ok(Some(Value::Null)),
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
                    let workspace = nth_arg(args, 2);
                    let is_transient = nth_arg(args, 1)
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("transient"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let user_data_dir = self.user_data_dir();
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                    let profile_id = format!("profile-{}", state.next_profile_id);
                    state.next_profile_id += 1;
                    let profile =
                        profile_descriptor(&user_data_dir, &profile_id, &name, false, is_transient);
                    state.profiles.insert(profile_id.clone(), profile.clone());
                    if let Some(workspace_identifier) = workspace_identifier_key(workspace) {
                        state
                            .workspace_profiles
                            .insert(workspace_identifier, profile_id);
                    }
                    Ok(Some(profile))
                }
                "createProfile" => {
                    let requested_id = extract_string_arg(nth_arg(args, 0))
                        .unwrap_or_else(|| "profile".to_string());
                    let name = extract_string_arg(nth_arg(args, 1))
                        .unwrap_or_else(|| "Profile".to_string());
                    let workspace = nth_arg(args, 3);
                    let is_transient = nth_arg(args, 2)
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("transient"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let user_data_dir = self.user_data_dir();
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                    let profile_id = unique_profile_id(&state.profiles, requested_id);
                    let profile =
                        profile_descriptor(&user_data_dir, &profile_id, &name, false, is_transient);
                    state.profiles.insert(profile_id.clone(), profile.clone());
                    if let Some(workspace_identifier) = workspace_identifier_key(workspace) {
                        state
                            .workspace_profiles
                            .insert(workspace_identifier, profile_id);
                    }
                    Ok(Some(profile))
                }
                "createTransientProfile" => {
                    let workspace = nth_arg(args, 0);
                    let user_data_dir = self.user_data_dir();
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                    let profile_id = format!("transient-{}", state.next_transient_id);
                    state.next_transient_id += 1;
                    let profile =
                        profile_descriptor(&user_data_dir, &profile_id, "Transient", false, true);
                    state.profiles.insert(profile_id.clone(), profile.clone());
                    if let Some(workspace_identifier) = workspace_identifier_key(workspace) {
                        state
                            .workspace_profiles
                            .insert(workspace_identifier, profile_id);
                    }
                    Ok(Some(profile))
                }
                "updateProfile" => {
                    let input_profile = nth_arg(args, 0).and_then(Value::as_object);
                    let update_options = nth_arg(args, 1).and_then(Value::as_object);
                    let user_data_dir = self.user_data_dir();
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;

                    let requested_id = input_profile
                        .and_then(|profile| profile.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("profile");
                    let profile_id = if state.profiles.contains_key(requested_id) {
                        requested_id.to_string()
                    } else {
                        unique_profile_id(&state.profiles, requested_id.to_string())
                    };

                    let current = state.profiles.get(&profile_id).cloned().unwrap_or_else(|| {
                        profile_descriptor(&user_data_dir, &profile_id, "Profile", false, false)
                    });
                    let mut next = current.clone();
                    if let Some(name) = update_options
                        .and_then(|options| options.get("name"))
                        .and_then(Value::as_str)
                    {
                        next["name"] = json!(name);
                    }
                    if let Some(short_name) = update_options
                        .and_then(|options| options.get("shortName"))
                        .and_then(Value::as_str)
                    {
                        next["shortName"] = json!(short_name);
                    }
                    state.profiles.insert(profile_id, next.clone());
                    Ok(Some(next))
                }
                "removeProfile" => {
                    let profile_id = nth_arg(args, 0)
                        .and_then(profile_id_from_value)
                        .unwrap_or_default();
                    if profile_id.is_empty() || profile_id == "default" {
                        return Ok(Some(Value::Null));
                    }
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                    state.profiles.remove(&profile_id);
                    state
                        .workspace_profiles
                        .retain(|_, mapped_id| mapped_id != &profile_id);
                    Ok(Some(Value::Null))
                }
                "setProfileForWorkspace" => {
                    let workspace = nth_arg(args, 0);
                    let profile_id = nth_arg(args, 1).and_then(profile_id_from_value);
                    if let (Some(workspace_identifier), Some(profile_id)) =
                        (workspace_identifier_key(workspace), profile_id)
                    {
                        let mut state = self
                            .user_data_profiles_state
                            .lock()
                            .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                        if state.profiles.contains_key(&profile_id) {
                            state
                                .workspace_profiles
                                .insert(workspace_identifier, profile_id);
                        }
                    }
                    Ok(Some(Value::Null))
                }
                "resetWorkspaces" => {
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                    state.workspace_profiles.clear();
                    Ok(Some(Value::Null))
                }
                "cleanUp" => {
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                    let existing_ids = state.profiles.keys().cloned().collect::<Vec<_>>();
                    state
                        .workspace_profiles
                        .retain(|_, profile_id| existing_ids.iter().any(|id| id == profile_id));
                    Ok(Some(Value::Null))
                }
                "cleanUpTransientProfiles" => {
                    let mut state = self
                        .user_data_profiles_state
                        .lock()
                        .map_err(|_| "userDataProfiles state lock poisoned".to_string())?;
                    let transient_ids = state
                        .profiles
                        .iter()
                        .filter_map(|(profile_id, profile)| {
                            let transient = profile
                                .get("isTransient")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            if transient {
                                Some(profile_id.clone())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>();
                    for transient_id in transient_ids {
                        state.profiles.remove(&transient_id);
                        state
                            .workspace_profiles
                            .retain(|_, profile_id| profile_id != &transient_id);
                    }
                    Ok(Some(Value::Null))
                }
                _ => Ok(None),
            },
            "workspaces" => match method {
                "getRecentlyOpened" => {
                    let state = self
                        .workspaces_state
                        .lock()
                        .map_err(|_| "workspaces state lock poisoned".to_string())?;
                    Ok(Some(json!({
                        "workspaces": state.recent_workspaces,
                        "files": state.recent_files
                    })))
                }
                "getDirtyWorkspaces" => Ok(Some(json!([]))),
                "getWorkspaceIdentifier" => {
                    let input = nth_arg(args, 0).unwrap_or(&Value::Null);
                    Ok(Some(workspace_identifier_from_value(input)))
                }
                "createUntitledWorkspace" => {
                    let mut state = self
                        .workspaces_state
                        .lock()
                        .map_err(|_| "workspaces state lock poisoned".to_string())?;
                    let untitled_id = state.next_untitled_id;
                    state.next_untitled_id += 1;
                    drop(state);

                    let config_path = self
                        .user_data_dir()
                        .join("Workspaces")
                        .join(format!("Untitled-{untitled_id}.code-workspace"));
                    if let Some(parent) = config_path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if !config_path.exists() {
                        let _ = fs::write(&config_path, "{\n  \"folders\": []\n}\n");
                    }

                    Ok(Some(workspace_identifier_for_path(&config_path)))
                }
                "enterWorkspace" => {
                    let input = nth_arg(args, 0).unwrap_or(&Value::Null);
                    Ok(Some(json!({
                        "workspace": workspace_identifier_from_value(input)
                    })))
                }
                "addRecentlyOpened"
                | "removeRecentlyOpened"
                | "clearRecentlyOpened"
                | "deleteUntitledWorkspace" => {
                    let mut state = self
                        .workspaces_state
                        .lock()
                        .map_err(|_| "workspaces state lock poisoned".to_string())?;
                    match method {
                        "addRecentlyOpened" => {
                            if let Some(recents) = nth_arg(args, 0).and_then(Value::as_array) {
                                for recent in recents {
                                    let object = match recent.as_object() {
                                        Some(value) => value.clone(),
                                        None => continue,
                                    };
                                    if object.contains_key("workspace")
                                        || object.contains_key("folderUri")
                                    {
                                        state.recent_workspaces.push(Value::Object(object));
                                    } else if object.contains_key("fileUri") {
                                        state.recent_files.push(Value::Object(object));
                                    }
                                }
                            }
                        }
                        "removeRecentlyOpened" => {
                            if let Some(paths) = nth_arg(args, 0).and_then(Value::as_array) {
                                state.recent_workspaces.retain(|recent| {
                                    !paths
                                        .iter()
                                        .any(|path| recent_entry_matches_path(recent, path))
                                });
                                state.recent_files.retain(|recent| {
                                    !paths
                                        .iter()
                                        .any(|path| recent_entry_matches_path(recent, path))
                                });
                            }
                        }
                        "clearRecentlyOpened" => {
                            state.recent_workspaces.clear();
                            state.recent_files.clear();
                        }
                        "deleteUntitledWorkspace" => {
                            if let Some(path) = nth_arg(args, 0).and_then(extract_fs_path) {
                                let _ = fs::remove_file(path);
                            }
                        }
                        _ => {}
                    }
                    Ok(Some(Value::Null))
                }
                _ => Ok(None),
            },
            "keyboardLayout" => match method {
                "getKeyboardLayoutData" => Ok(Some(json!({
                    "keyboardLayoutInfo": {
                        "id": keyboard_layout_id(),
                        "lang": "en",
                        "layout": "US"
                    },
                    "keyboardMapping": {}
                }))),
                _ => Ok(None),
            },
            "extensionHostStarter" => match method {
                "createExtensionHost" => {
                    let extension_host_id =
                        self.next_extension_host_id.fetch_add(1, Ordering::Relaxed);
                    Ok(Some(
                        json!({ "id": format!("tauri-extension-host-{extension_host_id}") }),
                    ))
                }
                "start" => Ok(Some(json!({ "pid": -1 }))),
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
                "getPerformanceMarks" | "getLatency" => Ok(Some(json!([]))),
                "getProfiles" => {
                    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
                    let profile_name = shell
                        .rsplit('/')
                        .next()
                        .filter(|value| !value.is_empty())
                        .unwrap_or("shell")
                        .to_string();
                    Ok(Some(json!([{
                        "profileName": profile_name,
                        "path": shell,
                        "isDefault": true,
                        "isAutoDetected": true
                    }])))
                }
                "getDefaultSystemShell" => Ok(Some(json!(
                    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
                ))),
                "getEnvironment" | "getShellEnvironment" => {
                    Ok(Some(json!(
                        std::env::vars().collect::<BTreeMap<String, String>>()
                    )))
                }
                "getTerminalLayoutInfo" => {
                    let workspace_id = nth_arg(args, 0)
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("workspaceId"))
                        .and_then(Value::as_str)
                        .unwrap_or("default");
                    let state = self
                        .local_pty_state
                        .lock()
                        .map_err(|_| "localPty state lock poisoned".to_string())?;
                    Ok(Some(
                        state
                            .layout_by_workspace
                            .get(workspace_id)
                            .cloned()
                            .unwrap_or(Value::Null),
                    ))
                }
                "requestDetachInstance" => Ok(Some(Value::Null)),
                "setTerminalLayoutInfo"
                | "reduceConnectionGraceTime"
                | "persistTerminalState"
                | "acceptDetachInstanceReply" => {
                    if method == "setTerminalLayoutInfo" {
                        if let Some(layout) = nth_arg(args, 0).and_then(Value::as_object) {
                            let workspace_id = layout
                                .get("workspaceId")
                                .and_then(Value::as_str)
                                .unwrap_or("default")
                                .to_string();
                            let mut state = self
                                .local_pty_state
                                .lock()
                                .map_err(|_| "localPty state lock poisoned".to_string())?;
                            state
                                .layout_by_workspace
                                .insert(workspace_id, Value::Object(layout.clone()));
                        }
                    }
                    Ok(Some(Value::Null))
                }
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

                    Ok(Some(file_uri_value_from_path(&resolved)))
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
                "getWindows" => Ok(Some(json!([{
                    "id": 1,
                    "workspace": Value::Null,
                    "title": "Code - Tauri",
                    "filename": Value::Null,
                    "folderUri": Value::Null
                }]))),
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
            "webview" => match method {
                "setIgnoreMenuShortcuts" | "findInFrame" | "stopFindInFrame" => {
                    Ok(Some(Value::Null))
                }
                _ => Ok(None),
            },
            "extensionTipsService" => match method {
                "getConfigBasedTips"
                | "getImportantExecutableBasedTips"
                | "getOtherExecutableBasedTips" => Ok(Some(json!([]))),
                _ => Ok(None),
            },
            "extensions" => self.handle_extensions_channel(method, args).await.map(Some),
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

    pub fn fallback_counts(&self) -> BTreeMap<String, u64> {
        self.fallback_telemetry
            .lock()
            .map(|state| state.counts.clone())
            .unwrap_or_default()
    }

    fn dispatch_channel_rust_default(
        &self,
        channel: &str,
        method: &str,
        _args: &Value,
    ) -> Option<Value> {
        match channel {
            "extensions" => match method {
                "getInstalled" => Some(json!([])),
                "getExtensionsControlManifest" => Some(json!({
                    "malicious": [],
                    "deprecated": {},
                    "search": [],
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
                    let sync_store = file_uri_value_from_path(&self.user_data_dir().join("sync"));
                    Some(json!({
                        "url": sync_store,
                        "type": "stable",
                        "defaultUrl": sync_store,
                        "insidersUrl": sync_store,
                        "stableUrl": sync_store,
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

fn should_emit_fallback_event(count: u64) -> bool {
    if count <= 3 {
        return true;
    }
    matches!(count, 5 | 10 | 25 | 50 | 100) || count % 500 == 0
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
        "$mid": 1,
        "scheme": "file",
        "authority": "",
        "path": to_forward_slash_path(path),
        "query": "",
        "fragment": ""
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

fn current_target_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "arm") => "linux-armhf",
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        _ => "unknown",
    }
}

fn sanitize_extension_segment(input: &str) -> String {
    let mut sanitized = input
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while sanitized.contains("--") {
        sanitized = sanitized.replace("--", "-");
    }
    sanitized.trim_matches('-').to_string()
}

fn extension_directory_size(path: &Path) -> u64 {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    if metadata.is_file() {
        return metadata.len();
    }
    let mut total = 0u64;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        total = total.saturating_add(extension_directory_size(&entry.path()));
    }
    total
}

fn merge_json_objects(
    target: &mut serde_json::Map<String, Value>,
    patch: &serde_json::Map<String, Value>,
) {
    for (key, value) in patch {
        target.insert(key.clone(), value.clone());
    }
}

fn ensure_extension_root(path: &Path) -> Option<PathBuf> {
    if path.join("package.json").is_file() {
        return Some(path.to_path_buf());
    }
    let extension_subdir = path.join("extension");
    if extension_subdir.join("package.json").is_file() {
        return Some(extension_subdir);
    }

    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        if entry.path().join("package.json").is_file() {
            return Some(entry.path());
        }
        let nested_extension = entry.path().join("extension");
        if nested_extension.join("package.json").is_file() {
            return Some(nested_extension);
        }
    }
    None
}

fn load_manifest_and_metadata(extension_root: &Path) -> Result<(Value, Value), String> {
    let package_json = extension_root.join("package.json");
    let bytes = fs::read(&package_json).map_err(|error| {
        format!(
            "extensions failed to read {}: {error}",
            package_json.display()
        )
    })?;
    let mut manifest: Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "extensions failed to parse manifest {}: {error}",
            package_json.display()
        )
    })?;
    let object = manifest.as_object_mut().ok_or_else(|| {
        format!(
            "extensions invalid manifest object {}",
            package_json.display()
        )
    })?;
    let mut metadata = object
        .remove("__metadata")
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    if !metadata.is_object() {
        metadata = Value::Object(serde_json::Map::new());
    }
    if object
        .get("publisher")
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        object.insert(
            "publisher".to_string(),
            Value::String("undefined_publisher".to_string()),
        );
    }
    if object.get("name").and_then(Value::as_str).is_none() {
        return Err(format!(
            "extensions manifest missing 'name' in {}",
            package_json.display()
        ));
    }
    if object.get("version").and_then(Value::as_str).is_none() {
        return Err(format!(
            "extensions manifest missing 'version' in {}",
            package_json.display()
        ));
    }
    Ok((Value::Object(object.clone()), metadata))
}

fn write_manifest_metadata(extension_root: &Path, metadata_patch: &Value) -> Result<(), String> {
    let package_json = extension_root.join("package.json");
    let bytes = fs::read(&package_json).map_err(|error| {
        format!(
            "extensions failed to read {}: {error}",
            package_json.display()
        )
    })?;
    let mut manifest: Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "extensions failed to parse {}: {error}",
            package_json.display()
        )
    })?;
    let object = manifest.as_object_mut().ok_or_else(|| {
        format!(
            "extensions invalid manifest object {}",
            package_json.display()
        )
    })?;
    let metadata = object
        .entry("__metadata".to_string())
        .or_insert_with(|| json!({}));
    if !metadata.is_object() {
        *metadata = json!({});
    }
    let metadata_object = metadata
        .as_object_mut()
        .ok_or_else(|| "extensions metadata object unavailable".to_string())?;
    if let Some(patch) = metadata_patch.as_object() {
        merge_json_objects(metadata_object, patch);
    }

    metadata_object
        .entry("installedTimestamp".to_string())
        .or_insert_with(|| json!(epoch_millis()));
    metadata_object
        .entry("targetPlatform".to_string())
        .or_insert_with(|| json!(current_target_platform()));
    metadata_object
        .entry("isMachineScoped".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("isApplicationScoped".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("isPreReleaseVersion".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("hasPreReleaseVersion".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("private".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("preRelease".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("updated".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("pinned".to_string())
        .or_insert_with(|| json!(false));
    metadata_object
        .entry("source".to_string())
        .or_insert_with(|| json!("resource"));
    metadata_object
        .entry("size".to_string())
        .or_insert_with(|| json!(extension_directory_size(extension_root)));

    if let Some(parent) = package_json.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let serialized = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("extensions failed to serialize manifest: {error}"))?;
    fs::write(&package_json, serialized).map_err(|error| {
        format!(
            "extensions failed to write {}: {error}",
            package_json.display()
        )
    })
}

fn build_local_extension_value(
    extension_root: &Path,
    extension_type: u64,
    is_builtin: bool,
    manifest: &Value,
    metadata: &Value,
) -> Value {
    let manifest_object = manifest.as_object();
    let metadata_object = metadata.as_object();
    let publisher = manifest_object
        .and_then(|value| value.get("publisher"))
        .and_then(Value::as_str)
        .unwrap_or("undefined_publisher");
    let name = manifest_object
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("extension");
    let identifier = format!("{publisher}.{name}");
    let readme_path = extension_root.join("README.md");
    let changelog_path = extension_root.join("CHANGELOG.md");
    let source = metadata_object
        .and_then(|value| value.get("source"))
        .and_then(Value::as_str)
        .unwrap_or(if is_builtin { "resource" } else { "vsix" });

    json!({
        "type": extension_type,
        "isBuiltin": is_builtin,
        "identifier": {
            "id": identifier,
            "uuid": metadata_object.and_then(|value| value.get("id")).and_then(Value::as_str)
        },
        "manifest": manifest,
        "location": file_uri_value_from_path(extension_root),
        "targetPlatform": metadata_object
            .and_then(|value| value.get("targetPlatform"))
            .and_then(Value::as_str)
            .unwrap_or("undefined"),
        "publisherDisplayName": metadata_object
            .and_then(|value| value.get("publisherDisplayName"))
            .and_then(Value::as_str),
        "readmeUrl": if readme_path.is_file() {
            file_uri_value_from_path(&readme_path)
        } else {
            Value::Null
        },
        "changelogUrl": if changelog_path.is_file() {
            file_uri_value_from_path(&changelog_path)
        } else {
            Value::Null
        },
        "isValid": true,
        "validations": [],
        "preRelease": metadata_object
            .and_then(|value| value.get("preRelease"))
            .and_then(Value::as_bool)
            .unwrap_or(false),

        "isWorkspaceScoped": false,
        "isMachineScoped": metadata_object
            .and_then(|value| value.get("isMachineScoped"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "isApplicationScoped": metadata_object
            .and_then(|value| value.get("isApplicationScoped"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "publisherId": metadata_object
            .and_then(|value| value.get("publisherId"))
            .cloned()
            .unwrap_or(Value::Null),
        "installedTimestamp": metadata_object
            .and_then(|value| value.get("installedTimestamp"))
            .cloned()
            .unwrap_or_else(|| json!(epoch_millis())),
        "isPreReleaseVersion": metadata_object
            .and_then(|value| value.get("isPreReleaseVersion"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "hasPreReleaseVersion": metadata_object
            .and_then(|value| value.get("hasPreReleaseVersion"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "private": metadata_object
            .and_then(|value| value.get("private"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "updated": metadata_object
            .and_then(|value| value.get("updated"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "pinned": metadata_object
            .and_then(|value| value.get("pinned"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "source": source,
        "size": metadata_object
            .and_then(|value| value.get("size"))
            .and_then(Value::as_u64)
            .unwrap_or_else(|| extension_directory_size(extension_root)),
    })
}

fn scan_extension_install_root(
    root: &Path,
    extension_type: u64,
    is_builtin: bool,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }

    if let Some(extension_root) = ensure_extension_root(root) {
        let (manifest, metadata) = load_manifest_and_metadata(&extension_root)?;
        out.push(build_local_extension_value(
            &extension_root,
            extension_type,
            is_builtin,
            &manifest,
            &metadata,
        ));
        return Ok(out);
    }

    for entry in fs::read_dir(root).map_err(|error| {
        format!(
            "extensions failed to read install root {}: {error}",
            root.display()
        )
    })? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.path().is_dir() {
            continue;
        }
        let Some(extension_root) = ensure_extension_root(&entry.path()) else {
            continue;
        };
        let (manifest, metadata) = match load_manifest_and_metadata(&extension_root) {
            Ok(value) => value,
            Err(_) => continue,
        };
        out.push(build_local_extension_value(
            &extension_root,
            extension_type,
            is_builtin,
            &manifest,
            &metadata,
        ));
    }

    Ok(out)
}

fn collect_installed_extensions(
    builtin_extensions_dir: &Path,
    user_extensions_dir: &Path,
    extension_type: Option<u64>,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    if extension_type != Some(1) {
        out.extend(scan_extension_install_root(
            builtin_extensions_dir,
            0,
            true,
        )?);
    }
    if extension_type != Some(0) {
        out.extend(scan_extension_install_root(user_extensions_dir, 1, false)?);
    }
    out.sort_by(|a, b| {
        let a_id = a
            .get("identifier")
            .and_then(Value::as_object)
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let b_id = b
            .get("identifier")
            .and_then(Value::as_object)
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        a_id.cmp(&b_id)
    });
    Ok(out)
}

fn zip_entry_is_safe(entry: &str) -> bool {
    if entry.trim().is_empty() || entry.starts_with('/') || entry.starts_with('\\') {
        return false;
    }
    let path = Path::new(entry);
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => {}
            _ => return false,
        }
    }
    true
}

fn list_archive_entries(archive: &Path) -> Result<Vec<String>, String> {
    let output = Command::new("unzip")
        .arg("-Z1")
        .arg(archive)
        .output()
        .map_err(|error| {
            format!(
                "extensions failed to list archive {}: {error}",
                archive.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "extensions failed to list archive {}: {}",
            archive.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Err(format!("extensions archive {} is empty", archive.display()));
    }
    for entry in &entries {
        if !zip_entry_is_safe(entry) {
            return Err(format!(
                "extensions archive {} has unsafe entry '{}'",
                archive.display(),
                entry
            ));
        }
    }
    Ok(entries)
}

fn read_manifest_from_archive(archive: &Path) -> Result<Value, String> {
    let entries = list_archive_entries(archive)?;
    let manifest_entry = entries
        .iter()
        .find(|entry| entry.ends_with("/package.json") || entry.as_str() == "package.json")
        .ok_or_else(|| {
            format!(
                "extensions archive {} is missing package.json",
                archive.display()
            )
        })?
        .to_string();
    let output = Command::new("unzip")
        .arg("-p")
        .arg(archive)
        .arg(&manifest_entry)
        .output()
        .map_err(|error| {
            format!(
                "extensions failed to extract manifest from {}: {error}",
                archive.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "extensions failed to read manifest from {}: {}",
            archive.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let mut manifest: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "extensions failed to parse manifest from {}: {error}",
            archive.display()
        )
    })?;
    if let Some(object) = manifest.as_object_mut() {
        object.remove("__metadata");
    }
    Ok(manifest)
}

fn extract_archive_to_dir(archive: &Path, destination: &Path) -> Result<(), String> {
    let status = Command::new("unzip")
        .arg("-q")
        .arg("-o")
        .arg(archive)
        .arg("-d")
        .arg(destination)
        .status()
        .map_err(|error| {
            format!(
                "extensions failed to extract archive {}: {error}",
                archive.display()
            )
        })?;
    if !status.success() {
        return Err(format!(
            "extensions failed to extract archive {} (status={})",
            archive.display(),
            status
        ));
    }
    Ok(())
}

fn install_from_directory(
    source: &Path,
    user_extensions_dir: &Path,
    metadata_patch: &Value,
) -> Result<Value, String> {
    let source_root = ensure_extension_root(source)
        .ok_or_else(|| format!("extensions install source {} is invalid", source.display()))?;
    let (manifest, _) = load_manifest_and_metadata(&source_root)?;
    let publisher = manifest
        .get("publisher")
        .and_then(Value::as_str)
        .unwrap_or("undefined_publisher");
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("extension");
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");
    let install_dir = user_extensions_dir.join(format!(
        "{}.{}-{}",
        sanitize_extension_segment(publisher),
        sanitize_extension_segment(name),
        sanitize_extension_segment(version)
    ));
    fs::create_dir_all(user_extensions_dir).map_err(|error| {
        format!(
            "extensions failed to create user install dir {}: {error}",
            user_extensions_dir.display()
        )
    })?;
    copy_path_recursive(&source_root, &install_dir, true).map_err(|error| {
        format!(
            "extensions failed to copy {} to {}: {error}",
            source_root.display(),
            install_dir.display()
        )
    })?;
    write_manifest_metadata(&install_dir, metadata_patch)?;
    let (installed_manifest, metadata) = load_manifest_and_metadata(&install_dir)?;
    Ok(build_local_extension_value(
        &install_dir,
        1,
        false,
        &installed_manifest,
        &metadata,
    ))
}

fn install_from_archive(
    archive: &Path,
    user_extensions_dir: &Path,
    cache_dir: &Path,
    metadata_patch: &Value,
) -> Result<Value, String> {
    list_archive_entries(archive)?;
    fs::create_dir_all(cache_dir).map_err(|error| {
        format!(
            "extensions failed to create cache dir {}: {error}",
            cache_dir.display()
        )
    })?;
    let extract_dir = cache_dir.join(format!(
        "extract-{}-{}",
        epoch_millis(),
        stable_short_hex_id(&archive.to_string_lossy())
    ));
    fs::create_dir_all(&extract_dir).map_err(|error| {
        format!(
            "extensions failed to create extract dir {}: {error}",
            extract_dir.display()
        )
    })?;
    let result = (|| {
        extract_archive_to_dir(archive, &extract_dir)?;
        install_from_directory(&extract_dir, user_extensions_dir, metadata_patch)
    })();
    let _ = fs::remove_dir_all(&extract_dir);
    result
}

fn zip_extension_directory(
    extension_dir: &Path,
    cache_dir: &Path,
    prefix: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(cache_dir).map_err(|error| {
        format!(
            "extensions failed to create cache dir {}: {error}",
            cache_dir.display()
        )
    })?;
    let zip_path = cache_dir.join(format!(
        "{}-{}-{}.zip",
        sanitize_extension_segment(prefix),
        epoch_millis(),
        stable_short_hex_id(&extension_dir.to_string_lossy())
    ));
    let status = Command::new("zip")
        .arg("-q")
        .arg("-r")
        .arg(&zip_path)
        .arg(".")
        .current_dir(extension_dir)
        .status()
        .map_err(|error| {
            format!(
                "extensions failed to zip extension dir {}: {error}",
                extension_dir.display()
            )
        })?;
    if !status.success() {
        return Err(format!(
            "extensions failed to zip extension dir {} (status={})",
            extension_dir.display(),
            status
        ));
    }
    Ok(zip_path)
}

fn gallery_download_url(gallery: &Value) -> Option<String> {
    gallery
        .get("assets")
        .and_then(Value::as_object)
        .and_then(|assets| assets.get("download"))
        .and_then(Value::as_object)
        .and_then(|download| {
            download
                .get("uri")
                .and_then(Value::as_str)
                .or_else(|| download.get("fallbackUri").and_then(Value::as_str))
        })
        .map(ToOwned::to_owned)
}

fn gallery_extension_metadata(gallery: &Value) -> Value {
    let is_pre_release = gallery
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|value| value.get("isPreReleaseVersion"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    json!({
        "id": gallery.get("identifier").and_then(Value::as_object).and_then(|value| value.get("uuid")).and_then(Value::as_str),
        "publisherId": gallery.get("publisherId").and_then(Value::as_str),
        "publisherDisplayName": gallery.get("publisherDisplayName").and_then(Value::as_str),
        "private": gallery.get("private").and_then(Value::as_bool).unwrap_or(false),
        "isPreReleaseVersion": is_pre_release,
        "hasPreReleaseVersion": gallery.get("hasPreReleaseVersion").and_then(Value::as_bool).unwrap_or(false),
        "preRelease": is_pre_release,
        "targetPlatform": gallery
            .get("properties")
            .and_then(Value::as_object)
            .and_then(|value| value.get("targetPlatform"))
            .and_then(Value::as_str)
            .unwrap_or("undefined"),
        "source": "gallery",
        "installedTimestamp": epoch_millis()
    })
}

async fn download_to_file(url: &str, destination: &Path) -> Result<(), String> {
    let response = reqwest::get(url)
        .await
        .map_err(|error| format!("extensions download failed for {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "extensions download failed for {url} with status {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("extensions download body failed for {url}: {error}"))?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "extensions failed to create download destination {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(destination, &bytes).map_err(|error| {
        format!(
            "extensions failed to write download {}: {error}",
            destination.display()
        )
    })
}

fn uninstall_local_extension(extension: &Value, user_extensions_dir: &Path) -> Result<(), String> {
    let location = extension
        .get("location")
        .and_then(extract_fs_path)
        .or_else(|| extract_fs_path(extension))
        .ok_or_else(|| "extensions.uninstall missing local extension location".to_string())?;
    let normalized_location = location.canonicalize().unwrap_or_else(|_| location.clone());
    let normalized_user_root = user_extensions_dir
        .canonicalize()
        .unwrap_or_else(|_| user_extensions_dir.to_path_buf());
    if !normalized_location.starts_with(&normalized_user_root) {
        return Err(format!(
            "extensions.uninstall refused to remove non-user extension path {}",
            normalized_location.display()
        ));
    }
    remove_path_force(&normalized_location, true).map_err(|error| {
        format!(
            "extensions.uninstall failed to remove {}: {error}",
            normalized_location.display()
        )
    })
}

fn update_local_extension_metadata(extension: &Value, metadata: &Value) -> Result<Value, String> {
    let location = extension
        .get("location")
        .and_then(extract_fs_path)
        .or_else(|| extract_fs_path(extension))
        .ok_or_else(|| "extensions.updateMetadata missing local extension location".to_string())?;
    write_manifest_metadata(&location, metadata)?;
    let (manifest, extension_metadata) = load_manifest_and_metadata(&location)?;
    let extension_type = extension.get("type").and_then(Value::as_u64).unwrap_or(1);
    let is_builtin = extension
        .get("isBuiltin")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(build_local_extension_value(
        &location,
        extension_type,
        is_builtin,
        &manifest,
        &extension_metadata,
    ))
}

async fn load_extensions_control_manifest(repo_root: &Path) -> Result<Value, String> {
    let default_manifest = json!({
        "malicious": [],
        "deprecated": {},
        "search": [],
        "autoUpdate": {}
    });

    let control_url_from_env = std::env::var("VSCODE_TAURI_EXTENSIONS_GALLERY_CONTROL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let control_url = if let Some(url) = control_url_from_env {
        Some(url)
    } else {
        let product_path = repo_root.join("product.json");
        let product_contents = fs::read_to_string(&product_path).ok();
        product_contents
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .and_then(|product| {
                product
                    .get("extensionsGallery")
                    .and_then(Value::as_object)
                    .and_then(|gallery| gallery.get("controlUrl"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .filter(|value| !value.trim().is_empty())
    };

    let Some(control_url) = control_url else {
        return Ok(default_manifest);
    };

    let response = match reqwest::get(control_url.clone()).await {
        Ok(response) => response,
        Err(_) => return Ok(default_manifest),
    };
    if !response.status().is_success() {
        return Ok(default_manifest);
    }
    let payload_bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => return Ok(default_manifest),
    };
    let payload: Value = match serde_json::from_slice(&payload_bytes) {
        Ok(payload) => payload,
        Err(_) => return Ok(default_manifest),
    };
    let object = payload.as_object().cloned().unwrap_or_default();
    Ok(json!({
        "malicious": object.get("malicious").cloned().unwrap_or_else(|| json!([])),
        "deprecated": object.get("deprecated").cloned().unwrap_or_else(|| json!({})),
        "search": object.get("search").cloned().unwrap_or_else(|| json!([])),
        "autoUpdate": object.get("autoUpdate").cloned().unwrap_or_else(|| json!({}))
    }))
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

fn capability_domain_name(domain: CapabilityDomain) -> &'static str {
    match domain {
        CapabilityDomain::Window => "window",
        CapabilityDomain::Filesystem => "filesystem",
        CapabilityDomain::Terminal => "terminal",
        CapabilityDomain::Clipboard => "clipboard",
        CapabilityDomain::Dialogs => "dialogs",
        CapabilityDomain::Process => "process",
        CapabilityDomain::Power => "power",
        CapabilityDomain::Os => "os",
        CapabilityDomain::Update => "update",
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn keyboard_layout_id() -> String {
    let raw = std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string());
    let normalized = raw
        .split('.')
        .next()
        .unwrap_or("en-US")
        .replace('_', "-")
        .to_lowercase();
    format!("tauri-{normalized}")
}

fn storage_scope_key(request: Option<&Value>) -> String {
    let request = request.and_then(Value::as_object);
    if let Some(workspace_key) =
        workspace_identifier_key(request.and_then(|value| value.get("workspace")))
    {
        return format!("workspace:{workspace_key}");
    }
    if let Some(profile_id) = request
        .and_then(|value| value.get("profile"))
        .and_then(profile_id_from_value)
    {
        return format!("profile:{profile_id}");
    }
    "application:default".to_string()
}

fn unique_profile_id(existing: &BTreeMap<String, Value>, requested_id: String) -> String {
    let mut sanitized = requested_id
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while sanitized.contains("--") {
        sanitized = sanitized.replace("--", "-");
    }
    sanitized = sanitized.trim_matches('-').to_string();
    if sanitized.is_empty() {
        sanitized = "profile".to_string();
    }
    if !existing.contains_key(&sanitized) {
        return sanitized;
    }
    let mut index = 1u64;
    loop {
        let candidate = format!("{sanitized}-{index}");
        if !existing.contains_key(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn profile_id_from_value(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let object = value.as_object()?;
    if let Some(id) = object.get("id").and_then(Value::as_str) {
        return Some(id.to_string());
    }
    let location = object.get("location")?;
    let location_path = location.get("path").and_then(Value::as_str)?;
    Path::new(location_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

fn workspace_identifier_key(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(id) = value.get("id").and_then(Value::as_str) {
        return Some(id.to_string());
    }
    if let Some(config_path) = value.get("configPath") {
        if let Some(path) = extract_fs_path(config_path) {
            return Some(to_forward_slash_path(&path));
        }
    }
    if let Some(uri) = value.get("uri") {
        if let Some(path) = extract_fs_path(uri) {
            return Some(to_forward_slash_path(&path));
        }
    }
    if let Some(path) = extract_fs_path(value) {
        return Some(to_forward_slash_path(&path));
    }
    None
}

fn workspace_identifier_for_path(path: &Path) -> Value {
    let normalized = to_forward_slash_path(path);
    json!({
        "id": stable_short_hex_id(&normalized),
        "configPath": file_uri_value_from_path(path)
    })
}

fn workspace_identifier_from_value(value: &Value) -> Value {
    if let Some(object) = value.as_object() {
        if object.get("id").and_then(Value::as_str).is_some() && object.get("configPath").is_some()
        {
            let mut workspace = Value::Object(object.clone());
            if let Some(config_path) = workspace.get("configPath").and_then(Value::as_str) {
                workspace["configPath"] = file_uri_value_from_path(&PathBuf::from(config_path));
            }
            return workspace;
        }
    }

    let path = extract_fs_path(value).unwrap_or_else(|| PathBuf::from("/"));
    workspace_identifier_for_path(&path)
}

fn recent_entry_matches_path(recent: &Value, candidate_path: &Value) -> bool {
    let mut candidate_paths = collect_recent_paths(candidate_path);
    if candidate_paths.is_empty() {
        return false;
    }
    candidate_paths.sort();
    candidate_paths.dedup();
    let recent_paths = collect_recent_paths(recent);
    recent_paths
        .iter()
        .any(|recent_path| candidate_paths.binary_search(recent_path).is_ok())
}

fn collect_recent_paths(value: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(path) = extract_fs_path(value) {
        paths.push(to_forward_slash_path(&path));
    }
    if let Some(object) = value.as_object() {
        for key in ["workspace", "folderUri", "fileUri", "uri", "configPath"] {
            if let Some(nested) = object.get(key) {
                paths.extend(collect_recent_paths(nested));
            }
        }
    }
    paths
}

fn profile_descriptor(
    user_data_dir: &Path,
    profile_id: &str,
    profile_name: &str,
    is_default: bool,
    is_transient: bool,
) -> Value {
    let profile_root = user_data_dir.join("User/profiles").join(profile_id);
    let cache_home = user_data_dir.join("CachedProfilesData").join(profile_id);
    let _ = fs::create_dir_all(&profile_root);
    let _ = fs::create_dir_all(&cache_home);

    json!({
        "id": profile_id,
        "isDefault": is_default,
        "isTransient": is_transient,
        "name": profile_name,
        "location": file_uri_value_from_path(&profile_root),
        "globalStorageHome": file_uri_value_from_path(&profile_root.join("globalStorage")),
        "settingsResource": file_uri_value_from_path(&profile_root.join("settings.json")),
        "keybindingsResource": file_uri_value_from_path(&profile_root.join("keybindings.json")),
        "tasksResource": file_uri_value_from_path(&profile_root.join("tasks.json")),
        "snippetsHome": file_uri_value_from_path(&profile_root.join("snippets")),
        "promptsHome": file_uri_value_from_path(&profile_root.join("prompts")),
        "extensionsResource": file_uri_value_from_path(&profile_root.join("extensions.json")),
        "mcpResource": file_uri_value_from_path(&profile_root.join("mcp.json")),
        "cacheHome": file_uri_value_from_path(&cache_home)
    })
}

fn read_fallback_counts(path: &Path) -> Result<BTreeMap<String, u64>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => {
            return Err(format!(
                "failed to read fallback metrics {}: {error}",
                path.display()
            ))
        }
    };

    let payload: Value = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "failed to parse fallback metrics {}: {error}",
            path.display()
        )
    })?;
    let mut counts = BTreeMap::new();
    if let Some(entries) = payload.get("counts").and_then(Value::as_object) {
        for (key, value) in entries {
            let Some(count) = value.as_u64() else {
                continue;
            };
            counts.insert(key.clone(), count);
        }
    }
    Ok(counts)
}

fn persist_fallback_metrics(
    path: &Path,
    at_ms: u64,
    counts: &BTreeMap<String, u64>,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = json!({
        "version": 1,
        "updated_at_ms": at_ms,
        "counts": counts
    });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    fs::write(path, bytes)
}

fn append_fallback_event(
    path: &Path,
    at_ms: u64,
    key: &str,
    class: &str,
    domain: &str,
    method: &str,
    count: u64,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let event = json!({
        "at_ms": at_ms,
        "key": key,
        "class": class,
        "domain": domain,
        "method": method,
        "count": count
    });
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let serialized =
        serde_json::to_string(&event).map_err(|error| std::io::Error::other(error.to_string()))?;
    file.write_all(serialized.as_bytes())?;
    file.write_all(b"\n")
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

    fn temp_repo_root(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vscode-tauri-router-{prefix}-{nonce}"));
        fs::create_dir_all(&path).expect("temp repo root should be created");
        path
    }

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

    #[test]
    fn extension_archive_paths_reject_traversal() {
        assert!(zip_entry_is_safe("extension/package.json"));
        assert!(zip_entry_is_safe("publisher.name/package.json"));
        assert!(!zip_entry_is_safe("../package.json"));
        assert!(!zip_entry_is_safe("/absolute/package.json"));
        assert!(!zip_entry_is_safe("extension/../../package.json"));
    }

    #[test]
    fn extension_metadata_builder_sets_expected_defaults() {
        let manifest = json!({
            "publisher": "example",
            "name": "hello",
            "version": "1.0.0",
            "engines": { "vscode": "*" }
        });
        let metadata = json!({});
        let location = std::env::temp_dir().join("vscode-tauri-extension-metadata-test");
        let local = build_local_extension_value(&location, 1, false, &manifest, &metadata);

        assert_eq!(local["identifier"]["id"], json!("example.hello"));
        assert_eq!(local["type"], json!(1));
        assert_eq!(local["source"], json!("vsix"));
        assert_eq!(local["isApplicationScoped"], json!(false));
    }

    #[test]
    fn unique_profile_id_sanitizes_and_deduplicates() {
        let mut existing = BTreeMap::new();
        existing.insert("profile".to_string(), json!({}));
        existing.insert("profile-1".to_string(), json!({}));

        let profile_id = unique_profile_id(&existing, " profile!? ".to_string());
        assert_eq!(profile_id, "profile-2");
    }

    #[test]
    fn profile_id_from_value_accepts_object_id_and_location_path() {
        let from_id = profile_id_from_value(&json!({ "id": "named-profile" }));
        assert_eq!(from_id.as_deref(), Some("named-profile"));

        let from_location = profile_id_from_value(&json!({
            "location": {
                "scheme": "file",
                "authority": "",
                "path": "/tmp/user-data/User/profiles/location-profile"
            }
        }));
        assert_eq!(from_location.as_deref(), Some("location-profile"));
    }

    #[tokio::test]
    async fn user_data_profiles_workspace_mapping_tracks_profile_lifecycle() {
        let repo_root = temp_repo_root("profiles");
        let router = CapabilityRouter::new(repo_root);
        let workspace = json!({ "id": "workspace-1" });

        let created = router
            .dispatch_channel(
                "userDataProfiles",
                "createNamedProfile",
                &json!(["Dev", { "transient": false }, workspace.clone()]),
            )
            .await
            .expect("createNamedProfile should succeed");
        let created_id = created
            .get("id")
            .and_then(Value::as_str)
            .expect("profile should include id")
            .to_string();

        {
            let state = router
                .user_data_profiles_state
                .lock()
                .expect("user profile state should lock");
            assert_eq!(
                state.workspace_profiles.get("workspace-1"),
                Some(&created_id)
            );
            assert!(state.profiles.contains_key(&created_id));
        }

        router
            .dispatch_channel("userDataProfiles", "resetWorkspaces", &json!([]))
            .await
            .expect("resetWorkspaces should succeed");
        {
            let state = router
                .user_data_profiles_state
                .lock()
                .expect("user profile state should lock");
            assert!(state.workspace_profiles.is_empty());
        }

        router
            .dispatch_channel(
                "userDataProfiles",
                "setProfileForWorkspace",
                &json!([workspace.clone(), created_id.clone()]),
            )
            .await
            .expect("setProfileForWorkspace should succeed");

        let transient = router
            .dispatch_channel(
                "userDataProfiles",
                "createTransientProfile",
                &json!([]),
            )
            .await
            .expect("createTransientProfile should succeed");
        let transient_id = transient
            .get("id")
            .and_then(Value::as_str)
            .expect("transient profile should include id")
            .to_string();
        assert_eq!(transient["isTransient"], json!(true));

        router
            .dispatch_channel("userDataProfiles", "cleanUpTransientProfiles", &json!([]))
            .await
            .expect("cleanUpTransientProfiles should succeed");
        {
            let state = router
                .user_data_profiles_state
                .lock()
                .expect("user profile state should lock");
            assert!(!state.profiles.contains_key(&transient_id));
            assert_eq!(
                state.workspace_profiles.get("workspace-1"),
                Some(&created_id)
            );
        }

        router
            .dispatch_channel(
                "userDataProfiles",
                "removeProfile",
                &json!([created_id.clone()]),
            )
            .await
            .expect("removeProfile should succeed");
        {
            let state = router
                .user_data_profiles_state
                .lock()
                .expect("user profile state should lock");
            assert!(!state.profiles.contains_key(&created_id));
            assert!(state.workspace_profiles.is_empty());
        }
    }

    #[tokio::test]
    async fn workspaces_recently_opened_can_be_added_removed_and_cleared() {
        let repo_root = temp_repo_root("workspaces-recents");
        let router = CapabilityRouter::new(repo_root);

        let folder_recent = json!({
            "folderUri": {
                "scheme": "file",
                "authority": "",
                "path": "/tmp/workspace-folder"
            }
        });
        let file_recent = json!({
            "fileUri": {
                "scheme": "file",
                "authority": "",
                "path": "/tmp/readme.md"
            }
        });

        router
            .dispatch_channel(
                "workspaces",
                "addRecentlyOpened",
                &json!([[folder_recent.clone(), file_recent.clone()]]),
            )
            .await
            .expect("addRecentlyOpened should succeed");

        let recently_opened = router
            .dispatch_channel("workspaces", "getRecentlyOpened", &json!([]))
            .await
            .expect("getRecentlyOpened should succeed");
        let workspaces = recently_opened
            .get("workspaces")
            .and_then(Value::as_array)
            .expect("workspaces should be an array");
        let files = recently_opened
            .get("files")
            .and_then(Value::as_array)
            .expect("files should be an array");
        assert_eq!(workspaces.len(), 1);
        assert_eq!(files.len(), 1);

        router
            .dispatch_channel(
                "workspaces",
                "removeRecentlyOpened",
                &json!([[{ "path": "/tmp/workspace-folder" }]]),
            )
            .await
            .expect("removeRecentlyOpened should succeed");

        let after_remove = router
            .dispatch_channel("workspaces", "getRecentlyOpened", &json!([]))
            .await
            .expect("getRecentlyOpened should succeed after remove");
        assert_eq!(
            after_remove["workspaces"]
                .as_array()
                .expect("workspaces should be an array")
                .len(),
            0
        );
        assert_eq!(
            after_remove["files"]
                .as_array()
                .expect("files should be an array")
                .len(),
            1
        );

        router
            .dispatch_channel("workspaces", "clearRecentlyOpened", &json!([]))
            .await
            .expect("clearRecentlyOpened should succeed");
        let after_clear = router
            .dispatch_channel("workspaces", "getRecentlyOpened", &json!([]))
            .await
            .expect("getRecentlyOpened should succeed after clear");
        assert_eq!(
            after_clear["workspaces"]
                .as_array()
                .expect("workspaces should be an array")
                .len(),
            0
        );
        assert_eq!(
            after_clear["files"]
                .as_array()
                .expect("files should be an array")
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn local_filesystem_fd_roundtrip_and_unknown_fd_close_error() {
        let repo_root = temp_repo_root("localfs-fd");
        let router = CapabilityRouter::new(repo_root.clone());
        let file_path = repo_root.join("localfs-fd.txt");

        let fd_write = router
            .dispatch_channel(
                "localFilesystem",
                "open",
                &json!([{ "path": file_path }, { "create": true }]),
            )
            .await
            .expect("open(create) should succeed")
            .as_u64()
            .expect("open should return numeric file descriptor");

        let bytes_written = router
            .dispatch_channel(
                "localFilesystem",
                "write",
                &json!([fd_write, 0, [72, 105]]),
            )
            .await
            .expect("write should succeed")
            .as_u64()
            .expect("write should return number");
        assert_eq!(bytes_written, 2);

        router
            .dispatch_channel("localFilesystem", "close", &json!([fd_write]))
            .await
            .expect("close should succeed");

        let fd_read = router
            .dispatch_channel("localFilesystem", "open", &json!([{ "path": file_path }]))
            .await
            .expect("open(read) should succeed")
            .as_u64()
            .expect("open should return numeric file descriptor");

        let read_result = router
            .dispatch_channel("localFilesystem", "read", &json!([fd_read, 0, 16]))
            .await
            .expect("read should succeed");
        assert_eq!(read_result[1], json!(2));
        assert_eq!(read_result[0]["buffer"], json!([72, 105]));

        router
            .dispatch_channel("localFilesystem", "close", &json!([fd_read]))
            .await
            .expect("close should succeed");

        let error = router
            .dispatch_channel("localFilesystem", "close", &json!([fd_read]))
            .await
            .expect_err("closing unknown descriptor should fail");
        assert!(error.contains("unknown file descriptor"));
    }

    #[tokio::test]
    async fn local_filesystem_write_rejects_invalid_offset() {
        let repo_root = temp_repo_root("localfs-invalid-offset");
        let router = CapabilityRouter::new(repo_root.clone());
        let file_path = repo_root.join("invalid-offset.txt");

        let fd = router
            .dispatch_channel(
                "localFilesystem",
                "open",
                &json!([{ "path": file_path }, { "create": true }]),
            )
            .await
            .expect("open(create) should succeed")
            .as_u64()
            .expect("open should return numeric file descriptor");

        let error = router
            .dispatch_channel(
                "localFilesystem",
                "write",
                &json!([fd, 0, [1, 2], 5, 1]),
            )
            .await
            .expect_err("invalid offset should fail");
        assert!(error.contains("invalid offset"));

        router
            .dispatch_channel("localFilesystem", "close", &json!([fd]))
            .await
            .expect("close should succeed");
    }

    #[tokio::test]
    async fn watcher_set_verbose_logging_updates_state() {
        let repo_root = temp_repo_root("watcher-verbose");
        let router = CapabilityRouter::new(repo_root);

        assert_eq!(router.watcher_verbose_logging(), false);

        router
            .dispatch_channel("watcher", "setVerboseLogging", &json!([true]))
            .await
            .expect("setVerboseLogging should succeed");
        assert_eq!(router.watcher_verbose_logging(), true);

        router
            .dispatch_channel("watcher", "setVerboseLogging", &json!([false]))
            .await
            .expect("setVerboseLogging should succeed");
        assert_eq!(router.watcher_verbose_logging(), false);
    }

    #[test]
    fn watcher_changes_from_filesystem_event_includes_correlation_id() {
        let repo_root = temp_repo_root("watcher-correlation");
        let router = CapabilityRouter::new(repo_root);

        {
            let mut state = router
                .watcher_state
                .lock()
                .expect("watcher state should lock");
            state.watch_requests.insert(
                "watcher:42".to_string(),
                WatcherWatchRequestState {
                    correlation_id: Some(777),
                },
            );
        }

        let payload = router
            .watcher_changes_from_filesystem_event("watcher:42", "/tmp/demo.txt", "created")
            .expect("watch payload should be present");
        assert_eq!(payload[0]["type"], json!(1));
        assert_eq!(payload[0]["cId"], json!(777));
        assert_eq!(payload[0]["resource"]["scheme"], json!("file"));
        assert_eq!(
            router.watcher_changes_from_filesystem_event("watcher:missing", "/tmp/demo.txt", "created"),
            None
        );
    }

    #[tokio::test]
    async fn watcher_watch_requires_requests_array_argument() {
        let repo_root = temp_repo_root("watcher-watch-args");
        let router = CapabilityRouter::new(repo_root);

        let error = router
            .dispatch_channel("watcher", "watch", &json!({}))
            .await
            .expect_err("watcher.watch without requests should fail");
        assert!(error.contains("watcher.watch expected requests array argument"));
    }

    #[test]
    fn watcher_changes_from_filesystem_event_without_correlation_omits_cid() {
        let repo_root = temp_repo_root("watcher-no-correlation");
        let router = CapabilityRouter::new(repo_root);

        {
            let mut state = router
                .watcher_state
                .lock()
                .expect("watcher state should lock");
            state.watch_requests.insert(
                "watcher:11".to_string(),
                WatcherWatchRequestState {
                    correlation_id: None,
                },
            );
        }

        let payload = router
            .watcher_changes_from_filesystem_event("watcher:11", "/tmp/demo.txt", "deleted")
            .expect("watch payload should be present");
        assert_eq!(payload[0]["type"], json!(2));
        assert_eq!(payload[0].get("cId"), None);
    }

    #[tokio::test]
    async fn watcher_stop_clears_registered_requests() {
        let repo_root = temp_repo_root("watcher-stop");
        let router = CapabilityRouter::new(repo_root);

        {
            let mut state = router
                .watcher_state
                .lock()
                .expect("watcher state should lock");
            state.watch_requests.insert(
                "watcher:1".to_string(),
                WatcherWatchRequestState {
                    correlation_id: Some(1),
                },
            );
        }

        router
            .dispatch_channel("watcher", "stop", &json!([]))
            .await
            .expect("watcher.stop should succeed");

        let state = router
            .watcher_state
            .lock()
            .expect("watcher state should lock");
        assert!(state.watch_requests.is_empty());
    }

    #[tokio::test]
    async fn local_filesystem_stat_realpath_and_readdir_have_expected_shapes() {
        let repo_root = temp_repo_root("localfs-shapes");
        let router = CapabilityRouter::new(repo_root.clone());
        let dir_path = repo_root.join("folder");
        let file_path = dir_path.join("note.txt");
        fs::create_dir_all(&dir_path).expect("dir should be created");
        fs::write(&file_path, b"hello").expect("file should be written");

        let dir_stat = router
            .dispatch_channel(
                "localFilesystem",
                "stat",
                &json!([{ "path": dir_path }]),
            )
            .await
            .expect("dir stat should succeed");
        assert_eq!(dir_stat["type"], json!(2));

        let file_stat = router
            .dispatch_channel(
                "localFilesystem",
                "stat",
                &json!([{ "path": file_path.clone() }]),
            )
            .await
            .expect("file stat should succeed");
        assert_eq!(file_stat["type"], json!(1));
        assert_eq!(file_stat["size"], json!(5));

        let realpath = router
            .dispatch_channel(
                "localFilesystem",
                "realpath",
                &json!([{ "path": file_path.clone() }]),
            )
            .await
            .expect("realpath should succeed");
        let resolved_path = extract_fs_path(&realpath).expect("realpath should return URI/path");
        assert_eq!(
            resolved_path,
            fs::canonicalize(file_path).expect("canonicalize should succeed")
        );

        let readdir = router
            .dispatch_channel(
                "localFilesystem",
                "readdir",
                &json!([{ "path": dir_path }]),
            )
            .await
            .expect("readdir should succeed")
            .as_array()
            .cloned()
            .expect("readdir should return array");
        assert!(readdir.contains(&json!(["note.txt", 1])));
    }

    #[tokio::test]
    async fn local_filesystem_mkdir_writefile_rename_copy_clone_and_delete_roundtrip() {
        let repo_root = temp_repo_root("localfs-roundtrip");
        let router = CapabilityRouter::new(repo_root.clone());
        let nested_dir = repo_root.join("nested/a/b");
        let source_file = nested_dir.join("source.bin");
        let renamed_file = nested_dir.join("renamed.bin");
        let copied_file = nested_dir.join("copied.bin");
        let cloned_file = nested_dir.join("cloned.bin");

        router
            .dispatch_channel("localFilesystem", "mkdir", &json!([{ "path": nested_dir }]))
            .await
            .expect("mkdir should succeed");

        router
            .dispatch_channel(
                "localFilesystem",
                "writeFile",
                &json!([{ "path": source_file.clone() }, [1, 2, 3]]),
            )
            .await
            .expect("writeFile should succeed");

        router
            .dispatch_channel(
                "localFilesystem",
                "rename",
                &json!([
                    { "path": source_file.clone() },
                    { "path": renamed_file.clone() },
                    { "overwrite": false }
                ]),
            )
            .await
            .expect("rename should succeed");

        router
            .dispatch_channel(
                "localFilesystem",
                "copy",
                &json!([
                    { "path": renamed_file.clone() },
                    { "path": copied_file.clone() },
                    { "overwrite": true }
                ]),
            )
            .await
            .expect("copy should succeed");

        router
            .dispatch_channel(
                "localFilesystem",
                "cloneFile",
                &json!([
                    { "path": copied_file.clone() },
                    { "path": cloned_file.clone() }
                ]),
            )
            .await
            .expect("cloneFile should succeed");

        assert_eq!(fs::read(renamed_file).expect("renamed file should exist"), vec![1, 2, 3]);
        assert_eq!(fs::read(copied_file).expect("copied file should exist"), vec![1, 2, 3]);
        assert_eq!(fs::read(cloned_file.clone()).expect("cloned file should exist"), vec![1, 2, 3]);

        router
            .dispatch_channel(
                "localFilesystem",
                "delete",
                &json!([{ "path": cloned_file }, { "recursive": false }]),
            )
            .await
            .expect("delete file should succeed");
        router
            .dispatch_channel(
                "localFilesystem",
                "delete",
                &json!([{ "path": repo_root.join("nested") }, { "recursive": true }]),
            )
            .await
            .expect("delete directory should succeed");
        assert!(!repo_root.join("nested").exists());
    }

    #[tokio::test]
    async fn local_filesystem_write_respects_offset_and_length_slice() {
        let repo_root = temp_repo_root("localfs-slice");
        let router = CapabilityRouter::new(repo_root.clone());
        let file_path = repo_root.join("slice.bin");

        let fd = router
            .dispatch_channel(
                "localFilesystem",
                "open",
                &json!([{ "path": file_path.clone() }, { "create": true }]),
            )
            .await
            .expect("open(create) should succeed")
            .as_u64()
            .expect("open should return numeric file descriptor");

        let bytes_written = router
            .dispatch_channel(
                "localFilesystem",
                "write",
                &json!([fd, 0, [10, 20, 30, 40], 1, 2]),
            )
            .await
            .expect("write should succeed")
            .as_u64()
            .expect("write should return number");
        assert_eq!(bytes_written, 2);

        router
            .dispatch_channel("localFilesystem", "close", &json!([fd]))
            .await
            .expect("close should succeed");
        assert_eq!(fs::read(file_path).expect("file should exist"), vec![20, 30]);
    }

    #[tokio::test]
    async fn local_filesystem_read_and_write_validate_required_args() {
        let repo_root = temp_repo_root("localfs-arg-validation");
        let router = CapabilityRouter::new(repo_root);

        let read_error = router
            .dispatch_channel("localFilesystem", "read", &json!([]))
            .await
            .expect_err("read without args should fail");
        assert!(read_error.contains("localFilesystem.read expected file descriptor argument"));

        let write_error = router
            .dispatch_channel("localFilesystem", "write", &json!([1, 0, { "bad": true }]))
            .await
            .expect_err("write with invalid data should fail");
        assert!(write_error.contains("localFilesystem.write expected byte content"));
    }

    #[tokio::test]
    async fn local_filesystem_watch_and_unwatch_validate_args() {
        let repo_root = temp_repo_root("localfs-watch-args");
        let router = CapabilityRouter::new(repo_root);

        let watch_error = router
            .dispatch_channel("localFilesystem", "watch", &json!([]))
            .await
            .expect_err("watch without session id should fail");
        assert!(watch_error.contains("localFilesystem.watch expected sessionId argument"));

        let unwatch_error = router
            .dispatch_channel("localFilesystem", "unwatch", &json!([]))
            .await
            .expect_err("unwatch without session id should fail");
        assert!(unwatch_error.contains("localFilesystem.unwatch expected sessionId argument"));
    }

    #[tokio::test]
    async fn storage_is_used_tracks_insert_delete_and_scope_updates() {
        let repo_root = temp_repo_root("storage-is-used");
        let router = CapabilityRouter::new(repo_root);

        router
            .dispatch_channel(
                "storage",
                "updateItems",
                &json!([{
                    "insert": [["alpha", "1"]]
                }]),
            )
            .await
            .expect("storage insert should succeed");
        let is_used_alpha = router
            .dispatch_channel("storage", "isUsed", &json!([{ "payload": "alpha" }]))
            .await
            .expect("storage isUsed should succeed");
        assert_eq!(is_used_alpha, json!(true));

        router
            .dispatch_channel(
                "storage",
                "updateItems",
                &json!([{
                    "delete": ["alpha"]
                }]),
            )
            .await
            .expect("storage delete should succeed");
        let is_used_after_delete = router
            .dispatch_channel("storage", "isUsed", &json!([{ "payload": "alpha" }]))
            .await
            .expect("storage isUsed should succeed");
        assert_eq!(is_used_after_delete, json!(false));

        router
            .dispatch_channel(
                "storage",
                "updateItems",
                &json!([{
                    "workspace": { "id": "workspace-storage" },
                    "insert": [["beta", "2"]]
                }]),
            )
            .await
            .expect("workspace storage insert should succeed");
        let is_used_workspace = router
            .dispatch_channel("storage", "isUsed", &json!([{ "payload": "beta" }]))
            .await
            .expect("storage isUsed should succeed");
        assert_eq!(is_used_workspace, json!(true));
    }

    #[tokio::test]
    async fn extension_host_starter_returns_stable_shapes() {
        let repo_root = temp_repo_root("extension-host-starter");
        let router = CapabilityRouter::new(repo_root);

        let host_a = router
            .dispatch_channel("extensionHostStarter", "createExtensionHost", &json!([]))
            .await
            .expect("createExtensionHost should succeed");
        let host_b = router
            .dispatch_channel("extensionHostStarter", "createExtensionHost", &json!([]))
            .await
            .expect("createExtensionHost should succeed");
        let id_a = host_a
            .get("id")
            .and_then(Value::as_str)
            .expect("host id should be present");
        let id_b = host_b
            .get("id")
            .and_then(Value::as_str)
            .expect("host id should be present");
        assert!(id_a.starts_with("tauri-extension-host-"));
        assert!(id_b.starts_with("tauri-extension-host-"));
        assert_ne!(id_a, id_b);

        let start = router
            .dispatch_channel("extensionHostStarter", "start", &json!([]))
            .await
            .expect("start should succeed");
        assert_eq!(start["pid"], json!(-1));

        let inspect = router
            .dispatch_channel("extensionHostStarter", "enableInspectPort", &json!([]))
            .await
            .expect("enableInspectPort should succeed");
        assert_eq!(inspect, json!(false));

        let kill = router
            .dispatch_channel("extensionHostStarter", "kill", &json!([]))
            .await
            .expect("kill should succeed");
        assert_eq!(kill, Value::Null);
    }

    #[tokio::test]
    async fn user_data_sync_store_management_has_stable_default_shape() {
        let repo_root = temp_repo_root("sync-store");
        let router = CapabilityRouter::new(repo_root.clone());

        let result = router
            .dispatch_channel(
                "userDataSyncStoreManagement",
                "getPreviousUserDataSyncStore",
                &json!([]),
            )
            .await
            .expect("getPreviousUserDataSyncStore should succeed");
        assert_eq!(result["type"], json!("stable"));
        assert_eq!(result["canSwitch"], json!(false));
        assert_eq!(result["authenticationProviders"], json!({}));
        assert_eq!(result["url"]["scheme"], json!("file"));
        let path = result
            .get("url")
            .and_then(extract_fs_path)
            .expect("url should contain file path");
        assert_eq!(path, repo_root.join(".vscode-tauri/user-data/sync"));
    }

    #[tokio::test]
    async fn user_data_profiles_update_profile_applies_name_fields() {
        let repo_root = temp_repo_root("profiles-update");
        let router = CapabilityRouter::new(repo_root);

        let created = router
            .dispatch_channel(
                "userDataProfiles",
                "createProfile",
                &json!(["dev", "Dev", { "transient": false }]),
            )
            .await
            .expect("createProfile should succeed");
        assert_eq!(created["id"], json!("dev"));

        let updated = router
            .dispatch_channel(
                "userDataProfiles",
                "updateProfile",
                &json!([
                    { "id": "dev" },
                    { "name": "Developer", "shortName": "DV" }
                ]),
            )
            .await
            .expect("updateProfile should succeed");
        assert_eq!(updated["name"], json!("Developer"));
        assert_eq!(updated["shortName"], json!("DV"));
    }

    #[tokio::test]
    async fn workspaces_delete_untitled_workspace_removes_workspace_file() {
        let repo_root = temp_repo_root("workspace-delete-untitled");
        let router = CapabilityRouter::new(repo_root.clone());

        let workspace = router
            .dispatch_channel("workspaces", "createUntitledWorkspace", &json!([]))
            .await
            .expect("createUntitledWorkspace should succeed");
        let config_path = workspace
            .get("configPath")
            .and_then(extract_fs_path)
            .expect("workspace should include configPath");
        assert!(config_path.exists());

        router
            .dispatch_channel(
                "workspaces",
                "deleteUntitledWorkspace",
                &json!([{ "path": config_path.clone() }]),
            )
            .await
            .expect("deleteUntitledWorkspace should succeed");
        assert!(!config_path.exists());
    }

    #[tokio::test]
    async fn webview_and_url_channels_return_stable_fallback_shapes() {
        let repo_root = temp_repo_root("webview-url");
        let router = CapabilityRouter::new(repo_root);

        let find_result = router
            .dispatch_channel("webview", "findInFrame", &json!([]))
            .await
            .expect("webview.findInFrame should succeed");
        assert_eq!(find_result, Value::Null);

        let stop_result = router
            .dispatch_channel("webview", "stopFindInFrame", &json!([]))
            .await
            .expect("webview.stopFindInFrame should succeed");
        assert_eq!(stop_result, Value::Null);

        let missing_url_result = router
            .dispatch_channel("url", "open", &json!([]))
            .await
            .expect("url.open without arg should succeed");
        assert_eq!(missing_url_result, json!(false));
    }

    #[test]
    fn default_by_method_name_returns_expected_defaults() {
        assert_eq!(default_by_method_name("isEnabled"), json!(false));
        assert_eq!(default_by_method_name("hasValue"), json!(false));
        assert_eq!(default_by_method_name("getValue"), Value::Null);
        assert_eq!(default_by_method_name("setValue"), Value::Null);
    }

    #[test]
    fn should_emit_fallback_event_matches_sampling_policy() {
        assert_eq!(should_emit_fallback_event(1), true);
        assert_eq!(should_emit_fallback_event(3), true);
        assert_eq!(should_emit_fallback_event(4), false);
        assert_eq!(should_emit_fallback_event(5), true);
        assert_eq!(should_emit_fallback_event(10), true);
        assert_eq!(should_emit_fallback_event(11), false);
        assert_eq!(should_emit_fallback_event(500), true);
    }

    #[test]
    fn storage_scope_key_prefers_workspace_then_profile_then_application() {
        let workspace_scope = storage_scope_key(Some(&json!({
            "workspace": { "id": "workspace-123" },
            "profile": { "id": "profile-123" }
        })));
        assert_eq!(workspace_scope, "workspace:workspace-123");

        let profile_scope = storage_scope_key(Some(&json!({
            "profile": { "id": "profile-123" }
        })));
        assert_eq!(profile_scope, "profile:profile-123");

        let application_scope = storage_scope_key(Some(&json!({})));
        assert_eq!(application_scope, "application:default");
    }

    #[test]
    fn workspace_identifier_from_value_normalizes_config_path() {
        let workspace = workspace_identifier_from_value(&json!({
            "id": "workspace-id",
            "configPath": "/tmp/my-workspace.code-workspace"
        }));
        assert_eq!(workspace["id"], json!("workspace-id"));
        assert_eq!(workspace["configPath"]["scheme"], json!("file"));
        assert_eq!(
            workspace["configPath"]["path"],
            json!("/tmp/my-workspace.code-workspace")
        );
    }

    #[test]
    fn extract_url_from_any_handles_structured_values() {
        let url = extract_url_from_any(&json!({
            "scheme": "https",
            "authority": "example.com",
            "path": "/resource",
            "query": "a=1",
            "fragment": "part"
        }));
        assert_eq!(url.as_deref(), Some("https://example.com/resource?a=1#part"));
    }

    #[test]
    fn remove_path_force_handles_missing_and_non_recursive_directory_failures() {
        let root = temp_repo_root("remove-path-force");
        let missing_path = root.join("missing");
        remove_path_force(&missing_path, false).expect("missing paths should be ignored");

        let non_empty_dir = root.join("non-empty");
        fs::create_dir_all(&non_empty_dir).expect("dir should be created");
        fs::write(non_empty_dir.join("file.txt"), b"x").expect("file should be created");
        let err = remove_path_force(&non_empty_dir, false).expect_err("non-recursive delete should fail for non-empty dir");
        assert_eq!(err.kind(), std::io::ErrorKind::DirectoryNotEmpty);

        remove_path_force(&non_empty_dir, true).expect("recursive delete should succeed");
        assert!(!non_empty_dir.exists());
    }

    #[test]
    fn copy_path_recursive_respects_overwrite_behavior() {
        let root = temp_repo_root("copy-path-recursive");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).expect("source dir should exist");
        fs::write(source.join("hello.txt"), b"hello").expect("source file should exist");

        copy_path_recursive(&source, &target, false).expect("initial copy should succeed");
        assert_eq!(
            fs::read(target.join("hello.txt")).expect("target file should exist"),
            b"hello"
        );

        let error = copy_path_recursive(&source, &target, false)
            .expect_err("copy without overwrite should fail if target exists");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);

        fs::write(source.join("hello.txt"), b"updated").expect("source file should update");
        copy_path_recursive(&source, &target, true).expect("copy with overwrite should succeed");
        assert_eq!(
            fs::read(target.join("hello.txt")).expect("target file should exist"),
            b"updated"
        );
    }

    #[tokio::test]
    async fn local_filesystem_copy_without_overwrite_fails_when_target_exists() {
        let repo_root = temp_repo_root("localfs-copy-overwrite");
        let router = CapabilityRouter::new(repo_root.clone());
        let source = repo_root.join("source.txt");
        let target = repo_root.join("target.txt");
        fs::write(&source, b"source").expect("source should exist");
        fs::write(&target, b"target").expect("target should exist");

        let error = router
            .dispatch_channel(
                "localFilesystem",
                "copy",
                &json!([
                    { "path": source },
                    { "path": target },
                    { "overwrite": false }
                ]),
            )
            .await
            .expect_err("copy without overwrite should fail");
        assert!(error.contains("already exists"));
    }

    #[tokio::test]
    async fn local_filesystem_rename_with_overwrite_replaces_target_contents() {
        let repo_root = temp_repo_root("localfs-rename-overwrite");
        let router = CapabilityRouter::new(repo_root.clone());
        let source = repo_root.join("source.txt");
        let target = repo_root.join("target.txt");
        fs::write(&source, b"new").expect("source should exist");
        fs::write(&target, b"old").expect("target should exist");

        router
            .dispatch_channel(
                "localFilesystem",
                "rename",
                &json!([
                    { "path": source.clone() },
                    { "path": target.clone() },
                    { "overwrite": true }
                ]),
            )
            .await
            .expect("rename with overwrite should succeed");

        assert!(!source.exists());
        assert_eq!(fs::read(target).expect("target should exist"), b"new");
    }

    #[tokio::test]
    async fn workspaces_identifier_and_enter_workspace_normalize_paths() {
        let repo_root = temp_repo_root("workspaces-identifiers");
        let router = CapabilityRouter::new(repo_root.clone());
        let config_path = repo_root.join("project.code-workspace");
        fs::write(&config_path, "{}").expect("workspace config should exist");

        let identifier = router
            .dispatch_channel(
                "workspaces",
                "getWorkspaceIdentifier",
                &json!([{ "path": config_path.clone() }]),
            )
            .await
            .expect("getWorkspaceIdentifier should succeed");
        assert_eq!(identifier["configPath"]["scheme"], json!("file"));

        let entered = router
            .dispatch_channel(
                "workspaces",
                "enterWorkspace",
                &json!([{ "path": config_path }]),
            )
            .await
            .expect("enterWorkspace should succeed");
        assert_eq!(entered["workspace"]["configPath"]["scheme"], json!("file"));
    }

    #[tokio::test]
    async fn user_data_profiles_set_profile_for_workspace_ignores_unknown_profile() {
        let repo_root = temp_repo_root("profiles-unknown-map");
        let router = CapabilityRouter::new(repo_root);

        router
            .dispatch_channel(
                "userDataProfiles",
                "setProfileForWorkspace",
                &json!([{ "id": "workspace-z" }, "profile-missing"]),
            )
            .await
            .expect("setProfileForWorkspace should succeed");

        let state = router
            .user_data_profiles_state
            .lock()
            .expect("user profile state should lock");
        assert!(state.workspace_profiles.get("workspace-z").is_none());
    }

    #[tokio::test]
    async fn user_data_profiles_cleanup_removes_stale_workspace_mappings() {
        let repo_root = temp_repo_root("profiles-cleanup");
        let router = CapabilityRouter::new(repo_root);

        {
            let mut state = router
                .user_data_profiles_state
                .lock()
                .expect("user profile state should lock");
            state
                .workspace_profiles
                .insert("workspace-a".to_string(), "missing-profile".to_string());
        }

        router
            .dispatch_channel("userDataProfiles", "cleanUp", &json!([]))
            .await
            .expect("cleanUp should succeed");

        let state = router
            .user_data_profiles_state
            .lock()
            .expect("user profile state should lock");
        assert!(state.workspace_profiles.is_empty());
    }

    #[tokio::test]
    async fn sync_related_channels_return_stable_payload_shapes() {
        let repo_root = temp_repo_root("sync-related");
        let router = CapabilityRouter::new(repo_root);

        let account_initial = router
            .dispatch_channel("userDataSyncAccount", "_getInitialData", &json!([]))
            .await
            .expect("userDataSyncAccount._getInitialData should succeed");
        assert_eq!(account_initial, Value::Null);

        let machines = router
            .dispatch_channel("userDataSyncMachines", "getMachines", &json!([]))
            .await
            .expect("userDataSyncMachines.getMachines should succeed");
        assert_eq!(machines, json!([]));

        let initial_sync_data = router
            .dispatch_channel("userDataSync", "_getInitialData", &json!([]))
            .await
            .expect("userDataSync._getInitialData should succeed");
        assert_eq!(initial_sync_data, json!(["uninitialized", [], Value::Null]));
    }

    #[tokio::test]
    async fn dispatch_channel_for_unknown_domain_uses_default_result_shape() {
        let repo_root = temp_repo_root("unknown-channel-default");
        let router = CapabilityRouter::new(repo_root);

        let unknown_get = router
            .dispatch_channel("unknownChannel", "getSomething", &json!([]))
            .await
            .expect("unknown get should succeed");
        assert_eq!(unknown_get, Value::Null);

        let unknown_is = router
            .dispatch_channel("unknownChannel", "isSomething", &json!([]))
            .await
            .expect("unknown is should succeed");
        assert_eq!(unknown_is, json!(false));
    }

    #[tokio::test]
    async fn fallback_counts_record_channel_calls() {
        let repo_root = temp_repo_root("fallback");
        let router = CapabilityRouter::new(repo_root.clone());

        router
            .dispatch_channel("logger", "log", &json!([{"message": "hello"}]))
            .await
            .expect("channel call should succeed");

        let counts = router.fallback_counts();
        assert_eq!(counts.get("channel:logger:log"), Some(&1));

        let metrics_path = repo_root.join("apps/tauri/logs/fallback-metrics.json");
        let metrics = fs::read_to_string(metrics_path).expect("fallback metrics should be written");
        assert!(metrics.contains("channel:logger:log"));
    }

    #[tokio::test]
    async fn storage_channel_is_stateful() {
        let repo_root = temp_repo_root("storage");
        let router = CapabilityRouter::new(repo_root);

        router
            .dispatch_channel(
                "storage",
                "updateItems",
                &json!([{
                    "insert": [
                        ["alpha", "1"],
                        ["beta", "2"]
                    ]
                }]),
            )
            .await
            .expect("storage updateItems should succeed");

        let items = router
            .dispatch_channel("storage", "getItems", &json!([{}]))
            .await
            .expect("storage getItems should succeed")
            .as_array()
            .cloned()
            .expect("storage getItems should return array");
        assert!(items.contains(&json!(["alpha", "1"])));
        assert!(items.contains(&json!(["beta", "2"])));
    }

    #[tokio::test]
    async fn workspaces_and_local_pty_use_repo_backed_state() {
        let repo_root = temp_repo_root("workspace-pty");
        let router = CapabilityRouter::new(repo_root.clone());

        let workspace = router
            .dispatch_channel("workspaces", "createUntitledWorkspace", &json!([]))
            .await
            .expect("createUntitledWorkspace should succeed");
        let config_path_value = workspace
            .get("configPath")
            .expect("workspace should include configPath");
        let config_path =
            extract_fs_path(config_path_value).expect("configPath should be a file URI/path");
        assert!(config_path.starts_with(repo_root.join(".vscode-tauri/user-data/Workspaces")));

        let expected_layout = json!({
            "workspaceId": "workspace-a",
            "tabs": [],
            "background": null
        });
        router
            .dispatch_channel(
                "localPty",
                "setTerminalLayoutInfo",
                &json!([expected_layout]),
            )
            .await
            .expect("setTerminalLayoutInfo should succeed");
        let loaded_layout = router
            .dispatch_channel(
                "localPty",
                "getTerminalLayoutInfo",
                &json!([{ "workspaceId": "workspace-a" }]),
            )
            .await
            .expect("getTerminalLayoutInfo should succeed");
        assert_eq!(loaded_layout["workspaceId"], json!("workspace-a"));
    }
}
