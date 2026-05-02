import { logger } from './logger.js';

let invoke = null;
let tauriConnected = false;

const mockState = {
    projects: [],
    files: new Map(),
    contents: new Map(),
    terminalSessionId: 'mock-terminal',
    terminalOutput: [],
    terminalCwd: 'C:/mock',
    gitInitialized: false
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createMockFile(path, name, isDirectory = false) {
    return {
        name,
        path,
        size: isDirectory ? 0 : (mockState.contents.get(path)?.length || 0),
        is_directory: isDirectory,
        modified: new Date().toLocaleString(),
        extension: isDirectory ? null : name.split('.').pop() || null
    };
}

function getParentPath(path) {
    const normalized = String(path || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function ensureMockFolder(path) {
    if (!mockState.files.has(path)) {
        mockState.files.set(path, []);
    }
}

function addMockChild(parentPath, file) {
    ensureMockFolder(parentPath);
    const siblings = mockState.files.get(parentPath) || [];
    if (!siblings.some(entry => entry.path === file.path)) {
        siblings.push(file);
        siblings.sort((a, b) => {
            if (a.is_directory !== b.is_directory) {
                return a.is_directory ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
        mockState.files.set(parentPath, siblings);
    }
}

function buildMockProject(name) {
    const projectPath = `mock/${name}`;
    const srcPath = `${projectPath}/src`;
    const includePath = `${projectPath}/include`;
    const mainPath = `${srcPath}/main.c`;
    const headerPath = `${includePath}/app.h`;
    const readmePath = `${projectPath}/README.md`;
    const cmakePath = `${projectPath}/CMakeLists.txt`;
    const makePath = `${projectPath}/Makefile`;
    const now = new Date().toLocaleString();

    const project = {
        name,
        path: projectPath,
        created: now,
        modified: now,
        file_count: 5
    };

    const srcFolder = createMockFile(srcPath, 'src', true);
    const includeFolder = createMockFile(includePath, 'include', true);
    const mainFile = createMockFile(mainPath, 'main.c');
    const headerFile = createMockFile(headerPath, 'app.h');
    const readmeFile = createMockFile(readmePath, 'README.md');
    const cmakeFile = createMockFile(cmakePath, 'CMakeLists.txt');
    const makeFile = createMockFile(makePath, 'Makefile');

    mockState.contents.set(
        mainPath,
        '#include <stdio.h>\n#include "app.h"\n\nint main(void) {\n    print_message();\n    return 0;\n}\n'
    );
    mockState.contents.set(
        headerPath,
        '#ifndef APP_H\n#define APP_H\n\nvoid print_message(void);\n\n#endif\n'
    );
    mockState.contents.set(
        readmePath,
        `# ${name}\n\nProject scaffold created in web preview mode.\n`
    );
    mockState.contents.set(
        cmakePath,
        `cmake_minimum_required(VERSION 3.18)\nproject(${name} C)\n\nadd_executable(${name} src/main.c)\ntarget_include_directories(${name} PRIVATE include)\n`
    );
    mockState.contents.set(
        makePath,
        'all:\n\t@echo Building mock target\n'
    );
    mockState.projects.push(project);
    mockState.projects.sort((a, b) => a.name.localeCompare(b.name));
    ensureMockFolder(projectPath);
    ensureMockFolder(srcPath);
    ensureMockFolder(includePath);
    addMockChild(projectPath, srcFolder);
    addMockChild(projectPath, includeFolder);
    addMockChild(projectPath, cmakeFile);
    addMockChild(projectPath, makeFile);
    addMockChild(projectPath, readmeFile);
    addMockChild(srcPath, mainFile);
    addMockChild(includePath, headerFile);

    return project;
}

function buildMockTree(path) {
    const entries = mockState.files.get(path) || [];
    return entries.map(entry => ({
        name: entry.name,
        path: entry.path,
        is_directory: entry.is_directory,
        extension: entry.extension,
        children: entry.is_directory ? buildMockTree(entry.path) : []
    }));
}

function pushMockTerminal(stream, text, extra = {}) {
    mockState.terminalOutput.push({
        stream,
        text,
        kind: extra.kind || null,
        cwd: extra.cwd || null,
        exit_code: Number.isInteger(extra.exit_code) ? extra.exit_code : null
    });
}

async function mockInvoke(cmd, args = {}) {
    switch (cmd) {
        case 'get_projects':
            return [...mockState.projects];

        case 'create_project':
            return buildMockProject(args.name);

        case 'get_files':
            return [...(mockState.files.get(args.path) || [])];

        case 'get_file_tree':
            return buildMockTree(args.path);

        case 'get_file_content':
            return mockState.contents.get(args.path) || '';

        case 'save_file':
            mockState.contents.set(args.path, args.content);
            return null;

        case 'create_file': {
            const path = `${args.parentPath}/${args.name}`.replace(/\\/g, '/');
            const file = createMockFile(path, args.name);
            mockState.contents.set(path, args.name.endsWith('.md') ? '' : '/* Mock file */\n');
            addMockChild(args.parentPath.replace(/\\/g, '/'), file);
            return file;
        }

        case 'create_folder': {
            const path = `${args.parentPath}/${args.name}`.replace(/\\/g, '/');
            const folder = createMockFile(path, args.name, true);
            ensureMockFolder(path);
            addMockChild(args.parentPath.replace(/\\/g, '/'), folder);
            return folder;
        }

        case 'delete_file_safe': {
            const parent = getParentPath(args.path);
            mockState.contents.delete(args.path);
            mockState.files.delete(args.path);
            if (mockState.files.has(parent)) {
                mockState.files.set(
                    parent,
                    (mockState.files.get(parent) || []).filter(entry => entry.path !== args.path)
                );
            }
            return null;
        }

        case 'rename_file': {
            const parent = getParentPath(args.path);
            const siblings = mockState.files.get(parent) || [];
            const target = siblings.find(entry => entry.path === args.path);
            if (!target) {
                throw new Error('Mock file not found');
            }
            target.name = args.newName;
            target.path = `${parent}/${args.newName}`;
            return null;
        }

        case 'compile_code':
            return {
                success: true,
                output: 'Mock run completed.',
                execution_time: 42,
                compiler: 'mock',
                errors: [],
                diagnostics: [],
                mode: args.mode || 'run',
                binary_path: `${args.projectPath || 'mock/build'}/program.exe`,
                debugger: 'mock-gdb',
                debugger_command: 'gdb "mock/build/program.exe"'
            };

        case 'check_syntax':
            return [];

        case 'get_system_info':
            return {
                ram_used: 2 * 1024 * 1024 * 1024,
                ram_total: 8 * 1024 * 1024 * 1024,
                cpu_usage: 12
            };

        case 'get_runtime_status':
            return {
                compiler_available: true,
                compiler_label: 'mock',
                debugger_available: true,
                debugger_label: 'mock-gdb',
                cmake_available: true,
                cmake_label: 'cmake',
                make_available: true,
                make_label: 'make',
                formatter_available: true,
                formatter_label: 'clang-format',
                git_available: true,
                package_managers: ['vcpkg', 'npm', 'pip'],
                project_roots: ['mock']
            };

        case 'get_workspace_tooling':
            return {
                preferred_build_system: 'cmake',
                cmake: {
                    kind: 'cmake',
                    available: true,
                    detected: true,
                    configured: true,
                    config_path: `${args.projectPath}/CMakeLists.txt`,
                    build_dir: `${args.projectPath}/.cat-editor/build/cmake`,
                    description: 'Project includes CMakeLists.txt'
                },
                make: {
                    kind: 'make',
                    available: true,
                    detected: true,
                    configured: true,
                    config_path: `${args.projectPath}/Makefile`,
                    build_dir: args.projectPath,
                    description: 'Project includes a Makefile'
                },
                formatter_available: true,
                formatter_label: 'clang-format'
            };

        case 'configure_project_build':
            return {
                success: true,
                command: `configure ${args.system || 'cmake'} (${args.mode || 'debug'})`,
                stdout: 'Mock configure completed.',
                stderr: '',
                exit_code: 0
            };

        case 'build_project':
            return {
                success: true,
                command: `build ${args.system || 'cmake'} (${args.mode || 'debug'})`,
                stdout: 'Mock build completed successfully.',
                stderr: '',
                exit_code: 0
            };

        case 'format_source_file':
            return {
                changed: true,
                formatter: 'clang-format',
                formatted_content: String(args.content || '').replace(/\t/g, '    '),
                stdout: 'Mock formatting completed.',
                stderr: ''
            };

        case 'create_terminal_session':
            pushMockTerminal('meta', 'Windows PowerShell ready.', {
                kind: 'ready',
                cwd: mockState.terminalCwd,
                exit_code: null
            });
            return {
                session_id: mockState.terminalSessionId,
                shell: 'Windows PowerShell',
                cwd: mockState.terminalCwd
            };

        case 'execute_terminal_command':
            pushMockTerminal('stdout', `Executed: ${args.input}`);
            pushMockTerminal('meta', `Working directory: ${mockState.terminalCwd}`, {
                kind: 'cwd',
                cwd: mockState.terminalCwd,
                exit_code: null
            });
            pushMockTerminal('meta', 'Command finished with exit code 0.', {
                kind: 'command-complete',
                cwd: mockState.terminalCwd,
                exit_code: 0
            });
            return null;

        case 'set_terminal_cwd':
            mockState.terminalCwd = args.path.replace(/\\/g, '/');
            pushMockTerminal('meta', `Working directory: ${mockState.terminalCwd}`, {
                kind: 'cwd',
                cwd: mockState.terminalCwd,
                exit_code: null
            });
            return mockState.terminalCwd;

        case 'drain_terminal_output': {
            const output = [...mockState.terminalOutput];
            mockState.terminalOutput = [];
            return output;
        }

        case 'close_terminal_session':
            pushMockTerminal('meta', 'PowerShell session ended.', {
                kind: 'session-ended',
                exit_code: null
            });
            return null;

        case 'get_git_status':
            return mockState.gitInitialized
                ? {
                    available: true,
                    repository: true,
                    repo_root: 'mock/demo',
                    branch: 'main',
                    upstream: 'origin/main',
                    ahead: 0,
                    behind: 0,
                    clean: false,
                    message: null,
                    entries: [
                        {
                            path: 'main.c',
                            status: 'M',
                            staged_status: ' ',
                            unstaged_status: 'M',
                            staged: false,
                            has_unstaged: true,
                            untracked: false,
                            deleted: false,
                            renamed: false
                        }
                    ]
                }
                : {
                    available: true,
                    repository: false,
                    repo_root: null,
                    branch: null,
                    upstream: null,
                    ahead: 0,
                    behind: 0,
                    clean: true,
                    message: 'Workspace is not a Git repository yet.',
                    entries: []
                };

        case 'init_git_repository':
            mockState.gitInitialized = true;
            return {
                success: true,
                command: 'git init',
                stdout: 'Initialized empty Git repository',
                stderr: '',
                exit_code: 0
            };

        case 'git_stage_all':
            return {
                success: true,
                command: 'git add -A',
                stdout: 'Staged all changes',
                stderr: '',
                exit_code: 0
            };

        case 'git_commit':
            return {
                success: true,
                command: `git commit -m "${args.message}"`,
                stdout: '[main abc1234] Mock commit',
                stderr: '',
                exit_code: 0
            };

        case 'git_pull':
            return {
                success: true,
                command: 'git pull --stat',
                stdout: 'Already up to date.',
                stderr: '',
                exit_code: 0
            };

        case 'git_push':
            return {
                success: true,
                command: 'git push',
                stdout: 'Everything up-to-date',
                stderr: '',
                exit_code: 0
            };

        case 'install_package':
            return {
                success: true,
                command: `${args.manager} install ${args.packageName}`,
                stdout: `Installed ${args.packageName} via ${args.manager}.`,
                stderr: '',
                exit_code: 0
            };

        case 'window_minimize':
        case 'window_close':
            return null;

        case 'window_toggle_maximize':
            return true;

        case 'window_is_maximized':
            return false;

        default:
            return null;
    }
}

async function waitForTauri(maxAttempts = 50, delayMs = 100) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (window.__TAURI__) {
            return window.__TAURI__;
        }
        await sleep(delayMs);
    }

    return null;
}

export async function initTauri() {
    const tauri = await waitForTauri();

    if (tauri) {
        invoke = tauri.core?.invoke || tauri.invoke || null;

        if (invoke) {
            tauriConnected = true;
            logger.sys('Native Tauri bridge connected.');
            return true;
        }
    }

    invoke = mockInvoke;
    logger.err('Tauri bridge is unavailable. Running in fallback web mode.');
    return false;
}

async function safeInvoke(cmd, args = {}) {
    if (!invoke) {
        throw new Error('Tauri bridge has not been initialized');
    }

    try {
        return await invoke(cmd, args);
    } catch (error) {
        const message = typeof error === 'string'
            ? error
            : error?.message || JSON.stringify(error);

        console.error(
            `[ERR] Command failed: ${cmd}`,
            tauriConnected ? 'native command error' : 'fallback command error',
            message
        );

        throw new Error(message);
    }
}

export function getWindow() {
    return null;
}

export function isNativeTauri() {
    return tauriConnected;
}

export const api = {
    async getProjects() { return await safeInvoke('get_projects'); },
    async createProject(name) { return await safeInvoke('create_project', { name }); },
    async getFiles(path) { return await safeInvoke('get_files', { path }); },
    async getFileTree(path) { return await safeInvoke('get_file_tree', { path }); },
    async getFileContent(path) { return await safeInvoke('get_file_content', { path }); },
    async saveFile(path, content) { return await safeInvoke('save_file', { path, content }); },
    async createFile(parentPath, name) { return await safeInvoke('create_file', { parentPath, name }); },
    async createFolder(parentPath, name) { return await safeInvoke('create_folder', { parentPath, name }); },
    async deleteFile(path) { return await safeInvoke('delete_file_safe', { path }); },
    async renameFile(path, newName) { return await safeInvoke('rename_file', { path, newName }); },
    async compile(code, filename, options = {}) {
        return await safeInvoke('compile_code', {
            code,
            filename,
            projectPath: options.projectPath,
            filePath: options.filePath,
            mode: options.mode
        });
    },
    async checkSyntax(code) { return await safeInvoke('check_syntax', { code }); },
    async getSystemInfo() { return await safeInvoke('get_system_info'); },
    async getRuntimeStatus() { return await safeInvoke('get_runtime_status'); },
    async getWorkspaceTooling(projectPath) { return await safeInvoke('get_workspace_tooling', { projectPath }); },
    async configureProjectBuild(projectPath, system, mode) {
        return await safeInvoke('configure_project_build', { projectPath, system, mode });
    },
    async buildProject(projectPath, system, mode) {
        return await safeInvoke('build_project', { projectPath, system, mode });
    },
    async formatSourceFile(path, content) {
        return await safeInvoke('format_source_file', { path, content });
    },
    async createTerminalSession(initialCwd) { return await safeInvoke('create_terminal_session', { initialCwd }); },
    async executeTerminalCommand(sessionId, input) { return await safeInvoke('execute_terminal_command', { sessionId, input }); },
    async setTerminalCwd(sessionId, path) { return await safeInvoke('set_terminal_cwd', { sessionId, path }); },
    async drainTerminalOutput(sessionId) { return await safeInvoke('drain_terminal_output', { sessionId }); },
    async closeTerminalSession(sessionId) { return await safeInvoke('close_terminal_session', { sessionId }); },
    async getGitStatus(projectPath) { return await safeInvoke('get_git_status', { projectPath }); },
    async initGitRepository(projectPath) { return await safeInvoke('init_git_repository', { projectPath }); },
    async gitStageAll(projectPath) { return await safeInvoke('git_stage_all', { projectPath }); },
    async gitCommit(projectPath, message) { return await safeInvoke('git_commit', { projectPath, message }); },
    async gitPull(projectPath) { return await safeInvoke('git_pull', { projectPath }); },
    async gitPush(projectPath) { return await safeInvoke('git_push', { projectPath }); },
    async installPackage(projectPath, manager, packageName) {
        return await safeInvoke('install_package', { projectPath, manager, packageName });
    },
    async minimizeWindow() { return await safeInvoke('window_minimize'); },
    async toggleMaximizeWindow() { return await safeInvoke('window_toggle_maximize'); },
    async isMaximizedWindow() { return await safeInvoke('window_is_maximized'); },
    async closeWindow() { return await safeInvoke('window_close'); },
    async getCompletions(code, prefix) {
        return await safeInvoke('get_completions', { code, prefix });
    }
};
