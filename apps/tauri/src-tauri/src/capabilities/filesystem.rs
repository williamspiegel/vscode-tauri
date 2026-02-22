use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait FilesystemCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryFilesystemCapability;

#[async_trait]
impl FilesystemCapability for RustPrimaryFilesystemCapability {
    async fn invoke(&self, _method: &str, _params: &Value) -> Result<Option<Value>, String> {
        Ok(None)
    }
}
