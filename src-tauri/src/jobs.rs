use crate::lock_poison;
use crate::models::*;
use crate::redact::redact_line;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;

const MAX_LOG_LINES: usize = 2000;
const MAX_JOBS: usize = 200;
const ENV_CACHE_TTL_MS: u64 = 30_000;

pub struct CachedEnvironments {
    pub fetched_at: u64,
    pub environments: Vec<EnvironmentSummary>,
}

/// 任务管理器：负责任务生命周期、事件推送、取消、per-prefix 锁与持久化，
/// 同时承担环境列表缓存。
pub struct JobManager {
    jobs: Mutex<HashMap<u64, Job>>,
    order: Mutex<Vec<u64>>,
    next_id: AtomicU64,
    cancel_flags: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    prefix_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    stderr_buffers: Mutex<HashMap<u64, String>>,
    env_cache: Mutex<HashMap<String, CachedEnvironments>>,
    operations_file: Option<PathBuf>,
}

impl JobManager {
    pub fn new(operations_file: Option<PathBuf>) -> Self {
        let manager = JobManager {
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            cancel_flags: Mutex::new(HashMap::new()),
            prefix_locks: Mutex::new(HashMap::new()),
            stderr_buffers: Mutex::new(HashMap::new()),
            env_cache: Mutex::new(HashMap::new()),
            operations_file: operations_file.clone(),
        };
        if let Some(path) = &operations_file {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(records) = serde_json::from_str::<Vec<OperationRecord>>(&text) {
                    let mut jobs = lock_poison(&manager.jobs);
                    let mut order = lock_poison(&manager.order);
                    let mut max_id = 0u64;
                    for mut record in records {
                        if record.status == "running" || record.status == "queued" {
                            record.status = "interrupted".to_string();
                            record.summary = "应用退出，操作未完成".to_string();
                        }
                        max_id = max_id.max(record.id);
                        let job = Job {
                            id: record.id,
                            kind: record.kind.clone(),
                            target: record.target.clone(),
                            status: record.status.clone(),
                            summary: record.summary.clone(),
                            error: None,
                            environment_prefix: None,
                            stage: None,
                            created_at: record.started_at,
                            started_at: Some(record.started_at),
                            finished_at: record.finished_at,
                            log: Vec::new(),
                        };
                        jobs.insert(record.id, job);
                        order.push(record.id);
                    }
                    manager.next_id.store(max_id + 1, Ordering::SeqCst);
                }
            }
        }
        manager
    }

    pub fn create(&self, kind: &str, target: &str, environment_prefix: Option<&str>) -> Job {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let job = Job {
            id,
            kind: kind.to_string(),
            target: target.to_string(),
            status: "queued".to_string(),
            summary: "等待执行…".to_string(),
            error: None,
            environment_prefix: environment_prefix.map(String::from),
            stage: Some("排队中".to_string()),
            created_at: now_millis(),
            started_at: None,
            finished_at: None,
            log: Vec::new(),
        };
        {
            let mut jobs = lock_poison(&self.jobs);
            let mut order = lock_poison(&self.order);
            jobs.insert(id, job.clone());
            order.push(id);
            while order.len() > MAX_JOBS {
                let old = order.remove(0);
                jobs.remove(&old);
                let mut flags = lock_poison(&self.cancel_flags);
                flags.remove(&old);
            }
        }
        {
            let mut flags = lock_poison(&self.cancel_flags);
            flags.insert(id, Arc::new(AtomicBool::new(false)));
        }
        self.persist();
        job
    }

    pub fn get(&self, id: u64) -> Option<Job> {
        lock_poison(&self.jobs).get(&id).cloned()
    }

    pub fn list(&self) -> Vec<Job> {
        let jobs = lock_poison(&self.jobs);
        let order = lock_poison(&self.order);
        order.iter().rev().filter_map(|id| jobs.get(id)).cloned().collect()
    }

    pub fn set_status(&self, id: u64, status: &str, summary: &str) {
        {
            let mut jobs = lock_poison(&self.jobs);
            if let Some(job) = jobs.get_mut(&id) {
                job.status = status.to_string();
                job.summary = summary.to_string();
            }
        }
        self.persist();
    }

    pub fn set_started(&self, id: u64) {
        {
            let mut jobs = lock_poison(&self.jobs);
            if let Some(job) = jobs.get_mut(&id) {
                if job.started_at.is_none() {
                    job.started_at = Some(now_millis());
                }
            }
        }
        self.persist();
    }

    pub fn set_finished(&self, id: u64) {
        {
            let mut jobs = lock_poison(&self.jobs);
            if let Some(job) = jobs.get_mut(&id) {
                job.finished_at = Some(now_millis());
            }
        }
        self.persist();
    }

    pub fn set_stage(&self, id: u64, stage: &str) {
        let mut jobs = lock_poison(&self.jobs);
        if let Some(job) = jobs.get_mut(&id) {
            job.stage = Some(stage.to_string());
        }
    }

    pub fn fail(&self, id: u64, error: &str) {
        {
            let mut jobs = lock_poison(&self.jobs);
            if let Some(job) = jobs.get_mut(&id) {
                job.status = "failed".to_string();
                job.summary = "执行失败".to_string();
                job.error = Some(error.to_string());
            }
        }
        self.persist();
    }

    pub fn append_log(&self, app: &AppHandle, id: u64, line: &str) {
        let redacted = redact_line(line);
        {
            let mut jobs = lock_poison(&self.jobs);
            if let Some(job) = jobs.get_mut(&id) {
                job.log.push(redacted.clone());
                if job.log.len() > MAX_LOG_LINES {
                    job.log.remove(0);
                }
            }
        }
        self.emit(app, id, Some(redacted));
    }

    pub fn append_stderr(&self, app: &AppHandle, id: u64, line: &str) {
        let redacted = redact_line(line);
        {
            let mut jobs = lock_poison(&self.jobs);
            if let Some(job) = jobs.get_mut(&id) {
                job.log.push(redacted.clone());
                if job.log.len() > MAX_LOG_LINES {
                    job.log.remove(0);
                }
            }
            let mut buffers = lock_poison(&self.stderr_buffers);
            let buffer = buffers.entry(id).or_default();
            buffer.push_str(&redacted);
            buffer.push('\n');
            if buffer.len() > 4096 {
                let cut = buffer.len() - 4096;
                buffer.drain(..cut);
            }
        }
        self.emit(app, id, Some(redacted));
    }

    pub fn take_stderr(&self, id: u64) -> String {
        let mut buffers = lock_poison(&self.stderr_buffers);
        let s = buffers.remove(&id).unwrap_or_default();
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            "命令执行失败（无错误输出）".to_string()
        } else {
            trimmed
        }
    }

    pub fn request_cancel(&self, app: &AppHandle, id: u64) -> Result<(), String> {
        {
            let flags = lock_poison(&self.cancel_flags);
            let Some(flag) = flags.get(&id) else {
                return Err("任务不存在".to_string());
            };
            flag.store(true, Ordering::SeqCst);
        }
        {
            let mut jobs = lock_poison(&self.jobs);
            if let Some(job) = jobs.get_mut(&id) {
                if job.status == "queued" || job.status == "running" {
                    job.status = "cancel_requested".to_string();
                    job.summary = "正在取消…".to_string();
                }
            }
        }
        self.persist();
        self.emit(app, id, None);
        Ok(())
    }

    pub fn cancel_flag(&self, id: u64) -> Arc<AtomicBool> {
        lock_poison(&self.cancel_flags)
            .get(&id)
            .cloned()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)))
    }

    pub fn acquire_prefix_lock(&self, prefix: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = lock_poison(&self.prefix_locks);
        locks
            .entry(prefix.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    pub fn emit(&self, app: &AppHandle, id: u64, log_line: Option<String>) {
        if let Some(job) = self.get(id) {
            let event = job.to_event(log_line);
            let _ = app.emit("job-event", event);
        }
    }

    pub fn get_env_cache(&self, instance_id: &str) -> Option<Vec<EnvironmentSummary>> {
        let cache = lock_poison(&self.env_cache);
        cache.get(instance_id).and_then(|cached| {
            if now_millis().saturating_sub(cached.fetched_at) < ENV_CACHE_TTL_MS {
                Some(cached.environments.clone())
            } else {
                None
            }
        })
    }

    pub fn set_env_cache(&self, instance_id: &str, environments: Vec<EnvironmentSummary>) {
        let mut cache = lock_poison(&self.env_cache);
        cache.insert(
            instance_id.to_string(),
            CachedEnvironments {
                fetched_at: now_millis(),
                environments,
            },
        );
    }

    pub fn invalidate_env_cache(&self, instance_id: &str) {
        let mut cache = lock_poison(&self.env_cache);
        cache.remove(instance_id);
    }

    fn persist(&self) {
        let Some(path) = &self.operations_file else {
            return;
        };
        let records: Vec<OperationRecord> = {
            let jobs = lock_poison(&self.jobs);
            let order = lock_poison(&self.order);
            order.iter().filter_map(|id| jobs.get(id)).map(|job| job.to_record()).collect()
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&records).unwrap_or_default();
        let _ = std::fs::write(path, json);
    }
}

/// 提交一个异步任务：创建 Job、推送 queued 事件，并在后台串行化执行。
/// `argv` 为完整命令行（程序 + 参数），由调用方按目标运行时（Windows / WSL）组装。
#[allow(clippy::too_many_arguments)]
pub fn submit(
    jobs: Arc<JobManager>,
    app: AppHandle,
    kind: &str,
    target: String,
    environment_prefix: Option<String>,
    lock_key: Option<String>,
    argv: Vec<String>,
    success_summary: String,
    invalidate_instance: Option<String>,
) -> Job {
    let job = jobs.create(kind, &target, environment_prefix.as_deref());
    jobs.emit(&app, job.id, None);
    let job_id = job.id;
    let cancel = jobs.cancel_flag(job_id);

    tauri::async_runtime::spawn(async move {
        let _lock = lock_key.map(|key| jobs.acquire_prefix_lock(&key));
        let _guard = match &_lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        execute_process(
            jobs.clone(),
            app.clone(),
            job_id,
            cancel,
            argv,
            success_summary,
        )
        .await;
        if let Some(instance_id) = invalidate_instance {
            jobs.invalidate_env_cache(&instance_id);
        }
    });

    job
}

/// 运行单个外部进程并流式推送输出，支持取消。
pub async fn execute_process(
    jobs: Arc<JobManager>,
    app: AppHandle,
    job_id: u64,
    cancel: Arc<AtomicBool>,
    argv: Vec<String>,
    success_summary: String,
) {
    jobs.set_status(job_id, "running", "正在执行…");
    jobs.set_started(job_id);
    jobs.set_stage(job_id, "执行中");
    jobs.emit(&app, job_id, None);

    let Some((program, args)) = argv.split_first() else {
        jobs.fail(job_id, "命令行为空");
        jobs.set_finished(job_id);
        jobs.emit(&app, job_id, None);
        return;
    };

    let mut command = tokio::process::Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：后台任务不弹控制台窗口
    let mut child = match command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            jobs.fail(job_id, &format!("无法启动进程: {error}"));
            jobs.set_finished(job_id);
            jobs.emit(&app, job_id, None);
            return;
        }
    };

    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let jobs = jobs.clone();
        let app = app.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                jobs.append_log(&app, job_id, &line);
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let jobs = jobs.clone();
        let app = app.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                jobs.append_stderr(&app, job_id, &line);
            }
        }));
    }

    let mut exit: Option<std::process::ExitStatus> = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit = Some(status);
                break;
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(120)).await,
            Err(_) => break,
        }
    }

    for reader in readers {
        let _ = reader.await;
    }

    let cancelled = cancel.load(Ordering::SeqCst);
    if cancelled {
        jobs.set_status(job_id, "cancelled", "已取消");
    } else if exit.map(|status| status.success()).unwrap_or(false) {
        let summary = match jobs.get(job_id) {
            Some(job) if is_clean_kind(&job.kind) => {
                let (count, bytes) = parse_freed(&job.log);
                format_freed_summary(count, bytes)
            }
            _ => success_summary,
        };
        jobs.set_status(job_id, "succeeded", &summary);
    } else {
        let detail = jobs.take_stderr(job_id);
        jobs.fail(job_id, &detail);
    }
    jobs.set_finished(job_id);
    jobs.emit(&app, job_id, None);
}

/// 判断任务类型是否为缓存清理。
fn is_clean_kind(kind: &str) -> bool {
    kind == "clean_cache" || kind == "clean_packages" || kind == "clean_tarballs"
}

/// 解析 conda clean 输出中的 "Will remove N (SIZE) ..." 行，返回 (项数, 字节数)。
fn parse_freed(log: &[String]) -> (u64, u64) {
    let mut count = 0u64;
    let mut bytes = 0u64;
    for line in log {
        let trimmed = line.trim();
        if !trimmed.starts_with("Will remove") {
            continue;
        }
        let Some(open) = trimmed.find('(') else { continue };
        let Some(close) = trimmed[open + 1..].find(')') else { continue };
        let size_text = trimmed[open + 1..open + 1 + close].trim();
        let Some(size_bytes) = parse_size(size_text) else { continue };
        if let Some(count_text) = trimmed[..open].split_whitespace().last() {
            if let Ok(n) = count_text.parse::<u64>() {
                count += n;
            }
        }
        bytes += size_bytes;
    }
    (count, bytes)
}

/// 解析 "33.4 MB" 这类大小为字节。
fn parse_size(text: &str) -> Option<u64> {
    let mut parts = text.split_whitespace();
    let value = parts.next()?.parse::<f64>().ok()?;
    let unit = parts.next().unwrap_or("B").to_ascii_uppercase();
    let factor = match unit.as_str() {
        "B" => 1.0,
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * factor) as u64)
}

/// 生成缓存清理完成摘要。
fn format_freed_summary(count: u64, bytes: u64) -> String {
    if count == 0 && bytes == 0 {
        "缓存清理完成：没有可清理的内容".to_string()
    } else {
        format!(
            "缓存清理完成：共清理 {count} 项，释放 {} 空间",
            human_bytes(bytes)
        )
    }
}

/// 将字节数格式化为人类可读大小。
fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0;
    while value >= 1024.0 && index < UNITS.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if index == 0 {
        format!("{bytes} B")
    } else if value >= 100.0 {
        format!("{value:.0} {}", UNITS[index])
    } else {
        format!("{value:.1} {}", UNITS[index])
    }
}
