use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

#[async_trait]
pub trait WindowCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryWindowCapability;

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

pub fn app_handle() -> Option<AppHandle> {
    APP_HANDLE.get().cloned()
}

#[async_trait]
impl WindowCapability for RustPrimaryWindowCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "window.open" => {
                let target = parse_window_label(params);
                let window = match get_window(target) {
                    Ok(window) => window,
                    Err(error) => {
                        if target == "main" {
                            return Err(error);
                        }
                        return Ok(Some(json!({
                            "target": target,
                            "opened": false,
                            "existing": false,
                            "reason": error
                        })));
                    }
                };
                window
                    .show()
                    .map_err(|error| format!("failed to show window '{target}': {error}"))?;
                window
                    .set_focus()
                    .map_err(|error| format!("failed to focus window '{target}': {error}"))?;

                Ok(Some(json!({
                    "target": target,
                    "opened": true,
                    "existing": true
                })))
            }
            "window.close" => {
                let target = parse_window_label(params);
                let window = get_window(target)?;
                window
                    .close()
                    .map_err(|error| format!("failed to close window '{target}': {error}"))?;
                Ok(Some(json!({
                    "target": target,
                    "closed": true
                })))
            }
            "window.focus" => {
                let target = parse_window_label(params);
                let window = get_window(target)?;
                window
                    .show()
                    .map_err(|error| format!("failed to show window '{target}': {error}"))?;
                window
                    .set_focus()
                    .map_err(|error| format!("failed to focus window '{target}': {error}"))?;
                Ok(Some(json!({
                    "target": target,
                    "focused": true
                })))
            }
            "window.setFullscreen" => {
                let target = parse_window_label(params);
                let enabled = parse_required_bool(params, "enabled")?;
                let window = get_window(target)?;
                window.set_fullscreen(enabled).map_err(|error| {
                    format!("failed to set fullscreen={enabled} for window '{target}': {error}")
                })?;

                Ok(Some(json!({
                    "target": target,
                    "fullscreen": enabled
                })))
            }
            "window.getState" => {
                let target = parse_window_label(params);
                let window = get_window(target)?;
                let focused = window
                    .is_focused()
                    .map_err(|error| format!("failed to read focus state: {error}"))?;
                let fullscreen = window
                    .is_fullscreen()
                    .map_err(|error| format!("failed to read fullscreen state: {error}"))?;

                Ok(Some(json!({
                    "target": target,
                    "focused": focused,
                    "fullscreen": fullscreen,
                    "platform": std::env::consts::OS
                })))
            }
            _ => Ok(None),
        }
    }
}

fn get_window(label: &str) -> Result<tauri::WebviewWindow, String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "tauri app handle not initialized".to_string())?;
    app.get_webview_window(label)
        .ok_or_else(|| format!("window '{label}' not found"))
}

fn parse_window_label(params: &Value) -> &str {
    params
        .as_object()
        .and_then(|object| object.get("target").or_else(|| object.get("label")))
        .and_then(Value::as_str)
        .unwrap_or("main")
}

fn parse_required_bool(params: &Value, key: &str) -> Result<bool, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "params must be an object".to_string())?;
    object
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("missing boolean param '{key}'"))
}
