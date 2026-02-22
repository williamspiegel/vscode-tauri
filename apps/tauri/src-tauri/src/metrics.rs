use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct FallbackMetrics {
    inner: Arc<Mutex<FallbackMetricsState>>,
}

struct FallbackMetricsState {
    counts: BTreeMap<String, u64>,
    metrics_path: PathBuf,
    events_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedMetrics {
    version: u32,
    updated_at_ms: u64,
    counts: BTreeMap<String, u64>,
}

#[derive(Debug, Serialize)]
struct PersistedEvent<'a> {
    at_ms: u64,
    key: &'a str,
    class: &'a str,
    domain: &'a str,
    method: &'a str,
    count: u64,
}

impl Default for FallbackMetrics {
    fn default() -> Self {
        let (metrics_path, events_path) = default_metrics_paths();
        let counts = load_counts(&metrics_path);
        Self {
            inner: Arc::new(Mutex::new(FallbackMetricsState {
                counts,
                metrics_path,
                events_path,
            })),
        }
    }
}

impl FallbackMetrics {
    pub fn increment_capability(&self, domain: &str, method: &str) -> u64 {
        let key = format!("capability:{domain}:{method}");
        self.increment_with_key(key, "capability", domain, method)
    }

    pub fn increment_channel(&self, channel: &str, method: &str) -> u64 {
        let key = format!("channel:{channel}:{method}");
        self.increment_with_key(key, "channel", channel, method)
    }

    fn increment_with_key(&self, key: String, class: &str, domain: &str, method: &str) -> u64 {
        let mut guard = self.inner.lock().expect("fallback metric mutex poisoned");
        let entry = guard.counts.entry(key.clone()).or_insert(0);
        *entry += 1;

        let next_count = *entry;
        if let Err(error) = persist_counts(&guard.metrics_path, &guard.counts) {
            eprintln!("Failed to persist fallback metrics: {error}");
        }
        if let Err(error) =
            append_event(&guard.events_path, &key, class, domain, method, next_count)
        {
            eprintln!("Failed to append fallback event: {error}");
        }

        next_count
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        self.inner
            .lock()
            .expect("fallback metric mutex poisoned")
            .counts
            .clone()
    }
}

fn load_counts(metrics_path: &PathBuf) -> BTreeMap<String, u64> {
    let raw = match fs::read(metrics_path) {
        Ok(bytes) => bytes,
        Err(_) => return BTreeMap::new(),
    };

    let parsed: PersistedMetrics = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(_) => return BTreeMap::new(),
    };

    parsed.counts
}

fn persist_counts(metrics_path: &PathBuf, counts: &BTreeMap<String, u64>) -> Result<(), String> {
    if let Some(parent) = metrics_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "unable to create fallback metrics directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let payload = PersistedMetrics {
        version: 1,
        updated_at_ms: epoch_millis(),
        counts: counts.clone(),
    };
    let encoded = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("unable to encode fallback metrics JSON: {error}"))?;

    let tmp_path = metrics_path.with_extension("tmp");
    fs::write(&tmp_path, encoded)
        .map_err(|error| format!("unable to write temporary fallback metrics file: {error}"))?;

    match fs::rename(&tmp_path, metrics_path) {
        Ok(()) => {}
        Err(rename_error) => {
            if metrics_path.exists() {
                fs::remove_file(metrics_path).map_err(|remove_error| {
                    format!(
                        "unable to replace fallback metrics file (remove failed: {remove_error}, rename failed: {rename_error})"
                    )
                })?;
                fs::rename(&tmp_path, metrics_path)
                    .map_err(|error| format!("unable to rename fallback metrics file: {error}"))?;
            } else {
                return Err(format!(
                    "unable to rename fallback metrics file: {rename_error}"
                ));
            }
        }
    }

    Ok(())
}

fn append_event(
    events_path: &PathBuf,
    key: &str,
    class: &str,
    domain: &str,
    method: &str,
    count: u64,
) -> Result<(), String> {
    if let Some(parent) = events_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "unable to create fallback events directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let event = PersistedEvent {
        at_ms: epoch_millis(),
        key,
        class,
        domain,
        method,
        count,
    };
    let encoded = serde_json::to_string(&event)
        .map_err(|error| format!("unable to encode fallback event: {error}"))?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path)
        .map_err(|error| {
            format!(
                "unable to open fallback events file {}: {error}",
                events_path.display()
            )
        })?;
    file.write_all(encoded.as_bytes())
        .map_err(|error| format!("unable to write fallback event: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("unable to write fallback event newline: {error}"))?;
    Ok(())
}

fn default_metrics_paths() -> (PathBuf, PathBuf) {
    if let Ok(raw_path) = std::env::var("VSCODE_TAURI_FALLBACK_METRICS_PATH") {
        let metrics_path = PathBuf::from(raw_path);
        let events_path = std::env::var("VSCODE_TAURI_FALLBACK_EVENTS_PATH").map_or_else(
            |_| metrics_path.with_extension("events.jsonl"),
            PathBuf::from,
        );
        return (metrics_path, events_path);
    }

    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        let manifest_dir = PathBuf::from(manifest_dir);
        if manifest_dir.exists() {
            let repo_metrics = manifest_dir.join("../logs/fallback-metrics.json");
            return (
                repo_metrics.clone(),
                repo_metrics.with_extension("events.jsonl"),
            );
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let repo_metrics = cwd.join("apps/tauri/logs/fallback-metrics.json");
        if cwd.join("apps/tauri").exists() {
            return (
                repo_metrics.clone(),
                repo_metrics.with_extension("events.jsonl"),
            );
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let metrics_path = home
        .join(".vscode-tauri")
        .join("logs")
        .join("fallback-metrics.json");
    (
        metrics_path.clone(),
        metrics_path.with_extension("events.jsonl"),
    )
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
