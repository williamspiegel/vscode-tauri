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
use std::path::PathBuf;
use std::sync::Arc;
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

        let fallback_result = self.fallback.invoke(domain, method, params).await?;
        let metric_key = format!("{}:{method}", domain.as_str());
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

    pub fn fallback_counts(&self) -> std::collections::BTreeMap<String, u64> {
        self.fallback.metrics().snapshot()
    }
}
