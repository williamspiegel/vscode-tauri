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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{Emitter, Manager, State};

struct ChannelSubscription {
    _channel: String,
    _event: String,
    _arg: Value,
}

struct AppState {
    router: CapabilityRouter,
    repo_root: PathBuf,
    subscriptions: Mutex<HashMap<String, ChannelSubscription>>,
    next_subscription_id: AtomicU64,
    cached_window_config: Mutex<Option<Value>>,
}

impl AppState {
    fn register_subscription(
        &self,
        channel: String,
        event: String,
        arg: Value,
    ) -> Result<String, String> {
        let id = format!(
            "sub-{}",
            self.next_subscription_id.fetch_add(1, Ordering::Relaxed)
        );

        let mut guard = self
            .subscriptions
            .lock()
            .map_err(|_| "subscription state lock poisoned".to_string())?;
        guard.insert(
            id.clone(),
            ChannelSubscription {
                _channel: channel,
                _event: event,
                _arg: arg,
            },
        );

        Ok(id)
    }

    fn remove_subscription(&self, id: &str) -> Result<bool, String> {
        let mut guard = self
            .subscriptions
            .lock()
            .map_err(|_| "subscription state lock poisoned".to_string())?;
        Ok(guard.remove(id).is_some())
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
        return Ok(ok_response(request.id, json!(state.router.fallback_counts())));
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

        return match state.router.dispatch_channel(&channel, &method, &args).await {
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

        return match state.register_subscription(channel, event, arg) {
            Ok(subscription_id) => {
                Ok(ok_response(request.id, json!({ "subscriptionId": subscription_id })))
            }
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

        return match state.remove_subscription(&subscription_id) {
            Ok(removed) => Ok(ok_response(request.id, json!({ "removed": removed }))),
            Err(error) => Ok(error_response(request.id, -32603, error)),
        };
    }

    match state.router.dispatch(&request.method, &request.params).await {
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

fn read_nls_messages(repo_root: &Path) -> Result<Vec<String>, String> {
    let path = repo_root.join("out/nls.messages.json");
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_slice::<Vec<String>>(&bytes)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
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

fn main() {
    let fallback_script = PathBuf::from("../node/fallback.mjs");
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()),
    );
    let repo_root = manifest_dir
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| manifest_dir.join("../../.."));

    let app_state = AppState {
        router: CapabilityRouter::new(fallback_script),
        repo_root,
        subscriptions: Mutex::new(HashMap::new()),
        next_subscription_id: AtomicU64::new(1),
        cached_window_config: Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.show();
            }
        }))
        .setup(|app| {
            capabilities::window::set_app_handle(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("host.lifecycle", json!({ "event": "setup" }));
            }
            Ok(())
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![host_invoke])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
