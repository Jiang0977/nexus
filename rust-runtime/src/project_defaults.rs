use crate::path_utils::resolve_workspace_path;
use crate::shell::{normalize_shell_type, uses_shell_profile};
use serde_json::{Value, json};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;

pub fn normalize_project_path_key(project_path: &str) -> String {
    let mut normalized = project_path.trim().replace('\\', "/");
    if normalized.is_empty() || normalized == "." {
        return String::new();
    }

    if normalized.len() > 1 {
        normalized = normalized.trim_end_matches('/').to_string();
    }

    normalized
}

pub fn get_project_default_payload(
    file_path: &Path,
    workspace_root: &str,
    raw_path: Option<&str>,
) -> Value {
    let normalized_path = raw_path.unwrap_or_default().trim();
    if normalized_path.is_empty() {
        return Value::Null;
    }

    let resolved_path = resolve_workspace_path(workspace_root, normalized_path);
    let key = normalize_project_path_key(&resolved_path);
    if key.is_empty() {
        return Value::Null;
    }

    let defaults = std::fs::read_to_string(file_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let Some(value) = defaults.get(&key).and_then(Value::as_object) else {
        return Value::Null;
    };

    json!({
        "path": key,
        "shell_type": normalize_shell_type(value.get("shell_type").and_then(Value::as_str)),
        "profile": value.get("profile").and_then(Value::as_str),
    })
}

pub async fn remember_project_default(
    file_path: &Path,
    project_path: &str,
    shell_type: &str,
    profile: Option<&str>,
) -> Result<(), String> {
    let key = normalize_project_path_key(project_path);
    if key.is_empty() {
        return Ok(());
    }

    let mut defaults = match fs::read_to_string(file_path).await {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    };

    defaults.insert(
        key,
        json!({
            "shell_type": shell_type,
            "profile": if uses_shell_profile(shell_type) {
                profile.filter(|value| !value.is_empty())
            } else {
                None
            },
            "updated_at": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs().to_string())
                .unwrap_or_else(|_| "0".to_string()),
        }),
    );

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("failed to create defaults directory: {error}"))?;
    }

    let content = serde_json::to_string_pretty(&Value::Object(defaults))
        .map_err(|error| format!("failed to serialize project defaults: {error}"))?;
    fs::write(file_path, format!("{content}\n"))
        .await
        .map_err(|error| format!("failed to write project defaults: {error}"))
}

#[cfg(test)]
mod tests {
    use super::normalize_project_path_key;

    #[test]
    fn normalizes_project_keys() {
        assert_eq!(
            normalize_project_path_key("/workspace/demo/"),
            "/workspace/demo"
        );
        assert_eq!(normalize_project_path_key("demo\\notes"), "demo/notes");
        assert_eq!(normalize_project_path_key("."), "");
    }
}
