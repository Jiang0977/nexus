use super::*;

const DEFAULT_WS_HEARTBEAT_MS: u64 = 10_000;

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
    let (key, tmux_redraw) = match state
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

    // Binary frames are protocol controls; text frames remain unmodified PTY data.
    // The event subscription predates attach, so this precedes all buffered redraw output.
    if tmux_redraw && query.terminal_protocol.as_deref() == Some("2") {
        let control =
            json!({"type": "terminal-state", "version": 1, "replayPolicy": "tmux-redraw"});
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
