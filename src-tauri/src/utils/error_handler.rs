use std::panic;
use tracing::error;

pub fn handle_panic(panic_info: &panic::PanicHookInfo<'_>) {
    let message = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "Unknown panic".to_string()
    };

    if let Some(location) = panic_info.location() {
        error!(
            "Panic at {}:{}:{} - {}",
            location.file(),
            location.line(),
            location.column(),
            message
        );
    } else {
        error!("Panic with unknown location - {}", message);
    }

    #[cfg(not(debug_assertions))]
    {
        // In release builds a UI-thread dialog can be shown here if needed.
    }
}
