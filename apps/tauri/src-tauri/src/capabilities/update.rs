use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait UpdateCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryUpdateCapability;

#[async_trait]
impl UpdateCapability for RustPrimaryUpdateCapability {
    async fn invoke(&self, _method: &str, _params: &Value) -> Result<Option<Value>, String> {
        Ok(None)
    }
}
