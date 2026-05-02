import { api } from './tauri.js';
import { appState } from './state.js';
import { logger } from './logger.js';
import { showToast } from './ui.js';

const POLL_INTERVAL_BUSY_MS = 200;
const POLL_INTERVAL_IDLE_MS = 600;

class PowerShellTerminal {
    constructor() {
        this.sessionId = null;
        this.currentCwd = '';
        this.pollTimer = null;
        this.output = null;
        this.input = null;
        this.form = null;
        this.cwdLabel = null;
        this.restartButton = null;
        this.clearButton = null;
        this.submitButton = null;
        this.statusBadge = null;
        this.historyBadge = null;
        this.ready = false;
        this.busy = false;
        this.history = [];
        this.historyIndex = -1;
    }

    async init() {
        this.output = document.getElementById('terminal-output');
        this.input = document.getElementById('terminal-input');
        this.form = document.getElementById('terminal-form');
        this.cwdLabel = document.getElementById('terminal-cwd');
        this.restartButton = document.getElementById('restart-terminal-btn');
        this.clearButton = document.getElementById('clear-terminal-btn');
        this.submitButton = document.getElementById('terminal-submit-btn');
        this.statusBadge = document.getElementById('terminal-status');
        this.historyBadge = document.getElementById('terminal-history-count');

        if (!this.output || !this.form || !this.input) {
            return;
        }

        this.bindEvents();
        try {
            await this.startSession();
            this.startPolling();
        } catch (error) {
            this.appendLine('stderr', error?.message || String(error));
            logger.err('Failed to initialize PowerShell terminal.', {
                details: error?.message || String(error)
            });
        }
    }

    bindEvents() {
        this.form?.addEventListener('submit', event => {
            event.preventDefault();
            this.runCurrentInput().catch(error => {
                logger.err('Terminal command failed.', {
                    details: error?.message || String(error)
                });
                showToast(error?.message || 'Terminal command failed', 'error');
            });
        });

        this.input?.addEventListener('input', () => this.syncInputHeight());

        this.input?.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.runCurrentInput().catch(error => {
                    logger.err('Terminal command failed.', {
                        details: error?.message || String(error)
                    });
                    showToast(error?.message || 'Terminal command failed', 'error');
                });
                return;
            }

            if (event.key === 'ArrowUp' && this.canNavigateHistory('up')) {
                event.preventDefault();
                this.navigateHistory(-1);
                return;
            }

            if (event.key === 'ArrowDown' && this.canNavigateHistory('down')) {
                event.preventDefault();
                this.navigateHistory(1);
            }
        });

        this.restartButton?.addEventListener('click', () => {
            this.restartSession().catch(error => {
                logger.err('Terminal restart failed.', {
                    details: error?.message || String(error)
                });
            });
        });

        this.clearButton?.addEventListener('click', () => this.clear());
    }

    async startSession(initialCwd = null) {
        const session = await api.createTerminalSession(initialCwd);
        this.sessionId = session.session_id;
        this.currentCwd = session.cwd || '';
        this.ready = true;
        this.busy = false;
        this.updatePrompt();
        this.updateStatus('ready');
        appState.updateTerminalState({
            ready: true,
            running: false,
            cwd: this.currentCwd,
            historySize: this.history.length
        });
        this.appendLine('meta', `${session.shell} session started.`);
        if (this.currentCwd) {
            this.appendLine('meta', `Working directory: ${this.currentCwd}`);
        }
    }

    async restartSession() {
        if (this.sessionId) {
            await api.closeTerminalSession(this.sessionId).catch(() => {});
        }

        this.clear();
        this.sessionId = null;
        this.ready = false;
        this.busy = false;
        this.updateStatus('restarting');
        await this.startSession(this.currentCwd || null);
        logger.info('PowerShell terminal restarted.');
    }

    async runCurrentInput() {
        const input = this.input?.value || '';
        const command = input.trim();
        if (!command) {
            return;
        }

        await this.runCommand(command, {
            echo: true,
            fromEditor: false
        });
        this.input.value = '';
        this.syncInputHeight();
    }

    async runCommand(command, options = {}) {
        if (!this.sessionId) {
            await this.startSession(this.currentCwd || null);
            this.startPolling();
        }

        const normalized = String(command || '').trim();
        if (!normalized || !this.sessionId) {
            return;
        }

        if (options.echo !== false) {
            this.appendLine('input', normalized);
        }

        if (!options.skipHistory) {
            this.pushHistory(normalized);
        }

        this.busy = true;
        this.ready = true;
        this.updateStatus('running');
        appState.updateTerminalState({
            ready: true,
            running: true,
            cwd: this.currentCwd,
            historySize: this.history.length
        });

        await api.executeTerminalCommand(this.sessionId, normalized);
    }

    async runDebugCommand(command) {
        appState.set('outputView', 'terminal');
        await this.runCommand(command, {
            echo: true,
            fromEditor: true
        });
        this.focusInput();
    }

    async setWorkingDirectory(path) {
        if (!this.sessionId || !path) {
            return;
        }

        const nextPath = await api.setTerminalCwd(this.sessionId, path);
        this.currentCwd = nextPath || path;
        this.updatePrompt();
        appState.updateTerminalState({
            cwd: this.currentCwd
        });
    }

    clear() {
        if (this.output) {
            this.output.innerHTML = '';
        }
    }

    focusInput() {
        this.input?.focus();
    }

    startPolling() {
        if (this.pollTimer || !this.sessionId) {
            return;
        }
        this._scheduleNextPoll();
    }

    _scheduleNextPoll() {
        if (!this.sessionId) return;
        const interval = this.busy ? POLL_INTERVAL_BUSY_MS : POLL_INTERVAL_IDLE_MS;
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            this.poll()
                .catch(error => {
                    logger.err('Terminal polling failed.', {
                        details: error?.message || String(error)
                    });
                })
                .finally(() => {
                    if (this.sessionId) {
                        this._scheduleNextPoll();
                    }
                });
        }, interval);
    }

    stopPolling() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async poll() {
        if (!this.sessionId) {
            return;
        }

        const events = await api.drainTerminalOutput(this.sessionId);
        if (!Array.isArray(events) || events.length === 0) {
            return;
        }

        events.forEach(event => this.handleEvent(event));
    }

    handleEvent(event) {
        if (event.kind === 'cwd' && event.cwd) {
            this.currentCwd = event.cwd;
            this.updatePrompt();
            appState.updateTerminalState({
                cwd: this.currentCwd
            });
            return;
        }

        if (event.kind === 'ready') {
            this.ready = true;
            this.busy = false;
            this.updatePrompt();
            this.updateStatus('ready');
            appState.updateTerminalState({
                ready: true,
                running: false,
                cwd: this.currentCwd
            });
            return;
        }

        if (event.kind === 'command-complete') {
            this.busy = false;
            this.updateStatus(event.exit_code === 0 ? 'ready' : 'error');
            appState.updateTerminalState({
                ready: true,
                running: false,
                cwd: event.cwd || this.currentCwd,
                exitCode: event.exit_code ?? null,
                historySize: this.history.length
            });
        }

        if (event.kind === 'session-ended') {
            this.appendLine('meta', event.text || 'PowerShell session ended.');
            this.ready = false;
            this.busy = false;
            this.sessionId = null;
            this.updateStatus('stopped');
            appState.updateTerminalState({
                ready: false,
                running: false,
                cwd: this.currentCwd
            });
            return;
        }

        this.appendLine(event.stream || 'stdout', event.text || '');
    }

    updatePrompt() {
        if (!this.cwdLabel) {
            return;
        }

        this.cwdLabel.textContent = this.currentCwd
            ? `PS ${this.currentCwd}>`
            : 'PS>';
    }

    updateStatus(state) {
        if (this.statusBadge) {
            this.statusBadge.textContent = state;
            this.statusBadge.dataset.terminalState = state;
        }

        if (this.submitButton) {
            this.submitButton.textContent = this.busy ? 'Busy' : 'Run';
        }
    }

    appendLine(stream, text) {
        if (!this.output || !text) {
            return;
        }

        const line = document.createElement('div');
        line.className = `terminal-line ${stream}`;
        line.textContent = text;
        this.output.appendChild(line);
        this.output.scrollTop = this.output.scrollHeight;
    }

    pushHistory(command) {
        if (!command) {
            return;
        }

        const previous = this.history[this.history.length - 1];
        if (previous !== command) {
            this.history.push(command);
        }

        this.historyIndex = this.history.length;
        if (this.historyBadge) {
            this.historyBadge.textContent = `${this.history.length} cmd`;
        }
    }

    canNavigateHistory(direction) {
        if (!this.input || this.history.length === 0) {
            return false;
        }

        const value = this.input.value || '';
        const selectionStart = this.input.selectionStart ?? 0;
        const selectionEnd = this.input.selectionEnd ?? 0;
        const isSingleLine = !value.includes('\n');

        if (!isSingleLine || selectionStart !== selectionEnd) {
            return false;
        }

        if (direction === 'up') {
            return selectionStart === 0 || selectionStart === value.length;
        }

        return selectionStart === value.length;
    }

    navigateHistory(delta) {
        if (!this.input || this.history.length === 0) {
            return;
        }

        const nextIndex = Math.max(
            0,
            Math.min(this.history.length, this.historyIndex + delta)
        );
        this.historyIndex = nextIndex;

        if (this.historyIndex === this.history.length) {
            this.input.value = '';
        } else {
            this.input.value = this.history[this.historyIndex] || '';
        }

        this.syncInputHeight();
        const caret = this.input.value.length;
        this.input.setSelectionRange(caret, caret);
    }

    syncInputHeight() {
        if (!this.input) {
            return;
        }

        this.input.style.height = 'auto';
        this.input.style.height = `${Math.min(this.input.scrollHeight, 140)}px`;
    }

    async dispose() {
        this.stopPolling();
        if (this.sessionId) {
            await api.closeTerminalSession(this.sessionId).catch(() => {});
        }
        this.sessionId = null;
    }
}

export const powerShellTerminal = new PowerShellTerminal();
