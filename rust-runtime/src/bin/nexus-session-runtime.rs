use nexus_rust_runtime::child_runtime_protocol::{
    ProtocolOutput, RuntimeControl, RuntimeMessage, StdioProtocol,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use nexus_rust_runtime::native_session_registry::NativeLaunchPlan;

#[path = "nexus_session_runtime/backend.rs"]
mod backend;
#[path = "nexus_session_runtime/tmux_backend.rs"]
mod tmux_backend;

use backend::{CodexSessionCleanup, SessionCatalog, SessionLifecycle};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectParams {
    session_name: String,
    cwd: String,
    initial_window_name: String,
    shell_cmd: String,
    launch_plan: Option<NativeLaunchPlan>,
    #[serde(default)]
    proxy_vars: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectChannelParams {
    session_name: String,
    cwd: String,
    channel_name: String,
    shell_cmd: String,
    default_shell_cmd: String,
    launch_plan: Option<NativeLaunchPlan>,
    #[serde(default)]
    proxy_vars: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateResumeWindowParams {
    session_name: String,
    cwd: String,
    window_name: String,
    shell_cmd: String,
    default_shell_cmd: String,
    launch_plan: Option<NativeLaunchPlan>,
    #[serde(default)]
    proxy_vars: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WindowIndex {
    String(String),
    Number(usize),
}

impl WindowIndex {
    fn as_string(&self) -> String {
        match self {
            Self::String(value) => value.clone(),
            Self::Number(value) => value.to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameProjectParams {
    old_name: String,
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteProjectParams {
    session_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachSessionWindowParams {
    session_name: String,
    index: WindowIndex,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameSessionWindowParams {
    session_name: String,
    index: WindowIndex,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteSessionWindowParams {
    session_name: String,
    index: WindowIndex,
    #[serde(default)]
    create_fallback_shell: bool,
    #[serde(default)]
    default_shell_cmd: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GetSessionCwdParams {
    session_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListProjectChannelsParams {
    project_name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListSessionWindowsParams {
    session_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateProjectParams {
    project_name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListCodexSessionsParams {
    project_name: String,
    #[serde(default)]
    limit: Value,
    #[serde(default)]
    cursor: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetCodexSessionDetailParams {
    session_id: String,
    project_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeCodexSessionParams {
    #[serde(default)]
    session_name: String,
    project_name: String,
    session_id: String,
    cwd: String,
    window_name: String,
    shell_cmd: String,
    launch_plan: Option<NativeLaunchPlan>,
    #[serde(default)]
    proxy_vars: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteProjectCodexSessionParams {
    session_id: String,
    project_name: String,
    #[serde(default)]
    default_shell_cmd: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeCapabilities {
    sessions: bool,
    admin: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    ready: bool,
    source: &'static str,
    version: &'static str,
    capabilities: RuntimeCapabilities,
    projects_created: usize,
    windows_created: usize,
}

#[derive(Clone)]
struct SharedState {
    projects_created: Arc<AtomicUsize>,
    windows_created: Arc<AtomicUsize>,
}

impl SharedState {
    fn runtime_status(&self) -> ReadyPayload {
        ReadyPayload {
            ready: true,
            source: "nexus-session-runtime",
            version: env!("CARGO_PKG_VERSION"),
            capabilities: RuntimeCapabilities {
                sessions: true,
                admin: true,
            },
            projects_created: self.projects_created.load(Ordering::SeqCst),
            windows_created: self.windows_created.load(Ordering::SeqCst),
        }
    }
}

#[derive(Clone)]
struct CodexSessionIndexEntry {
    id: String,
    title: String,
    updated_at: String,
}

#[derive(Clone)]
struct CodexSessionMetaEntry {
    file_path: PathBuf,
    cwd: String,
    timestamp: String,
    source: String,
    originator: String,
    cli_version: String,
    model_provider: String,
}

#[derive(Clone)]
struct CodexSessionSummary {
    id: String,
    title: String,
    updated_at: String,
    cwd: String,
    attribution_kind: String,
}

struct CodexCollectionResult {
    scope: Value,
    items: Vec<CodexSessionSummary>,
    warning: Value,
}

fn respond_with(output: &ProtocolOutput, id: String, result: Result<Value, String>) {
    match result {
        Ok(result) => output.success(id, result),
        Err(error) => output.failure(id, error),
    }
}

fn parse_and_respond<P>(
    output: &ProtocolOutput,
    id: String,
    params: Value,
    action: impl FnOnce(P) -> Result<Value, String>,
) where
    P: DeserializeOwned,
{
    match serde_json::from_value::<P>(params) {
        Ok(params) => respond_with(output, id, action(params)),
        Err(error) => output.failure(id, error.to_string()),
    }
}

fn env_or_default(key: &str, default: &str) -> String {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn resolve_existing_project_path(project_name: &str) -> Result<String, String> {
    SessionCatalog::current()?.resolve_existing_project_path(project_name)
}

fn current_codex_home() -> String {
    let explicit = env_or_default("NEXUS_SESSION_MANAGEMENT_CODEX_HOME", "");
    if !explicit.is_empty() {
        return explicit;
    }

    let home = env_or_default("HOME", "");
    if home.is_empty() {
        return String::new();
    }

    Path::new(&home)
        .join(".codex")
        .to_string_lossy()
        .to_string()
}

fn current_codex_runtime_dir() -> PathBuf {
    let explicit = env_or_default("NEXUS_SESSION_MANAGEMENT_CODEX_RUNTIME_DIR", "");
    if !explicit.is_empty() {
        return PathBuf::from(explicit);
    }

    let data_dir = env_or_default("NEXUS_DATA_DIR", "data");
    let data_path = {
        let candidate = PathBuf::from(&data_dir);
        if candidate.is_absolute() {
            candidate
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(candidate)
        }
    };

    data_path.join("codex-runtime")
}

fn normalize_path(path_value: &str) -> String {
    let normalized = path_value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return String::new();
    }
    if normalized == "/" {
        return "/".to_string();
    }
    normalized.trim_end_matches('/').to_string()
}

fn is_same_or_nested_path(parent_path: &str, child_path: &str) -> bool {
    let parent = normalize_path(parent_path);
    let child = normalize_path(child_path);
    if parent.is_empty() || child.is_empty() {
        return false;
    }
    child == parent || child.starts_with(&format!("{}/", parent))
}

fn normalize_title(value: &str) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return String::new();
    }
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() > 120 {
        chars[..117].iter().collect::<String>() + "..."
    } else {
        text
    }
}

fn fallback_title(session_id: &str, cwd: &str) -> String {
    let normalized_cwd = normalize_path(cwd);
    if let Some(last_segment) = normalized_cwd
        .split('/')
        .rfind(|segment| !segment.is_empty())
    {
        return last_segment.to_string();
    }

    let short_id = if session_id.len() > 8 {
        &session_id[..8]
    } else {
        session_id
    };
    format!("Session {}", short_id)
}

fn parse_limit_value(value: &Value) -> usize {
    const DEFAULT_LIMIT: usize = 10;
    const MAX_LIMIT: usize = 50;

    let parsed = match value {
        Value::Number(number) => number.as_u64().map(|value| value as usize),
        Value::String(text) => text.trim().parse::<usize>().ok(),
        _ => None,
    };

    match parsed {
        Some(value) if value > 0 => value.min(MAX_LIMIT),
        _ => DEFAULT_LIMIT,
    }
}

fn parse_cursor_value(value: &Value) -> usize {
    let parsed = match value {
        Value::Number(number) => number.as_u64().map(|value| value as usize),
        Value::String(text) => text.trim().parse::<usize>().ok(),
        _ => None,
    };

    match parsed {
        Some(value) if value > 0 => value,
        _ => 0,
    }
}

fn resolve_git_root(cwd: &str) -> String {
    let normalized_cwd = normalize_path(cwd);
    if normalized_cwd.is_empty() {
        return String::new();
    }

    let output = Command::new("git")
        .args([
            "-C",
            normalized_cwd.as_str(),
            "rev-parse",
            "--show-toplevel",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(result) if result.status.success() => {
            normalize_path(String::from_utf8_lossy(&result.stdout).trim())
        }
        _ => String::new(),
    }
}

fn collect_session_files(root_dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(root_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            collect_session_files(&path, files);
            continue;
        }

        if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension == "jsonl")
                .unwrap_or(false)
        {
            files.push(path);
        }
    }
}

fn load_session_index(codex_home: &str) -> (Vec<CodexSessionIndexEntry>, usize) {
    let session_index_path = Path::new(codex_home).join("session_index.jsonl");
    if !session_index_path.exists() {
        return (vec![], 0);
    }

    let content = match fs::read_to_string(session_index_path) {
        Ok(content) => content,
        Err(_) => return (vec![], 1),
    };

    let mut bad_index_lines = 0;
    let mut entries = vec![];

    for line in content
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
    {
        match serde_json::from_str::<Value>(line) {
            Ok(parsed) => {
                let id = parsed
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if id.is_empty() {
                    bad_index_lines += 1;
                    continue;
                }

                entries.push(CodexSessionIndexEntry {
                    id,
                    title: normalize_title(
                        parsed
                            .get("thread_name")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    ),
                    updated_at: parsed
                        .get("updated_at")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                });
            }
            Err(_) => {
                bad_index_lines += 1;
            }
        }
    }

    entries.sort_by(|left, right| {
        let right_ts = right.updated_at.as_str();
        let left_ts = left.updated_at.as_str();
        right_ts.cmp(left_ts).then_with(|| left.id.cmp(&right.id))
    });

    (entries, bad_index_lines)
}

fn load_session_meta_map(codex_home: &str) -> (HashMap<String, CodexSessionMetaEntry>, usize) {
    let sessions_root = Path::new(codex_home).join("sessions");
    if !sessions_root.exists() {
        return (HashMap::new(), 0);
    }

    let mut files = vec![];
    collect_session_files(&sessions_root, &mut files);
    let mut session_meta_by_id = HashMap::new();
    let mut bad_session_files = 0;

    for file_path in files {
        let content = match fs::read_to_string(&file_path) {
            Ok(content) => content,
            Err(_) => {
                bad_session_files += 1;
                continue;
            }
        };
        let first_line = match content.lines().next() {
            Some(line) if !line.trim().is_empty() => line.trim(),
            _ => {
                bad_session_files += 1;
                continue;
            }
        };

        let parsed = match serde_json::from_str::<Value>(first_line) {
            Ok(parsed) => parsed,
            Err(_) => {
                bad_session_files += 1;
                continue;
            }
        };
        if parsed.get("type").and_then(Value::as_str).unwrap_or("") != "session_meta" {
            bad_session_files += 1;
            continue;
        }

        let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            bad_session_files += 1;
            continue;
        }

        session_meta_by_id.insert(
            id,
            CodexSessionMetaEntry {
                file_path: file_path.clone(),
                cwd: normalize_path(payload.get("cwd").and_then(Value::as_str).unwrap_or("")),
                timestamp: payload
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .or_else(|| parsed.get("timestamp").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string(),
                source: payload
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                originator: payload
                    .get("originator")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                cli_version: payload
                    .get("cli_version")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                model_provider: payload
                    .get("model_provider")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
            },
        );
    }

    (session_meta_by_id, bad_session_files)
}

fn build_warning(
    bad_index_lines: usize,
    bad_session_files: usize,
    missing_session_files: usize,
    cwd_fallback_matches: usize,
) -> Value {
    let mut codes = vec![];
    if bad_index_lines > 0 || bad_session_files > 0 || missing_session_files > 0 {
        codes.push("partial_results");
    }
    if cwd_fallback_matches > 0 {
        codes.push("attribution_unavailable");
    }
    if codes.is_empty() {
        return Value::Null;
    }

    let message = if codes.len() == 1 && codes[0] == "attribution_unavailable" {
        "部分历史会话只能按工作目录匹配，归属信息可能不完整。"
    } else if codes.len() == 2 {
        "部分历史会话结果不完整，且部分条目只能按工作目录匹配。"
    } else {
        "部分历史会话结果不可用。"
    };

    json!({
        "codes": codes,
        "message": message,
    })
}

fn collect_project_codex_sessions(
    project_name: &str,
    project_path: &str,
    codex_home: &str,
) -> CodexCollectionResult {
    let normalized_project_path = normalize_path(project_path);
    let project_repo_root = resolve_git_root(&normalized_project_path);
    let (entries, bad_index_lines) = load_session_index(codex_home);
    let (session_meta_by_id, bad_session_files) = load_session_meta_map(codex_home);
    let mut session_index_by_id = HashMap::new();
    let mut items = vec![];
    let mut missing_session_files = 0;
    let mut cwd_fallback_matches = 0;

    for entry in &entries {
        if !session_index_by_id.contains_key(&entry.id) {
            session_index_by_id.insert(entry.id.clone(), entry.clone());
        }
        if !session_meta_by_id.contains_key(&entry.id) {
            missing_session_files += 1;
        }
    }

    for (session_id, meta) in session_meta_by_id.iter() {
        let session_cwd = normalize_path(&meta.cwd);
        if session_cwd.is_empty() {
            continue;
        }

        let session_repo_root = resolve_git_root(&session_cwd);
        let attribution_kind = if !project_repo_root.is_empty() && !session_repo_root.is_empty() {
            if project_repo_root != session_repo_root {
                continue;
            }
            "repo-root".to_string()
        } else if !project_repo_root.is_empty() {
            if !is_same_or_nested_path(&normalized_project_path, &session_cwd) {
                continue;
            }
            cwd_fallback_matches += 1;
            "cwd".to_string()
        } else if session_cwd == normalized_project_path {
            cwd_fallback_matches += 1;
            "cwd".to_string()
        } else {
            continue;
        };

        let entry = session_index_by_id.get(session_id);
        items.push(CodexSessionSummary {
            id: session_id.clone(),
            title: entry
                .map(|entry| entry.title.clone())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| fallback_title(session_id, &session_cwd)),
            updated_at: entry
                .map(|entry| entry.updated_at.clone())
                .filter(|updated_at| !updated_at.is_empty())
                .unwrap_or_else(|| meta.timestamp.clone()),
            cwd: session_cwd,
            attribution_kind,
        });
    }

    items.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    CodexCollectionResult {
        scope: json!({
            "project": project_name,
            "path": normalized_project_path,
            "repoRoot": project_repo_root,
            "summary": if !project_repo_root.is_empty() {
                format!("repo root: {}", project_repo_root)
            } else {
                format!("cwd: {}", normalized_project_path)
            },
        }),
        items,
        warning: build_warning(
            bad_index_lines,
            bad_session_files,
            missing_session_files,
            cwd_fallback_matches,
        ),
    }
}

fn list_project_codex_sessions(params: ListCodexSessionsParams) -> Result<Value, String> {
    let project_name = params.project_name.trim().to_string();
    let codex_home = current_codex_home();
    let project_path = resolve_existing_project_path(&project_name)?;
    let page_size = parse_limit_value(&params.limit);
    let offset = parse_cursor_value(&params.cursor);
    let result = collect_project_codex_sessions(&project_name, &project_path, &codex_home);
    let page_items = result
        .items
        .iter()
        .skip(offset)
        .take(page_size)
        .map(|item| {
            json!({
                "id": item.id,
                "title": item.title,
                "updatedAt": item.updated_at,
                "cwd": item.cwd,
                "attributionKind": item.attribution_kind,
            })
        })
        .collect::<Vec<_>>();
    let next_cursor = if result.items.len() > offset + page_size {
        Value::String((offset + page_size).to_string())
    } else {
        Value::Null
    };

    Ok(json!({
        "scope": result.scope,
        "items": page_items,
        "nextCursor": next_cursor,
        "warning": result.warning,
    }))
}

fn get_project_codex_session_detail(params: GetCodexSessionDetailParams) -> Result<Value, String> {
    let project_name = params.project_name.trim().to_string();
    let session_id = params.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("session id required".to_string());
    }

    let codex_home = current_codex_home();
    let project_path = resolve_existing_project_path(&project_name)?;
    let result = collect_project_codex_sessions(&project_name, &project_path, &codex_home);
    let summary = match result.items.iter().find(|item| item.id == session_id) {
        Some(summary) => summary,
        None => return Err("codex session not found in project".to_string()),
    };

    let (session_meta_by_id, _) = load_session_meta_map(&codex_home);
    let meta = match session_meta_by_id.get(&session_id) {
        Some(meta) => meta,
        None => return Err("codex session not found in project".to_string()),
    };

    Ok(json!({
        "id": summary.id,
        "title": summary.title,
        "updatedAt": summary.updated_at,
        "startedAt": meta.timestamp,
        "cwd": summary.cwd,
        "attributionKind": summary.attribution_kind,
        "source": meta.source,
        "originator": meta.originator,
        "cliVersion": meta.cli_version,
        "modelProvider": meta.model_provider,
    }))
}

fn remove_session_index_entry(codex_home: &str, session_id: &str) -> Result<(), String> {
    let session_index_path = Path::new(codex_home).join("session_index.jsonl");
    if !session_index_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&session_index_path).map_err(|error| error.to_string())?;
    let mut remaining_lines = vec![];

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Ok(parsed) = serde_json::from_str::<Value>(line)
            && parsed
                .get("id")
                .and_then(Value::as_str)
                .map(|value| value == session_id)
                .unwrap_or(false)
        {
            continue;
        }

        remaining_lines.push(line.to_string());
    }

    let next_content = if remaining_lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", remaining_lines.join("\n"))
    };
    fs::write(session_index_path, next_content).map_err(|error| error.to_string())
}

fn delete_codex_session_file(session_id: &str, codex_home: &str) -> Result<PathBuf, String> {
    let (session_meta_by_id, _) = load_session_meta_map(codex_home);
    let meta = match session_meta_by_id.get(session_id) {
        Some(meta) => meta,
        None => {
            return Err(format!(
                "codex session file not found for session {}",
                session_id
            ));
        }
    };
    if !meta.file_path.exists() {
        return Err(format!(
            "codex session file not found for session {}",
            session_id
        ));
    }

    fs::remove_file(&meta.file_path).map_err(|error| error.to_string())?;
    remove_session_index_entry(codex_home, session_id)?;
    Ok(meta.file_path.clone())
}

fn delete_project_codex_session(params: DeleteProjectCodexSessionParams) -> Result<Value, String> {
    let project_name = params.project_name.trim().to_string();
    let session_id = params.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("session id required".to_string());
    }

    let codex_home = current_codex_home();
    let project_path = resolve_existing_project_path(&project_name)?;
    let result = collect_project_codex_sessions(&project_name, &project_path, &codex_home);
    if !result.items.iter().any(|item| item.id == session_id) {
        return Err("codex session not found in project".to_string());
    }

    delete_codex_session_file(&session_id, &codex_home)?;
    let closed_window_indexes = CodexSessionCleanup::current()?.close_resume_channels(
        &project_name,
        &session_id,
        &params.default_shell_cmd,
    )?;

    Ok(json!({
        "ok": true,
        "sessionId": session_id,
        "closedWindowIndexes": closed_window_indexes,
    }))
}

fn list_tmux_sessions() -> Result<Value, String> {
    SessionCatalog::current()?.list_sessions()
}

fn list_all_session_names() -> Result<Value, String> {
    SessionCatalog::current()?.list_all_session_names()
}

fn list_projects() -> Result<Value, String> {
    SessionCatalog::current()?.list_projects()
}

fn get_session_cwd(params: GetSessionCwdParams) -> Result<Value, String> {
    SessionCatalog::current()?.get_session_cwd(params)
}

fn list_project_channels(params: ListProjectChannelsParams) -> Result<Value, String> {
    SessionCatalog::current()?.list_project_channels(params)
}

fn list_session_windows(params: ListSessionWindowsParams) -> Result<Value, String> {
    SessionCatalog::current()?.list_session_windows(params)
}

fn activate_project(params: ActivateProjectParams) -> Result<Value, String> {
    SessionCatalog::current()?.activate_project(params)
}

fn create_project(state: &SharedState, params: CreateProjectParams) -> Result<Value, String> {
    SessionLifecycle::current()?.create_project(state, params)
}

fn create_project_channel(
    state: &SharedState,
    params: CreateProjectChannelParams,
) -> Result<Value, String> {
    SessionLifecycle::current()?.create_project_channel(state, params)
}

fn create_resume_window(
    state: &SharedState,
    params: CreateResumeWindowParams,
) -> Result<Value, String> {
    SessionLifecycle::current()?.create_resume_window(state, params)
}

fn resume_codex_session(
    state: &SharedState,
    params: ResumeCodexSessionParams,
) -> Result<Value, String> {
    SessionLifecycle::current()?.resume_codex_session(state, params)
}

fn rename_project(params: RenameProjectParams) -> Result<Value, String> {
    SessionLifecycle::current()?.rename_project(params)
}

fn delete_project(params: DeleteProjectParams) -> Result<Value, String> {
    SessionLifecycle::current()?.delete_project(params)
}

fn attach_session_window(params: AttachSessionWindowParams) -> Result<Value, String> {
    SessionLifecycle::current()?.attach_session_window(params)
}

fn rename_session_window(params: RenameSessionWindowParams) -> Result<Value, String> {
    SessionLifecycle::current()?.rename_session_window(params)
}

fn delete_session_window(params: DeleteSessionWindowParams) -> Result<Value, String> {
    SessionLifecycle::current()?.delete_session_window(params)
}
fn main() {
    let (mut protocol, output) = StdioProtocol::start();
    let state = SharedState {
        projects_created: Arc::new(AtomicUsize::new(0)),
        windows_created: Arc::new(AtomicUsize::new(0)),
    };

    protocol.run(|message| {
        let RuntimeMessage::Request { id, method, params } = message else {
            return RuntimeControl::Continue;
        };
        match method.as_str() {
            "ready" | "runtimeStatus" => output.success(id, state.runtime_status()),
            "listTmuxSessions" => respond_with(&output, id, list_tmux_sessions()),
            "listAllSessionNames" => respond_with(&output, id, list_all_session_names()),
            "listProjects" => respond_with(&output, id, list_projects()),
            "getSessionCwd" => {
                parse_and_respond(&output, id, params, get_session_cwd);
            }
            "listProjectChannels" => {
                parse_and_respond(&output, id, params, list_project_channels);
            }
            "listSessionWindows" => {
                parse_and_respond(&output, id, params, list_session_windows);
            }
            "activateProject" => {
                parse_and_respond(&output, id, params, activate_project);
            }
            "listCodexSessions" => {
                parse_and_respond(&output, id, params, list_project_codex_sessions);
            }
            "getCodexSessionDetail" => {
                parse_and_respond(&output, id, params, get_project_codex_session_detail);
            }
            "resumeCodexSession" => {
                parse_and_respond(&output, id, params, |params| {
                    resume_codex_session(&state, params)
                });
            }
            "deleteProjectCodexSession" => {
                parse_and_respond(&output, id, params, delete_project_codex_session);
            }
            "createProject" => {
                parse_and_respond(&output, id, params, |params| create_project(&state, params));
            }
            "createProjectChannel" => {
                parse_and_respond(&output, id, params, |params| {
                    create_project_channel(&state, params)
                });
            }
            "createResumeWindow" => {
                parse_and_respond(&output, id, params, |params| {
                    create_resume_window(&state, params)
                });
            }
            "renameProject" => {
                parse_and_respond(&output, id, params, rename_project);
            }
            "deleteProject" => {
                parse_and_respond(&output, id, params, delete_project);
            }
            "attachSessionWindow" => {
                parse_and_respond(&output, id, params, attach_session_window);
            }
            "renameSessionWindow" => {
                parse_and_respond(&output, id, params, rename_session_window);
            }
            "deleteSessionWindow" => {
                parse_and_respond(&output, id, params, delete_session_window);
            }
            "shutdown" => {
                output.success(id, serde_json::json!({ "ok": true }));
                return RuntimeControl::Shutdown;
            }
            _ => output.failure(id, format!("unsupported method: {method}")),
        }
        RuntimeControl::Continue
    });

    drop(state);
    drop(output);
    protocol.finish();
}
