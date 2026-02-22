use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait TerminalCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryTerminalCapability;

#[async_trait]
impl TerminalCapability for RustPrimaryTerminalCapability {
    async fn invoke(&self, _method: &str, _params: &Value) -> Result<Option<Value>, String> {
        Ok(None)
    }
}
