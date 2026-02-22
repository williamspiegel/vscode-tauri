use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait ProcessCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryProcessCapability;

#[async_trait]
impl ProcessCapability for RustPrimaryProcessCapability {
    async fn invoke(&self, _method: &str, _params: &Value) -> Result<Option<Value>, String> {
        Ok(None)
    }
}
