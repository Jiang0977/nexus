use crate::auth::validate_auth_token;
use crate::path_utils::{
    copy_path_recursive_sync, normalize_path_lexically, path_contains_parent_marker,
    path_to_string, paths_equal, percent_encode_utf8, remove_path_recursive_sync,
    resolve_channel_cwd, resolve_workspace_path, sanitize_request_path,
    strip_leading_parent_components,
};
use crate::project_defaults::{get_project_default_payload, remember_project_default};
use crate::runtime_config::{AppConfig, RuntimeConfigs, RuntimeServiceConfig};
use crate::sanitize::{
    parse_output_snapshot_tail_chars, sanitize_managed_upload_filename, sanitize_project_name,
    sanitize_window_name, sanitize_workspace_upload_filename, truncate_websocket_close_reason,
};
use crate::shell::{
    build_interactive_shell_command, build_native_shell_launch_plan, build_window_name,
    derive_initial_window_name, derive_project_session_name, next_available_name,
    normalize_shell_type,
};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Json, Multipart, Path as AxumPath, Query, State};
use axum::http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, RETRY_AFTER,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post, put};
use bcrypt::verify;
use chrono::Utc;
use jsonwebtoken::{EncodingKey, Header, encode};
use mime_guess::from_path;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::fs as stdfs;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio::time::{Duration, timeout};
use tower_http::compression::CompressionLayer;

mod config;
mod layouts;
mod prompts;
mod runtime;
mod session_ws;
mod version;
mod workspace;

use self::config::*;
use self::layouts::*;
use self::prompts::*;
use self::runtime::*;
use self::session_ws::*;
use self::version::*;
use self::workspace::*;

pub async fn run() -> Result<(), Box<dyn Error>> {
    let config = match AppConfig::load() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("ERROR: {message}");
            std::process::exit(1);
        }
    };

    let runtime_manager = Arc::new(
        RuntimeManager::new(
            config.runtime_configs,
            config.session_backend.clone(),
            config.native_pty_supervisor_socket.clone(),
        )
        .await,
    );
    fs::create_dir_all(&config.uploads_dir).await?;
    let prompt_store = PromptStore::new(config.prompts_file);
    let bind_addr = format!("{}:{}", config.host, config.port);
    let state = Arc::new(AppState {
        jwt_secret: Arc::new(config.jwt_secret),
        password_hash: Arc::new(config.password_hash),
        default_tmux_session: Arc::new(config.default_tmux_session),
        session_backend: Arc::new(config.session_backend),
        session_backend_config_file: Arc::new(config.session_backend_config_file),
        codex_history_enabled: config.codex_history_enabled,
        ws_connection_counter: Arc::new(AtomicUsize::new(0)),
        github_repo: Arc::new(config.github_repo),
        project_root: Arc::new(config.project_root.clone()),
        workspace_root: Arc::new(config.workspace_root),
        configs_dir: Arc::new(config.configs_dir),
        codex_configs_dir: Arc::new(config.codex_configs_dir),
        codex_validate_dir: Arc::new(config.codex_validate_dir),
        project_defaults_file: Arc::new(config.project_defaults_file),
        toolbar_config_file: Arc::new(config.toolbar_config_file),
        workspace_layouts_file: Arc::new(config.workspace_layouts_file),
        prompt_store,
        uploads_dir: Arc::new(config.uploads_dir),
        proxy_vars: Arc::new(config.proxy_vars),
        public_dir: Arc::new(config.project_root.join("public")),
        frontend_dist_dir: Arc::new(config.project_root.join("frontend").join("dist")),
        runtime_manager: runtime_manager.clone(),
        login_limiter: Arc::new(LoginRateLimiter::new()),
    });
    let app = build_router(state);

    let listener = TcpListener::bind(&bind_addr).await?;
    println!("nexus-server listening on {}", listener.local_addr()?);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    runtime_manager.shutdown_all().await;
    Ok(())
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(api_health))
        .route("/api/auth/login", post(api_login))
        .route("/api/config", get(api_config).post(api_save_config))
        .route("/api/configs", get(api_claude_configs))
        .route("/api/configs/{id}", post(api_save_claude_config))
        .route("/api/configs/{id}", delete(api_delete_claude_config))
        .route(
            "/api/configs/{id}/sync-current",
            post(api_sync_current_claude_config),
        )
        .route("/api/runtime/status", get(api_runtime_status))
        .route("/api/codex-configs", get(api_codex_configs))
        .route(
            "/api/codex-configs/import-global",
            post(api_import_global_codex_config),
        )
        .route(
            "/api/codex-configs/{id}/sync-current",
            post(api_sync_current_codex_config),
        )
        .route(
            "/api/codex-configs/{id}/validate",
            post(api_validate_codex_config),
        )
        .route("/api/codex-configs/{id}", post(api_save_codex_config))
        .route("/api/codex-configs/{id}", delete(api_delete_codex_config))
        .route("/api/cc-switch/providers", get(api_cc_switch_providers))
        .route(
            "/api/cc-switch/providers/{kind}/{provider_id}/import",
            post(api_import_cc_switch_provider),
        )
        .route(
            "/api/cc-switch/codex/sync-history",
            post(api_sync_cc_switch_codex_history),
        )
        .route("/api/project-defaults", get(api_project_defaults))
        .route("/api/toolbar-config", get(api_toolbar_config))
        .route("/api/toolbar-config", post(api_save_toolbar_config))
        .route(
            "/api/workspace-layouts/active",
            get(api_get_active_workspace_layout).put(api_put_active_workspace_layout),
        )
        .route(
            "/api/prompt-library",
            get(api_get_prompt_library).post(api_create_prompt),
        )
        .route("/api/prompt-library/order", put(api_reorder_prompt_library))
        .route(
            "/api/prompt-library/{id}",
            put(api_update_prompt).delete(api_delete_prompt),
        )
        .route("/api/version", get(api_version))
        .route("/api/version/latest", get(api_latest_version))
        .route("/api/browse", get(api_browse))
        .route("/api/workspace/files", get(api_workspace_entries))
        .route("/api/workspace/files", post(api_workspace_create_file))
        .route("/api/workspace/mkdir", post(api_workspace_mkdir))
        .route("/api/workspace/file", get(api_workspace_read_file))
        .route("/api/workspace/file", put(api_workspace_write_file))
        .route("/api/workspace/entry", delete(api_workspace_delete_entry))
        .route("/api/workspace/rename", post(api_workspace_rename_entry))
        .route("/api/workspace/copy", post(api_workspace_copy_entry))
        .route("/api/workspace/move", post(api_workspace_move_entry))
        .route("/ws", get(api_ws))
        .route("/api/upload", post(api_upload_workspace_file))
        .route("/api/files/upload", post(api_upload_managed_file))
        .route("/api/files", get(api_files))
        .route("/api/files/all", delete(api_delete_all_files))
        .route("/api/files/{date}/{filename}", delete(api_delete_file))
        .route("/api/sessions/{id}/output", get(api_session_output))
        .route("/api/sessions/{id}/scrollback", get(api_session_scrollback))
        .route("/api/tmux-sessions", get(api_tmux_sessions))
        .route("/api/projects", get(api_projects))
        .route("/api/projects", post(api_create_project))
        .route("/api/windows", post(api_launch_window))
        .route("/api/session-cwd", get(api_session_cwd))
        .route("/api/codex-sessions", get(api_codex_sessions))
        .route(
            "/api/codex-sessions/{id}/detail",
            get(api_codex_session_detail),
        )
        .route(
            "/api/codex-sessions/{id}/resume",
            post(api_codex_session_resume),
        )
        .route("/api/codex-sessions/{id}", delete(api_codex_session_delete))
        .route("/api/projects/{name}/channels", get(api_project_channels))
        .route(
            "/api/projects/{name}/channels",
            post(api_create_project_channel),
        )
        .route("/api/projects/{name}/activate", post(api_activate_project))
        .route("/api/projects/{name}/rename", post(api_rename_project))
        .route("/api/projects/{name}", delete(api_delete_project))
        .route("/api/sessions", get(api_sessions))
        .route("/api/sessions", post(api_create_session_window))
        .route("/api/sessions/{id}", delete(api_delete_session))
        .route("/api/sessions/{id}/attach", post(api_attach_session))
        .route("/api/sessions/{id}/rename", post(api_rename_session))
        .route("/workspace", get(api_workspace_file_root))
        .route("/workspace/{*path}", get(api_workspace_file_path))
        .route("/uploads/{*path}", get(static_uploads))
        .route("/", any(static_fallback))
        .route("/{*path}", any(static_fallback))
        .with_state(state)
        .layer(CompressionLayer::new())
}
async fn api_health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "server": "nexus-server",
    }))
}

async fn api_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
) -> Response {
    ws.on_upgrade(move |socket| handle_pty_websocket(socket, state, query))
}

async fn api_session_output(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let window_index = match id.parse::<u32>() {
        Ok(value) => value,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid window index"),
    };
    let session = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let tail_chars = parse_output_snapshot_tail_chars(query.tail_chars.as_deref());
    let mut params = json!({
        "session": session,
        "windowIndex": window_index,
    });
    if let Some(limit) = tail_chars {
        params["tailChars"] = json!(limit);
    }

    runtime_request_response(
        resolve_session_output_snapshot(
            state
                .runtime_manager
                .pty_broker_request("getOutputSnapshot", params)
                .await,
            &session,
            window_index,
            tail_chars,
        )
        .await,
    )
}

async fn api_session_scrollback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ScrollbackQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let window_index = match id.parse::<u32>() {
        Ok(value) => value,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid window index"),
    };
    let session = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let lines = query
        .lines
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(3000)
        .min(10_000);

    if state.is_native_session_backend() {
        return runtime_request_response(
            state
                .runtime_manager
                .pty_broker_request(
                    "getScrollbackSnapshot",
                    json!({
                        "session": session,
                        "windowIndex": window_index,
                    }),
                )
                .await
                .map(|snapshot| {
                    let content = snapshot
                        .get("output")
                        .and_then(Value::as_str)
                        .map(render_native_scrollback_plain_text)
                        .map(|output| trim_scrollback_to_lines(&output, lines))
                        .unwrap_or_default();
                    json!({ "content": content })
                }),
        );
    }

    match capture_tmux_scrollback(&session, window_index, lines).await {
        Ok(content) => Json(json!({ "content": content })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

fn native_launch_plan_json(
    state: &AppState,
    shell_type: &str,
    profile: Option<&str>,
    cwd: &str,
    resume_session_id: Option<&str>,
) -> Option<Value> {
    if !state.is_native_session_backend() {
        return None;
    }

    let plan = build_native_shell_launch_plan(
        state.project_root.as_ref(),
        state.proxy_vars.as_ref(),
        shell_type,
        profile,
        cwd,
        resume_session_id,
    )?;
    let env = plan.env.into_iter().collect::<HashMap<_, _>>();
    Some(json!({
        "program": plan.program,
        "args": plan.args,
        "env": env,
        "cwd": plan.cwd,
    }))
}

fn with_launch_plan(mut payload: Value, launch_plan: Option<Value>) -> Value {
    if let Some(launch_plan) = launch_plan
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("launchPlan".to_string(), launch_plan);
    }
    payload
}

async fn api_tmux_sessions(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("listTmuxSessions", json!({}))
            .await,
    )
}

async fn api_projects(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("listProjects", json!({}))
            .await,
    )
}

async fn api_session_cwd(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "getSessionCwd",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                }),
            )
            .await,
    )
}

async fn api_launch_window(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
    Json(body): Json<WindowLaunchBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let session_name = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let rel_path = body.rel_path.filter(|value| !value.is_empty());
    let update_session_cwd = rel_path.is_some();
    let cwd = match rel_path {
        Some(path) => resolve_workspace_path(state.workspace_root.as_ref(), &path),
        None => resolve_session_cwd_from_runtime(&state, &session_name).await,
    };

    launch_window_via_runtime(
        &state,
        session_name,
        cwd,
        &shell_type,
        response_profile,
        update_session_cwd,
        "window",
    )
    .await
}

async fn api_codex_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CodexSessionsQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "listCodexSessions",
                json!({
                    "projectName": query.project.unwrap_or_default(),
                    "limit": query.limit,
                    "cursor": query.cursor,
                }),
            )
            .await,
    )
}

async fn api_codex_session_detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "getCodexSessionDetail",
                json!({
                    "sessionId": id,
                    "projectName": query.project.unwrap_or_default(),
                }),
            )
            .await,
    )
}

async fn api_codex_session_resume(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectQuery>,
    body: Option<Json<CodexResumeBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let (project_name, requested_profile) = match body {
        Some(Json(payload)) => (
            payload
                .project
                .filter(|value| !value.is_empty())
                .or(query.project)
                .unwrap_or_default(),
            payload.profile,
        ),
        None => (query.project.unwrap_or_default(), None),
    };
    let detail = match state
        .runtime_manager
        .session_management_request(
            "getCodexSessionDetail",
            json!({
                "sessionId": id,
                "projectName": project_name.clone(),
            }),
        )
        .await
    {
        Ok(Value::Object(payload)) => payload,
        Ok(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "codex session detail missing payload",
            );
        }
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };

    let cwd = detail
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| state.workspace_root.as_ref().clone());
    let default_payload = get_project_default_payload(
        state.project_defaults_file.as_ref(),
        state.workspace_root.as_ref(),
        Some(&cwd),
    );
    let default_profile =
        if default_payload.get("shell_type").and_then(Value::as_str) == Some("codex") {
            default_payload
                .get("profile")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        } else {
            None
        };
    let response_profile = requested_profile.or(default_profile);
    let shell_cmd = build_interactive_shell_command(
        state.project_root.as_ref(),
        state.proxy_vars.as_ref(),
        DEFAULT_INTERACTIVE_SHELL,
        "codex",
        response_profile.as_deref(),
        &cwd,
        Some(&id),
    );

    let request_payload = with_launch_plan(
        json!({
            "sessionId": id.clone(),
            "sessionName": project_name.clone(),
            "projectName": project_name,
            "cwd": cwd.clone(),
            "windowName": "codex-history",
            "shellCmd": shell_cmd,
            "proxyVars": proxy_vars_json(&state),
        }),
        native_launch_plan_json(
            &state,
            "codex",
            response_profile.as_deref(),
            &cwd,
            Some(&id),
        ),
    );

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("resumeCodexSession", request_payload)
            .await,
    )
}

async fn api_codex_session_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectQuery>,
    body: Option<Json<ProjectBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "deleteProjectCodexSession",
                json!({
                    "sessionId": id,
                    "projectName": project_from_sources(body, query.project),
                }),
            )
            .await,
    )
}

async fn api_project_channels(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("listProjectChannels", json!({ "projectName": name }))
            .await,
    )
}

async fn api_create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateProjectBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(path) = body.path.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "path required");
    };

    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let cwd = resolve_workspace_path(state.workspace_root.as_ref(), &path);
    let safe_name = derive_project_session_name(&cwd);
    let existing_sessions = list_all_session_names_from_runtime(&state).await;
    let final_name = next_available_name(&safe_name, &existing_sessions);
    let initial_window_name =
        derive_initial_window_name(&cwd, response_profile.as_deref()).to_string();
    let shell_cmd = build_interactive_shell_command(
        state.project_root.as_ref(),
        state.proxy_vars.as_ref(),
        DEFAULT_INTERACTIVE_SHELL,
        &shell_type,
        response_profile.as_deref(),
        &cwd,
        None,
    );

    let request_payload = with_launch_plan(
        json!({
            "sessionName": final_name.clone(),
            "cwd": cwd.clone(),
            "initialWindowName": initial_window_name,
            "shellCmd": shell_cmd,
            "proxyVars": proxy_vars_json(&state),
        }),
        native_launch_plan_json(&state, &shell_type, response_profile.as_deref(), &cwd, None),
    );

    match state
        .runtime_manager
        .session_management_request("createProject", request_payload)
        .await
    {
        Ok(_) => {}
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to create project: {error}"),
            );
        }
    }

    if let Err(error) = remember_project_default(
        state.project_defaults_file.as_ref(),
        &cwd,
        &shell_type,
        response_profile.as_deref(),
    )
    .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }

    Json(json!({
        "name": final_name,
        "path": cwd,
        "shell_type": shell_type,
        "profile": response_profile,
    }))
    .into_response()
}

async fn api_create_project_channel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<CreateProjectBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let requested_path = body.path.filter(|value| !value.is_empty());
    let resolved_requested = requested_path
        .as_deref()
        .map(|path| resolve_workspace_path(state.workspace_root.as_ref(), path));
    let session_cwd = match resolved_requested.as_deref() {
        Some(path) if !paths_equal(path, state.workspace_root.as_ref()) => String::new(),
        _ => resolve_session_cwd_from_runtime(&state, &name).await,
    };
    let cwd = resolve_channel_cwd(
        state.workspace_root.as_ref(),
        &session_cwd,
        requested_path.as_deref(),
    );
    let base_channel_name = response_profile
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("channel");
    let existing_channel_names = list_channel_names_from_runtime(&state, &name).await;
    let channel_name = next_available_name(base_channel_name, &existing_channel_names);
    let shell_cmd = build_interactive_shell_command(
        state.project_root.as_ref(),
        state.proxy_vars.as_ref(),
        DEFAULT_INTERACTIVE_SHELL,
        &shell_type,
        response_profile.as_deref(),
        &cwd,
        None,
    );

    let request_payload = with_launch_plan(
        json!({
            "sessionName": name.clone(),
            "cwd": cwd.clone(),
            "channelName": channel_name.clone(),
            "shellCmd": shell_cmd,
            "defaultShellCmd": DEFAULT_INTERACTIVE_SHELL,
            "proxyVars": proxy_vars_json(&state),
        }),
        native_launch_plan_json(&state, &shell_type, response_profile.as_deref(), &cwd, None),
    );

    match state
        .runtime_manager
        .session_management_request("createProjectChannel", request_payload)
        .await
    {
        Ok(_) => {}
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
        }
    }

    if let Err(error) = remember_project_default(
        state.project_defaults_file.as_ref(),
        &cwd,
        &shell_type,
        response_profile.as_deref(),
    )
    .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }

    Json(json!({
        "name": channel_name,
        "cwd": cwd,
        "shell_type": shell_type,
        "profile": response_profile,
        "project": name,
    }))
    .into_response()
}

async fn api_activate_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("activateProject", json!({ "projectName": name }))
            .await,
    )
}

async fn api_create_session_window(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WindowLaunchBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(path) = body.rel_path.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "rel_path required");
    };

    let session_name = body
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let cwd = resolve_workspace_path(state.workspace_root.as_ref(), &path);

    launch_window_via_runtime(
        &state,
        session_name,
        cwd,
        &shell_type,
        response_profile,
        false,
        "session",
    )
    .await
}

async fn api_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "listSessionWindows",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                }),
            )
            .await,
    )
}

async fn api_rename_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<NameBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(new_name) = sanitize_project_name(body.name) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid name format");
    };

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "renameProject",
                json!({
                    "oldName": name,
                    "newName": new_name,
                }),
            )
            .await,
    )
}

async fn api_delete_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("deleteProject", json!({ "sessionName": name }))
            .await,
    )
}

async fn api_attach_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "attachSessionWindow",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                    "index": id,
                }),
            )
            .await,
    )
}

async fn api_rename_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
    Json(body): Json<NameBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(window_name) = sanitize_window_name(body.name) else {
        return json_error(StatusCode::BAD_REQUEST, "name required");
    };

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "renameSessionWindow",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                    "index": id,
                    "name": window_name,
                }),
            )
            .await,
    )
}

async fn api_delete_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "deleteSessionWindow",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                    "index": id,
                    "defaultShellCmd": DEFAULT_INTERACTIVE_SHELL,
                }),
            )
            .await,
    )
}
