use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeRequest {
    pub protocol_version: String,
    pub client_name: String,
    pub client_version: String,
    #[serde(default)]
    pub requested_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResponse {
    pub protocol_version: String,
    pub server_name: String,
    pub server_version: String,
    pub supported_capabilities: Vec<String>,
}

pub const PROTOCOL_VERSION: &str = "1.0.0";

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum CapabilityDomain {
    Window,
    Filesystem,
    Terminal,
    Clipboard,
    Dialogs,
    Process,
    Power,
    Os,
    Update,
}

impl CapabilityDomain {
    pub fn from_method(method: &str) -> Option<Self> {
        if method.starts_with("window.") {
            Some(Self::Window)
        } else if method.starts_with("filesystem.") {
            Some(Self::Filesystem)
        } else if method.starts_with("terminal.") {
            Some(Self::Terminal)
        } else if method.starts_with("clipboard.") {
            Some(Self::Clipboard)
        } else if method.starts_with("dialogs.") {
            Some(Self::Dialogs)
        } else if method.starts_with("process.") {
            Some(Self::Process)
        } else if method.starts_with("power.") {
            Some(Self::Power)
        } else if method.starts_with("os.") {
            Some(Self::Os)
        } else if method.starts_with("update.") {
            Some(Self::Update)
        } else {
            None
        }
    }
}

pub fn ok_response(id: u64, result: Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: Some(result),
        error: None,
    }
}

pub fn error_response(id: u64, code: i64, message: impl Into<String>) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.into(),
            data: None,
        }),
    }
}
