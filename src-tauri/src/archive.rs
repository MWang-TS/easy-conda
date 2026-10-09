use crate::conda::run_command;
use crate::models::*;
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
struct EnvYaml {
    name: Option<String>,
    channels: Option<Vec<String>>,
    dependencies: Option<Vec<serde_yaml::Value>>,
}

/// 导出 environment.yml（依赖规格）。
pub fn export_yaml(instance: &CondaInstance, prefix: &str) -> Result<String, AppError> {
    let output = run_command(
        instance,
        &[
            "env".to_string(),
            "export".to_string(),
            "-p".to_string(),
            prefix.to_string(),
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::Command(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 导出 explicit spec（精确到包 URL/build，用于同平台精确重建）。
pub fn export_explicit(instance: &CondaInstance, prefix: &str) -> Result<String, AppError> {
    let output = run_command(
        instance,
        &[
            "list".to_string(),
            "-p".to_string(),
            prefix.to_string(),
            "--explicit".to_string(),
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::Command(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 原子写入文件：先写同目录临时文件，再重命名覆盖，失败不留下半成品目标文件。
pub fn write_file_atomic(dest: &Path, content: &str) -> Result<(), AppError> {
    let dir = dest
        .parent()
        .ok_or_else(|| AppError::Message("无效的保存路径".into()))?;
    std::fs::create_dir_all(dir)
        .map_err(|error| AppError::Message(format!("创建目录失败: {error}")))?;
    let tmp = dir.join(format!(".easy-conda-{}.tmp", std::process::id()));
    std::fs::write(&tmp, content)
        .map_err(|error| AppError::Message(format!("写入失败: {error}")))?;
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(&tmp, dest).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        AppError::Message(format!("保存失败: {error}"))
    })?;
    Ok(())
}

/// 解析 environment.yml 用于导入预览。
pub fn parse_yaml_preview(path: &Path) -> Result<YamlPreview, AppError> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| AppError::Message(format!("读取文件失败: {error}")))?;
    match serde_yaml::from_str::<EnvYaml>(&content) {
        Ok(parsed) => {
            let dependencies = parsed
                .dependencies
                .unwrap_or_default()
                .into_iter()
                .map(|value| match value {
                    serde_yaml::Value::String(s) => s,
                    other => serde_yaml::to_string(&other)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                })
                .collect();
            Ok(YamlPreview {
                parsed: true,
                name: parsed.name,
                channels: parsed.channels.unwrap_or_default(),
                dependencies,
                error: None,
            })
        }
        Err(error) => Ok(YamlPreview {
            parsed: false,
            name: None,
            channels: Vec::new(),
            dependencies: Vec::new(),
            error: Some(format!("解析失败: {error}")),
        }),
    }
}
