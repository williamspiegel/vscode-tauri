use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

#[async_trait]
pub trait OsCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryOsCapability;

#[async_trait]
impl OsCapability for RustPrimaryOsCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "os.systemInfo" => Ok(Some(json!({
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "family": std::env::consts::FAMILY
            }))),
            "os.openExternal" => {
                let url = parse_required_string(params, "url")?;
                open_external(url)?;
                Ok(Some(json!({
                    "url": url,
                    "opened": true
                })))
            }
            "os.showItemInFolder" => {
                let raw_path = parse_required_string(params, "path")?;
                let path = PathBuf::from(raw_path);
                show_item_in_folder(&path)?;
                Ok(Some(json!({
                    "path": path,
                    "shown": true
                })))
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

fn open_external(url: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).status()
    } else {
        Command::new("xdg-open").arg(url).status()
    }
    .map_err(|error| format!("os.openExternal failed for '{url}': {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "os.openExternal failed for '{url}' with status {status}"
        ))
    }
}

fn show_item_in_folder(path: &Path) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        if path.is_file() {
            Command::new("open").arg("-R").arg(path).status()
        } else {
            Command::new("open").arg(path).status()
        }
    } else if cfg!(target_os = "windows") {
        if path.is_file() {
            Command::new("explorer")
                .arg(format!("/select,{}", path.display()))
                .status()
        } else {
            Command::new("explorer").arg(path).status()
        }
    } else {
        let open_target = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        Command::new("xdg-open").arg(open_target).status()
    }
    .map_err(|error| {
        format!(
            "os.showItemInFolder failed for '{}': {error}",
            path.display()
        )
    })?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "os.showItemInFolder failed for '{}' with status {status}",
            path.display()
        ))
    }
}
