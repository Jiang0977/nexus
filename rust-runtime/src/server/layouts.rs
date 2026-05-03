use super::*;
use std::collections::HashSet;

const WORKSPACE_LAYOUT_VERSION: u32 = 1;
const MAX_WORKSPACE_LAYOUT_PANES: usize = 9;
const DEFAULT_PANE_ID: &str = "pane-1";
const DEFAULT_LAYOUT_MODE: &str = "single";
const VALID_LAYOUT_MODES: [&str; 5] = ["single", "vertical", "horizontal", "grid-2x2", "grid-3x3"];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspacePaneTarget {
    pub(super) session: String,
    pub(super) window_index: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspacePaneState {
    pub(super) id: String,
    pub(super) target: Option<WorkspacePaneTarget>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceLayout {
    pub(super) version: u32,
    pub(super) mode: String,
    pub(super) focused_pane_id: String,
    pub(super) panes: Vec<WorkspacePaneState>,
    pub(super) updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceLayoutsFile {
    version: u32,
    active_layout: WorkspaceLayout,
}

pub(super) async fn api_get_active_workspace_layout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(read_active_workspace_layout(state.workspace_layouts_file.as_ref()).await).into_response()
}

pub(super) async fn api_put_active_workspace_layout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<WorkspaceLayout>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let layout = match validate_workspace_layout(payload) {
        Ok(layout) => layout,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, &error),
    };

    match write_active_workspace_layout(state.workspace_layouts_file.as_ref(), &layout).await {
        Ok(()) => Json(layout).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) fn default_workspace_layout() -> WorkspaceLayout {
    WorkspaceLayout {
        version: WORKSPACE_LAYOUT_VERSION,
        mode: DEFAULT_LAYOUT_MODE.to_string(),
        focused_pane_id: DEFAULT_PANE_ID.to_string(),
        panes: vec![WorkspacePaneState {
            id: DEFAULT_PANE_ID.to_string(),
            target: None,
        }],
        updated_at: iso_timestamp_now(),
    }
}

pub(super) async fn read_active_workspace_layout(file_path: &Path) -> WorkspaceLayout {
    let raw = match fs::read_to_string(file_path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return default_workspace_layout();
        }
        Err(error) => {
            eprintln!(
                "workspace layout warning: failed to read {}: {error}",
                file_path.display()
            );
            return default_workspace_layout();
        }
    };

    let stored = match serde_json::from_str::<WorkspaceLayoutsFile>(&raw) {
        Ok(stored) => stored,
        Err(error) => {
            eprintln!(
                "workspace layout warning: failed to parse {}: {error}",
                file_path.display()
            );
            return default_workspace_layout();
        }
    };

    match validate_workspace_layout(stored.active_layout) {
        Ok(layout) => layout,
        Err(error) => {
            eprintln!(
                "workspace layout warning: invalid stored layout in {}: {error}",
                file_path.display()
            );
            default_workspace_layout()
        }
    }
}

pub(super) async fn write_active_workspace_layout(
    file_path: &Path,
    layout: &WorkspaceLayout,
) -> Result<(), String> {
    let layout = validate_workspace_layout(layout.clone())?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }

    let stored = WorkspaceLayoutsFile {
        version: WORKSPACE_LAYOUT_VERSION,
        active_layout: layout,
    };
    let mut content = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    content.push('\n');

    let tmp_path = workspace_layout_tmp_path(file_path);
    let write_result = async {
        let mut tmp_file = fs::File::create(&tmp_path)
            .await
            .map_err(|error| error.to_string())?;
        tmp_file
            .write_all(content.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        tmp_file.flush().await.map_err(|error| error.to_string())?;
        drop(tmp_file);
        fs::rename(&tmp_path, file_path)
            .await
            .map_err(|error| error.to_string())
    }
    .await;

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path).await;
    }

    write_result
}

pub(super) fn validate_workspace_layout(
    mut layout: WorkspaceLayout,
) -> Result<WorkspaceLayout, String> {
    if layout.version != WORKSPACE_LAYOUT_VERSION {
        return Err("invalid layout version".to_string());
    }

    layout.mode = layout.mode.trim().to_string();
    if !VALID_LAYOUT_MODES.contains(&layout.mode.as_str()) {
        return Err("invalid layout mode".to_string());
    }

    if layout.panes.len() > MAX_WORKSPACE_LAYOUT_PANES {
        return Err("too many panes".to_string());
    }

    let mut ids = HashSet::new();
    for pane in &mut layout.panes {
        pane.id = pane.id.trim().to_string();
        if pane.id.is_empty() {
            return Err("pane id required".to_string());
        }
        if !ids.insert(pane.id.clone()) {
            return Err("pane ids must be unique".to_string());
        }

        if let Some(target) = &mut pane.target {
            target.session = target.session.trim().to_string();
            if target.session.is_empty() {
                return Err("target session required".to_string());
            }
            if target.window_index < 0 {
                return Err("target windowIndex must be non-negative".to_string());
            }
        }
    }

    layout.focused_pane_id = layout.focused_pane_id.trim().to_string();
    if layout.focused_pane_id.is_empty() {
        layout.focused_pane_id = layout
            .panes
            .first()
            .map(|pane| pane.id.clone())
            .unwrap_or_else(|| DEFAULT_PANE_ID.to_string());
    }

    if layout.updated_at.trim().is_empty() {
        layout.updated_at = iso_timestamp_now();
    }

    Ok(layout)
}

fn workspace_layout_tmp_path(file_path: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace-layouts.json");
    file_path.with_file_name(format!(
        "{file_name}.{}.tmp",
        std::process::id() ^ stamp as u32
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use tempfile::tempdir;

    fn layout_fixture() -> WorkspaceLayout {
        WorkspaceLayout {
            version: 1,
            mode: "grid-2x2".to_string(),
            focused_pane_id: "pane-1".to_string(),
            panes: vec![
                WorkspacePaneState {
                    id: "pane-1".to_string(),
                    target: Some(WorkspacePaneTarget {
                        session: "nexus".to_string(),
                        window_index: 0,
                    }),
                },
                WorkspacePaneState {
                    id: "pane-2".to_string(),
                    target: None,
                },
            ],
            updated_at: "2026-05-04T00:00:00Z".to_string(),
        }
    }

    fn invalid_layout(mut mutate: impl FnMut(&mut WorkspaceLayout)) -> WorkspaceLayout {
        let mut layout = layout_fixture();
        mutate(&mut layout);
        layout
    }

    fn unconfigured_runtime(display_name: &'static str) -> Arc<ManagedRuntime> {
        Arc::new(ManagedRuntime {
            display_name,
            inner: Mutex::new(ManagedRuntimeState {
                ready_timeout: Duration::from_millis(1),
                process: None,
                status: json!({ "ready": false, "source": "test" }),
            }),
        })
    }

    async fn test_state(layout_file: PathBuf) -> Arc<AppState> {
        let task_runtime = unconfigured_runtime("task runner");
        let runtime_manager = Arc::new(RuntimeManager {
            task_runner: task_runtime.clone(),
            pty_broker: unconfigured_runtime("pty broker"),
            window_launch: unconfigured_runtime("window launch"),
            session_management: unconfigured_runtime("session management"),
        });

        Arc::new(AppState {
            jwt_secret: Arc::new("secret".to_string()),
            password_hash: Arc::new("hash".to_string()),
            default_tmux_session: Arc::new("nexus".to_string()),
            codex_history_enabled: true,
            ws_connection_counter: Arc::new(AtomicUsize::new(0)),
            github_repo: Arc::new("repo".to_string()),
            project_root: Arc::new(PathBuf::from("/tmp/nexus")),
            workspace_root: Arc::new("/workspace".to_string()),
            configs_dir: Arc::new(PathBuf::from("/tmp/nexus/configs")),
            codex_configs_dir: Arc::new(PathBuf::from("/tmp/nexus/codex-configs")),
            codex_validate_dir: Arc::new(PathBuf::from("/tmp/nexus/codex-validate")),
            project_defaults_file: Arc::new(PathBuf::from("/tmp/nexus/project-defaults.json")),
            toolbar_config_file: Arc::new(PathBuf::from("/tmp/nexus/toolbar-config.json")),
            workspace_layouts_file: Arc::new(layout_file),
            uploads_dir: Arc::new(PathBuf::from("/tmp/nexus/uploads")),
            proxy_vars: Arc::new(Vec::new()),
            public_dir: Arc::new(PathBuf::from("/tmp/nexus/public")),
            frontend_dist_dir: Arc::new(PathBuf::from("/tmp/nexus/frontend/dist")),
            runtime_manager,
            task_manager: TaskManager::new(PathBuf::from("/tmp/nexus/tasks.json"), task_runtime)
                .await,
            telegram_bridge: Arc::new(TelegramBridge::new(
                String::new(),
                String::new(),
                String::new(),
                "https://api.telegram.org".to_string(),
            )),
        })
    }

    #[test]
    fn validates_allowed_layout() {
        let layout = validate_workspace_layout(layout_fixture()).expect("valid layout");
        assert_eq!(layout.mode, "grid-2x2");
        assert_eq!(layout.panes.len(), 2);
    }

    #[test]
    fn rejects_invalid_mode() {
        let error = validate_workspace_layout(invalid_layout(|layout| {
            layout.mode = "diagonal".to_string();
        }))
        .expect_err("invalid mode");
        assert_eq!(error, "invalid layout mode");
    }

    #[test]
    fn rejects_too_many_panes() {
        let error = validate_workspace_layout(invalid_layout(|layout| {
            layout.panes = (1..=10)
                .map(|index| WorkspacePaneState {
                    id: format!("pane-{index}"),
                    target: None,
                })
                .collect();
        }))
        .expect_err("too many panes");
        assert_eq!(error, "too many panes");
    }

    #[test]
    fn rejects_duplicate_or_empty_pane_ids() {
        let duplicate = validate_workspace_layout(invalid_layout(|layout| {
            layout.panes[1].id = "pane-1".to_string();
        }))
        .expect_err("duplicate id");
        assert_eq!(duplicate, "pane ids must be unique");

        let empty = validate_workspace_layout(invalid_layout(|layout| {
            layout.panes[0].id = "   ".to_string();
        }))
        .expect_err("empty id");
        assert_eq!(empty, "pane id required");
    }

    #[test]
    fn rejects_empty_session_and_negative_window_index() {
        let empty_session = validate_workspace_layout(invalid_layout(|layout| {
            layout.panes[0].target.as_mut().unwrap().session = " ".to_string();
        }))
        .expect_err("empty session");
        assert_eq!(empty_session, "target session required");

        let negative_index = validate_workspace_layout(invalid_layout(|layout| {
            layout.panes[0].target.as_mut().unwrap().window_index = -1;
        }))
        .expect_err("negative index");
        assert_eq!(negative_index, "target windowIndex must be non-negative");
    }

    #[tokio::test]
    async fn missing_layout_file_returns_default_single_layout() {
        let dir = tempdir().expect("tempdir");
        let layout = read_active_workspace_layout(&dir.path().join("workspace-layouts.json")).await;
        assert_eq!(layout.version, 1);
        assert_eq!(layout.mode, "single");
        assert_eq!(layout.focused_pane_id, "pane-1");
        assert_eq!(layout.panes.len(), 1);
        assert!(layout.panes[0].target.is_none());
    }

    #[tokio::test]
    async fn corrupt_or_invalid_stored_layout_fails_open_to_default() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("workspace-layouts.json");

        fs::write(&file, "{not json").await.expect("write corrupt");
        let corrupt = read_active_workspace_layout(&file).await;
        assert_eq!(corrupt.mode, "single");

        fs::write(
            &file,
            serde_json::to_string(&WorkspaceLayoutsFile {
                version: 1,
                active_layout: invalid_layout(|layout| layout.mode = "bad".to_string()),
            })
            .expect("json"),
        )
        .await
        .expect("write invalid");
        let invalid = read_active_workspace_layout(&file).await;
        assert_eq!(invalid.mode, "single");
    }

    #[tokio::test]
    async fn write_then_read_active_layout() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("nested").join("workspace-layouts.json");
        let layout = layout_fixture();

        write_active_workspace_layout(&file, &layout)
            .await
            .expect("write layout");
        let restored = read_active_workspace_layout(&file).await;

        assert_eq!(restored, layout);
        let raw = fs::read_to_string(&file).await.expect("file exists");
        let stored: WorkspaceLayoutsFile = serde_json::from_str(&raw).expect("stored json");
        assert_eq!(stored.version, 1);
        assert_eq!(stored.active_layout, layout);
    }

    #[tokio::test]
    async fn active_layout_api_requires_auth() {
        let dir = tempdir().expect("tempdir");
        let state = test_state(dir.path().join("workspace-layouts.json")).await;
        let response = api_get_active_workspace_layout(State(state), HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
