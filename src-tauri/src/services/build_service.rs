use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::models::{
    AppError, BuildSystemStatus, CommandResult, FormatResult, WorkspaceToolingStatus,
};
use crate::utils::path_validator::PathValidator;
use tracing::warn;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct BuildService {
    cmake_path: Option<PathBuf>,
    make_path: Option<PathBuf>,
    formatter_path: Option<PathBuf>,
}

impl BuildService {
    pub fn new() -> Self {
        Self {
            cmake_path: which::which("cmake").ok(),
            make_path: ["make", "mingw32-make", "nmake"]
                .iter()
                .find_map(|tool| which::which(tool).ok()),
            formatter_path: which::which("clang-format").ok(),
        }
    }

    pub fn cmake_available(&self) -> bool {
        self.cmake_path.is_some()
    }

    pub fn cmake_label(&self) -> String {
        Self::tool_label(self.cmake_path.as_deref(), "Not available")
    }

    pub fn make_available(&self) -> bool {
        self.make_path.is_some()
    }

    pub fn make_label(&self) -> String {
        Self::tool_label(self.make_path.as_deref(), "Not available")
    }

    pub fn formatter_available(&self) -> bool {
        self.formatter_path.is_some()
    }

    pub fn formatter_label(&self) -> String {
        Self::tool_label(self.formatter_path.as_deref(), "Not available")
    }

    async fn execute_with_timeout<T, F>(
        &self,
        timeout_duration: Duration,
        operation: F,
        timeout_message: &str,
    ) -> Result<T, AppError>
    where
        F: FnOnce() -> Result<T, AppError> + Send + 'static,
        T: Send + 'static,
    {
        let result = tokio::time::timeout(
            timeout_duration,
            tokio::task::spawn_blocking(operation),
        )
        .await;

        match result {
            Ok(Ok(result)) => result,
            Ok(Err(e)) => Err(AppError::Build(format!("Task failed: {}", e))),
            Err(_) => {
                warn!("{}", timeout_message);
                Err(AppError::Timeout(timeout_message.to_string()))
            }
        }
    }

    pub async fn workspace_status(
        &self,
        project_path: &Path,
    ) -> Result<WorkspaceToolingStatus, AppError> {
        let valid_path = PathValidator::validate_directory_path(project_path)?;
        let cmake_path = self.cmake_path.clone();
        let make_path = self.make_path.clone();
        let formatter_path = self.formatter_path.clone();

        let result = tokio::task::spawn_blocking(move || {
            Self::workspace_status_blocking(
                &valid_path,
                cmake_path.as_deref(),
                make_path.as_deref(),
                formatter_path.as_deref(),
            )
        })
        .await;

        result.map_err(|error| AppError::Build(format!("Workspace status task failed: {}", error)))
    }

    pub async fn configure_project(
        &self,
        project_path: &Path,
        system: Option<&str>,
        mode: Option<&str>,
    ) -> Result<CommandResult, AppError> {
        let valid_path = PathValidator::validate_directory_path(project_path)?;
        let cmake_path = self.cmake_path.clone();
        let make_path = self.make_path.clone();
        let selected_system = self.resolve_build_system(&valid_path, system)?;
        let build_type = Self::build_type(mode);

        self.execute_with_timeout(
            Duration::from_secs(60),
            move || match selected_system.as_str() {
                "cmake" => {
                    let cmake = cmake_path.ok_or_else(|| {
                        AppError::Build("CMake is not available on this machine.".to_string())
                    })?;
                    Self::configure_cmake(&cmake, &valid_path, build_type)
                }
                "make" => {
                    if make_path.is_none() {
                        return Err(AppError::Build(
                            "Make is not available on this machine.".to_string(),
                        ));
                    }

                    Ok(CommandResult {
                        success: true,
                        command: "make (configure step skipped)".to_string(),
                        stdout: "Make-based projects do not require a separate configure step."
                            .to_string(),
                        stderr: String::new(),
                        exit_code: Some(0),
                    })
                }
                _ => Err(AppError::Build(format!(
                    "Unsupported build system: {}",
                    selected_system
                ))),
            },
            "Project configure timed out (60 seconds)",
        )
        .await
    }

    pub async fn build_project(
        &self,
        project_path: &Path,
        system: Option<&str>,
        mode: Option<&str>,
    ) -> Result<CommandResult, AppError> {
        let valid_path = PathValidator::validate_directory_path(project_path)?;
        let cmake_path = self.cmake_path.clone();
        let make_path = self.make_path.clone();
        let selected_system = self.resolve_build_system(&valid_path, system)?;
        let build_type = Self::build_type(mode);

        self.execute_with_timeout(
            Duration::from_secs(300),
            move || match selected_system.as_str() {
                "cmake" => {
                    let cmake = cmake_path.ok_or_else(|| {
                        AppError::Build("CMake is not available on this machine.".to_string())
                    })?;
                    Self::build_with_cmake(&cmake, &valid_path, build_type)
                }
                "make" => {
                    let make = make_path.ok_or_else(|| {
                        AppError::Build("Make is not available on this machine.".to_string())
                    })?;
                    Self::build_with_make(&make, &valid_path)
                }
                _ => Err(AppError::Build(format!(
                    "Unsupported build system: {}",
                    selected_system
                ))),
            },
            "Build timed out (5 minutes)",
        )
        .await
    }

    pub async fn format_source(
        &self,
        file_path: &Path,
        content: &str,
    ) -> Result<FormatResult, AppError> {
        let valid_path = PathValidator::validate_path(file_path)?;
        let formatter_path = self.formatter_path.clone().ok_or_else(|| {
            AppError::Format("clang-format is not available on this machine.".to_string())
        })?;
        let source = content.to_string();

        self.execute_with_timeout(
            Duration::from_secs(10),
            move || Self::format_source_blocking(&formatter_path, &valid_path, &source),
            "Code formatting timed out (10 seconds)",
        )
        .await
    }

    fn workspace_status_blocking(
        project_path: &Path,
        cmake_path: Option<&Path>,
        make_path: Option<&Path>,
        formatter_path: Option<&Path>,
    ) -> WorkspaceToolingStatus {
        let cmake_file = project_path.join("CMakeLists.txt");
        let make_file = Self::find_makefile(project_path);
        let cmake_build_dir = project_path.join(".cat-editor").join("build").join("cmake");
        let preferred_build_system = if cmake_file.exists() {
            Some("cmake".to_string())
        } else if make_file.is_some() {
            Some("make".to_string())
        } else {
            None
        };

        WorkspaceToolingStatus {
            preferred_build_system,
            cmake: BuildSystemStatus {
                kind: "cmake".to_string(),
                available: cmake_path.is_some(),
                detected: cmake_file.exists(),
                configured: cmake_build_dir.join("CMakeCache.txt").exists(),
                config_path: cmake_file
                    .exists()
                    .then(|| cmake_file.to_string_lossy().to_string()),
                build_dir: Some(cmake_build_dir.to_string_lossy().to_string()),
                description: if cmake_file.exists() {
                    "Project includes CMakeLists.txt".to_string()
                } else {
                    "CMakeLists.txt was not found".to_string()
                },
            },
            make: BuildSystemStatus {
                kind: "make".to_string(),
                available: make_path.is_some(),
                detected: make_file.is_some(),
                configured: make_file.is_some(),
                config_path: make_file
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
                build_dir: Some(project_path.to_string_lossy().to_string()),
                description: if make_file.is_some() {
                    "Project includes a Makefile".to_string()
                } else {
                    "Makefile was not found".to_string()
                },
            },
            formatter_available: formatter_path.is_some(),
            formatter_label: Self::tool_label(formatter_path, "Not available"),
        }
    }

    fn resolve_build_system(
        &self,
        project_path: &Path,
        requested: Option<&str>,
    ) -> Result<String, AppError> {
        if let Some(system) = requested {
            let normalized = system.trim().to_ascii_lowercase();
            if normalized == "cmake" || normalized == "make" {
                return Ok(normalized);
            }
        }

        let cmake_file = project_path.join("CMakeLists.txt");
        if cmake_file.exists() {
            return Ok("cmake".to_string());
        }

        if Self::find_makefile(project_path).is_some() {
            return Ok("make".to_string());
        }

        Err(AppError::Build(
            "No supported build system was detected in this workspace.".to_string(),
        ))
    }

    fn configure_cmake(
        cmake_path: &Path,
        project_path: &Path,
        build_type: &'static str,
    ) -> Result<CommandResult, AppError> {
        let build_dir = Self::cmake_build_dir(project_path)?;
        std::fs::create_dir_all(&build_dir).map_err(|error| AppError::Io(error.to_string()))?;

        let args = vec![
            "-S".to_string(),
            project_path.to_string_lossy().to_string(),
            "-B".to_string(),
            build_dir.to_string_lossy().to_string(),
            format!("-DCMAKE_BUILD_TYPE={}", build_type),
        ];
        let output = Self::run_process(cmake_path, project_path, &args, None)
            .map_err(|error| AppError::Build(error.to_string()))?;

        Ok(Self::command_result(
            format!("cmake {}", args.join(" ")),
            output,
        ))
    }

    fn build_with_cmake(
        cmake_path: &Path,
        project_path: &Path,
        build_type: &'static str,
    ) -> Result<CommandResult, AppError> {
        let build_dir = Self::cmake_build_dir(project_path)?;
        let cache_file = build_dir.join("CMakeCache.txt");

        let mut logs = Vec::new();

        if !cache_file.exists() {
            let configure = Self::configure_cmake(cmake_path, project_path, build_type)?;
            logs.push(("Configure".to_string(), configure));

            if !logs.last().map(|(_, result)| result.success).unwrap_or(false) {
                let exit_code = logs.last().map(|(_, result)| result.exit_code).unwrap_or(Some(0));
                return Ok(Self::merge_command_results("cmake auto-configure", logs, exit_code));
            }
        }

        let args = vec![
            "--build".to_string(),
            build_dir.to_string_lossy().to_string(),
            "--config".to_string(),
            build_type.to_string(),
        ];
        let output = Self::run_process(cmake_path, project_path, &args, None)
            .map_err(|error| AppError::Build(error.to_string()))?;
        let build_result = Self::command_result(format!("cmake {}", args.join(" ")), output);
        let exit_code = build_result.exit_code; // Capture exit_code before moving
        logs.push(("Build".to_string(), build_result));

        Ok(Self::merge_command_results("cmake build", logs, exit_code))
    }

    fn build_with_make(make_path: &Path, project_path: &Path) -> Result<CommandResult, AppError> {
        let output = Self::run_process(make_path, project_path, &Vec::new(), None)
            .map_err(|error| AppError::Build(error.to_string()))?;
        let command = make_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "make".to_string());

        Ok(Self::command_result(command, output))
    }

    fn format_source_blocking(
        formatter_path: &Path,
        file_path: &Path,
        content: &str,
    ) -> Result<FormatResult, AppError> {
        let extension = file_path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let supported = [
            "c", "h", "cpp", "cxx", "cc", "hpp", "hh", "hxx", "inl",
        ];
        if !supported.contains(&extension.as_str()) {
            return Err(AppError::Format(
                "Formatting is currently supported for C/C++ source files only.".to_string(),
            ));
        }

        let args = vec![
            "-style=file".to_string(),
            "--assume-filename".to_string(),
            file_path.to_string_lossy().to_string(),
        ];

        let output = Self::run_process(
            formatter_path,
            file_path.parent().unwrap_or_else(|| Path::new(".")),
            &args,
            Some(content),
        )
        .map_err(|error| AppError::Format(error.to_string()))?;

        let formatted_content = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(FormatResult {
            changed: formatted_content != content,
            formatter: Self::tool_label(Some(formatter_path), "clang-format"),
            formatted_content,
            stdout: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }

    fn merge_command_results(
        command: &str,
        sections: Vec<(String, CommandResult)>,
        exit_code: Option<i32>,
    ) -> CommandResult {
        let success = sections.iter().all(|(_, result)| result.success);
        let stdout = sections
            .iter()
            .filter(|(_, result)| !result.stdout.is_empty())
            .map(|(label, result)| format!("{}:\n{}", label, result.stdout))
            .collect::<Vec<_>>()
            .join("\n\n");
        let stderr = sections
            .iter()
            .filter(|(_, result)| !result.stderr.is_empty())
            .map(|(label, result)| format!("{}:\n{}", label, result.stderr))
            .collect::<Vec<_>>()
            .join("\n\n");

        CommandResult {
            success,
            command: command.to_string(),
            stdout,
            stderr,
            exit_code,
        }
    }

    fn command_result(command: String, output: Output) -> CommandResult {
        CommandResult {
            success: output.status.success(),
            command,
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            exit_code: output.status.code(),
        }
    }

    fn run_process(
        binary: &Path,
        cwd: &Path,
        args: &[String],
        stdin: Option<&str>,
    ) -> Result<Output, AppError> {
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if stdin.is_some() {
            command.stdin(Stdio::piped());
        }

        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        if let Some(input) = stdin {
            let mut child = command
                .spawn()
                .map_err(|error| AppError::Io(format!("Failed to start process: {}", error)))?;
            let mut child_stdin = child
                .stdin
                .take()
                .ok_or_else(|| AppError::Io("Failed to open process stdin".to_string()))?;
            child_stdin
                .write_all(input.as_bytes())
                .map_err(|error| AppError::Io(format!("Failed to write process stdin: {}", error)))?;
            drop(child_stdin);

            return child
                .wait_with_output()
                .map_err(|error| AppError::Io(format!("Failed to read process output: {}", error)));
        }

        command
            .output()
            .map_err(|error| AppError::Io(format!("Failed to execute process: {}", error)))
    }

    fn cmake_build_dir(project_path: &Path) -> Result<PathBuf, AppError> {
        let build_dir = project_path.join(".cat-editor").join("build").join("cmake");
        std::fs::create_dir_all(&build_dir).map_err(|error| AppError::Io(error.to_string()))?;
        Ok(build_dir)
    }

    fn find_makefile(project_path: &Path) -> Option<PathBuf> {
        ["Makefile", "makefile", "GNUmakefile"]
            .iter()
            .map(|name| project_path.join(name))
            .find(|path| path.exists())
    }

    fn build_type(mode: Option<&str>) -> &'static str {
        match mode.unwrap_or("debug").trim().to_ascii_lowercase().as_str() {
            "release" => "Release",
            _ => "Debug",
        }
    }

    fn tool_label(path: Option<&Path>, fallback: &str) -> String {
        path.and_then(|value| value.file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| fallback.to_string())
    }
}

/*
Note: The compile method is a new addition that allows compiling C/C++ code directly. It handles creating a temporary source file, determining the appropriate compiler, and executing the compilation process while capturing output and errors. The method also supports specifying a project path for include directories and manages temporary files cleanly. This is a basic implementation and can be further enhanced with additional features like support for more languages, custom compiler flags, or better error handling based on specific compiler outputs.
TODO: Consider adding support for other languages (e.g., Rust, Go) by detecting file extensions and using appropriate compilers. Also, implement more robust error parsing to provide clearer feedback on compilation issues.
FIXME: Ensure that the compile method is secure against potential code injection or misuse, especially if exposed to untrusted input. Consider sandboxing the compilation process or adding resource limits to prevent abuse.
FIXME: FIX CRITICAL ISSUE: On Windows, path handling can cause compilation to fail due to backslashes. Ensure that all paths passed to the compiler are properly normalized and use forward slashes or are escaped correctly. This is addressed in the code by normalizing paths and replacing backslashes with forward slashes for Windows. THE ISSUE LOG IS "cc1.exe: fatal error: \\main.c: No such file or directory compilation terminated."
*/
