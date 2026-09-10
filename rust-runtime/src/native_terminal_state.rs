//! Bounded native PTY checkpoint. Live output remains raw; snapshots restore
//! both buffers, saved cursor, margins, tabs, attributes and parser continuation.
//! avt deliberately excludes input handling, so negotiated input modes are
//! observed separately with vte (never application names or output keywords).
use std::collections::BTreeSet;

pub(crate) const MAX_COLS: u16 = 500;
pub(crate) const MAX_ROWS: u16 = 200;
const HISTORY_LINES: usize = 200;

pub(crate) struct NativeTerminalState {
    terminal: avt::Vt,
    parser: vte::Parser,
    modes: InputModes,
}

impl NativeTerminalState {
    pub(crate) fn new(cols: u16, rows: u16) -> Self {
        Self {
            terminal: avt::Vt::builder()
                .size(cols.into(), rows.into())
                .scrollback_limit(HISTORY_LINES)
                .build(),
            parser: vte::Parser::new(),
            modes: InputModes::default(),
        }
    }

    pub(crate) fn feed(&mut self, data: &str) {
        if self.modes.overflow {
            return;
        }
        for byte in data.bytes() {
            if byte == 0x1b || (!self.modes.pending.is_empty() && byte >= 0x20) {
                if self.modes.pending.len() >= 4096 {
                    self.modes.overflow = true;
                    return;
                }
                self.modes.pending.push(byte);
            }
            self.parser.advance(&mut self.modes, &[byte]);
        }
        if !self.modes.overflow {
            self.terminal.feed_str(data);
            self.modes.overflow = !self.terminal.recovery_safe();
        }
    }

    pub(crate) fn size(&self) -> (u16, u16) {
        let (cols, rows) = self.terminal.size();
        (cols as u16, rows as u16)
    }

    pub(crate) fn resize(&mut self, cols: u16, rows: u16) {
        self.terminal.resize(cols.into(), rows.into());
    }

    pub(crate) fn snapshot(&self) -> Result<String, String> {
        if self.modes.overflow {
            return Err(
                "Native terminal state exceeds safe recovery limits; create a new channel".into(),
            );
        }
        // Input state must precede dump: dump may end in an unfinished CSI,
        // which the next raw PTY chunk must complete without inserted bytes.
        let mut result = String::from("\x1bc");
        for mode in &self.modes.dec {
            result.push_str(&format!("\x1b[?{mode}h"));
        }
        if self.modes.keypad {
            result.push_str("\x1b=");
        }
        if !self.modes.title.is_empty() {
            result.push_str("\x1b]0;");
            result.push_str(&self.modes.title);
            result.push('\x07');
        }
        result.push_str(&self.terminal.dump_screen());
        result.push_str(&String::from_utf8_lossy(&self.modes.pending));
        if result.len() > 8 * 1024 * 1024 {
            return Err("Native terminal checkpoint exceeds 8 MiB; create a new channel".into());
        }
        Ok(result)
    }
}

#[derive(Default)]
struct InputModes {
    dec: BTreeSet<u16>,
    keypad: bool,
    title: String,
    pending: Vec<u8>,
    combining_run: usize,
    overflow: bool,
}

impl vte::Perform for InputModes {
    fn print(&mut self, ch: char) {
        self.pending.clear();
        if avt::char_width(ch) == 0 {
            self.combining_run += 1;
            if self.combining_run > 256 {
                self.overflow = true;
            }
        } else {
            self.combining_run = 0;
        }
    }

    fn execute(&mut self, byte: u8) {
        if matches!(byte, 0x18 | 0x1a) {
            self.pending.clear();
        }
        self.combining_run = 0;
    }

    fn unhook(&mut self) {
        self.pending.clear();
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        action: char,
    ) {
        self.pending.clear();
        self.combining_run = 0;
        if ignore {
            return;
        }
        if intermediates == [b'?'] && matches!(action, 'h' | 'l') {
            for param in params {
                if let [mode @ (9 | 66 | 1000 | 1002 | 1003 | 1004 | 1006 | 1016 | 2004 | 2026)] =
                    param
                {
                    if *mode == 66 {
                        self.keypad = action == 'h';
                        continue;
                    }
                    if matches!(*mode, 9 | 1000 | 1002 | 1003) {
                        self.dec
                            .retain(|mode| !matches!(*mode, 9 | 1000 | 1002 | 1003));
                    }
                    if matches!(*mode, 1006 | 1016) {
                        self.dec.retain(|mode| !matches!(*mode, 1006 | 1016));
                    }
                    if action == 'h' {
                        self.dec.insert(*mode);
                    } else {
                        self.dec.remove(mode);
                    }
                }
            }
        } else if intermediates == [b'!'] && action == 'p' {
            // xterm soft reset resets CoreService input flags, not mouse service.
            self.dec
                .retain(|mode| matches!(*mode, 9 | 1000 | 1002 | 1003 | 1006 | 1016));
            self.keypad = false;
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
        self.pending.clear();
        self.combining_run = 0;
        if ignore || !intermediates.is_empty() {
            return;
        }
        match byte {
            b'c' => *self = Self::default(),
            b'=' => self.keypad = true,
            b'>' => self.keypad = false,
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _: bool) {
        self.pending.clear();
        if params.len() == 2 && matches!(params[0], b"0" | b"2") {
            self.title = String::from_utf8_lossy(params[1])
                .chars()
                .filter(|ch| !ch.is_control())
                .take(256)
                .collect();
        }
        // Never replay OSC 52 clipboard effects or terminal queries.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_restores_fragmented_parser_and_continuation() {
        let mut state = NativeTerminalState::new(80, 24);
        state.feed("base\x1b[?1049h\x1b[2J\x1b[3;7H\x1b7saved\x1b[6;20r\x1b[38;2;1;");
        let mut restored = avt::Vt::new(80, 24);
        restored.feed_str(&state.snapshot().unwrap());
        let next = "2;3mCOLOR\x1b8continued\x1b[?1049l";
        state.feed(next);
        restored.feed_str(next);
        assert_eq!(restored.dump(), state.terminal.dump());
    }

    #[test]
    fn observes_only_complete_negotiated_modes_and_resets() {
        let mut state = NativeTerminalState::new(80, 24);
        state.feed("\x1b]0;Grok\x07\x1b[?1000;");
        assert!(state.modes.dec.is_empty());
        state.feed("1006;2004h\x1b=");
        assert_eq!(state.modes.dec, BTreeSet::from([1000, 1006, 2004]));
        assert!(state.snapshot().unwrap().contains("\x1b[?1006h"));
        state.feed("\x1b[?1000;1006l");
        assert_eq!(state.modes.dec, BTreeSet::from([2004]));
        state.feed("\x1bc");
        assert!(state.modes.dec.is_empty());
        assert!(!state.modes.keypad);
    }

    #[test]
    fn snapshots_preserve_partial_osc_without_replaying_completed_side_effects() {
        let mut state = NativeTerminalState::new(80, 24);
        state.feed("\x1b]52;c;ignored\x07\x1b]2;part");
        let snapshot = state.snapshot().unwrap();
        assert!(!snapshot.contains("52;c;"));
        assert!(snapshot.ends_with("\x1b]2;part"));
        state.feed("ial\x07");
        assert!(state.snapshot().unwrap().contains("\x1b]0;partial\x07"));
    }

    #[test]
    fn state_history_and_untrusted_sequences_have_limits() {
        let mut state = NativeTerminalState::new(MAX_COLS, MAX_ROWS);
        for _ in 0..1000 {
            state.feed("line\r\n");
        }
        assert!(state.terminal.lines().count() <= (MAX_ROWS as usize + HISTORY_LINES));
        assert!(state.snapshot().unwrap().len() < 2_000_000);
        state.feed(&format!("\x1b]2;{}", "a".repeat(5000)));
        assert!(state.snapshot().is_err());
        assert!(state.modes.pending.len() <= 4096);
        let mut state = NativeTerminalState::new(80, 24);
        state.feed(&format!("a{}", "\u{301}".repeat(257)));
        assert!(state.snapshot().is_err());
    }

    #[test]
    fn mouse_protocols_are_exclusive_and_soft_reset_preserves_mouse_service() {
        let mut state = NativeTerminalState::new(80, 24);
        state.feed("\x1b[?1003h\x1b[?1000h\x1b[?1006;2004h");
        assert_eq!(state.modes.dec, BTreeSet::from([1000, 1006, 2004]));
        state.feed("\x1b[!p");
        assert_eq!(state.modes.dec, BTreeSet::from([1000, 1006]));
        state.feed("\x1b[?1003l");
        assert_eq!(state.modes.dec, BTreeSet::from([1006]));
        state.feed("\x1b[?1016h\x1b[?1006l");
        assert!(state.modes.dec.is_empty());
    }
}
