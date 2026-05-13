use crate::runtime_config::read_session_backend_config_file;
use super::*;

pub(super) async fn api_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LoginRequest>,
) -> Response {
    let Some(password) = payload.password.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "password required");
    };

    let password_matches = match verify(password, state.password_hash.as_str()) {
        Ok(matches) => matches,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };

    if !password_matches {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => 0,
    };
    let claims = AuthClaims {
        exp: now + TOKEN_TTL_SECONDS,
    };

    match encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    ) {
        Ok(token) => Json(json!({ "token": token })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    }
}

pub(super) async fn api_config(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let configured_session_backend =
        read_session_backend_config_file(state.session_backend_config_file.as_ref());
    Json(json!({
        "tmuxSession": state.default_tmux_session.as_ref(),
        "sessionBackend": state.session_backend.as_ref(),
        "configuredSessionBackend": configured_session_backend,
        "workspaceRoot": state.workspace_root.as_ref(),
        "features": {
            "codexHistory": state.codex_history_enabled,
        },
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(super) struct SessionBackendConfigPayload {
    pub(super) session_backend: Option<String>,
}

pub(super) async fn api_save_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SessionBackendConfigPayload>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(session_backend) = payload
        .session_backend
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return json_error(StatusCode::BAD_REQUEST, "session_backend required");
    };

    let normalized = match session_backend.to_ascii_lowercase().as_str() {
        "tmux" => "tmux",
        "native" => "native",
        _ => return json_error(StatusCode::BAD_REQUEST, "invalid session backend"),
    };

    match write_session_backend_config_file(state.session_backend_config_file.as_ref(), normalized) {
        Ok(()) => Json(json!({
            "ok": true,
            "sessionBackend": state.session_backend.as_ref(),
            "configuredSessionBackend": normalized,
            "restartRequired": true,
        }))
        .into_response(),
        Err(error) => Json(error.body).into_response(),
    }
}

pub(super) async fn api_claude_configs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(list_claude_configs(state.configs_dir.as_ref())).into_response()
}

pub(super) async fn api_save_claude_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<Value>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(save_claude_config_route(
        state.configs_dir.as_ref(),
        &id,
        payload,
    ))
}

pub(super) async fn api_sync_current_claude_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(sync_current_claude_config_route(
        state.configs_dir.as_ref(),
        &id,
    ))
}

pub(super) async fn api_delete_claude_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(delete_claude_config_route(state.configs_dir.as_ref(), &id))
}

pub(super) async fn api_runtime_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(state.runtime_manager.runtime_status_payload().await).into_response()
}

pub(super) async fn api_codex_configs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(list_codex_configs(state.codex_configs_dir.as_ref())).into_response()
}

pub(super) async fn api_import_global_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<IdBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(import_global_codex_config_route(
        state.codex_configs_dir.as_ref(),
        body.and_then(|Json(payload)| payload.id),
    ))
}

pub(super) async fn api_sync_current_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(sync_current_codex_config_route(
        state.codex_configs_dir.as_ref(),
        &id,
    ))
}

pub(super) async fn api_validate_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(
        validate_codex_config_route(
            state.codex_configs_dir.as_ref(),
            state.codex_validate_dir.as_ref(),
            state.project_root.as_ref(),
            &id,
            state.proxy_vars.as_ref(),
        )
        .await,
    )
}

pub(super) async fn api_save_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<Value>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(save_codex_config_route(
        state.codex_configs_dir.as_ref(),
        &id,
        payload,
    ))
}

pub(super) async fn api_delete_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(delete_codex_config_route(
        state.codex_configs_dir.as_ref(),
        &id,
    ))
}

pub(super) async fn api_cc_switch_providers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<KindQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(list_cc_switch_providers_route(
        state.configs_dir.as_ref(),
        state.codex_configs_dir.as_ref(),
        query.kind.as_deref().unwrap_or_default(),
    ))
}

pub(super) async fn api_import_cc_switch_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((kind, provider_id)): AxumPath<(String, String)>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(import_cc_switch_provider_route(
        state.configs_dir.as_ref(),
        state.codex_configs_dir.as_ref(),
        &kind,
        &provider_id,
    ))
}

pub(super) async fn api_sync_cc_switch_codex_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match crate::codex_replay::sync_cc_switch_codex_history() {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_error(error.status_code, &error.message),
    }
}

pub(super) async fn api_project_defaults(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(get_project_default_payload(
        state.project_defaults_file.as_ref(),
        state.workspace_root.as_ref(),
        query.path.as_deref(),
    ))
    .into_response()
}

pub(super) async fn api_toolbar_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(read_toolbar_config_file(state.toolbar_config_file.as_ref()).await).into_response()
}

pub(super) async fn api_save_toolbar_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match write_toolbar_config_file(state.toolbar_config_file.as_ref(), &payload).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn api_telegram_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(update): Json<TelegramUpdate>,
) -> Response {
    if let Err(error) = state.telegram_bridge.verify_webhook_request(&headers) {
        return json_error(error.status, &error.message);
    }

    let telegram_bridge = state.telegram_bridge.clone();
    let task_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = telegram_bridge.handle_update(task_state, update).await {
            eprintln!("telegram webhook error: {error}");
        }
    });

    Json(json!({ "ok": true })).into_response()
}

pub(super) async fn api_telegram_setup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let protocol =
        forwarded_header_value(&headers, "x-forwarded-proto").unwrap_or_else(|| "http".to_string());
    let host = forwarded_header_value(&headers, "x-forwarded-host")
        .or_else(|| header_string(&headers, "host"))
        .unwrap_or_default();
    if host.is_empty() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "host header missing");
    }

    match state
        .telegram_bridge
        .setup_webhook(protocol.trim(), host.trim())
        .await
    {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_error(error.status, &error.message),
    }
}

pub(super) fn config_profiles_response(result: Result<Value, ServiceRouteError>) -> Response {
    match result {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

pub(super) fn sync_metadata_keys() -> [&'static str; 3] {
    ["SYNC_SOURCE", "SYNC_SOURCE_ID", "SYNC_SOURCE_NAME"]
}

pub(super) fn object_value(value: &Value) -> serde_json::Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

pub(super) fn value_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(super) fn json_object_file(path: &Path) -> Option<serde_json::Map<String, Value>> {
    stdfs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
}

pub(super) fn write_session_backend_config_file(
    path: &Path,
    session_backend: &str,
) -> Result<(), ServiceRouteError> {
    let mut object = serde_json::Map::new();
    object.insert(
        "session_backend".to_string(),
        Value::String(session_backend.to_string()),
    );
    write_json_object_file(path, &object, true)
}

pub(super) fn write_json_object_file(
    path: &Path,
    object: &serde_json::Map<String, Value>,
    trailing_newline: bool,
) -> Result<(), ServiceRouteError> {
    if let Some(parent) = path.parent() {
        stdfs::create_dir_all(parent).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    }
    let mut content =
        serde_json::to_string_pretty(&Value::Object(object.clone())).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    if trailing_newline {
        content.push('\n');
    }
    stdfs::write(path, content).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })
}

pub(super) fn sanitize_profile_id(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
}

pub(super) fn merge_sync_metadata(
    current: &serde_json::Map<String, Value>,
    next: &mut serde_json::Map<String, Value>,
) {
    for key in sync_metadata_keys() {
        if !next.contains_key(key)
            && let Some(value) = current.get(key)
        {
            next.insert(key.to_string(), value.clone());
        }
    }
}

pub(super) fn metadata_mtime_ms(path: &Path) -> u64 {
    stdfs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn build_claude_config_response_object(
    id: &str,
    raw: Option<serde_json::Map<String, Value>>,
) -> Value {
    let mut payload = raw.unwrap_or_default();
    let label = value_string(payload.get("label"));
    payload.insert("id".to_string(), Value::String(id.to_string()));
    payload.insert(
        "label".to_string(),
        Value::String(if label.is_empty() {
            id.to_string()
        } else {
            label
        }),
    );
    Value::Object(payload)
}

pub(super) fn read_stored_claude_config(configs_dir: &Path, id: &str) -> Option<Value> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return None;
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if !file_path.exists() {
        return None;
    }
    Some(build_claude_config_response_object(
        &sanitized_id,
        json_object_file(&file_path),
    ))
}

pub(super) fn list_claude_configs(configs_dir: &Path) -> Value {
    let mut files = match stdfs::read_dir(configs_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    files.sort_by_key(|path| std::cmp::Reverse(metadata_mtime_ms(path)));
    Value::Array(
        files
            .into_iter()
            .map(|path| {
                let id = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                build_claude_config_response_object(&id, json_object_file(&path))
            })
            .collect(),
    )
}

pub(super) fn save_stored_claude_config(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<(String, Value), ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }

    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    let current = read_stored_claude_config(configs_dir, &sanitized_id)
        .map(|value| object_value(&value))
        .unwrap_or_default();
    let mut next = object_value(&config);
    merge_sync_metadata(&current, &mut next);
    write_json_object_file(&file_path, &next, false)?;

    Ok((
        sanitized_id.clone(),
        build_claude_config_response_object(&sanitized_id, Some(next)),
    ))
}

pub(super) fn save_claude_config_route(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<Value, ServiceRouteError> {
    let (saved_id, _) = save_stored_claude_config(configs_dir, id, config)?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
    }))
}

pub(super) fn read_global_claude_config() -> Option<Value> {
    let home_dir = env::var("HOME").ok()?;
    let settings_file = Path::new(&home_dir).join(".claude").join("settings.json");
    let settings = json_object_file(&settings_file)?;
    let env_payload = settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let default_model = {
        let sonnet = value_string(env_payload.get("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        if sonnet.is_empty() {
            value_string(env_payload.get("ANTHROPIC_MODEL"))
        } else {
            sonnet
        }
    };
    let think_model = {
        let opus = value_string(env_payload.get("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        if opus.is_empty() {
            value_string(env_payload.get("ANTHROPIC_THINK_MODEL"))
        } else {
            opus
        }
    };
    let api_timeout_ms = {
        let timeout = value_string(env_payload.get("API_TIMEOUT_MS"));
        if timeout.is_empty() {
            "3000000".to_string()
        } else {
            timeout
        }
    };

    Some(json!({
        "label": "Imported from ~/.claude/settings.json",
        "BASE_URL": value_string(env_payload.get("ANTHROPIC_BASE_URL")),
        "AUTH_TOKEN": value_string(env_payload.get("ANTHROPIC_AUTH_TOKEN")),
        "API_KEY": value_string(env_payload.get("ANTHROPIC_API_KEY")),
        "DEFAULT_MODEL": default_model,
        "THINK_MODEL": think_model,
        "LONG_CONTEXT_MODEL": value_string(env_payload.get("ANTHROPIC_LONG_CONTEXT_MODEL")),
        "DEFAULT_HAIKU_MODEL": value_string(env_payload.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")),
        "API_TIMEOUT_MS": api_timeout_ms,
    }))
}

pub(super) fn sync_current_claude_config_route(
    configs_dir: &Path,
    id: &str,
) -> Result<Value, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }

    let existing = read_stored_claude_config(configs_dir, &sanitized_id).ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "config not found")
    })?;
    let imported = read_global_claude_config().ok_or_else(|| {
        ServiceRouteError::from_message(
            StatusCode::NOT_FOUND,
            "global ~/.claude/settings.json not found",
        )
    })?;

    let mut imported_object = object_value(&imported);
    let existing_label = value_string(object_value(&existing).get("label"));
    let imported_label = value_string(imported_object.get("label"));
    imported_object.insert(
        "label".to_string(),
        Value::String(if existing_label.is_empty() {
            if imported_label.is_empty() {
                sanitized_id.clone()
            } else {
                imported_label
            }
        } else {
            existing_label
        }),
    );

    let (saved_id, saved_config) =
        save_stored_claude_config(configs_dir, &sanitized_id, Value::Object(imported_object))?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
        "config": saved_config,
    }))
}

pub(super) fn delete_claude_config_route(
    configs_dir: &Path,
    id: &str,
) -> Result<Value, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if file_path.exists() {
        stdfs::remove_file(file_path).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    }
    Ok(json!({ "ok": true }))
}

pub(super) fn parse_json_object_from_str(raw: &str) -> Option<serde_json::Map<String, Value>> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

pub(super) fn normalize_json_text_value(value: Option<&Value>) -> String {
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

pub(super) fn empty_codex_config_object(label: &str) -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([
        ("label".to_string(), Value::String(label.to_string())),
        ("OPENAI_API_KEY".to_string(), Value::String(String::new())),
        ("BASE_URL".to_string(), Value::String(String::new())),
        ("MODEL".to_string(), Value::String(String::new())),
        ("REASONING_EFFORT".to_string(), Value::String(String::new())),
        ("CONFIG_TOML".to_string(), Value::String(String::new())),
        ("AUTH_JSON".to_string(), Value::String(String::new())),
        ("SYNC_SOURCE".to_string(), Value::String(String::new())),
        ("SYNC_SOURCE_ID".to_string(), Value::String(String::new())),
        ("SYNC_SOURCE_NAME".to_string(), Value::String(String::new())),
    ])
}

pub(super) fn normalize_codex_config_value(value: &Value) -> serde_json::Map<String, Value> {
    let raw = object_value(value);
    let auth_json = normalize_json_text_value(raw.get("AUTH_JSON"));
    let auth_payload = parse_json_object_from_str(&auth_json).unwrap_or_default();
    let mut normalized = empty_codex_config_object(&value_string(raw.get("label")));
    let openai_api_key = value_string(raw.get("OPENAI_API_KEY"));
    normalized.insert(
        "OPENAI_API_KEY".to_string(),
        Value::String(if openai_api_key.is_empty() {
            value_string(auth_payload.get("OPENAI_API_KEY"))
        } else {
            openai_api_key
        }),
    );
    normalized.insert(
        "BASE_URL".to_string(),
        Value::String(value_string(raw.get("BASE_URL"))),
    );
    normalized.insert(
        "MODEL".to_string(),
        Value::String(value_string(raw.get("MODEL"))),
    );
    normalized.insert(
        "REASONING_EFFORT".to_string(),
        Value::String(value_string(raw.get("REASONING_EFFORT"))),
    );
    normalized.insert(
        "CONFIG_TOML".to_string(),
        Value::String(value_string(raw.get("CONFIG_TOML"))),
    );
    normalized.insert("AUTH_JSON".to_string(), Value::String(auth_json));
    for key in sync_metadata_keys() {
        normalized.insert(key.to_string(), Value::String(value_string(raw.get(key))));
    }
    normalized
}

pub(super) fn build_codex_config_response_object(
    id: &str,
    raw: Option<serde_json::Map<String, Value>>,
) -> Value {
    let mut normalized = match raw {
        Some(raw) => normalize_codex_config_value(&Value::Object(raw)),
        None => empty_codex_config_object(id),
    };
    let label = value_string(normalized.get("label"));
    normalized.insert("id".to_string(), Value::String(id.to_string()));
    normalized.insert(
        "label".to_string(),
        Value::String(if label.is_empty() {
            id.to_string()
        } else {
            label
        }),
    );
    Value::Object(normalized)
}

pub(super) fn read_codex_config(configs_dir: &Path, id: &str) -> Option<Value> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return None;
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if !file_path.exists() {
        return None;
    }
    Some(build_codex_config_response_object(
        &sanitized_id,
        json_object_file(&file_path),
    ))
}

pub(super) fn list_codex_configs(configs_dir: &Path) -> Value {
    let mut files = match stdfs::read_dir(configs_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    files.sort_by_key(|path| std::cmp::Reverse(metadata_mtime_ms(path)));
    Value::Array(
        files
            .into_iter()
            .map(|path| {
                let id = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                build_codex_config_response_object(&id, json_object_file(&path))
            })
            .collect(),
    )
}

pub(super) fn save_codex_config_file(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<String, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    let normalized = normalize_codex_config_value(&config);
    write_json_object_file(&file_path, &normalized, true)?;
    Ok(sanitized_id)
}

pub(super) fn save_codex_config_with_metadata(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<(String, Value), ServiceRouteError> {
    let current = read_codex_config(configs_dir, id)
        .map(|value| object_value(&value))
        .unwrap_or_default();
    let mut next = object_value(&config);
    merge_sync_metadata(&current, &mut next);
    let saved_id = save_codex_config_file(configs_dir, id, Value::Object(next.clone()))?;
    let saved_config = read_codex_config(configs_dir, &saved_id)
        .unwrap_or_else(|| build_codex_config_response_object(&saved_id, Some(next)));
    Ok((saved_id, saved_config))
}

pub(super) fn save_codex_config_route(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<Value, ServiceRouteError> {
    let (saved_id, _) = save_codex_config_with_metadata(configs_dir, id, config)?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
    }))
}

pub(super) struct SimpleToml {
    pub(super) root: HashMap<String, String>,
    pub(super) sections: HashMap<String, HashMap<String, String>>,
}

pub(super) fn parse_toml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else {
        value.to_string()
    }
}

pub(super) fn parse_simple_toml(text: &str) -> SimpleToml {
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

pub(super) fn import_codex_config_from_global(
    config_toml_text: &str,
    auth_json_text: &str,
) -> Value {
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
    let model = parsed_toml.root.get("model").cloned().unwrap_or_default();

    let config = json!({
        "label": if model.is_empty() {
            "Imported from ~/.codex".to_string()
        } else {
            format!("Imported ({model})")
        },
        "OPENAI_API_KEY": value_string(auth_payload.get("OPENAI_API_KEY")),
        "BASE_URL": provider_section.get("base_url").cloned().unwrap_or_default(),
        "MODEL": model,
        "REASONING_EFFORT": parsed_toml
            .root
            .get("model_reasoning_effort")
            .cloned()
            .unwrap_or_default(),
        "CONFIG_TOML": normalized_config_toml,
        "AUTH_JSON": normalized_auth_json,
    });
    Value::Object(normalize_codex_config_value(&config))
}

pub(super) fn read_global_codex_config() -> Option<Value> {
    let home_dir = env::var("HOME").ok()?;
    let codex_dir = Path::new(&home_dir).join(".codex");
    let config_file = codex_dir.join("config.toml");
    let auth_file = codex_dir.join("auth.json");
    if !config_file.exists() && !auth_file.exists() {
        return None;
    }

    let config_toml_text = stdfs::read_to_string(&config_file).unwrap_or_default();
    let auth_json_text = stdfs::read_to_string(&auth_file).unwrap_or_default();
    Some(import_codex_config_from_global(
        &config_toml_text,
        &auth_json_text,
    ))
}

pub(super) fn import_global_codex_config_route(
    configs_dir: &Path,
    preferred_id: Option<String>,
) -> Result<Value, ServiceRouteError> {
    let imported = read_global_codex_config().ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "global ~/.codex not found")
    })?;

    let preferred_id = preferred_id.unwrap_or_default().trim().to_string();
    let raw_base_id = sanitize_profile_id(if preferred_id.is_empty() {
        "imported"
    } else {
        &preferred_id
    });
    let base_id = if raw_base_id.is_empty() {
        "imported".to_string()
    } else {
        raw_base_id
    };
    let mut next_id = base_id.clone();
    let mut counter = 1;
    while configs_dir.join(format!("{next_id}.json")).exists() {
        next_id = format!("{base_id}-{counter}");
        counter += 1;
    }

    let (saved_id, saved_config) =
        save_codex_config_with_metadata(configs_dir, &next_id, imported)?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
        "config": saved_config,
    }))
}

pub(super) fn sync_current_codex_config_route(
    configs_dir: &Path,
    id: &str,
) -> Result<Value, ServiceRouteError> {
    let existing = read_codex_config(configs_dir, id).ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "config not found")
    })?;
    let imported = read_global_codex_config().ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "global ~/.codex not found")
    })?;

    let existing_label = value_string(object_value(&existing).get("label"));
    let imported_label = value_string(object_value(&imported).get("label"));
    let mut next = object_value(&imported);
    next.insert(
        "label".to_string(),
        Value::String(if existing_label.is_empty() {
            if imported_label.is_empty() {
                id.to_string()
            } else {
                imported_label
            }
        } else {
            existing_label
        }),
    );

    let (saved_id, saved_config) =
        save_codex_config_with_metadata(configs_dir, id, Value::Object(next))?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
        "config": saved_config,
    }))
}

pub(super) fn detect_codex_auth_mode(config: &Value) -> String {
    let normalized = normalize_codex_config_value(config);
    let auth_payload =
        parse_json_object_from_str(&value_string(normalized.get("AUTH_JSON"))).unwrap_or_default();
    let auth_mode = value_string(auth_payload.get("auth_mode"));
    if !auth_mode.is_empty() {
        return auth_mode;
    }
    if !value_string(normalized.get("OPENAI_API_KEY")).is_empty() {
        return "api_key".to_string();
    }
    String::new()
}

pub(super) fn build_codex_validation_config(config: &Value) -> Value {
    let mut normalized = normalize_codex_config_value(config);
    normalized.insert("CONFIG_TOML".to_string(), Value::String(String::new()));
    Value::Object(normalized)
}

pub(super) fn ensure_trailing_newline(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

pub(super) fn append_trusted_project_section(config_toml_text: &str, project_path: &str) -> String {
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
    let merged = if trimmed.is_empty() {
        project_section
    } else {
        format!("{trimmed}\n\n{project_section}")
    };
    ensure_trailing_newline(&merged)
}

pub(super) fn build_codex_config_toml(config: &Value, project_path: &str) -> String {
    let normalized = normalize_codex_config_value(config);
    let config_toml = value_string(normalized.get("CONFIG_TOML"));
    if !config_toml.is_empty() {
        return append_trusted_project_section(&config_toml, project_path);
    }

    let mut lines = Vec::new();
    let base_url = value_string(normalized.get("BASE_URL"));
    let model = value_string(normalized.get("MODEL"));
    let reasoning_effort = value_string(normalized.get("REASONING_EFFORT"));
    if !base_url.is_empty() {
        lines.push("model_provider = \"custom\"".to_string());
    }
    if !model.is_empty() {
        lines.push(format!(
            "model = {}",
            serde_json::to_string(&model).unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    if !reasoning_effort.is_empty() {
        lines.push(format!(
            "model_reasoning_effort = {}",
            serde_json::to_string(&reasoning_effort).unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    if !base_url.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("[model_providers]".to_string());
        lines.push(String::new());
        lines.push("[model_providers.custom]".to_string());
        lines.push("name = \"custom\"".to_string());
        lines.push("wire_api = \"responses\"".to_string());
        lines.push("requires_openai_auth = true".to_string());
        lines.push(format!(
            "base_url = {}",
            serde_json::to_string(&base_url).unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    if !project_path.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(format!(
            "[projects.{}]",
            serde_json::to_string(project_path).unwrap_or_else(|_| "\"\"".to_string())
        ));
        lines.push("trust_level = \"trusted\"".to_string());
    }

    ensure_trailing_newline(&lines.join("\n"))
}

pub(super) fn materialize_codex_home(
    config: &Value,
    home_dir: &Path,
    project_path: &Path,
) -> Result<(), ServiceRouteError> {
    let codex_dir = home_dir.join(".codex");
    stdfs::create_dir_all(home_dir).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    let _ = stdfs::remove_dir_all(&codex_dir);
    stdfs::create_dir_all(&codex_dir).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    let normalized = normalize_codex_config_value(config);
    let config_toml = build_codex_config_toml(
        &Value::Object(normalized.clone()),
        &path_to_string(project_path),
    );
    stdfs::write(codex_dir.join("config.toml"), config_toml).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    let auth_json = value_string(normalized.get("AUTH_JSON"));
    let openai_api_key = value_string(normalized.get("OPENAI_API_KEY"));
    let auth_file = codex_dir.join("auth.json");
    if !auth_json.is_empty() {
        stdfs::write(auth_file, ensure_trailing_newline(&auth_json)).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    } else if !openai_api_key.is_empty() {
        let content = serde_json::to_string_pretty(&json!({ "OPENAI_API_KEY": openai_api_key }))
            .unwrap_or_else(|_| "{}".to_string());
        stdfs::write(auth_file, format!("{content}\n")).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    } else {
        let _ = stdfs::remove_file(auth_file);
    }
    Ok(())
}

pub(super) enum CommandRunError {
    Timeout,
    Io(String),
}

pub(super) struct CommandRunResult {
    pub(super) status: i32,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

pub(super) fn resolve_codex_executable() -> String {
    match std::process::Command::new("bash")
        .args(["-lc", "which -a codex | tail -1"])
        .output()
    {
        Ok(output) if output.status.success() => {
            let executable = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if executable.is_empty() {
                "codex".to_string()
            } else {
                executable
            }
        }
        _ => "codex".to_string(),
    }
}

pub(super) async fn run_command_with_timeout(
    executable: &str,
    args: &[String],
    home_dir: &Path,
    proxy_vars: &[(String, String)],
    timeout_ms: u64,
) -> Result<CommandRunResult, CommandRunError> {
    let mut command = Command::new(executable);
    command.args(args);
    command.env("HOME", home_dir);
    command.env_remove("HOST");
    for (key, value) in proxy_vars {
        command.env(key, value);
    }
    let output = timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| CommandRunError::Timeout)?
        .map_err(|error| CommandRunError::Io(error.to_string()))?;

    Ok(CommandRunResult {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

pub(super) fn summarize_command_success(result: &CommandRunResult) -> String {
    let stdout = result.stdout.trim();
    let stderr = result.stderr.trim();
    if !stdout.is_empty() {
        stdout.to_string()
    } else if !stderr.is_empty() {
        stderr.to_string()
    } else {
        "OK".to_string()
    }
}

pub(super) fn summarize_command_failure(result: &CommandRunResult) -> String {
    let stderr = result.stderr.trim();
    let stdout = result.stdout.trim();
    let source = if !stderr.is_empty() { stderr } else { stdout };
    let lines = source.lines().collect::<Vec<_>>();
    if !lines.is_empty() {
        let start = lines.len().saturating_sub(8);
        lines[start..].join("\n")
    } else {
        format!("codex exited with status {}", result.status)
    }
}

pub(super) fn codex_timeout_message(step: &str, timeout_ms: u64) -> String {
    format!("codex {step} timed out after {}s", timeout_ms / 1000)
}

pub(super) fn unique_validation_home(
    codex_validate_dir: &Path,
) -> Result<PathBuf, ServiceRouteError> {
    stdfs::create_dir_all(codex_validate_dir).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let path = codex_validate_dir.join(format!("validate-{pid}-{nanos}"));
    stdfs::create_dir_all(&path).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    Ok(path)
}

pub(super) async fn validate_codex_config_route(
    configs_dir: &Path,
    codex_validate_dir: &Path,
    project_path: &Path,
    id: &str,
    proxy_vars: &[(String, String)],
) -> Result<Value, ServiceRouteError> {
    let config = read_codex_config(configs_dir, id).ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "config not found")
    })?;
    let temp_home = unique_validation_home(codex_validate_dir)?;
    let output_file = temp_home.join("last-message.txt");
    let executable = resolve_codex_executable();

    let validation_result = async {
        let validation_config = build_codex_validation_config(&config);
        let auth_mode = detect_codex_auth_mode(&validation_config);
        let normalized = normalize_codex_config_value(&validation_config);
        let requires_exec_validation = auth_mode != "chatgpt"
            || !value_string(normalized.get("OPENAI_API_KEY")).is_empty()
            || !value_string(normalized.get("BASE_URL")).is_empty();

        materialize_codex_home(&validation_config, &temp_home, project_path)?;

        let login_status = run_command_with_timeout(
            &executable,
            &["login".to_string(), "status".to_string()],
            &temp_home,
            proxy_vars,
            CODEX_LOGIN_STATUS_TIMEOUT_MS,
        )
        .await
        .map_err(|error| match error {
            CommandRunError::Timeout => ServiceRouteError {
                status_code: StatusCode::GATEWAY_TIMEOUT,
                body: json!({
                    "ok": false,
                    "error": codex_timeout_message("login status", CODEX_LOGIN_STATUS_TIMEOUT_MS),
                }),
            },
            CommandRunError::Io(message) => ServiceRouteError {
                status_code: StatusCode::INTERNAL_SERVER_ERROR,
                body: json!({
                    "ok": false,
                    "error": message,
                }),
            },
        })?;

        if login_status.status != 0 {
            return Err(ServiceRouteError {
                status_code: StatusCode::BAD_REQUEST,
                body: json!({
                    "ok": false,
                    "error": summarize_command_failure(&login_status),
                }),
            });
        }

        let login_message = summarize_command_success(&login_status);
        if !requires_exec_validation {
            return Ok(json!({
                "ok": true,
                "message": if login_message.is_empty() {
                    "Logged in using ChatGPT".to_string()
                } else {
                    login_message
                },
            }));
        }

        let exec_args = vec![
            "exec".to_string(),
            "--skip-git-repo-check".to_string(),
            "--ephemeral".to_string(),
            "--dangerously-bypass-approvals-and-sandbox".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "-C".to_string(),
            path_to_string(project_path),
            "-o".to_string(),
            path_to_string(&output_file),
            "Reply with EXACTLY: OK".to_string(),
        ];
        let exec_result = run_command_with_timeout(
            &executable,
            &exec_args,
            &temp_home,
            proxy_vars,
            CODEX_EXEC_VALIDATE_TIMEOUT_MS,
        )
        .await
        .map_err(|error| match error {
            CommandRunError::Timeout => ServiceRouteError {
                status_code: StatusCode::GATEWAY_TIMEOUT,
                body: json!({
                    "ok": false,
                    "error": codex_timeout_message("exec validation", CODEX_EXEC_VALIDATE_TIMEOUT_MS),
                }),
            },
            CommandRunError::Io(message) => ServiceRouteError {
                status_code: StatusCode::INTERNAL_SERVER_ERROR,
                body: json!({
                    "ok": false,
                    "error": message,
                }),
            },
        })?;

        if exec_result.status != 0 {
            return Err(ServiceRouteError {
                status_code: StatusCode::BAD_REQUEST,
                body: json!({
                    "ok": false,
                    "error": summarize_command_failure(&exec_result),
                }),
            });
        }

        let message = stdfs::read_to_string(&output_file)
            .unwrap_or_else(|_| "OK".to_string())
            .trim()
            .to_string();
        Ok(json!({
            "ok": true,
            "message": if message.is_empty() { "OK".to_string() } else { message },
        }))
    }
    .await;

    let _ = stdfs::remove_dir_all(&temp_home);
    validation_result
}

pub(super) fn delete_codex_config_route(
    configs_dir: &Path,
    id: &str,
) -> Result<Value, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if file_path.exists() {
        stdfs::remove_file(file_path).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    }
    Ok(json!({ "ok": true }))
}

#[derive(Clone)]
pub(super) struct CcSwitchProviderRow {
    pub(super) id: String,
    pub(super) app_type: String,
    pub(super) name: String,
    pub(super) settings_config: String,
    pub(super) is_current: bool,
}

pub(super) fn ensure_cc_switch_kind(kind: &str) -> Result<(), ServiceRouteError> {
    if kind == "claude" || kind == "codex" {
        Ok(())
    } else {
        Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid kind",
        ))
    }
}

pub(super) fn resolve_cc_switch_db_path() -> Option<PathBuf> {
    let home_dir = env::var("HOME").ok()?;
    Some(Path::new(&home_dir).join(".cc-switch").join("cc-switch.db"))
}

pub(super) fn open_cc_switch_db() -> Result<Option<Connection>, ServiceRouteError> {
    let Some(db_path) = resolve_cc_switch_db_path() else {
        return Ok(None);
    };
    if !db_path.exists() {
        return Ok(None);
    }
    Connection::open(db_path).map(Some).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })
}

pub(super) fn load_cc_switch_provider_rows(
    connection: &Connection,
    kind: &str,
) -> Result<Vec<CcSwitchProviderRow>, ServiceRouteError> {
    let mut statement = connection
        .prepare(
            "
            SELECT id, app_type, name, settings_config, is_current
            FROM providers
            WHERE app_type = ?
            ORDER BY is_current DESC, name ASC, id ASC
            ",
        )
        .map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    let rows = statement
        .query_map([kind], |row| {
            Ok(CcSwitchProviderRow {
                id: row.get::<_, String>(0)?,
                app_type: row.get::<_, String>(1)?,
                name: row.get::<_, String>(2)?,
                settings_config: row.get::<_, String>(3)?,
                is_current: row.get::<_, bool>(4)?,
            })
        })
        .map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })
}

pub(super) fn load_cc_switch_provider_row(
    connection: &Connection,
    kind: &str,
    provider_id: &str,
) -> Result<Option<CcSwitchProviderRow>, ServiceRouteError> {
    let mut statement = connection
        .prepare(
            "
            SELECT id, app_type, name, settings_config, is_current
            FROM providers
            WHERE app_type = ? AND id = ?
            LIMIT 1
            ",
        )
        .map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    let mut rows = statement.query([kind, provider_id]).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    match rows.next().map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })? {
        Some(row) => Ok(Some(CcSwitchProviderRow {
            id: row.get::<_, String>(0).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            app_type: row.get::<_, String>(1).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            name: row.get::<_, String>(2).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            settings_config: row.get::<_, String>(3).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            is_current: row.get::<_, bool>(4).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
        })),
        None => Ok(None),
    }
}

pub(super) fn existing_profile_match(
    existing_profiles: &[Value],
    provider_id: &str,
) -> Option<String> {
    existing_profiles
        .iter()
        .find(|profile| {
            let profile_object = object_value(profile);
            value_string(profile_object.get("SYNC_SOURCE")) == CC_SWITCH_SYNC_SOURCE
                && value_string(profile_object.get("SYNC_SOURCE_ID")) == provider_id
        })
        .and_then(|profile| {
            let profile_object = object_value(profile);
            profile_object
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

pub(super) fn resolve_cc_switch_target_profile_id(
    existing_profiles: &[Value],
    provider_id: &str,
    provider_name: &str,
) -> String {
    if let Some(existing_id) = existing_profile_match(existing_profiles, provider_id) {
        return existing_id;
    }

    let base = sanitize_profile_id(&format!(
        "cc-switch-{}",
        if provider_name.is_empty() {
            provider_id
        } else {
            provider_name
        }
    ));
    let base = if base.is_empty() {
        "cc-switch-provider".to_string()
    } else {
        base
    };
    let existing_ids = existing_profiles
        .iter()
        .filter_map(|profile| {
            let profile_object = object_value(profile);
            profile_object
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let mut next_id = base.clone();
    let mut counter = 1;
    while existing_ids
        .iter()
        .any(|existing_id| existing_id == &next_id)
    {
        next_id = format!("{base}-{counter}");
        counter += 1;
    }
    next_id
}

pub(super) fn summarize_claude_provider(row: &CcSwitchProviderRow) -> (String, String, String) {
    let settings = parse_json_object_from_str(&row.settings_config).unwrap_or_default();
    let env_payload = settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let model = {
        let sonnet = value_string(env_payload.get("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        if sonnet.is_empty() {
            value_string(env_payload.get("ANTHROPIC_MODEL"))
        } else {
            sonnet
        }
    };
    let base_url = value_string(env_payload.get("ANTHROPIC_BASE_URL"));
    let auth_mode = if !value_string(env_payload.get("ANTHROPIC_AUTH_TOKEN")).is_empty() {
        "auth_token".to_string()
    } else if !value_string(env_payload.get("ANTHROPIC_API_KEY")).is_empty() {
        "api_key".to_string()
    } else {
        String::new()
    };
    (model, base_url, auth_mode)
}

pub(super) fn summarize_codex_provider(row: &CcSwitchProviderRow) -> (String, String, String) {
    let settings = parse_json_object_from_str(&row.settings_config).unwrap_or_default();
    let auth_payload = settings
        .get("auth")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let parsed_toml = parse_simple_toml(&value_string(settings.get("config")));
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
    let auth_mode = {
        let explicit = value_string(auth_payload.get("auth_mode"));
        if !explicit.is_empty() {
            explicit
        } else if !value_string(auth_payload.get("OPENAI_API_KEY")).is_empty() {
            "api_key".to_string()
        } else {
            String::new()
        }
    };
    (
        parsed_toml.root.get("model").cloned().unwrap_or_default(),
        provider_section
            .get("base_url")
            .cloned()
            .unwrap_or_default(),
        auth_mode,
    )
}

pub(super) fn import_cc_switch_provider_value(row: &CcSwitchProviderRow) -> Value {
    let settings = parse_json_object_from_str(&row.settings_config).unwrap_or_default();
    let env_payload = settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let claude_default_model = {
        let sonnet = value_string(env_payload.get("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        if sonnet.is_empty() {
            value_string(env_payload.get("ANTHROPIC_MODEL"))
        } else {
            sonnet
        }
    };
    let claude_think_model = {
        let opus = value_string(env_payload.get("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        if opus.is_empty() {
            value_string(env_payload.get("ANTHROPIC_THINK_MODEL"))
        } else {
            opus
        }
    };
    let claude_timeout = {
        let value = value_string(env_payload.get("API_TIMEOUT_MS"));
        if value.is_empty() {
            "3000000".to_string()
        } else {
            value
        }
    };
    let mut imported = if row.app_type == "claude" {
        object_value(&json!({
            "label": "Imported from ~/.claude/settings.json",
            "BASE_URL": value_string(env_payload.get("ANTHROPIC_BASE_URL")),
            "AUTH_TOKEN": value_string(env_payload.get("ANTHROPIC_AUTH_TOKEN")),
            "API_KEY": value_string(env_payload.get("ANTHROPIC_API_KEY")),
            "DEFAULT_MODEL": claude_default_model,
            "THINK_MODEL": claude_think_model,
            "LONG_CONTEXT_MODEL": value_string(env_payload.get("ANTHROPIC_LONG_CONTEXT_MODEL")),
            "DEFAULT_HAIKU_MODEL": value_string(env_payload.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")),
            "API_TIMEOUT_MS": claude_timeout,
        }))
    } else {
        object_value(&import_codex_config_from_global(
            &value_string(settings.get("config")),
            &serde_json::to_string_pretty(
                &settings.get("auth").cloned().unwrap_or_else(|| json!({})),
            )
            .unwrap_or_else(|_| "{}".to_string()),
        ))
    };
    imported.insert(
        "label".to_string(),
        Value::String(if row.name.trim().is_empty() {
            row.id.clone()
        } else {
            row.name.trim().to_string()
        }),
    );
    imported.insert(
        "SYNC_SOURCE".to_string(),
        Value::String(CC_SWITCH_SYNC_SOURCE.to_string()),
    );
    imported.insert("SYNC_SOURCE_ID".to_string(), Value::String(row.id.clone()));
    imported.insert(
        "SYNC_SOURCE_NAME".to_string(),
        Value::String(row.name.trim().to_string()),
    );
    Value::Object(imported)
}

pub(super) fn list_cc_switch_providers_route(
    configs_dir: &Path,
    codex_configs_dir: &Path,
    kind: &str,
) -> Result<Value, ServiceRouteError> {
    ensure_cc_switch_kind(kind)?;
    let existing_profiles = if kind == "claude" {
        match list_claude_configs(configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    } else {
        match list_codex_configs(codex_configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    };
    let Some(connection) = open_cc_switch_db()? else {
        return Ok(Value::Array(Vec::new()));
    };
    let rows = load_cc_switch_provider_rows(&connection, kind)?;
    let providers = rows
        .into_iter()
        .map(|row| {
            let (model, base_url, auth_mode) = if kind == "claude" {
                summarize_claude_provider(&row)
            } else {
                summarize_codex_provider(&row)
            };
            let existing_profile_id = existing_profile_match(&existing_profiles, &row.id);
            let target_profile_id =
                resolve_cc_switch_target_profile_id(&existing_profiles, &row.id, &row.name);
            json!({
                "provider_id": row.id,
                "kind": kind,
                "name": if row.name.trim().is_empty() { row.id } else { row.name },
                "is_current": row.is_current,
                "model": model,
                "base_url": base_url,
                "auth_mode": auth_mode,
                "existing_profile_id": existing_profile_id,
                "target_profile_id": target_profile_id,
            })
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(providers))
}

pub(super) fn import_cc_switch_provider_route(
    configs_dir: &Path,
    codex_configs_dir: &Path,
    kind: &str,
    provider_id: &str,
) -> Result<Value, ServiceRouteError> {
    ensure_cc_switch_kind(kind)?;
    let existing_profiles = if kind == "claude" {
        match list_claude_configs(configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    } else {
        match list_codex_configs(codex_configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    };
    let Some(connection) = open_cc_switch_db()? else {
        return Err(ServiceRouteError::from_message(
            StatusCode::NOT_FOUND,
            "provider not found",
        ));
    };
    let row = load_cc_switch_provider_row(&connection, kind, provider_id)?.ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "provider not found")
    })?;
    let imported = import_cc_switch_provider_value(&row);
    let target_id = resolve_cc_switch_target_profile_id(&existing_profiles, &row.id, &row.name);

    if kind == "claude" {
        let (saved_id, saved_config) =
            save_stored_claude_config(configs_dir, &target_id, imported)?;
        Ok(json!({
            "ok": true,
            "id": saved_id,
            "config": saved_config,
        }))
    } else {
        let (saved_id, saved_config) =
            save_codex_config_with_metadata(codex_configs_dir, &target_id, imported)?;
        Ok(json!({
            "ok": true,
            "id": saved_id,
            "config": saved_config,
        }))
    }
}

pub(super) async fn static_fallback(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
) -> Response {
    if uri.path().starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }

    if method != Method::GET && method != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }

    if uri.path() == "/" {
        return serve_index(&state).await;
    }

    if let Some(path) = state.find_static_file(uri.path()) {
        return serve_file(path).await;
    }

    serve_index(&state).await
}

pub(super) struct UploadMultipartPayload {
    pub(super) session_name: Option<String>,
    pub(super) original_name: Option<String>,
    pub(super) file: Option<UploadMultipartFile>,
}

pub(super) struct UploadMultipartFile {
    pub(super) original_name: String,
    pub(super) bytes: Vec<u8>,
    pub(super) size: usize,
}

pub(super) struct ServiceRouteError {
    pub(super) status_code: StatusCode,
    pub(super) body: Value,
}

impl ServiceRouteError {
    pub(super) fn from_message(status_code: StatusCode, message: &str) -> Self {
        Self {
            status_code,
            body: json!({ "error": message }),
        }
    }
}

pub(super) async fn current_version_payload(project_root: &Path) -> Value {
    let describe_output = Command::new("git")
        .args(["describe", "--tags", "--abbrev=0"])
        .current_dir(project_root)
        .output()
        .await;
    let Ok(describe_output) = describe_output else {
        return json!({ "current": "unknown", "clean": true });
    };
    if !describe_output.status.success() {
        return json!({ "current": "unknown", "clean": true });
    }

    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_root)
        .output()
        .await;
    let Ok(status_output) = status_output else {
        return json!({ "current": "unknown", "clean": true });
    };
    if !status_output.status.success() {
        return json!({ "current": "unknown", "clean": true });
    }

    json!({
        "current": String::from_utf8_lossy(&describe_output.stdout).trim().to_string(),
        "clean": String::from_utf8_lossy(&status_output.stdout).trim().is_empty(),
    })
}
