use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use regex::Regex;
use tempfile::TempDir;
use tokio::time::timeout;

use crate::models::{AppError, CompileResult, SyntaxError};
use crate::utils::path_validator::PathValidator;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BuildMode {
    Run,
    Debug,
}

impl BuildMode {
    fn from_str(value: Option<&str>) -> Self {
        match value.unwrap_or("run").trim().to_ascii_lowercase().as_str() {
            "debug" => Self::Debug,
            _ => Self::Run,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Debug => "debug",
        }
    }
}

pub struct CompilerService {
    compiler_path: Option<String>,
    debugger_path: Option<String>,
    timeout_duration: Duration,
}

impl CompilerService {
    pub fn new() -> Self {
        Self {
            compiler_path: Self::find_compiler(),
            debugger_path: Self::find_debugger(),
            timeout_duration: Duration::from_secs(30),
        }
    }

    pub fn is_available(&self) -> bool {
        self.compiler_path.is_some()
    }

    pub fn compiler_label(&self) -> String {
        Self::tool_label(self.compiler_path.as_deref(), "No compiler detected")
    }

    pub fn debugger_available(&self) -> bool {
        self.debugger_path.is_some()
    }

    pub fn debugger_label(&self) -> String {
        Self::tool_label(self.debugger_path.as_deref(), "No debugger detected")
    }

    fn tool_label(path: Option<&str>, fallback: &str) -> String {
        path.and_then(|value| Path::new(value).file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| fallback.to_string())
    }

    fn get_exe_directory() -> Option<PathBuf> {
        env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|path| path.to_path_buf()))
    }

    fn find_compiler() -> Option<String> {
        if let Some(compiler) = Self::find_compiler_near_exe() {
            return Some(compiler);
        }

        Self::find_compiler_in_path()
    }

    fn find_compiler_near_exe() -> Option<String> {
        let exe_dir = Self::get_exe_directory()?;

        let candidate_paths = vec![
            exe_dir.join("tools").join("tcc").join("tcc.exe"),
            exe_dir.join("tools").join("tcc").join("bin").join("tcc.exe"),
            exe_dir.join("bin").join("tcc").join("tcc.exe"),
            exe_dir.join("compilers").join("tcc").join("tcc.exe"),
            exe_dir.join("tcc").join("tcc.exe"),
            exe_dir.join("tools").join("mingw64").join("bin").join("gcc.exe"),
            exe_dir.join("mingw64").join("bin").join("gcc.exe"),
            exe_dir.join("bin").join("gcc.exe"),
            exe_dir.join("tools").join("clang").join("bin").join("clang.exe"),
            exe_dir.join("clang").join("bin").join("clang.exe"),
        ];

        for path in candidate_paths {
            if path.exists() {
                tracing::info!("Found compiler at: {}", path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }

        Self::find_compiler_recursive(&exe_dir)
    }

    fn find_compiler_recursive(exe_dir: &Path) -> Option<String> {
        let target_names = ["tcc.exe", "gcc.exe", "clang.exe"];

        for name in target_names {
            if let Some(path) = Self::search_file(exe_dir, name, 3) {
                tracing::info!("Found {} recursively at: {}", name, path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }

        None
    }

    fn search_file(dir: &Path, filename: &str, max_depth: usize) -> Option<PathBuf> {
        if max_depth == 0 {
            return None;
        }

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();

                if path.is_file() && path.file_name()?.to_str()? == filename {
                    return Some(path);
                }

                if path.is_dir() {
                    if let Some(found) = Self::search_file(&path, filename, max_depth - 1) {
                        return Some(found);
                    }
                }
            }
        }

        None
    }

    fn find_compiler_in_path() -> Option<String> {
        let compilers = ["tcc", "gcc", "clang", "cc"];
        for compiler in compilers {
            if let Ok(path) = which::which(compiler) {
                tracing::info!("Found {} in PATH: {}", compiler, path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }

        tracing::warn!("No C compiler found");
        None
    }

    fn find_debugger() -> Option<String> {
        let debuggers = ["gdb", "lldb", "cdb"];
        for debugger in debuggers {
            if let Ok(path) = which::which(debugger) {
                tracing::info!("Found debugger in PATH: {}", path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }

        tracing::warn!("No debugger found");
        None
    }

    pub async fn compile(
        &self,
        code: &str,
        filename: Option<&str>,
        project_path: Option<&Path>,
        file_path: Option<&Path>,
        mode: Option<&str>,
    ) -> Result<CompileResult, AppError> {
        // Input validation
        let trimmed_code = code.trim();
        if trimmed_code.is_empty() {
            return Err(AppError::Compiler(
                "Cannot compile empty source code".to_string(),
            ));
        }

        if trimmed_code.len() > 50 * 1024 * 1024 {
            return Err(AppError::Compiler(
                "Source code too large (> 50MB)".to_string(),
            ));
        }

        let compiler_path = self.compiler_path.clone().ok_or_else(|| {
            AppError::Compiler(
                "No C compiler found. Install GCC, Clang, or TCC to use Run from the editor."
                    .to_string(),
            )
        })?;
        let build_mode = BuildMode::from_str(mode);
        let workspace_dir = match project_path {
            Some(path) => Some(PathValidator::validate_directory_path(path)?),
            None => None,
        };

        let start = Instant::now();
        let mut scratch_dir = None;
        let source_name = filename.unwrap_or("program.c");
    
        // Get the source path
        let source_path = if let Some(path) = file_path {
            let validated = PathValidator::validate_path(path)?;
            let absolute = if !validated.is_absolute() {
                std::fs::canonicalize(&validated)
                    .map_err(|e| AppError::Io(format!("Failed to resolve path: {}", e)))?
            } else {
                validated
            };
            absolute
        } else {
            let temp_dir = TempDir::new().map_err(|error| {
                tracing::warn!("Failed to create temp dir: {}", error);
                AppError::Io(error.to_string())
            })?;
            let src_path = temp_dir.path().join(source_name);
            std::fs::write(&src_path, code).map_err(|error| {
                tracing::warn!("Failed to write source file: {}", error);
                AppError::Io(error.to_string())
            })?;
            scratch_dir = Some(temp_dir);
            src_path
        };

        let output_dir = if let Some(workspace) = &workspace_dir {
            let dir = workspace.join(".cat-editor").join("build").join(build_mode.as_str());
            std::fs::create_dir_all(&dir).map_err(|error| {
                tracing::warn!("Failed to create build dir: {}", error);
                AppError::Io(error.to_string())
            })?;
            dir
        } else {
            scratch_dir
                .as_ref()
                .map(|dir| dir.path().to_path_buf())
                .ok_or_else(|| AppError::Io("Missing build directory.".to_string()))?
        };

        let binary_name = source_path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("program");

        #[cfg(target_os = "windows")]
        let exe_path = output_dir.join(format!("{}.exe", binary_name));
        #[cfg(not(target_os = "windows"))]
        let exe_path = output_dir.join(binary_name);

        let compiler_path_for_task = compiler_path.clone();
        let source_path_for_task = source_path.clone();
        let exe_path_for_task = exe_path.clone();
        let workspace_dir_for_task = workspace_dir.clone();
        let compiler_name = Path::new(&compiler_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        // Run compilation in blocking task
        let compile_output = tokio::task::spawn_blocking(move || {
            // Get the source directory and filename separately
            let source_dir = source_path_for_task
                .parent()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Source directory not found"))?;
        
            // Get JUST the filename (no path)
            let source_filename = source_path_for_task
                .file_name()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Source filename not found"))?;
        
            let source_filename_str = source_filename.to_string_lossy().to_string();
        
            let mut command = Command::new(&compiler_path_for_task);
        
            // CRITICAL FIX: Change to source directory first
            command.current_dir(source_dir);
        
            // Pass ONLY the filename (no path) to the compiler
            command.arg(&source_filename_str);
            command.arg("-o");
            command.arg(&exe_path_for_task);
        
            if build_mode == BuildMode::Debug {
                if compiler_name == "tcc" {
                    command.arg("-g");
                } else {
                    command.arg("-g").arg("-O0");
                }
            }
        
        // Add include paths if needed
            if let Some(workspace) = &workspace_dir_for_task {
                let include_path = workspace.join("include");
                if include_path.exists() {
                    if let Ok(include_abs) = include_path.canonicalize() {
                        let include_str = include_abs.to_string_lossy().to_string();
                        command.arg(format!("-I{}", include_str));
                    }
                }
            }
        
            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);
        
            // Debug logging
            tracing::debug!(
                "Compiling: cd {:?} && {:?} {:?} -o {:?}",
                source_dir,
                compiler_path_for_task,
                source_filename_str,
                exe_path_for_task
            );
        
            command.output()
        }).await;
    
        // Handle the result
        let output = match compile_output {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => {
                return Err(AppError::Compiler(format!("Compilation failed: {}", e)));
            }
            Err(e) => {
                return Err(AppError::Compiler(format!("Compilation task failed: {}", e)));
            }
        };
    
        let execution_time = start.elapsed().as_millis() as u64;
        let compiler_label = Path::new(&compiler_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        if output.status.success() {
            if build_mode == BuildMode::Debug {
                let debugger = self.debugger_path.as_ref().map(|_| self.debugger_label());
                let debugger_command = self.debugger_command(&exe_path);
                let output_message = if debugger_command.is_some() {
                    format!(
                        "Debug build created: {}\nUse the integrated terminal to step through the program.",
                        exe_path.display()
                    )
                } else {
                    format!(
                        "Debug build created: {}\nNo supported debugger was found in PATH.",
                        exe_path.display()
                    )
                };

                Ok(CompileResult {
                    success: true,
                    output: output_message,
                    errors: Vec::new(),
                    execution_time,
                    compiler: compiler_label,
                    diagnostics: Vec::new(),
                    mode: build_mode.as_str().to_string(),
                    binary_path: Some(exe_path.to_string_lossy().to_string()),
                    debugger,
                    debugger_command,
                })
            } else {
                let program_output = self
                    .run_program_hidden(&exe_path, workspace_dir.as_deref())
                    .await;
                Ok(CompileResult {
                    success: true,
                    output: program_output,
                    errors: Vec::new(),
                    execution_time,
                    compiler: compiler_label,
                    diagnostics: Vec::new(),
                    mode: build_mode.as_str().to_string(),
                    binary_path: Some(exe_path.to_string_lossy().to_string()),
                    debugger: None,
                    debugger_command: None,
                })
            }
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let diagnostics = self.parse_errors(&stderr, workspace_dir.as_deref().or(source_path.parent()));

            Ok(CompileResult {
                success: false,
                output: String::new(),
                errors: vec![stderr],
                execution_time,
                compiler: compiler_label,
                diagnostics,
                mode: build_mode.as_str().to_string(),
                binary_path: None,
                debugger: None,
                debugger_command: None,
            })
        }
    }

    fn debugger_command(&self, exe_path: &Path) -> Option<String> {
        let debugger = self.debugger_path.as_ref()?;
        let debugger_name = Path::new(debugger)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let executable = exe_path.to_string_lossy();

        if debugger_name.contains("gdb") {
            return Some(format!("gdb \"{}\"", executable));
        }

        if debugger_name.contains("lldb") {
            return Some(format!("lldb \"{}\"", executable));
        }

        if debugger_name.contains("cdb") {
            return Some(format!("cdb \"{}\"", executable));
        }

        None
    }

    async fn run_program_hidden(&self, exe_path: &Path, cwd: Option<&Path>) -> String {
        if !exe_path.exists() {
            return "Failed to create executable".to_string();
        }

        let executable = exe_path.to_path_buf();
        let working_directory = cwd.map(Path::to_path_buf);
        let result = timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking(move || {
                let mut command = Command::new(&executable);

                #[cfg(target_os = "windows")]
                command.creation_flags(CREATE_NO_WINDOW);

                if let Some(path) = working_directory {
                    command.current_dir(path);
                }

                command.stdout(Stdio::piped()).stderr(Stdio::piped());
                let output = command.output();

                match output {
                    Ok(out) => {
                        let stdout = String::from_utf8_lossy(&out.stdout);
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        let combined = format!("{}{}", stdout, stderr);
                        if combined.trim().is_empty() {
                            "Program completed successfully (no output)".to_string()
                        } else {
                            combined.trim_end().to_string()
                        }
                    }
                    Err(error) => format!("Execution error: {}", error),
                }
            }),
        )
        .await;

        match result {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => format!("Task error: {}", error),
            Err(_) => "Program timeout (5 seconds)".to_string(),
        }
    }

    pub async fn check_syntax(&self, code: &str) -> Result<Vec<SyntaxError>, AppError> {
        let compiler_path = self.compiler_path.clone().ok_or_else(|| {
            AppError::Compiler(
                "No compiler found. Syntax checks are unavailable until a C compiler is installed."
                    .to_string(),
            )
        })?;

        // Validate input: reject empty or too large code
        let trimmed_code = code.trim();
        if trimmed_code.is_empty() {
            tracing::debug!("Syntax check requested on empty code, returning no errors");
            return Ok(Vec::new());
        }

        if trimmed_code.len() > 50 * 1024 * 1024 {
            return Err(AppError::Compiler(
                "Code too large (> 50MB) for syntax check".to_string(),
            ));
        }

        let temp_dir = TempDir::new().map_err(|error| AppError::Io(error.to_string()))?;
        let src_path = temp_dir.path().join("check.c");

        std::fs::write(&src_path, code).map_err(|error| {
            tracing::warn!("Failed to write syntax check file: {}", error);
            AppError::Io(error.to_string())
        })?;

        let result = timeout(
            Duration::from_secs(10),
            tokio::task::spawn_blocking(move || {
                let compiler_name = Path::new(&compiler_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                let mut command = Command::new(&compiler_path);
                command.arg("-c").arg(&src_path);

                #[cfg(target_os = "windows")]
                command.creation_flags(CREATE_NO_WINDOW);

                if compiler_name != "tcc" {
                    command.arg("-fsyntax-only");
                }

                let output = command.output()?;
                Ok::<_, std::io::Error>(String::from_utf8_lossy(&output.stderr).to_string())
            }),
        )
        .await;

        match result {
            Ok(Ok(Ok(stderr))) => Ok(self.parse_errors(&stderr, None)),
            Ok(Ok(Err(error))) => Err(AppError::Compiler(format!(
                "Syntax check failed: {}",
                error
            ))),
            Ok(Err(error)) => Err(AppError::Compiler(format!(
                "Syntax task failed: {}",
                error
            ))),
            Err(_) => Err(AppError::Timeout("Syntax check timeout".to_string())),
        }
    }

    fn parse_errors(&self, stderr: &str, base_dir: Option<&Path>) -> Vec<SyntaxError> {
        let regex = Regex::new(
            r"^(?P<file>.*?):(?P<line>\d+):(?:(?P<column>\d+):)?\s*(?P<kind>fatal error|error|warning):\s*(?P<message>.+)$",
        )
        .unwrap();
        stderr
            .lines()
            .filter_map(|line| {
                let captures = regex.captures(line)?;
                let file = captures.name("file").map(|value| value.as_str().trim());
                let file = file.and_then(|value| Self::normalize_diagnostic_path(value, base_dir));

                Some(SyntaxError {
                    file,
                    // Use 1-based line/column numbers to match common editor conventions
                    line: captures
                        .name("line")
                        .and_then(|value| value.as_str().parse::<usize>().ok())
                        .unwrap_or(1),
                    column: captures
                        .name("column")
                        .and_then(|value| value.as_str().parse::<usize>().ok())
                        .unwrap_or(1),
                    message: captures
                        .name("message")
                        .map(|value| value.as_str().trim().to_string())
                        .unwrap_or_default(),
                    error_type: captures
                        .name("kind")
                        .map(|value| value.as_str().to_string())
                        .unwrap_or_else(|| "error".to_string()),
                })
            })
            .collect()
    }

    pub async fn get_completions(
        &self,
        code: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, AppError> {
        // Lightweight, fast completion: C keywords + identifiers found in the buffer
        let keywords = vec![
            "int", "char", "void", "float", "double", "short", "long", "signed", "unsigned",
            "if", "else", "switch", "case", "for", "while", "do", "return", "break", "continue",
            "struct", "union", "enum", "typedef", "const", "volatile", "static", "extern", "sizeof",
            "include", "define",
        ];

        let mut suggestions = Vec::new();

        if let Some(pref) = prefix {
            let pref = pref.trim();
            for kw in &keywords {
                if kw.starts_with(pref) {
                    suggestions.push(kw.to_string());
                }
            }
        } else {
            suggestions.extend(keywords.into_iter().map(|s| s.to_string()));
        }

        // Extract identifiers from the buffer (very fast regex)
        let ident_re = Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)\b").unwrap();
        let mut seen = std::collections::HashSet::new();
        for cap in ident_re.captures_iter(code) {
            if let Some(id) = cap.get(1) {
                let name = id.as_str();
                if name.len() >= 2 && !seen.contains(name) {
                    seen.insert(name.to_string());
                    if let Some(pref) = prefix {
                        if name.starts_with(pref) {
                            suggestions.push(name.to_string());
                        }
                    } else {
                        suggestions.push(name.to_string());
                    }
                }
            }
            if suggestions.len() >= 200 {
                break;
            }
        }

        // Keep results deterministic and limited
        suggestions.sort();
        suggestions.dedup();
        if suggestions.len() > 100 {
            suggestions.truncate(100);
        }

        Ok(suggestions)
    }

    fn normalize_diagnostic_path(file: &str, base_dir: Option<&Path>) -> Option<String> {
        if file.eq_ignore_ascii_case("check.c") || file.eq_ignore_ascii_case("program.c") {
            return None;
        }

        let file_path = PathBuf::from(file);
        if file_path.is_absolute() {
            return Some(file_path.to_string_lossy().to_string());
        }

        let resolved = base_dir?.join(file_path);
        Some(resolved.to_string_lossy().to_string())
    }
}
