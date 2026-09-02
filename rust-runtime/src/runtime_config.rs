use crate::config::{
    collect_proxy_vars, env_or_dotenv, load_dotenv, parse_json_array_env, resolve_data_dir,
    resolve_project_root, resolve_runtime_path,
};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 59000;
pub const DEFAULT_RUNTIME_READY_TIMEOUT_MS: u64 = 5_000;
pub const DEFAULT_TMUX_SESSION: &str = "~";
pub const DEFAULT_SESSION_BACKEND: &str = "tmux";
pub const DEFAULT_GITHUB_REPO: &str = "Jiang0977/nexus";
pub const NATIVE_PTY_SUPERVISOR_SOCKET_ENV: &str = "NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET";

pub const LEGACY_DEFAULT_JWT_SECRET: &str =
    "fcea4c5c28bee4c9fa7adca25c947f87b2a7179202c824d185618d3b3bf2a333";
pub const LEGACY_DEFAULT_PASSWORD_HASH: &str =
    "$2b$12$5xRyI8a3yVhcCHqYP/Pdju/mKjxtxjWihXE1VpaXCdnuM6VUVNUsW";

pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub project_root: PathBuf,
    pub jwt_secret: String,
    pub password_hash: String,
    pub default_tmux_session: String,
    pub session_backend: String,
    pub session_backend_config_file: PathBuf,
    pub native_pty_supervisor_socket: PathBuf,
    pub codex_history_enabled: bool,
    pub github_repo: String,
    pub workspace_root: String,
    pub configs_dir: PathBuf,
    pub codex_configs_dir: PathBuf,
    pub codex_validate_dir: PathBuf,
    pub project_defaults_file: PathBuf,
    pub toolbar_config_file: PathBuf,
    pub workspace_layouts_file: PathBuf,
    pub prompts_file: PathBuf,
    pub uploads_dir: PathBuf,
    pub proxy_vars: Vec<(String, String)>,
    pub runtime_configs: RuntimeConfigs,
}

pub fn validate_jwt_secret(secret: Option<String>) -> Result<String, String> {
    let secret = secret.unwrap_or_default();
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err("JWT_SECRET must be set and non-empty in environment or .env. Run ./setup.sh to generate secure credentials.".to_string());
    }
    if trimmed == LEGACY_DEFAULT_JWT_SECRET {
        return Err("JWT_SECRET is using the insecure legacy default value. Run ./setup.sh or update .env with a newly generated secret (e.g. openssl rand -hex 32).".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn validate_password_hash(hash: Option<String>) -> Result<String, String> {
    let hash = hash.unwrap_or_default();
    let trimmed = hash.trim();
    if trimmed.is_empty() {
        return Err("ACC_PASSWORD_HASH must be set and non-empty in environment or .env. Run ./setup.sh to generate secure credentials.".to_string());
    }
    if trimmed == LEGACY_DEFAULT_PASSWORD_HASH {
        return Err("ACC_PASSWORD_HASH is using the insecure legacy default value (nexus123). Run ./setup.sh or generate a new bcrypt password hash in .env.".to_string());
    }
    Ok(trimmed.to_string())
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
        let jwt_secret = validate_jwt_secret(env_or_dotenv("JWT_SECRET", &dotenv))?;
        let password_hash = validate_password_hash(env_or_dotenv("ACC_PASSWORD_HASH", &dotenv))?;

        let session_backend_config_file = data_dir.join("session-backend.json");
        let session_backend = env_or_dotenv("NEXUS_SESSION_BACKEND", &dotenv)
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| read_session_backend_config_file(&session_backend_config_file));
        let native_pty_supervisor_socket =
            resolve_native_pty_supervisor_socket(&project_root, &data_dir, &dotenv);

        Ok(Self {
            host,
            port,
            project_root: project_root.clone(),
            jwt_secret,
            password_hash,
            default_tmux_session: env_or_dotenv("TMUX_SESSION", &dotenv)
                .unwrap_or_else(|| DEFAULT_TMUX_SESSION.to_string()),
            session_backend,
            session_backend_config_file,
            native_pty_supervisor_socket,
            codex_history_enabled: env_or_dotenv("NEXUS_CODEX_HISTORY_ENABLED", &dotenv)
                .map(|value| value != "0")
                .unwrap_or(true),
            github_repo: env_or_dotenv("GITHUB_REPO", &dotenv)
                .unwrap_or_else(|| DEFAULT_GITHUB_REPO.to_string()),
            workspace_root: env_or_dotenv("WORKSPACE_ROOT", &dotenv)
                .unwrap_or_else(|| "/workspace".to_string()),
            configs_dir: data_dir.join("configs"),
            codex_configs_dir: data_dir.join("codex-configs"),
            codex_validate_dir: data_dir.join("codex-validate"),
            project_defaults_file: data_dir.join("project-shell-defaults.json"),
            toolbar_config_file: data_dir.join("toolbar-config.json"),
            workspace_layouts_file: data_dir.join("workspace-layouts.json"),
            prompts_file: data_dir.join("prompts.json"),
            uploads_dir: data_dir.join("uploads"),
            proxy_vars: collect_proxy_vars(&dotenv),
            runtime_configs: RuntimeConfigs::from_env(&dotenv, &runtime_root),
        })
    }
}

pub fn resolve_native_pty_supervisor_socket(
    project_root: &Path,
    data_dir: &Path,
    dotenv: &HashMap<String, String>,
) -> PathBuf {
    let configured = env_or_dotenv(NATIVE_PTY_SUPERVISOR_SOCKET_ENV, dotenv)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    resolve_native_pty_supervisor_socket_path(project_root, data_dir, configured)
}

fn resolve_native_pty_supervisor_socket_path(
    project_root: &Path,
    data_dir: &Path,
    configured: Option<String>,
) -> PathBuf {
    let path = configured
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("native-sessions").join("supervisor.sock"));
    if path.is_absolute() {
        path
    } else {
        project_root.join(path)
    }
}

pub fn read_session_backend_config_file(path: &Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| {
            value
                .as_object()
                .and_then(|object| object.get("session_backend"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "tmux" | "native"))
        .unwrap_or_else(|| DEFAULT_SESSION_BACKEND.to_string())
}

pub struct RuntimeConfigs {
    pub pty_broker: RuntimeServiceConfig,
    pub window_launch: RuntimeServiceConfig,
    pub session_management: RuntimeServiceConfig,
}

impl RuntimeConfigs {
    pub fn from_env(dotenv: &HashMap<String, String>, runtime_root: &Path) -> Self {
        Self {
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
    use super::{
        DEFAULT_GITHUB_REPO, DEFAULT_HOST, DEFAULT_PORT, LEGACY_DEFAULT_JWT_SECRET,
        LEGACY_DEFAULT_PASSWORD_HASH, resolve_native_pty_supervisor_socket_path,
        validate_jwt_secret, validate_password_hash,
    };
    use std::path::Path;

    #[test]
    fn runtime_defaults_match_repository_defaults() {
        assert_eq!(DEFAULT_HOST, "127.0.0.1");
        assert_eq!(DEFAULT_PORT, 59000);
        assert_eq!(DEFAULT_GITHUB_REPO, "Jiang0977/nexus");
    }

    #[test]
    fn validate_jwt_secret_rejects_none_empty_and_legacy_default() {
        assert!(validate_jwt_secret(None).is_err());
        assert!(validate_jwt_secret(Some("   ".to_string())).is_err());
        assert!(validate_jwt_secret(Some(LEGACY_DEFAULT_JWT_SECRET.to_string())).is_err());
        assert_eq!(
            validate_jwt_secret(Some(" valid-secret-key ".to_string())).unwrap(),
            "valid-secret-key"
        );
    }

    #[test]
    fn validate_password_hash_rejects_none_empty_and_legacy_default() {
        assert!(validate_password_hash(None).is_err());
        assert!(validate_password_hash(Some("   ".to_string())).is_err());
        assert!(validate_password_hash(Some(LEGACY_DEFAULT_PASSWORD_HASH.to_string())).is_err());
        assert_eq!(
            validate_password_hash(Some(" valid-password-hash ".to_string())).unwrap(),
            "valid-password-hash"
        );
    }

    #[test]
    fn native_supervisor_socket_defaults_under_data_dir() {
        assert_eq!(
            resolve_native_pty_supervisor_socket_path(
                Path::new("/repo"),
                Path::new("/repo/data"),
                None
            ),
            Path::new("/repo/data/native-sessions/supervisor.sock")
        );
    }

    #[test]
    fn native_supervisor_socket_honors_env_override() {
        assert_eq!(
            resolve_native_pty_supervisor_socket_path(
                Path::new("/repo"),
                Path::new("/repo/data"),
                Some("var/native.sock".to_string())
            ),
            Path::new("/repo/var/native.sock")
        );
    }
}
