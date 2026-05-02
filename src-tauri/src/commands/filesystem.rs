use std::path::PathBuf;

use tauri::State;

use crate::models::{AppError, FileInfo, FileTreeNode};
use crate::AppState;

#[tauri::command]
pub async fn get_files(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileInfo>, AppError> {
    state.file_service.list_files(PathBuf::from(path).as_path()).await
}

#[tauri::command]
pub async fn get_file_tree(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileTreeNode>, AppError> {
    state
        .file_service
        .get_file_tree(PathBuf::from(path).as_path())
        .await
}

#[tauri::command]
pub async fn get_file_content(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    state
        .file_service
        .read_file(PathBuf::from(path).as_path())
        .await
}

#[tauri::command]
pub async fn save_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state
        .file_service
        .write_file(PathBuf::from(path).as_path(), &content)
        .await
}

#[tauri::command]
pub async fn create_file(
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<FileInfo, AppError> {
    state
        .file_service
        .create_file(PathBuf::from(parent_path).as_path(), &name)
        .await
}

#[tauri::command]
pub async fn create_folder(
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<FileInfo, AppError> {
    state
        .file_service
        .create_folder(PathBuf::from(parent_path).as_path(), &name)
        .await
}

#[tauri::command]
pub async fn delete_file_safe(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state
        .trash
        .move_to_trash(PathBuf::from(path).as_path())
        .await
}

#[tauri::command]
pub async fn rename_file(
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state
        .file_service
        .rename(PathBuf::from(path).as_path(), &new_name)
        .await
}
