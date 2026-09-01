pub fn sanitize_workspace_upload_filename(original_name: &str) -> String {
    original_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '.'
                || character == '_'
                || character == '-'
            {
                character
            } else {
                '_'
            }
        })
        .collect()
}

pub fn sanitize_managed_upload_filename(original_name: &str) -> String {
    original_name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/' => '_',
            _ if character.is_control() => '_',
            _ => character,
        })
        .collect()
}

pub fn sanitize_project_name(raw: Option<String>) -> Option<String> {
    let trimmed = raw.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        return None;
    }

    let sanitized: String = trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect();

    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

pub fn sanitize_window_name(raw: Option<String>) -> Option<String> {
    let trimmed = raw.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        return None;
    }

    let sanitized: String = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .take(50)
        .collect();

    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

pub fn truncate_head(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub fn truncate_tail(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }

    value
        .chars()
        .skip(char_count.saturating_sub(max_chars))
        .collect()
}

/// Conservative Unicode-character cap for optional output-snapshot tail limits.
pub const MAX_OUTPUT_SNAPSHOT_TAIL_CHARS: usize = 16_384;

pub fn clamp_output_snapshot_tail_chars(requested: u32) -> usize {
    if requested == 0 {
        MAX_OUTPUT_SNAPSHOT_TAIL_CHARS
    } else {
        (requested as usize).min(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS)
    }
}

pub fn parse_output_snapshot_tail_chars(raw: Option<&str>) -> Option<usize> {
    let raw = raw?;
    let value = raw.trim();
    if value.is_empty() {
        return Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS);
    }
    match value.parse::<u32>() {
        Ok(parsed) => Some(clamp_output_snapshot_tail_chars(parsed)),
        Err(_) => Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS),
    }
}

pub fn truncate_head_with_notice(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }
    let head: String = value.chars().take(max_chars).collect();
    format!("{head}\n\n…(输出已截断)")
}

pub fn truncate_websocket_close_reason(reason: &str) -> String {
    reason.chars().take(120).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_OUTPUT_SNAPSHOT_TAIL_CHARS, clamp_output_snapshot_tail_chars,
        parse_output_snapshot_tail_chars, sanitize_managed_upload_filename, sanitize_project_name,
        sanitize_window_name, sanitize_workspace_upload_filename, truncate_head,
        truncate_head_with_notice, truncate_tail, truncate_websocket_close_reason,
    };

    #[test]
    fn sanitizes_upload_filenames() {
        assert_eq!(
            sanitize_workspace_upload_filename("report?.txt"),
            "report_.txt"
        );
        assert_eq!(
            sanitize_managed_upload_filename("capture?.png"),
            "capture_.png"
        );
    }

    #[test]
    fn sanitizes_project_and_window_names() {
        assert_eq!(
            sanitize_project_name(Some("demo.project_2".to_string())),
            Some("demoproject_2".to_string())
        );
        assert_eq!(
            sanitize_window_name(Some("notes 2".to_string())),
            Some("notes-2".to_string())
        );
    }

    #[test]
    fn truncates_strings_without_panicking() {
        assert_eq!(truncate_head("abcdef", 3), "abc");
        assert_eq!(truncate_tail("abcdef", 3), "def");
        assert_eq!(truncate_tail("a中🙂z", 2), "🙂z");
        assert_eq!(
            truncate_head_with_notice("abcdef", 3),
            "abc\n\n…(输出已截断)"
        );
        assert_eq!(
            truncate_websocket_close_reason(&"a".repeat(130))
                .chars()
                .count(),
            120
        );
    }

    #[test]
    fn output_snapshot_tail_chars_omit_valid_clamp_and_invalid() {
        assert_eq!(parse_output_snapshot_tail_chars(None), None);
        assert_eq!(
            parse_output_snapshot_tail_chars(Some("")),
            Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS)
        );
        assert_eq!(
            parse_output_snapshot_tail_chars(Some("  ")),
            Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS)
        );
        assert_eq!(parse_output_snapshot_tail_chars(Some("7")), Some(7));
        assert_eq!(parse_output_snapshot_tail_chars(Some("4096")), Some(4096));
        assert_eq!(
            parse_output_snapshot_tail_chars(Some("20000")),
            Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS)
        );
        assert_eq!(
            parse_output_snapshot_tail_chars(Some("0")),
            Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS)
        );
        assert_eq!(
            parse_output_snapshot_tail_chars(Some("abc")),
            Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS)
        );
        assert_eq!(
            parse_output_snapshot_tail_chars(Some("-1")),
            Some(MAX_OUTPUT_SNAPSHOT_TAIL_CHARS)
        );
        assert_eq!(
            clamp_output_snapshot_tail_chars(0),
            MAX_OUTPUT_SNAPSHOT_TAIL_CHARS
        );
        assert_eq!(clamp_output_snapshot_tail_chars(8), 8);
        assert_eq!(
            clamp_output_snapshot_tail_chars(50_000),
            MAX_OUTPUT_SNAPSHOT_TAIL_CHARS
        );
    }
}
