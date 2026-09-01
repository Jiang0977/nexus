use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

const SHARED_STATE_PATHS: &[&str] = &[
    ".codex-global-state.json",
    ".tmp",
    "AGENTS.md",
    "cache",
    "history.jsonl",
    "installation_id",
    "models_cache.json",
    "plugins",
    "RTK.md",
    "session_index.jsonl",
    "sessions",
    "shell_snapshots",
    "skills",
    "vendor_imports",
    "version.json",
];

const SHARED_CONFIG_SECTION_PREFIXES: &[&str] = &["mcp_servers.", "plugins."];
const SHARED_CONFIG_SECTION_NAMES: &[&str] = &["notice.model_migrations"];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodexHomeConfig {
    openai_api_key: String,
    base_url: String,
    model: String,
    reasoning_effort: String,
    config_toml: String,
    auth_json: String,
}

#[derive(Default)]
pub struct SimpleToml {
    pub root: HashMap<String, String>,
    pub sections: HashMap<String, HashMap<String, String>>,
}

impl CodexHomeConfig {
    pub fn from_value(value: &Value) -> Self {
        let raw = value.as_object().cloned().unwrap_or_default();
        let auth_json = normalize_json_text(raw.get("AUTH_JSON"));
        let auth_payload = parse_json_object(&auth_json).unwrap_or_default();
        let openai_api_key = value_string(raw.get("OPENAI_API_KEY"));
        Self {
            openai_api_key: if openai_api_key.is_empty() {
                value_string(auth_payload.get("OPENAI_API_KEY"))
            } else {
                openai_api_key
            },
            base_url: value_string(raw.get("BASE_URL")),
            model: value_string(raw.get("MODEL")),
            reasoning_effort: value_string(raw.get("REASONING_EFFORT")),
            config_toml: value_string(raw.get("CONFIG_TOML")),
            auth_json,
        }
    }

    pub fn import_global(config_toml_text: &str, auth_json_text: &str) -> Self {
        let normalized_config_toml = config_toml_text.trim().to_string();
        let normalized_auth_json =
            normalize_json_text(Some(&Value::String(auth_json_text.to_string())));
        let parsed_toml = parse_simple_toml(&normalized_config_toml);
        let provider_name = parsed_toml
            .root
            .get("model_provider")
            .cloned()
            .unwrap_or_default();
        let provider_section = parsed_toml
            .sections
            .get(&format!("model_providers.{provider_name}"))
            .cloned()
            .unwrap_or_default();
        let auth_payload = parse_json_object(&normalized_auth_json).unwrap_or_default();

        Self::from_value(&json!({
            "OPENAI_API_KEY": value_string(auth_payload.get("OPENAI_API_KEY")),
            "BASE_URL": provider_section.get("base_url").cloned().unwrap_or_default(),
            "MODEL": parsed_toml.root.get("model").cloned().unwrap_or_default(),
            "REASONING_EFFORT": parsed_toml
                .root
                .get("model_reasoning_effort")
                .cloned()
                .unwrap_or_default(),
            "CONFIG_TOML": normalized_config_toml,
            "AUTH_JSON": normalized_auth_json,
        }))
    }

    pub fn read_file(path: &Path) -> Result<Self, String> {
        let content = fs::read_to_string(path)
            .map_err(|error| format!("failed to read config file {}: {error}", path.display()))?;
        let value = serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("failed to parse config file {}: {error}", path.display()))?;
        Ok(Self::from_value(&value))
    }

    pub fn read_global(source_home: &Path) -> Option<Self> {
        if source_home.as_os_str().is_empty() {
            return None;
        }
        let codex_dir = source_home.join(".codex");
        let config_file = codex_dir.join("config.toml");
        let auth_file = codex_dir.join("auth.json");
        if !config_file.exists() && !auth_file.exists() {
            return None;
        }

        let config_toml = fs::read_to_string(config_file).unwrap_or_default();
        let auth_json = fs::read_to_string(auth_file).unwrap_or_default();
        Some(Self::import_global(&config_toml, &auth_json))
    }

    pub fn to_value(&self) -> Value {
        json!({
            "OPENAI_API_KEY": self.openai_api_key,
            "BASE_URL": self.base_url,
            "MODEL": self.model,
            "REASONING_EFFORT": self.reasoning_effort,
            "CONFIG_TOML": self.config_toml,
            "AUTH_JSON": self.auth_json,
        })
    }

    pub fn without_config_toml(&self) -> Self {
        let mut config = self.clone();
        config.config_toml.clear();
        config
    }

    pub fn auth_mode(&self) -> String {
        let auth_payload = parse_json_object(&self.auth_json).unwrap_or_default();
        let auth_mode = value_string(auth_payload.get("auth_mode"));
        if !auth_mode.is_empty() {
            auth_mode
        } else if !self.openai_api_key.is_empty() {
            "api_key".to_string()
        } else {
            String::new()
        }
    }

    pub fn openai_api_key(&self) -> &str {
        &self.openai_api_key
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn materialize(
        &self,
        home_dir: &Path,
        project_path: &str,
        shared_source_home: Option<&Path>,
    ) -> Result<(), String> {
        let codex_dir = home_dir.join(".codex");
        fs::create_dir_all(home_dir).map_err(|error| {
            format!(
                "failed to create home directory {}: {error}",
                home_dir.display()
            )
        })?;
        let _ = fs::remove_dir_all(&codex_dir);
        fs::create_dir_all(&codex_dir).map_err(|error| {
            format!(
                "failed to create codex directory {}: {error}",
                codex_dir.display()
            )
        })?;

        if let Some(source_home) = shared_source_home {
            link_shared_state(&codex_dir, source_home)?;
        }

        let source_config_toml = shared_source_home
            .map(read_source_config_toml)
            .unwrap_or_default();
        let config_toml = merge_shared_config_sections(
            &self.build_config_toml(project_path),
            &source_config_toml,
        );
        fs::write(codex_dir.join("config.toml"), config_toml).map_err(|error| {
            format!(
                "failed to write config.toml in {}: {error}",
                codex_dir.display()
            )
        })?;

        let auth_file = codex_dir.join("auth.json");
        if !self.auth_json.is_empty() {
            fs::write(&auth_file, ensure_trailing_newline(&self.auth_json)).map_err(|error| {
                format!(
                    "failed to write auth.json in {}: {error}",
                    codex_dir.display()
                )
            })?;
        } else if !self.openai_api_key.is_empty() {
            let content = serde_json::to_string_pretty(&json!({
                "OPENAI_API_KEY": self.openai_api_key
            }))
            .unwrap_or_else(|_| "{}".to_string());
            fs::write(&auth_file, format!("{content}\n")).map_err(|error| {
                format!(
                    "failed to write auth.json in {}: {error}",
                    codex_dir.display()
                )
            })?;
        } else {
            let _ = fs::remove_file(auth_file);
        }

        Ok(())
    }

    fn build_config_toml(&self, project_path: &str) -> String {
        if !self.config_toml.is_empty() {
            let config_toml = append_trusted_project_section(&self.config_toml, project_path);
            return ensure_resume_provider_aliases(&config_toml, &self.base_url);
        }

        let mut lines = Vec::new();
        if !self.base_url.is_empty() {
            lines.push("model_provider = \"custom\"".to_string());
        }
        if !self.model.is_empty() {
            lines.push(format!("model = {}", toml_string(&self.model)));
        }
        if !self.reasoning_effort.is_empty() {
            lines.push(format!(
                "model_reasoning_effort = {}",
                toml_string(&self.reasoning_effort)
            ));
        }
        if !self.base_url.is_empty() {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push("[model_providers]".to_string());
            lines.push(String::new());
            lines.push("[model_providers.custom]".to_string());
            lines.push("name = \"custom\"".to_string());
            lines.push("wire_api = \"responses\"".to_string());
            lines.push("requires_openai_auth = true".to_string());
            lines.push(format!("base_url = {}", toml_string(&self.base_url)));
        }
        if !project_path.is_empty() {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push(format!("[projects.{}]", toml_string(project_path)));
            lines.push("trust_level = \"trusted\"".to_string());
        }

        ensure_trailing_newline(&lines.join("\n"))
    }
}

fn ensure_resume_provider_aliases(config_toml_text: &str, fallback_base_url: &str) -> String {
    let parsed_toml = parse_simple_toml(config_toml_text);
    let configured_provider = parsed_toml
        .root
        .get("model_provider")
        .cloned()
        .unwrap_or_default();
    let base_url = resolve_provider_base_url(&parsed_toml, &configured_provider, fallback_base_url);
    if base_url.is_empty() {
        return ensure_trailing_newline(config_toml_text.trim());
    }

    let mut text = config_toml_text.trim().to_string();
    if !configured_provider.is_empty()
        && !has_model_provider_section(&parsed_toml, &configured_provider)
    {
        text = append_model_provider_section(&text, &configured_provider, &base_url, None);
    }
    if configured_provider != "custom" && !has_model_provider_section(&parsed_toml, "custom") {
        text = append_model_provider_section(
            &text,
            "custom",
            &base_url,
            provider_section_values(&parsed_toml, &configured_provider),
        );
    }
    ensure_trailing_newline(&text)
}

fn resolve_provider_base_url(
    parsed_toml: &SimpleToml,
    configured_provider: &str,
    fallback_base_url: &str,
) -> String {
    if !fallback_base_url.trim().is_empty() {
        return fallback_base_url.trim().to_string();
    }
    if !configured_provider.is_empty()
        && let Some(base_url) = provider_section_base_url(parsed_toml, configured_provider)
    {
        return base_url;
    }
    parsed_toml
        .sections
        .iter()
        .find_map(|(section_name, values)| {
            if section_name.starts_with("model_providers.") {
                values
                    .get("base_url")
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
            } else {
                None
            }
        })
        .unwrap_or_default()
}

fn has_model_provider_section(parsed_toml: &SimpleToml, provider_name: &str) -> bool {
    parsed_toml
        .sections
        .contains_key(&format!("model_providers.{provider_name}"))
        || parsed_toml
            .sections
            .contains_key(&format!("model_providers.{}", toml_string(provider_name)))
}

fn provider_section_base_url(parsed_toml: &SimpleToml, provider_name: &str) -> Option<String> {
    provider_section_values(parsed_toml, provider_name)
        .and_then(|section| section.get("base_url"))
        .filter(|value| !value.trim().is_empty())
        .cloned()
}

fn provider_section_values<'a>(
    parsed_toml: &'a SimpleToml,
    provider_name: &str,
) -> Option<&'a HashMap<String, String>> {
    parsed_toml
        .sections
        .get(&format!("model_providers.{provider_name}"))
        .or_else(|| {
            parsed_toml
                .sections
                .get(&format!("model_providers.{}", toml_string(provider_name)))
        })
}

fn append_model_provider_section(
    config_toml_text: &str,
    provider_name: &str,
    base_url: &str,
    template: Option<&HashMap<String, String>>,
) -> String {
    let mut lines = Vec::new();
    if !config_toml_text.trim().is_empty() {
        lines.push(config_toml_text.trim().to_string());
        lines.push(String::new());
    }
    lines.push(format!(
        "[model_providers.{}]",
        model_provider_section_key(provider_name)
    ));
    lines.push(format!("name = {}", toml_string(provider_name)));
    let template_values = template.cloned().unwrap_or_default();
    let wire_api = template_values
        .get("wire_api")
        .cloned()
        .unwrap_or_else(|| "responses".to_string());
    let requires_openai_auth = template_values
        .get("requires_openai_auth")
        .cloned()
        .unwrap_or_else(|| "true".to_string());
    lines.push(format!("wire_api = {}", toml_scalar_string(&wire_api)));
    lines.push(format!(
        "requires_openai_auth = {}",
        toml_scalar_string(&requires_openai_auth)
    ));
    lines.push(format!("base_url = {}", toml_string(base_url)));
    let mut extra_keys = template_values
        .keys()
        .filter(|key| {
            key.as_str() != "name"
                && key.as_str() != "wire_api"
                && key.as_str() != "requires_openai_auth"
                && key.as_str() != "base_url"
        })
        .cloned()
        .collect::<Vec<_>>();
    extra_keys.sort();
    for key in extra_keys {
        if let Some(value) = template_values.get(&key) {
            lines.push(format!("{key} = {}", toml_scalar_string(value)));
        }
    }
    lines.join("\n")
}

fn model_provider_section_key(provider_name: &str) -> String {
    if provider_name
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
    {
        provider_name.to_string()
    } else {
        toml_string(provider_name)
    }
}

fn toml_scalar_string(value: &str) -> String {
    if value == "true"
        || value == "false"
        || value.parse::<i64>().is_ok()
        || value.parse::<f64>().is_ok()
    {
        value.to_string()
    } else {
        toml_string(value)
    }
}

pub fn parse_simple_toml(text: &str) -> SimpleToml {
    let mut root = HashMap::new();
    let mut sections: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current_section: Option<String> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let section_name = line[1..line.len() - 1].trim().to_string();
            sections.entry(section_name.clone()).or_default();
            current_section = Some(section_name);
            continue;
        }
        if let Some((key, raw_value)) = line.split_once('=') {
            let key = key.trim().to_string();
            let value = parse_toml_scalar(raw_value);
            if let Some(section_name) = current_section.as_ref() {
                sections
                    .entry(section_name.clone())
                    .or_default()
                    .insert(key, value);
            } else {
                root.insert(key, value);
            }
        }
    }

    SimpleToml { root, sections }
}

fn parse_json_object(raw: &str) -> Option<Map<String, Value>> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn normalize_json_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(raw)) => parse_json_object(raw)
            .and_then(|object| serde_json::to_string_pretty(&Value::Object(object)).ok())
            .unwrap_or_default(),
        Some(Value::Object(object)) => {
            serde_json::to_string_pretty(&Value::Object(object.clone())).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(raw)) => raw.trim().to_string(),
        Some(Value::Number(raw)) => raw.to_string(),
        Some(Value::Bool(raw)) => raw.to_string(),
        _ => String::new(),
    }
}

fn parse_toml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else {
        value.to_string()
    }
}

fn ensure_trailing_newline(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

fn append_trusted_project_section(config_toml_text: &str, project_path: &str) -> String {
    let trimmed = config_toml_text.trim();
    if project_path.is_empty() {
        return ensure_trailing_newline(trimmed);
    }
    let project_header = format!("[projects.{}]", toml_string(project_path));
    if trimmed.contains(&project_header) {
        return ensure_trailing_newline(trimmed);
    }
    let project_section = format!("{project_header}\ntrust_level = \"trusted\"");
    if trimmed.is_empty() {
        ensure_trailing_newline(&project_section)
    } else {
        ensure_trailing_newline(&format!("{trimmed}\n\n{project_section}"))
    }
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn parse_toml_section_blocks(text: &str) -> Vec<(String, String)> {
    let mut sections = Vec::new();
    let mut current_section = String::new();
    let mut current_lines: Vec<String> = Vec::new();

    let flush = |sections: &mut Vec<(String, String)>,
                 current_section: &String,
                 current_lines: &mut Vec<String>| {
        if !current_section.is_empty() && !current_lines.is_empty() {
            sections.push((
                current_section.clone(),
                current_lines.join("\n").trim().to_string(),
            ));
        }
        current_lines.clear();
    };

    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            flush(&mut sections, &current_section, &mut current_lines);
            current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
            current_lines.push(raw_line.to_string());
        } else if !current_section.is_empty() {
            current_lines.push(raw_line.to_string());
        }
    }
    flush(&mut sections, &current_section, &mut current_lines);
    sections
}

fn merge_shared_config_sections(config_toml_text: &str, source_config_toml_text: &str) -> String {
    let base_text = config_toml_text.trim();
    let source_text = source_config_toml_text.trim();
    if source_text.is_empty() {
        return ensure_trailing_newline(base_text);
    }

    let mut merged_sections = parse_toml_section_blocks(base_text)
        .into_iter()
        .map(|(section_name, _)| section_name)
        .collect::<HashSet<_>>();
    let mut merged_text = base_text.to_string();

    for (section_name, block_text) in parse_toml_section_blocks(source_text) {
        let should_merge = SHARED_CONFIG_SECTION_NAMES.contains(&section_name.as_str())
            || SHARED_CONFIG_SECTION_PREFIXES
                .iter()
                .any(|prefix| section_name.starts_with(prefix));
        if !should_merge || merged_sections.contains(&section_name) {
            continue;
        }
        merged_text = if merged_text.is_empty() {
            block_text
        } else {
            format!("{merged_text}\n\n{block_text}")
        };
        merged_sections.insert(section_name);
    }

    ensure_trailing_newline(&merged_text)
}

fn read_source_config_toml(source_home: &Path) -> String {
    if source_home.as_os_str().is_empty() {
        return String::new();
    }
    fs::read_to_string(source_home.join(".codex").join("config.toml")).unwrap_or_default()
}

#[cfg(unix)]
fn symlink_path(source_path: &Path, target_path: &Path, _is_dir: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source_path, target_path)
}

#[cfg(windows)]
fn symlink_path(source_path: &Path, target_path: &Path, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        std::os::windows::fs::symlink_dir(source_path, target_path)
    } else {
        std::os::windows::fs::symlink_file(source_path, target_path)
    }
}

fn link_shared_state(codex_dir: &Path, source_home: &Path) -> Result<(), String> {
    if source_home.as_os_str().is_empty() {
        return Ok(());
    }
    let source_codex_dir = source_home.join(".codex");
    if !source_codex_dir.exists() || source_codex_dir == codex_dir {
        return Ok(());
    }

    for relative_path in SHARED_STATE_PATHS {
        let source_path = source_codex_dir.join(relative_path);
        if !source_path.exists() {
            continue;
        }
        let target_path = codex_dir.join(relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create shared state directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let metadata = fs::metadata(&source_path).map_err(|error| {
            format!(
                "failed to read shared state metadata {}: {error}",
                source_path.display()
            )
        })?;
        symlink_path(&source_path, &target_path, metadata.is_dir()).map_err(|error| {
            format!(
                "failed to link shared state {} -> {}: {error}",
                target_path.display(),
                source_path.display()
            )
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalization_uses_auth_key_when_top_level_key_is_absent() {
        let config = CodexHomeConfig::from_value(&json!({
            "AUTH_JSON": { "OPENAI_API_KEY": "from-auth" },
            "MODEL": "gpt-test",
        }));

        assert_eq!(config.openai_api_key(), "from-auth");
        assert_eq!(config.auth_mode(), "api_key");
        assert_eq!(config.to_value()["MODEL"], "gpt-test");
    }

    #[test]
    fn materialize_writes_trusted_project_without_shared_state() {
        let home = tempdir().expect("temp home");
        let config = CodexHomeConfig::from_value(&json!({
            "OPENAI_API_KEY": "test-key",
            "MODEL": "gpt-test",
        }));

        config
            .materialize(home.path(), "/workspace/demo", None)
            .expect("materialize");

        let config_toml =
            fs::read_to_string(home.path().join(".codex/config.toml")).expect("config.toml");
        let auth_json =
            fs::read_to_string(home.path().join(".codex/auth.json")).expect("auth.json");
        assert!(config_toml.contains("model = \"gpt-test\""));
        assert!(config_toml.contains("[projects.\"/workspace/demo\"]"));
        assert!(auth_json.contains("\"OPENAI_API_KEY\": \"test-key\""));
    }
}
