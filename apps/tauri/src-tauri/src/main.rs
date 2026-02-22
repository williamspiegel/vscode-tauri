#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capabilities;
mod metrics;
mod node_fallback;
mod protocol;
mod router;

use protocol::{error_response, ok_response, HandshakeRequest, HandshakeResponse, JsonRpcRequest, PROTOCOL_VERSION};
use router::CapabilityRouter;
use serde_json::{json, Value};
use std::path::PathBuf;
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
        return Ok(error_response(request.id, -32600, "Invalid jsonrpc version"));
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
                    handshake.protocol_version,
                    PROTOCOL_VERSION
                ),
            ));
        }

        let response = HandshakeResponse {
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_name: "vscode-tauri-host".to_string(),
            server_version: "0.1.0".to_string(),
            supported_capabilities: vec![
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

    match state.router.dispatch(&request.method, &request.params).await {
        Ok(result) => Ok(ok_response(request.id, result)),
        Err(error) => Ok(error_response(request.id, 1003, error)),
    }
}

#[tauri::command]
fn fallback_counts(state: State<'_, AppState>) -> Value {
    json!(state.router.fallback_counts())
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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("host.lifecycle", json!({ "event": "setup" }));
            }
            Ok(())
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![host_invoke, fallback_counts])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
