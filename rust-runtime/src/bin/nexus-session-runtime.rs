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

struct DiscoverableSession {
    name: String,
    windows: usize,
    attached: bool,
    path: String,
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

struct TmuxCodexResumeWindow {
    window_id: String,
    index: usize,
    resume_session_id: String,
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

fn tmux_session_exists(session: &str) -> bool {
    Command::new("tmux")
        .args(["has-session", "-t", session])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn run_tmux(args: &[String]) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        Err(stderr)
    } else {
        Err(format!("tmux command failed: {}", args.join(" ")))
    }
}

fn run_tmux_capture(args: &[String]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        Err(stderr)
    } else {
        Err(format!("tmux command failed: {}", args.join(" ")))
    }
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

fn read_tmux_env_value(session: &str, key: &str) -> String {
    match run_tmux_capture(&[
        "show-environment".to_string(),
        "-t".to_string(),
        session.to_string(),
        key.to_string(),
    ]) {
        Ok(output) => output
            .strip_prefix(&format!("{}=", key))
            .unwrap_or("")
            .trim()
            .to_string(),
        Err(_) => String::new(),
    }
}

fn read_session_discovery_path(session: &str, windows_count: usize) -> String {
    let session_path = read_tmux_env_value(session, "NEXUS_CWD");
    if !session_path.is_empty() {
        return session_path;
    }
    if windows_count == 0 {
        return String::new();
    }
    match run_tmux_capture(&[
        "list-windows".to_string(),
        "-t".to_string(),
        session.to_string(),
        "-F".to_string(),
        "#{pane_current_path}".to_string(),
    ]) {
        Ok(output) => output.lines().next().unwrap_or("").trim().to_string(),
        Err(_) => String::new(),
    }
}

fn resolve_project_path(session_name: &str) -> String {
    let workspace_root = current_workspace_root();
    let env_cwd = read_tmux_env_value(session_name, "NEXUS_CWD");
    if !env_cwd.is_empty() {
        return env_cwd;
    }

    if let Ok(pane_path) = run_tmux_capture(&[
        "display-message".to_string(),
        "-t".to_string(),
        session_name.to_string(),
        "-p".to_string(),
        "#{pane_current_path}".to_string(),
    ]) && !pane_path.is_empty()
    {
        return pane_path;
    }

    workspace_root
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
    if project_name.is_empty() || !tmux_session_exists(&project_name) {
        return Err("project not found".to_string());
    }

    let codex_home = current_codex_home();
    let project_path = resolve_project_path(&project_name);
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
    if project_name.is_empty() || !tmux_session_exists(&project_name) {
        return Err("project not found".to_string());
    }
    if session_id.is_empty() {
        return Err("session id required".to_string());
    }

    let codex_home = current_codex_home();
    let project_path = resolve_project_path(&project_name);
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

fn parse_tmux_codex_resume_windows(output: &str) -> Vec<TmuxCodexResumeWindow> {
    output
        .lines()
        .filter_map(|raw_line| {
            let line = raw_line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(3, '|');
            let window_id = parts.next().unwrap_or("").to_string();
            let index = parts.next().unwrap_or("").parse::<usize>().ok()?;
            let resume_session_id = parts.next().unwrap_or("").to_string();
            if window_id.is_empty() {
                return None;
            }
            Some(TmuxCodexResumeWindow {
                window_id,
                index,
                resume_session_id,
            })
        })
        .collect()
}

fn mark_tmux_window_as_codex_resume_session(
    window_target: &str,
    session_id: &str,
) -> Result<(), String> {
    if window_target.is_empty() || session_id.is_empty() {
        return Ok(());
    }

    run_tmux(&[
        "set-option".to_string(),
        "-w".to_string(),
        "-t".to_string(),
        window_target.to_string(),
        "@nexus_codex_resume_session_id".to_string(),
        session_id.to_string(),
    ])
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
) -> Result<Vec<TmuxCodexResumeWindow>, String> {
    if session_name.is_empty() || session_id.is_empty() {
        return Ok(vec![]);
    }

    let output = run_tmux_capture(&[
        "list-windows".to_string(),
        "-t".to_string(),
        session_name.to_string(),
        "-F".to_string(),
        "#{window_id}|#{window_index}|#{@nexus_codex_resume_session_id}".to_string(),
    ])
    .unwrap_or_default();
    let windows = parse_tmux_codex_resume_windows(&output);
    let matched_windows = windows
        .into_iter()
        .filter(|window| window.resume_session_id == session_id)
        .collect::<Vec<_>>();
    if matched_windows.is_empty() {
        return Ok(vec![]);
    }

    if output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count()
        <= matched_windows.len()
    {
        run_tmux(&[
            "new-window".to_string(),
            "-t".to_string(),
            session_name.to_string(),
            "-n".to_string(),
            "shell".to_string(),
            default_shell_cmd.to_string(),
        ])?;
    }

    for window in &matched_windows {
        run_tmux(&[
            "kill-window".to_string(),
            "-t".to_string(),
            window.window_id.clone(),
        ])?;
        let _ = fs::remove_dir_all(resolve_codex_runtime_dir(&window.window_id));
    }

    Ok(matched_windows)
}

fn delete_project_codex_session(params: DeleteProjectCodexSessionParams) -> Result<Value, String> {
    let project_name = params.project_name.trim().to_string();
    let session_id = params.session_id.trim().to_string();
    if project_name.is_empty() || !tmux_session_exists(&project_name) {
        return Err("project not found".to_string());
    }
    if session_id.is_empty() {
        return Err("session id required".to_string());
    }

    let codex_home = current_codex_home();
    let project_path = resolve_project_path(&project_name);
    let result = collect_project_codex_sessions(&project_name, &project_path, &codex_home);
    if !result.items.iter().any(|item| item.id == session_id) {
        return Err("codex session not found in project".to_string());
    }

    delete_codex_session_file(&session_id, &codex_home)?;
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

fn list_discoverable_sessions() -> Vec<DiscoverableSession> {
    let tmux_session = current_tmux_session();
    let workspace_root = current_workspace_root();

    match run_tmux_capture(&[
        "list-sessions".to_string(),
        "-F".to_string(),
        "#{session_name}|#{session_windows}|#{session_attached}".to_string(),
    ]) {
        Ok(stdout) => stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| {
                let mut parts = line.splitn(3, '|');
                let name = parts.next().unwrap_or("").trim().to_string();
                if name.is_empty() {
                    return None;
                }
                let windows = parts
                    .next()
                    .unwrap_or("0")
                    .trim()
                    .parse::<usize>()
                    .unwrap_or(0);
                let attached = parts
                    .next()
                    .unwrap_or("0")
                    .trim()
                    .parse::<usize>()
                    .unwrap_or(0)
                    > 0;
                let path = read_session_discovery_path(&name, windows);
                Some(DiscoverableSession {
                    name,
                    windows,
                    attached,
                    path,
                })
            })
            .collect(),
        Err(_) => vec![DiscoverableSession {
            name: tmux_session,
            windows: 0,
            attached: false,
            path: workspace_root,
        }],
    }
}

fn list_tmux_sessions() -> Result<Value, String> {
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
    let sessions = run_tmux_capture(&[
        "list-sessions".to_string(),
        "-F".to_string(),
        "#{session_name}".to_string(),
    ])?
    .lines()
    .map(|line| line.trim().to_string())
    .filter(|line| !line.is_empty())
    .map(Value::String)
    .collect::<Vec<_>>();

    Ok(Value::Array(sessions))
}

fn list_projects() -> Result<Value, String> {
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

    let mut cwd = workspace_root.clone();
    let env_cwd = read_tmux_env_value(&session_name, "NEXUS_CWD");
    if !env_cwd.is_empty() {
        cwd = env_cwd;
    } else if let Ok(pane_path) = run_tmux_capture(&[
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
    let stdout = run_tmux_capture(&[
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

    let stdout = run_tmux_capture(&[
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
    if project_name.is_empty() || !tmux_session_exists(&project_name) {
        return Err("project not found".to_string());
    }

    let mut last_channel = read_tmux_env_value(&project_name, "NEXUS_LAST_CHANNEL")
        .parse::<usize>()
        .ok();

    if let Some(candidate) = last_channel {
        match run_tmux_capture(&[
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

fn ensure_tmux_session(session: &str, default_shell_cmd: &str) -> Result<(), String> {
    if tmux_session_exists(session) {
        return Ok(());
    }

    run_tmux(&[
        "new-session".to_string(),
        "-d".to_string(),
        "-s".to_string(),
        session.to_string(),
        "-n".to_string(),
        "shell".to_string(),
        default_shell_cmd.to_string(),
    ])
}

fn set_tmux_env(session: &str, key: &str, value: &str) -> Result<(), String> {
    run_tmux(&[
        "set-environment".to_string(),
        "-t".to_string(),
        session.to_string(),
        key.to_string(),
        value.to_string(),
    ])
}

fn mark_session_owned_by_current_instance(session: &str) {
    let owner_session = current_tmux_session();
    if owner_session.trim().is_empty() {
        return;
    }
    let _ = set_tmux_env(session, "NEXUS_OWNER_SESSION", &owner_session);
}

fn apply_proxy_vars(session: &str, proxy_vars: HashMap<String, String>) -> Result<(), String> {
    for (key, value) in proxy_vars {
        set_tmux_env(session, &key, &value)?;
    }
    Ok(())
}

fn session_window_target(session: &str, index: &WindowIndex) -> String {
    format!("{}:{}", session, index.as_string())
}

fn get_tmux_window_id(session: &str, index: &WindowIndex) -> String {
    run_tmux_capture(&[
        "display-message".to_string(),
        "-t".to_string(),
        session_window_target(session, index),
        "-p".to_string(),
        "#{window_id}".to_string(),
    ])
    .unwrap_or_default()
}

fn list_tmux_window_ids(session: &str) -> Vec<String> {
    run_tmux_capture(&[
        "list-windows".to_string(),
        "-t".to_string(),
        session.to_string(),
        "-F".to_string(),
        "#{window_id}".to_string(),
    ])
    .map(|output| {
        output
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
    })
    .unwrap_or_default()
}

fn count_tmux_windows(session: &str) -> Result<usize, String> {
    run_tmux_capture(&[
        "list-windows".to_string(),
        "-t".to_string(),
        session.to_string(),
        "-F".to_string(),
        "#{window_index}".to_string(),
    ])
    .map(|output| {
        output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    })
}

fn cleanup_codex_runtime(window_id: &str) {
    if window_id.trim().is_empty() {
        return;
    }
    let _ = fs::remove_dir_all(resolve_codex_runtime_dir(window_id));
}

fn create_project(state: &SharedState, params: CreateProjectParams) -> Result<Value, String> {
    run_tmux(&[
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
    set_tmux_env(&params.session_name, "NEXUS_CWD", &params.cwd)?;
    apply_proxy_vars(&params.session_name, params.proxy_vars)?;
    mark_session_owned_by_current_instance(&params.session_name);

    state.projects_created.fetch_add(1, Ordering::SeqCst);
    state.windows_created.fetch_add(1, Ordering::SeqCst);
    Ok(serde_json::json!({ "ok": true }))
}

fn create_project_channel(
    state: &SharedState,
    params: CreateProjectChannelParams,
) -> Result<Value, String> {
    ensure_tmux_session(&params.session_name, &params.default_shell_cmd)?;
    apply_proxy_vars(&params.session_name, params.proxy_vars)?;
    run_tmux(&[
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
    ensure_tmux_session(&params.session_name, &params.default_shell_cmd)?;
    apply_proxy_vars(&params.session_name, params.proxy_vars)?;
    let output = run_tmux_capture(&[
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
    let project_name = if !params.project_name.trim().is_empty() {
        params.project_name.trim().to_string()
    } else {
        params.session_name.trim().to_string()
    };
    if project_name.is_empty() || !tmux_session_exists(&project_name) {
        return Err("project not found".to_string());
    }

    apply_proxy_vars(&project_name, params.proxy_vars)?;
    let output = run_tmux_capture(&[
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

    mark_tmux_window_as_codex_resume_session(&window_target, &params.session_id)?;
    let _ = run_tmux(&[
        "select-window".to_string(),
        "-t".to_string(),
        format!("{}:{}", project_name, index),
    ]);
    let _ = set_tmux_env(&project_name, "NEXUS_LAST_CHANNEL", &index.to_string());

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
    run_tmux(&[
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
    let window_ids = list_tmux_window_ids(&params.session_name);
    run_tmux(&[
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
    let index = params.index.as_string();
    let target = session_window_target(&params.session_name, &params.index);
    run_tmux(&["select-window".to_string(), "-t".to_string(), target])?;
    set_tmux_env(&params.session_name, "NEXUS_LAST_CHANNEL", &index)?;

    Ok(serde_json::json!({ "ok": true }))
}

fn rename_session_window(params: RenameSessionWindowParams) -> Result<Value, String> {
    let target = session_window_target(&params.session_name, &params.index);
    run_tmux(&[
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
    let window_id = get_tmux_window_id(&params.session_name, &params.index);
    let create_fallback_shell =
        params.create_fallback_shell || count_tmux_windows(&params.session_name)? <= 1;

    if create_fallback_shell && !params.default_shell_cmd.trim().is_empty() {
        run_tmux(&[
            "new-window".to_string(),
            "-t".to_string(),
            params.session_name.clone(),
            "-n".to_string(),
            "shell".to_string(),
            params.default_shell_cmd.clone(),
        ])?;
    }

    let target = session_window_target(&params.session_name, &params.index);
    run_tmux(&["kill-window".to_string(), "-t".to_string(), target])?;
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
