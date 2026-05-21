use std::collections::HashSet;

use chrono::{DateTime, Utc};

use crate::codex_replay::model::{AccountRef, ActivationEvent, AttributedSession, SessionRecord};

pub fn attribute_sessions(
    sessions: &[SessionRecord],
    activations: &[ActivationEvent],
) -> Vec<AttributedSession> {
    sessions
        .iter()
        .map(|session| AttributedSession {
            id: session.id.clone(),
            started_at: session.started_at,
            last_activity_at: session.last_activity_at,
            model: session.model.clone(),
            archived: session.archived,
            attribution: attribute_at(session.started_at, activations),
        })
        .collect()
}

pub fn attribute_at(instant: DateTime<Utc>, activations: &[ActivationEvent]) -> Option<AccountRef> {
    activations
        .iter()
        .enumerate()
        .filter(|(_, activation)| activation.event_type == "activation")
        .filter(|(_, activation)| activation.timestamp <= instant)
        .filter_map(|(index, activation)| {
            activation
                .account_ref()
                .map(|account| (index, activation.timestamp, account))
        })
        .max_by(|lhs, rhs| lhs.1.cmp(&rhs.1).then(lhs.0.cmp(&rhs.0)))
        .map(|(_, _, account)| account)
}

pub fn remap_to_target_account(
    items: &mut [AttributedSession],
    provider_ids: &HashSet<String>,
    target_account_id: &str,
    keep_unknown: bool,
) {
    for item in items {
        match item.attribution.as_mut() {
            Some(account)
                if account.provider_id == "codex" && provider_ids.contains(&account.account_id) =>
            {
                account.account_id = target_account_id.to_string();
            }
            Some(_) => {}
            None if !keep_unknown => {
                item.attribution = Some(AccountRef {
                    provider_id: "codex".to_string(),
                    account_id: target_account_id.to_string(),
                });
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use chrono::{TimeZone, Utc};

    use super::{attribute_at, remap_to_target_account};
    use crate::codex_replay::model::{ActivationEvent, AttributedSession, SessionRecord};

    #[test]
    fn attribute_at_uses_latest_preceding_activation() {
        let activations = vec![
            ActivationEvent::new(
                Utc.with_ymd_and_hms(2026, 4, 11, 8, 0, 0).unwrap(),
                "codex".into(),
                "provider-primary".into(),
                None,
                Some("manual".into()),
                false,
                false,
                false,
            ),
            ActivationEvent::new(
                Utc.with_ymd_and_hms(2026, 4, 11, 9, 0, 0).unwrap(),
                "codex".into(),
                "provider-secondary".into(),
                Some("provider-primary".into()),
                Some("manual".into()),
                false,
                false,
                false,
            ),
        ];

        let account = attribute_at(
            Utc.with_ymd_and_hms(2026, 4, 11, 9, 30, 0).unwrap(),
            &activations,
        )
        .expect("account");

        assert_eq!(account.provider_id, "codex");
        assert_eq!(account.account_id, "provider-secondary");
    }

    #[test]
    fn remap_to_target_account_merges_known_codex_accounts() {
        let mut sessions = vec![AttributedSession {
            id: "session-1".to_string(),
            started_at: Utc.with_ymd_and_hms(2026, 4, 11, 9, 0, 0).unwrap(),
            last_activity_at: Utc.with_ymd_and_hms(2026, 4, 11, 9, 5, 0).unwrap(),
            model: "gpt-5.4".to_string(),
            archived: false,
            attribution: Some(crate::codex_replay::model::AccountRef {
                provider_id: "codex".to_string(),
                account_id: "provider-old".to_string(),
            }),
        }];
        let provider_ids =
            HashSet::from(["provider-old".to_string(), "provider-target".to_string()]);

        remap_to_target_account(&mut sessions, &provider_ids, "provider-target", false);

        assert_eq!(
            sessions[0]
                .attribution
                .as_ref()
                .map(|account| account.account_id.as_str()),
            Some("provider-target")
        );
    }

    #[test]
    fn remap_to_target_account_fills_unknown_when_requested() {
        let mut sessions = vec![AttributedSession {
            id: "session-1".to_string(),
            started_at: Utc.with_ymd_and_hms(2026, 4, 11, 9, 0, 0).unwrap(),
            last_activity_at: Utc.with_ymd_and_hms(2026, 4, 11, 9, 5, 0).unwrap(),
            model: "gpt-5.4".to_string(),
            archived: false,
            attribution: None,
        }];
        let provider_ids = HashSet::from(["provider-target".to_string()]);

        remap_to_target_account(&mut sessions, &provider_ids, "provider-target", false);

        assert_eq!(
            sessions[0]
                .attribution
                .as_ref()
                .map(|account| (account.provider_id.as_str(), account.account_id.as_str())),
            Some(("codex", "provider-target"))
        );
    }

    #[test]
    fn attribute_sessions_keeps_shape() {
        let sessions = vec![SessionRecord {
            id: "session-1".to_string(),
            started_at: Utc.with_ymd_and_hms(2026, 4, 11, 9, 0, 0).unwrap(),
            last_activity_at: Utc.with_ymd_and_hms(2026, 4, 11, 9, 5, 0).unwrap(),
            archived: false,
            model: "gpt-5.4".to_string(),
        }];
        let activations = vec![ActivationEvent::new(
            Utc.with_ymd_and_hms(2026, 4, 11, 8, 0, 0).unwrap(),
            "codex".into(),
            "provider-main".into(),
            None,
            Some("manual".into()),
            false,
            false,
            false,
        )];

        let attributed = super::attribute_sessions(&sessions, &activations);
        assert_eq!(attributed.len(), 1);
        assert_eq!(
            attributed[0]
                .attribution
                .as_ref()
                .map(|value| value.account_id.as_str()),
            Some("provider-main")
        );
    }
}
