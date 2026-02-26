use async_trait::async_trait;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[async_trait]
pub trait ClipboardCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryClipboardCapability;

#[async_trait]
impl ClipboardCapability for RustPrimaryClipboardCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "clipboard.readText" => match read_clipboard_text() {
                Ok(text) => Ok(Some(json!({
                    "text": text,
                    "handledBy": "rust-primary"
                }))),
                Err(_) => Ok(None),
            },
            "clipboard.writeText" => {
                let text = parse_required_string(params, "text")?;
                match write_clipboard_text(text) {
                    Ok(()) => Ok(Some(json!({
                        "written": true,
                        "length": text.chars().count(),
                        "handledBy": "rust-primary"
                    }))),
                    Err(_) => Ok(None),
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

fn read_clipboard_text() -> Result<String, String> {
    let output =
        if cfg!(target_os = "macos") {
            Command::new("pbpaste").output()
        } else if cfg!(target_os = "windows") {
            Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"])
                .output()
        } else {
            Command::new("sh")
			.args(["-c", "wl-paste --no-newline 2>/dev/null || xclip -selection clipboard -o 2>/dev/null"])
			.output()
        }
        .map_err(|error| format!("clipboard.readText command failed: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format!(
            "clipboard.readText command exited with status {}",
            output.status
        ))
    }
}

fn write_clipboard_text(text: &str) -> Result<(), String> {
    let mut child = if cfg!(target_os = "macos") {
        Command::new("pbcopy").stdin(Stdio::piped()).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", "clip"])
            .stdin(Stdio::piped())
            .spawn()
    } else {
        Command::new("sh")
            .args(["-c", "wl-copy 2>/dev/null || xclip -selection clipboard"])
            .stdin(Stdio::piped())
            .spawn()
    }
    .map_err(|error| format!("clipboard.writeText command failed: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("clipboard.writeText stdin write failed: {error}"))?;
    }

    let status = child
        .wait()
        .map_err(|error| format!("clipboard.writeText wait failed: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "clipboard.writeText command exited with status {status}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_method_returns_none() {
        let capability = RustPrimaryClipboardCapability;
        let result = capability
            .invoke("clipboard.notImplemented", &json!({}))
            .await
            .expect("unknown method should not error");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn write_text_requires_text_param() {
        let capability = RustPrimaryClipboardCapability;
        let error = capability
            .invoke("clipboard.writeText", &json!({}))
            .await
            .expect_err("missing text param should return an error");
        assert!(error.contains("missing string param 'text'"));
    }

    #[tokio::test]
    async fn write_text_requires_object_params() {
        let capability = RustPrimaryClipboardCapability;
        let error = capability
            .invoke("clipboard.writeText", &json!("invalid"))
            .await
            .expect_err("non-object params should return an error");
        assert!(error.contains("params must be an object"));
    }
}
