use super::*;

static TASK_TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug)]
pub(super) enum TaskDeleteError {
    Conflict(String),
    Internal(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskRuntimeChunkEvent {
    pub(super) task_id: String,
    pub(super) chunk: String,
    pub(super) is_err: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskRuntimeDoneEvent {
    pub(super) task_id: String,
    pub(super) exit_code: Option<i32>,
    pub(super) error_message: Option<String>,
}

pub(super) struct TaskRunOptions {
    pub(super) session_name: String,
    pub(super) source: String,
    pub(super) tmux_session: String,
    pub(super) engine: String,
    pub(super) profile: Option<String>,
    pub(super) codex_configs_dir: Option<PathBuf>,
}

pub(super) struct TaskRunHandle {
    pub(super) task_id: String,
    pub(super) created_at: String,
    pub(super) receiver: mpsc::UnboundedReceiver<TaskSseFrame>,
}

pub(super) struct RunningTaskState {
    pub(super) output: String,
    pub(super) error_output: String,
    pub(super) sender: mpsc::UnboundedSender<TaskSseFrame>,
}

pub(super) struct TaskManager {
    pub(super) tasks_file: Arc<PathBuf>,
    pub(super) store_lock: Mutex<()>,
    pub(super) runtime: Arc<ManagedRuntime>,
    pub(super) running_tasks: Mutex<HashMap<String, RunningTaskState>>,
    pub(super) next_task_counter: AtomicUsize,
}

#[derive(Clone)]
pub(super) struct TaskSseFrame {
    pub(super) event: String,
    pub(super) payload: Value,
}

pub(super) struct TaskEventStream {
    pub(super) start_frame: Option<TaskSseFrame>,
    pub(super) receiver: mpsc::UnboundedReceiver<TaskSseFrame>,
}

fn append_bounded_chunk(buffer: &mut String, chunk: &str, max_chars: usize) {
    if max_chars == 0 {
        buffer.clear();
        return;
    }

    if chunk.chars().count() >= max_chars {
        *buffer = truncate_tail(chunk, max_chars);
        return;
    }

    buffer.push_str(chunk);
    if buffer.chars().count() > max_chars {
        *buffer = truncate_tail(buffer, max_chars);
    }
}

impl TaskManager {
    pub(super) async fn new(tasks_file: PathBuf, runtime: Arc<ManagedRuntime>) -> Arc<Self> {
        let manager = Arc::new(Self {
            tasks_file: Arc::new(tasks_file),
            store_lock: Mutex::new(()),
            runtime: runtime.clone(),
            running_tasks: Mutex::new(HashMap::new()),
            next_task_counter: AtomicUsize::new(0),
        });

        let _ = manager
            .mark_running_tasks_interrupted(TASK_INTERRUPT_MESSAGE)
            .await;

        if let Some(receiver) = runtime.subscribe_events().await {
            manager.spawn_event_loop(receiver);
        }

        manager
    }

    pub(super) fn spawn_event_loop(
        self: &Arc<Self>,
        mut receiver: broadcast::Receiver<RuntimeEventEnvelope>,
    ) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => manager.handle_runtime_event(event).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub(super) async fn run_task(
        self: &Arc<Self>,
        prompt: String,
        cwd: String,
        options: TaskRunOptions,
    ) -> Result<TaskRunHandle, String> {
        let TaskRunOptions {
            session_name,
            source,
            tmux_session,
            engine,
            profile,
            codex_configs_dir,
        } = options;
        let task_id = self.next_task_id();
        let created_at = iso_timestamp_now();
        let (sender, receiver) = mpsc::unbounded_channel();

        let mut task_record = json!({
            "id": task_id.clone(),
            "session_name": session_name,
            "prompt": truncate_head(&prompt, MAX_TASK_PROMPT_LENGTH),
            "status": "running",
            "output": "",
            "error": "",
            "createdAt": created_at.clone(),
            "source": source,
            "tmux_session": tmux_session,
            "engine": engine.clone(),
        });
        if let Some(profile_ref) = profile.as_ref() {
            task_record["profile"] = json!(profile_ref);
        }

        self.append_task(task_record).await?;

        self.running_tasks.lock().await.insert(
            task_id.clone(),
            RunningTaskState {
                output: String::new(),
                error_output: String::new(),
                sender,
            },
        );

        let manager = Arc::clone(self);
        let task_id_for_runtime = task_id.clone();
        let codex_configs_dir_str = if engine == "codex" {
            codex_configs_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };
        let codex_task_home_str = if engine == "codex" {
            self.tasks_file
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("codex-task-runtime")
                .join(&task_id_for_runtime)
                .to_string_lossy()
                .to_string()
        } else {
            String::new()
        };

        tokio::spawn(async move {
            let mut start_params = json!({
                "taskId": task_id_for_runtime.clone(),
                "prompt": prompt,
                "cwd": cwd,
                "engine": engine,
                "profile": profile,
            });
            if !codex_task_home_str.is_empty() {
                start_params["codexTaskHome"] = json!(codex_task_home_str);
            }
            if let Some(cfg_dir) = codex_configs_dir_str {
                start_params["codexConfigsDir"] = json!(cfg_dir);
            }
            let result = manager.runtime.request("startTask", start_params).await;
            if let Err(error) = result {
                manager
                    .finalize_task(&task_id_for_runtime, None, Some(error))
                    .await;
            }
        });

        Ok(TaskRunHandle {
            task_id,
            created_at,
            receiver,
        })
    }

    pub(super) async fn list_recent(&self, limit: usize) -> Result<Vec<Value>, String> {
        let tasks = self.load_tasks().await?;
        Ok(tasks.into_iter().rev().take(limit).collect())
    }

    pub(super) async fn delete_task(&self, id: &str) -> Result<(), TaskDeleteError> {
        let _guard = self.store_lock.lock().await;
        let tasks = self
            .load_tasks_locked()
            .await
            .map_err(TaskDeleteError::Internal)?;
        let target = tasks
            .iter()
            .find(|task| task.get("id").and_then(Value::as_str) == Some(id));
        if let Some(task) = target {
            if task.get("status").and_then(Value::as_str) == Some("running") {
                return Err(TaskDeleteError::Conflict("task is running".to_string()));
            }
        } else {
            return Ok(());
        }

        let filtered = tasks
            .into_iter()
            .filter(|task| task.get("id").and_then(Value::as_str) != Some(id))
            .collect::<Vec<_>>();
        self.save_tasks_locked(filtered)
            .await
            .map_err(TaskDeleteError::Internal)
    }

    pub(super) async fn append_task(&self, task: Value) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let mut tasks = self.load_tasks_locked().await?;
        tasks.push(task);
        self.save_tasks_locked(tasks).await
    }

    pub(super) async fn update_task(&self, id: &str, updates: Value) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let mut tasks = self.load_tasks_locked().await?;
        for task in &mut tasks {
            if task.get("id").and_then(Value::as_str) != Some(id) {
                continue;
            }
            if let (Some(task_object), Some(update_object)) =
                (task.as_object_mut(), updates.as_object())
            {
                for (key, value) in update_object {
                    task_object.insert(key.clone(), value.clone());
                }
            }
            break;
        }
        self.save_tasks_locked(tasks).await
    }

    pub(super) async fn mark_running_tasks_interrupted(&self, message: &str) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let mut tasks = self.load_tasks_locked().await?;
        let mut changed = false;
        for task in &mut tasks {
            if task.get("status").and_then(Value::as_str) != Some("running") {
                continue;
            }
            if let Some(object) = task.as_object_mut() {
                object.insert("status".to_string(), Value::String("error".to_string()));
                object.insert("error".to_string(), Value::String(message.to_string()));
                object.insert(
                    "completedAt".to_string(),
                    Value::String(iso_timestamp_now()),
                );
                changed = true;
            }
        }

        if changed {
            self.save_tasks_locked(tasks).await?;
        }
        Ok(())
    }

    pub(super) async fn handle_runtime_event(self: &Arc<Self>, event: RuntimeEventEnvelope) {
        match event.event.as_str() {
            "chunk" => {
                if let Ok(chunk) = serde_json::from_value::<TaskRuntimeChunkEvent>(event.params) {
                    let mut running = self.running_tasks.lock().await;
                    let Some(state) = running.get_mut(&chunk.task_id) else {
                        return;
                    };
                    if chunk.is_err {
                        append_bounded_chunk(
                            &mut state.error_output,
                            &chunk.chunk,
                            MAX_TASK_ERROR_LENGTH,
                        );
                    } else {
                        append_bounded_chunk(
                            &mut state.output,
                            &chunk.chunk,
                            MAX_TASK_OUTPUT_LENGTH,
                        );
                    }
                    let _ = state.sender.send(TaskSseFrame {
                        event: if chunk.is_err { "error" } else { "output" }.to_string(),
                        payload: json!({ "chunk": chunk.chunk }),
                    });
                }
            }
            "done" => {
                if let Ok(done) = serde_json::from_value::<TaskRuntimeDoneEvent>(event.params) {
                    self.finalize_task(&done.task_id, done.exit_code, done.error_message)
                        .await;
                }
            }
            "fatal" => {
                let message = event
                    .params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("task runner backend unavailable")
                    .to_string();
                self.fail_all_running_tasks(&message).await;
            }
            _ => {}
        }
    }

    pub(super) async fn finalize_task(
        &self,
        task_id: &str,
        exit_code: Option<i32>,
        error_message: Option<String>,
    ) {
        let state = self.running_tasks.lock().await.remove(task_id);
        let Some(mut state) = state else {
            return;
        };

        let trimmed_error = error_message.unwrap_or_default().trim().to_string();
        if !trimmed_error.is_empty() && state.error_output.is_empty() {
            state.error_output = trimmed_error;
        }

        let status = if exit_code == Some(0) {
            "success"
        } else {
            "error"
        };
        if let Err(error) = self
            .update_task(
                task_id,
                json!({
                    "status": status,
                    "output": truncate_tail(&state.output, MAX_TASK_OUTPUT_LENGTH),
                    "error": truncate_tail(&state.error_output, MAX_TASK_ERROR_LENGTH),
                    "completedAt": iso_timestamp_now(),
                    "exitCode": exit_code,
                }),
            )
            .await
        {
            eprintln!("task store update failed for {task_id}: {error}");
        }

        let _ = state.sender.send(TaskSseFrame {
            event: "done".to_string(),
            payload: json!({
                "taskId": task_id,
                "status": status,
                "exitCode": exit_code,
            }),
        });
    }

    pub(super) async fn fail_all_running_tasks(&self, message: &str) {
        let task_ids = self
            .running_tasks
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for task_id in task_ids {
            self.finalize_task(&task_id, None, Some(message.to_string()))
                .await;
        }
    }

    pub(super) fn next_task_id(&self) -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let counter = self.next_task_counter.fetch_add(1, Ordering::SeqCst);
        format!("task_{millis}_{counter}")
    }

    pub(super) async fn load_tasks(&self) -> Result<Vec<Value>, String> {
        let _guard = self.store_lock.lock().await;
        self.load_tasks_locked().await
    }

    pub(super) async fn load_tasks_locked(&self) -> Result<Vec<Value>, String> {
        match fs::read_to_string(self.tasks_file.as_ref()).await {
            Ok(raw) => serde_json::from_str::<Vec<Value>>(&raw)
                .map_err(|error| format!("failed to parse task store: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!("failed to read task store: {error}")),
        }
    }

    pub(super) async fn save_tasks_locked(&self, mut tasks: Vec<Value>) -> Result<(), String> {
        if tasks.len() > DEFAULT_MAX_TASKS {
            tasks = tasks.split_off(tasks.len() - DEFAULT_MAX_TASKS);
        }
        let target_file = self.tasks_file.as_ref();
        let parent_dir = target_file.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent_dir)
            .await
            .map_err(|error| format!("failed to create task store directory: {error}"))?;

        let file_stem = target_file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("tasks.json");

        let content = serde_json::to_string_pretty(&tasks)
            .map_err(|error| format!("failed to serialize task store: {error}"))?;
        let mut content_with_newline = content;
        content_with_newline.push('\n');

        let pid = std::process::id();
        const MAX_TEMP_RETRIES: usize = 100;
        let mut created: Option<(PathBuf, fs::File)> = None;

        for _ in 0..MAX_TEMP_RETRIES {
            let seq = TASK_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let temp_name = format!("{file_stem}.tmp.{pid}.{nanos}.{seq}");
            let temp_path = parent_dir.join(temp_name);
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            match options.open(&temp_path).await {
                Ok(file) => {
                    created = Some((temp_path, file));
                    break;
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => {
                    return Err(format!("failed to create temporary task store file: {err}"));
                }
            }
        }

        let (temp_path, mut file) = created.ok_or_else(|| {
            "exhausted retries trying to create unique temporary task store file".to_string()
        })?;

        if let Err(error) = async {
            file.write_all(content_with_newline.as_bytes()).await?;
            file.flush().await?;
            file.sync_all().await?;
            Ok::<(), std::io::Error>(())
        }
        .await
        {
            drop(file);
            let _ = fs::remove_file(&temp_path).await;
            return Err(format!("failed to write temporary task store: {error}"));
        }
        drop(file);

        if let Err(error) = fs::rename(&temp_path, target_file).await {
            let _ = fs::remove_file(&temp_path).await;
            return Err(format!("failed to atomically replace task store: {error}"));
        }
        Ok(())
    }
}

impl TaskEventStream {
    pub(super) fn new(session_name: String, prompt: String, handle: TaskRunHandle) -> Self {
        Self {
            start_frame: Some(TaskSseFrame {
                event: "start".to_string(),
                payload: json!({
                    "taskId": handle.task_id,
                    "session_name": session_name,
                    "prompt": prompt,
                    "createdAt": handle.created_at,
                }),
            }),
            receiver: handle.receiver,
        }
    }
}

impl Stream for TaskEventStream {
    type Item = Result<SseEvent, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(frame) = self.start_frame.take() {
            return Poll::Ready(Some(Ok(to_sse_event(frame))));
        }

        match Pin::new(&mut self.receiver).poll_recv(cx) {
            Poll::Ready(Some(frame)) => Poll::Ready(Some(Ok(to_sse_event(frame)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

pub(super) async fn api_tasks(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state
        .task_manager
        .list_recent(DEFAULT_TASK_HISTORY_LIMIT)
        .await
    {
        Ok(tasks) => Json(Value::Array(tasks)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn api_delete_task(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state.task_manager.delete_task(&id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(TaskDeleteError::Conflict(message)) => json_error(StatusCode::CONFLICT, &message),
        Err(TaskDeleteError::Internal(error)) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, &error)
        }
    }
}

pub(super) async fn api_create_task(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<TaskBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(prompt) = body.prompt.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "prompt required");
    };

    let engine_raw = body.engine.unwrap_or_default();
    let engine = if engine_raw.trim().is_empty() {
        "claude".to_string()
    } else {
        match engine_raw.as_str() {
            "claude" | "codex" => engine_raw,
            _ => return json_error(StatusCode::BAD_REQUEST, "invalid engine"),
        }
    };

    let profile = if engine == "codex" {
        if let Some(ref prof_raw) = body.profile {
            let prof = prof_raw.trim();
            if !prof.is_empty() {
                let canonical = sanitize_profile_id(prof);
                if prof != canonical
                    || read_codex_config(state.codex_configs_dir.as_ref(), &canonical).is_none()
                {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        &format!("codex profile '{prof_raw}' not found"),
                    );
                }
                Some(canonical)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        body.profile
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
    };

    let session_name = body.session_name.unwrap_or_default();
    let tmux_session = body
        .tmux_session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let cwd = resolve_task_cwd_from_runtime(&state, &tmux_session, &session_name).await;
    let handle = match state
        .task_manager
        .run_task(
            prompt.clone(),
            cwd,
            TaskRunOptions {
                session_name: session_name.clone(),
                source: "web".to_string(),
                tmux_session: tmux_session.clone(),
                engine,
                profile,
                codex_configs_dir: Some(state.codex_configs_dir.as_ref().clone()),
            },
        )
        .await
    {
        Ok(handle) => handle,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };

    let stream = TaskEventStream::new(session_name, prompt, handle);
    let mut response = Sse::new(stream).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn append_bounded_chunk_keeps_tail_within_limit() {
        let mut buffer = "12345".to_string();
        append_bounded_chunk(&mut buffer, "67890", 6);
        assert_eq!(buffer, "567890");
        assert!(buffer.chars().count() <= 6);
    }

    #[test]
    fn append_bounded_chunk_replaces_buffer_when_chunk_exceeds_limit() {
        let mut buffer = "prefix".to_string();
        append_bounded_chunk(&mut buffer, "abcdefghij", 4);
        assert_eq!(buffer, "ghij");
        assert!(buffer.chars().count() <= 4);
    }

    fn unconfigured_runtime(display_name: &'static str) -> Arc<ManagedRuntime> {
        Arc::new(ManagedRuntime {
            display_name,
            extra_env: Vec::new(),
            inner: Mutex::new(ManagedRuntimeState {
                ready_timeout: std::time::Duration::from_millis(1),
                process: None,
                status: json!({ "ready": false, "source": "test" }),
            }),
        })
    }

    #[tokio::test]
    async fn save_tasks_atomic_writes_and_keeps_max_tasks_and_0600_mode() {
        let dir = tempdir().unwrap();
        let tasks_file = dir.path().join("tasks.json");
        let runtime = unconfigured_runtime("task runner");
        let manager = TaskManager::new(tasks_file.clone(), runtime).await;

        let total_tasks = DEFAULT_MAX_TASKS + 15;
        let mut task_list = Vec::new();
        for i in 0..total_tasks {
            task_list.push(json!({
                "id": format!("task_{i}"),
                "status": "success",
                "prompt": format!("prompt {i}"),
            }));
        }

        let _guard = manager.store_lock.lock().await;
        manager.save_tasks_locked(task_list).await.unwrap();

        let raw = std::fs::read_to_string(&tasks_file).unwrap();
        let parsed: Vec<Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.len(), DEFAULT_MAX_TASKS);
        assert_eq!(parsed[0]["id"], "task_15");
        assert_eq!(
            parsed[DEFAULT_MAX_TASKS - 1]["id"],
            format!("task_{}", total_tasks - 1)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&tasks_file).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        }

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|r| r.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["tasks.json"]);
    }

    #[tokio::test]
    async fn save_tasks_atomic_failure_cleans_up_temp_on_rename_error() {
        let dir = tempdir().unwrap();
        let tasks_file = dir.path().join("tasks.json");
        let initial_json = json!([{"id": "initial_task", "status": "success"}]);
        std::fs::write(&tasks_file, serde_json::to_string(&initial_json).unwrap()).unwrap();

        let runtime = unconfigured_runtime("task runner");
        let manager = TaskManager::new(tasks_file.clone(), runtime).await;

        std::fs::remove_file(&tasks_file).unwrap();
        std::fs::create_dir(&tasks_file).unwrap();

        let new_tasks = vec![json!([{"id": "new_task", "status": "running"}])];
        let _guard = manager.store_lock.lock().await;
        let result = manager.save_tasks_locked(new_tasks).await;
        assert!(result.is_err());

        let temp_files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|r| r.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("tasks.json.tmp."))
            .collect();
        assert!(
            temp_files.is_empty(),
            "expected no leftover temp files, found: {temp_files:?}"
        );
    }

    #[tokio::test]
    async fn delete_task_running_returns_conflict() {
        let dir = tempdir().unwrap();
        let tasks_file = dir.path().join("tasks.json");
        let runtime = unconfigured_runtime("task runner");
        let manager = TaskManager::new(tasks_file.clone(), runtime).await;

        {
            let _guard = manager.store_lock.lock().await;
            manager
                .save_tasks_locked(vec![
                    json!({ "id": "t1", "status": "running" }),
                    json!({ "id": "t2", "status": "success" }),
                ])
                .await
                .unwrap();
        }

        match manager.delete_task("t1").await {
            Err(TaskDeleteError::Conflict(msg)) => assert_eq!(msg, "task is running"),
            other => panic!("expected Conflict error, got {other:?}"),
        }

        let loaded = manager.load_tasks().await.unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0]["id"], "t1");

        manager.delete_task("non_existent").await.unwrap();

        manager.delete_task("t2").await.unwrap();
        let loaded2 = manager.load_tasks().await.unwrap();
        assert_eq!(loaded2.len(), 1);
        assert_eq!(loaded2[0]["id"], "t1");
    }

    #[tokio::test]
    async fn run_task_persists_engine_and_profile() {
        let dir = tempdir().unwrap();
        let tasks_file = dir.path().join("tasks.json");
        let runtime = unconfigured_runtime("task runner");
        let manager = TaskManager::new(tasks_file.clone(), runtime).await;

        let handle = manager
            .run_task(
                "test prompt".to_string(),
                dir.path().to_string_lossy().to_string(),
                TaskRunOptions {
                    session_name: "test_session".to_string(),
                    source: "web".to_string(),
                    tmux_session: "default".to_string(),
                    engine: "codex".to_string(),
                    profile: Some("custom-prof".to_string()),
                    codex_configs_dir: Some(dir.path().join("codex-configs")),
                },
            )
            .await
            .unwrap();

        let tasks = manager.load_tasks().await.unwrap();
        let saved = tasks.iter().find(|t| t["id"] == handle.task_id).unwrap();
        assert_eq!(saved["engine"], "codex");
        assert_eq!(saved["profile"], "custom-prof");
        assert_eq!(saved["prompt"], "test prompt");
        assert_eq!(saved["status"], "running");
    }

    #[tokio::test]
    async fn run_task_claude_omits_profile_when_none() {
        let dir = tempdir().unwrap();
        let tasks_file = dir.path().join("tasks.json");
        let runtime = unconfigured_runtime("task runner");
        let manager = TaskManager::new(tasks_file.clone(), runtime).await;

        let handle = manager
            .run_task(
                "claude prompt".to_string(),
                dir.path().to_string_lossy().to_string(),
                TaskRunOptions {
                    session_name: "sess".to_string(),
                    source: "web".to_string(),
                    tmux_session: "default".to_string(),
                    engine: "claude".to_string(),
                    profile: None,
                    codex_configs_dir: None,
                },
            )
            .await
            .unwrap();

        let tasks = manager.load_tasks().await.unwrap();
        let saved = tasks.iter().find(|t| t["id"] == handle.task_id).unwrap();
        assert_eq!(saved["engine"], "claude");
        assert!(saved.get("profile").is_none());
    }

    #[tokio::test]
    async fn api_create_task_validation_checks_engine_and_profile() {
        let dir = tempdir().unwrap();
        let tasks_file = dir.path().join("tasks.json");
        let codex_configs_dir = dir.path().join("codex-configs");
        std::fs::create_dir_all(&codex_configs_dir).unwrap();
        let runtime = unconfigured_runtime("task runner");
        let task_manager = TaskManager::new(tasks_file, runtime.clone()).await;

        let state = Arc::new(AppState {
            jwt_secret: Arc::new("secret".to_string()),
            password_hash: Arc::new("hash".to_string()),
            default_tmux_session: Arc::new("nexus".to_string()),
            session_backend: Arc::new("tmux".to_string()),
            session_backend_config_file: Arc::new(dir.path().join("session-backend.json")),
            codex_history_enabled: false,
            ws_connection_counter: Arc::new(AtomicUsize::new(0)),
            github_repo: Arc::new("test/repo".to_string()),
            project_root: Arc::new(dir.path().to_path_buf()),
            workspace_root: Arc::new(dir.path().to_string_lossy().to_string()),
            configs_dir: Arc::new(dir.path().join("configs")),
            codex_configs_dir: Arc::new(codex_configs_dir.clone()),
            codex_validate_dir: Arc::new(dir.path().join("validate")),
            project_defaults_file: Arc::new(dir.path().join("project_defaults.json")),
            toolbar_config_file: Arc::new(dir.path().join("toolbar-config.json")),
            workspace_layouts_file: Arc::new(dir.path().join("workspace-layouts.json")),
            uploads_dir: Arc::new(dir.path().join("uploads")),
            public_dir: Arc::new(dir.path().join("public")),
            frontend_dist_dir: Arc::new(dir.path().join("dist")),
            runtime_manager: Arc::new(RuntimeManager {
                task_runner: runtime.clone(),
                pty_broker: unconfigured_runtime("pty broker"),
                window_launch: unconfigured_runtime("window launch"),
                session_management: unconfigured_runtime("session management"),
            }),
            task_manager,
            prompt_store: PromptStore::new(dir.path().join("prompts.json")),
            proxy_vars: Arc::new(Vec::new()),
            login_limiter: Arc::new(LoginRateLimiter::new()),
        });

        let token = encode(
            &Header::default(),
            &AuthClaims { exp: u64::MAX },
            &EncodingKey::from_secret("secret".as_bytes()),
        )
        .unwrap();

        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );

        // 1. Missing prompt -> 400
        let resp = api_create_task(
            State(state.clone()),
            headers.clone(),
            Json(TaskBody {
                prompt: None,
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // 2. Invalid engine -> 400
        let resp = api_create_task(
            State(state.clone()),
            headers.clone(),
            Json(TaskBody {
                prompt: Some("do work".to_string()),
                engine: Some("unsupported".to_string()),
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // 3. Codex engine with missing profile -> 400
        let resp = api_create_task(
            State(state.clone()),
            headers.clone(),
            Json(TaskBody {
                prompt: Some("do work".to_string()),
                engine: Some("codex".to_string()),
                profile: Some("nonexistent".to_string()),
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // 4. Codex engine with valid profile -> 200 SSE
        std::fs::write(
            codex_configs_dir.join("valid-prof.json"),
            serde_json::json!({
                "OPENAI_API_KEY": "sk-test",
            })
            .to_string(),
        )
        .unwrap();

        let resp = api_create_task(
            State(state.clone()),
            headers.clone(),
            Json(TaskBody {
                prompt: Some("do work".to_string()),
                engine: Some("codex".to_string()),
                profile: Some("valid-prof".to_string()),
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // 5. Codex engine rejects aliases / noncanonical profile IDs and accepts canonical
        std::fs::write(
            codex_configs_dir.join("valid--prof.json"),
            serde_json::json!({
                "OPENAI_API_KEY": "sk-test",
            })
            .to_string(),
        )
        .unwrap();

        let resp = api_create_task(
            State(state.clone()),
            headers.clone(),
            Json(TaskBody {
                prompt: Some("do work".to_string()),
                engine: Some("codex".to_string()),
                profile: Some("../valid..prof".to_string()),
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let resp = api_create_task(
            State(state.clone()),
            headers.clone(),
            Json(TaskBody {
                prompt: Some("do work".to_string()),
                engine: Some("codex".to_string()),
                profile: Some("valid..prof".to_string()),
                ..Default::default()
            }),
        )
        .await;
        // "valid..prof" is an alias (non-canonical) -> must return 400
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let resp = api_create_task(
            State(state.clone()),
            headers.clone(),
            Json(TaskBody {
                prompt: Some("do work".to_string()),
                engine: Some("codex".to_string()),
                profile: Some("  valid--prof  ".to_string()),
                ..Default::default()
            }),
        )
        .await;
        // trimmed "valid--prof" equals canonical -> 200
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
