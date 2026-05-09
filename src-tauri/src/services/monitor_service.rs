use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sysinfo::{Disks, System};
use tracing::warn;

use crate::models::{AppError, SystemInfo};

pub struct MonitorService {
    sys: Arc<Mutex<System>>,
    cache: Arc<Mutex<MonitorCache>>,
}

struct MonitorCache {
    last_update: Instant,
    info: Option<SystemInfo>,
}

impl MonitorService {
    pub fn new() -> Self {
        Self {
            sys: Arc::new(Mutex::new(System::new_all())),
            cache: Arc::new(Mutex::new(MonitorCache {
                last_update: Instant::now() - Duration::from_secs(10),
                info: None,
            })),
        }
    }

    pub async fn get_info(&self) -> Result<SystemInfo, AppError> {
        let now = Instant::now();
        let cached = {
            let cache = self
                .cache
                .lock()
                .map_err(|_| AppError::Monitor("Monitor cache lock poisoned.".to_string()))?;
            if now.duration_since(cache.last_update) < Duration::from_secs(5) {
                cache.info.clone()
            } else {
                None
            }
        };
        if let Some(info) = cached {
            return Ok(info);
        }

        // Refresh in blocking worker and bound it by timeout.
        let sys_arc = Arc::clone(&self.sys);
        let update_result = tokio::time::timeout(
            Duration::from_secs(3),
            tokio::task::spawn_blocking(move || {
                let mut sys = sys_arc
                    .lock()
                    .map_err(|_| AppError::Monitor("System monitor lock poisoned.".to_string()))?;
                sys.refresh_memory();
                sys.refresh_cpu();

                let ram_total = sys.total_memory();
                let ram_used = sys.used_memory();
                let ram_free = ram_total.saturating_sub(ram_used);
                let ram_percent = if ram_total > 0 {
                    ((ram_used as f64 / ram_total as f64) * 100.0) as u8
                } else {
                    0
                };

                let disks = Disks::new_with_refreshed_list();
                let mut disk_total = 0u64;
                let mut disk_used = 0u64;
                for disk in disks.list() {
                    disk_total += disk.total_space();
                    disk_used += disk.total_space().saturating_sub(disk.available_space());
                }

                Ok::<SystemInfo, AppError>(SystemInfo {
                    ram_total,
                    ram_used,
                    ram_free,
                    ram_percent,
                    disk_total,
                    disk_used,
                    disk_free: disk_total.saturating_sub(disk_used),
                    cpu_usage: sys.global_cpu_info().cpu_usage(),
                })
            }),
        )
        .await;

        let info = match update_result {
            Ok(Ok(Ok(info))) => info,
            Ok(Ok(Err(error))) => return Err(error),
            Ok(Err(_)) => {
                warn!("System info refresh task join failed");
                return Err(AppError::Monitor("Failed to refresh system information".to_string()));
            }
            Err(_) => {
                warn!("System info refresh timeout (3s) - returning cached data");
                if let Some(cached) = self
                    .cache
                    .lock()
                    .map_err(|_| AppError::Monitor("Monitor cache lock poisoned.".to_string()))?
                    .info
                    .clone()
                {
                    return Ok(cached);
                }

                return Ok(SystemInfo {
                    ram_total: 0,
                    ram_used: 0,
                    ram_free: 0,
                    ram_percent: 0,
                    disk_total: 0,
                    disk_used: 0,
                    disk_free: 0,
                    cpu_usage: 0.0,
                });
            }
        };

        let mut cache = self
            .cache
            .lock()
            .map_err(|_| AppError::Monitor("Monitor cache lock poisoned.".to_string()))?;
        cache.last_update = now;
        cache.info = Some(info.clone());

        Ok(info)
    }
}