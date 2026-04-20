use crate::config::{
    collect_proxy_vars, env_or_dotenv, load_dotenv, parse_json_array_env, resolve_data_dir,
    resolve_project_root, resolve_runtime_path,
};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_HOST: &str = "0.0.0.0";
pub const DEFAULT_PORT: u16 = 59000;
pub const DEFAULT_RUNTIME_READY_TIMEOUT_MS: u64 = 5_000;
pub const DEFAULT_TMUX_SESSION: &str = "~";
pub const DEFAULT_GITHUB_REPO: &str = "Jiang0977/nexus";
pub const TELEGRAM_API_BASE_URL: &str = "https://api.telegram.org";

pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub project_root: PathBuf,
    pub jwt_secret: String,
    pub password_hash: String,
    pub default_tmux_session: String,
    pub codex_history_enabled: bool,
    pub github_repo: String,
    pub workspace_root: String,
    pub telegram_bot_token: String,
    pub telegram_webhook_secret: String,
    pub telegram_default_session: String,
    pub telegram_api_base_url: String,
    pub configs_dir: PathBuf,
    pub codex_configs_dir: PathBuf,
    pub codex_validate_dir: PathBuf,
    pub project_defaults_file: PathBuf,
    pub toolbar_config_file: PathBuf,
    pub tasks_file: PathBuf,
    pub uploads_dir: PathBuf,
    pub proxy_vars: Vec<(String, String)>,
    pub runtime_configs: RuntimeConfigs,
}

impl AppConfig {
    pub fn load() -> Result<Self, String> {
        let project_root = resolve_project_root()?;
        let runtime_root = env::current_dir()
            .map_err(|error| format!("failed to read current directory: {error}"))?;
        let dotenv = load_dotenv(&project_root);
        let host = env_or_dotenv("HOST", &dotenv).unwrap_or_else(|| DEFAULT_HOST.to_string());
        let port = env_or_dotenv("PORT", &dotenv)
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);
        let data_dir = resolve_data_dir(&project_root, &dotenv);
        let jwt_secret = env_or_dotenv("JWT_SECRET", &dotenv)
            .ok_or_else(|| "JWT_SECRET must be set in environment or .env".to_string())?;
        let password_hash = env_or_dotenv("ACC_PASSWORD_HASH", &dotenv)
            .ok_or_else(|| "ACC_PASSWORD_HASH must be set in environment or .env".to_string())?;

        Ok(Self {
            host,
            port,
            project_root: project_root.clone(),
            jwt_secret,
            password_hash,
            default_tmux_session: env_or_dotenv("TMUX_SESSION", &dotenv)
                .unwrap_or_else(|| DEFAULT_TMUX_SESSION.to_string()),
            codex_history_enabled: env_or_dotenv("NEXUS_CODEX_HISTORY_ENABLED", &dotenv)
                .map(|value| value != "0")
                .unwrap_or(true),
            github_repo: env_or_dotenv("GITHUB_REPO", &dotenv)
                .unwrap_or_else(|| DEFAULT_GITHUB_REPO.to_string()),
            workspace_root: env_or_dotenv("WORKSPACE_ROOT", &dotenv)
                .unwrap_or_else(|| "/workspace".to_string()),
            telegram_bot_token: env_or_dotenv("TELEGRAM_BOT_TOKEN", &dotenv).unwrap_or_default(),
            telegram_webhook_secret: env_or_dotenv("TELEGRAM_WEBHOOK_SECRET", &dotenv)
                .unwrap_or_default(),
            telegram_default_session: env_or_dotenv("TELEGRAM_DEFAULT_SESSION", &dotenv)
                .unwrap_or_default(),
            telegram_api_base_url: env_or_dotenv("NEXUS_TELEGRAM_API_BASE_URL", &dotenv)
                .unwrap_or_else(|| TELEGRAM_API_BASE_URL.to_string()),
            configs_dir: data_dir.join("configs"),
            codex_configs_dir: data_dir.join("codex-configs"),
            codex_validate_dir: data_dir.join("codex-validate"),
            project_defaults_file: data_dir.join("project-shell-defaults.json"),
            toolbar_config_file: data_dir.join("toolbar-config.json"),
            tasks_file: data_dir.join("tasks.json"),
            uploads_dir: data_dir.join("uploads"),
            proxy_vars: collect_proxy_vars(&dotenv),
            runtime_configs: RuntimeConfigs::from_env(&dotenv, &runtime_root),
        })
    }
}

pub struct RuntimeConfigs {
    pub task_runner: RuntimeServiceConfig,
    pub pty_broker: RuntimeServiceConfig,
    pub window_launch: RuntimeServiceConfig,
    pub session_management: RuntimeServiceConfig,
}

impl RuntimeConfigs {
    pub fn from_env(dotenv: &HashMap<String, String>, runtime_root: &Path) -> Self {
        Self {
            task_runner: RuntimeServiceConfig::from_env(
                "task runner",
                "NEXUS_TASK_RUNNER_RUST_EXECUTABLE",
                "NEXUS_TASK_RUNNER_RUST_ARGS",
                "NEXUS_TASK_RUNNER_RUST_READY_TIMEOUT_MS",
                dotenv,
                runtime_root,
            ),
            pty_broker: RuntimeServiceConfig::from_env(
                "pty broker",
                "NEXUS_PTY_BROKER_RUST_EXECUTABLE",
                "NEXUS_PTY_BROKER_RUST_ARGS",
                "NEXUS_PTY_BROKER_RUST_READY_TIMEOUT_MS",
                dotenv,
                runtime_root,
            ),
            window_launch: RuntimeServiceConfig::from_env(
                "window launch",
                "NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE",
                "NEXUS_WINDOW_LAUNCH_RUST_ARGS",
                "NEXUS_WINDOW_LAUNCH_RUST_READY_TIMEOUT_MS",
                dotenv,
                runtime_root,
            ),
            session_management: RuntimeServiceConfig::from_env(
                "session management",
                "NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE",
                "NEXUS_SESSION_MANAGEMENT_RUST_ARGS",
                "NEXUS_SESSION_MANAGEMENT_RUST_READY_TIMEOUT_MS",
                dotenv,
                runtime_root,
            ),
        }
    }
}

#[derive(Clone)]
pub struct RuntimeServiceConfig {
    pub display_name: &'static str,
    pub executable: Option<PathBuf>,
    pub args: Vec<String>,
    pub ready_timeout: Duration,
}

impl RuntimeServiceConfig {
    pub fn from_env(
        display_name: &'static str,
        executable_key: &str,
        args_key: &str,
        timeout_key: &str,
        dotenv: &HashMap<String, String>,
        runtime_root: &Path,
    ) -> Self {
        let executable = env_or_dotenv(executable_key, dotenv)
            .filter(|value| !value.is_empty())
            .map(|value| resolve_runtime_path(runtime_root, &value));
        let args = parse_json_array_env(env_or_dotenv(args_key, dotenv));
        let ready_timeout = Duration::from_millis(
            env_or_dotenv(timeout_key, dotenv)
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(DEFAULT_RUNTIME_READY_TIMEOUT_MS),
        );

        Self {
            display_name,
            executable,
            args,
            ready_timeout,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_GITHUB_REPO, DEFAULT_PORT};

    #[test]
    fn runtime_defaults_match_repository_defaults() {
        assert_eq!(DEFAULT_PORT, 59000);
        assert_eq!(DEFAULT_GITHUB_REPO, "Jiang0977/nexus");
    }
}
