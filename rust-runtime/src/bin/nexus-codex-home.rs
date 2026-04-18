use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

const SHARED_CODEX_STATE_PATHS: &[&str] = &[
    ".codex-global-state.json",
    ".tmp",
    "cache",
    "history.jsonl",
    "installation_id",
    "models_cache.json",
    "plugins",
    "session_index.jsonl",
    "sessions",
    "shell_snapshots",
    "skills",
    "vendor_imports",
    "version.json",
];

const SHARED_CODEX_CONFIG_SECTION_PREFIXES: &[&str] = &["mcp_servers.", "plugins."];
const SHARED_CODEX_CONFIG_SECTION_NAMES: &[&str] = &["notice.model_migrations"];
const RUNTIME_DISABLED_CODEX_FEATURES: &[&str] = &["apps", "plugins"];

#[derive(Clone, Debug, Default)]
struct NormalizedCodexConfig {
    openai_api_key: String,
    base_url: String,
    model: String,
    reasoning_effort: String,
    config_toml: String,
    auth_json: String,
}

#[derive(Default)]
struct SimpleToml {
    root: HashMap<String, String>,
    sections: HashMap<String, HashMap<String, String>>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("[Nexus] {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err("Usage: nexus-codex-home <config-file?> <home-dir> <project-path>".to_string());
    }

    let config_file = args[0].trim();
    let home_dir = args[1].trim();
    let project_path = args[2].trim();
    if home_dir.is_empty() || project_path.is_empty() {
        return Err("Usage: nexus-codex-home <config-file?> <home-dir> <project-path>".to_string());
    }

    let source_home = env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_default();

    let config = if config_file.is_empty() {
        read_global_codex_config(&source_home).unwrap_or_default()
    } else {
        read_config_file(Path::new(config_file))?
    };

    materialize_codex_home(
        &config,
        Path::new(home_dir),
        project_path,
        &source_home,
        true,
    )
}

fn read_config_file(path: &Path) -> Result<NormalizedCodexConfig, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read config file {}: {error}", path.display()))?;
    let value = serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("failed to parse config file {}: {error}", path.display()))?;
    Ok(normalize_codex_config_value(&value))
}

fn read_global_codex_config(source_home: &Path) -> Option<NormalizedCodexConfig> {
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
    Some(import_codex_config_from_global(&config_toml, &auth_json))
}

fn parse_json_object_from_str(raw: &str) -> Option<Map<String, Value>> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn normalize_json_text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(raw)) => parse_json_object_from_str(raw)
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

fn normalize_codex_config_value(value: &Value) -> NormalizedCodexConfig {
    let raw = value.as_object().cloned().unwrap_or_default();
    let auth_json = normalize_json_text_value(raw.get("AUTH_JSON"));
    let auth_payload = parse_json_object_from_str(&auth_json).unwrap_or_default();
    let openai_api_key = value_string(raw.get("OPENAI_API_KEY"));
    NormalizedCodexConfig {
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

fn parse_toml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else {
        value.to_string()
    }
}

fn parse_simple_toml(text: &str) -> SimpleToml {
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

fn import_codex_config_from_global(
    config_toml_text: &str,
    auth_json_text: &str,
) -> NormalizedCodexConfig {
    let normalized_config_toml = config_toml_text.trim().to_string();
    let normalized_auth_json =
        normalize_json_text_value(Some(&Value::String(auth_json_text.to_string())));
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
    let auth_payload = parse_json_object_from_str(&normalized_auth_json).unwrap_or_default();

    normalize_codex_config_value(&json!({
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

    let project_header = format!(
        "[projects.{}]",
        serde_json::to_string(project_path).unwrap_or_else(|_| "\"\"".to_string())
    );
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

fn build_codex_config_toml(config: &NormalizedCodexConfig, project_path: &str) -> String {
    if !config.config_toml.is_empty() {
        return append_trusted_project_section(&config.config_toml, project_path);
    }

    let mut lines = Vec::new();
    if !config.base_url.is_empty() {
        lines.push("model_provider = \"custom\"".to_string());
    }
    if !config.model.is_empty() {
        lines.push(format!("model = {}", toml_string(&config.model)));
    }
    if !config.reasoning_effort.is_empty() {
        lines.push(format!(
            "model_reasoning_effort = {}",
            toml_string(&config.reasoning_effort)
        ));
    }
    if !config.base_url.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("[model_providers]".to_string());
        lines.push(String::new());
        lines.push("[model_providers.custom]".to_string());
        lines.push("name = \"custom\"".to_string());
        lines.push("wire_api = \"responses\"".to_string());
        lines.push("requires_openai_auth = true".to_string());
        lines.push(format!("base_url = {}", toml_string(&config.base_url)));
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

fn parse_toml_section_blocks(text: &str) -> Vec<(String, String)> {
    let mut sections = Vec::new();
    let mut current_section = String::new();
    let mut current_lines: Vec<String> = Vec::new();

    let flush = |sections: &mut Vec<(String, String)>,
                 current_section: &mut String,
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
            flush(&mut sections, &mut current_section, &mut current_lines);
            current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
            current_lines.push(raw_line.to_string());
        } else if !current_section.is_empty() {
            current_lines.push(raw_line.to_string());
        }
    }

    flush(&mut sections, &mut current_section, &mut current_lines);
    sections
}

fn should_merge_shared_codex_config_section(section_name: &str) -> bool {
    SHARED_CODEX_CONFIG_SECTION_NAMES.contains(&section_name)
        || SHARED_CODEX_CONFIG_SECTION_PREFIXES
            .iter()
            .any(|prefix| section_name.starts_with(prefix))
}

fn merge_shared_codex_config_sections(
    config_toml_text: &str,
    source_config_toml_text: &str,
) -> String {
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
        if !should_merge_shared_codex_config_section(&section_name) {
            continue;
        }
        if merged_sections.contains(&section_name) {
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

fn disable_runtime_codex_features(config_toml_text: &str) -> String {
    let source_lines = config_toml_text.split('\n').collect::<Vec<_>>();
    let mut output_lines: Vec<String> = Vec::new();
    let mut pending_features = RUNTIME_DISABLED_CODEX_FEATURES
        .iter()
        .map(|value| value.to_string())
        .collect::<HashSet<_>>();
    let mut inside_features = false;
    let mut saw_features_section = false;

    let append_missing_feature_overrides =
        |output_lines: &mut Vec<String>,
         pending_features: &mut HashSet<String>,
         inside_features: bool| {
            if !inside_features {
                return;
            }
            for feature_name in RUNTIME_DISABLED_CODEX_FEATURES {
                if pending_features.remove(*feature_name) {
                    output_lines.push(format!("{feature_name} = false"));
                }
            }
        };

    for raw_line in source_lines {
        let trimmed_line = raw_line.trim();
        if trimmed_line.starts_with('[') && trimmed_line.ends_with(']') {
            append_missing_feature_overrides(
                &mut output_lines,
                &mut pending_features,
                inside_features,
            );
            inside_features = trimmed_line[1..trimmed_line.len() - 1].trim() == "features";
            if inside_features {
                saw_features_section = true;
            }
            output_lines.push(raw_line.to_string());
            continue;
        }

        if inside_features {
            if let Some((key, _)) = trimmed_line.split_once('=') {
                let key = key.trim();
                if pending_features.remove(key) {
                    output_lines.push(format!("{key} = false"));
                    continue;
                }
            }
        }

        output_lines.push(raw_line.to_string());
    }

    append_missing_feature_overrides(&mut output_lines, &mut pending_features, inside_features);

    if !saw_features_section {
        let trimmed_output = output_lines.join("\n").trim().to_string();
        let feature_section = format!(
            "[features]\n{}",
            RUNTIME_DISABLED_CODEX_FEATURES
                .iter()
                .map(|feature_name| format!("{feature_name} = false"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let merged = if trimmed_output.is_empty() {
            feature_section
        } else {
            format!("{trimmed_output}\n\n{feature_section}")
        };
        return ensure_trailing_newline(&merged);
    }

    ensure_trailing_newline(output_lines.join("\n").trim())
}

fn read_source_codex_config_toml(source_home: &Path) -> String {
    if source_home.as_os_str().is_empty() {
        return String::new();
    }
    let config_file = source_home.join(".codex").join("config.toml");
    fs::read_to_string(config_file).unwrap_or_default()
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

fn link_shared_codex_state(codex_dir: &Path, source_home: &Path) -> Result<(), String> {
    if source_home.as_os_str().is_empty() {
        return Ok(());
    }
    let source_codex_dir = source_home.join(".codex");
    if !source_codex_dir.exists() || source_codex_dir == codex_dir {
        return Ok(());
    }

    for relative_path in SHARED_CODEX_STATE_PATHS {
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

fn materialize_codex_home(
    config: &NormalizedCodexConfig,
    home_dir: &Path,
    project_path: &str,
    source_home: &Path,
    include_shared_state: bool,
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

    if include_shared_state {
        link_shared_codex_state(&codex_dir, source_home)?;
    }

    let source_config_toml = if include_shared_state {
        read_source_codex_config_toml(source_home)
    } else {
        String::new()
    };
    let config_toml = disable_runtime_codex_features(&merge_shared_codex_config_sections(
        &build_codex_config_toml(config, project_path),
        &source_config_toml,
    ));
    fs::write(codex_dir.join("config.toml"), config_toml).map_err(|error| {
        format!(
            "failed to write config.toml in {}: {error}",
            codex_dir.display()
        )
    })?;

    let auth_file = codex_dir.join("auth.json");
    if !config.auth_json.is_empty() {
        fs::write(&auth_file, ensure_trailing_newline(&config.auth_json)).map_err(|error| {
            format!(
                "failed to write auth.json in {}: {error}",
                codex_dir.display()
            )
        })?;
    } else if !config.openai_api_key.is_empty() {
        let content = serde_json::to_string_pretty(&json!({
            "OPENAI_API_KEY": config.openai_api_key
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
