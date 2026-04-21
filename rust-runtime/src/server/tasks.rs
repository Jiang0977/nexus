use super::*;

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
    pub(super) profile: Option<String>,
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
    pub(super) task_manager: Arc<TaskManager>,
    pub(super) task_id: String,
    pub(super) start_frame: Option<TaskSseFrame>,
    pub(super) receiver: mpsc::UnboundedReceiver<TaskSseFrame>,
    pub(super) completed: bool,
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
            profile,
        } = options;
        let task_id = self.next_task_id();
        let created_at = iso_timestamp_now();
        let (sender, receiver) = mpsc::unbounded_channel();

        self.append_task(json!({
            "id": task_id.clone(),
            "session_name": session_name,
            "prompt": truncate_head(&prompt, MAX_TASK_PROMPT_LENGTH),
            "status": "running",
            "output": "",
            "error": "",
            "createdAt": created_at.clone(),
            "source": source,
            "tmux_session": tmux_session,
        }))
        .await?;

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
        tokio::spawn(async move {
            let result = manager
                .runtime
                .request(
                    "startTask",
                    json!({
                        "taskId": task_id_for_runtime.clone(),
                        "prompt": prompt,
                        "cwd": cwd,
                        "profile": profile,
                    }),
                )
                .await;
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

    pub(super) async fn kill_task(&self, task_id: &str) -> Result<(), String> {
        self.runtime
            .notify("killTask", json!({ "taskId": task_id }))
            .await
    }

    pub(super) async fn list_recent(&self, limit: usize) -> Result<Vec<Value>, String> {
        let tasks = self.load_tasks().await?;
        Ok(tasks.into_iter().rev().take(limit).collect())
    }

    pub(super) async fn delete_task(&self, id: &str) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let tasks = self.load_tasks_locked().await?;
        let filtered = tasks
            .into_iter()
            .filter(|task| task.get("id").and_then(Value::as_str) != Some(id))
            .collect::<Vec<_>>();
        self.save_tasks_locked(filtered).await
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
                        state.error_output.push_str(&chunk.chunk);
                    } else {
                        state.output.push_str(&chunk.chunk);
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
        if let Some(parent) = self.tasks_file.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("failed to create task store directory: {error}"))?;
        }
        let content = serde_json::to_string_pretty(&tasks)
            .map_err(|error| format!("failed to serialize task store: {error}"))?;
        fs::write(self.tasks_file.as_ref(), format!("{content}\n"))
            .await
            .map_err(|error| format!("failed to write task store: {error}"))
    }
}

impl TaskEventStream {
    pub(super) fn new(
        task_manager: Arc<TaskManager>,
        session_name: String,
        prompt: String,
        handle: TaskRunHandle,
    ) -> Self {
        Self {
            task_manager,
            task_id: handle.task_id.clone(),
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
            completed: false,
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
            Poll::Ready(Some(frame)) => {
                if frame.event == "done" {
                    self.completed = true;
                }
                Poll::Ready(Some(Ok(to_sse_event(frame))))
            }
            Poll::Ready(None) => {
                self.completed = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for TaskEventStream {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let task_manager = Arc::clone(&self.task_manager);
        let task_id = self.task_id.clone();
        tokio::spawn(async move {
            let _ = task_manager.kill_task(&task_id).await;
        });
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
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
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
                profile: body.profile.filter(|value| !value.is_empty()),
            },
        )
        .await
    {
        Ok(handle) => handle,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };

    let stream = TaskEventStream::new(state.task_manager.clone(), session_name, prompt, handle);
    let mut response = Sse::new(stream).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}
