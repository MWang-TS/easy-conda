use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
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
    #[error("{0}")]
    Message(String),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CondaInstance {
    pub id: String,
    /// 运行目标：`windows` 表示本机 Windows，`wsl:<distro>` 表示 WSL 发行版。
    pub runtime: String,
    pub executable_path: String,
    pub kind: String,
    pub version: String,
    pub root_prefix: String,
    pub platform: String,
    pub is_default: bool,
}

impl CondaInstance {
    /// 若为 WSL 目标，返回发行版名。
    pub fn wsl_distro(&self) -> Option<&str> {
        self.runtime.strip_prefix("wsl:")
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSummary {
    pub instance_id: String,
    pub name: Option<String>,
    pub prefix: String,
    pub is_base: bool,
    /// 该环境是否为当前激活的环境（应用内维护的激活状态）。
    pub is_active: bool,
    pub python_version: Option<String>,
    pub package_count: Option<usize>,
    pub platform: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRecord {
    pub name: String,
    pub version: String,
    pub build: Option<String>,
    pub channel: Option<String>,
    pub package_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEnvironmentRequest {
    pub name: String,
    pub python_version: Option<String>,
    pub packages: Vec<String>,
    pub channels: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub name: String,
    pub version: String,
    pub channel: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub id: u64,
    pub kind: String,
    pub target: String,
    pub status: String,
    pub summary: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u64,
    pub kind: String,
    pub target: String,
    pub status: String,
    pub summary: String,
    pub error: Option<String>,
    pub environment_prefix: Option<String>,
    pub stage: Option<String>,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub log: Vec<String>,
}

impl Job {
    pub fn to_event(&self, log_line: Option<String>) -> JobEvent {
        JobEvent {
            id: self.id,
            kind: self.kind.clone(),
            target: self.target.clone(),
            status: self.status.clone(),
            summary: self.summary.clone(),
            error: self.error.clone(),
            environment_prefix: self.environment_prefix.clone(),
            stage: self.stage.clone(),
            created_at: self.created_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            log_line,
        }
    }

    pub fn to_record(&self) -> OperationRecord {
        OperationRecord {
            id: self.id,
            kind: self.kind.clone(),
            target: self.target.clone(),
            status: self.status.clone(),
            summary: self.summary.clone(),
            started_at: self.started_at.unwrap_or(self.created_at),
            finished_at: self.finished_at,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: u64,
    pub kind: String,
    pub target: String,
    pub status: String,
    pub summary: String,
    pub error: Option<String>,
    pub environment_prefix: Option<String>,
    pub stage: Option<String>,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub log_line: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub channels: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelTestResult {
    pub channel: String,
    pub target: String,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPlan {
    pub supported: bool,
    pub command: Option<String>,
    pub changes: Vec<PlanChange>,
    pub downloads: Vec<PlanDownload>,
    pub warnings: Vec<String>,
    pub fetch_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChange {
    pub action: String,
    pub name: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub channel: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDownload {
    pub name: String,
    pub version: Option<String>,
    pub channel: Option<String>,
    pub size: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YamlPreview {
    pub parsed: bool,
    pub name: Option<String>,
    pub channels: Vec<String>,
    pub dependencies: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSection {
    pub title: String,
    pub content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub generated_at: u64,
    pub redacted: bool,
    pub sections: Vec<DiagnosticSection>,
}

/// 安装器下载源（官方 GitHub 与国内镜像）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSource {
    pub id: String,
    pub label: String,
    pub download_url: String,
    pub recommended: bool,
}

/// 推荐的 Conda 发行版安装器信息（当前为 Miniforge）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub filename: String,
    pub license: String,
    pub description: String,
    pub sources: Vec<InstallSource>,
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
