use super::*;

pub(super) struct TelegramBridge {
    pub(super) client: Client,
    pub(super) bot_token: Arc<String>,
    pub(super) webhook_secret: Arc<String>,
    pub(super) default_session: Arc<String>,
    pub(super) api_base_url: Arc<String>,
}

#[derive(Clone)]
pub(super) struct TelegramWindow {
    pub(super) index: String,
    pub(super) name: String,
    pub(super) cwd: String,
    pub(super) active: bool,
}

pub(super) struct TelegramRouteError {
    pub(super) status: StatusCode,
    pub(super) message: String,
}

#[derive(Clone, Deserialize)]
pub(super) struct TelegramUpdate {
    pub(super) message: Option<TelegramMessage>,
    pub(super) edited_message: Option<TelegramMessage>,
}

#[derive(Clone, Deserialize)]
pub(super) struct TelegramMessage {
    pub(super) chat: Option<TelegramChat>,
    pub(super) text: Option<String>,
    pub(super) caption: Option<String>,
    pub(super) photo: Option<Vec<TelegramPhoto>>,
    pub(super) document: Option<TelegramDocument>,
}

#[derive(Clone, Deserialize)]
pub(super) struct TelegramChat {
    pub(super) id: i64,
}

#[derive(Clone, Deserialize)]
pub(super) struct TelegramPhoto {
    pub(super) file_id: String,
}

#[derive(Clone, Deserialize)]
pub(super) struct TelegramDocument {
    pub(super) file_id: String,
    pub(super) file_name: Option<String>,
}

impl TelegramRouteError {
    pub(super) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl TelegramBridge {
    pub(super) fn new(
        bot_token: String,
        webhook_secret: String,
        default_session: String,
        api_base_url: String,
    ) -> Self {
        Self {
            client: Client::new(),
            bot_token: Arc::new(bot_token),
            webhook_secret: Arc::new(webhook_secret),
            default_session: Arc::new(default_session),
            api_base_url: Arc::new(api_base_url.trim_end_matches('/').to_string()),
        }
    }

    pub(super) fn ensure_configured(&self, message: &str) -> Result<(), TelegramRouteError> {
        if self.bot_token.trim().is_empty() {
            return Err(TelegramRouteError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                message,
            ));
        }
        Ok(())
    }

    pub(super) fn verify_webhook_request(
        &self,
        headers: &HeaderMap,
    ) -> Result<(), TelegramRouteError> {
        if !self.webhook_secret.is_empty() {
            let secret = header_string(headers, "x-telegram-bot-api-secret-token");
            if secret.as_deref() != Some(self.webhook_secret.as_str()) {
                return Err(TelegramRouteError::new(StatusCode::FORBIDDEN, "forbidden"));
            }
        }
        self.ensure_configured("Telegram not configured")
    }

    pub(super) async fn setup_webhook(
        &self,
        protocol: &str,
        host: &str,
    ) -> Result<Value, TelegramRouteError> {
        self.ensure_configured("TELEGRAM_BOT_TOKEN not set")?;
        let webhook_url = format!("{protocol}://{host}/api/webhooks/telegram");
        let request = self
            .client
            .get(self.telegram_api_url("setWebhook"))
            .query(&[("url", webhook_url.as_str())]);
        let request = if self.webhook_secret.is_empty() {
            request
        } else {
            request.query(&[("secret_token", self.webhook_secret.as_str())])
        };

        let raw = request
            .send()
            .await
            .map_err(|error| {
                TelegramRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })?
            .text()
            .await
            .map_err(|error| {
                TelegramRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })?;

        let response = serde_json::from_str::<Value>(&raw).unwrap_or(Value::String(raw));
        Ok(match response {
            Value::String(raw) => json!({
                "webhookUrl": webhook_url,
                "raw": raw,
            }),
            other => json!({
                "webhookUrl": webhook_url,
                "telegramResponse": other,
            }),
        })
    }

    pub(super) async fn handle_update(
        &self,
        state: Arc<AppState>,
        update: TelegramUpdate,
    ) -> Result<(), String> {
        let Some(message) = update.message.or(update.edited_message) else {
            return Ok(());
        };
        let Some(chat_id) = message.chat.as_ref().map(|chat| chat.id) else {
            return Ok(());
        };
        let text = message.text.clone().unwrap_or_default().trim().to_string();

        if text == "/start" {
            let _ = self.send_message(chat_id, TELEGRAM_START_MESSAGE).await;
            return Ok(());
        }

        if text == "/sessions" {
            self.handle_sessions_command(&state, chat_id).await;
            return Ok(());
        }

        if text.starts_with("/switch ") {
            self.handle_switch_command(&state, chat_id, &text).await;
            return Ok(());
        }

        if message
            .photo
            .as_ref()
            .map(|photos| !photos.is_empty())
            .unwrap_or(false)
            || message.document.is_some()
        {
            self.handle_file_upload(state, chat_id, message).await;
            return Ok(());
        }

        if text.is_empty() {
            return Ok(());
        }

        let (cwd, session_name) = self.resolve_prompt_target(&state).await;
        self.run_prompt(state, chat_id, text, cwd, session_name)
            .await;
        Ok(())
    }

    pub(super) async fn handle_sessions_command(&self, state: &AppState, chat_id: i64) {
        match self.list_windows(state).await {
            Ok(windows) => {
                let mut sorted = windows;
                sorted.sort_by_key(|window| window.index.parse::<u32>().unwrap_or(u32::MAX));
                let lines = sorted
                    .into_iter()
                    .map(|window| {
                        format!(
                            "{} `{}: {}`",
                            if window.active { "▶" } else { "  " },
                            window.index,
                            window.name
                        )
                    })
                    .collect::<Vec<_>>();
                let body = format!(
                    "*当前 tmux 窗口:*\n{}\n\n用 `/switch <编号>` 切换",
                    lines.join("\n")
                );
                let _ = self.send_message(chat_id, &body).await;
            }
            Err(error) => {
                let _ = self
                    .send_message(chat_id, &format!("❌ 无法获取会话列表: {error}"))
                    .await;
            }
        }
    }

    pub(super) async fn handle_switch_command(&self, state: &AppState, chat_id: i64, text: &str) {
        let target = sanitize_telegram_switch_target(text);
        if target.is_empty() {
            let _ = self
                .send_message(chat_id, "❌ 无效的窗口名称，只允许字母/数字/下划线/连字符")
                .await;
            return;
        }

        let result = state
            .runtime_manager
            .session_management_request(
                "attachSessionWindow",
                json!({
                    "sessionName": state.default_tmux_session.as_ref(),
                    "index": target,
                }),
            )
            .await;
        match result {
            Ok(_) => {
                let _ = self
                    .send_message(
                        chat_id,
                        &format!("✅ 已切换到窗口 `{target}`\n\n后续任务将在此窗口执行。"),
                    )
                    .await;
            }
            Err(error) => {
                let _ = self
                    .send_message(chat_id, &format!("❌ 无法切换到窗口 `{target}`: {error}"))
                    .await;
            }
        }
    }

    pub(super) async fn handle_file_upload(
        &self,
        state: Arc<AppState>,
        chat_id: i64,
        message: TelegramMessage,
    ) {
        let result = async {
            let cwd = self.resolve_upload_directory(&state).await;
            let (file_id, filename) = telegram_file_target(&message)?;
            let _ = self
                .send_message(chat_id, &format!("⬇️ 正在下载文件到 `{cwd}`..."))
                .await;
            let download = self.download_file(&file_id, &cwd, &filename).await?;
            let _ = self
                .send_message(
                    chat_id,
                    &format!(
                        "✅ 文件已保存\n```\n{}\n```\n大小: {:.1} KB",
                        download.path,
                        (download.size as f64) / 1024.0
                    ),
                )
                .await;
            if let Some(caption) = message
                .caption
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                self.run_prompt(
                    state,
                    chat_id,
                    caption.to_string(),
                    cwd,
                    Some("telegram".to_string()),
                )
                .await;
            }
            Ok::<(), String>(())
        }
        .await;

        if let Err(error) = result {
            let _ = self
                .send_message(chat_id, &format!("❌ 文件处理失败: {error}"))
                .await;
        }
    }

    pub(super) async fn resolve_prompt_target(&self, state: &AppState) -> (String, Option<String>) {
        let mut cwd = state.workspace_root.as_ref().clone();
        let mut session_name = if self.default_session.as_ref().trim().is_empty() {
            None
        } else {
            Some(self.default_session.as_ref().clone())
        };

        if let Ok(windows) = self.list_windows(state).await {
            if let Some(default_name) = session_name.as_deref() {
                if let Some(window) = windows.iter().find(|window| window.name == default_name) {
                    cwd = if window.cwd.is_empty() {
                        cwd
                    } else {
                        window.cwd.clone()
                    };
                    session_name = Some(window.name.clone());
                }
            } else if let Some(active_window) = windows.iter().find(|window| window.active) {
                session_name = Some(active_window.name.clone());
                if !active_window.cwd.is_empty() {
                    cwd = active_window.cwd.clone();
                }
            }
        }

        (cwd, session_name)
    }

    pub(super) async fn resolve_upload_directory(&self, state: &AppState) -> String {
        match self.list_windows(state).await {
            Ok(windows) => windows
                .into_iter()
                .find(|window| window.active)
                .map(|window| window.cwd)
                .filter(|cwd| !cwd.is_empty())
                .unwrap_or_else(|| state.workspace_root.as_ref().clone()),
            Err(_) => state.workspace_root.as_ref().clone(),
        }
    }

    pub(super) async fn run_prompt(
        &self,
        state: Arc<AppState>,
        chat_id: i64,
        prompt: String,
        cwd: String,
        session_name: Option<String>,
    ) {
        let display_session_name = session_name
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "default".to_string());
        let task_session_name = session_name
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "telegram".to_string());
        let progress_message_id = self
            .send_message(
                chat_id,
                &telegram_progress_message(&display_session_name, None),
            )
            .await;

        let handle = match state
            .task_manager
            .run_task(
                prompt.clone(),
                cwd,
                TaskRunOptions {
                    session_name: task_session_name,
                    source: "telegram".to_string(),
                    tmux_session: state.default_tmux_session.as_ref().clone(),
                    profile: None,
                },
            )
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                let message = telegram_done_message(
                    &display_session_name,
                    Some(1),
                    &truncate_head_with_notice(&error, 3_800),
                );
                if let Some(message_id) = progress_message_id {
                    self.edit_message(chat_id, message_id, &message).await;
                } else {
                    let _ = self.send_message(chat_id, &message).await;
                }
                return;
            }
        };

        let task_id = handle.task_id.clone();
        let mut receiver = handle.receiver;
        let mut output = String::new();
        let mut error_output = String::new();
        let mut progress_interval =
            tokio::time::interval(Duration::from_millis(TELEGRAM_RUNNING_INTERVAL_MS));

        loop {
            tokio::select! {
                _ = progress_interval.tick() => {
                    let preview = if output.is_empty() { error_output.trim() } else { output.trim() };
                    if preview.is_empty() {
                        continue;
                    }
                    if let Some(message_id) = progress_message_id {
                        self.edit_message(
                            chat_id,
                            message_id,
                            &telegram_progress_message(
                                &display_session_name,
                                Some(&truncate_tail(preview, 3_000)),
                            ),
                        ).await;
                    }
                    let _ = state.task_manager.update_task(
                        &task_id,
                        json!({
                            "output": truncate_tail(&output, MAX_TASK_OUTPUT_LENGTH),
                            "error": truncate_tail(&error_output, MAX_TASK_ERROR_LENGTH),
                        }),
                    ).await;
                }
                maybe_frame = receiver.recv() => {
                    let Some(frame) = maybe_frame else {
                        break;
                    };

                    match frame.event.as_str() {
                        "output" => {
                            if let Some(chunk) = frame.payload.get("chunk").and_then(Value::as_str) {
                                output.push_str(chunk);
                            }
                        }
                        "error" => {
                            if let Some(chunk) = frame.payload.get("chunk").and_then(Value::as_str) {
                                error_output.push_str(chunk);
                            }
                        }
                        "done" => {
                            let exit_code = frame
                                .payload
                                .get("exitCode")
                                .and_then(Value::as_i64)
                                .map(|value| value as i32);
                            let result = if !output.trim().is_empty() {
                                output.trim().to_string()
                            } else if !error_output.trim().is_empty() {
                                error_output.trim().to_string()
                            } else {
                                "(无输出)".to_string()
                            };
                            let message = telegram_done_message(
                                &display_session_name,
                                exit_code,
                                &truncate_head_with_notice(&result, 3_800),
                            );
                            if let Some(message_id) = progress_message_id {
                                self.edit_message(chat_id, message_id, &message).await;
                            } else {
                                let _ = self.send_message(chat_id, &message).await;
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    pub(super) async fn list_windows(
        &self,
        state: &AppState,
    ) -> Result<Vec<TelegramWindow>, String> {
        let payload = state
            .runtime_manager
            .session_management_request(
                "listProjectChannels",
                json!({ "projectName": state.default_tmux_session.as_ref() }),
            )
            .await?;

        let channels = payload
            .get("channels")
            .and_then(Value::as_array)
            .ok_or_else(|| "failed to list project channels".to_string())?;

        Ok(channels
            .iter()
            .map(|channel| TelegramWindow {
                index: json_value_to_string(channel.get("index"))
                    .unwrap_or_else(|| "0".to_string()),
                name: channel
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                cwd: channel
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                active: channel
                    .get("active")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
            .collect())
    }

    pub(super) async fn send_message(&self, chat_id: i64, text: &str) -> Option<i64> {
        self.send_telegram_message(
            "sendMessage",
            json!({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "Markdown",
            }),
        )
        .await
        .and_then(|payload| {
            payload
                .get("result")
                .and_then(|result| result.get("message_id"))
                .and_then(Value::as_i64)
        })
    }

    pub(super) async fn edit_message(&self, chat_id: i64, message_id: i64, text: &str) {
        let _ = self
            .send_telegram_message(
                "editMessageText",
                json!({
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": text,
                    "parse_mode": "Markdown",
                }),
            )
            .await;
    }

    pub(super) async fn send_telegram_message(
        &self,
        method: &str,
        payload: Value,
    ) -> Option<Value> {
        if self.bot_token.is_empty() {
            return None;
        }

        let response = self
            .client
            .post(self.telegram_api_url(method))
            .json(&payload)
            .send()
            .await;
        let Ok(response) = response else {
            return None;
        };
        let text = response.text().await.ok()?;
        serde_json::from_str::<Value>(&text).ok()
    }

    pub(super) async fn download_file(
        &self,
        file_id: &str,
        dest_dir: &str,
        filename: &str,
    ) -> Result<TelegramDownloadedFile, String> {
        let raw = self
            .client
            .get(self.telegram_api_url("getFile"))
            .query(&[("file_id", file_id)])
            .send()
            .await
            .map_err(|error| error.to_string())?
            .text()
            .await
            .map_err(|error| error.to_string())?;
        let payload = serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("invalid getFile response: {error}"))?;
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            let description = payload
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("getFile failed: {description}"));
        }

        let file_path = payload
            .get("result")
            .and_then(|result| result.get("file_path"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "telegram file path missing".to_string())?;
        let bytes = self
            .client
            .get(self.telegram_file_url(file_path))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .bytes()
            .await
            .map_err(|error| error.to_string())?;

        let safe_filename = sanitize_telegram_filename(filename, "telegram-file");
        fs::create_dir_all(dest_dir)
            .await
            .map_err(|error| error.to_string())?;
        let path = Path::new(dest_dir).join(safe_filename);
        fs::write(&path, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        Ok(TelegramDownloadedFile {
            path: path_to_string(&path),
            size: bytes.len(),
        })
    }

    pub(super) fn telegram_api_url(&self, method: &str) -> String {
        format!("{}/bot{}/{}", self.api_base_url, self.bot_token, method)
    }

    pub(super) fn telegram_file_url(&self, file_path: &str) -> String {
        format!(
            "{}/file/bot{}/{}",
            self.api_base_url,
            self.bot_token,
            file_path.trim_start_matches('/')
        )
    }
}

pub(super) struct TelegramDownloadedFile {
    pub(super) path: String,
    pub(super) size: usize,
}
