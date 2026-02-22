use crate::metrics::FallbackMetrics;
use crate::protocol::CapabilityDomain;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Clone)]
pub struct NodeFallbackClient {
    node_exec: String,
    fallback_script: PathBuf,
    metrics: FallbackMetrics,
}

impl NodeFallbackClient {
    pub fn new(fallback_script: PathBuf, metrics: FallbackMetrics) -> Self {
        Self {
            node_exec: "node".to_string(),
            fallback_script,
            metrics,
        }
    }

    pub async fn invoke_capability(
        &self,
        domain: CapabilityDomain,
        method: &str,
        params: &Value,
    ) -> Result<Value, String> {
        let fallback_count = self.metrics.increment_capability(domain.as_str(), method);
        self.run_fallback(
            json!({
                "kind": "capability",
                "domain": domain.as_str(),
                "method": method,
                "params": params,
                "fallbackCount": fallback_count
            }),
            method,
        )
        .await
    }

    pub async fn invoke_channel(
        &self,
        channel: &str,
        method: &str,
        args: &Value,
    ) -> Result<Value, String> {
        let fallback_count = self.metrics.increment_channel(channel, method);
        self.run_fallback(
            json!({
                "kind": "channel",
                "channel": channel,
                "method": method,
                "args": args,
                "fallbackCount": fallback_count
            }),
            method,
        )
        .await
    }

    async fn run_fallback(&self, request: Value, method: &str) -> Result<Value, String> {
        let mut child = Command::new(&self.node_exec)
            .arg(&self.fallback_script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| format!("Unable to spawn Node fallback: {error}"))?;

        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(request.to_string().as_bytes())
                .await
                .map_err(|error| format!("Unable to write fallback stdin: {error}"))?;
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|error| format!("Fallback process wait failed: {error}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Node fallback execution failed for {method}: {}",
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: Value = serde_json::from_str(stdout.trim())
            .map_err(|error| format!("Fallback JSON parse failed: {error}"))?;

        if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "Node fallback returned non-ok result for {method}: {}",
                parsed
            ));
        }

        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    }

    pub fn metrics(&self) -> FallbackMetrics {
        self.metrics.clone()
    }
}
