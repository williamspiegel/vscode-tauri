use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct FallbackMetrics {
    inner: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl FallbackMetrics {
    pub fn increment(&self, domain: &str, method: &str) -> u64 {
        let key = format!("{domain}:{method}");
        let mut guard = self.inner.lock().expect("fallback metric mutex poisoned");
        let entry = guard.entry(key).or_insert(0);
        *entry += 1;
        *entry
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        self.inner
            .lock()
            .expect("fallback metric mutex poisoned")
            .clone()
    }
}
