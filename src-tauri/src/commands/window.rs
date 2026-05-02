use tauri::WebviewWindow;

use crate::models::AppError;

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), AppError> {
    window
        .minimize()
        .map_err(|e| AppError::Window(format!("Failed to minimize window: {}", e)))
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> Result<bool, AppError> {
    let is_maximized = window
        .is_maximized()
        .map_err(|e| AppError::Window(format!("Failed to read window state: {}", e)))?;

    if is_maximized {
        window
            .unmaximize()
            .map_err(|e| AppError::Window(format!("Failed to restore window: {}", e)))?;
        Ok(false)
    } else {
        window
            .maximize()
            .map_err(|e| AppError::Window(format!("Failed to maximize window: {}", e)))?;
        Ok(true)
    }
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> Result<bool, AppError> {
    window
        .is_maximized()
        .map_err(|e| AppError::Window(format!("Failed to read window state: {}", e)))
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), AppError> {
    window
        .close()
        .map_err(|e| AppError::Window(format!("Failed to close window: {}", e)))
}
