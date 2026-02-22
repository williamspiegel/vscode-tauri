use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait PowerCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryPowerCapability;

#[async_trait]
impl PowerCapability for RustPrimaryPowerCapability {
    async fn invoke(&self, _method: &str, _params: &Value) -> Result<Option<Value>, String> {
        Ok(None)
    }
}
