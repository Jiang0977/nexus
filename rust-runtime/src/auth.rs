use jsonwebtoken::{DecodingKey, Validation, decode};
use serde::de::DeserializeOwned;

pub fn validate_auth_token<T: DeserializeOwned>(token: &str, secret: &str) -> bool {
    decode::<T>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::validate_auth_token;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Deserialize, Serialize)]
    struct Claims {
        sub: String,
        exp: usize,
    }

    #[test]
    fn accepts_valid_jwt() {
        let token = encode(
            &Header::default(),
            &Claims {
                sub: "nexus".to_string(),
                exp: 4_102_444_800,
            },
            &EncodingKey::from_secret(b"secret"),
        )
        .expect("token");

        assert!(validate_auth_token::<Claims>(&token, "secret"));
    }

    #[test]
    fn rejects_invalid_jwt() {
        assert!(!validate_auth_token::<Claims>("bad-token", "secret"));
    }
}
