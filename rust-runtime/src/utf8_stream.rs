#[derive(Default, Debug)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn new() -> Self {
        Self {
            pending: Vec::with_capacity(4),
        }
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }

        let combined: Vec<u8>;
        let buffer: &[u8] = if self.pending.is_empty() {
            bytes
        } else {
            combined = [&self.pending[..], bytes].concat();
            self.pending.clear();
            &combined
        };

        let mut out = String::new();
        let mut start = 0;

        while start < buffer.len() {
            match std::str::from_utf8(&buffer[start..]) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(valid) = std::str::from_utf8(&buffer[start..start + valid_up_to])
                        {
                            out.push_str(valid);
                        }
                        start += valid_up_to;
                    }

                    match error.error_len() {
                        Some(error_len) => {
                            out.push('\u{FFFD}');
                            start += error_len;
                        }
                        None => {
                            self.pending.extend_from_slice(&buffer[start..]);
                            break;
                        }
                    }
                }
            }
        }

        out
    }

    pub(crate) fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        self.pending.clear();
        "\u{FFFD}".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    #[test]
    fn utf8_valid_ascii_immediate() {
        let mut decoder = Utf8StreamDecoder::new();
        let text = "hello world";
        let decoded = decoder.feed(text.as_bytes());
        assert_eq!(decoded, text);
        assert!(decoder.pending.is_empty());
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn utf8_mixed_every_single_split_position() {
        let sample = "A/B中文test🙂123";
        let bytes = sample.as_bytes();

        for split in 0..=bytes.len() {
            let mut decoder = Utf8StreamDecoder::new();
            let mut result = decoder.feed(&bytes[..split]);
            result.push_str(&decoder.feed(&bytes[split..]));
            result.push_str(&decoder.finish());
            assert_eq!(result, sample, "failed at split {}", split);
        }
    }

    #[test]
    fn utf8_byte_by_byte_feeding() {
        let sample = "prefix: 中文, 🚀 emoji, suffix!";
        let mut decoder = Utf8StreamDecoder::new();
        let mut result = String::new();

        for &byte in sample.as_bytes() {
            result.push_str(&decoder.feed(&[byte]));
        }
        result.push_str(&decoder.finish());
        assert_eq!(result, sample);
    }

    #[test]
    fn utf8_truly_invalid_bytes_replaced() {
        let mut decoder = Utf8StreamDecoder::new();
        let bad_bytes = b"valid\x80\xffmid\xfeend";
        let decoded = decoder.feed(bad_bytes);
        assert_eq!(decoded, "valid\u{FFFD}\u{FFFD}mid\u{FFFD}end");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn utf8_incomplete_eof_replaces_tail() {
        let mut decoder = Utf8StreamDecoder::new();
        let full_chinese = "中".as_bytes();
        let part = decoder.feed(&full_chinese[..2]);
        assert_eq!(part, "");
        assert_eq!(decoder.pending.len(), 2);
        let finished = decoder.finish();
        assert_eq!(finished, "\u{FFFD}");
        assert!(decoder.pending.is_empty());
    }
}
