use super::*;

const DEFAULT_WS_HEARTBEAT_MS: u64 = 10_000;

fn terminal_scroll_profile(bytes: &[u8], session: &str, window: u32) -> Option<&'static str> {
    if bytes.len() > 65536 {
        return None;
    }
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if value.get("version")?.as_u64()? != 1 {
        return None;
    }
    let entries = value.get("channels")?.as_array()?;
    let mut matched = entries.iter().filter(|entry| {
        entry.get("session").and_then(Value::as_str) == Some(session)
            && entry.get("windowIndex").and_then(Value::as_u64) == Some(window.into())
    });
    let entry = matched.next()?;
    if matched.next().is_some() {
        return None;
    }
    match entry.get("scroll").and_then(Value::as_str)? {
        "auto" => Some("auto"),
        "application-sgr" => Some("application-sgr"),
        _ => None,
    }
}

async fn read_terminal_scroll_profile(
    path: &Path,
    session: &str,
    window: u32,
) -> Option<&'static str> {
    use tokio::io::AsyncReadExt;
    let metadata = tokio::fs::metadata(path).await.ok()?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return None;
    }
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut bytes = Vec::new();
    file.take(65537).read_to_end(&mut bytes).await.ok()?;
    terminal_scroll_profile(&bytes, session, window)
}

fn websocket_heartbeat_interval() -> Duration {
    let milliseconds = env::var("NEXUS_WS_HEARTBEAT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_WS_HEARTBEAT_MS);
    Duration::from_millis(milliseconds)
}

pub(super) async fn handle_pty_websocket(
    mut socket: WebSocket,
    state: Arc<AppState>,
    query: WsQuery,
) {
    let token = query.token.unwrap_or_default();
    if token.is_empty() || !validate_auth_token::<AuthClaims>(&token, state.jwt_secret.as_ref()) {
        let _ = send_websocket_close(&mut socket, 4001, "unauthorized").await;
        return;
    }

    let session_name = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let window_index = query
        .window
        .as_deref()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let profile_path = state
        .project_defaults_file
        .with_file_name("terminal-profiles.json");
    let scroll_profile =
        read_terminal_scroll_profile(&profile_path, &session_name, window_index).await;
    let Some(mut event_receiver) = state.runtime_manager.pty_broker_subscribe_events().await else {
        let _ = send_websocket_close(
            &mut socket,
            4004,
            "pty broker runtime executable not configured",
        )
        .await;
        return;
    };
    let connection_id = format!(
        "broker_conn_{}",
        state.ws_connection_counter.fetch_add(1, Ordering::SeqCst) + 1
    );

    let initial_cols = query
        .cols
        .as_deref()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0);
    let initial_rows = query
        .rows
        .as_deref()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0);
    let (key, tmux_redraw, native_snapshot) = match state
        .runtime_manager
        .pty_broker_request(
            "attachConnection",
            json!({
                "connectionId": connection_id.clone(),
                "session": session_name,
                "windowIndex": window_index,
                "cols": initial_cols,
                "rows": initial_rows,
            }),
        )
        .await
    {
        Ok(Value::Object(payload)) => match payload.get("key").and_then(Value::as_str) {
            Some(key) if !key.is_empty() => (
                key.to_string(),
                payload.get("replayPolicy").and_then(Value::as_str) == Some("tmux-redraw"),
                payload.get("replayPolicy").and_then(Value::as_str) == Some("native-snapshot"),
            ),
            _ => {
                let _ =
                    send_websocket_close(&mut socket, 4004, "attach connection missing key").await;
                return;
            }
        },
        Ok(_) => {
            let _ = send_websocket_close(&mut socket, 4004, "attach connection failed").await;
            return;
        }
        Err(error) => {
            let _ = send_websocket_close(&mut socket, 4004, &error).await;
            return;
        }
    };

    if native_snapshot && query.terminal_protocol.as_deref() != Some("2") {
        let _ = send_websocket_close(
            &mut socket,
            4002,
            "native terminal requires protocol 2; refresh the page",
        )
        .await;
        let _ = state
            .runtime_manager
            .pty_broker_notify(
                "errorConnection",
                json!({"connectionId": connection_id, "key": key}),
            )
            .await;
        return;
    }

    // Binary frames are protocol controls; text frames remain unmodified PTY data.
    // The event subscription predates attach, so this precedes all buffered redraw output.
    if tmux_redraw && query.terminal_protocol.as_deref() == Some("2") {
        let mut control =
            json!({"type": "terminal-state", "version": 1, "replayPolicy": "tmux-redraw"});
        if let Some(profile) = scroll_profile {
            control["scrollProfile"] = json!(profile);
        }
        if socket
            .send(Message::Binary(control.to_string().into_bytes().into()))
            .await
            .is_err()
        {
            let _ = state
                .runtime_manager
                .pty_broker_notify(
                    "errorConnection",
                    json!({"connectionId": connection_id, "key": key}),
                )
                .await;
            return;
        }
    }

    let disconnect_notify: &'static str;
    let mut heartbeat = tokio::time::interval(websocket_heartbeat_interval());
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;

    loop {
        tokio::select! {
            maybe_message = socket.recv() => {
                match maybe_message {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(error) = state.runtime_manager.pty_broker_notify(
                            "handleConnectionMessage",
                            json!({
                                "connectionId": connection_id.clone(),
                                "key": key.clone(),
                                "rawMessage": text.to_string(),
                            }),
                        ).await {
                            disconnect_notify = "errorConnection";
                            let _ = send_websocket_close(&mut socket, 1011, &error).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if let Err(error) = state.runtime_manager.pty_broker_notify(
                            "handleConnectionMessage",
                            json!({
                                "connectionId": connection_id.clone(),
                                "key": key.clone(),
                                "rawBytes": data.to_vec(),
                            }),
                        ).await {
                            disconnect_notify = "errorConnection";
                            let _ = send_websocket_close(&mut socket, 1011, &error).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        let _ = timeout(Duration::from_secs(1), socket.recv()).await;
                        disconnect_notify = "closeConnection";
                        break;
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Err(error)) => {
                        eprintln!("WebSocket error: {error}");
                        disconnect_notify = "errorConnection";
                        break;
                    }
                    None => {
                        disconnect_notify = "closeConnection";
                        break;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    disconnect_notify = "errorConnection";
                    break;
                }
            }
            runtime_event = event_receiver.recv() => {
                match runtime_event {
                    Ok(event) => match event.event.as_str() {
                        "output" => {
                            if event
                                .params
                                .get("connectionId")
                                .and_then(Value::as_str)
                                != Some(connection_id.as_str())
                            {
                                continue;
                            }

                            let data = event
                                .params
                                .get("data")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if let Some(geometry) = event.params.get("nativeState")
                                && query.terminal_protocol.as_deref() == Some("2")
                            {
                                let control = json!({"type": "native-state", "version": 1, "replayPolicy": "native-snapshot", "cols": geometry.get("cols"), "rows": geometry.get("rows"), "unicodeVersion": geometry.get("unicodeVersion"), "scrollProfile": scroll_profile});
                                if socket.send(Message::Binary(control.to_string().into_bytes().into())).await.is_err() {
                                    disconnect_notify = "errorConnection";
                                    break;
                                }
                            }
                            if socket.send(Message::Text(data.into())).await.is_err() {
                                disconnect_notify = "errorConnection";
                                break;
                            }
                        }
                        "connectionClosed" => {
                            if event.params.get("connectionId").and_then(Value::as_str) != Some(connection_id.as_str()) {
                                continue;
                            }
                            disconnect_notify = "errorConnection";
                            let _ = send_websocket_close(&mut socket, 1011, "terminal client exited").await;
                            break;
                        }
                        "fatal" => {
                            disconnect_notify = "errorConnection";
                            let reason = event
                                .params
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("pty broker unavailable");
                            let _ = send_websocket_close(&mut socket, 1011, reason).await;
                            break;
                        }
                        _ => {}
                    },
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        disconnect_notify = "errorConnection";
                        let _ = send_websocket_close(&mut socket, 1013, "terminal output lost; reconnect required").await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        disconnect_notify = "errorConnection";
                        let _ = send_websocket_close(&mut socket, 1011, "pty broker unavailable")
                            .await;
                        break;
                    }
                }
            }
        }
    }

    let _ = state
        .runtime_manager
        .pty_broker_notify(
            disconnect_notify,
            json!({
                "connectionId": connection_id.clone(),
                "key": key.clone(),
            }),
        )
        .await;
}

#[cfg(test)]
mod terminal_profile_tests {
    use super::terminal_scroll_profile;

    #[test]
    fn profile_requires_explicit_exact_channel_and_valid_schema() {
        let config = br#"{"version":1,"channels":[{"session":"demo","windowIndex":2,"scroll":"application-sgr"}]}"#;
        assert_eq!(
            terminal_scroll_profile(config, "demo", 2),
            Some("application-sgr")
        );
        assert_eq!(terminal_scroll_profile(config, "demo", 1), None);
        assert_eq!(terminal_scroll_profile(config, "Grok demo", 2), None);
        assert_eq!(
            terminal_scroll_profile(br#"{"version":2,"channels":[]}"#, "demo", 2),
            None
        );
        assert_eq!(terminal_scroll_profile(b"not json", "demo", 2), None);
        assert_eq!(terminal_scroll_profile(&vec![b' '; 65537], "demo", 2), None);
    }

    #[test]
    fn duplicate_or_unknown_profiles_do_not_guess_routing() {
        let duplicate = br#"{"version":1,"channels":[{"session":"a","windowIndex":0,"scroll":"auto"},{"session":"a","windowIndex":0,"scroll":"application-sgr"}]}"#;
        assert_eq!(terminal_scroll_profile(duplicate, "a", 0), None);
        let unknown =
            br#"{"version":1,"channels":[{"session":"a","windowIndex":0,"scroll":"grok"}]}"#;
        assert_eq!(terminal_scroll_profile(unknown, "a", 0), None);
    }
}
