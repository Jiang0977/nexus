use super::*;

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

    let key = match state
        .runtime_manager
        .pty_broker_request(
            "attachConnection",
            json!({
                "connectionId": connection_id.clone(),
                "session": session_name,
                "windowIndex": window_index,
            }),
        )
        .await
    {
        Ok(Value::Object(payload)) => match payload.get("key").and_then(Value::as_str) {
            Some(key) if !key.is_empty() => key.to_string(),
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

    let mut disconnect_notify: Option<&'static str> = None;

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
                            disconnect_notify = Some("errorConnection");
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
                                "rawMessage": String::from_utf8_lossy(&data).to_string(),
                            }),
                        ).await {
                            disconnect_notify = Some("errorConnection");
                            let _ = send_websocket_close(&mut socket, 1011, &error).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        disconnect_notify = Some("closeConnection");
                        break;
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Err(error)) => {
                        eprintln!("WebSocket error: {error}");
                        disconnect_notify = Some("errorConnection");
                        break;
                    }
                    None => {
                        disconnect_notify = Some("closeConnection");
                        break;
                    }
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
                                disconnect_notify = Some("errorConnection");
                                break;
                            }
                        }
                        "fatal" => {
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
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        let _ = send_websocket_close(&mut socket, 1011, "pty broker unavailable")
                            .await;
                        break;
                    }
                }
            }
        }
    }

    if let Some(method) = disconnect_notify {
        let _ = state
            .runtime_manager
            .pty_broker_notify(
                method,
                json!({
                    "connectionId": connection_id.clone(),
                    "key": key.clone(),
                }),
            )
            .await;
    }
}
