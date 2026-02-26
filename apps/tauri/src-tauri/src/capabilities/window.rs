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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_main_errors_when_app_handle_is_missing() {
        let capability = RustPrimaryWindowCapability;
        let error = capability
            .invoke("window.open", &json!({ "target": "main" }))
            .await
            .expect_err("main window open should fail without app handle");
        assert!(error.contains("tauri app handle not initialized"));
    }

    #[tokio::test]
    async fn open_non_main_returns_non_fatal_payload_when_app_handle_is_missing() {
        let capability = RustPrimaryWindowCapability;
        let result = capability
            .invoke("window.open", &json!({ "target": "settings" }))
            .await
            .expect("non-main window open should not fail")
            .expect("non-main window open should return payload");
        assert_eq!(result["target"], json!("settings"));
        assert_eq!(result["opened"], json!(false));
        assert_eq!(result["existing"], json!(false));
        assert_eq!(result["reason"], json!("tauri app handle not initialized"));
    }

    #[tokio::test]
    async fn set_fullscreen_requires_enabled_param() {
        let capability = RustPrimaryWindowCapability;
        let error = capability
            .invoke("window.setFullscreen", &json!({}))
            .await
            .expect_err("missing enabled should return an error");
        assert!(error.contains("missing boolean param 'enabled'"));
    }

    #[tokio::test]
    async fn get_state_errors_when_app_handle_is_missing() {
        let capability = RustPrimaryWindowCapability;
        let error = capability
            .invoke("window.getState", &json!({}))
            .await
            .expect_err("window.getState should fail without app handle");
        assert!(error.contains("tauri app handle not initialized"));
    }

    #[tokio::test]
    async fn focus_errors_when_app_handle_is_missing() {
        let capability = RustPrimaryWindowCapability;
        let error = capability
            .invoke("window.focus", &json!({}))
            .await
            .expect_err("window.focus should fail without app handle");
        assert!(error.contains("tauri app handle not initialized"));
    }

    #[tokio::test]
    async fn close_errors_when_app_handle_is_missing() {
        let capability = RustPrimaryWindowCapability;
        let error = capability
            .invoke("window.close", &json!({}))
            .await
            .expect_err("window.close should fail without app handle");
        assert!(error.contains("tauri app handle not initialized"));
    }

    #[tokio::test]
    async fn open_honors_label_alias_for_non_main_targets() {
        let capability = RustPrimaryWindowCapability;
        let result = capability
            .invoke("window.open", &json!({ "label": "extensions" }))
            .await
            .expect("non-main window open should not fail")
            .expect("non-main window open should return payload");
        assert_eq!(result["target"], json!("extensions"));
        assert_eq!(result["opened"], json!(false));
        assert_eq!(result["existing"], json!(false));
    }

    #[tokio::test]
    async fn unknown_method_returns_none() {
        let capability = RustPrimaryWindowCapability;
        let result = capability
            .invoke("window.notImplemented", &json!({}))
            .await
            .expect("unknown method should not fail");
        assert!(result.is_none());
    }
}
