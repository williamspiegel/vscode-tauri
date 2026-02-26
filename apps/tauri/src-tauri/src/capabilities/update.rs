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

                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "update state lock poisoned".to_string())?;
                state.downloaded_version = None;
                state.downloaded_at_ms = None;

                Ok(Some(json!({
                    "downloaded": false,
                    "version": requested_version,
                    "downloadedAtMs": Value::Null,
                    "bytes": 0,
                    "source": "rust-primary-disabled",
                    "reason": "native updater download is not implemented for this Tauri host",
                    "handledBy": "rust-primary"
                })))
            }
            "update.install" => {
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

                state.install_scheduled_version = None;
                state.install_scheduled_at_ms = None;

                Ok(Some(json!({
                    "scheduled": false,
                    "installed": false,
                    "version": version,
                    "scheduledAtMs": Value::Null,
                    "requiresRestart": false,
                    "reason": "native updater install is not implemented for this Tauri host",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn check_returns_stable_payload() {
        let capability = RustPrimaryUpdateCapability::new();
        let result = capability
            .invoke("update.check", &json!({}))
            .await
            .expect("update.check should succeed")
            .expect("update.check should return payload");
        assert_eq!(result["checked"], json!(true));
        assert_eq!(result["handledBy"], json!("rust-primary"));
    }

    #[tokio::test]
    async fn check_echoes_requested_channel() {
        let capability = RustPrimaryUpdateCapability::new();
        let result = capability
            .invoke("update.check", &json!({ "channel": "insiders" }))
            .await
            .expect("update.check should succeed")
            .expect("update.check should return payload");
        assert_eq!(result["channel"], json!("insiders"));
    }

    #[tokio::test]
    async fn download_without_version_uses_unknown_fallback() {
        let capability = RustPrimaryUpdateCapability::new();
        let result = capability
            .invoke("update.download", &json!({}))
            .await
            .expect("update.download should succeed")
            .expect("update.download should return payload");
        assert_eq!(result["downloaded"], json!(false));
        assert_eq!(result["version"], json!("unknown"));
    }

    #[tokio::test]
    async fn install_without_downloaded_version_reports_stable_reason() {
        let capability = RustPrimaryUpdateCapability::new();
        let result = capability
            .invoke("update.install", &json!({}))
            .await
            .expect("update.install should succeed")
            .expect("update.install should return payload");
        assert_eq!(result["scheduled"], json!(false));
        assert_eq!(result["installed"], json!(false));
        assert_eq!(result["reason"], json!("no downloaded update is available"));
    }

    #[tokio::test]
    async fn install_with_explicit_version_returns_stable_payload() {
        let capability = RustPrimaryUpdateCapability::new();
        let result = capability
            .invoke("update.install", &json!({ "version": "1.2.3" }))
            .await
            .expect("update.install should succeed")
            .expect("update.install should return payload");
        assert_eq!(result["scheduled"], json!(false));
        assert_eq!(result["installed"], json!(false));
        assert_eq!(result["version"], json!("1.2.3"));
        assert_eq!(result["handledBy"], json!("rust-primary"));
    }

    #[tokio::test]
    async fn unknown_method_returns_none() {
        let capability = RustPrimaryUpdateCapability::new();
        let result = capability
            .invoke("update.notImplemented", &json!({}))
            .await
            .expect("unknown method should not fail");
        assert!(result.is_none());
    }
}
