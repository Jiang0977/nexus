use super::*;
use std::collections::{HashMap, HashSet};

const PROMPT_LIBRARY_VERSION: u32 = 1;
const MAX_PROMPTS: usize = 500;
const MAX_PROMPT_TITLE_CHARS: usize = 160;
const MAX_PROMPT_CONTENT_CHARS: usize = 200_000;
const MAX_PROMPT_ID_CHARS: usize = 80;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptRecord {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) content: String,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptLibraryFile {
    pub(super) version: u32,
    pub(super) prompts: Vec<PromptRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptInput {
    title: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptOrderInput {
    ids: Vec<String>,
    expected_ids: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum PromptStoreError {
    Invalid(String),
    Conflict(String),
    NotFound,
    Storage(String),
}

impl PromptStoreError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::Invalid(message) | Self::Conflict(message) | Self::Storage(message) => message,
            Self::NotFound => "prompt not found",
        }
    }
}

pub(super) struct PromptStore {
    file_path: PathBuf,
    store_lock: Mutex<()>,
    next_id_counter: AtomicUsize,
    next_write_counter: AtomicUsize,
}

impl PromptStore {
    pub(super) fn new(file_path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            file_path,
            store_lock: Mutex::new(()),
            next_id_counter: AtomicUsize::new(0),
            next_write_counter: AtomicUsize::new(0),
        })
    }

    async fn list(&self) -> Result<PromptLibraryFile, PromptStoreError> {
        let _guard = self.store_lock.lock().await;
        self.load_locked().await
    }

    async fn create(&self, input: PromptInput) -> Result<PromptRecord, PromptStoreError> {
        let (title, content) = validate_prompt_input(input)?;
        let _guard = self.store_lock.lock().await;
        let mut library = self.load_locked().await?;
        if library.prompts.len() >= MAX_PROMPTS {
            return Err(PromptStoreError::Invalid(format!(
                "prompt limit reached ({MAX_PROMPTS})"
            )));
        }

        let timestamp = iso_timestamp_now();
        let prompt = PromptRecord {
            id: self.next_prompt_id(),
            title,
            content,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        library.prompts.insert(0, prompt.clone());
        self.save_locked(&library).await?;
        Ok(prompt)
    }

    async fn update(&self, id: &str, input: PromptInput) -> Result<PromptRecord, PromptStoreError> {
        validate_prompt_id(id).map_err(PromptStoreError::Invalid)?;
        let (title, content) = validate_prompt_input(input)?;
        let _guard = self.store_lock.lock().await;
        let mut library = self.load_locked().await?;
        let Some(prompt) = library.prompts.iter_mut().find(|prompt| prompt.id == id) else {
            return Err(PromptStoreError::NotFound);
        };

        prompt.title = title;
        prompt.content = content;
        prompt.updated_at = iso_timestamp_now();
        let updated = prompt.clone();
        self.save_locked(&library).await?;
        Ok(updated)
    }

    async fn reorder(
        &self,
        input: PromptOrderInput,
    ) -> Result<PromptLibraryFile, PromptStoreError> {
        let requested_ids = validate_prompt_order_ids(&input.ids)?;
        validate_prompt_order_ids(&input.expected_ids)?;

        let _guard = self.store_lock.lock().await;
        let mut library = self.load_locked().await?;
        if !library
            .prompts
            .iter()
            .map(|prompt| prompt.id.as_str())
            .eq(input.expected_ids.iter().map(String::as_str))
        {
            return Err(PromptStoreError::Conflict(
                "prompt library changed; reload before reordering".to_string(),
            ));
        }
        let current_ids = library
            .prompts
            .iter()
            .map(|prompt| prompt.id.as_str())
            .collect::<HashSet<_>>();
        if current_ids.len() != requested_ids.len()
            || !requested_ids.iter().all(|id| current_ids.contains(id))
        {
            return Err(PromptStoreError::Conflict(
                "prompt library changed; reload before reordering".to_string(),
            ));
        }

        if library
            .prompts
            .iter()
            .map(|prompt| prompt.id.as_str())
            .eq(input.ids.iter().map(String::as_str))
        {
            return Ok(library);
        }

        let mut prompts_by_id = library
            .prompts
            .drain(..)
            .map(|prompt| (prompt.id.clone(), prompt))
            .collect::<HashMap<_, _>>();
        library.prompts = input
            .ids
            .iter()
            .map(|id| {
                prompts_by_id
                    .remove(id)
                    .expect("validated prompt order must contain every stored id")
            })
            .collect();
        self.save_locked(&library).await?;
        Ok(library)
    }

    async fn delete(&self, id: &str) -> Result<(), PromptStoreError> {
        validate_prompt_id(id).map_err(PromptStoreError::Invalid)?;
        let _guard = self.store_lock.lock().await;
        let mut library = self.load_locked().await?;
        let original_len = library.prompts.len();
        library.prompts.retain(|prompt| prompt.id != id);
        if library.prompts.len() == original_len {
            return Err(PromptStoreError::NotFound);
        }
        self.save_locked(&library).await
    }

    fn next_prompt_id(&self) -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let counter = self.next_id_counter.fetch_add(1, Ordering::SeqCst);
        format!("prompt_{millis}_{counter}")
    }

    async fn load_locked(&self) -> Result<PromptLibraryFile, PromptStoreError> {
        let raw = match fs::read_to_string(&self.file_path).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(empty_prompt_library());
            }
            Err(error) => {
                return Err(PromptStoreError::Storage(format!(
                    "failed to read prompt library: {error}"
                )));
            }
        };

        let library = serde_json::from_str::<PromptLibraryFile>(&raw).map_err(|error| {
            PromptStoreError::Storage(format!("failed to parse prompt library: {error}"))
        })?;
        validate_stored_library(library)
    }

    async fn save_locked(&self, library: &PromptLibraryFile) -> Result<(), PromptStoreError> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent).await.map_err(|error| {
                PromptStoreError::Storage(format!(
                    "failed to create prompt library directory: {error}"
                ))
            })?;
        }

        let mut content = serde_json::to_string_pretty(library).map_err(|error| {
            PromptStoreError::Storage(format!("failed to serialize prompt library: {error}"))
        })?;
        content.push('\n');

        let tmp_path = self.temporary_file_path();
        let write_result = async {
            let mut tmp_file = fs::File::create(&tmp_path).await.map_err(|error| {
                PromptStoreError::Storage(format!(
                    "failed to create prompt library temporary file: {error}"
                ))
            })?;
            tmp_file
                .write_all(content.as_bytes())
                .await
                .map_err(|error| {
                    PromptStoreError::Storage(format!(
                        "failed to write prompt library temporary file: {error}"
                    ))
                })?;
            tmp_file.flush().await.map_err(|error| {
                PromptStoreError::Storage(format!(
                    "failed to flush prompt library temporary file: {error}"
                ))
            })?;
            tmp_file.sync_all().await.map_err(|error| {
                PromptStoreError::Storage(format!(
                    "failed to sync prompt library temporary file: {error}"
                ))
            })?;
            drop(tmp_file);
            fs::rename(&tmp_path, &self.file_path)
                .await
                .map_err(|error| {
                    PromptStoreError::Storage(format!("failed to replace prompt library: {error}"))
                })
        }
        .await;

        if write_result.is_err() {
            let _ = fs::remove_file(&tmp_path).await;
        }
        write_result
    }

    fn temporary_file_path(&self) -> PathBuf {
        let counter = self.next_write_counter.fetch_add(1, Ordering::SeqCst);
        let file_name = self
            .file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("prompts.json");
        self.file_path.with_file_name(format!(
            "{file_name}.{}.{}.tmp",
            std::process::id(),
            counter
        ))
    }
}

pub(super) async fn api_get_prompt_library(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state.prompt_store.list().await {
        Ok(library) => Json(library).into_response(),
        Err(error) => prompt_store_error_response(error),
    }
}

pub(super) async fn api_create_prompt(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<PromptInput>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state.prompt_store.create(input).await {
        Ok(prompt) => (StatusCode::CREATED, Json(prompt)).into_response(),
        Err(error) => prompt_store_error_response(error),
    }
}

pub(super) async fn api_update_prompt(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<PromptInput>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state.prompt_store.update(&id, input).await {
        Ok(prompt) => Json(prompt).into_response(),
        Err(error) => prompt_store_error_response(error),
    }
}

pub(super) async fn api_reorder_prompt_library(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<PromptOrderInput>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state.prompt_store.reorder(input).await {
        Ok(library) => Json(library).into_response(),
        Err(error) => prompt_store_error_response(error),
    }
}

pub(super) async fn api_delete_prompt(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state.prompt_store.delete(&id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => prompt_store_error_response(error),
    }
}

fn prompt_store_error_response(error: PromptStoreError) -> Response {
    json_error(error.status(), error.message())
}

fn empty_prompt_library() -> PromptLibraryFile {
    PromptLibraryFile {
        version: PROMPT_LIBRARY_VERSION,
        prompts: Vec::new(),
    }
}

fn validate_prompt_input(input: PromptInput) -> Result<(String, String), PromptStoreError> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(PromptStoreError::Invalid(
            "prompt title required".to_string(),
        ));
    }
    if title.chars().count() > MAX_PROMPT_TITLE_CHARS {
        return Err(PromptStoreError::Invalid(format!(
            "prompt title exceeds {MAX_PROMPT_TITLE_CHARS} characters"
        )));
    }
    if input.content.trim().is_empty() {
        return Err(PromptStoreError::Invalid(
            "prompt content required".to_string(),
        ));
    }
    if input.content.chars().count() > MAX_PROMPT_CONTENT_CHARS {
        return Err(PromptStoreError::Invalid(format!(
            "prompt content exceeds {MAX_PROMPT_CONTENT_CHARS} characters"
        )));
    }
    Ok((title, input.content))
}

fn validate_stored_library(
    library: PromptLibraryFile,
) -> Result<PromptLibraryFile, PromptStoreError> {
    if library.version != PROMPT_LIBRARY_VERSION {
        return Err(PromptStoreError::Storage(format!(
            "unsupported prompt library version: {}",
            library.version
        )));
    }
    if library.prompts.len() > MAX_PROMPTS {
        return Err(PromptStoreError::Storage(format!(
            "prompt library exceeds {MAX_PROMPTS} entries"
        )));
    }

    let mut ids = HashSet::new();
    for prompt in &library.prompts {
        validate_stored_prompt(prompt)?;
        if !ids.insert(prompt.id.as_str()) {
            return Err(PromptStoreError::Storage(
                "prompt library contains duplicate ids".to_string(),
            ));
        }
    }
    Ok(library)
}

fn validate_stored_prompt(prompt: &PromptRecord) -> Result<(), PromptStoreError> {
    validate_prompt_id(&prompt.id).map_err(PromptStoreError::Storage)?;
    validate_prompt_input(PromptInput {
        title: prompt.title.clone(),
        content: prompt.content.clone(),
    })
    .map_err(|error| PromptStoreError::Storage(error.message().to_string()))?;
    chrono::DateTime::parse_from_rfc3339(&prompt.created_at)
        .map_err(|_| PromptStoreError::Storage("prompt createdAt must be RFC 3339".to_string()))?;
    chrono::DateTime::parse_from_rfc3339(&prompt.updated_at)
        .map_err(|_| PromptStoreError::Storage("prompt updatedAt must be RFC 3339".to_string()))?;
    Ok(())
}

fn validate_prompt_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.chars().count() > MAX_PROMPT_ID_CHARS
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err("invalid prompt id".to_string());
    }
    Ok(())
}

fn validate_prompt_order_ids(ids: &[String]) -> Result<HashSet<&str>, PromptStoreError> {
    if ids.len() > MAX_PROMPTS {
        return Err(PromptStoreError::Invalid(format!(
            "prompt order exceeds {MAX_PROMPTS} entries"
        )));
    }

    let mut validated = HashSet::with_capacity(ids.len());
    for id in ids {
        validate_prompt_id(id).map_err(PromptStoreError::Invalid)?;
        if !validated.insert(id.as_str()) {
            return Err(PromptStoreError::Invalid(
                "prompt order contains duplicate ids".to_string(),
            ));
        }
    }
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn input(title: &str, content: &str) -> PromptInput {
        PromptInput {
            title: title.to_string(),
            content: content.to_string(),
        }
    }

    fn unconfigured_runtime(display_name: &'static str) -> Arc<ManagedRuntime> {
        Arc::new(ManagedRuntime {
            display_name,
            extra_env: Vec::new(),
            inner: Mutex::new(ManagedRuntimeState {
                ready_timeout: Duration::from_millis(1),
                process: None,
                status: json!({ "ready": false, "source": "test" }),
            }),
        })
    }

    async fn test_state(prompts_file: PathBuf) -> Arc<AppState> {
        let runtime_manager = Arc::new(RuntimeManager {
            pty_broker: unconfigured_runtime("pty broker"),
            window_launch: unconfigured_runtime("window launch"),
            session_management: unconfigured_runtime("session management"),
        });

        Arc::new(AppState {
            jwt_secret: Arc::new("secret".to_string()),
            password_hash: Arc::new("hash".to_string()),
            default_tmux_session: Arc::new("nexus".to_string()),
            session_backend: Arc::new("tmux".to_string()),
            session_backend_config_file: Arc::new(PathBuf::from("/tmp/nexus/session-backend.json")),
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
            workspace_layouts_file: Arc::new(PathBuf::from("/tmp/nexus/workspace-layouts.json")),
            prompt_store: PromptStore::new(prompts_file),
            uploads_dir: Arc::new(PathBuf::from("/tmp/nexus/uploads")),
            proxy_vars: Arc::new(Vec::new()),
            public_dir: Arc::new(PathBuf::from("/tmp/nexus/public")),
            frontend_dist_dir: Arc::new(PathBuf::from("/tmp/nexus/frontend/dist")),
            runtime_manager,
            login_limiter: Arc::new(LoginRateLimiter::new()),
        })
    }

    #[tokio::test]
    async fn missing_store_returns_empty_versioned_library() {
        let dir = tempdir().expect("tempdir");
        let store = PromptStore::new(dir.path().join("prompts.json"));

        let library = store.list().await.expect("empty library");

        assert_eq!(library, empty_prompt_library());
    }

    #[tokio::test]
    async fn create_update_delete_round_trip_preserves_content() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("nested").join("prompts.json");
        let store = PromptStore::new(file.clone());

        let created = store
            .create(input("  Review  ", "line one\nline two\n"))
            .await
            .expect("create");
        assert_eq!(created.title, "Review");
        assert_eq!(created.content, "line one\nline two\n");

        let updated = store
            .update(&created.id, input("Release", "updated body"))
            .await
            .expect("update");
        assert_eq!(updated.title, "Release");
        assert_eq!(updated.created_at, created.created_at);

        let restored = PromptStore::new(file.clone())
            .list()
            .await
            .expect("restored");
        assert_eq!(restored.prompts, vec![updated.clone()]);

        store.delete(&created.id).await.expect("delete");
        assert!(
            store
                .list()
                .await
                .expect("empty after delete")
                .prompts
                .is_empty()
        );
    }

    #[tokio::test]
    async fn corrupt_store_rejects_reads_and_mutations_without_overwrite() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("prompts.json");
        fs::write(&file, "{not json").await.expect("write corrupt");
        let store = PromptStore::new(file.clone());

        assert!(matches!(
            store.list().await,
            Err(PromptStoreError::Storage(_))
        ));
        assert!(matches!(
            store.create(input("Title", "Body")).await,
            Err(PromptStoreError::Storage(_))
        ));
        assert_eq!(
            fs::read_to_string(file).await.expect("unchanged"),
            "{not json"
        );
    }

    #[tokio::test]
    async fn validates_required_and_bounded_fields() {
        let dir = tempdir().expect("tempdir");
        let store = PromptStore::new(dir.path().join("prompts.json"));

        assert_eq!(
            store.create(input(" ", "body")).await.expect_err("title"),
            PromptStoreError::Invalid("prompt title required".to_string())
        );
        assert_eq!(
            store
                .create(input("title", " \n "))
                .await
                .expect_err("content"),
            PromptStoreError::Invalid("prompt content required".to_string())
        );
        assert!(matches!(
            store
                .create(input(&"t".repeat(MAX_PROMPT_TITLE_CHARS + 1), "body"))
                .await,
            Err(PromptStoreError::Invalid(_))
        ));
        assert!(matches!(
            store
                .create(input("title", &"x".repeat(MAX_PROMPT_CONTENT_CHARS + 1)))
                .await,
            Err(PromptStoreError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn concurrent_creates_do_not_lose_entries() {
        let dir = tempdir().expect("tempdir");
        let store = PromptStore::new(dir.path().join("prompts.json"));
        let mut handles = Vec::new();
        for index in 0..24 {
            let store = Arc::clone(&store);
            handles.push(tokio::spawn(async move {
                store
                    .create(input(&format!("Prompt {index}"), &format!("Body {index}")))
                    .await
            }));
        }
        for handle in handles {
            handle.await.expect("join").expect("create");
        }

        let library = store.list().await.expect("library");
        assert_eq!(library.prompts.len(), 24);
        let ids = library
            .prompts
            .iter()
            .map(|prompt| prompt.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 24);
    }

    #[tokio::test]
    async fn prompt_reorder_persists_exact_requested_order() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("prompts.json");
        let store = PromptStore::new(file.clone());
        let first = store.create(input("First", "one")).await.expect("first");
        let second = store.create(input("Second", "two")).await.expect("second");
        let third = store.create(input("Third", "three")).await.expect("third");

        let reordered = store
            .reorder(PromptOrderInput {
                ids: vec![first.id.clone(), third.id.clone(), second.id.clone()],
                expected_ids: vec![third.id.clone(), second.id.clone(), first.id.clone()],
            })
            .await
            .expect("reorder");

        assert_eq!(
            reordered
                .prompts
                .iter()
                .map(|prompt| prompt.id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), third.id.as_str(), second.id.as_str()]
        );
        let restored = PromptStore::new(file).list().await.expect("restored");
        assert_eq!(restored.prompts, reordered.prompts);
    }

    #[tokio::test]
    async fn prompt_reorder_rejects_invalid_sets_without_writing() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("prompts.json");
        let store = PromptStore::new(file.clone());
        let first = store.create(input("First", "one")).await.expect("first");
        let second = store.create(input("Second", "two")).await.expect("second");
        let original = fs::read_to_string(&file).await.expect("original file");

        let expected_ids = vec![second.id.clone(), first.id.clone()];
        let invalid_orders = [
            vec![first.id.clone()],
            vec![first.id.clone(), first.id.clone()],
            vec![first.id.clone(), "prompt_unknown_0".to_string()],
            vec![first.id.clone(), "invalid/id".to_string()],
        ];
        for ids in invalid_orders {
            assert!(
                store
                    .reorder(PromptOrderInput {
                        ids,
                        expected_ids: expected_ids.clone(),
                    })
                    .await
                    .is_err()
            );
            assert_eq!(
                fs::read_to_string(&file).await.expect("unchanged file"),
                original
            );
        }

        let library = store.list().await.expect("unchanged library");
        assert_eq!(
            library
                .prompts
                .iter()
                .map(|prompt| prompt.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
    }

    #[tokio::test]
    async fn prompt_reorder_rejects_stale_baseline_without_overwriting_newer_order() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("prompts.json");
        let store = PromptStore::new(file.clone());
        let first = store.create(input("First", "one")).await.expect("first");
        let second = store.create(input("Second", "two")).await.expect("second");
        let third = store.create(input("Third", "three")).await.expect("third");
        let original = vec![third.id.clone(), second.id.clone(), first.id.clone()];
        let newer = vec![first.id.clone(), third.id.clone(), second.id.clone()];

        store
            .reorder(PromptOrderInput {
                ids: newer.clone(),
                expected_ids: original.clone(),
            })
            .await
            .expect("first reorder");
        let after_newer = fs::read_to_string(&file).await.expect("newer file");

        let stale = store
            .reorder(PromptOrderInput {
                ids: vec![second.id.clone(), first.id.clone(), third.id.clone()],
                expected_ids: original,
            })
            .await
            .expect_err("stale reorder");

        assert!(matches!(stale, PromptStoreError::Conflict(_)));
        assert_eq!(
            fs::read_to_string(&file).await.expect("unchanged"),
            after_newer
        );
        assert_eq!(
            store
                .list()
                .await
                .expect("library")
                .prompts
                .iter()
                .map(|prompt| prompt.id.as_str())
                .collect::<Vec<_>>(),
            newer.iter().map(String::as_str).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn prompt_library_api_requires_auth_for_every_operation() {
        let dir = tempdir().expect("tempdir");
        let state = test_state(dir.path().join("prompts.json")).await;

        let list = api_get_prompt_library(State(Arc::clone(&state)), HeaderMap::new()).await;
        let create = api_create_prompt(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Json(input("Title", "Body")),
        )
        .await;
        let update = api_update_prompt(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            AxumPath("prompt_1_0".to_string()),
            Json(input("Title", "Body")),
        )
        .await;
        let reorder = api_reorder_prompt_library(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Json(PromptOrderInput {
                ids: Vec::new(),
                expected_ids: Vec::new(),
            }),
        )
        .await;
        let delete = api_delete_prompt(
            State(state),
            HeaderMap::new(),
            AxumPath("prompt_1_0".to_string()),
        )
        .await;

        assert_eq!(list.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(create.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(update.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(reorder.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(delete.status(), StatusCode::UNAUTHORIZED);
    }
}
