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
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{Emitter, Manager, State};

struct AppState {
    router: CapabilityRouter,
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

    match state
        .router
        .dispatch(&request.method, &request.params)
        .await
    {
        Ok(result) => Ok(ok_response(request.id, result)),
        Err(error) => Ok(error_response(request.id, 1003, error)),
    }
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

    let bytes = fs::read(manifest_path)
        .map_err(|error| format!("Failed to read CSS module manifest {}: {error}", manifest_path.display()))?;
    let modules = serde_json::from_slice::<Vec<String>>(&bytes)
        .map_err(|error| format!("Failed to parse CSS module manifest {}: {error}", manifest_path.display()))?;

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
    let app_state = AppState {
        router: CapabilityRouter::new(fallback_script),
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
