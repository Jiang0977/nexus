use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationEvent {
    #[serde(rename = "type", default = "default_activation_type")]
    pub event_type: String,
    #[serde(rename = "timestamp")]
    pub timestamp: DateTime<Utc>,
    #[serde(rename = "providerId")]
    pub provider_id: Option<String>,
    #[serde(rename = "accountId")]
    pub account_id: Option<String>,
    #[serde(rename = "previousAccountId")]
    pub previous_account_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub automatic: bool,
    #[serde(default)]
    pub forced: bool,
    #[serde(rename = "protectedByManualGrace", default)]
    pub protected_by_manual_grace: bool,
}

fn default_activation_type() -> String {
    "activation".to_string()
}

impl ActivationEvent {
    #[cfg(test)]
    pub fn new(
        timestamp: DateTime<Utc>,
        provider_id: String,
        account_id: String,
        previous_account_id: Option<String>,
        reason: Option<String>,
        automatic: bool,
        forced: bool,
        protected_by_manual_grace: bool,
    ) -> Self {
        Self {
            event_type: default_activation_type(),
            timestamp,
            provider_id: Some(provider_id),
            account_id: Some(account_id),
            previous_account_id,
            reason,
            automatic,
            forced,
            protected_by_manual_grace,
        }
    }

    pub fn account_ref(&self) -> Option<AccountRef> {
        let provider_id = self.provider_id.as_ref()?.trim();
        let account_id = self.account_id.as_ref()?.trim();
        if provider_id.is_empty() || account_id.is_empty() {
            return None;
        }

        Some(AccountRef {
            provider_id: provider_id.to_string(),
            account_id: account_id.to_string(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AccountRef {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub archived: bool,
    pub model: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttributedSession {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub model: String,
    pub archived: bool,
    pub attribution: Option<AccountRef>,
}
