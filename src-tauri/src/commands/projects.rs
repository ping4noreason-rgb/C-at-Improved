use tauri::State;

use crate::models::{AppError, ProjectInfo};
use crate::AppState;

#[tauri::command]
pub async fn get_projects(
    state: State<'_, AppState>,
) -> Result<Vec<ProjectInfo>, AppError> {
    state.file_service.get_projects().await
}

#[tauri::command]
pub async fn create_project(
    name: String,
    state: State<'_, AppState>,
) -> Result<ProjectInfo, AppError> {
    state.file_service.create_project(&name).await
}

#[tauri::command]
pub async fn delete_project_safe(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let projects = state.file_service.get_projects().await?;
    let project = projects
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| AppError::NotFound(format!("Project '{}' not found", name)))?;

    state
        .trash
        .move_to_trash(std::path::PathBuf::from(&project.path).as_path())
        .await
}
