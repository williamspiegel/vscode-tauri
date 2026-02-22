use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[async_trait]
pub trait UpdateCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryUpdateCapability {
    state: Mutex<UpdateState>,
}

#[derive(Debug, Clone, Default)]
struct UpdateState {
    last_channel: String,
    last_check_ms: Option<u64>,
    downloaded_version: Option<String>,
    downloaded_at_ms: Option<u64>,
    install_scheduled_version: Option<String>,
    install_scheduled_at_ms: Option<u64>,
}

impl RustPrimaryUpdateCapability {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(UpdateState::default()),
        }
    }
}

#[async_trait]
impl UpdateCapability for RustPrimaryUpdateCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "update.check" => {
                let channel = params
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    .to_string();
                let now = epoch_millis();

                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "update state lock poisoned".to_string())?;
                state.last_channel = channel.clone();
                state.last_check_ms = Some(now);

                Ok(Some(json!({
                    "checked": true,
                    "available": false,
                    "channel": channel,
                    "checkedAtMs": now,
                    "supportsNativeUpdater": false,
                    "reason": "rust-primary update feed not configured yet",
                    "handledBy": "rust-primary"
                })))
            }
            "update.download" => {
                let requested_version = params
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let now = epoch_millis();

                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "update state lock poisoned".to_string())?;
                state.downloaded_version = Some(requested_version.clone());
                state.downloaded_at_ms = Some(now);

                Ok(Some(json!({
                    "downloaded": true,
                    "version": requested_version,
                    "downloadedAtMs": now,
                    "bytes": 0,
                    "source": "rust-primary-placeholder",
                    "handledBy": "rust-primary"
                })))
            }
            "update.install" => {
                let now = epoch_millis();
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "update state lock poisoned".to_string())?;

                let version = params
                    .get("version")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| state.downloaded_version.clone());

                let Some(version) = version else {
                    return Ok(Some(json!({
                        "scheduled": false,
                        "installed": false,
                        "reason": "no downloaded update is available",
                        "handledBy": "rust-primary"
                    })));
                };

                state.install_scheduled_version = Some(version.clone());
                state.install_scheduled_at_ms = Some(now);

                Ok(Some(json!({
                    "scheduled": true,
                    "installed": false,
                    "version": version,
                    "scheduledAtMs": now,
                    "requiresRestart": true,
                    "reason": "native installer pipeline is not wired yet; install is only marked as scheduled",
                    "handledBy": "rust-primary"
                })))
            }
            _ => Ok(None),
        }
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
