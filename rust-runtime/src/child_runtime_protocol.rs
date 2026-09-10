use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};

#[derive(Debug, PartialEq)]
pub enum RuntimeMessage {
    Request {
        id: String,
        method: String,
        params: Value,
    },
    Notify {
        method: String,
        params: Value,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeControl {
    Continue,
    Shutdown,
}

#[derive(Clone)]
pub struct ProtocolOutput {
    tx: SyncSender<String>,
}

pub struct StdioProtocol {
    writer: JsonLineWriter,
}

#[derive(Deserialize)]
struct WireMessage {
    kind: String,
    id: Option<String>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct ResponseMessage<T>
where
    T: Serialize,
{
    kind: &'static str,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ResponseError>,
}

#[derive(Serialize)]
struct ResponseError {
    message: String,
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct ProtocolResponse {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Value,
    error: Option<ResponseErrorPayload>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct ResponseErrorPayload {
    message: String,
}

#[derive(Serialize)]
struct EventMessage<'a, T>
where
    T: Serialize,
{
    kind: &'static str,
    event: &'a str,
    params: T,
}

pub struct JsonLineWriter {
    writer: JoinHandle<()>,
}

impl ProtocolOutput {
    pub fn success<T>(&self, id: String, result: T)
    where
        T: Serialize,
    {
        self.send(&ResponseMessage {
            kind: "response",
            id,
            ok: true,
            result: Some(result),
            error: None,
        });
    }

    pub fn failure(&self, id: String, error: impl Into<String>) {
        self.send(&ResponseMessage::<Value> {
            kind: "response",
            id,
            ok: false,
            result: None,
            error: Some(ResponseError {
                message: error.into(),
            }),
        });
    }

    pub fn event<T>(&self, event: &str, params: T)
    where
        T: Serialize,
    {
        self.send(&EventMessage {
            kind: "event",
            event,
            params,
        });
    }

    pub fn forward_json_line(&self, line: &str) {
        if serde_json::from_str::<Value>(line).is_ok() {
            let _ = self.tx.send(line.to_string());
        }
    }

    fn send<T>(&self, value: &T)
    where
        T: Serialize,
    {
        if let Ok(line) = serde_json::to_string(value) {
            let _ = self.tx.send(line);
        }
    }
}

impl ProtocolResponse {
    pub fn into_result(self, fallback_error: impl FnOnce() -> String) -> Result<Value, String> {
        if self.ok {
            Ok(self.result)
        } else {
            Err(self
                .error
                .map(|error| error.message)
                .unwrap_or_else(fallback_error))
        }
    }
}

impl JsonLineWriter {
    pub fn start<W>(mut writer: W) -> (Self, ProtocolOutput)
    where
        W: Write + Send + 'static,
    {
        // Backpressure the producer instead of accumulating an unbounded stream
        // of native checkpoints when the pipe/socket consumer is slow.
        let (tx, rx) = mpsc::sync_channel::<String>(16);
        let writer = thread::spawn(move || {
            while let Ok(line) = rx.recv() {
                if write_line(&mut writer, &line).is_err() {
                    break;
                }
            }
        });
        (Self { writer }, ProtocolOutput { tx })
    }

    pub fn finish(self) {
        let _ = self.writer.join();
    }
}

impl StdioProtocol {
    pub fn start() -> (Self, ProtocolOutput) {
        let (writer, output) = JsonLineWriter::start(io::stdout());
        (Self { writer }, output)
    }

    pub fn run<F>(&mut self, mut dispatch: F)
    where
        F: FnMut(RuntimeMessage) -> RuntimeControl,
    {
        let stdin = io::stdin();
        dispatch_lines(BufReader::new(stdin.lock()), &mut dispatch);
    }

    pub fn finish(self) {
        self.writer.finish();
    }
}

pub fn dispatch_lines<R, F>(reader: R, dispatch: &mut F)
where
    R: BufRead,
    F: FnMut(RuntimeMessage) -> RuntimeControl,
{
    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let message = match parse_message(&line) {
            Ok(Some(value)) => value,
            Ok(None) => continue,
            Err(error) => {
                eprintln!("invalid request: {error}");
                continue;
            }
        };
        if dispatch(message) == RuntimeControl::Shutdown {
            break;
        }
    }
}

pub fn parse_message(line: &str) -> Result<Option<RuntimeMessage>, serde_json::Error> {
    let message: WireMessage = serde_json::from_str(line)?;
    Ok(match message.kind.as_str() {
        "request" => Some(RuntimeMessage::Request {
            id: message.id.unwrap_or_default(),
            method: message.method.unwrap_or_default(),
            params: message.params,
        }),
        "notify" => Some(RuntimeMessage::Notify {
            method: message.method.unwrap_or_default(),
            params: message.params,
        }),
        _ => None,
    })
}

pub fn parse_response(line: &str) -> Result<Option<ProtocolResponse>, serde_json::Error> {
    let value: Value = serde_json::from_str(line)?;
    if value.get("kind").and_then(Value::as_str) != Some("response") {
        return Ok(None);
    }
    serde_json::from_value(value).map(Some)
}

pub fn write_request(
    writer: &mut impl Write,
    id: &str,
    method: &str,
    params: Value,
) -> io::Result<()> {
    write_value(
        writer,
        &serde_json::json!({
            "kind": "request",
            "id": id,
            "method": method,
            "params": params,
        }),
    )
}

pub fn write_notify(writer: &mut impl Write, method: &str, params: Value) -> io::Result<()> {
    write_value(
        writer,
        &serde_json::json!({
            "kind": "notify",
            "method": method,
            "params": params,
        }),
    )
}

pub fn write_value(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    let line = serde_json::to_string(value).map_err(io::Error::other)?;
    write_line(writer, &line)
}

pub fn write_line(writer: &mut impl Write, line: &str) -> io::Result<()> {
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedBuffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("buffer").extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn dispatches_requests_and_notifications_until_shutdown() {
        let input = [
            "",
            r#"{"kind":"request","id":"1","method":"ready","params":{}}"#,
            r#"{"kind":"notify","method":"close","params":{"id":"c1"}}"#,
            r#"{"kind":"request","id":"2","method":"shutdown","params":{}}"#,
            r#"{"kind":"request","id":"3","method":"ignored","params":{}}"#,
        ]
        .join("\n");
        let mut messages = Vec::new();

        dispatch_lines(Cursor::new(input), &mut |message| {
            let shutdown = matches!(
                &message,
                RuntimeMessage::Request { method, .. } if method == "shutdown"
            );
            messages.push(message);
            if shutdown {
                RuntimeControl::Shutdown
            } else {
                RuntimeControl::Continue
            }
        });

        assert_eq!(messages.len(), 3);
        assert!(matches!(
            &messages[0],
            RuntimeMessage::Request { id, method, .. } if id == "1" && method == "ready"
        ));
        assert!(matches!(
            &messages[1],
            RuntimeMessage::Notify { method, params } if method == "close" && params["id"] == "c1"
        ));
    }

    #[test]
    fn output_serializes_shared_response_and_event_envelopes() {
        let (tx, rx) = mpsc::sync_channel(16);
        let output = ProtocolOutput { tx };

        output.success("1".to_string(), json!({ "ready": true }));
        output.failure("2".to_string(), "boom");
        output.event("chunk", json!({ "value": "x" }));

        let lines = [
            rx.recv().expect("success"),
            rx.recv().expect("failure"),
            rx.recv().expect("event"),
        ];
        let values = lines
            .iter()
            .map(|line| serde_json::from_str::<Value>(line).expect("json"))
            .collect::<Vec<_>>();
        assert_eq!(values[0]["kind"], "response");
        assert_eq!(values[0]["ok"], true);
        assert_eq!(values[1]["error"]["message"], "boom");
        assert_eq!(values[2]["event"], "chunk");
    }

    #[test]
    fn request_response_codec_is_transport_neutral() {
        let mut wire = Vec::new();
        write_request(&mut wire, "r1", "ready", json!({ "probe": true })).expect("write request");
        let request = parse_message(std::str::from_utf8(&wire).expect("utf8").trim())
            .expect("parse request")
            .expect("request");
        assert!(matches!(
            request,
            RuntimeMessage::Request { id, method, params }
                if id == "r1" && method == "ready" && params["probe"] == true
        ));

        let response = parse_response(
            r#"{"kind":"response","id":"r1","ok":false,"error":{"message":"denied"}}"#,
        )
        .expect("parse response")
        .expect("response");
        assert_eq!(
            response.into_result(|| "fallback".to_string()),
            Err("denied".to_string())
        );
    }

    #[test]
    fn json_line_writer_uses_the_same_output_contract_for_any_transport() {
        let buffer = SharedBuffer::default();
        let observed = buffer.clone();
        let (writer, output) = JsonLineWriter::start(buffer);
        output.success("1".to_string(), json!({ "ready": true }));
        output.event("output", json!({ "data": "hello" }));
        drop(output);
        writer.finish();

        let bytes = observed.0.lock().expect("buffer").clone();
        let lines = std::str::from_utf8(&bytes)
            .expect("utf8")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("json"))
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["kind"], "response");
        assert_eq!(lines[1]["kind"], "event");
    }

    #[test]
    fn slow_transport_backpressures_after_sixteen_queued_messages() {
        struct GatedWriter {
            gate: Option<mpsc::Receiver<()>>,
            started: mpsc::SyncSender<()>,
        }
        impl Write for GatedWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if let Some(gate) = self.gate.take() {
                    let _ = self.started.send(());
                    let _ = gate.recv();
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let (release, gate) = mpsc::sync_channel(1);
        let (started, writing) = mpsc::sync_channel(1);
        let (writer, output) = JsonLineWriter::start(GatedWriter {
            gate: Some(gate),
            started,
        });
        output.event("first", json!({}));
        writing.recv().unwrap();
        for _ in 0..16 {
            output.tx.try_send("{}".into()).unwrap();
        }
        assert!(matches!(
            output.tx.try_send("{}".into()),
            Err(mpsc::TrySendError::Full(_))
        ));
        release.send(()).unwrap();
        drop(output);
        writer.finish();
    }
}
