use super::*;

pub(super) async fn api_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(current_version_payload(state.project_root.as_ref()).await).into_response()
}

pub(super) async fn api_latest_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match fetch_latest_version_payload(state.github_repo.as_ref()).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

pub(super) async fn fetch_latest_version_payload(
    github_repo: &str,
) -> Result<Value, ServiceRouteError> {
    let remote = version_remote_ref(github_repo);
    let output = Command::new("git")
        .args([
            "ls-remote",
            "--refs",
            "--tags",
            "--sort=-version:refname",
            &remote,
        ])
        .output()
        .await
        .map_err(|_| {
            ServiceRouteError::from_message(StatusCode::BAD_GATEWAY, "cannot reach GitHub")
        })?;

    if !output.status.success() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_GATEWAY,
            "cannot reach GitHub",
        ));
    }

    let latest = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split('\t').nth(1))
        .filter_map(|reference| reference.strip_prefix("refs/tags/"))
        .map(str::trim)
        .find(|tag| !tag.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| ServiceRouteError::from_message(StatusCode::BAD_GATEWAY, "no tags found"))?;

    Ok(json!({
        "latest": latest,
        "url": version_release_url(github_repo, &latest),
    }))
}

pub(super) fn version_remote_ref(github_repo: &str) -> String {
    if looks_like_github_repo_slug(github_repo) {
        format!("https://github.com/{github_repo}.git")
    } else {
        github_repo.to_string()
    }
}

pub(super) fn version_release_url(github_repo: &str, tag: &str) -> String {
    if looks_like_github_repo_slug(github_repo) {
        format!("https://github.com/{github_repo}/releases/tag/{tag}")
    } else {
        format!("{github_repo}#{tag}")
    }
}

pub(super) fn looks_like_github_repo_slug(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.starts_with('.')
        && !value.contains("://")
        && value.matches('/').count() == 1
}
