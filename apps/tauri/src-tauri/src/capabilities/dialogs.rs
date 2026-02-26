use async_trait::async_trait;
use serde_json::{json, Value};
use std::process::Command;

#[async_trait]
pub trait DialogsCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryDialogsCapability;

#[async_trait]
impl DialogsCapability for RustPrimaryDialogsCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        if !cfg!(target_os = "macos") {
            return match method {
                "dialogs.showMessage" => {
                    let message = params
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("VS Code");
                    let title = params
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("VS Code Tauri");
                    let buttons = parse_string_array(params.get("buttons"))?;
                    let effective_buttons = if buttons.is_empty() {
                        vec!["OK".to_string()]
                    } else {
                        buttons
                    };
                    Ok(Some(json!({
                        "title": title,
                        "message": message,
                        "buttons": effective_buttons,
                        "selectedIndex": 0,
                        "interactive": false,
                        "handledBy": "rust-primary-non-macos"
                    })))
                }
                "dialogs.openFile" | "dialogs.openFolder" | "dialogs.saveFile" => Ok(Some(json!({
                    "path": Value::Null,
                    "canceled": true,
                    "reason": "native dialog picker is currently implemented for macOS only",
                    "handledBy": "rust-primary-non-macos"
                }))),
                _ => Ok(None),
            };
        }

        match method {
            "dialogs.showMessage" => {
                let message = parse_required_string(params, "message")?;
                let title = params
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("VS Code Tauri");
                let severity = params
                    .get("severity")
                    .and_then(Value::as_str)
                    .unwrap_or("info");
                let buttons = parse_string_array(params.get("buttons"))?;
                let selected_index = params
                    .get("defaultButton")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let effective_buttons = if buttons.is_empty() {
                    vec!["OK".to_string()]
                } else {
                    buttons
                };
                let clamped_index = selected_index.min(effective_buttons.len().saturating_sub(1));
                let default_label = effective_buttons[clamped_index].clone();
                let icon = match severity {
                    "error" => "stop",
                    "warning" => "caution",
                    _ => "note",
                };
                let button_list = format!(
                    "{{{}}}",
                    effective_buttons
                        .iter()
                        .map(|button| format!("\"{}\"", escape_apple_script_string(button)))
                        .collect::<Vec<String>>()
                        .join(", ")
                );

                let script = vec![
					format!(
						"set __result to display dialog \"{}\" with title \"{}\" buttons {} default button \"{}\" with icon {}",
						escape_apple_script_string(message),
						escape_apple_script_string(title),
						button_list,
						escape_apple_script_string(&default_label),
						icon
					),
					"return button returned of __result".to_string(),
				];

                match run_osascript(&script) {
                    Ok(selected_label) => {
                        let selected = effective_buttons
                            .iter()
                            .position(|candidate| candidate == &selected_label)
                            .unwrap_or(clamped_index);
                        Ok(Some(json!({
                            "title": title,
                            "message": message,
                            "severity": severity,
                            "buttons": effective_buttons,
                            "selectedIndex": selected,
                            "selectedLabel": selected_label,
                            "interactive": true,
                            "handledBy": "rust-primary"
                        })))
                    }
                    Err(AppleScriptInvocationError::Canceled) => Ok(Some(json!({
                        "title": title,
                        "message": message,
                        "severity": severity,
                        "buttons": effective_buttons,
                        "canceled": true,
                        "interactive": true,
                        "handledBy": "rust-primary"
                    }))),
                    Err(AppleScriptInvocationError::Failed(error)) => {
                        Err(format!("dialogs.showMessage failed: {error}"))
                    }
                }
            }
            "dialogs.openFile" => {
                let prompt = params
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("Select a file");
                let script = vec![format!(
                    "POSIX path of (choose file with prompt \"{}\")",
                    escape_apple_script_string(prompt)
                )];
                match run_osascript(&script) {
                    Ok(path) => Ok(Some(json!({
                        "path": path,
                        "canceled": false,
                        "handledBy": "rust-primary"
                    }))),
                    Err(AppleScriptInvocationError::Canceled) => Ok(Some(json!({
                        "path": Value::Null,
                        "canceled": true,
                        "handledBy": "rust-primary"
                    }))),
                    Err(AppleScriptInvocationError::Failed(error)) => {
                        Err(format!("dialogs.openFile failed: {error}"))
                    }
                }
            }
            "dialogs.openFolder" => {
                let prompt = params
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("Select a folder");
                let script = vec![format!(
                    "POSIX path of (choose folder with prompt \"{}\")",
                    escape_apple_script_string(prompt)
                )];
                match run_osascript(&script) {
                    Ok(path) => Ok(Some(json!({
                        "path": path,
                        "canceled": false,
                        "handledBy": "rust-primary"
                    }))),
                    Err(AppleScriptInvocationError::Canceled) => Ok(Some(json!({
                        "path": Value::Null,
                        "canceled": true,
                        "handledBy": "rust-primary"
                    }))),
                    Err(AppleScriptInvocationError::Failed(error)) => {
                        Err(format!("dialogs.openFolder failed: {error}"))
                    }
                }
            }
            "dialogs.saveFile" => {
                let prompt = params
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("Choose save location");
                let default_name = params
                    .get("defaultName")
                    .and_then(Value::as_str)
                    .unwrap_or("untitled.txt");
                let script = vec![format!(
                    "POSIX path of (choose file name with prompt \"{}\" default name \"{}\")",
                    escape_apple_script_string(prompt),
                    escape_apple_script_string(default_name)
                )];
                match run_osascript(&script) {
                    Ok(path) => Ok(Some(json!({
                        "path": path,
                        "canceled": false,
                        "handledBy": "rust-primary"
                    }))),
                    Err(AppleScriptInvocationError::Canceled) => Ok(Some(json!({
                        "path": Value::Null,
                        "canceled": true,
                        "handledBy": "rust-primary"
                    }))),
                    Err(AppleScriptInvocationError::Failed(error)) => {
                        Err(format!("dialogs.saveFile failed: {error}"))
                    }
                }
            }
            _ => Ok(None),
        }
    }
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

fn parse_string_array(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(array) = value.as_array() else {
        return Err("buttons must be an array of strings".to_string());
    };

    array
        .iter()
        .map(|item| {
            item.as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "buttons must contain only strings".to_string())
        })
        .collect()
}

#[derive(Debug)]
enum AppleScriptInvocationError {
    Canceled,
    Failed(String),
}

fn run_osascript(lines: &[String]) -> Result<String, AppleScriptInvocationError> {
    let mut command = Command::new("osascript");
    for line in lines {
        command.arg("-e").arg(line);
    }

    let output = command
        .output()
        .map_err(|error| AppleScriptInvocationError::Failed(error.to_string()))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("(-128)") {
        return Err(AppleScriptInvocationError::Canceled);
    }

    Err(AppleScriptInvocationError::Failed(stderr))
}

fn escape_apple_script_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_method_returns_none() {
        let capability = RustPrimaryDialogsCapability;
        let result = capability
            .invoke("dialogs.notImplemented", &json!({}))
            .await
            .expect("unknown method should not error");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn show_message_has_stable_shape() {
        let capability = RustPrimaryDialogsCapability;

        #[cfg(target_os = "macos")]
        {
            let error = capability
                .invoke("dialogs.showMessage", &json!({}))
                .await
                .expect_err("macOS path requires explicit message");
            assert!(error.contains("missing string param 'message'"));
        }

        #[cfg(not(target_os = "macos"))]
        {
            let result = capability
                .invoke("dialogs.showMessage", &json!({}))
                .await
                .expect("non-macOS path should not error")
                .expect("non-macOS path should return a payload");
            assert_eq!(result["selectedIndex"], json!(0));
            assert_eq!(result["handledBy"], json!("rust-primary-non-macos"));
        }
    }

    #[tokio::test]
    async fn show_message_rejects_non_string_buttons() {
        let capability = RustPrimaryDialogsCapability;
        let error = capability
            .invoke(
                "dialogs.showMessage",
                &json!({
                    "message": "hello",
                    "buttons": ["ok", 1]
                }),
            )
            .await
            .expect_err("non-string buttons should fail validation");
        assert!(error.contains("buttons must contain only strings"));
    }
}
