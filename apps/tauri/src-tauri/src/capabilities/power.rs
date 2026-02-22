use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[async_trait]
pub trait PowerCapability: Send + Sync {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String>;
}

pub struct RustPrimaryPowerCapability {
    blockers: Mutex<BTreeMap<String, Child>>,
    next_id: AtomicU64,
}

impl RustPrimaryPowerCapability {
    pub fn new() -> Self {
        Self {
            blockers: Mutex::new(BTreeMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

#[async_trait]
impl PowerCapability for RustPrimaryPowerCapability {
    async fn invoke(&self, method: &str, params: &Value) -> Result<Option<Value>, String> {
        match method {
            "power.preventSleep" => {
                if !cfg!(target_os = "macos") {
                    return Ok(None);
                }

                let reason = parse_required_string(params, "reason")?;
                let child = Command::new("caffeinate")
                    .args(["-dimsu"])
                    .spawn()
                    .map_err(|error| {
                        format!("failed to start caffeinate for '{reason}': {error}")
                    })?;

                let id = format!(
                    "sleep-blocker-{}",
                    self.next_id.fetch_add(1, Ordering::Relaxed)
                );
                let mut blockers = self
                    .blockers
                    .lock()
                    .map_err(|_| "power blocker state lock poisoned".to_string())?;
                blockers.insert(id.clone(), child);

                Ok(Some(json!({
                    "id": id,
                    "reason": reason,
                    "active": true
                })))
            }
            "power.allowSleep" => {
                if !cfg!(target_os = "macos") {
                    return Ok(None);
                }

                let id = parse_required_string(params, "id")?;
                let mut blockers = self
                    .blockers
                    .lock()
                    .map_err(|_| "power blocker state lock poisoned".to_string())?;
                let Some(mut child) = blockers.remove(id) else {
                    return Ok(Some(json!({
                        "id": id,
                        "released": false,
                        "reason": "unknown blocker id"
                    })));
                };

                child
                    .kill()
                    .map_err(|error| format!("failed to stop sleep blocker '{id}': {error}"))?;
                let _ = child.wait();

                Ok(Some(json!({
                    "id": id,
                    "released": true
                })))
            }
            "power.idleState" => {
                if !cfg!(target_os = "macos") {
                    return Ok(None);
                }

                let threshold_seconds = parse_required_u64(params, "thresholdSeconds")?;
                let idle_nanos = read_macos_idle_time_nanos()?;
                let idle_seconds = idle_nanos as f64 / 1_000_000_000_f64;
                let state = if idle_seconds >= threshold_seconds as f64 {
                    "idle"
                } else {
                    "active"
                };

                Ok(Some(json!({
                    "state": state,
                    "idleSeconds": idle_seconds,
                    "thresholdSeconds": threshold_seconds
                })))
            }
            _ => Ok(None),
        }
    }
}

impl Drop for RustPrimaryPowerCapability {
    fn drop(&mut self) {
        if let Ok(mut blockers) = self.blockers.lock() {
            for child in blockers.values_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn parse_required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "params must be an object".to_string())?;
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string param '{key}'"))
}

fn parse_required_u64(params: &Value, key: &str) -> Result<u64, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "params must be an object".to_string())?;
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing numeric param '{key}'"))
}

fn read_macos_idle_time_nanos() -> Result<u64, String> {
    let output = Command::new("ioreg")
        .args(["-c", "IOHIDSystem"])
        .output()
        .map_err(|error| format!("failed to read idle state via ioreg: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "ioreg returned non-zero status while reading idle state: {}",
            output.status
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if !line.contains("HIDIdleTime") {
            continue;
        }

        let Some((_, right)) = line.split_once('=') else {
            continue;
        };
        let token = right
            .trim()
            .trim_matches(|character| matches!(character, '"' | ',' | ';'));
        if token.is_empty() {
            continue;
        }

        if let Some(hex) = token.strip_prefix("0x") {
            if let Ok(value) = u64::from_str_radix(hex, 16) {
                return Ok(value);
            }
        } else if let Ok(value) = token.parse::<u64>() {
            return Ok(value);
        }
    }

    Err("failed to parse HIDIdleTime from ioreg output".to_string())
}
