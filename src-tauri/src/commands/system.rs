use tauri::State;

use crate::models::{AppError, RuntimeStatus, SystemInfo};
use crate::utils::path_validator::PathValidator;
use crate::AppState;

#[tauri::command]
pub async fn get_system_info(
    state: State<'_, AppState>,
) -> Result<SystemInfo, AppError> {
    state.monitor.get_info().await
}

#[tauri::command]
pub async fn get_runtime_status(
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, AppError> {
    Ok(RuntimeStatus {
        compiler_available: state.compiler.is_available(),
        compiler_label: state.compiler.compiler_label(),
        debugger_available: state.compiler.debugger_available(),
        debugger_label: state.compiler.debugger_label(),
        cmake_available: state.build.cmake_available(),
        cmake_label: state.build.cmake_label(),
        make_available: state.build.make_available(),
        make_label: state.build.make_label(),
        formatter_available: state.build.formatter_available(),
        formatter_label: state.build.formatter_label(),
        git_available: state.git.is_available(),
        package_managers: state.packages.available_managers(),
        project_roots: PathValidator::get_project_roots_as_strings()?,
    })
}
