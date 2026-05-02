use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::models::AppError;

pub struct PathValidator;

impl PathValidator {
    const LEGACY_BASE_DIR: &'static str = "C-at-Projects";
    const APP_DIR: &'static str = "Cat Editor";
    const PROJECTS_DIR: &'static str = "Projects";

    pub fn get_primary_root() -> PathBuf {
        dirs::data_local_dir()
            .or_else(dirs::document_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(Self::APP_DIR)
            .join(Self::PROJECTS_DIR)
    }

    pub fn get_legacy_root() -> Option<PathBuf> {
        dirs::document_dir().map(|dir| dir.join(Self::LEGACY_BASE_DIR))
    }

    pub fn ensure_primary_root() -> Result<PathBuf, AppError> {
        let root = Self::get_primary_root();
        if !root.exists() {
            std::fs::create_dir_all(&root)
                .map_err(|e| AppError::Io(format!("Failed to create project root: {}", e)))?;
        }

        Ok(root)
    }

    pub fn get_project_roots() -> Result<Vec<PathBuf>, AppError> {
        let mut roots = vec![Self::ensure_primary_root()?];
        if let Some(legacy_root) = Self::get_legacy_root() {
            if legacy_root.exists() {
                roots.push(legacy_root);
            }
        }

        Ok(Self::dedupe_paths(roots))
    }

    pub fn get_project_roots_as_strings() -> Result<Vec<String>, AppError> {
        Ok(Self::get_project_roots()?
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect())
    }

    pub fn validate_path(path: &Path) -> Result<PathBuf, AppError> {
        let roots = Self::get_project_roots()?;
        let canonical_roots = roots
            .iter()
            .map(|root| {
                root.canonicalize()
                    .map_err(|e| AppError::Io(format!("Failed to canonicalize root: {}", e)))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let target = if path.is_absolute() {
            path.to_path_buf()
        } else {
            canonical_roots
                .first()
                .cloned()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(path)
        };

        let canonical_target = target
            .canonicalize()
            .map_err(|_| AppError::NotFound(format!("Path does not exist: {}", path.display())))?;

        if canonical_roots
            .iter()
            .any(|root| canonical_target.starts_with(root))
        {
            return Ok(canonical_target);
        }

        Err(AppError::PermissionDenied(format!(
            "Access denied: {} is outside allowed directories",
            path.display()
        )))
    }

    pub fn validate_directory_path(path: &Path) -> Result<PathBuf, AppError> {
        let canonical = if path.is_absolute() {
            path.canonicalize()
                .map_err(|e| AppError::NotFound(format!("Directory not found: {}", e)))?
        } else {
            std::env::current_dir()
                .map_err(|e| AppError::Io(format!("Failed to read current directory: {}", e)))?
                .join(path)
                .canonicalize()
                .map_err(|e| AppError::NotFound(format!("Directory not found: {}", e)))?
        };

        if !canonical.is_dir() {
            return Err(AppError::NotFound(format!(
                "Directory not found: {}",
                canonical.display()
            )));
        }

        Ok(canonical)
    }

    pub fn validate_name(name: &str) -> Result<(), AppError> {
        let normalized = name.trim();

        if normalized.is_empty() || normalized.len() > 255 {
            return Err(AppError::InvalidName(
                "Name must be 1-255 non-space characters".to_string(),
            ));
        }

        if normalized != name {
            return Err(AppError::InvalidName(
                "Leading or trailing spaces are not allowed".to_string(),
            ));
        }

        if normalized == "." || normalized == ".." {
            return Err(AppError::InvalidName("Reserved names are not allowed".to_string()));
        }

        let invalid_chars = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\0'];
        if normalized.chars().any(|c| invalid_chars.contains(&c)) {
            return Err(AppError::InvalidName(format!(
                "Name contains invalid characters: {}",
                normalized
            )));
        }

        if normalized.starts_with('.') {
            return Err(AppError::InvalidName(
                "Hidden files and folders are not allowed".to_string(),
            ));
        }

        Ok(())
    }

    pub fn is_allowed_extension(path: &Path) -> bool {
        match path.extension().and_then(|e| e.to_str()) {
            Some("c")
            | Some("h")
            | Some("cpp")
            | Some("cxx")
            | Some("cc")
            | Some("hpp")
            | Some("hxx")
            | Some("hh")
            | Some("txt")
            | Some("md") => true,
            None => true,
            _ => false,
        }
    }

    fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
        let mut seen = HashSet::new();
        let mut deduped = Vec::new();

        for path in paths {
            let key = path
                .canonicalize()
                .unwrap_or(path.clone())
                .to_string_lossy()
                .to_lowercase();

            if seen.insert(key) {
                deduped.push(path);
            }
        }

        deduped
    }
}
