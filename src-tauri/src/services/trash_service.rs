use std::path::Path;
use trash::{delete, delete_all};
use tracing::{info, warn};

use crate::models::AppError;
use crate::utils::path_validator::PathValidator;

pub struct TrashService;

impl TrashService {
    pub fn new() -> Self {
        Self
    }
    
    pub async fn move_to_trash(&self, path: &Path) -> Result<(), AppError> {
        let valid_path = PathValidator::validate_path(path)?;
        
        if !valid_path.exists() {
            return Err(AppError::NotFound(format!("Path not found: {}", valid_path.display())));
        }
        
        tokio::task::spawn_blocking(move || {
            match delete(&valid_path) {
                Ok(_) => {
                    info!("Moved to trash: {}", valid_path.display());
                    Ok(())
                },
                Err(e) => {
                    warn!("Failed to move to trash: {}", e);
                    Err(AppError::Io(format!("Failed to move to trash: {}", e)))
                }
            }
        }).await
        .map_err(|e| AppError::Io(format!("Task join error: {}", e)))?
    }
    
    pub async fn delete_multiple(&self, paths: Vec<&Path>) -> Result<(), AppError> {
        let valid_paths: Vec<_> = paths.iter()
            .map(|p| PathValidator::validate_path(p))
            .collect::<Result<Vec<_>, _>>()?;
        
        tokio::task::spawn_blocking(move || {
            match delete_all(valid_paths.iter().map(|p| p.as_path())) {
                Ok(_) => {
                    info!("Moved {} items to trash", valid_paths.len());
                    Ok(())
                },
                Err(e) => {
                    Err(AppError::Io(format!("Failed to move to trash: {}", e)))
                }
            }
        }).await
        .map_err(|e| AppError::Io(format!("Task join error: {}", e)))?
    }
}
