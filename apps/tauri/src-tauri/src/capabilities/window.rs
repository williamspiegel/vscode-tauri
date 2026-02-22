use async_trait::async_trait;
use serde_json::{json, Value};

#[async_trait]
pub trait WindowCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryWindowCapability;

#[async_trait]
impl WindowCapability for RustPrimaryWindowCapability {
    async fn invoke(&self, method: &str, _params: &Value) -> Result<Option<Value>, String> {
        if method == "window.getState" {
            return Ok(Some(json!({
                "focused": true,
                "fullscreen": false,
                "platform": std::env::consts::OS
            })));
        }

        Ok(None)
    }
}
