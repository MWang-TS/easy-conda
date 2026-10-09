use crate::conda::{
    get_channels_inner, list_environments_inner, probe_tcp,
    resolve_channel_target, run_json,
};
use crate::models::*;

/// 生成脱敏后的诊断报告。
pub fn build_diagnostics(instance: &CondaInstance) -> Result<DiagnosticReport, AppError> {
    let mut sections = Vec::new();

    // 1. Conda 实例信息
    let info = run_json(instance, &["info", "--json"])
        .map(|value| serde_json::to_string_pretty(&value).unwrap_or_default())
        .unwrap_or_else(|error| error.to_string());
    sections.push(DiagnosticSection {
        title: "Conda 实例信息".to_string(),
        content: info,
    });

    // 2. 下载源（渠道）连通性
    let channels = get_channels_inner(instance)
        .map(|info| info.channels)
        .unwrap_or_default();
    let mut channel_text = String::new();
    for channel in &channels {
        let target = resolve_channel_target(channel);
        let (reachable, latency, error) = probe_tcp(&target);
        if reachable {
            channel_text.push_str(&format!(
                "{channel} -> {target}: 可达 ({} ms)\n",
                latency.unwrap_or(0)
            ));
        } else {
            channel_text.push_str(&format!(
                "{channel} -> {target}: 不可达 ({})\n",
                error.unwrap_or_else(|| "未知错误".to_string())
            ));
        }
    }
    sections.push(DiagnosticSection {
        title: "下载源连通性".to_string(),
        content: if channel_text.is_empty() {
            "（未配置渠道）".to_string()
        } else {
            channel_text
        },
    });

    // 3. 环境列表摘要
    let environments = list_environments_inner(instance).unwrap_or_default();
    let mut env_text = format!("共 {} 个环境\n", environments.len());
    for env in &environments {
        env_text.push_str(&format!(
            "- {} ({}) python={:?} 包数={:?}\n",
            env.name.clone().unwrap_or_default(),
            env.prefix,
            env.python_version,
            env.package_count
        ));
    }
    sections.push(DiagnosticSection {
        title: "环境列表".to_string(),
        content: env_text,
    });

    Ok(DiagnosticReport {
        generated_at: now_millis(),
        redacted: true,
        sections,
    })
}
