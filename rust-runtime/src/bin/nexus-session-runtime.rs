use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread;

use nexus_rust_runtime::native_session_registry::{
    NativeLaunchPlan, NativeProcessInstance, NativeSessionRegistry,
};

#[path = "nexus_session_runtime/tmux_backend.rs"]
mod tmux_backend;

use tmux_backend::TmuxSessionBackend;

const CODEX_RESUME_SESSION_METADATA_KEY: &str = "@nexus_codex_resume_session_id";

#[derive(Deserialize)]
struct Message {
    kind: String,
    id: Option<String>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

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

#[derive(Serialize)]
struct ResponseMessage<T>
where
    T: Serialize,
{
    kind: &'static str,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ResponseError>,
}

#[derive(Serialize)]
struct ResponseError {
    message: String,
}

#[derive(Clone)]
struct SharedState {
    event_tx: Sender<String>,
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

    fn send_json<T>(&self, value: &T)
    where
        T: Serialize,
    {
        if let Ok(line) = serde_json::to_string(value) {
            let _ = self.event_tx.send(line);
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

fn send_response<T>(
    state: &SharedState,
    id: String,
    ok: bool,
    result: Option<T>,
    error: Option<String>,
) where
    T: Serialize,
{
    state.send_json(&ResponseMessage {
        kind: "response",
        id,
        ok,
        result,
        error: error.map(|message| ResponseError { message }),
    });
}

fn env_or_default(key: &str, default: &str) -> String {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn current_tmux_session() -> String {
    env_or_default("TMUX_SESSION", "nexus")
}

fn current_workspace_root() -> String {
    env_or_default("WORKSPACE_ROOT", "")
}

fn native_backend_enabled() -> bool {
    env::var("NEXUS_SESSION_BACKEND")
        .ok()
        .map(|value| value.trim().eq_ignore_ascii_case("native"))
        .unwrap_or(false)
}

fn native_registry() -> Result<NativeSessionRegistry, String> {
    NativeSessionRegistry::open_default()
}

fn resolve_project_path(session_name: &str) -> String {
    let workspace_root = current_workspace_root();
    TmuxSessionBackend::new().resolve_project_path(session_name, &workspace_root)
}

fn resolve_existing_project_path(project_name: &str) -> Result<String, String> {
    let project_name = project_name.trim();
    if project_name.is_empty() {
        return Err("project not found".to_string());
    }

    if native_backend_enabled() {
        return native_registry()?.get_project_cwd(project_name);
    }

    if !TmuxSessionBackend::new().session_exists(project_name) {
        return Err("project not found".to_string());
    }
    Ok(resolve_project_path(project_name))
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

fn resolve_codex_runtime_dir(window_id: &str) -> PathBuf {
    let safe_window_id = if window_id.trim().is_empty() {
        "window-unknown".to_string()
    } else {
        window_id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                    ch
                } else {
                    '-'
                }
            })
            .collect::<String>()
    };

    current_codex_runtime_dir().join(safe_window_id)
}

fn close_tmux_windows_for_codex_session(
    session_name: &str,
    session_id: &str,
    default_shell_cmd: &str,
) -> Result<Vec<tmux_backend::CodexResumeWindow>, String> {
    if session_name.is_empty() || session_id.is_empty() {
        return Ok(vec![]);
    }

    let backend = TmuxSessionBackend::new();
    let (windows, total_windows) = backend.list_codex_resume_windows_with_total(session_name);
    let matched_windows = windows
        .into_iter()
        .filter(|window| window.resume_session_id == session_id)
        .collect::<Vec<_>>();
    if matched_windows.is_empty() {
        return Ok(vec![]);
    }

    if total_windows <= matched_windows.len() {
        backend.run(&[
            "new-window".to_string(),
            "-t".to_string(),
            session_name.to_string(),
            "-n".to_string(),
            "shell".to_string(),
            default_shell_cmd.to_string(),
        ])?;
    }

    for window in &matched_windows {
        backend.run(&[
            "kill-window".to_string(),
            "-t".to_string(),
            window.window_id.clone(),
        ])?;
        let _ = fs::remove_dir_all(resolve_codex_runtime_dir(&window.window_id));
    }

    Ok(matched_windows)
}

fn close_native_channels_for_codex_session(
    project_name: &str,
    session_id: &str,
    default_shell_cmd: &str,
) -> Result<Vec<u32>, String> {
    if project_name.is_empty() || session_id.is_empty() {
        return Ok(vec![]);
    }

    let registry = native_registry()?;
    let matched_channels = registry.list_channels_by_metadata(
        project_name,
        CODEX_RESUME_SESSION_METADATA_KEY,
        session_id,
    )?;
    let channel_count = registry.list_channels(project_name)?.len();
    if channel_count <= matched_channels.len() && !default_shell_cmd.trim().is_empty() {
        let cwd = registry.get_project_cwd(project_name)?;
        registry.create_channel(project_name, &cwd, "shell", default_shell_cmd)?;
    }

    let mut closed_indexes = Vec::with_capacity(matched_channels.len());

    for channel in matched_channels {
        let processes = registry.running_processes_for_channel(project_name, channel.index)?;
        terminate_native_processes(&processes)?;
        registry.delete_channel(project_name, channel.index)?;
        cleanup_codex_runtime(&native_window_id(project_name, channel.index));
        closed_indexes.push(channel.index);
    }

    Ok(closed_indexes)
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
    if native_backend_enabled() {
        let closed_window_indexes = close_native_channels_for_codex_session(
            &project_name,
            &session_id,
            &params.default_shell_cmd,
        )?;
        return Ok(json!({
            "ok": true,
            "sessionId": session_id,
            "closedWindowIndexes": closed_window_indexes,
        }));
    }

    let closed_windows = close_tmux_windows_for_codex_session(
        &project_name,
        &session_id,
        &params.default_shell_cmd,
    )?;

    Ok(json!({
        "ok": true,
        "sessionId": session_id,
        "closedWindowIndexes": closed_windows.iter().map(|window| window.index).collect::<Vec<_>>(),
    }))
}

fn list_discoverable_sessions() -> Vec<tmux_backend::DiscoverableSession> {
    let tmux_session = current_tmux_session();
    let workspace_root = current_workspace_root();
    TmuxSessionBackend::new().list_discoverable_sessions(&tmux_session, &workspace_root)
}

fn list_tmux_sessions() -> Result<Value, String> {
    if native_backend_enabled() {
        let sessions = native_registry()?
            .list_projects()?
            .into_iter()
            .map(|project| {
                json!({
                    "name": project.name,
                    "windows": project.channel_count,
                    "attached": false,
                })
            })
            .collect::<Vec<_>>();
        return Ok(Value::Array(sessions));
    }

    let sessions = list_discoverable_sessions()
        .into_iter()
        .map(|session| {
            json!({
                "name": session.name,
                "windows": session.windows,
                "attached": session.attached,
            })
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(sessions))
}

fn list_all_session_names() -> Result<Value, String> {
    if native_backend_enabled() {
        let sessions = native_registry()?
            .list_projects()?
            .into_iter()
            .map(|project| Value::String(project.name))
            .collect::<Vec<_>>();
        return Ok(Value::Array(sessions));
    }

    let sessions = TmuxSessionBackend::new()
        .list_all_session_names()?
        .into_iter()
        .map(Value::String)
        .collect::<Vec<_>>();

    Ok(Value::Array(sessions))
}

fn list_projects() -> Result<Value, String> {
    if native_backend_enabled() {
        let projects = native_registry()?
            .list_projects()?
            .into_iter()
            .map(|project| {
                json!({
                    "name": project.name,
                    "path": project.cwd,
                    "active": false,
                    "channelCount": project.channel_count,
                })
            })
            .collect::<Vec<_>>();
        return Ok(Value::Array(projects));
    }

    let tmux_session = current_tmux_session();
    let workspace_root = current_workspace_root();
    let mut projects = list_discoverable_sessions()
        .into_iter()
        .map(|session| {
            json!({
                "name": session.name,
                "path": if session.path.is_empty() { workspace_root.clone() } else { session.path },
                "active": session.name == tmux_session,
                "channelCount": session.windows,
            })
        })
        .collect::<Vec<_>>();
    projects.reverse();
    Ok(Value::Array(projects))
}

fn get_session_cwd(params: GetSessionCwdParams) -> Result<Value, String> {
    let default_session = current_tmux_session();
    let session_name = params
        .session_name
        .unwrap_or(default_session)
        .trim()
        .to_string();
    let session_name = if session_name.is_empty() {
        current_tmux_session()
    } else {
        session_name
    };
    let workspace_root = current_workspace_root();

    if native_backend_enabled() {
        let cwd = native_registry()?.get_project_cwd(&session_name)?;
        let relative = if !workspace_root.is_empty() && cwd.starts_with(&workspace_root) {
            cwd[workspace_root.len()..]
                .trim_start_matches('/')
                .to_string()
        } else {
            String::new()
        };
        return Ok(json!({
            "cwd": cwd,
            "relative": relative,
        }));
    }

    let backend = TmuxSessionBackend::new();

    let mut cwd = workspace_root.clone();
    let env_cwd = backend.read_env_value(&session_name, "NEXUS_CWD");
    if !env_cwd.is_empty() {
        cwd = env_cwd;
    } else if let Ok(pane_path) = backend.capture(&[
        "display-message".to_string(),
        "-t".to_string(),
        session_name.clone(),
        "-p".to_string(),
        "#{pane_current_path}".to_string(),
    ]) && !pane_path.is_empty()
    {
        cwd = pane_path;
    }

    let relative = if !workspace_root.is_empty() && cwd.starts_with(&workspace_root) {
        cwd[workspace_root.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        String::new()
    };

    Ok(json!({
        "cwd": cwd,
        "relative": relative,
    }))
}

fn list_project_channels(params: ListProjectChannelsParams) -> Result<Value, String> {
    let project_name = params.project_name.trim().to_string();
    if native_backend_enabled() {
        let channels = native_registry()?
            .list_channels(&project_name)?
            .into_iter()
            .map(|channel| {
                json!({
                    "index": channel.index,
                    "name": channel.name,
                    "active": channel.active,
                    "cwd": channel.cwd,
                })
            })
            .collect::<Vec<_>>();
        return Ok(json!({
            "project": project_name,
            "channels": channels,
        }));
    }

    let stdout = TmuxSessionBackend::new().capture(&[
        "list-windows".to_string(),
        "-t".to_string(),
        project_name.clone(),
        "-F".to_string(),
        "#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}".to_string(),
    ])?;

    let mut channels = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.splitn(4, '|');
            let index = parts
                .next()
                .unwrap_or("0")
                .trim()
                .parse::<usize>()
                .unwrap_or(0);
            let name = parts.next().unwrap_or("").to_string();
            let active = parts.next().unwrap_or("").trim() == "1";
            let cwd = parts.next().unwrap_or("").to_string();
            json!({
                "index": index,
                "name": name,
                "active": active,
                "cwd": cwd,
            })
        })
        .collect::<Vec<_>>();
    channels.reverse();

    Ok(json!({
        "project": project_name,
        "channels": channels,
    }))
}

fn list_session_windows(params: ListSessionWindowsParams) -> Result<Value, String> {
    let default_session = current_tmux_session();
    let session_name = params
        .session_name
        .unwrap_or(default_session)
        .trim()
        .to_string();
    let session_name = if session_name.is_empty() {
        current_tmux_session()
    } else {
        session_name
    };

    if native_backend_enabled() {
        let windows = native_registry()?
            .list_channels(&session_name)?
            .into_iter()
            .rev()
            .map(|channel| {
                json!({
                    "index": channel.index,
                    "name": channel.name,
                    "active": channel.active,
                })
            })
            .collect::<Vec<_>>();
        return Ok(json!({
            "session": session_name,
            "windows": windows,
        }));
    }

    let stdout = TmuxSessionBackend::new().capture(&[
        "list-windows".to_string(),
        "-t".to_string(),
        session_name.clone(),
        "-F".to_string(),
        "#{window_index}|#{window_name}|#{window_active}".to_string(),
    ])?;

    let windows = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.splitn(3, '|');
            let index = parts
                .next()
                .unwrap_or("0")
                .trim()
                .parse::<usize>()
                .unwrap_or(0);
            let name = parts.next().unwrap_or("").to_string();
            let active = parts.next().unwrap_or("").trim() == "1";
            json!({
                "index": index,
                "name": name,
                "active": active,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "session": session_name,
        "windows": windows,
    }))
}

fn activate_project(params: ActivateProjectParams) -> Result<Value, String> {
    let project_name = params.project_name.trim().to_string();
    if native_backend_enabled() {
        let channels = native_registry()?.list_channels(&project_name)?;
        let last_channel = channels
            .iter()
            .find(|channel| channel.active)
            .map(|channel| channel.index);
        return Ok(json!({
            "active": true,
            "project": project_name,
            "lastChannel": last_channel,
        }));
    }

    let backend = TmuxSessionBackend::new();
    if project_name.is_empty() || !backend.session_exists(&project_name) {
        return Err("project not found".to_string());
    }

    let mut last_channel = backend
        .read_env_value(&project_name, "NEXUS_LAST_CHANNEL")
        .parse::<usize>()
        .ok();

    if let Some(candidate) = last_channel {
        match backend.capture(&[
            "list-windows".to_string(),
            "-t".to_string(),
            project_name.clone(),
            "-F".to_string(),
            "#I".to_string(),
        ]) {
            Ok(output) => {
                let windows = output
                    .lines()
                    .map(|line| line.trim().to_string())
                    .filter(|line| !line.is_empty())
                    .collect::<Vec<_>>();
                if !windows.contains(&candidate.to_string()) {
                    last_channel = None;
                }
            }
            Err(_) => {
                last_channel = None;
            }
        }
    }

    Ok(json!({
        "active": true,
        "project": project_name,
        "lastChannel": last_channel,
    }))
}

fn mark_session_owned_by_current_instance(session: &str) {
    let owner_session = current_tmux_session();
    TmuxSessionBackend::new().mark_session_owned_by_current_instance(session, &owner_session);
}

fn session_window_target(session: &str, index: &WindowIndex) -> String {
    format!("{}:{}", session, index.as_string())
}

fn native_window_index(index: &WindowIndex) -> Result<u32, String> {
    index
        .as_string()
        .parse::<u32>()
        .map_err(|_| "invalid native window index".to_string())
}

fn native_window_id(session_name: &str, channel_index: u32) -> String {
    format!("native:{}:{}", session_name, channel_index)
}

fn get_tmux_window_id(session: &str, index: &WindowIndex) -> String {
    TmuxSessionBackend::new().window_id(&session_window_target(session, index))
}

fn cleanup_codex_runtime(window_id: &str) {
    if window_id.trim().is_empty() {
        return;
    }
    let _ = fs::remove_dir_all(resolve_codex_runtime_dir(window_id));
}

fn native_pid_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let filter = format!("PID eq {pid}");
        return Command::new("tasklist")
            .args(["/FI", &filter])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
            .unwrap_or(false);
    }

    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn terminate_native_process(process: &NativeProcessInstance) -> Result<(), String> {
    let Some(pid) = process.os_pid else {
        return Ok(());
    };

    let status = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
    } else {
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
    }
    .map_err(|error| error.to_string())?;

    if status.success() || !native_pid_alive(pid) {
        Ok(())
    } else {
        Err(format!(
            "failed to terminate native process pid {} for {}:{}",
            pid, process.project_name, process.channel_index
        ))
    }
}

fn terminate_native_processes(processes: &[NativeProcessInstance]) -> Result<(), String> {
    let errors = processes
        .iter()
        .filter_map(|process| terminate_native_process(process).err())
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "native process cleanup failed: {}",
            errors.join("; ")
        ))
    }
}

fn create_project(state: &SharedState, params: CreateProjectParams) -> Result<Value, String> {
    if native_backend_enabled() {
        native_registry()?.create_project_with_launch_plan(
            &params.session_name,
            &params.cwd,
            &params.initial_window_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        state.projects_created.fetch_add(1, Ordering::SeqCst);
        state.windows_created.fetch_add(1, Ordering::SeqCst);
        return Ok(serde_json::json!({ "ok": true }));
    }

    let backend = TmuxSessionBackend::new();
    backend.run(&[
        "new-session".to_string(),
        "-d".to_string(),
        "-s".to_string(),
        params.session_name.clone(),
        "-n".to_string(),
        params.initial_window_name,
        "-c".to_string(),
        params.cwd.clone(),
        params.shell_cmd,
    ])?;
    backend.set_env(&params.session_name, "NEXUS_CWD", &params.cwd)?;
    backend.apply_proxy_vars(&params.session_name, params.proxy_vars)?;
    mark_session_owned_by_current_instance(&params.session_name);

    state.projects_created.fetch_add(1, Ordering::SeqCst);
    state.windows_created.fetch_add(1, Ordering::SeqCst);
    Ok(serde_json::json!({ "ok": true }))
}

fn create_project_channel(
    state: &SharedState,
    params: CreateProjectChannelParams,
) -> Result<Value, String> {
    if native_backend_enabled() {
        native_registry()?.create_channel_with_launch_plan(
            &params.session_name,
            &params.cwd,
            &params.channel_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        state.windows_created.fetch_add(1, Ordering::SeqCst);
        return Ok(serde_json::json!({ "ok": true }));
    }

    let backend = TmuxSessionBackend::new();
    backend.ensure_session(&params.session_name, &params.default_shell_cmd)?;
    backend.apply_proxy_vars(&params.session_name, params.proxy_vars)?;
    backend.run(&[
        "new-window".to_string(),
        "-t".to_string(),
        params.session_name.clone(),
        "-c".to_string(),
        params.cwd,
        "-n".to_string(),
        params.channel_name,
        params.shell_cmd,
    ])?;
    mark_session_owned_by_current_instance(&params.session_name);

    state.windows_created.fetch_add(1, Ordering::SeqCst);
    Ok(serde_json::json!({ "ok": true }))
}

fn create_resume_window(
    state: &SharedState,
    params: CreateResumeWindowParams,
) -> Result<Value, String> {
    if native_backend_enabled() {
        let index = native_registry()?.create_channel_with_launch_plan(
            &params.session_name,
            &params.cwd,
            &params.window_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        state.windows_created.fetch_add(1, Ordering::SeqCst);
        return Ok(serde_json::json!({
            "windowId": native_window_id(&params.session_name, index),
            "index": index,
            "name": params.window_name,
        }));
    }

    let backend = TmuxSessionBackend::new();
    backend.ensure_session(&params.session_name, &params.default_shell_cmd)?;
    backend.apply_proxy_vars(&params.session_name, params.proxy_vars)?;
    let output = backend.capture(&[
        "new-window".to_string(),
        "-P".to_string(),
        "-F".to_string(),
        "#{window_id}|#{window_index}|#{window_name}".to_string(),
        "-t".to_string(),
        params.session_name,
        "-c".to_string(),
        params.cwd,
        "-n".to_string(),
        params.window_name.clone(),
        params.shell_cmd,
    ])?;

    let mut parts = output.split('|');
    let window_id = parts.next().unwrap_or_default().to_string();
    let index = parts
        .next()
        .unwrap_or_default()
        .parse::<usize>()
        .unwrap_or_default();

    state.windows_created.fetch_add(1, Ordering::SeqCst);
    Ok(serde_json::json!({
        "windowId": window_id,
        "index": index,
        "name": params.window_name,
    }))
}

fn resume_codex_session(
    state: &SharedState,
    params: ResumeCodexSessionParams,
) -> Result<Value, String> {
    if native_backend_enabled() {
        let registry = native_registry()?;
        let project_name = if !params.project_name.trim().is_empty() {
            params.project_name.trim().to_string()
        } else {
            params.session_name.trim().to_string()
        };
        if project_name.is_empty() {
            return Err("project not found".to_string());
        }

        let index = registry.create_channel_with_launch_plan(
            &project_name,
            &params.cwd,
            &params.window_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        registry.set_channel_metadata(
            &project_name,
            index,
            CODEX_RESUME_SESSION_METADATA_KEY,
            &params.session_id,
        )?;
        registry.activate_channel(&project_name, index)?;

        state.windows_created.fetch_add(1, Ordering::SeqCst);
        return Ok(json!({
            "ok": true,
            "project": project_name,
            "channelIndex": index,
            "channelName": params.window_name,
            "sessionId": params.session_id,
        }));
    }

    let backend = TmuxSessionBackend::new();
    let project_name = if !params.project_name.trim().is_empty() {
        params.project_name.trim().to_string()
    } else {
        params.session_name.trim().to_string()
    };
    if project_name.is_empty() || !backend.session_exists(&project_name) {
        return Err("project not found".to_string());
    }

    backend.apply_proxy_vars(&project_name, params.proxy_vars)?;
    let output = backend.capture(&[
        "new-window".to_string(),
        "-P".to_string(),
        "-F".to_string(),
        "#{window_id}|#{window_index}|#{window_name}".to_string(),
        "-t".to_string(),
        project_name.clone(),
        "-c".to_string(),
        params.cwd,
        "-n".to_string(),
        params.window_name.clone(),
        params.shell_cmd,
    ])?;

    let mut parts = output.split('|');
    let window_id = parts.next().unwrap_or_default().to_string();
    let index = parts
        .next()
        .unwrap_or_default()
        .parse::<usize>()
        .unwrap_or_default();
    let window_target = if window_id.is_empty() {
        format!("{}:{}", project_name, index)
    } else {
        window_id.clone()
    };

    backend.mark_window_as_codex_resume_session(&window_target, &params.session_id)?;
    let _ = backend.run(&[
        "select-window".to_string(),
        "-t".to_string(),
        format!("{}:{}", project_name, index),
    ]);
    let _ = backend.set_env(&project_name, "NEXUS_LAST_CHANNEL", &index.to_string());

    state.windows_created.fetch_add(1, Ordering::SeqCst);
    Ok(json!({
        "ok": true,
        "project": project_name,
        "channelIndex": index,
        "channelName": params.window_name,
        "sessionId": params.session_id,
    }))
}

fn rename_project(params: RenameProjectParams) -> Result<Value, String> {
    if native_backend_enabled() {
        native_registry()?.rename_project(&params.old_name, &params.new_name)?;
        return Ok(serde_json::json!({
            "ok": true,
            "oldName": params.old_name,
            "newName": params.new_name,
        }));
    }

    TmuxSessionBackend::new().run(&[
        "rename-session".to_string(),
        "-t".to_string(),
        params.old_name.clone(),
        params.new_name.clone(),
    ])?;
    mark_session_owned_by_current_instance(&params.new_name);

    Ok(serde_json::json!({
        "ok": true,
        "oldName": params.old_name,
        "newName": params.new_name,
    }))
}

fn delete_project(params: DeleteProjectParams) -> Result<Value, String> {
    if native_backend_enabled() {
        let registry = native_registry()?;
        let channels = registry.list_channels(&params.session_name)?;
        let processes = registry.running_processes_for_project(&params.session_name)?;
        terminate_native_processes(&processes)?;
        registry.delete_project(&params.session_name)?;
        for channel in channels {
            cleanup_codex_runtime(&native_window_id(&params.session_name, channel.index));
        }
        return Ok(serde_json::json!({ "ok": true }));
    }

    let backend = TmuxSessionBackend::new();
    let window_ids = backend.list_window_ids(&params.session_name);
    backend.run(&[
        "kill-session".to_string(),
        "-t".to_string(),
        params.session_name,
    ])?;

    for window_id in window_ids {
        cleanup_codex_runtime(&window_id);
    }

    Ok(serde_json::json!({ "ok": true }))
}

fn attach_session_window(params: AttachSessionWindowParams) -> Result<Value, String> {
    if native_backend_enabled() {
        let index = native_window_index(&params.index)?;
        native_registry()?.activate_channel(&params.session_name, index)?;
        return Ok(serde_json::json!({ "ok": true }));
    }

    let backend = TmuxSessionBackend::new();
    let index = params.index.as_string();
    let target = session_window_target(&params.session_name, &params.index);
    backend.run(&["select-window".to_string(), "-t".to_string(), target])?;
    backend.set_env(&params.session_name, "NEXUS_LAST_CHANNEL", &index)?;

    Ok(serde_json::json!({ "ok": true }))
}

fn rename_session_window(params: RenameSessionWindowParams) -> Result<Value, String> {
    if native_backend_enabled() {
        let index = native_window_index(&params.index)?;
        native_registry()?.rename_channel(&params.session_name, index, &params.name)?;
        return Ok(serde_json::json!({
            "ok": true,
            "name": params.name,
        }));
    }

    let target = session_window_target(&params.session_name, &params.index);
    TmuxSessionBackend::new().run(&[
        "rename-window".to_string(),
        "-t".to_string(),
        target,
        params.name.clone(),
    ])?;

    Ok(serde_json::json!({
        "ok": true,
        "name": params.name,
    }))
}

fn delete_session_window(params: DeleteSessionWindowParams) -> Result<Value, String> {
    if native_backend_enabled() {
        let index = native_window_index(&params.index)?;
        let registry = native_registry()?;
        let channel_count = registry.list_channels(&params.session_name)?.len();
        let should_create_fallback = params.create_fallback_shell || channel_count <= 1;
        if should_create_fallback && !params.default_shell_cmd.trim().is_empty() {
            let cwd = registry.get_project_cwd(&params.session_name)?;
            registry.create_channel(
                &params.session_name,
                &cwd,
                "shell",
                &params.default_shell_cmd,
            )?;
        }
        let processes = registry.running_processes_for_channel(&params.session_name, index)?;
        terminate_native_processes(&processes)?;
        registry.delete_channel(&params.session_name, index)?;
        cleanup_codex_runtime(&native_window_id(&params.session_name, index));
        return Ok(serde_json::json!({ "ok": true }));
    }

    let backend = TmuxSessionBackend::new();
    let window_id = get_tmux_window_id(&params.session_name, &params.index);
    let create_fallback_shell =
        params.create_fallback_shell || backend.count_windows(&params.session_name)? <= 1;

    if create_fallback_shell && !params.default_shell_cmd.trim().is_empty() {
        backend.run(&[
            "new-window".to_string(),
            "-t".to_string(),
            params.session_name.clone(),
            "-n".to_string(),
            "shell".to_string(),
            params.default_shell_cmd.clone(),
        ])?;
    }

    let target = session_window_target(&params.session_name, &params.index);
    backend.run(&["kill-window".to_string(), "-t".to_string(), target])?;
    cleanup_codex_runtime(&window_id);

    Ok(serde_json::json!({ "ok": true }))
}

fn main() {
    let (tx, rx) = mpsc::channel::<String>();
    let state = SharedState {
        event_tx: tx.clone(),
        projects_created: Arc::new(AtomicUsize::new(0)),
        windows_created: Arc::new(AtomicUsize::new(0)),
    };

    let writer = thread::spawn(move || {
        let stdout = io::stdout();
        let mut handle = stdout.lock();
        while let Ok(line) = rx.recv() {
            if handle.write_all(line.as_bytes()).is_err() {
                break;
            }
            if handle.write_all(b"\n").is_err() {
                break;
            }
            if handle.flush().is_err() {
                break;
            }
        }
    });

    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let message: Message = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("invalid request: {error}");
                continue;
            }
        };

        #[allow(clippy::single_match)]
        match message.kind.as_str() {
            "request" => {
                let id = message.id.unwrap_or_default();
                let method = message.method.unwrap_or_default();
                match method.as_str() {
                    "ready" | "runtimeStatus" => {
                        send_response(&state, id, true, Some(state.runtime_status()), None);
                    }
                    "listTmuxSessions" => match list_tmux_sessions() {
                        Ok(result) => send_response(&state, id, true, Some(result), None),
                        Err(error) => send_response::<Value>(&state, id, false, None, Some(error)),
                    },
                    "listAllSessionNames" => match list_all_session_names() {
                        Ok(result) => send_response(&state, id, true, Some(result), None),
                        Err(error) => send_response::<Value>(&state, id, false, None, Some(error)),
                    },
                    "listProjects" => match list_projects() {
                        Ok(result) => send_response(&state, id, true, Some(result), None),
                        Err(error) => send_response::<Value>(&state, id, false, None, Some(error)),
                    },
                    "getSessionCwd" => {
                        match serde_json::from_value::<GetSessionCwdParams>(message.params) {
                            Ok(params) => match get_session_cwd(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "listProjectChannels" => {
                        match serde_json::from_value::<ListProjectChannelsParams>(message.params) {
                            Ok(params) => match list_project_channels(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "listSessionWindows" => {
                        match serde_json::from_value::<ListSessionWindowsParams>(message.params) {
                            Ok(params) => match list_session_windows(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "activateProject" => {
                        match serde_json::from_value::<ActivateProjectParams>(message.params) {
                            Ok(params) => match activate_project(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "listCodexSessions" => {
                        match serde_json::from_value::<ListCodexSessionsParams>(message.params) {
                            Ok(params) => match list_project_codex_sessions(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "getCodexSessionDetail" => {
                        match serde_json::from_value::<GetCodexSessionDetailParams>(message.params)
                        {
                            Ok(params) => match get_project_codex_session_detail(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "resumeCodexSession" => {
                        match serde_json::from_value::<ResumeCodexSessionParams>(message.params) {
                            Ok(params) => match resume_codex_session(&state, params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "deleteProjectCodexSession" => {
                        match serde_json::from_value::<DeleteProjectCodexSessionParams>(
                            message.params,
                        ) {
                            Ok(params) => match delete_project_codex_session(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "createProject" => {
                        match serde_json::from_value::<CreateProjectParams>(message.params) {
                            Ok(params) => match create_project(&state, params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "createProjectChannel" => {
                        match serde_json::from_value::<CreateProjectChannelParams>(message.params) {
                            Ok(params) => match create_project_channel(&state, params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "createResumeWindow" => {
                        match serde_json::from_value::<CreateResumeWindowParams>(message.params) {
                            Ok(params) => match create_resume_window(&state, params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "renameProject" => {
                        match serde_json::from_value::<RenameProjectParams>(message.params) {
                            Ok(params) => match rename_project(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "deleteProject" => {
                        match serde_json::from_value::<DeleteProjectParams>(message.params) {
                            Ok(params) => match delete_project(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "attachSessionWindow" => {
                        match serde_json::from_value::<AttachSessionWindowParams>(message.params) {
                            Ok(params) => match attach_session_window(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "renameSessionWindow" => {
                        match serde_json::from_value::<RenameSessionWindowParams>(message.params) {
                            Ok(params) => match rename_session_window(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "deleteSessionWindow" => {
                        match serde_json::from_value::<DeleteSessionWindowParams>(message.params) {
                            Ok(params) => match delete_session_window(params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "shutdown" => {
                        send_response(
                            &state,
                            id,
                            true,
                            Some(serde_json::json!({ "ok": true })),
                            None,
                        );
                        break;
                    }
                    _ => {
                        send_response::<Value>(
                            &state,
                            id,
                            false,
                            None,
                            Some(format!("unsupported method: {method}")),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    drop(state);
    drop(tx);
    let _ = writer.join();
}
