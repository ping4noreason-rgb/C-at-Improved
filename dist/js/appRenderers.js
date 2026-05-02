import { escapeHtml, getFileName, normalizePath } from './utils.js';

export function formatProblemLocation(problem) {
    const fileLabel = problem.file ? getFileName(problem.file) : 'current file';
    return `${fileLabel}:${Number(problem.line || 0) + 1}:${Number(problem.column || 0) + 1}`;
}

export function formatProblemLabel(problem) {
    return `${formatProblemLocation(problem)} | ${problem.message}`;
}

export function renderOutput(appState, onOpenProblem) {
    const container = document.getElementById('output-content');
    if (!container) {
        return;
    }

    const output = appState.getVisibleOutput();
    container.innerHTML = '';

    if (output.length === 0) {
        container.innerHTML = `
            <div class="terminal-empty">
                <strong>No visible logs right now.</strong>
                <p>Run an action or re-enable filtered log groups.</p>
            </div>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();

    output.forEach(entry => {
        const row = document.createElement('div');
        row.className = `output-line level-${entry.level.toLowerCase()}`;

        const badge = document.createElement('span');
        badge.className = 'output-badge';
        badge.textContent = `[${entry.level}]`;

        const content = document.createElement('div');
        content.className = 'output-body';

        const head = document.createElement('div');
        head.className = 'output-head';
        head.innerHTML = `
            <span class="output-message">${escapeHtml(entry.message)}</span>
            <span class="output-time">${escapeHtml(entry.timestamp)}</span>
        `;
        content.appendChild(head);

        if (entry.context) {
            const context = document.createElement('div');
            context.className = 'output-context';
            context.textContent = entry.context;
            content.appendChild(context);
        }

        if (entry.problems?.length) {
            const problemList = document.createElement('div');
            problemList.className = 'output-problems';

            entry.problems.forEach(problem => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'problem-link';
                button.textContent = formatProblemLabel(problem);
                button.addEventListener('click', () => onOpenProblem(problem));
                problemList.appendChild(button);
            });

            content.appendChild(problemList);
        }

        if (entry.details) {
            const details = document.createElement('pre');
            details.className = 'output-details';
            details.textContent = entry.details;
            content.appendChild(details);
        }

        row.append(badge, content);
        fragment.appendChild(row);
    });

    container.appendChild(fragment);
    container.scrollTop = container.scrollHeight;
}

export function renderProblemsPanel(appState, onOpenProblem) {
    const container = document.getElementById('problem-list');
    const count = document.getElementById('problem-count');
    if (!container) {
        return;
    }

    const currentFile = appState.get('currentFile');
    const currentPath = normalizePath(currentFile?.path || '');
    const problems = appState.get('problems') || [];

    if (count) {
        count.textContent = String(problems.length);
    }

    container.innerHTML = '';

    if (problems.length === 0) {
        container.innerHTML = `
            <div class="empty-card">
                <strong>No problems detected.</strong>
                <p>Save the current file or run it to refresh diagnostics.</p>
            </div>
        `;
        return;
    }

    problems.forEach(problem => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'problem-item';
        if (normalizePath(problem.file || '') === currentPath) {
            item.classList.add('active');
        }

        item.innerHTML = `
            <div class="problem-item-head">
                <span class="problem-kind ${problem.errorType.toLowerCase().includes('warning') ? 'warning' : 'error'}">
                    ${escapeHtml(problem.errorType)}
                </span>
                <span class="problem-location">${escapeHtml(formatProblemLocation(problem))}</span>
            </div>
            <div class="problem-message">${escapeHtml(problem.message)}</div>
        `;

        item.addEventListener('click', () => onOpenProblem(problem));
        container.appendChild(item);
    });
}

export function renderGitStatus(appState, fileTree, onOpenGitFile) {
    const status = appState.get('gitStatus');
    const project = appState.get('currentProject');
    const branch = document.getElementById('git-branch');
    const summary = document.getElementById('git-summary');
    const list = document.getElementById('git-status-list');
    const initButton = document.getElementById('init-git-btn');
    const stageButton = document.getElementById('git-stage-all-btn');
    const commitButton = document.getElementById('git-commit-btn');
    const pullButton = document.getElementById('git-pull-btn');
    const pushButton = document.getElementById('git-push-btn');

    if (branch) {
        branch.textContent = status?.repository
            ? (status.branch || 'detached')
            : 'No repository';
    }

    if (summary) {
        summary.textContent = !project
            ? 'Open a workspace to inspect repository status.'
            : !status
                ? 'Loading repository status...'
                : !status.available
                    ? 'Git is not available on this machine.'
                    : !status.repository
                        ? (status.message || 'Initialize a repository in this workspace.')
                        : status.clean
                            ? 'Working tree is clean.'
                            : `${status.entries.length} file(s) changed${status.ahead || status.behind ? ` | ahead ${status.ahead}, behind ${status.behind}` : ''}.`;
    }

    if (initButton) {
        initButton.disabled = !project || Boolean(status?.repository) || !status?.available;
    }
    if (stageButton) {
        stageButton.disabled = !project || !status?.repository || status.clean;
    }
    if (commitButton) {
        commitButton.disabled = !project || !status?.repository || status.clean;
    }
    if (pullButton) {
        pullButton.disabled = !project || !status?.repository;
    }
    if (pushButton) {
        pushButton.disabled = !project || !status?.repository;
    }

    if (!list) {
        return;
    }

    list.innerHTML = '';

    if (!project) {
        list.innerHTML = `
            <div class="empty-card">
                <strong>No workspace open.</strong>
                <p>Select a project to work with Git.</p>
            </div>
        `;
        return;
    }

    if (!status?.available) {
        list.innerHTML = `
            <div class="empty-card">
                <strong>Git not found.</strong>
                <p>Install Git and reopen the editor to enable repository actions.</p>
            </div>
        `;
        return;
    }

    if (!status.repository) {
        list.innerHTML = `
            <div class="empty-card">
                <strong>No repository yet.</strong>
                <p>Use the Init button to run <code>git init</code> for this workspace.</p>
            </div>
        `;
        return;
    }

    if (!status.entries?.length) {
        list.innerHTML = `
            <div class="empty-card">
                <strong>Working tree clean.</strong>
                <p>No staged or unstaged changes right now.</p>
            </div>
        `;
        return;
    }

    status.entries.forEach(entry => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'git-item';
        item.innerHTML = `
            <span class="git-item-status">${escapeHtml(entry.status || '--')}</span>
            <span class="git-item-path">${escapeHtml(entry.path)}</span>
            <span class="git-item-meta">${entry.untracked ? 'new' : entry.staged ? 'staged' : entry.has_unstaged ? 'modified' : 'changed'}</span>
        `;
        item.addEventListener('click', () => {
            if (!entry.deleted) {
                const targetPath = status.repo_root
                    ? `${status.repo_root}\\${entry.path.replace(/\//g, '\\')}`
                    : entry.path;
                onOpenGitFile(targetPath, fileTree);
            }
        });
        list.appendChild(item);
    });
}

export function renderRunTools(appState) {
    const runtimeStatus = appState.get('runtimeStatus');
    const tooling = appState.get('workspaceTooling');
    const terminalState = appState.get('terminalState') || {};
    const currentProject = appState.get('currentProject');

    const compiler = document.getElementById('runtime-compiler');
    const debuggerLabel = document.getElementById('runtime-debugger');
    const git = document.getElementById('runtime-git');
    const packages = document.getElementById('runtime-packages');
    const terminal = document.getElementById('runtime-terminal');
    const buildSystem = document.getElementById('runtime-build-system');
    const formatter = document.getElementById('runtime-formatter');
    const runButton = document.getElementById('run-panel-run-btn');
    const debugButton = document.getElementById('run-panel-debug-btn');
    const buildButton = document.getElementById('build-project-btn');
    const configureButton = document.getElementById('configure-project-btn');
    const formatButton = document.getElementById('format-code-btn');
    const installButton = document.getElementById('install-library-btn');

    if (compiler) {
        compiler.textContent = runtimeStatus?.compiler_available
            ? runtimeStatus.compiler_label
            : 'Not available';
    }
    if (debuggerLabel) {
        debuggerLabel.textContent = runtimeStatus?.debugger_available
            ? runtimeStatus.debugger_label
            : 'Not available';
    }
    if (git) {
        git.textContent = runtimeStatus?.git_available ? 'Ready' : 'Not installed';
    }
    if (packages) {
        packages.textContent = runtimeStatus?.package_managers?.length
            ? runtimeStatus.package_managers.join(', ')
            : 'No supported managers';
    }
    if (terminal) {
        terminal.textContent = terminalState.running
            ? `Running in ${terminalState.cwd || 'shell'}`
            : terminalState.ready
                ? `Ready in ${terminalState.cwd || 'shell'}`
                : 'Terminal offline';
    }
    if (buildSystem) {
        buildSystem.textContent = tooling?.preferred_build_system
            ? tooling.preferred_build_system.toUpperCase()
            : 'No build system';
    }
    if (formatter) {
        formatter.textContent = runtimeStatus?.formatter_available
            ? runtimeStatus.formatter_label
            : 'Not available';
    }

    if (runButton) {
        runButton.disabled = !currentProject;
    }
    if (debugButton) {
        debugButton.disabled = !currentProject;
    }
    if (buildButton) {
        buildButton.disabled = !currentProject || !tooling?.preferred_build_system;
    }
    if (configureButton) {
        configureButton.disabled = !currentProject || !tooling?.preferred_build_system;
    }
    if (formatButton) {
        formatButton.disabled = !currentProject || !runtimeStatus?.formatter_available;
    }
    if (installButton) {
        installButton.disabled = !currentProject || !(runtimeStatus?.package_managers?.length);
    }
}
