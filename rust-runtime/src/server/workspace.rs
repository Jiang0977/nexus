use super::*;

pub(super) async fn api_browse(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        browse_workspace_directories(state.workspace_root.as_ref(), query.path.as_deref()).await,
    )
}

pub(super) async fn api_workspace_entries(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        list_workspace_entries(state.workspace_root.as_ref(), query.path.as_deref()).await,
    )
}

pub(super) async fn api_workspace_mkdir(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceCreateEntryBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        create_workspace_directory(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.name.as_deref(),
        )
        .await,
    )
}

pub(super) async fn api_workspace_create_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceCreateEntryBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        create_workspace_file(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.name.as_deref(),
            body.content.as_deref().unwrap_or(""),
        )
        .await,
    )
}

pub(super) async fn api_workspace_read_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        read_workspace_file_content(state.workspace_root.as_ref(), query.path.as_deref()).await,
    )
}

pub(super) async fn api_workspace_write_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceWriteFileBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        write_workspace_file_content(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.content.as_deref().unwrap_or(""),
        )
        .await,
    )
}

pub(super) async fn api_workspace_delete_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
    body: Option<Json<WorkspaceDeleteBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let path = body
        .and_then(|Json(payload)| payload.path)
        .or(query.path)
        .unwrap_or_default();
    workspace_json_response(delete_workspace_entry(state.workspace_root.as_ref(), &path).await)
}

pub(super) async fn api_workspace_rename_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceRenameBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        rename_workspace_entry(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.new_name.as_deref(),
        )
        .await,
    )
}

pub(super) async fn api_workspace_copy_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceTransferBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        copy_workspace_entry(
            state.workspace_root.as_ref(),
            body.source_path.as_deref(),
            body.target_path.as_deref(),
        )
        .await,
    )
}

pub(super) async fn api_workspace_move_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceTransferBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        move_workspace_entry(
            state.workspace_root.as_ref(),
            body.source_path.as_deref(),
            body.target_path.as_deref(),
        )
        .await,
    )
}

pub(super) async fn api_workspace_file_root(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceServeQuery>,
) -> Response {
    serve_workspace_file_response(state, headers, query, "").await
}

pub(super) async fn api_workspace_file_path(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceServeQuery>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    serve_workspace_file_response(state, headers, query, &path).await
}

pub(super) async fn api_upload_workspace_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let payload = match parse_upload_multipart(multipart).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let Some(file) = payload.file else {
        return json_error(StatusCode::BAD_REQUEST, "no file");
    };
    let destination =
        resolve_workspace_upload_destination(&state, payload.session_name.as_deref()).await;
    let file_name = sanitize_workspace_upload_filename(&file.original_name);
    let file_path = PathBuf::from(&destination).join(&file_name);

    if let Err(error) = fs::create_dir_all(&destination).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
    }
    if let Err(error) = fs::write(&file_path, &file.bytes).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
    }

    Json(json!({
        "ok": true,
        "path": file_path.to_string_lossy().to_string(),
        "filename": file_name,
        "size": file.size,
    }))
    .into_response()
}

pub(super) async fn api_upload_managed_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<OverwriteQuery>,
    multipart: Multipart,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let payload = match parse_upload_multipart(multipart).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let Some(file) = payload.file else {
        return json_error(StatusCode::BAD_REQUEST, "no file");
    };

    match save_managed_upload_file(
        state.uploads_dir.as_ref(),
        &file.bytes,
        &file.original_name,
        payload.original_name.as_deref(),
        file.size,
        query.overwrite.as_deref() == Some("1"),
    )
    .await
    {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

pub(super) async fn api_files(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match list_managed_files(state.uploads_dir.as_ref()).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

pub(super) async fn api_delete_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((date, filename)): AxumPath<(String, String)>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match delete_managed_file(state.uploads_dir.as_ref(), &date, &filename).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

pub(super) async fn api_delete_all_files(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match delete_all_managed_files(state.uploads_dir.as_ref()).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

pub(super) async fn static_uploads(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    let Some(safe_path) = sanitize_request_path(&path) else {
        return json_error(StatusCode::NOT_FOUND, "not found");
    };
    let full_path = state.uploads_dir.join(safe_path);
    if !full_path.starts_with(state.uploads_dir.as_ref()) || !full_path.is_file() {
        return json_error(StatusCode::NOT_FOUND, "not found");
    }
    serve_file(full_path).await
}

pub(super) struct WorkspaceRouteError {
    pub(super) status_code: StatusCode,
    pub(super) message: String,
}

impl WorkspaceRouteError {
    pub(super) fn new(status_code: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status_code,
            message: message.into(),
        }
    }
}

pub(super) fn workspace_json_response(result: Result<Value, WorkspaceRouteError>) -> Response {
    match result {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_error(error.status_code, &error.message),
    }
}

pub(super) async fn serve_workspace_file_response(
    state: Arc<AppState>,
    headers: HeaderMap,
    query: WorkspaceServeQuery,
    request_path: &str,
) -> Response {
    if let Some(response) = require_workspace_auth(&headers, query.token.as_deref(), &state) {
        return response;
    }

    match resolve_workspace_serve_file_path(
        state.workspace_root.as_ref(),
        query.path.as_deref(),
        request_path,
    )
    .await
    {
        Ok(full_path) => {
            let mut response = serve_file(full_path.clone()).await;
            if response.status() == StatusCode::OK
                && query.dl.as_deref() == Some("1")
                && let Some(file_name) = full_path.file_name().and_then(|value| value.to_str())
                && let Ok(header_value) = HeaderValue::from_str(&format!(
                    "attachment; filename*=UTF-8''{}",
                    percent_encode_utf8(file_name)
                ))
            {
                response
                    .headers_mut()
                    .insert(CONTENT_DISPOSITION, header_value);
            }
            response
        }
        Err(error) => (error.status_code, error.message).into_response(),
    }
}

pub(super) async fn browse_workspace_directories(
    workspace_root: &str,
    path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let mut dirs = Vec::new();
    let mut entries = fs::read_dir(&resolved_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    while let Some(entry) = entries.next_entry().await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })? {
        let file_type = entry.file_type().await.map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        dirs.push(json!({
            "name": name,
            "path": path_to_string(&entry.path()),
        }));
    }

    dirs.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .cmp(&right.get("name").and_then(Value::as_str))
    });

    Ok(json!({
        "path": path_to_string(&resolved_path),
        "parent": resolved_path.parent().map(path_to_string),
        "dirs": dirs,
    }))
}

pub(super) async fn list_workspace_entries(
    workspace_root: &str,
    path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let mut entries = Vec::new();
    let mut read_dir = fs::read_dir(&resolved_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let file_type = entry.file_type().await.map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
        let metadata = entry.metadata().await.map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
        let mut payload = serde_json::Map::new();
        payload.insert("name".to_string(), Value::String(name));
        payload.insert(
            "type".to_string(),
            Value::String(if file_type.is_dir() {
                "dir".to_string()
            } else {
                "file".to_string()
            }),
        );
        if file_type.is_file() {
            payload.insert("size".to_string(), Value::from(metadata.len()));
        }
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        payload.insert("mtime".to_string(), Value::from(mtime));
        entries.push(Value::Object(payload));
    }

    entries.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .cmp(&right.get("name").and_then(Value::as_str))
    });

    Ok(json!({
        "path": path_to_string(&resolved_path),
        "entries": entries,
    }))
}

pub(super) async fn create_workspace_directory(
    workspace_root: &str,
    path: Option<&str>,
    name: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(name) = name.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "name required",
        ));
    };
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let dir_path = normalize_path_lexically(&resolved_path.join(name));
    if path_contains_parent_marker(&dir_path) {
        return Err(WorkspaceRouteError::new(
            StatusCode::FORBIDDEN,
            "invalid path",
        ));
    }
    if fs::metadata(&dir_path).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "already exists",
        ));
    }

    fs::create_dir_all(&dir_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&dir_path),
    }))
}

pub(super) async fn create_workspace_file(
    workspace_root: &str,
    path: Option<&str>,
    name: Option<&str>,
    content: &str,
) -> Result<Value, WorkspaceRouteError> {
    let Some(name) = name.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "name required",
        ));
    };
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let file_path = normalize_path_lexically(&resolved_path.join(name));
    if path_contains_parent_marker(&file_path) {
        return Err(WorkspaceRouteError::new(
            StatusCode::FORBIDDEN,
            "invalid path",
        ));
    }
    if fs::metadata(&file_path).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "already exists",
        ));
    }

    fs::write(&file_path, content).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&file_path),
    }))
}

pub(super) async fn read_workspace_file_content(
    workspace_root: &str,
    path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, false)?;
    let metadata = fs::metadata(&resolved_path)
        .await
        .map_err(|_| WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"))?;
    if !metadata.is_file() {
        return Err(WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"));
    }

    let content = fs::read_to_string(&resolved_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "path": path_to_string(&resolved_path),
        "content": content,
    }))
}

pub(super) async fn write_workspace_file_content(
    workspace_root: &str,
    path: Option<&str>,
    content: &str,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, false)?;
    fs::write(&resolved_path, content).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&resolved_path),
    }))
}

pub(super) async fn delete_workspace_entry(
    workspace_root: &str,
    path: &str,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, Some(path), false)?;
    let metadata = fs::metadata(&resolved_path)
        .await
        .map_err(|_| WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"))?;

    let result = if metadata.is_dir() {
        fs::remove_dir_all(&resolved_path).await
    } else {
        fs::remove_file(&resolved_path).await
    };
    result.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    Ok(json!({ "ok": true }))
}

pub(super) async fn rename_workspace_entry(
    workspace_root: &str,
    path: Option<&str>,
    new_name: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(source_path) = path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "path and newName required",
        ));
    };
    let Some(new_name) = new_name.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "path and newName required",
        ));
    };
    let resolved_source = resolve_workspace_input_path(workspace_root, Some(source_path), false)?;
    if fs::metadata(&resolved_source).await.is_err() {
        return Err(WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"));
    }

    let parent = resolved_source
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);
    let dest_path = normalize_path_lexically(&parent.join(new_name));
    if path_contains_parent_marker(&dest_path) {
        return Err(WorkspaceRouteError::new(
            StatusCode::FORBIDDEN,
            "invalid newName",
        ));
    }
    if fs::metadata(&dest_path).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "already exists",
        ));
    }

    fs::rename(&resolved_source, &dest_path)
        .await
        .map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&dest_path),
    }))
}

pub(super) async fn copy_workspace_entry(
    workspace_root: &str,
    source_path: Option<&str>,
    target_path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(source_path) = source_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let Some(target_path) = target_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let resolved_source = resolve_workspace_input_path(workspace_root, Some(source_path), false)?;
    let resolved_target = resolve_workspace_input_path(workspace_root, Some(target_path), false)?;

    if fs::metadata(&resolved_source).await.is_err() {
        return Err(WorkspaceRouteError::new(
            StatusCode::NOT_FOUND,
            "source not found",
        ));
    }
    if fs::metadata(&resolved_target).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "target already exists",
        ));
    }

    copy_path_recursive_sync(&resolved_source, &resolved_target)
        .map_err(|error| WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&resolved_target),
    }))
}

pub(super) async fn move_workspace_entry(
    workspace_root: &str,
    source_path: Option<&str>,
    target_path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(source_path) = source_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let Some(target_path) = target_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let resolved_source = resolve_workspace_input_path(workspace_root, Some(source_path), false)?;
    let resolved_target = resolve_workspace_input_path(workspace_root, Some(target_path), false)?;

    if fs::metadata(&resolved_source).await.is_err() {
        return Err(WorkspaceRouteError::new(
            StatusCode::NOT_FOUND,
            "source not found",
        ));
    }
    if fs::metadata(&resolved_target).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "target already exists",
        ));
    }

    match stdfs::rename(&resolved_source, &resolved_target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_path_recursive_sync(&resolved_source, &resolved_target).map_err(|copy_error| {
                WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, copy_error)
            })?;
            remove_path_recursive_sync(&resolved_source).map_err(|remove_error| {
                WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, remove_error)
            })?;
        }
        Err(error) => {
            return Err(WorkspaceRouteError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            ));
        }
    }

    Ok(json!({
        "ok": true,
        "path": path_to_string(&resolved_target),
    }))
}

pub(super) async fn parse_upload_multipart(
    mut multipart: Multipart,
) -> Result<UploadMultipartPayload, Response> {
    let mut payload = UploadMultipartPayload {
        session_name: None,
        original_name: None,
        file: None,
    };

    loop {
        let next_field = multipart.next_field().await;
        let field = match next_field {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string())),
        };

        let field_name = field.name().unwrap_or_default().to_string();
        match field_name.as_str() {
            "session_name" => {
                let value = match field.text().await {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                    }
                };
                payload.session_name = Some(value);
            }
            "originalName" => {
                let value = match field.text().await {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                    }
                };
                payload.original_name = Some(value);
            }
            "file" => {
                let original_name = field.file_name().unwrap_or("upload.bin").to_string();
                let bytes = match field.bytes().await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                    }
                };
                payload.file = Some(UploadMultipartFile {
                    original_name,
                    size: bytes.len(),
                    bytes: bytes.to_vec(),
                });
            }
            _ => {
                if let Err(error) = field.bytes().await {
                    return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                }
            }
        }
    }

    Ok(payload)
}

pub(super) async fn resolve_workspace_upload_destination(
    state: &AppState,
    session_name: Option<&str>,
) -> String {
    let workspace_root = state.workspace_root.as_ref().clone();
    let session_name = session_name.unwrap_or_default().trim().to_string();
    let runtime_result = state
        .runtime_manager
        .session_management_request(
            "listProjectChannels",
            json!({ "projectName": state.default_tmux_session.as_ref() }),
        )
        .await;

    let candidate = match runtime_result {
        Ok(Value::Object(payload)) => payload
            .get("channels")
            .and_then(Value::as_array)
            .and_then(|channels| {
                if !session_name.is_empty() {
                    channels.iter().find_map(|channel| {
                        let name = channel.get("name").and_then(Value::as_str)?;
                        if name != session_name {
                            return None;
                        }
                        channel
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                } else {
                    channels.iter().find_map(|channel| {
                        if channel.get("active").and_then(Value::as_bool) != Some(true) {
                            return None;
                        }
                        channel
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                }
            })
            .unwrap_or_else(|| workspace_root.clone()),
        _ => workspace_root.clone(),
    };

    if Path::new(&candidate).is_dir() {
        candidate
    } else {
        workspace_root
    }
}

pub(super) async fn save_managed_upload_file(
    uploads_dir: &Path,
    file_buffer: &[u8],
    original_name: &str,
    preferred_name: Option<&str>,
    size: usize,
    overwrite: bool,
) -> Result<Value, ServiceRouteError> {
    let date_dir = Utc::now().format("%Y-%m-%d").to_string();
    let upload_dir = uploads_dir.join(&date_dir);
    fs::create_dir_all(&upload_dir).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    let resolved_original_name = preferred_name.unwrap_or(original_name);
    let safe_name = sanitize_managed_upload_filename(resolved_original_name);
    let file_path = upload_dir.join(&safe_name);

    if !overwrite && file_path.is_file() {
        return Err(ServiceRouteError {
            status_code: StatusCode::CONFLICT,
            body: json!({
                "error": "file exists",
                "filename": safe_name,
                "message": format!("文件 \"{}\" 已存在", safe_name),
            }),
        });
    }

    fs::write(&file_path, file_buffer).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    Ok(json!({
        "ok": true,
        "filename": safe_name,
        "url": format!("/uploads/{date_dir}/{}", safe_name),
        "fullPath": file_path.to_string_lossy().to_string(),
        "size": size,
        "originalName": resolved_original_name,
    }))
}

pub(super) async fn list_managed_files(uploads_dir: &Path) -> Result<Value, ServiceRouteError> {
    let mut date_dirs = Vec::new();
    let mut root_entries = fs::read_dir(uploads_dir).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    while let Some(entry) = root_entries.next_entry().await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })? {
        let file_type = entry.file_type().await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
        if file_type.is_dir() {
            date_dirs.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    date_dirs.sort_by(|left, right| right.cmp(left));

    let mut groups = Vec::new();
    for date_dir in date_dirs {
        let dir_path = uploads_dir.join(&date_dir);
        let mut file_entries = fs::read_dir(&dir_path).await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
        let mut files = Vec::new();

        while let Some(entry) = file_entries.next_entry().await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })? {
            let file_type = entry.file_type().await.map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?;
            if !file_type.is_file() {
                continue;
            }

            let full_path = dir_path.join(entry.file_name());
            let metadata = entry.metadata().await.map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);

            files.push(json!({
                "name": entry.file_name().to_string_lossy().to_string(),
                "url": format!("/uploads/{date_dir}/{}", entry.file_name().to_string_lossy()),
                "fullPath": full_path.to_string_lossy().to_string(),
                "size": metadata.len(),
                "created": modified,
            }));
        }

        files.sort_by(|left, right| {
            right
                .get("created")
                .and_then(Value::as_u64)
                .cmp(&left.get("created").and_then(Value::as_u64))
        });
        if !files.is_empty() {
            groups.push(json!({
                "date": date_dir,
                "files": files,
            }));
        }
    }

    Ok(Value::Array(groups))
}

pub(super) async fn delete_managed_file(
    uploads_dir: &Path,
    date: &str,
    filename: &str,
) -> Result<Value, ServiceRouteError> {
    let safe_date: String = date
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '-')
        .collect();
    let safe_filename = sanitize_workspace_upload_filename(filename);
    let file_path = uploads_dir.join(&safe_date).join(&safe_filename);

    if !file_path.starts_with(uploads_dir) {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid path",
        ));
    }
    if !file_path.is_file() {
        return Err(ServiceRouteError::from_message(
            StatusCode::NOT_FOUND,
            "file not found",
        ));
    }

    fs::remove_file(&file_path).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    Ok(json!({ "ok": true }))
}

pub(super) async fn delete_all_managed_files(
    uploads_dir: &Path,
) -> Result<Value, ServiceRouteError> {
    let mut root_entries = fs::read_dir(uploads_dir).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    let mut deleted_count = 0_u64;

    while let Some(entry) = root_entries.next_entry().await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })? {
        let file_type = entry.file_type().await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
        if !file_type.is_dir() {
            continue;
        }

        let dir_path = entry.path();
        let mut files = match fs::read_dir(&dir_path).await {
            Ok(files) => files,
            Err(_) => continue,
        };

        while let Ok(Some(file)) = files.next_entry().await {
            let file_type = match file.file_type().await {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_file() {
                continue;
            }
            if fs::remove_file(file.path()).await.is_ok() {
                deleted_count += 1;
            }
        }

        let _ = fs::remove_dir(&dir_path).await;
    }

    Ok(json!({
        "ok": true,
        "deletedCount": deleted_count,
    }))
}
