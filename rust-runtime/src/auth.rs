use jsonwebtoken::{DecodingKey, Validation, decode};
use serde::de::DeserializeOwned;

pub fn validate_auth_token<T: DeserializeOwned>(token: &str, secret: &str) -> bool {
    let mut validation = Validation::default();
    validation.validate_nbf = true;
    decode::<T>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::validate_auth_token;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde::{Deserialize, Serialize};
    use serde_json::json;

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

    #[test]
    fn rejects_invalid_time_claims_even_without_typed_claims() {
        for claims in [
            json!({ "sub": "nexus", "exp": 1 }),
            json!({ "sub": "nexus" }),
            json!({ "sub": "nexus", "exp": "4102444800" }),
            json!({ "sub": "nexus", "exp": 4102444800_u64, "nbf": 4102444700_u64 }),
            json!({ "sub": "nexus", "exp": 4102444800_u64, "nbf": "4102444700" }),
            json!({ "sub": "nexus", "exp": 4102444800_u64, "nbf": null }),
        ] {
            let token = encode(
                &Header::default(),
                &claims,
                &EncodingKey::from_secret(b"test-signing-secret"),
            )
            .expect("test token");
            assert!(
                !validate_auth_token::<serde_json::Value>(&token, "test-signing-secret"),
                "invalid claims accepted: {claims}"
            );
        }
    }

    #[test]
    fn requires_the_correct_key_and_hs256_algorithm() {
        let claims = json!({ "sub": "nexus", "exp": 4102444800_u64 });
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(b"test-signing-secret"),
        )
        .expect("test token");
        assert!(!validate_auth_token::<serde_json::Value>(
            &token,
            "wrong-key"
        ));
        let wrong_algorithm = encode(
            &Header::new(jsonwebtoken::Algorithm::HS384),
            &claims,
            &EncodingKey::from_secret(b"test-signing-secret"),
        )
        .expect("test token");
        assert!(!validate_auth_token::<serde_json::Value>(
            &wrong_algorithm,
            "test-signing-secret"
        ));
    }

    #[test]
    fn accepts_valid_optional_not_before_and_legacy_claim_shape() {
        for claims in [
            json!({ "sub": "nexus", "iat": 1700000000, "exp": 4102444800_u64 }),
            json!({ "sub": "nexus", "exp": 4102444800_u64, "nbf": 1 }),
        ] {
            let token = encode(
                &Header::default(),
                &claims,
                &EncodingKey::from_secret(b"test-signing-secret"),
            )
            .expect("test token");
            assert!(validate_auth_token::<serde_json::Value>(
                &token,
                "test-signing-secret"
            ));
        }
    }
}
