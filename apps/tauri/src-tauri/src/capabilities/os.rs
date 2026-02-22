use async_trait::async_trait;
use serde_json::{json, Value};

#[async_trait]
pub trait OsCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryOsCapability;

#[async_trait]
impl OsCapability for RustPrimaryOsCapability {
    async fn invoke(&self, method: &str, _params: &Value) -> Result<Option<Value>, String> {
        if method == "os.systemInfo" {
            return Ok(Some(json!({
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH
            })));
        }

        Ok(None)
    }
}
