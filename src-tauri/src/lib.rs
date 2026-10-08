use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::{TcpStream, ToSocketAddrs},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use thiserror::Error;

#[derive(Debug, Error)]
enum AppError {
    #[error("Conda command failed: {0}")]
    Command(String),
    #[error("Invalid Conda response: {0}")]
    Parse(String),
    #[error("Conda instance was not found")]
    InstanceNotFound,
    #[error("The base environment cannot be modified or removed")]
    BaseEnvironment,
    #[error("Environment name is required and must be valid")]
    InvalidName,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CondaInstance {
    id: String,
    executable_path: String,
    kind: String,
    version: String,
    root_prefix: String,
    platform: String,
    is_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentSummary {
    instance_id: String,
    name: Option<String>,
    prefix: String,
    is_base: bool,
    python_version: Option<String>,
    package_count: Option<usize>,
    platform: Option<String>,
    size_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageRecord {
    name: String,
    version: String,
    build: Option<String>,
    channel: Option<String>,
    package_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateEnvironmentRequest {
    name: String,
    python_version: Option<String>,
    packages: Vec<String>,
    channels: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    name: String,
    version: String,
    channel: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OperationRecord {
    id: u64,
    kind: String,
    target: String,
    status: String,
    summary: String,
    started_at: u64,
    finished_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelInfo {
    channels: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelTestResult {
    channel: String,
    target: String,
    reachable: bool,
    latency_ms: Option<u64>,
    error: Option<String>,
}

/// 环境列表缓存条目，记录抓取时间以便过期判断。
struct CachedEnvironments {
    fetched_at: u64,
    environments: Vec<EnvironmentSummary>,
}

/// 环境列表缓存有效期（毫秒）。在此窗口内直接返回缓存，避免频繁启动 Conda 子进程。
const ENV_CACHE_TTL_MS: u64 = 30_000;

#[derive(Default)]
struct AppState {
    instances: std::sync::Mutex<Vec<CondaInstance>>,
    operations: std::sync::Mutex<Vec<OperationRecord>>,
    next_operation_id: std::sync::atomic::AtomicU64,
    env_cache: std::sync::Mutex<HashMap<String, CachedEnvironments>>,
    operations_file: Option<PathBuf>,
}

fn run_json(executable: &Path, args: &[&str]) -> Result<serde_json::Value, AppError> {
    let output = Command::new(executable)
        .args(args)
        .output()
        .map_err(|error| AppError::Command(format!("{}: {error}", executable.display())))?;
    parse_output(output)
}

fn parse_output(output: Output) -> Result<serde_json::Value, AppError> {
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Command(detail.trim().to_string()));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| {
        AppError::Parse(format!(
            "{error}: {}",
            String::from_utf8_lossy(&output.stdout)
        ))
    })
}

fn run_command(executable: &Path, args: &[String]) -> Result<Output, AppError> {
    Command::new(executable)
        .args(args)
        .output()
        .map_err(|error| AppError::Command(format!("{}: {error}", executable.display())))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 操作记录持久化文件路径（`%APPDATA%\easy-conda\operations.json`）。
fn operations_file_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    Some(base.join("easy-conda").join("operations.json"))
}

/// 从磁盘加载历史操作记录；文件不存在或损坏时返回空。
fn load_operations(path: &Path) -> Vec<OperationRecord> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<OperationRecord>>(&text).ok())
        .unwrap_or_default()
}

/// 将当前操作记录写回磁盘（失败静默忽略，不影响主流程）。
fn persist_operations(state: &AppState) {
    let Some(path) = state.operations_file.as_ref() else {
        return;
    };
    let Ok(operations) = state.operations.lock() else {
        return;
    };
    let Ok(json) = serde_json::to_string_pretty(&*operations) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, json);
}

fn record_operation(state: &AppState, kind: &str, target: &str, status: &str, summary: &str, started_at: u64) -> OperationRecord {
    let id = state
        .next_operation_id
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let record = OperationRecord {
        id,
        kind: kind.into(),
        target: target.into(),
        status: status.into(),
        summary: summary.into(),
        started_at,
        finished_at: if status == "running" { None } else { Some(now_millis()) },
    };
    if let Ok(mut operations) = state.operations.lock() {
        operations.push(record.clone());
        if operations.len() > 200 {
            let excess = operations.len() - 200;
            operations.drain(0..excess);
        }
    }
    persist_operations(state);
    record
}

fn update_operation(state: &AppState, id: u64, status: &str, summary: &str) {
    if let Ok(mut operations) = state.operations.lock() {
        if let Some(record) = operations.iter_mut().find(|record| record.id == id) {
            record.status = status.into();
            record.summary = summary.into();
            record.finished_at = Some(now_millis());
        }
    }
    persist_operations(state);
}

fn valid_env_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 128
        && name.chars().all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
}

fn executable_kind(path: &Path) -> &'static str {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if name.contains("micromamba") {
        "micromamba"
    } else if name.contains("mamba") {
        "mamba"
    } else {
        "conda"
    }
}

fn candidate_executables() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for name in ["conda", "mamba", "micromamba"] {
        if let Some(path) = find_executable(name) {
            candidates.push(path);
        }
    }
    if let Some(path) = std::env::var_os("CONDA_EXE") {
        candidates.push(PathBuf::from(path));
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let extensions: Vec<String> = std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_else(|| vec![".EXE".into(), ".BAT".into(), ".CMD".into()]);
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|directory| {
            extensions
                .iter()
                .map(move |extension| directory.join(format!("{name}{extension}")))
        })
        .find(|candidate| candidate.is_file())
}

fn probe(path: &Path) -> Result<CondaInstance, AppError> {
    let json = run_json(path, &["info", "--json"])?;
    let root_prefix = json
        .get("root_prefix")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::Parse("missing root_prefix".into()))?;
    let version = json
        .get("conda_version")
        .and_then(|value| value.as_str())
        .or_else(|| json.get("mamba_version").and_then(|value| value.as_str()))
        .unwrap_or("unknown");
    let platform = json
        .get("platform")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    Ok(CondaInstance {
        id: format!("{}:{}", executable_kind(path), root_prefix.to_lowercase()),
        executable_path: path.to_string_lossy().into_owned(),
        kind: executable_kind(path).into(),
        version: version.into(),
        root_prefix: root_prefix.into(),
        platform: platform.into(),
        is_default: false,
    })
}

fn find_instance(state: &AppState, id: &str) -> Result<CondaInstance, AppError> {
    state
        .instances
        .lock()
        .map_err(|error| AppError::Command(error.to_string()))?
        .iter()
        .find(|instance| instance.id == id)
        .cloned()
        .ok_or(AppError::InstanceNotFound)
}

fn instance_executable(instance: &CondaInstance) -> PathBuf {
    PathBuf::from(&instance.executable_path)
}

#[tauri::command]
async fn discover_conda_instances(state: State<'_, AppState>) -> Result<Vec<CondaInstance>, String> {
    let found: Vec<_> = candidate_executables()
        .iter()
        .filter_map(|path| probe(path).ok())
        .collect();
    let mut lock = state.instances.lock().map_err(|error| error.to_string())?;
    let mut found = found;
    if let Some(previous_default) = lock.iter().find(|instance| instance.is_default) {
        if let Some(instance) = found
            .iter_mut()
            .find(|instance| instance.id == previous_default.id)
        {
            instance.is_default = true;
        }
    }
    if !found.is_empty() && !found.iter().any(|instance| instance.is_default) {
        found[0].is_default = true;
    }
    *lock = found.clone();
    Ok(found)
}

#[tauri::command]
async fn list_conda_instances(state: State<'_, AppState>) -> Result<Vec<CondaInstance>, String> {
    let is_empty = state
        .instances
        .lock()
        .map_err(|error| error.to_string())?
        .is_empty();
    if is_empty {
        return discover_conda_instances(state).await;
    }
    state
        .instances
        .lock()
        .map(|instances| instances.clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_environments(
    instance_id: String,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<EnvironmentSummary>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let force = force.unwrap_or(false);
    if !force {
        if let Ok(cache) = state.env_cache.lock() {
            if let Some(cached) = cache.get(&instance_id) {
                if now_millis().saturating_sub(cached.fetched_at) < ENV_CACHE_TTL_MS {
                    return Ok(cached.environments.clone());
                }
            }
        }
    }
    let mut environments = list_environments_inner(&instance)
        .map_err(|error| error.to_string())?;
    environments.sort_by(|a, b| {
        (!a.is_base)
            .cmp(&(!b.is_base))
            .then_with(|| a.name.cmp(&b.name))
    });
    if let Ok(mut cache) = state.env_cache.lock() {
        cache.insert(
            instance_id,
            CachedEnvironments {
                fetched_at: now_millis(),
                environments: environments.clone(),
            },
        );
    }
    Ok(environments)
}

/// 使指定实例的环境列表缓存失效（写操作后调用）。
fn invalidate_env_cache(state: &AppState, instance_id: &str) {
    if let Ok(mut cache) = state.env_cache.lock() {
        cache.remove(instance_id);
    }
}

fn list_environments_inner(instance: &CondaInstance) -> Result<Vec<EnvironmentSummary>, AppError> {
    let json = run_json(&instance_executable(instance), &["env", "list", "--json"])?;
    let prefixes = json
        .get("envs")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::Parse("Conda response is missing envs".into()))?;
    let root = PathBuf::from(&instance.root_prefix);
    let mut environments = Vec::new();
    for value in prefixes {
        let Some(prefix) = value.as_str() else {
            continue;
        };
        let prefix_path = PathBuf::from(prefix);
        let is_base = same_path(&prefix_path, &root);
        let name = if is_base {
            Some("base".to_string())
        } else {
            prefix_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        };
        let (python_version, package_count) = read_env_meta(&prefix_path);
        let size_bytes = dir_size(&prefix_path);
        environments.push(EnvironmentSummary {
            instance_id: instance.id.clone(),
            name,
            prefix: prefix.into(),
            is_base,
            python_version,
            package_count,
            platform: Some(instance.platform.clone()),
            size_bytes,
        });
    }
    Ok(environments)
}

/// 通过直接读取环境的 `conda-meta` 目录来快速获取 Python 版本与包数量，
/// 避免为每个环境启动一次 `conda list` 子进程（这是环境列表页变慢的主因）。
///
/// `conda-meta` 下每个 `.json` 文件对应一个 conda 包；`python-<version>-*.json`
/// 的文件名即携带 Python 版本。此统计不含 pip 安装的包，仅用于概览展示。
fn read_env_meta(prefix: &Path) -> (Option<String>, Option<usize>) {
    let conda_meta = prefix.join("conda-meta");
    let Ok(entries) = std::fs::read_dir(&conda_meta) else {
        return (None, None);
    };
    let mut count = 0usize;
    let mut python_version = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".json") {
            continue;
        }
        count += 1;
        if python_version.is_none() {
            if let Some(rest) = file_name.strip_prefix("python-") {
                if let Some(version) = rest.split('-').next() {
                    python_version = Some(version.to_string());
                }
            }
        }
    }
    (python_version, Some(count))
}

/// 递归计算环境目录占用的磁盘空间（字节）。
/// 跳过 `pkgs` 子目录（那是 conda 下载缓存，不属于环境安装的包）。
fn dir_size(prefix: &Path) -> Option<u64> {
    fn walk(path: &Path, total: &mut u64) {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if path.file_name().and_then(|name| name.to_str()) == Some("pkgs") {
                    continue;
                }
                walk(&path, total);
            } else if file_type.is_file() {
                if let Ok(meta) = entry.metadata() {
                    *total += meta.len();
                }
            }
        }
    }
    if !prefix.is_dir() {
        return None;
    }
    let mut total = 0u64;
    walk(prefix, &mut total);
    Some(total)
}

#[tauri::command]
async fn list_packages(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<Vec<PackageRecord>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let prefix_path = PathBuf::from(&prefix);
    let root_path = PathBuf::from(&instance.root_prefix);
    if !prefix_path.is_absolute() {
        return Err("Environment path must be absolute".into());
    }
    let known = run_json(&instance_executable(&instance), &["env", "list", "--json"])
        .map_err(|error| error.to_string())?;
    let belongs = known
        .get("envs")
        .and_then(|value| value.as_array())
        .is_some_and(|envs| {
            envs.iter()
                .filter_map(|item| item.as_str())
                .any(|path| same_path(Path::new(path), &prefix_path))
        });
    if !belongs {
        return Err("Environment does not belong to the selected Conda instance".into());
    }
    let _is_base = same_path(&prefix_path, &root_path);
    let prefix_arg = prefix_path.to_string_lossy().to_string();
    let json = run_json(
        &instance_executable(&instance),
        &["list", "-p", &prefix_arg, "--json"],
    )
    .map_err(|error| error.to_string())?;
    let records = json
        .as_array()
        .ok_or_else(|| "Conda response is not a package array".to_string())?;
    Ok(records
        .iter()
        .filter_map(|item| {
            Some(PackageRecord {
                name: item.get("name")?.as_str()?.to_string(),
                version: item
                    .get("version")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                build: item
                    .get("build_string")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                channel: item
                    .get("channel")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                package_type: if item.get("channel").and_then(|value| value.as_str())
                    == Some("pypi")
                {
                    "pip"
                } else {
                    "conda"
                }
                .into(),
            })
        })
        .collect())
}

fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    normalize(left) == normalize(right)
}

#[tauri::command]
async fn start_delete_environment(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let target = PathBuf::from(&prefix);
    if same_path(&target, Path::new(&instance.root_prefix)) {
        return Err(AppError::BaseEnvironment.to_string());
    }
    if !target.is_absolute() {
        return Err("Environment path must be absolute".into());
    }
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| prefix.clone());
    let started = now_millis();
    let record = record_operation(&state, "delete_environment", &name, "running", "正在删除环境…", started);
    let executable = instance_executable(&instance);
    let output = run_command(
        &executable,
        &vec![
            "env".to_string(),
            "remove".to_string(),
            "-p".to_string(),
            prefix.clone(),
            "-y".to_string(),
        ],
    )
    .map_err(|error| {
        update_operation(&state, record.id, "failed", &error.to_string());
        error.to_string()
    })?;
    if output.status.success() {
        update_operation(&state, record.id, "succeeded", "环境已删除");
        invalidate_env_cache(&state, &instance_id);
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        update_operation(&state, record.id, "failed", &detail);
        Err(detail)
    }
}

#[tauri::command]
async fn create_environment(
    instance_id: String,
    request: CreateEnvironmentRequest,
    state: State<'_, AppState>,
) -> Result<EnvironmentSummary, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if !valid_env_name(&request.name) {
        return Err(AppError::InvalidName.to_string());
    }
    let executable = instance_executable(&instance);
    let mut args: Vec<String> = vec![
        "create".to_string(),
        "-n".to_string(),
        request.name.clone(),
        "-y".to_string(),
    ];
    if let Some(version) = &request.python_version {
        args.push(format!("python={version}"));
    }
    for channel in &request.channels {
        args.push("-c".to_string());
        args.push(channel.clone());
    }
    for package in &request.packages {
        args.push(package.clone());
    }
    let started = now_millis();
    let record = record_operation(&state, "create_environment", &request.name, "running", "正在创建环境…", started);
    let output = run_command(&executable, &args).map_err(|error| {
        update_operation(&state, record.id, "failed", &error.to_string());
        error.to_string()
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        update_operation(&state, record.id, "failed", &detail);
        return Err(detail);
    }
    update_operation(&state, record.id, "succeeded", "环境已创建");
    invalidate_env_cache(&state, &instance_id);
    let mut environments = list_environments_inner(&instance)
        .map_err(|error| error.to_string())?;
    environments.sort_by(|a, b| (!a.is_base).cmp(&(!b.is_base)).then_with(|| a.name.cmp(&b.name)));
    environments
        .into_iter()
        .find(|environment| environment.name.as_deref() == Some(request.name.as_str()))
        .ok_or_else(|| "环境创建成功，但未能读取其信息，请刷新列表。".to_string())
}

#[tauri::command]
async fn export_environment_yaml(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let target = PathBuf::from(&prefix);
    if !target.is_absolute() {
        return Err("Environment path must be absolute".into());
    }
    let executable = instance_executable(&instance);
    let output = run_command(
        &executable,
        &vec![
            "env".to_string(),
            "export".to_string(),
            "-p".to_string(),
            prefix.clone(),
        ],
    )
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(detail);
    }
    let yaml = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    Ok(yaml)
}

#[tauri::command]
async fn install_packages(
    instance_id: String,
    prefix: String,
    packages: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let target = PathBuf::from(&prefix);
    if !target.is_absolute() {
        return Err("Environment path must be absolute".into());
    }
    if packages.is_empty() {
        return Err("请至少输入一个包名".into());
    }
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| prefix.clone());
    let executable = instance_executable(&instance);
    let mut args = vec![
        "install".to_string(),
        "-p".to_string(),
        prefix.clone(),
        "-y".to_string(),
    ];
    args.extend(packages.clone());
    let started = now_millis();
    let record = record_operation(&state, "install_packages", &name, "running", "正在安装包…", started);
    let output = run_command(&executable, &args).map_err(|error| {
        update_operation(&state, record.id, "failed", &error.to_string());
        error.to_string()
    })?;
    if output.status.success() {
        update_operation(&state, record.id, "succeeded", &format!("已安装 {}", packages.join(", ")));
        invalidate_env_cache(&state, &instance_id);
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        update_operation(&state, record.id, "failed", &detail);
        Err(detail)
    }
}

#[tauri::command]
async fn remove_packages(
    instance_id: String,
    prefix: String,
    packages: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let target = PathBuf::from(&prefix);
    if !target.is_absolute() {
        return Err("Environment path must be absolute".into());
    }
    if packages.is_empty() {
        return Err("请至少输入一个包名".into());
    }
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| prefix.clone());
    let executable = instance_executable(&instance);
    let mut args = vec![
        "remove".to_string(),
        "-p".to_string(),
        prefix.clone(),
        "-y".to_string(),
    ];
    args.extend(packages.clone());
    let started = now_millis();
    let record = record_operation(&state, "remove_packages", &name, "running", "正在卸载包…", started);
    let output = run_command(&executable, &args).map_err(|error| {
        update_operation(&state, record.id, "failed", &error.to_string());
        error.to_string()
    })?;
    if output.status.success() {
        update_operation(&state, record.id, "succeeded", &format!("已卸载 {}", packages.join(", ")));
        invalidate_env_cache(&state, &instance_id);
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        update_operation(&state, record.id, "failed", &detail);
        Err(detail)
    }
}

#[tauri::command]
async fn search_packages(
    instance_id: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let executable = instance_executable(&instance);
    let json = run_json(&executable, &["search", trimmed, "--json"])
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for (name, value) in json.as_object().into_iter().flatten() {
        let versions = value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let version = item.get("version")?.as_str()?.to_string();
                        let channel = item
                            .get("channel")
                            .and_then(|channel| channel.as_str())
                            .map(String::from)
                            .unwrap_or_default();
                        Some(SearchResult {
                            name: name.clone(),
                            version,
                            channel,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Some(latest) = versions.last() {
            results.push(latest.clone());
        }
    }
    results.sort_by(|a, b| a.name.cmp(&b.name));
    results.truncate(100);
    Ok(results)
}

#[tauri::command]
async fn list_package_versions(
    instance_id: String,
    package: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let trimmed = package.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let executable = instance_executable(&instance);
    let json = run_json(&executable, &["search", trimmed, "--json"])
        .map_err(|error| error.to_string())?;
    let mut versions: Vec<SearchResult> = Vec::new();
    if let Some(value) = json.get(trimmed) {
        if let Some(items) = value.as_array() {
            for item in items {
                let version = item
                    .get("version")
                    .and_then(|version| version.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let channel = item
                    .get("channel")
                    .and_then(|channel| channel.as_str())
                    .map(String::from)
                    .unwrap_or_default();
                versions.push(SearchResult {
                    name: trimmed.to_string(),
                    version,
                    channel,
                });
            }
        }
    }
    // conda search 返回升序，反转成最新在前
    versions.reverse();
    // 按「版本 + 渠道」去重
    let mut seen = HashSet::new();
    versions.retain(|item| seen.insert(format!("{}:{}", item.version, item.channel)));
    versions.truncate(100);
    Ok(versions)
}

#[tauri::command]
async fn get_channels(instance_id: String, state: State<'_, AppState>) -> Result<ChannelInfo, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    get_channels_inner(&instance).map_err(|error| error.to_string())
}

fn get_channels_inner(instance: &CondaInstance) -> Result<ChannelInfo, AppError> {
    let executable = instance_executable(instance);
    let json = run_json(&executable, &["config", "--get", "channels", "--json"])?;
    // conda config --get channels --json 的返回格式为 {"get": {"channels": [...]}}。
    // 兼容 `get` 为对象（含 channels 字段）或直接为数组的两种形态。
    let channels = json
        .get("get")
        .and_then(|get| {
            get.get("channels")
                .and_then(|value| value.as_array())
                .or_else(|| get.as_array())
        })
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ChannelInfo { channels })
}

/// 将 conda 渠道名解析为可用于连通性探测的目标 URL。
/// `defaults` 是 conda 内置别名，指向官方仓库；其余短名按 conda 默认
/// 渠道别名（Anaconda Cloud）推断为 `https://conda.anaconda.org/<name>`。
fn resolve_channel_target(channel: &str) -> String {
    let trimmed = channel.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed == "defaults" {
        "https://repo.anaconda.com/pkgs/main".to_string()
    } else if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://conda.anaconda.org/{trimmed}")
    }
}

/// 从 URL 中提取主机名与端口（HTTPS 默认 443，HTTP 默认 80）。
fn parse_host_port(url: &str) -> (String, u16) {
    let without_scheme = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    if let Some((host, port)) = authority.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            return (host.to_string(), port);
        }
    }
    let port = if url.starts_with("https://") { 443 } else { 80 };
    (authority.to_string(), port)
}

/// 对目标做一次 TCP 连接探测，返回 (是否可达, 延迟毫秒, 错误信息)。
fn probe_tcp(target: &str) -> (bool, Option<u64>, Option<String>) {
    let (host, port) = parse_host_port(target);
    let addresses = match (host.as_str(), port).to_socket_addrs() {
        Ok(addresses) => addresses.collect::<Vec<_>>(),
        Err(error) => return (false, None, Some(format!("解析地址失败: {error}"))),
    };
    if addresses.is_empty() {
        return (false, None, Some("无法解析主机地址".into()));
    }
    let start = Instant::now();
    for address in addresses {
        if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
            drop(stream);
            let latency_ms = start.elapsed().as_millis() as u64;
            return (true, Some(latency_ms), None);
        }
    }
    (false, None, Some("连接超时或拒绝".into()))
}

#[tauri::command]
async fn test_channel_connectivity(
    instance_id: String,
    channel: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ChannelTestResult>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let info = get_channels_inner(&instance).map_err(|error| error.to_string())?;
    // 传入 channel 时只测试那一个；否则测试全部已配置渠道。
    let targets: Vec<String> = match channel {
        Some(channel) => {
            let trimmed = channel.trim();
            if trimmed.is_empty() {
                return Err("渠道不能为空".into());
            }
            vec![trimmed.to_string()]
        }
        None => info.channels.clone(),
    };
    let mut results = Vec::with_capacity(targets.len());
    for channel in targets {
        let target = resolve_channel_target(&channel);
        let (reachable, latency_ms, error) = probe_tcp(&target);
        results.push(ChannelTestResult {
            channel,
            target,
            reachable,
            latency_ms,
            error,
        });
    }
    Ok(results)
}

#[tauri::command]
async fn add_channel(
    instance_id: String,
    channel: String,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let trimmed = channel.trim();
    if trimmed.is_empty() {
        return Err("渠道名称不能为空".into());
    }
    let executable = instance_executable(&instance);
    let output = run_command(&executable, &vec![
        "config".to_string(),
        "--add".to_string(),
        "channels".to_string(),
        trimmed.to_string(),
    ])
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(detail);
    }
    get_channels(instance_id, state).await
}

#[tauri::command]
async fn remove_channel(
    instance_id: String,
    channel: String,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let trimmed = channel.trim();
    if trimmed.is_empty() {
        return Err("渠道名称不能为空".into());
    }
    let executable = instance_executable(&instance);
    let output = run_command(&executable, &vec![
        "config".to_string(),
        "--remove".to_string(),
        "channels".to_string(),
        trimmed.to_string(),
    ])
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(detail);
    }
    get_channels(instance_id, state).await
}

#[tauri::command]
async fn list_operations(state: State<'_, AppState>) -> Result<Vec<OperationRecord>, String> {
    let mut operations = state
        .operations
        .lock()
        .map(|operations| operations.clone())
        .map_err(|error| error.to_string())?;
    operations.reverse();
    Ok(operations)
}

#[tauri::command]
async fn open_environment_terminal(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let target = PathBuf::from(&prefix);
    let is_base = same_path(&target, Path::new(&instance.root_prefix));
    let activate_name = if is_base {
        "base".to_string()
    } else {
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string()
    };
    let hook = PathBuf::from(&instance.root_prefix)
        .join("shell")
        .join("condabin")
        .join("conda-hook.ps1");
    // 优先通过 conda 的 PowerShell hook 脚本初始化并激活环境；
    // 若 hook 不存在则回退到直接调用 conda activate（依赖用户已 conda init）。
    let script = if hook.exists() {
        format!(
            "& '{}'; conda activate '{}'",
            hook.display(),
            activate_name
        )
    } else {
        format!("conda activate '{}'", activate_name)
    };
    // 默认工作目录设为 Windows 用户主目录（USERPROFILE），
    // 而不是继承本应用进程（cargo run）的当前项目目录。
    let home_dir = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE：在独立新窗口打开
    if let Some(home) = home_dir {
        command.current_dir(home);
    }
    command
        .spawn()
        .map_err(|error| format!("无法打开 PowerShell 窗口: {error}"))?;
    Ok(())
}

pub fn run() {
    let operations_file = operations_file_path();
    let mut state = AppState::default();
    if let Some(path) = &operations_file {
        let mut loaded = load_operations(path);
        // 应用退出时仍处于 running 的记录，视为被中断的操作。
        for record in loaded.iter_mut() {
            if record.status == "running" {
                record.status = "failed".into();
                record.summary = "应用退出，操作未完成".into();
                record.finished_at = Some(record.finished_at.unwrap_or_else(now_millis));
            }
        }
        let max_id = loaded.iter().map(|record| record.id).max().unwrap_or(0);
        state.next_operation_id.store(max_id + 1, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut operations) = state.operations.lock() {
            *operations = loaded;
        }
    }
    state.operations_file = operations_file;
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            discover_conda_instances,
            list_conda_instances,
            list_environments,
            list_packages,
            start_delete_environment,
            create_environment,
            export_environment_yaml,
            install_packages,
            remove_packages,
            search_packages,
            list_package_versions,
            get_channels,
            add_channel,
            remove_channel,
            test_channel_connectivity,
            list_operations,
            open_environment_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running Easy Conda");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_is_case_insensitive_and_ignores_trailing_separator() {
        assert!(same_path(
            Path::new(r"C:\Conda\envs\base\"),
            Path::new(r"c:\conda\envs\base")
        ));
    }

    #[test]
    fn executable_kind_uses_file_name() {
        assert_eq!(
            executable_kind(Path::new(r"C:\tools\micromamba.exe")),
            "micromamba"
        );
        assert_eq!(executable_kind(Path::new(r"C:\tools\mamba.exe")), "mamba");
        assert_eq!(executable_kind(Path::new(r"C:\tools\conda.exe")), "conda");
    }
}
