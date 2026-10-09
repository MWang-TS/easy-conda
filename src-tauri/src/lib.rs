mod archive;
mod commands;
mod conda;
mod diagnostics;
mod jobs;
mod models;
mod redact;

use crate::jobs::JobManager;
use crate::models::CondaInstance;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub instances: Mutex<Vec<CondaInstance>>,
    pub jobs: std::sync::Arc<JobManager>,
    /// 每个实例当前激活的环境 prefix（instance_id -> prefix）。
    pub active_prefixes: Mutex<HashMap<String, String>>,
}

/// 从被毒化的锁中恢复锁守卫，避免后续 panic。
pub(crate) fn lock_poison<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn operations_file_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    Some(base.join("easy-conda").join("operations.json"))
}

pub fn run() {
    let operations_file = operations_file_path();
    let jobs = std::sync::Arc::new(JobManager::new(operations_file));
    let state = AppState {
        instances: Mutex::new(Vec::new()),
        jobs,
        active_prefixes: Mutex::new(commands::load_active_prefixes()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::discover_conda_instances,
            commands::list_conda_instances,
            commands::set_default_conda_instance,
            commands::list_environments,
            commands::list_packages,
            commands::search_packages,
            commands::list_package_versions,
            commands::get_channels,
            commands::add_channel,
            commands::remove_channel,
            commands::test_channel_connectivity,
            commands::plan_create_environment,
            commands::start_create_environment,
            commands::start_delete_environment,
            commands::plan_install_packages,
            commands::start_install_packages,
            commands::plan_remove_packages,
            commands::start_remove_packages,
            commands::start_clone_environment,
            commands::export_environment_yaml,
            commands::export_environment_yaml_to_file,
            commands::export_explicit_spec,
            commands::export_explicit_spec_to_file,
            commands::parse_yaml_preview,
            commands::import_environment_yaml,
            commands::import_explicit_spec,
            commands::list_jobs,
            commands::cancel_job,
            commands::get_diagnostics,
            commands::clean_cache,
            commands::build_offline_channel,
            commands::build_wheelhouse,
            commands::conda_pack_environment,
            commands::open_environment_terminal,
            commands::open_environment_directory,
            commands::activate_environment,
            commands::get_install_info,
            commands::start_download_installer,
            commands::launch_installer
        ])
        .run(tauri::generate_context!())
        .expect("error while running Easy Conda");
}

#[cfg(test)]
mod tests {
    use crate::conda;
    use std::path::Path;

    #[test]
    fn same_path_is_case_insensitive_and_ignores_trailing_separator() {
        assert!(conda::same_path(
            Path::new(r"C:\Conda\envs\base\"),
            Path::new(r"c:\conda\envs\base")
        ));
    }

    #[test]
    fn executable_kind_uses_file_name() {
        assert_eq!(
            conda::executable_kind(Path::new(r"C:\tools\micromamba.exe")),
            "micromamba"
        );
        assert_eq!(
            conda::executable_kind(Path::new(r"C:\tools\mamba.exe")),
            "mamba"
        );
        assert_eq!(
            conda::executable_kind(Path::new(r"C:\tools\conda.exe")),
            "conda"
        );
    }

    #[test]
    fn redaction_masks_url_credentials() {
        let out = crate::redact::redact_line("https://user:secret@repo.example.com/pkgs");
        assert!(!out.contains("secret"));
        assert!(out.contains("repo.example.com"));
    }

    #[test]
    fn redaction_masks_bearer_token() {
        let out = crate::redact::redact_line("Authorization: Bearer abcdef123456");
        assert!(!out.contains("abcdef123456"));
    }
}
