use crate::lock_poison;
use crate::models::*;
use crate::{archive, conda, diagnostics, jobs, AppState};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

/// 在 Windows 上为新进程附加 CREATE_NEW_CONSOLE，使其在独立窗口运行；其它平台为 no-op。
#[cfg(target_os = "windows")]
fn with_new_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0000_0010);
}

#[cfg(not(target_os = "windows"))]
fn with_new_console(_command: &mut std::process::Command) {}

fn find_instance(state: &AppState, id: &str) -> Result<CondaInstance, AppError> {
    let instances = lock_poison(&state.instances);
    instances
        .iter()
        .find(|instance| instance.id == id)
        .cloned()
        .ok_or(AppError::InstanceNotFound)
}

fn preferences_file() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|base| base.join("easy-conda").join("preferences.json"))
}

fn load_default_instance_id() -> Option<String> {
    let path = preferences_file()?;
    let text = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("default_instance_id")
        .and_then(|value| value.as_str())
        .map(String::from)
}

fn save_default_instance_id(id: &str) {
    if let Some(path) = preferences_file() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::json!({ "default_instance_id": id });
        let _ = std::fs::write(
            path,
            serde_json::to_string_pretty(&json).unwrap_or_default(),
        );
    }
}

/// 从 preferences.json 读取已保存的激活环境映射（instance_id -> prefix）。
pub fn load_active_prefixes() -> std::collections::HashMap<String, String> {
    let Some(path) = preferences_file() else {
        return std::collections::HashMap::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return std::collections::HashMap::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return std::collections::HashMap::new();
    };
    let mut map = std::collections::HashMap::new();
    if let Some(entries) = json.get("active_prefixes").and_then(|value| value.as_object()) {
        for (instance_id, prefix) in entries {
            if let Some(prefix) = prefix.as_str() {
                map.insert(instance_id.clone(), prefix.to_string());
            }
        }
    }
    map
}

/// 将激活环境映射持久化到 preferences.json（合并 default_instance_id）。
fn save_active_prefixes(active: &std::collections::HashMap<String, String>) {
    let Some(path) = preferences_file() else {
        return;
    };
    let existing: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let mut obj = match existing {
        serde_json::Value::Object(map) => map,
        _ => Default::default(),
    };
    let active_json: serde_json::Map<String, serde_json::Value> = active
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    obj.insert("active_prefixes".to_string(), serde_json::Value::Object(active_json));
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        path,
        serde_json::to_string_pretty(&serde_json::Value::Object(obj)).unwrap_or_default(),
    );
}

fn target_name(prefix: &str) -> String {
    Path::new(prefix)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| prefix.to_string())
}

// ---------- 实例发现与选择 ----------

#[tauri::command]
pub async fn discover_conda_instances(state: State<'_, AppState>) -> Result<Vec<CondaInstance>, String> {
    let mut found = tauri::async_runtime::spawn_blocking(conda::discover)
        .await
        .map_err(|error| error.to_string())?;
    let saved_default = load_default_instance_id();
    let mut has_default = false;
    if let Some(id) = &saved_default {
        for instance in found.iter_mut() {
            if &instance.id == id {
                instance.is_default = true;
                has_default = true;
            }
        }
    }
    if !has_default && !found.is_empty() {
        found[0].is_default = true;
    }
    let mut lock = lock_poison(&state.instances);
    *lock = found.clone();
    Ok(found)
}

#[tauri::command]
pub async fn list_conda_instances(state: State<'_, AppState>) -> Result<Vec<CondaInstance>, String> {
    let is_empty = lock_poison(&state.instances).is_empty();
    if is_empty {
        return discover_conda_instances(state).await;
    }
    Ok(lock_poison(&state.instances).clone())
}

#[tauri::command]
pub async fn set_default_conda_instance(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<CondaInstance, String> {
    {
        let mut instances = lock_poison(&state.instances);
        let mut exists = false;
        for instance in instances.iter_mut() {
            instance.is_default = instance.id == instance_id;
            if instance.id == instance_id {
                exists = true;
            }
        }
        if !exists {
            return Err("实例不存在".to_string());
        }
    }
    save_default_instance_id(&instance_id);
    lock_poison(&state.instances)
        .iter()
        .find(|instance| instance.id == instance_id)
        .cloned()
        .ok_or_else(|| "实例不存在".to_string())
}

// ---------- 读取操作 ----------

#[tauri::command]
pub async fn list_environments(
    instance_id: String,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<EnvironmentSummary>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let force = force.unwrap_or(false);
    if !force {
        if let Some(cached) = state.jobs.get_env_cache(&instance_id) {
            return Ok(cached);
        }
    }
    let active_prefix = lock_poison(&state.active_prefixes)
        .get(&instance_id)
        .cloned();
    let jobs = state.jobs.clone();
    let id = instance_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut environments =
            conda::list_environments_inner(&instance).map_err(|error| error.to_string())?;
        for environment in &mut environments {
            environment.is_active = active_prefix
                .as_deref()
                .is_some_and(|active| conda::same_path(Path::new(active), Path::new(&environment.prefix)));
        }
        environments.sort_by(|a, b| {
            (!a.is_base)
                .cmp(&(!b.is_base))
                .then_with(|| a.name.cmp(&b.name))
        });
        jobs.set_env_cache(&id, environments.clone());
        Ok(environments)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn activate_environment(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<Vec<EnvironmentSummary>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    // 激活 base 等价于取消激活（无显式激活环境）。
    let is_base = conda::same_path(Path::new(&prefix), Path::new(&instance.root_prefix));
    {
        let mut active = lock_poison(&state.active_prefixes);
        if is_base {
            active.remove(&instance_id);
        } else {
            active.insert(instance_id.clone(), prefix.clone());
        }
        save_active_prefixes(&active);
    }
    state.jobs.invalidate_env_cache(&instance_id);
    list_environments(instance_id, Some(true), state).await
}

#[tauri::command]
pub async fn list_packages(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<Vec<PackageRecord>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        conda::list_packages_inner(&instance, &prefix).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn search_packages(
    instance_id: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        conda::search_packages_inner(&instance, &query).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_package_versions(
    instance_id: String,
    package: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        conda::list_package_versions_inner(&instance, &package).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_channels(instance_id: String, state: State<'_, AppState>) -> Result<ChannelInfo, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        conda::get_channels_inner(&instance).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn test_channel_connectivity(
    instance_id: String,
    channel: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ChannelTestResult>, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = conda::get_channels_inner(&instance).map_err(|error| error.to_string())?;
        let targets: Vec<String> = match channel {
            Some(channel) => {
                let trimmed = channel.trim().to_string();
                if trimmed.is_empty() {
                    return Err("渠道不能为空".to_string());
                }
                vec![trimmed]
            }
            None => info.channels.clone(),
        };
        let mut results = Vec::with_capacity(targets.len());
        for channel in targets {
            let target = conda::resolve_channel_target(&channel);
            let (reachable, latency_ms, error) = conda::probe_tcp(&target);
            results.push(ChannelTestResult {
                channel,
                target,
                reachable,
                latency_ms,
                error,
            });
        }
        Ok(results)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn add_channel(
    instance_id: String,
    channel: String,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let trimmed = channel.trim().to_string();
    if trimmed.is_empty() {
        return Err("渠道名称不能为空".to_string());
    }
    let output = tauri::async_runtime::spawn_blocking(move || {
        conda::run_command(
            &instance,
            &[
                "config".to_string(),
                "--add".to_string(),
                "channels".to_string(),
                trimmed.clone(),
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    get_channels(instance_id, state).await
}

#[tauri::command]
pub async fn remove_channel(
    instance_id: String,
    channel: String,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let trimmed = channel.trim().to_string();
    if trimmed.is_empty() {
        return Err("渠道名称不能为空".to_string());
    }
    let output = tauri::async_runtime::spawn_blocking(move || {
        conda::run_command(
            &instance,
            &[
                "config".to_string(),
                "--remove".to_string(),
                "channels".to_string(),
                trimmed.clone(),
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    get_channels(instance_id, state).await
}

// ---------- 求解预览（dry-run） ----------

fn build_create_args(request: &CreateEnvironmentRequest) -> Vec<String> {
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
    args
}

async fn run_dry_run_plan(
    instance: CondaInstance,
    args: Vec<String>,
) -> Result<OperationPlan, String> {
    let plan = tauri::async_runtime::spawn_blocking(move || conda::plan_dry_run(&instance, &args))
        .await
        .map_err(|error| error.to_string())?;
    match plan {
        Ok(plan) => Ok(plan),
        Err(error) => Ok(OperationPlan {
            supported: false,
            command: None,
            changes: Vec::new(),
            downloads: Vec::new(),
            warnings: vec![format!("无法生成预览：{error}")],
            fetch_bytes: None,
        }),
    }
}

#[tauri::command]
pub async fn plan_create_environment(
    instance_id: String,
    request: CreateEnvironmentRequest,
    state: State<'_, AppState>,
) -> Result<OperationPlan, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if !conda::valid_env_name(&request.name) {
        return Err(AppError::InvalidName.to_string());
    }
    let args = build_create_args(&request);
    run_dry_run_plan(instance, args).await
}

#[tauri::command]
pub async fn plan_install_packages(
    instance_id: String,
    prefix: String,
    packages: Vec<String>,
    state: State<'_, AppState>,
) -> Result<OperationPlan, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if packages.is_empty() {
        return Err("请至少输入一个包名".to_string());
    }
    let mut args = vec![
        "install".to_string(),
        "-p".to_string(),
        prefix,
        "-y".to_string(),
    ];
    args.extend(packages);
    run_dry_run_plan(instance, args).await
}

#[tauri::command]
pub async fn plan_remove_packages(
    instance_id: String,
    prefix: String,
    packages: Vec<String>,
    state: State<'_, AppState>,
) -> Result<OperationPlan, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if packages.is_empty() {
        return Err("请至少输入一个包名".to_string());
    }
    let mut args = vec![
        "remove".to_string(),
        "-p".to_string(),
        prefix,
        "-y".to_string(),
    ];
    args.extend(packages);
    run_dry_run_plan(instance, args).await
}

// ---------- 变更操作（异步任务） ----------

fn guard_not_base(instance: &CondaInstance, prefix: &str) -> Result<(), String> {
    if conda::same_path(Path::new(prefix), Path::new(&instance.root_prefix)) {
        return Err(AppError::BaseEnvironment.to_string());
    }
    if !conda::is_absolute_prefix(instance, prefix) {
        return Err("Environment path must be absolute".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn start_create_environment(
    instance_id: String,
    request: CreateEnvironmentRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if !conda::valid_env_name(&request.name) {
        return Err(AppError::InvalidName.to_string());
    }
    let args = build_create_args(&request);
    let lock_key = Some(format!("create:{}:{}", instance.root_prefix, request.name));
    let summary = format!("环境 {} 已创建", request.name);
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "create_environment",
        request.name.clone(),
        None,
        lock_key,
        conda::conda_argv(&instance, &args),
        summary,
        Some(instance_id),
    ))
}

#[tauri::command]
pub async fn start_delete_environment(
    instance_id: String,
    prefix: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    guard_not_base(&instance, &prefix)?;
    let name = target_name(&prefix);
    let args = vec![
        "env".to_string(),
        "remove".to_string(),
        "-p".to_string(),
        prefix.clone(),
        "-y".to_string(),
    ];
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "delete_environment",
        name,
        Some(prefix.clone()),
        Some(prefix.clone()),
        conda::conda_argv(&instance, &args),
        "环境已删除".to_string(),
        Some(instance_id),
    ))
}

#[tauri::command]
pub async fn start_install_packages(
    instance_id: String,
    prefix: String,
    packages: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    guard_not_base(&instance, &prefix)?;
    if packages.is_empty() {
        return Err("请至少输入一个包名".to_string());
    }
    let name = target_name(&prefix);
    let mut args = vec![
        "install".to_string(),
        "-p".to_string(),
        prefix.clone(),
        "-y".to_string(),
    ];
    args.extend(packages.clone());
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "install_packages",
        name,
        Some(prefix.clone()),
        Some(prefix.clone()),
        conda::conda_argv(&instance, &args),
        format!("已安装 {}", packages.join(", ")),
        Some(instance_id),
    ))
}

#[tauri::command]
pub async fn start_remove_packages(
    instance_id: String,
    prefix: String,
    packages: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    guard_not_base(&instance, &prefix)?;
    if packages.is_empty() {
        return Err("请至少输入一个包名".to_string());
    }
    let name = target_name(&prefix);
    let mut args = vec![
        "remove".to_string(),
        "-p".to_string(),
        prefix.clone(),
        "-y".to_string(),
    ];
    args.extend(packages.clone());
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "remove_packages",
        name,
        Some(prefix.clone()),
        Some(prefix.clone()),
        conda::conda_argv(&instance, &args),
        format!("已卸载 {}", packages.join(", ")),
        Some(instance_id),
    ))
}

#[tauri::command]
pub async fn start_clone_environment(
    instance_id: String,
    source_prefix: String,
    target_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if !conda::valid_env_name(&target_name) {
        return Err(AppError::InvalidName.to_string());
    }
    let args = vec![
        "create".to_string(),
        "-n".to_string(),
        target_name.clone(),
        "--clone".to_string(),
        source_prefix,
        "-y".to_string(),
    ];
    let lock_key = Some(format!("create:{}:{}", instance.root_prefix, target_name));
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "clone_environment",
        target_name.clone(),
        None,
        lock_key,
        conda::conda_argv(&instance, &args),
        format!("环境 {target_name} 已克隆"),
        Some(instance_id),
    ))
}

// ---------- 导入 / 导出 ----------

#[tauri::command]
pub async fn export_environment_yaml(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        archive::export_yaml(&instance, &prefix).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn export_environment_yaml_to_file(
    instance_id: String,
    prefix: String,
    destination: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let yaml = archive::export_yaml(&instance, &prefix).map_err(|error| error.to_string())?;
        archive::write_file_atomic(Path::new(&destination), &yaml).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn export_explicit_spec(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        archive::export_explicit(&instance, &prefix).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn export_explicit_spec_to_file(
    instance_id: String,
    prefix: String,
    destination: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let spec =
            archive::export_explicit(&instance, &prefix).map_err(|error| error.to_string())?;
        archive::write_file_atomic(Path::new(&destination), &spec)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn parse_yaml_preview(source: String) -> Result<YamlPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive::parse_yaml_preview(Path::new(&source)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn import_environment_yaml(
    instance_id: String,
    source: String,
    target_name: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let name = match target_name {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => {
            let preview = archive::parse_yaml_preview(Path::new(&source))
                .map_err(|error| error.to_string())?;
            preview.name.unwrap_or_else(|| {
                Path::new(&source)
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "imported-env".to_string())
            })
        }
    };
    if !conda::valid_env_name(&name) {
        return Err(AppError::InvalidName.to_string());
    }
    let args = vec![
        "env".to_string(),
        "create".to_string(),
        "-n".to_string(),
        name.clone(),
        "-f".to_string(),
        source,
    ];
    let lock_key = Some(format!("create:{}:{}", instance.root_prefix, name));
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "import_environment",
        name,
        None,
        lock_key,
        conda::conda_argv(&instance, &args),
        "环境导入完成".to_string(),
        Some(instance_id),
    ))
}

#[tauri::command]
pub async fn import_explicit_spec(
    instance_id: String,
    prefix: String,
    source: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if !conda::is_absolute_prefix(&instance, &prefix) {
        return Err("Environment path must be absolute".to_string());
    }
    let name = target_name(&prefix);
    let args = vec![
        "create".to_string(),
        "-p".to_string(),
        prefix.clone(),
        "--file".to_string(),
        source,
        "-y".to_string(),
    ];
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "import_explicit",
        name,
        Some(prefix.clone()),
        Some(prefix.clone()),
        conda::conda_argv(&instance, &args),
        "环境已从 explicit spec 创建".to_string(),
        Some(instance_id),
    ))
}

// ---------- 任务中心 ----------

#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>) -> Result<Vec<Job>, String> {
    Ok(state.jobs.list())
}

#[tauri::command]
pub async fn cancel_job(job_id: u64, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.jobs.request_cancel(&app, job_id)
}

// ---------- 诊断、缓存与离线（P1/P2） ----------

#[tauri::command]
pub async fn get_diagnostics(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<DiagnosticReport, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics::build_diagnostics(&instance).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clean_cache(
    instance_id: String,
    kind: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let (flag, job_kind) = match kind.as_str() {
        "packages" => ("--packages", "clean_packages"),
        "tarballs" => ("--tarballs", "clean_tarballs"),
        _ => ("--all", "clean_cache"),
    };
    let target = match instance.wsl_distro() {
        Some(distro) => format!("WSL · {distro}"),
        None => "本地 Windows".to_string(),
    };
    let args = vec!["clean".to_string(), flag.to_string(), "-y".to_string()];
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        job_kind,
        target,
        None,
        None,
        conda::conda_argv(&instance, &args),
        "缓存清理完成".to_string(),
        None,
    ))
}

#[tauri::command]
pub async fn build_offline_channel(
    instance_id: String,
    prefix: String,
    destination: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let spec = tauri::async_runtime::spawn_blocking({
        let instance = instance.clone();
        let prefix = prefix.clone();
        move || archive::export_explicit(&instance, &prefix).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let dest = PathBuf::from(&destination);
    std::fs::create_dir_all(&dest).map_err(|error| error.to_string())?;
    let spec_path = dest.join("explicit-spec.txt");
    archive::write_file_atomic(&spec_path, &spec).map_err(|error| error.to_string())?;
    let manifest = format!(
        "# Easy Conda 离线交付清单\n目标平台: {}\n生成时间: {}\n说明: 离线重建需在目标机执行\n  conda install -p <prefix> --download-only --file explicit-spec.txt\n然后 `conda index <本目录>` 构建本地 channel。\n",
        instance.platform,
        now_millis()
    );
    archive::write_file_atomic(&dest.join("README.txt"), &manifest).map_err(|error| error.to_string())?;

    let name = target_name(&prefix);
    let args = vec![
        "install".to_string(),
        "-p".to_string(),
        prefix.clone(),
        "--download-only".to_string(),
        "--file".to_string(),
        spec_path.to_string_lossy().into_owned(),
        "-y".to_string(),
    ];
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "build_offline_channel",
        name,
        Some(prefix.clone()),
        Some(prefix.clone()),
        conda::conda_argv(&instance, &args),
        "离线包已下载（见 explicit-spec.txt）".to_string(),
        None,
    ))
}

#[tauri::command]
pub async fn build_wheelhouse(
    instance_id: String,
    prefix: String,
    destination: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    if instance.wsl_distro().is_some() {
        return Err("WSL 环境暂不支持构建 wheelhouse".to_string());
    }
    let python = Path::new(&prefix).join("python.exe");
    if !python.is_file() {
        return Err("环境中未找到 python.exe".to_string());
    }
    let req = tauri::async_runtime::spawn_blocking({
        let python = python.clone();
        move || {
            let mut command = std::process::Command::new(&python);
            command.args(["-m", "pip", "freeze"]);
            conda::no_console_window(&mut command);
            let output = command
                .output()
                .map_err(|error| error.to_string())?;
            Ok::<String, String>(String::from_utf8_lossy(&output.stdout).into_owned())
        }
    })
    .await
    .map_err(|error| error.to_string())??;
    let dest = PathBuf::from(&destination);
    std::fs::create_dir_all(&dest).map_err(|error| error.to_string())?;
    let req_path = dest.join("requirements.txt");
    archive::write_file_atomic(&req_path, &req).map_err(|error| error.to_string())?;

    let name = target_name(&prefix);
    let args = vec![
        "-m".to_string(),
        "pip".to_string(),
        "download".to_string(),
        "-r".to_string(),
        req_path.to_string_lossy().into_owned(),
        "-d".to_string(),
        dest.to_string_lossy().into_owned(),
    ];
    let mut argv = vec![python.to_string_lossy().into_owned()];
    argv.extend(args);
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "build_wheelhouse",
        name,
        Some(prefix.clone()),
        Some(prefix.clone()),
        argv,
        "wheelhouse 已构建（仅覆盖 pip 依赖）".to_string(),
        None,
    ))
}

#[tauri::command]
pub async fn conda_pack_environment(
    instance_id: String,
    prefix: String,
    destination: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let pack = conda::find_conda_pack(&instance)
        .ok_or_else(|| "未找到 conda-pack，请先在环境内 `conda install conda-pack`".to_string())?;
    let name = target_name(&prefix);
    let args = vec![
        "-p".to_string(),
        prefix.clone(),
        "-o".to_string(),
        destination,
    ];
    let mut argv = vec![pack.to_string_lossy().into_owned()];
    argv.extend(args);
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "conda_pack",
        name,
        Some(prefix.clone()),
        Some(prefix.clone()),
        argv,
        "环境已打包".to_string(),
        None,
    ))
}

// ---------- 终端 ----------

#[tauri::command]
pub async fn open_environment_terminal(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    let target = PathBuf::from(&prefix);
    let is_base = conda::same_path(&target, Path::new(&instance.root_prefix));
    let activate_name = if is_base {
        "base".to_string()
    } else {
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string()
    };

    if let Some(distro) = instance.wsl_distro() {
        // WSL：在发行版内 source conda.sh 并激活环境，新开一个窗口。
        let script = format!(
            "source \"{}/etc/profile.d/conda.sh\" 2>/dev/null || true; conda activate \"{}\"; exec bash",
            instance.root_prefix, activate_name
        );
        let mut command = std::process::Command::new("wsl.exe");
        command.args(["-d", distro, "--", "bash", "-lc", &script]);
        with_new_console(&mut command);
        command
            .spawn()
            .map_err(|error| format!("无法打开 WSL 终端: {error}"))?;
        return Ok(());
    }

    open_local_terminal(&instance.root_prefix, &activate_name)
}

/// 在 Windows 上打开本机环境的终端（PowerShell + conda-hook）。
#[cfg(target_os = "windows")]
fn open_local_terminal(root_prefix: &str, activate_name: &str) -> Result<(), String> {
    let hook = PathBuf::from(root_prefix)
        .join("shell")
        .join("condabin")
        .join("conda-hook.ps1");
    let script = if hook.exists() {
        format!("& '{}'; conda activate '{}'", hook.display(), activate_name)
    } else {
        format!("conda activate '{}'", activate_name)
    };
    let home_dir = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", &script]);
    with_new_console(&mut command);
    if let Some(home) = home_dir {
        command.current_dir(home);
    }
    command
        .spawn()
        .map_err(|error| format!("无法打开 PowerShell 窗口: {error}"))?;
    Ok(())
}

/// 在 macOS 上打开本机环境的终端（Terminal.app）。
#[cfg(target_os = "macos")]
fn open_local_terminal(root_prefix: &str, activate_name: &str) -> Result<(), String> {
    let script = format!(
        "source \"{}/etc/profile.d/conda.sh\" 2>/dev/null || true; conda activate \"{}\"; exec bash",
        root_prefix, activate_name
    );
    std::process::Command::new("osascript")
        .args(["-e", &format!("tell application \"Terminal\" to do script \"{}\"", script)])
        .spawn()
        .map_err(|error| format!("无法打开终端: {error}"))?;
    Ok(())
}

/// 在 Linux 上打开本机环境的终端（x-terminal-emulator）。
#[cfg(all(unix, not(target_os = "macos")))]
fn open_local_terminal(root_prefix: &str, activate_name: &str) -> Result<(), String> {
    let script = format!(
        "source \"{}/etc/profile.d/conda.sh\" 2>/dev/null || true; conda activate \"{}\"; exec bash",
        root_prefix, activate_name
    );
    std::process::Command::new("x-terminal-emulator")
        .args(["-e", "bash", "-lc", &script])
        .spawn()
        .map_err(|error| format!("无法打开终端: {error}"))?;
    Ok(())
}

/// 在文件管理器中打开环境目录。
#[tauri::command]
pub async fn open_environment_directory(
    instance_id: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let instance = find_instance(&state, &instance_id).map_err(|error| error.to_string())?;
    // WSL 目标需通过 \\wsl$\<distro> UNC 路径打开。
    let target = conda::fs_path(&instance, &prefix);
    if !target.is_dir() {
        return Err("环境目录不存在或不可访问".to_string());
    }
    open_in_file_manager(&target)
}

#[cfg(target_os = "windows")]
fn open_in_file_manager(target: &Path) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(target.to_string_lossy().into_owned())
        .spawn()
        .map_err(|error| format!("无法打开目录: {error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_in_file_manager(target: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(target)
        .spawn()
        .map_err(|error| format!("无法打开目录: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_file_manager(target: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map_err(|error| format!("无法打开目录: {error}"))?;
    Ok(())
}

// ---------- 安装引导（无 Conda 时） ----------

const MINIFORGE_FILENAME: &str = "Miniforge3-Windows-x86_64.exe";

/// 官方与国内镜像下载源列表。`LatestRelease` 目录会自动指向最新版本。
const MINIFORGE_SOURCES: &[(&str, &str, &str, bool)] = &[
    (
        "tuna",
        "清华 TUNA 镜像（推荐）",
        "https://mirrors.tuna.tsinghua.edu.cn/github-release/conda-forge/miniforge/LatestRelease/Miniforge3-Windows-x86_64.exe",
        true,
    ),
    (
        "nju",
        "南京大学镜像",
        "https://mirrors.nju.edu.cn/github-release/conda-forge/miniforge/LatestRelease/Miniforge3-Windows-x86_64.exe",
        false,
    ),
    (
        "bfsu",
        "北京外国语大学镜像",
        "https://mirrors.bfsu.edu.cn/github-release/conda-forge/miniforge/LatestRelease/Miniforge3-Windows-x86_64.exe",
        false,
    ),
    (
        "github",
        "GitHub 官方",
        "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Windows-x86_64.exe",
        false,
    ),
];

#[tauri::command]
pub async fn get_install_info() -> Result<InstallInfo, String> {
    let sources = MINIFORGE_SOURCES
        .iter()
        .map(|(id, label, url, recommended)| InstallSource {
            id: id.to_string(),
            label: label.to_string(),
            download_url: url.to_string(),
            recommended: *recommended,
        })
        .collect();
    Ok(InstallInfo {
        name: "Miniforge3".to_string(),
        version: "latest".to_string(),
        arch: "x86_64".to_string(),
        filename: MINIFORGE_FILENAME.to_string(),
        license: "BSD-3-Clause".to_string(),
        description:
            "Miniforge 是社区维护的轻量 Conda 发行版，默认使用 conda-forge 渠道，安装包更小、无需商业订阅。"
                .to_string(),
        sources,
    })
}

#[tauri::command]
pub async fn start_download_installer(
    destination: String,
    url: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, String> {
    let curl = conda::find_executable("curl")
        .ok_or_else(|| "未找到 curl，无法下载安装器。".to_string())?;
    let dest = PathBuf::from(&destination);
    if dest.extension().and_then(|value| value.to_str()) != Some("exe") {
        return Err("保存路径必须以 .exe 结尾".to_string());
    }
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() || (!trimmed_url.starts_with("https://") && !trimmed_url.starts_with("http://")) {
        return Err("下载地址无效".to_string());
    }
    let args = vec![
        "-L".to_string(),
        "--fail".to_string(),
        "--output".to_string(),
        destination.clone(),
        trimmed_url.to_string(),
    ];
    let filename = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| destination.clone());
    let mut argv = vec![curl.to_string_lossy().into_owned()];
    argv.extend(args);
    Ok(jobs::submit(
        state.jobs.clone(),
        app,
        "download_installer",
        filename,
        None,
        None,
        argv,
        "安装器已下载完成".to_string(),
        None,
    ))
}

#[tauri::command]
pub async fn launch_installer(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err("安装器文件不存在".to_string());
    }
    std::process::Command::new(&target)
        .spawn()
        .map_err(|error| format!("无法启动安装器: {error}"))?;
    Ok(())
}
