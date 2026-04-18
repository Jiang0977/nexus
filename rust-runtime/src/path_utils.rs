use std::ffi::OsString;
use std::fs as stdfs;
use std::path::{Component, Path, PathBuf};

pub fn resolve_workspace_path(workspace_root: &str, input_path: &str) -> String {
    if input_path.starts_with('/') {
        return input_path.to_string();
    }

    let base = workspace_root.trim_end_matches('/');
    let relative = input_path.trim_start_matches('/');
    if base.is_empty() || base == "/" {
        format!("/{relative}")
    } else {
        format!("{base}/{relative}")
    }
}

pub fn sanitize_request_path(request_path: &str) -> Option<PathBuf> {
    let mut safe_path = PathBuf::new();
    for component in Path::new(request_path.trim_start_matches('/')).components() {
        match component {
            Component::Normal(value) => safe_path.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(safe_path)
}

pub fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut prefix: Option<OsString> = None;
    let mut has_root = false;
    let mut parts: Vec<OsString> = Vec::new();

    for component in path.components() {
        match component {
            Component::Prefix(value) => prefix = Some(value.as_os_str().to_os_string()),
            Component::RootDir => has_root = true,
            Component::CurDir => {}
            Component::ParentDir => {
                if !parts.is_empty() {
                    parts.pop();
                } else if !has_root {
                    parts.push(OsString::from(".."));
                }
            }
            Component::Normal(value) => parts.push(value.to_os_string()),
        }
    }

    let mut normalized = PathBuf::new();
    if let Some(prefix) = prefix {
        normalized.push(prefix);
    }
    if has_root {
        normalized.push(std::path::MAIN_SEPARATOR.to_string());
    }
    for part in parts {
        normalized.push(part);
    }

    if normalized.as_os_str().is_empty() {
        if has_root {
            PathBuf::from(std::path::MAIN_SEPARATOR.to_string())
        } else {
            PathBuf::from(".")
        }
    } else {
        normalized
    }
}

pub fn strip_leading_parent_components(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    let mut skipping_leading_parents = true;

    for component in path.components() {
        match component {
            Component::ParentDir if skipping_leading_parents => {}
            Component::CurDir if skipping_leading_parents => {}
            Component::Normal(value) => {
                skipping_leading_parents = false;
                result.push(value);
            }
            Component::ParentDir => result.push(".."),
            Component::CurDir => {}
            Component::RootDir => {
                skipping_leading_parents = false;
                result.push(std::path::MAIN_SEPARATOR.to_string());
            }
            Component::Prefix(value) => {
                skipping_leading_parents = false;
                result.push(value.as_os_str());
            }
        }
    }

    result
}

pub fn path_contains_parent_marker(path: &Path) -> bool {
    path.to_string_lossy().contains("..")
}

pub fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn copy_path_recursive_sync(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = stdfs::metadata(source).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        stdfs::create_dir_all(target).map_err(|error| error.to_string())?;
        let entries = stdfs::read_dir(source).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let child_source = entry.path();
            let child_target = target.join(entry.file_name());
            copy_path_recursive_sync(&child_source, &child_target)?;
        }
        Ok(())
    } else {
        stdfs::copy(source, target)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

pub fn remove_path_recursive_sync(path: &Path) -> Result<(), String> {
    let metadata = stdfs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        stdfs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        stdfs::remove_file(path).map_err(|error| error.to_string())
    }
}

pub fn percent_encode_utf8(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_path_lexically, percent_encode_utf8, resolve_workspace_path,
        sanitize_request_path, strip_leading_parent_components,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn resolves_workspace_relative_paths() {
        assert_eq!(
            resolve_workspace_path("/workspace", "apps/demo"),
            "/workspace/apps/demo"
        );
        assert_eq!(
            resolve_workspace_path("/workspace", "/tmp/demo"),
            "/tmp/demo"
        );
    }

    #[test]
    fn rejects_parent_components_in_request_path() {
        assert_eq!(sanitize_request_path("../secret.txt"), None);
        assert_eq!(
            sanitize_request_path("assets/app.js"),
            Some(PathBuf::from("assets/app.js"))
        );
    }

    #[test]
    fn normalizes_paths_lexically() {
        assert_eq!(
            normalize_path_lexically(Path::new("/workspace/demo/../docs")),
            PathBuf::from("/workspace/docs")
        );
        assert_eq!(
            normalize_path_lexically(Path::new("demo/./notes/../todo.txt")),
            PathBuf::from("demo/todo.txt")
        );
    }

    #[test]
    fn strips_leading_parent_components() {
        assert_eq!(
            strip_leading_parent_components(Path::new("../../uploads/a.txt")),
            PathBuf::from("uploads/a.txt")
        );
    }

    #[test]
    fn percent_encodes_utf8_bytes() {
        assert_eq!(
            percent_encode_utf8("capture 你好.png"),
            "capture%20%E4%BD%A0%E5%A5%BD.png"
        );
    }
}
