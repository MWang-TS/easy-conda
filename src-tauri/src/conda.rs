use crate::models::*;
use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

/// 根据实例的运行目标（Windows 或 WSL 发行版）构建 conda 子进程。
/// 参数以独立 argv 传入，不经 shell 拼接。
fn build_command(instance: &CondaInstance) -> Command {
    if let Some(distro) = instance.wsl_distro() {
        let mut command = Command::new("wsl.exe");
        command.arg("-d").arg(distro).arg("--").arg(&instance.executable_path);
        command
    } else {
        Command::new(&instance.executable_path)
    }
}

/// 构建完整 argv（程序 + 参数），供异步任务系统直接执行。
pub fn conda_argv(instance: &CondaInstance, args: &[String]) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    if let Some(distro) = instance.wsl_distro() {
        argv.push("wsl.exe".to_string());
        argv.push("-d".to_string());
        argv.push(distro.to_string());
        argv.push("--".to_string());
    }
    argv.push(instance.executable_path.clone());
    argv.extend(args.iter().cloned());
    argv
}

pub fn run_json(instance: &CondaInstance, args: &[&str]) -> Result<serde_json::Value, AppError> {
    let mut command = build_command(instance);
    command.args(args);
    let output = command
        .output()
        .map_err(|error| AppError::Command(format!("{}: {error}", instance.executable_path)))?;
    parse_output(output)
}

pub fn parse_output(output: Output) -> Result<serde_json::Value, AppError> {
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

pub fn run_command(instance: &CondaInstance, args: &[String]) -> Result<Output, AppError> {
    let mut command = build_command(instance);
    command.args(args);
    command
        .output()
        .map_err(|error| AppError::Command(format!("{}: {error}", instance.executable_path)))
}

/// 判断一个环境前缀是否为绝对路径（对 WSL 目标按 Linux 语义判断）。
pub fn is_absolute_prefix(instance: &CondaInstance, prefix: &str) -> bool {
    if instance.wsl_distro().is_some() {
        prefix.starts_with('/')
    } else {
        Path::new(prefix).is_absolute()
    }
}

/// 将实例内环境前缀转换为可在 Windows 侧直接访问的文件系统路径。
/// WSL 的 Linux 路径映射为 `\\wsl$\<distro>\<linux-path>` UNC 路径。
pub fn fs_path(instance: &CondaInstance, prefix: &str) -> PathBuf {
    if let Some(distro) = instance.wsl_distro() {
        let rel = prefix.trim_start_matches('/').replace('/', "\\");
        PathBuf::from(format!(r"\\wsl$\{}\{}", distro, rel))
    } else {
        PathBuf::from(prefix)
    }
}

pub fn valid_env_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 128
        && name.chars().all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
}

pub fn executable_kind(path: &Path) -> &'static str {
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

pub fn find_executable(name: &str) -> Option<PathBuf> {
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

pub fn probe(path: &Path) -> Result<CondaInstance, AppError> {
    let json = run_json_from_path(path, &["info", "--json"])?;
    Ok(instance_from_info(path, "windows", &json)?)
}

/// 从 Windows 侧指定路径运行 `conda info --json`（仅用于发现阶段的裸路径探测）。
fn run_json_from_path(executable: &Path, args: &[&str]) -> Result<serde_json::Value, AppError> {
    let output = Command::new(executable)
        .args(args)
        .output()
        .map_err(|error| AppError::Command(format!("{}: {error}", executable.display())))?;
    parse_output(output)
}

/// 从 JSON info 结果构造实例。`executable_kind` 基于可执行文件名。
fn instance_from_info(
    executable: &Path,
    runtime: &str,
    json: &serde_json::Value,
) -> Result<CondaInstance, AppError> {
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
        id: format!("{}:{}:{}", runtime, executable_kind(executable), root_prefix.to_lowercase()),
        executable_path: executable.to_string_lossy().into_owned(),
        runtime: runtime.to_string(),
        kind: executable_kind(executable).into(),
        version: version.into(),
        root_prefix: root_prefix.into(),
        platform: platform.into(),
        is_default: false,
    })
}

pub fn discover() -> Vec<CondaInstance> {
    // 同一根目录可能被多个可执行文件命中（如 PATH 里的 conda.EXE 与 CONDA_EXE 里的
    // conda.exe 仅大小写不同，PathBuf::dedup 无法去重）。按实例 id（kind:root_prefix）
    // 去重，确保每个 Conda 安装只出现一次。
    let mut seen = std::collections::HashSet::new();
    let mut all = candidate_executables()
        .iter()
        .filter_map(|path| probe(path).ok())
        .filter(|instance| seen.insert(instance.id.clone()))
        .collect::<Vec<_>>();
    all.extend(discover_wsl());
    all
}

// ---------- WSL 支持 ----------

/// 解码 `wsl.exe` 自身的 stdout。`wsl.exe` 在 stdout 被管道捕获时输出 UTF-16LE
/// （每个 ASCII 字符后跟 0x00，可能带 BOM），而 `String::from_utf8_lossy` 会得到夹
/// 着空字节的乱码，导致解析失败。这里检测编码并按需转 UTF-16LE。
fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16LE BOM
        return decode_utf16le(&bytes[2..]);
    }
    // 空字节占比高（每个 ASCII 字符后跟一个 0x00）即判定为 UTF-16LE。
    if !bytes.is_empty() {
        let null_ratio = bytes.iter().filter(|&&b| b == 0).count() as f64 / bytes.len() as f64;
        if null_ratio > 0.3 {
            return decode_utf16le(bytes);
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// 解析 `wsl.exe --list --verbose` 输出，返回发行版名列表（去掉 `*` 默认标记）。
pub fn list_wsl_distros() -> Vec<String> {
    let Ok(output) = Command::new("wsl.exe").args(["--list", "--verbose"]).output() else {
        return Vec::new();
    };
    let text = decode_wsl_output(&output.stdout);
    let mut distros = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 跳过表头（含 NAME / STATE）与可能的 "Windows Subsystem..." 提示行。
        if line.to_ascii_uppercase().contains("NAME") && line.to_ascii_uppercase().contains("STATE") {
            continue;
        }
        let name = line.trim_start_matches('*').split_whitespace().next();
        if let Some(name) = name {
            if name.len() > 1 && !name.to_ascii_uppercase().contains("VERSION") {
                distros.push(name.to_string());
            }
        }
    }
    distros
}

/// 在指定 WSL 发行版内探测 conda 可执行文件（返回 Linux 路径）。
///
/// 注意：`wsl.exe -d <distro> -- bash -lc "<脚本>"` 会先把脚本交给外层 shell
/// 再展开一次，脚本里自己赋值的变量（`$p` 等）会被展开成空。因此脚本内所有
/// `$` 都写成 `\$`，让 `bash -lc` 自己展开。
fn find_conda_in_wsl(distro: &str) -> Option<String> {
    let script = r#"
for p in "\$HOME/miniconda3/bin/conda" "\$HOME/anaconda3/bin/conda" "\$HOME/miniforge3/bin/conda" \
         /opt/conda/bin/conda /opt/miniconda3/bin/conda /usr/local/bin/conda "\$HOME/.local/bin/conda"; do
  if [ -x "\$p" ]; then echo "\$p"; exit 0; fi
done
command -v conda 2>/dev/null
"#;
    let output = Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout);
    path.lines()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
        .map(str::to_string)
}

/// 探测 WSL 发行版内的 conda 并构造实例（runtime 为 `wsl:<distro>`）。
pub fn probe_wsl(distro: &str, conda_path: &str) -> Result<CondaInstance, AppError> {
    let script = format!("{} info --json", conda_path);
    let output = Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .map_err(|error| AppError::Command(format!("wsl {distro}: {error}")))?;
    let json = parse_output(output)?;
    instance_from_info(Path::new(conda_path), &format!("wsl:{distro}"), &json)
}

/// 发现所有 WSL 发行版内的 conda 安装。
pub fn discover_wsl() -> Vec<CondaInstance> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for distro in list_wsl_distros() {
        if let Some(conda_path) = find_conda_in_wsl(&distro) {
            if let Ok(instance) = probe_wsl(&distro, &conda_path) {
                if seen.insert(instance.id.clone()) {
                    found.push(instance);
                }
            }
        }
    }
    found
}

pub fn find_conda_pack(instance: &CondaInstance) -> Option<PathBuf> {
    let root = Path::new(&instance.root_prefix);
    let candidate = root.join("Scripts").join("conda-pack.exe");
    if candidate.is_file() {
        return Some(candidate);
    }
    find_executable("conda-pack")
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    normalize(left) == normalize(right)
}

pub fn list_environments_inner(instance: &CondaInstance) -> Result<Vec<EnvironmentSummary>, AppError> {
    let json = run_json(instance, &["env", "list", "--json"])?;
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
        // WSL 目标需通过 UNC 路径读取 conda-meta 与磁盘占用。
        let fs_prefix = fs_path(instance, prefix);
        let (python_version, package_count) = read_env_meta(&fs_prefix);
        environments.push(EnvironmentSummary {
            instance_id: instance.id.clone(),
            name,
            prefix: prefix.into(),
            is_base,
            is_active: false,
            python_version,
            package_count,
            platform: Some(instance.platform.clone()),
            size_bytes: None,
        });
    }
    // 并行计算磁盘占用，避免环境较多时列表变慢。
    let sizes = compute_sizes_parallel(instance, &environments);
    for env in &mut environments {
        env.size_bytes = sizes.get(env.prefix.as_str()).copied();
    }
    Ok(environments)
}

fn compute_sizes_parallel(
    instance: &CondaInstance,
    environments: &[EnvironmentSummary],
) -> HashMap<String, u64> {
    let prefixes: Vec<(String, PathBuf)> = environments
        .iter()
        .map(|env| (env.prefix.clone(), fs_path(instance, &env.prefix)))
        .collect();
    if prefixes.is_empty() {
        return HashMap::new();
    }
    let workers = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .min(8)
        .min(prefixes.len());
    let results = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
    std::thread::scope(|scope| {
        for group in prefixes.chunks((prefixes.len() / workers).max(1)) {
            let results = std::sync::Arc::clone(&results);
            scope.spawn(move || {
                for (key, fs_prefix) in group {
                    if let Some(size) = dir_size(fs_prefix) {
                        results
                            .lock()
                            .unwrap()
                            .insert(key.clone(), size);
                    }
                }
            });
        }
    });
    std::sync::Arc::try_unwrap(results)
        .map(|mutex| mutex.into_inner().unwrap_or_default())
        .unwrap_or_default()
}

/// 通过直接读取环境的 `conda-meta` 目录来快速获取 Python 版本与包数量，
/// 避免为每个环境启动一次 `conda list` 子进程（这是环境列表页变慢的主因）。
pub fn read_env_meta(prefix: &Path) -> (Option<String>, Option<usize>) {
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

/// 递归计算环境目录占用的磁盘空间（字节）。跳过 `pkgs` 子目录（下载缓存）。
pub fn dir_size(prefix: &Path) -> Option<u64> {
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

pub fn list_packages_inner(instance: &CondaInstance, prefix: &str) -> Result<Vec<PackageRecord>, AppError> {
    let prefix_path = PathBuf::from(prefix);
    if !is_absolute_prefix(instance, prefix) {
        return Err(AppError::Message("Environment path must be absolute".into()));
    }
    let known = run_json(instance, &["env", "list", "--json"])?;
    let belongs = known
        .get("envs")
        .and_then(|value| value.as_array())
        .is_some_and(|envs| {
            envs.iter()
                .filter_map(|item| item.as_str())
                .any(|path| same_path(Path::new(path), &prefix_path))
        });
    if !belongs {
        return Err(AppError::Message(
            "Environment does not belong to the selected Conda instance".into(),
        ));
    }
    let json = run_json(
        instance,
        &["list", "-p", prefix, "--json"],
    )?;
    let records = json
        .as_array()
        .ok_or_else(|| AppError::Parse("Conda response is not a package array".into()))?;
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
                package_type: if item.get("channel").and_then(|value| value.as_str()) == Some("pypi") {
                    "pip"
                } else {
                    "conda"
                }
                .into(),
            })
        })
        .collect())
}

pub fn search_packages_inner(instance: &CondaInstance, query: &str) -> Result<Vec<SearchResult>, AppError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let json = run_json(instance, &["search", trimmed, "--json"])?;
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

pub fn list_package_versions_inner(instance: &CondaInstance, package: &str) -> Result<Vec<SearchResult>, AppError> {
    let trimmed = package.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let json = run_json(instance, &["search", trimmed, "--json"])?;
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
    versions.reverse();
    let mut seen = std::collections::HashSet::new();
    versions.retain(|item| seen.insert(format!("{}:{}", item.version, item.channel)));
    versions.truncate(100);
    Ok(versions)
}

pub fn get_channels_inner(instance: &CondaInstance) -> Result<ChannelInfo, AppError> {
    let json = run_json(instance, &["config", "--get", "channels", "--json"])?;
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
pub fn resolve_channel_target(channel: &str) -> String {
    let trimmed = channel.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed == "defaults" {
        "https://repo.anaconda.com/pkgs/main".to_string()
    } else {
        format!("https://conda.anaconda.org/{trimmed}")
    }
}

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
pub fn probe_tcp(target: &str) -> (bool, Option<u64>, Option<String>) {
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

/// 对一组 conda 参数执行 `--dry-run --json` 并解析求解计划。
/// 若命令不支持 dry-run 或解析失败，返回 Err，由调用方降级为 supported=false。
pub fn plan_dry_run(instance: &CondaInstance, base_args: &[String]) -> Result<OperationPlan, AppError> {
    let mut args: Vec<String> = base_args.to_vec();
    args.push("--dry-run".to_string());
    args.push("--json".to_string());
    let output = run_command(instance, &args)?;
    if !output.status.success() {
        return Err(AppError::Command(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| AppError::Parse(error.to_string()))?;
    parse_plan_json(&json)
}

fn parse_plan_json(json: &serde_json::Value) -> Result<OperationPlan, AppError> {
    let empty = serde_json::Value::Null;
    let actions = json.get("actions").unwrap_or(&empty);

    let mut unlink: Vec<PlanChange> = Vec::new();
    let mut link: Vec<PlanChange> = Vec::new();
    let mut downloads: Vec<PlanDownload> = Vec::new();
    let mut fetch_bytes: u64 = 0;

    if let Some(items) = actions.get("UNLINK").and_then(|value| value.as_array()) {
        for item in items {
            unlink.push(plan_change_from(item, "remove"));
        }
    }
    if let Some(items) = actions.get("LINK").and_then(|value| value.as_array()) {
        for item in items {
            link.push(plan_change_from(item, "install"));
        }
    }
    if let Some(items) = actions.get("FETCH").and_then(|value| value.as_array()) {
        for item in items {
            let size = item.get("size").and_then(|value| value.as_u64());
            fetch_bytes += size.unwrap_or(0);
            downloads.push(PlanDownload {
                name: item
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("?")
                    .to_string(),
                version: item
                    .get("version")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                channel: item
                    .get("channel")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                size,
            });
        }
    }

    let mut changes: Vec<PlanChange> = Vec::new();
    let mut link_by_name: HashMap<String, PlanChange> = HashMap::new();
    for change in link {
        link_by_name.insert(change.name.clone(), change);
    }
    for mut change in unlink {
        if let Some(linked) = link_by_name.remove(&change.name) {
            change.action = "update".to_string();
            change.to_version = linked.to_version;
            changes.push(change);
        } else {
            changes.push(change);
        }
    }
    for (_, change) in link_by_name {
        changes.push(change);
    }

    Ok(OperationPlan {
        supported: true,
        command: None,
        changes,
        downloads,
        warnings: Vec::new(),
        fetch_bytes: Some(fetch_bytes),
    })
}

fn plan_change_from(item: &serde_json::Value, action: &str) -> PlanChange {
    let version = item
        .get("version")
        .and_then(|value| value.as_str())
        .map(String::from);
    PlanChange {
        action: action.to_string(),
        name: item
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("?")
            .to_string(),
        from_version: if action == "remove" {
            version.clone()
        } else {
            None
        },
        to_version: if action == "install" { version } else { None },
        channel: item
            .get("channel")
            .and_then(|value| value.as_str())
            .map(String::from),
    }
}
