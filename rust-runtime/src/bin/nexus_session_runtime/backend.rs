#[path = "backend/catalog.rs"]
mod catalog;
#[path = "backend/cleanup.rs"]
mod cleanup;
#[path = "backend/lifecycle.rs"]
mod lifecycle;
#[path = "backend/support.rs"]
mod support;

pub(super) use catalog::SessionCatalog;
pub(super) use cleanup::CodexSessionCleanup;
pub(super) use lifecycle::SessionLifecycle;
use support::native_backend_enabled;
