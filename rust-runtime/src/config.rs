use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

pub fn resolve_project_root() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("NEXUS_PROJECT_ROOT") {
        let configured = PathBuf::from(value);
        if configured.is_absolute() {
            return Ok(configured);
        }

        return env::current_dir()
            .map(|cwd| cwd.join(configured))
            .map_err(|error| format!("failed to resolve project root: {error}"));
    }

    let cwd =
        env::current_dir().map_err(|error| format!("failed to read current directory: {error}"))?;
    if looks_like_project_root(&cwd) {
        return Ok(cwd);
    }

    if let Some(root) = project_root_from_executable() {
        return Ok(root);
    }

    Ok(cwd)
}

fn looks_like_project_root(path: &Path) -> bool {
    path.join("start.sh").is_file()
        && (path.join("rust-runtime/Cargo.toml").is_file()
            || (path.join("VERSION").is_file() && path.join("package.json").is_file()))
}

fn project_root_from_executable() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    for ancestor in executable.ancestors() {
        if looks_like_project_root(ancestor) {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

pub fn load_dotenv(project_root: &Path) -> HashMap<String, String> {
    let env_file = project_root.join(".env");
    let Ok(contents) = std::fs::read_to_string(env_file) else {
        return HashMap::new();
    };

    let mut values = HashMap::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }

        values.insert(key.to_string(), value.trim().to_string());
    }

    values
}

pub fn env_or_dotenv(key: &str, dotenv: &HashMap<String, String>) -> Option<String> {
    env::var(key)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| dotenv.get(key).cloned())
}

pub fn resolve_data_dir(project_root: &Path, dotenv: &HashMap<String, String>) -> PathBuf {
    let configured = env_or_dotenv("NEXUS_DATA_DIR", dotenv).unwrap_or_default();
    resolve_data_dir_path(project_root, &configured)
}

fn resolve_data_dir_path(project_root: &Path, configured: &str) -> PathBuf {
    if configured.is_empty() {
        return project_root.join("data");
    }

    let configured_path = PathBuf::from(configured);
    if configured_path.is_absolute() {
        configured_path
    } else {
        project_root.join(configured_path)
    }
}

pub fn resolve_runtime_path(runtime_root: &Path, value: &str) -> PathBuf {
    let configured = PathBuf::from(value);
    if configured.is_absolute() {
        configured
    } else {
        runtime_root.join(configured)
    }
}

pub fn parse_json_array_env(raw: Option<String>) -> Vec<String> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };

    serde_json::from_str::<Vec<Value>>(&raw)
        .map(|items| {
            items
                .into_iter()
                .filter_map(|value| match value {
                    Value::String(value) => Some(value),
                    Value::Number(value) => Some(value.to_string()),
                    Value::Bool(value) => Some(value.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn collect_proxy_vars(dotenv: &HashMap<String, String>) -> Vec<(String, String)> {
    let mut proxy_vars = Vec::new();
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
    ] {
        if let Some(value) = env_or_dotenv(key, dotenv).filter(|value| !value.is_empty()) {
            proxy_vars.push((key.to_string(), value));
        }
    }

    if let Some(claude_proxy) =
        env_or_dotenv("CLAUDE_PROXY", dotenv).filter(|value| !value.is_empty())
    {
        upsert_proxy_var(&mut proxy_vars, "ALL_PROXY", &claude_proxy);
        upsert_proxy_var(&mut proxy_vars, "HTTPS_PROXY", &claude_proxy);
        upsert_proxy_var(&mut proxy_vars, "HTTP_PROXY", &claude_proxy);
        upsert_proxy_var(&mut proxy_vars, "NEXUS_PROXY", &claude_proxy);
    }

    proxy_vars
}

fn upsert_proxy_var(proxy_vars: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some((_, existing)) = proxy_vars
        .iter_mut()
        .find(|(existing_key, _)| existing_key == key)
    {
        *existing = value.to_string();
    } else {
        proxy_vars.push((key.to_string(), value.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        load_dotenv, looks_like_project_root, parse_json_array_env, project_root_from_executable,
        resolve_data_dir_path, resolve_runtime_path,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_json_array_env_values() {
        let values = parse_json_array_env(Some(r#"["a",2,true,{"skip":1}]"#.to_string()));
        assert_eq!(values, vec!["a", "2", "true"]);
    }

    #[test]
    fn resolves_relative_and_absolute_paths() {
        let runtime_root = Path::new("/repo");
        assert_eq!(
            resolve_runtime_path(runtime_root, "bin/nexus-server"),
            PathBuf::from("/repo/bin/nexus-server")
        );
        assert_eq!(
            resolve_runtime_path(runtime_root, "/tmp/nexus-server"),
            PathBuf::from("/tmp/nexus-server")
        );
    }

    #[test]
    fn resolves_data_dir_from_dotenv() {
        assert_eq!(
            resolve_data_dir_path(Path::new("/repo"), "var/data"),
            PathBuf::from("/repo/var/data")
        );
    }

    #[test]
    fn loads_simple_dotenv_file() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nexus-dotenv-{stamp}"));
        fs::create_dir_all(&root).expect("dir");
        fs::write(
            root.join(".env"),
            "JWT_SECRET=abc\n# comment\nACC_PASSWORD_HASH=xyz\n",
        )
        .expect("write env");

        let values = load_dotenv(&root);
        assert_eq!(values.get("JWT_SECRET"), Some(&"abc".to_string()));
        assert_eq!(values.get("ACC_PASSWORD_HASH"), Some(&"xyz".to_string()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recognizes_binary_release_root_without_cargo_manifest() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("start.sh"), "#!/bin/sh").unwrap();
        fs::write(root.path().join("package.json"), "{}").unwrap();
        assert!(!looks_like_project_root(root.path()));
        fs::write(root.path().join("VERSION"), "4.5.0").unwrap();
        assert!(looks_like_project_root(root.path()));
    }

    #[test]
    fn can_infer_project_root_from_release_binary_location() {
        let inferred = project_root_from_executable().unwrap();
        assert!(inferred.join("start.sh").is_file());
        assert!(inferred.join("rust-runtime/Cargo.toml").is_file());
    }
}
