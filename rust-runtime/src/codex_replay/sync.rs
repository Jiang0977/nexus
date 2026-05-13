use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::codex_replay::engine::{attribute_sessions, remap_to_target_account};
use crate::codex_replay::journal::load_activation_journal;
use crate::codex_replay::model::{ActivationEvent, SessionRecord};

#[derive(Debug)]
pub struct ReplayRouteError {
    pub status_code: StatusCode,
    pub message: String,
}

impl ReplayRouteError {
    pub fn from_message(status_code: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status_code,
            message: message.into(),
        }
    }

    fn internal(error: anyhow::Error) -> Self {
        Self::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryOutput {
    pub ok: bool,
    pub current_provider_codex: Option<String>,
    pub target_account_id: String,
    pub index_projection: SessionIndexProjectionOutput,
    pub state_projection: DesktopStateProjectionOutput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexProjectionOutput {
    pub index_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub written_entries: usize,
    pub preserved_thread_names: usize,
    pub derived_thread_names: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStateProjectionOutput {
    pub state_db_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub written_threads: usize,
    pub normalized_sources: usize,
    pub projected_target_provider_threads: usize,
    pub target_model_provider: Option<String>,
}

#[derive(Clone, Debug)]
struct CodexProviderRecord {
    id: String,
    desktop_model_provider: String,
    is_current: bool,
}

#[derive(Clone, Debug)]
struct CodexMapOutput {
    current_provider_codex: Option<String>,
    target_account_id: String,
    providers: Vec<CodexProviderRecord>,
}

#[derive(Clone, Debug, Deserialize)]
struct CcSwitchSettings {
    #[serde(rename = "currentProviderCodex")]
    current_provider_codex: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ProviderSettings {
    config: Option<String>,
}

#[derive(Clone, Debug)]
struct SessionIndexEntry {
    id: String,
    thread_name: String,
    updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
struct SessionFileSummary {
    id: String,
    path: PathBuf,
    started_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    cwd: String,
    source: String,
    model_provider: String,
    cli_version: String,
    model: String,
    approval_mode: String,
    sandbox_policy: String,
    git_sha: Option<String>,
    git_branch: Option<String>,
    git_origin_url: Option<String>,
    dynamic_tools: Vec<DynamicToolRecord>,
    first_user_messages: Vec<(DateTime<Utc>, String)>,
}

#[derive(Clone, Debug)]
struct DynamicToolRecord {
    name: String,
    description: String,
    input_schema: String,
    defer_loading: bool,
}

#[derive(Clone, Debug)]
struct DesktopThreadProjection {
    id: String,
    rollout_path: PathBuf,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    source: String,
    model_provider: String,
    cwd: String,
    title: String,
    sandbox_policy: String,
    approval_mode: String,
    cli_version: String,
    model: String,
    reasoning_effort: Option<String>,
    git_sha: Option<String>,
    git_branch: Option<String>,
    git_origin_url: Option<String>,
    dynamic_tools: Vec<DynamicToolRecord>,
    normalized_source: bool,
    projected_to_target: bool,
}

pub fn sync_cc_switch_codex_history() -> Result<SyncHistoryOutput, ReplayRouteError> {
    let home_dir = env::var_os("HOME").ok_or_else(|| {
        ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, "HOME is not set")
    })?;
    sync_cc_switch_codex_history_for_home(Path::new(&home_dir))
}

fn sync_cc_switch_codex_history_for_home(
    home_dir: &Path,
) -> Result<SyncHistoryOutput, ReplayRouteError> {
    let map = load_cc_switch_codex_map(home_dir)?;
    let codex_root = home_dir.join(".codex");
    fs::create_dir_all(&codex_root).map_err(|error| {
        ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    let journal_path = default_journal_path(home_dir);
    let activations = load_activation_journal(&journal_path).map_err(ReplayRouteError::internal)?;
    let sessions_dir = codex_root.join("sessions");
    let session_index_path = codex_root.join("session_index.jsonl");
    let existing_names = load_existing_session_index_names(&session_index_path)
        .map_err(ReplayRouteError::internal)?;
    let summaries = scan_session_summaries(&sessions_dir).map_err(ReplayRouteError::internal)?;
    let index_entries = build_session_index_entries(&summaries, &existing_names);
    let index_projection =
        write_session_index_projection(&session_index_path, &index_entries, true)
            .map_err(ReplayRouteError::internal)?;

    let provider_ids = map
        .providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect::<HashSet<_>>();
    let target_provider = map
        .providers
        .iter()
        .find(|provider| provider.id == map.target_account_id)
        .ok_or_else(|| {
            ReplayRouteError::from_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("missing target provider {}", map.target_account_id),
            )
        })?;
    let desktop_rows = build_target_desktop_thread_projections(
        &summaries,
        &activations,
        &provider_ids,
        &map.target_account_id,
        &target_provider.desktop_model_provider,
        false,
    );
    let state_db_path = latest_versioned_sqlite(&codex_root, "state", 5);
    let state_projection = write_desktop_state_projection(&state_db_path, &desktop_rows, true)
        .map_err(ReplayRouteError::internal)?;

    Ok(SyncHistoryOutput {
        ok: true,
        current_provider_codex: map.current_provider_codex,
        target_account_id: map.target_account_id,
        index_projection,
        state_projection,
    })
}

fn load_cc_switch_codex_map(home_dir: &Path) -> Result<CodexMapOutput, ReplayRouteError> {
    let cc_switch_dir = home_dir.join(".cc-switch");
    let settings_path = cc_switch_dir.join("settings.json");
    let db_path = cc_switch_dir.join("cc-switch.db");
    if !settings_path.exists() {
        return Err(ReplayRouteError::from_message(
            StatusCode::NOT_FOUND,
            format!("cc-switch settings not found: {}", settings_path.display()),
        ));
    }
    if !db_path.exists() {
        return Err(ReplayRouteError::from_message(
            StatusCode::NOT_FOUND,
            format!("cc-switch db not found: {}", db_path.display()),
        ));
    }

    let settings_text = fs::read_to_string(&settings_path).map_err(|error| {
        ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    let settings: CcSwitchSettings = serde_json::from_str(&settings_text).map_err(|error| {
        ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    let connection = Connection::open(&db_path).map_err(|error| {
        ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    let mut statement = connection
        .prepare(
            "select id, settings_config, is_current \
             from providers where app_type = 'codex' order by is_current desc, name asc",
        )
        .map_err(|error| {
            ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;

    let providers = statement
        .query_map([], |row| {
            let settings_text: String = row.get(1)?;
            let settings_value: ProviderSettings =
                serde_json::from_str(&settings_text).unwrap_or(ProviderSettings { config: None });
            let config = settings_value.config.unwrap_or_default();
            let is_current: i64 = row.get(2)?;
            Ok(CodexProviderRecord {
                id: row.get(0)?,
                desktop_model_provider: derive_desktop_model_provider(&config),
                is_current: is_current != 0,
            })
        })
        .map_err(|error| {
            ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| {
            ReplayRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;

    if providers.is_empty() {
        return Err(ReplayRouteError::from_message(
            StatusCode::NOT_FOUND,
            format!("no codex providers found in {}", db_path.display()),
        ));
    }

    let target_account_id = settings
        .current_provider_codex
        .clone()
        .or_else(|| {
            providers
                .iter()
                .find(|provider| provider.is_current)
                .map(|provider| provider.id.clone())
        })
        .or_else(|| providers.first().map(|provider| provider.id.clone()))
        .ok_or_else(|| {
            ReplayRouteError::from_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed resolving current codex provider",
            )
        })?;

    Ok(CodexMapOutput {
        current_provider_codex: settings.current_provider_codex,
        target_account_id,
        providers,
    })
}

fn default_journal_path(home_dir: &Path) -> PathBuf {
    let candidates = [
        home_dir.join(".local/state/cc-switch/activation-journal.jsonl"),
        home_dir.join(".config/cc-switch/activation-journal.jsonl"),
        home_dir.join(".codexbar/switch-journal.jsonl"),
    ];

    candidates
        .iter()
        .find(|candidate| candidate.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

fn latest_versioned_sqlite(codex_root: &Path, basename: &str, default_version: i32) -> PathBuf {
    let prefix = format!("{basename}_");
    let discovered = fs::read_dir(codex_root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("sqlite") {
                return None;
            }
            let stem = path.file_stem()?.to_string_lossy();
            let suffix = stem.strip_prefix(&prefix)?;
            suffix.parse::<i32>().ok()
        })
        .max()
        .unwrap_or(default_version);

    codex_root.join(format!("{basename}_{discovered}.sqlite"))
}

fn build_target_desktop_thread_projections(
    summaries: &[SessionFileSummary],
    activations: &[ActivationEvent],
    provider_ids: &HashSet<String>,
    target_account_id: &str,
    target_model_provider: &str,
    keep_unknown: bool,
) -> Vec<DesktopThreadProjection> {
    let mut attributed = attribute_sessions(
        &summaries
            .iter()
            .map(|summary| SessionRecord {
                id: summary.id.clone(),
                started_at: summary.started_at,
                last_activity_at: summary.updated_at,
                archived: false,
                model: summary.model.clone(),
            })
            .collect::<Vec<_>>(),
        activations,
    );
    remap_to_target_account(
        &mut attributed,
        provider_ids,
        target_account_id,
        keep_unknown,
    );
    let attributed_by_id = attributed
        .into_iter()
        .map(|session| (session.id.clone(), session.attribution))
        .collect::<HashMap<_, _>>();

    summaries
        .iter()
        .map(|summary| {
            let projected_to_target = matches!(
                attributed_by_id.get(&summary.id),
                Some(Some(account))
                    if account.provider_id == "codex" && account.account_id == target_account_id
            );
            let projected_model_provider = if projected_to_target {
                target_model_provider
            } else {
                &summary.model_provider
            };
            project_desktop_thread(summary, projected_model_provider, projected_to_target)
        })
        .collect()
}

fn project_desktop_thread(
    summary: &SessionFileSummary,
    model_provider: &str,
    normalize_source_flag: bool,
) -> DesktopThreadProjection {
    let projected_source = if normalize_source_flag {
        normalize_desktop_source(&summary.source)
    } else {
        summary.source.clone()
    };
    DesktopThreadProjection {
        id: summary.id.clone(),
        rollout_path: summary.path.clone(),
        created_at: summary.started_at,
        updated_at: summary.updated_at,
        source: projected_source.clone(),
        model_provider: model_provider.to_string(),
        cwd: summary.cwd.clone(),
        title: pick_first_message_after_start(&summary.first_user_messages, summary.started_at)
            .unwrap_or_else(|| format!("session-{}", &summary.id[..8])),
        sandbox_policy: summary.sandbox_policy.clone(),
        approval_mode: summary.approval_mode.clone(),
        cli_version: summary.cli_version.clone(),
        model: summary.model.clone(),
        reasoning_effort: None,
        git_sha: summary.git_sha.clone(),
        git_branch: summary.git_branch.clone(),
        git_origin_url: summary.git_origin_url.clone(),
        dynamic_tools: summary.dynamic_tools.clone(),
        normalized_source: projected_source != summary.source,
        projected_to_target: normalize_source_flag,
    }
}

fn load_existing_session_index_names(path: &Path) -> Result<HashMap<String, String>> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let file = File::open(path).with_context(|| format!("failed opening {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut names = HashMap::new();
    for line in reader.lines() {
        let line = line.with_context(|| format!("failed reading {}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<Value>(&line)
            .with_context(|| format!("invalid json in {}", path.display()))?;
        let id = parsed
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        if let Some(thread_name) = parsed
            .get("thread_name")
            .and_then(Value::as_str)
            .and_then(normalize_preserved_thread_name)
        {
            names.insert(id, thread_name);
        }
    }
    Ok(names)
}

fn scan_session_summaries(sessions_dir: &Path) -> Result<Vec<SessionFileSummary>> {
    let files = collect_session_jsonl_files(sessions_dir)?;
    let mut summaries = Vec::new();
    for path in files {
        if let Some(summary) = parse_session_file_summary(&path)? {
            summaries.push(summary);
        }
    }
    Ok(summaries)
}

fn collect_session_jsonl_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .with_context(|| format!("failed reading directory {}", dir.display()))?;
        for entry in entries {
            let entry =
                entry.with_context(|| format!("failed reading entry in {}", dir.display()))?;
            let path = entry.path();
            let metadata = entry
                .metadata()
                .with_context(|| format!("failed reading metadata {}", path.display()))?;
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if metadata.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            {
                files.push(path);
            }
        }
    }

    files.sort();
    Ok(files)
}

fn build_session_index_entries(
    summaries: &[SessionFileSummary],
    existing_names: &HashMap<String, String>,
) -> Vec<SessionIndexEntry> {
    let mut entries = summaries
        .iter()
        .map(|summary| {
            let preserved_name = existing_names
                .get(&summary.id)
                .and_then(|value| normalize_preserved_thread_name(value));
            let thread_name = preserved_name.unwrap_or_else(|| {
                pick_first_message_after_start(&summary.first_user_messages, summary.started_at)
                    .unwrap_or_else(|| format!("session-{}", &summary.id[..8]))
            });

            SessionIndexEntry {
                id: summary.id.clone(),
                thread_name,
                updated_at: summary.updated_at,
            }
        })
        .collect::<Vec<_>>();

    entries.sort_by(|lhs, rhs| {
        lhs.updated_at
            .cmp(&rhs.updated_at)
            .then(lhs.id.cmp(&rhs.id))
    });
    entries
}

fn write_session_index_projection(
    index_path: &Path,
    entries: &[SessionIndexEntry],
    create_backup: bool,
) -> Result<SessionIndexProjectionOutput> {
    if let Some(parent) = index_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed creating directory {}", parent.display()))?;
    }

    let existing_names = if index_path.exists() {
        load_existing_session_index_names(index_path)?
    } else {
        HashMap::new()
    };
    let preserved_thread_names = entries
        .iter()
        .filter(|entry| {
            existing_names
                .get(&entry.id)
                .and_then(|value| normalize_preserved_thread_name(value))
                .is_some()
        })
        .count();
    let derived_thread_names = entries.len().saturating_sub(preserved_thread_names);

    let backup_path = if create_backup && index_path.exists() {
        let backup =
            index_path.with_extension(format!("jsonl.bak-{}", Utc::now().format("%Y%m%dT%H%M%SZ")));
        fs::copy(index_path, &backup).with_context(|| {
            format!(
                "failed creating backup from {} to {}",
                index_path.display(),
                backup.display()
            )
        })?;
        Some(backup)
    } else {
        None
    };

    let mut rendered = String::new();
    for entry in entries {
        rendered.push_str(
            &serde_json::to_string(&json!({
                "id": entry.id,
                "thread_name": entry.thread_name,
                "updated_at": render_timestamp(entry.updated_at),
            }))
            .context("failed rendering index entry")?,
        );
        rendered.push('\n');
    }
    fs::write(index_path, rendered)
        .with_context(|| format!("failed writing {}", index_path.display()))?;

    Ok(SessionIndexProjectionOutput {
        index_path: index_path.to_path_buf(),
        backup_path,
        written_entries: entries.len(),
        preserved_thread_names,
        derived_thread_names,
    })
}

fn parse_session_file_summary(path: &Path) -> Result<Option<SessionFileSummary>> {
    let Some(expected_id) = extract_session_id_from_rollout_filename(path) else {
        return Ok(None);
    };
    let file = File::open(path).with_context(|| format!("failed opening {}", path.display()))?;
    let reader = BufReader::new(file);

    let mut started_at: Option<DateTime<Utc>> = None;
    let mut updated_at: Option<DateTime<Utc>> = None;
    let mut cwd: Option<String> = None;
    let mut source: Option<String> = None;
    let mut model_provider: Option<String> = None;
    let mut cli_version: Option<String> = None;
    let mut model: Option<String> = None;
    let mut approval_mode: Option<String> = None;
    let mut sandbox_policy: Option<String> = None;
    let mut git_sha: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut git_origin_url: Option<String> = None;
    let mut dynamic_tools = Vec::new();
    let mut first_user_messages = Vec::new();

    for line in reader.lines() {
        let line = line.with_context(|| format!("failed reading {}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line)
            .with_context(|| format!("invalid json in {}", path.display()))?;

        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|value| parse_session_timestamp(value).ok());
        if let Some(timestamp) = timestamp {
            updated_at = Some(updated_at.map_or(timestamp, |current| current.max(timestamp)));
        }

        let record_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = value.get("payload");
        if record_type == "session_meta" {
            let id = payload
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str);
            if id == Some(expected_id.as_str()) {
                let started = payload
                    .and_then(|value| value.get("timestamp"))
                    .and_then(Value::as_str)
                    .and_then(|value| parse_session_timestamp(value).ok())
                    .or(timestamp);
                if let Some(started) = started {
                    started_at = Some(started);
                }
                cwd = payload
                    .and_then(|value| value.get("cwd"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or(cwd);
                source = payload
                    .and_then(|value| value.get("source"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or(source);
                model_provider = payload
                    .and_then(|value| value.get("model_provider"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or(model_provider);
                cli_version = payload
                    .and_then(|value| value.get("cli_version"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or(cli_version);
                if let Some(git) = payload.and_then(|value| value.get("git")) {
                    git_sha = git
                        .get("commit_hash")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or(git_sha);
                    git_branch = git
                        .get("branch")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or(git_branch);
                    git_origin_url = git
                        .get("repository_url")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or(git_origin_url);
                }
                dynamic_tools = payload
                    .and_then(|value| value.get("dynamic_tools"))
                    .map(parse_dynamic_tools)
                    .unwrap_or(dynamic_tools);
            }
            continue;
        }

        if record_type == "turn_context" {
            cwd = payload
                .and_then(|value| value.get("cwd"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or(cwd);
            model = payload
                .and_then(|value| value.get("model"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or(model);
            approval_mode = payload
                .and_then(|value| value.get("approval_policy"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or(approval_mode);
            sandbox_policy = payload
                .and_then(|value| value.get("sandbox_policy"))
                .map(serde_json::to_string)
                .transpose()
                .context("failed rendering sandbox policy")?
                .or(sandbox_policy);
        }

        if let (Some(timestamp), Some(text)) =
            (timestamp, extract_user_prompt_text(record_type, payload))
        {
            first_user_messages.push((timestamp, text));
        }
    }

    let Some(updated_at) = updated_at else {
        return Ok(None);
    };
    let started_at = started_at.unwrap_or(updated_at);

    Ok(Some(SessionFileSummary {
        id: expected_id,
        path: path.to_path_buf(),
        started_at,
        updated_at,
        cwd: cwd.unwrap_or_default(),
        source: source.unwrap_or_else(|| "unknown".to_string()),
        model_provider: model_provider.unwrap_or_else(|| "openai".to_string()),
        cli_version: cli_version.unwrap_or_default(),
        model: model.unwrap_or_else(|| "unknown".to_string()),
        approval_mode: approval_mode.unwrap_or_else(|| "never".to_string()),
        sandbox_policy: sandbox_policy.unwrap_or_else(|| "{}".to_string()),
        git_sha,
        git_branch,
        git_origin_url,
        dynamic_tools,
        first_user_messages,
    }))
}

fn parse_dynamic_tools(value: &Value) -> Vec<DynamicToolRecord> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let description = item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let input_schema = item
                .get("input_schema")
                .or_else(|| item.get("inputSchema"))
                .map(serde_json::to_string)
                .transpose()
                .ok()
                .flatten()
                .unwrap_or_else(|| "{}".to_string());
            let defer_loading = item
                .get("defer_loading")
                .or_else(|| item.get("deferLoading"))
                .and_then(Value::as_bool)
                .unwrap_or(false);

            Some(DynamicToolRecord {
                name: name.to_string(),
                description,
                input_schema,
                defer_loading,
            })
        })
        .collect()
}

fn extract_user_prompt_text(record_type: &str, payload: Option<&Value>) -> Option<String> {
    let text = match record_type {
        "event_msg" => {
            let payload = payload?;
            if payload.get("type").and_then(Value::as_str) != Some("user_message") {
                return None;
            }
            payload
                .get("message")
                .and_then(Value::as_str)
                .map(|value| value.to_string())
        }
        "response_item" => {
            let payload = payload?;
            if payload.get("type").and_then(Value::as_str) != Some("message") {
                return None;
            }
            if payload.get("role").and_then(Value::as_str) != Some("user") {
                return None;
            }
            let content = payload.get("content")?.as_array()?;
            content
                .iter()
                .find_map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("input_text") {
                        item.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .map(|value| value.to_string())
        }
        _ => None,
    }?;

    normalize_thread_name(&text)
}

fn normalize_thread_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('<') && trimmed.ends_with('>') {
        return None;
    }

    let compact = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    if compact.starts_with("# AGENTS.md instructions for ") {
        return None;
    }
    const IGNORED_MARKERS: [&str; 6] = [
        "<environment_context>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "<skills_instructions>",
        "<plugins_instructions>",
        "<app-context>",
    ];
    if IGNORED_MARKERS
        .iter()
        .any(|marker| compact.contains(marker))
    {
        return None;
    }

    const MAX_THREAD_NAME_LEN: usize = 120;
    let shortened = if compact.chars().count() > MAX_THREAD_NAME_LEN {
        compact
            .chars()
            .take(MAX_THREAD_NAME_LEN)
            .collect::<String>()
    } else {
        compact
    };
    Some(shortened)
}

fn normalize_preserved_thread_name(value: &str) -> Option<String> {
    let normalized = normalize_thread_name(value)?;
    let trailing_braces = normalized
        .chars()
        .rev()
        .take_while(|value| matches!(value, '}' | ']' | ')' | '\'' | '"' | '】'))
        .count();
    if trailing_braces >= 3 {
        return None;
    }
    if normalized.contains("\\\"")
        || normalized.contains("]}]")
        || normalized.contains("}]}")
        || normalized.contains("'}")
    {
        return None;
    }
    Some(normalized)
}

fn pick_first_message_after_start(
    messages: &[(DateTime<Utc>, String)],
    started_at: DateTime<Utc>,
) -> Option<String> {
    messages
        .iter()
        .filter(|(timestamp, _)| *timestamp >= started_at)
        .min_by(|lhs, rhs| lhs.0.cmp(&rhs.0))
        .map(|(_, text)| text.clone())
        .or_else(|| {
            messages
                .iter()
                .min_by(|lhs, rhs| lhs.0.cmp(&rhs.0))
                .map(|(_, text)| text.clone())
        })
}

fn normalize_desktop_source(value: &str) -> String {
    match value {
        "cli" | "vscode" | "appServer" => value.to_string(),
        _ => "cli".to_string(),
    }
}

fn write_desktop_state_projection(
    state_db_path: &Path,
    rows: &[DesktopThreadProjection],
    create_backup: bool,
) -> Result<DesktopStateProjectionOutput> {
    if let Some(parent) = state_db_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed creating directory {}", parent.display()))?;
    }

    let backup_path = if create_backup && state_db_path.exists() {
        let backup = state_db_path.with_extension(format!(
            "sqlite.bak-{}",
            Utc::now().format("%Y%m%dT%H%M%SZ")
        ));
        fs::copy(state_db_path, &backup).with_context(|| {
            format!(
                "failed creating backup from {} to {}",
                state_db_path.display(),
                backup.display()
            )
        })?;
        Some(backup)
    } else {
        None
    };

    let temp_path = unique_temp_path(state_db_path, "sqlite.tmp");
    if temp_path.exists() {
        fs::remove_file(&temp_path)
            .with_context(|| format!("failed removing stale temp db {}", temp_path.display()))?;
    }

    let template_home = create_desktop_state_template(state_db_path).ok();
    if let Some(template_home) = template_home.as_ref() {
        let template_state_db_path = latest_versioned_sqlite(template_home, "state", 5);
        fs::copy(&template_state_db_path, &temp_path).with_context(|| {
            format!(
                "failed copying template state db {} -> {}",
                template_state_db_path.display(),
                temp_path.display()
            )
        })?;
    }

    let connection = Connection::open(&temp_path)
        .with_context(|| format!("failed opening sqlite {}", temp_path.display()))?;
    ensure_desktop_projection_schema(&connection)?;
    clear_desktop_projection_tables(&connection)?;
    write_desktop_projection_rows(&connection, rows)?;
    mark_desktop_projection_complete(&connection)?;
    drop(connection);
    if let Some(template_home) = template_home {
        let _ = fs::remove_dir_all(template_home);
    }

    fs::rename(&temp_path, state_db_path).with_context(|| {
        format!(
            "failed moving desktop projection db {} -> {}",
            temp_path.display(),
            state_db_path.display()
        )
    })?;

    let normalized_sources = rows.iter().filter(|row| row.normalized_source).count();
    let projected_target_provider_threads =
        rows.iter().filter(|row| row.projected_to_target).count();
    let target_model_provider = rows
        .iter()
        .find(|row| row.projected_to_target)
        .map(|row| row.model_provider.clone());

    Ok(DesktopStateProjectionOutput {
        state_db_path: state_db_path.to_path_buf(),
        backup_path,
        written_threads: rows.len(),
        normalized_sources,
        projected_target_provider_threads,
        target_model_provider,
    })
}

fn create_desktop_state_template(state_db_path: &Path) -> Result<PathBuf> {
    let template_root = state_db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(
            ".nexus-state-template-{}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%3f"),
            std::process::id()
        ));
    fs::create_dir_all(&template_root).with_context(|| {
        format!(
            "failed creating temporary codex home {}",
            template_root.display()
        )
    })?;

    let request = json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "nexus",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }
    });

    let mut child = ProcessCommand::new("codex")
        .arg("app-server")
        .env("CODEX_HOME", &template_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "failed spawning `codex app-server` for template state db under {}",
                template_root.display()
            )
        })?;

    {
        let mut stdin = child
            .stdin
            .take()
            .context("failed opening `codex app-server` stdin")?;
        stdin
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&request).context("failed rendering init request")?
                )
                .as_bytes(),
            )
            .context("failed writing init request to `codex app-server`")?;
    }

    let output = child
        .wait_with_output()
        .context("failed waiting for `codex app-server` template init")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "`codex app-server` failed while creating template state db at {}: {}",
            template_root.display(),
            stderr.trim()
        );
    }

    Ok(template_root)
}

fn ensure_desktop_projection_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source TEXT NOT NULL,
                model_provider TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                sandbox_policy TEXT NOT NULL,
                approval_mode TEXT NOT NULL,
                tokens_used INTEGER NOT NULL DEFAULT 0,
                has_user_event INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at INTEGER,
                git_sha TEXT,
                git_branch TEXT,
                git_origin_url TEXT,
                cli_version TEXT NOT NULL DEFAULT '',
                first_user_message TEXT NOT NULL DEFAULT '',
                agent_nickname TEXT,
                agent_role TEXT,
                memory_mode TEXT NOT NULL DEFAULT 'enabled',
                model TEXT,
                reasoning_effort TEXT,
                agent_path TEXT
            );
            CREATE TABLE IF NOT EXISTS thread_dynamic_tools (
                thread_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                input_schema TEXT NOT NULL,
                defer_loading INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(thread_id, position)
            );
            CREATE TABLE IF NOT EXISTS thread_spawn_edges (
                parent_thread_id TEXT NOT NULL,
                child_thread_id TEXT NOT NULL PRIMARY KEY,
                status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stage1_outputs (
                thread_id TEXT PRIMARY KEY,
                source_updated_at INTEGER NOT NULL,
                raw_memory TEXT NOT NULL,
                rollout_summary TEXT NOT NULL,
                generated_at INTEGER NOT NULL,
                rollout_slug TEXT,
                usage_count INTEGER,
                last_usage INTEGER,
                selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
                selected_for_phase2_source_updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS backfill_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                status TEXT NOT NULL,
                last_watermark TEXT,
                last_success_at INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                kind TEXT NOT NULL,
                job_key TEXT NOT NULL,
                status TEXT NOT NULL,
                worker_id TEXT,
                ownership_token TEXT,
                started_at INTEGER,
                finished_at INTEGER,
                lease_until INTEGER,
                retry_at INTEGER,
                retry_remaining INTEGER NOT NULL,
                last_error TEXT,
                input_watermark INTEGER,
                last_success_watermark INTEGER,
                PRIMARY KEY (kind, job_key)
            );
            CREATE TABLE IF NOT EXISTS agent_jobs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                instruction TEXT NOT NULL,
                output_schema_json TEXT,
                input_headers_json TEXT NOT NULL,
                input_csv_path TEXT NOT NULL,
                output_csv_path TEXT NOT NULL,
                auto_export INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                started_at INTEGER,
                completed_at INTEGER,
                last_error TEXT,
                max_runtime_seconds INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_job_items (
                job_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                row_index INTEGER NOT NULL,
                source_id TEXT,
                row_json TEXT NOT NULL,
                status TEXT NOT NULL,
                assigned_thread_id TEXT,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                result_json TEXT,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                reported_at INTEGER,
                PRIMARY KEY (job_id, item_id)
            );
            INSERT OR IGNORE INTO backfill_state (id, status, last_watermark, last_success_at, updated_at)
            VALUES (1, 'complete', NULL, NULL, 0);",
        )
        .context("failed ensuring desktop projection schema")
}

fn clear_desktop_projection_tables(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "DELETE FROM thread_dynamic_tools;
            DELETE FROM thread_spawn_edges;
            DELETE FROM stage1_outputs;
            DELETE FROM agent_job_items;
            DELETE FROM agent_jobs;
            DELETE FROM jobs;
            DELETE FROM threads;",
        )
        .context("failed clearing desktop projection tables")
}

fn write_desktop_projection_rows(
    connection: &Connection,
    rows: &[DesktopThreadProjection],
) -> Result<()> {
    let transaction = connection
        .unchecked_transaction()
        .context("failed starting desktop projection transaction")?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO threads (
                    id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
                    sandbox_policy, approval_mode, tokens_used, has_user_event, archived,
                    archived_at, git_sha, git_branch, git_origin_url, cli_version,
                    first_user_message, agent_nickname, agent_role, memory_mode, model,
                    reasoning_effort, agent_path
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 0, 0, NULL, ?11, ?12, ?13, ?14, ?15, NULL, NULL, 'enabled', ?16, ?17, NULL)",
            )
            .context("failed preparing desktop thread insert")?;
        let mut dynamic_tool_statement = transaction
            .prepare(
                "INSERT INTO thread_dynamic_tools (
                    thread_id, position, name, description, input_schema, defer_loading
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .context("failed preparing desktop tool insert")?;

        for row in rows {
            let rollout_path = row.rollout_path.to_string_lossy().into_owned();
            statement
                .execute(params![
                    row.id.as_str(),
                    rollout_path.as_str(),
                    row.created_at.timestamp(),
                    row.updated_at.timestamp(),
                    row.source.as_str(),
                    row.model_provider.as_str(),
                    row.cwd.as_str(),
                    row.title.as_str(),
                    row.sandbox_policy.as_str(),
                    row.approval_mode.as_str(),
                    row.git_sha.as_deref(),
                    row.git_branch.as_deref(),
                    row.git_origin_url.as_deref(),
                    row.cli_version.as_str(),
                    row.title.as_str(),
                    row.model.as_str(),
                    row.reasoning_effort.as_deref(),
                ])
                .with_context(|| format!("failed inserting desktop thread {}", row.id))?;

            for (position, tool) in row.dynamic_tools.iter().enumerate() {
                dynamic_tool_statement
                    .execute(params![
                        row.id.as_str(),
                        position as i64,
                        tool.name.as_str(),
                        tool.description.as_str(),
                        tool.input_schema.as_str(),
                        i64::from(tool.defer_loading),
                    ])
                    .with_context(|| {
                        format!(
                            "failed inserting desktop dynamic tool {} for {}",
                            tool.name, row.id
                        )
                    })?;
            }
        }
    }
    transaction
        .commit()
        .context("failed committing desktop projection rows")
}

fn mark_desktop_projection_complete(connection: &Connection) -> Result<()> {
    let now = Utc::now().timestamp();
    connection
        .execute(
            "UPDATE backfill_state
             SET status = 'complete',
                 last_watermark = NULL,
                 last_success_at = ?1,
                 updated_at = ?1
             WHERE id = 1",
            params![now],
        )
        .context("failed updating desktop projection backfill state")?;
    Ok(())
}

fn parse_session_timestamp(value: &str) -> Result<DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("invalid session timestamp: {value}"))
        .map(|value| value.with_timezone(&Utc))
}

fn extract_session_id_from_rollout_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let mut parts = stem.rsplit('-').take(5).collect::<Vec<_>>();
    if parts.len() != 5 {
        return None;
    }
    parts.reverse();
    let lengths = [8usize, 4, 4, 4, 12];
    if !parts.iter().zip(lengths).all(|(part, length)| {
        part.len() == length && part.chars().all(|value| value.is_ascii_hexdigit())
    }) {
        return None;
    }
    Some(parts.join("-"))
}

fn extract_toml_string(config: &str, key: &str) -> Option<String> {
    let pattern = format!("{key} =");
    config.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(&pattern) {
            return None;
        }
        let (_, right) = trimmed.split_once('=')?;
        let value = right.trim().trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn derive_desktop_model_provider(config: &str) -> String {
    extract_toml_string(config, "model_provider")
        .or_else(|| {
            if extract_toml_string(config, "base_url").is_some() {
                Some("custom".to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "openai".to_string())
}

fn render_timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn unique_temp_path(base: &Path, suffix_prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    base.with_extension(format!("{suffix_prefix}-{nanos}"))
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;

    use chrono::{TimeZone, Utc};
    use rusqlite::Connection;
    use tempfile::tempdir;

    use super::{
        DesktopThreadProjection, DynamicToolRecord, build_session_index_entries,
        build_target_desktop_thread_projections, derive_desktop_model_provider,
        normalize_thread_name, pick_first_message_after_start, scan_session_summaries,
        write_desktop_projection_rows, write_desktop_state_projection,
        write_session_index_projection,
    };
    use crate::codex_replay::model::ActivationEvent;

    #[test]
    fn derive_desktop_model_provider_prefers_configured_value() {
        let custom_config = "model_provider = \"custom\"\nmodel = \"gpt-5.4\"\n\n[model_providers.custom]\nbase_url = \"https://example.com/v1\"\n";
        let base_url_only = "base_url = \"https://example.com/v1\"\n";
        let openai_default = "model = \"gpt-5.4\"\n";

        assert_eq!(derive_desktop_model_provider(custom_config), "custom");
        assert_eq!(derive_desktop_model_provider(base_url_only), "custom");
        assert_eq!(derive_desktop_model_provider(openai_default), "openai");
    }

    #[test]
    fn normalize_thread_name_ignores_context_blobs() {
        assert!(normalize_thread_name("<environment_context>").is_none());
        assert_eq!(
            normalize_thread_name("  切到 SSH 远端  ").as_deref(),
            Some("切到 SSH 远端")
        );
    }

    #[test]
    fn pick_first_message_after_start_prefers_current_session() {
        let started_at = Utc.with_ymd_and_hms(2026, 4, 14, 12, 0, 0).unwrap();
        let messages = vec![
            (
                Utc.with_ymd_and_hms(2026, 4, 14, 11, 59, 0).unwrap(),
                "older".to_string(),
            ),
            (
                Utc.with_ymd_and_hms(2026, 4, 14, 12, 0, 5).unwrap(),
                "current".to_string(),
            ),
        ];

        let picked = pick_first_message_after_start(&messages, started_at).expect("picked");
        assert_eq!(picked, "current");
    }

    #[test]
    fn build_target_projection_normalizes_exec_source_and_target_provider() {
        let summary = super::SessionFileSummary {
            id: "11111111-2222-3333-4444-555555555555".to_string(),
            path: PathBuf::from("/tmp/session.jsonl"),
            started_at: Utc.with_ymd_and_hms(2026, 4, 14, 12, 0, 0).unwrap(),
            updated_at: Utc.with_ymd_and_hms(2026, 4, 14, 12, 1, 0).unwrap(),
            cwd: "/workspace/demo".to_string(),
            source: "exec".to_string(),
            model_provider: "openai".to_string(),
            cli_version: "0.117.0".to_string(),
            model: "gpt-5.4".to_string(),
            approval_mode: "never".to_string(),
            sandbox_policy: "{}".to_string(),
            git_sha: None,
            git_branch: None,
            git_origin_url: None,
            dynamic_tools: vec![],
            first_user_messages: vec![(
                Utc.with_ymd_and_hms(2026, 4, 14, 12, 0, 5).unwrap(),
                "Fix replay sync".to_string(),
            )],
        };
        let activations = vec![ActivationEvent::new(
            Utc.with_ymd_and_hms(2026, 4, 14, 11, 59, 0).unwrap(),
            "codex".into(),
            "provider-old".into(),
            None,
            Some("manual".into()),
            false,
            false,
            false,
        )];
        let provider_ids =
            HashSet::from(["provider-old".to_string(), "provider-target".to_string()]);

        let projected = build_target_desktop_thread_projections(
            &[summary],
            &activations,
            &provider_ids,
            "provider-target",
            "custom",
            false,
        );

        assert_eq!(projected.len(), 1);
        assert!(projected[0].projected_to_target);
        assert_eq!(projected[0].source, "cli");
        assert_eq!(projected[0].model_provider, "custom");
        assert_eq!(projected[0].title, "Fix replay sync");
    }

    #[test]
    fn write_desktop_projection_rows_persists_threads_and_dynamic_tools() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("state.sqlite");
        let connection = Connection::open(&db_path).expect("open");
        super::ensure_desktop_projection_schema(&connection).expect("schema");

        let rows = vec![DesktopThreadProjection {
            id: "session-1".to_string(),
            rollout_path: PathBuf::from("/tmp/session-1.jsonl"),
            created_at: Utc.with_ymd_and_hms(2026, 4, 14, 12, 0, 0).unwrap(),
            updated_at: Utc.with_ymd_and_hms(2026, 4, 14, 12, 1, 0).unwrap(),
            source: "cli".to_string(),
            model_provider: "custom".to_string(),
            cwd: "/workspace/demo".to_string(),
            title: "Fix replay sync".to_string(),
            sandbox_policy: "{}".to_string(),
            approval_mode: "never".to_string(),
            cli_version: "0.117.0".to_string(),
            model: "gpt-5.4".to_string(),
            reasoning_effort: Some("high".to_string()),
            git_sha: Some("abc123".to_string()),
            git_branch: Some("main".to_string()),
            git_origin_url: Some("https://example.com/repo.git".to_string()),
            dynamic_tools: vec![DynamicToolRecord {
                name: "shell_exec".to_string(),
                description: "execute shell command".to_string(),
                input_schema: "{\"type\":\"object\"}".to_string(),
                defer_loading: false,
            }],
            normalized_source: false,
            projected_to_target: true,
        }];

        write_desktop_projection_rows(&connection, &rows).expect("projection rows");

        let thread_row = connection
            .prepare("SELECT id, model_provider, source, title FROM threads")
            .expect("prepare thread query")
            .query_row([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .expect("thread row");
        assert_eq!(
            thread_row,
            (
                "session-1".to_string(),
                "custom".to_string(),
                "cli".to_string(),
                "Fix replay sync".to_string(),
            )
        );

        let tool_row = connection
            .prepare("SELECT thread_id, name, description, input_schema FROM thread_dynamic_tools")
            .expect("prepare tool query")
            .query_row([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .expect("tool row");
        assert_eq!(
            tool_row,
            (
                "session-1".to_string(),
                "shell_exec".to_string(),
                "execute shell command".to_string(),
                "{\"type\":\"object\"}".to_string(),
            )
        );
    }

    #[test]
    fn write_desktop_state_projection_rebuilds_from_corrupt_existing_db() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("state_5.sqlite");
        fs::write(&db_path, b"not-a-sqlite-db").expect("write corrupt db");

        let rows = vec![DesktopThreadProjection {
            id: "session-1".to_string(),
            rollout_path: PathBuf::from("/tmp/session-1.jsonl"),
            created_at: Utc.with_ymd_and_hms(2026, 4, 14, 12, 0, 0).unwrap(),
            updated_at: Utc.with_ymd_and_hms(2026, 4, 14, 12, 1, 0).unwrap(),
            source: "cli".to_string(),
            model_provider: "custom".to_string(),
            cwd: "/workspace/demo".to_string(),
            title: "Recovered from corrupt db".to_string(),
            sandbox_policy: "{}".to_string(),
            approval_mode: "never".to_string(),
            cli_version: "0.117.0".to_string(),
            model: "gpt-5.4".to_string(),
            reasoning_effort: Some("high".to_string()),
            git_sha: None,
            git_branch: None,
            git_origin_url: None,
            dynamic_tools: vec![],
            normalized_source: false,
            projected_to_target: true,
        }];

        let projection =
            write_desktop_state_projection(&db_path, &rows, true).expect("rebuild projection");
        assert_eq!(projection.written_threads, 1);

        let connection = Connection::open(&db_path).expect("open rebuilt db");
        let thread_row = connection
            .prepare("SELECT id, title FROM threads")
            .expect("prepare thread query")
            .query_row([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("thread row");
        assert_eq!(
            thread_row,
            (
                "session-1".to_string(),
                "Recovered from corrupt db".to_string()
            )
        );
    }

    #[test]
    fn session_index_rebuild_derives_first_user_message() {
        let dir = tempdir().expect("tempdir");
        let sessions_dir = dir
            .path()
            .join("sessions")
            .join("2026")
            .join("04")
            .join("14");
        fs::create_dir_all(&sessions_dir).expect("mkdir");
        let session_id = "11111111-2222-3333-4444-555555555555";
        let file = sessions_dir.join(format!("rollout-2026-04-14-{session_id}.jsonl"));
        fs::write(
            &file,
            concat!(
                "{\"timestamp\":\"2026-04-14T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"11111111-2222-3333-4444-555555555555\",\"timestamp\":\"2026-04-14T12:00:00.000Z\",\"cwd\":\"/workspace/demo\",\"source\":\"cli\",\"model_provider\":\"openai\",\"cli_version\":\"0.117.0\"}}\n",
                "{\"timestamp\":\"2026-04-14T12:00:01.000Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.4\",\"approval_policy\":\"never\",\"sandbox_policy\":{}}}\n",
                "{\"timestamp\":\"2026-04-14T12:00:02.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Fix replay sync\"}]}}\n"
            ),
        )
        .expect("write");

        let summaries =
            scan_session_summaries(dir.path().join("sessions").as_path()).expect("scan");
        let entries = build_session_index_entries(&summaries, &HashMap::new());
        let projection = write_session_index_projection(
            &dir.path().join("session_index.jsonl"),
            &entries,
            false,
        )
        .expect("projection");

        assert_eq!(projection.written_entries, 1);
        let rendered = fs::read_to_string(dir.path().join("session_index.jsonl")).expect("read");
        assert!(rendered.contains("Fix replay sync"));
        assert!(rendered.contains(session_id));
    }
}
