use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use anyhow::{Context, Result};

use crate::codex_replay::model::ActivationEvent;

pub fn load_activation_journal(path: &Path) -> Result<Vec<ActivationEvent>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = fs::File::open(path)
        .with_context(|| format!("failed opening activation journal {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();

    for (index, line) in reader.lines().enumerate() {
        let line = line.with_context(|| {
            format!("failed reading line {} from {}", index + 1, path.display())
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let event = serde_json::from_str::<ActivationEvent>(trimmed).with_context(|| {
            format!(
                "failed parsing activation journal line {} from {}",
                index + 1,
                path.display()
            )
        })?;
        if event.event_type == "activation" {
            events.push(event);
        }
    }

    events.sort_by(|lhs, rhs| lhs.timestamp.cmp(&rhs.timestamp));
    Ok(events)
}

#[cfg(test)]
fn append_activation_event(path: &Path, event: &ActivationEvent) -> Result<()> {
    use std::fs::OpenOptions;
    use std::io::Write;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed creating journal directory {}", parent.display()))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed opening activation journal {}", path.display()))?;

    serde_json::to_writer(&mut file, event)
        .with_context(|| format!("failed encoding activation event for {}", path.display()))?;
    file.write_all(b"\n")
        .with_context(|| format!("failed appending newline to {}", path.display()))?;
    file.flush()
        .with_context(|| format!("failed flushing activation journal {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use tempfile::tempdir;

    use super::{append_activation_event, load_activation_journal};
    use crate::codex_replay::model::ActivationEvent;

    #[test]
    fn journal_round_trip_preserves_activation_order() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("activation.jsonl");

        append_activation_event(
            &path,
            &ActivationEvent::new(
                Utc.with_ymd_and_hms(2026, 4, 11, 8, 0, 0).unwrap(),
                "codex".into(),
                "provider-primary".into(),
                None,
                Some("manual".into()),
                false,
                false,
                false,
            ),
        )
        .expect("append");

        let loaded = load_activation_journal(&path).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].provider_id.as_deref(), Some("codex"));
        assert_eq!(loaded[0].account_id.as_deref(), Some("provider-primary"));
    }
}
