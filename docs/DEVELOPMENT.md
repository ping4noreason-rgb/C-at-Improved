Cat Editor — Development & Compilation Guide
============================================

Status: Production-ready developer documentation
License: AGPL v3 (see LICENSE)

Overview
--------
This document explains how to build, check, and debug the native Rust/Tauri backend and how the C compilation pipeline is implemented and hardened for Windows path edge-cases.

Project Architecture
--------------------
C-at Editor is a Tauri v2 application with a Rust backend and vanilla JavaScript frontend.

### Backend (src-tauri/)
Built with Rust, organized into layered modules:

- **main.rs** — Application entry point, service initialization, Tauri command registration
- **commands/** — Tauri IPC handlers (15+ commands exposed to frontend)
  - `build.rs` — Project build configuration and execution
  - `compiler.rs` — Code compilation and syntax checking
  - `filesystem.rs` — File tree, read/write, create, delete operations
  - `git.rs` — Git status, stage, commit, push, pull
  - `packages.rs` — Package/dependency management
  - `projects.rs` — Project CRUD operations
  - `system.rs` — System info and runtime status
  - `terminal.rs` — Terminal session management
  - `window.rs` — Custom titlebar window controls
- **services/** — Core business logic
  - `build_service.rs` — Project build orchestration
  - `compiler_service.rs` — C compilation (TCC/GCC), syntax checking, diagnostics parsing
  - `file_service.rs` — File I/O, tree building, encoding detection (UTF-8/16, Windows-1252)
  - `git_service.rs` — Git operations via CLI
  - `monitor_service.rs` — System resource monitoring
  - `package_service.rs` — Package management
  - `terminal_service.rs` — Terminal session handling
  - `trash_service.rs` — Safe file deletion via system trash
- **models/** — Shared data structures (`AppError`, `CompileResult`, `FileInfo`, `ProjectInfo`)
- **utils/** — Path validation, error handling, panic hooks

### Frontend (dist/)
Vanilla JS modular application (no framework):

- `app.js` — Main application class, workspace management, output panel
- `editor.js` — CodeMirror 5.x integration with C mode, dark/light theme
- `fileTree.js` — Recursive file tree rendering with selection
- `terminal.js` — PowerShell terminal emulation via Tauri API
- `fileImport.js` — File/folder import with structure preservation
- `appActions.js` — Menu actions and command bindings
- `appRenderers.js` — UI rendering (problems, git status, projects)
- `editorHints.js` — Autocompletion and inline hints
- `state.js` — Application state management
- `tauri.js` — Tauri API bridge (native vs web fallback)
- `ui.js` — Dialogs, toasts, form controls
- `utils.js` — HTML escaping, path normalization, validation
- `logger.js` — Console logging utility

### Configuration
- `tauri.conf.json` — Window (1200x800, frameless), NSIS installer (EN/RU), WebView2 bootstrapper
- `Cargo.toml` — Dependencies: tauri v2, tokio, sysinfo, walkdir, tempfile, which, regex, chrono, uuid, dirs, tracing, trash, futures, mime_guess, encoding_rs
- `build.rs` — Minimal Tauri build script

### CI/CD
- `.github/workflows/build.yml` — GitHub Actions: builds on Windows, installs Rust + Node.js, runs `cargo tauri build`

Goals
-----
- Provide reproducible developer steps for local checks (`cargo check`, optional Node.js/static checks).
- Explain the root cause and the fix for the Windows compiler path problem (compiler writing to `//main.exe` or `//?/C:/...`).
- Give clear reproduction and validation steps and point to the exact code locations changed.

What was failing (root cause)
-----------------------------
On Windows, canonicalizing paths can produce an extended-length path that begins with the `\\?\` prefix (or equivalent forms). When those paths were converted to plain strings and then massaged (backslashes replaced with forward slashes) to create compiler flag arguments, the resulting strings sometimes began with `//?/` or other malformed leading slashes. Passing such malformed paths to compilers produced errors like:

- `tcc: error: could not write '//main.exe': No such file or directory`
- `ld.exe: cannot open output file //?/C:/.../main.exe: No error`

Both errors are caused by an incorrect string representation of the desired output path being given to the compiler/linker.

What I changed (summary)
------------------------
Files modified:
- `src-tauri/src/services/compiler_service.rs`
  - Sanitizes Windows extended path prefixes such as `\\?\\` and `\\?\\UNC\\` before converting paths to compiler-flag strings.
  - Normalizes diagnostic file paths emitted by compilers by stripping these prefixes.
- `src-tauri/src/utils/path_validator.rs`
  - Removed two unused legacy constants to reduce noise/warnings.

Key technical points:
- The code now strips `\\?\\` and `//?/` variants before performing any `\\ -> /` conversions.
- Diagnostic lines from compilers (stderr) are normalized so they map back to real filesystem paths in the workspace.

Why this is safe
-----------------
- The changes only alter how paths are represented in compiler flags and diagnostics; they do not change the target directories or behavior of the built binaries.
- Windows extended-length prefixes are purely an API-level representation. Removing the `\\?\\` prefix returns a normal absolute path which compilers and linkers expect.

How to reproduce the original issue (before the fix)
---------------------------------------------------
1. On Windows, prepare a project with a C source file (for example `main.c`).
2. Ensure a compiler (TCC or GCC) is available in PATH or in the `tools` folder next to the application executable.
3. Invoke the application compile feature that delegates to the local compiler. If the application passed a long-path with the `\\?\\` prefix as a simple string with backslashes replaced by `/`, you would get an error like the ones above.

How to verify the fix locally
-----------------------------
- Quick Rust build check (verifies code compiles):

```powershell
cd src-tauri
cargo check
```

- End-to-end verification (requires a C compiler available):
  1. Create a temporary C file `test.c`:

```c
#include <stdio.h>
int main(void) { puts("hello"); return 0; }
```

  2. Use the app UI or call the backend compile command (the application will pick an available compiler). Alternatively compile directly with the detected binaries:

```powershell
# If using GCC
gcc test.c -o test.exe
# If using TCC
tcc test.c -o test.exe
```

  3. Confirm the produced `test.exe` appears in the build directory and runs without errors.

Developer notes & code pointers
-------------------------------
- The compiler invocation happens in `src-tauri/src/services/compiler_service.rs`.
  - Look at `compiler_path_arg` — this function now strips Windows extended prefixes and returns a portable path string suitable for passing to compilers.
  - Look at `normalize_diagnostic_path` — compiler diagnostics are mapped back to correct local paths.
- Path validation logic is in `src-tauri/src/utils/path_validator.rs`.
- `AppState` struct in `main.rs` shares all services via `Arc` for thread-safe access across Tauri commands.
- Frontend communicates via `invoke()` calls defined in `tauri.js`, with fallback for non-Tauri environments.

If you need to debug further:
- Enable debug logs (Tauri/Rust logging) and reproduce the compile step; inspect the `Compiling: cd ... && ... -o ...` debug log emitted by the backend. That log shows both the current directory and the exact arguments passed to the compiler.

Node.js / Frontend checks (optional)
------------------------------------
This repository contains a small Node-based smoke-check script at the repository root (`frontend-smoke-check.mjs`). The project does not include a `package.json` by default; if your frontend uses Node tooling, do:

```powershell
# in frontend dir (if present)
npm install
npm run lint   # or the appropriate script provided by the project
```

License
-------
This project is provided under AGPL v3 (see the repository `LICENSE` file).

Next steps (suggested)
----------------------
- (Optional) Add CI steps to run `cargo check` and any Node linters on push/PR to prevent regressions.
- (Optional) Add a small integration test to exercise the compiler path code by invoking the service with a synthetic long-path to ensure the prefix stripping remains effective.
- (Optional) Expand test coverage for `file_service.rs` encoding detection and `terminal_service.rs` session management.

Contact / Changes
-----------------
- The path-fix was implemented by sanitizing Windows extended prefixes prior to constructing compiler flags and before converting backslashes to slashes.
- If you want I can also: remove any remaining legacy comments found across the repo (please confirm which comments you consider "legacy"), or add CI job configs for `cargo check` and Node linters.
