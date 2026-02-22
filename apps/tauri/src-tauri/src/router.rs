use crate::capabilities::clipboard::{ClipboardCapability, RustPrimaryClipboardCapability};
use crate::capabilities::dialogs::{DialogsCapability, RustPrimaryDialogsCapability};
use crate::capabilities::filesystem::{FilesystemCapability, RustPrimaryFilesystemCapability};
use crate::capabilities::os::{OsCapability, RustPrimaryOsCapability};
use crate::capabilities::power::{PowerCapability, RustPrimaryPowerCapability};
use crate::capabilities::process::{ProcessCapability, RustPrimaryProcessCapability};
use crate::capabilities::terminal::{RustPrimaryTerminalCapability, TerminalCapability};
use crate::capabilities::update::{RustPrimaryUpdateCapability, UpdateCapability};
use crate::capabilities::window::{RustPrimaryWindowCapability, WindowCapability};
use crate::node_fallback::NodeFallbackClient;
use crate::protocol::CapabilityDomain;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
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
    fallback: NodeFallbackClient,
}

impl CapabilityRouter {
    pub fn new(fallback_script: PathBuf) -> Self {
        let metrics = crate::metrics::FallbackMetrics::default();
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
            fallback: NodeFallbackClient::new(fallback_script, metrics),
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

        let fallback_result = self
            .fallback
            .invoke_capability(domain, method, params)
            .await?;
        let metric_key = format!("capability:{}:{method}", domain.as_str());
        let fallback_count = self
            .fallback
            .metrics()
            .snapshot()
            .get(&metric_key)
            .copied()
            .unwrap_or(0);
        if let Some(app_handle) = crate::capabilities::window::app_handle() {
            let _ = app_handle.emit(
                "fallback.used",
                json!({
                    "domain": domain.as_str(),
                    "method": method,
                    "count": fallback_count
                }),
            );
        }

        Ok(fallback_result)
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

        let fallback_result = self.fallback.invoke_channel(channel, method, args).await?;
        let metric_key = format!("channel:{channel}:{method}");
        let fallback_count = self
            .fallback
            .metrics()
            .snapshot()
            .get(&metric_key)
            .copied()
            .unwrap_or(0);
        if let Some(app_handle) = crate::capabilities::window::app_handle() {
            let _ = app_handle.emit(
                "fallback.used",
                json!({
                    "domain": format!("channel:{channel}"),
                    "method": method,
                    "count": fallback_count
                }),
            );
        }

        Ok(fallback_result)
    }

    async fn dispatch_channel_rust_primary(
        &self,
        channel: &str,
        method: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        let arg0 = first_arg(args);

        match channel {
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
                        "buffer": bytes,
                        "base64": base64_encode_bytes(&bytes)
                    })))
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
                _ => Ok(None),
            },
            "nativeHost" => match method {
                "notifyReady" => Ok(Some(Value::Null)),
                "focusWindow" => {
                    self.window
                        .invoke("window.focus", &json!({ "target": "main" }))
                        .await?;
                    Ok(Some(Value::Null))
                }
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
                "writeClipboardText" => {
                    if let Some(text) = extract_string_arg(arg0) {
                        self.clipboard
                            .invoke("clipboard.writeText", &json!({ "text": text }))
                            .await?;
                    }
                    Ok(Some(Value::Null))
                }
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
        self.fallback.metrics().snapshot()
    }
}

fn first_arg(args: &Value) -> Option<&Value> {
    args.as_array().and_then(|items| items.first())
}

fn nth_arg(args: &Value, index: usize) -> Option<&Value> {
    args.as_array().and_then(|items| items.get(index))
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
