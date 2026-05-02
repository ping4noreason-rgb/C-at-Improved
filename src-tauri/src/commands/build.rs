use std::path::PathBuf;

use tauri::State;

use crate::models::{AppError, CommandResult, FormatResult, WorkspaceToolingStatus};
use crate::AppState;

#[tauri::command]
pub async fn get_workspace_tooling(
    project_path: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceToolingStatus, AppError> {
    state
        .build
        .workspace_status(PathBuf::from(project_path).as_path())
        .await
}

#[tauri::command]
pub async fn configure_project_build(
    project_path: String,
    system: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .build
        .configure_project(
            PathBuf::from(project_path).as_path(),
            system.as_deref(),
            mode.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn build_project(
    project_path: String,
    system: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .build
        .build_project(
            PathBuf::from(project_path).as_path(),
            system.as_deref(),
            mode.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn format_source_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<FormatResult, AppError> {
    state
        .build
        .format_source(PathBuf::from(path).as_path(), &content)
        .await
}
