const MAX_OUTPUT_ENTRIES = 600;

const DEFAULT_OUTPUT_FILTERS = Object.freeze({
    SYS: true,
    INFO: true,
    ERR: true
});

function cloneFilters(filters) {
    return {
        ...DEFAULT_OUTPUT_FILTERS,
        ...(filters || {})
    };
}

function createTimestamp() {
    return new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

let entryCounter = 0;
function nextEntryId() {
    entryCounter = (entryCounter + 1) >>> 0;
    return `${Date.now().toString(36)}-${entryCounter.toString(36)}`;
}

function normalizeOutputEntry(entryOrMessage, options = {}) {
    if (typeof entryOrMessage === 'object' && entryOrMessage !== null) {
        return {
            id: entryOrMessage.id || nextEntryId(),
            timestamp: entryOrMessage.timestamp || createTimestamp(),
            level: entryOrMessage.level || 'SYS',
            message: entryOrMessage.message || '',
            context: entryOrMessage.context || '',
            details: entryOrMessage.details || '',
            problems: Array.isArray(entryOrMessage.problems) ? entryOrMessage.problems : []
        };
    }

    return {
        id: nextEntryId(),
        timestamp: createTimestamp(),
        level: options.level || (options.isError ? 'ERR' : 'SYS'),
        message: String(entryOrMessage ?? ''),
        context: options.context || '',
        details: options.details || '',
        problems: Array.isArray(options.problems) ? options.problems : []
    };
}

class AppState {
    constructor() {
        this._state = {
            currentProject: null,
            currentFile: null,
            openFiles: new Map(),
            activeTab: null,
            fileTree: null,
            output: [],
            outputFilters: cloneFilters(),
            outputView: 'logs',
            outputVisible: true,
            outputHeight: 230,
            sidebarView: 'explorer',
            runtimeStatus: null,
            workspaceTooling: null,
            workspaceTree: [],
            problems: [],
            gitStatus: null,
            terminalState: {
                ready: false,
                running: false,
                cwd: '',
                exitCode: null,
                historySize: 0
            }
        };

        this._listeners = new Map();
    }

    subscribe(key, callback) {
        if (typeof callback !== 'function') {
            return () => {};
        }
        let bucket = this._listeners.get(key);
        if (!bucket) {
            bucket = new Set();
            this._listeners.set(key, bucket);
        }
        bucket.add(callback);

        return () => {
            const set = this._listeners.get(key);
            if (set) {
                set.delete(callback);
                if (set.size === 0) this._listeners.delete(key);
            }
        };
    }

    _notify(key, value) {
        const bucket = this._listeners.get(key);
        if (!bucket || bucket.size === 0) return;
        // copy to a static array to allow safe unsubscribe during iteration
        const callbacks = Array.from(bucket);
        for (let i = 0; i < callbacks.length; i += 1) {
            try {
                callbacks[i](value);
            } catch (error) {
                console.error(`[appState] subscriber for "${key}" failed:`, error);
            }
        }
    }

    get(key) {
        return this._state[key];
    }

    set(key, value) {
        if (this._state[key] === value) {
            return;
        }

        this._state[key] = value;
        this._notify(key, value);
    }

    getOpenFile(path) {
        return this._state.openFiles.get(path);
    }

    /**
     * Light-weight update for an open file.
     * - Mutates the existing object in place (avoids spread + JSON.stringify on every keystroke)
     * - Notifies via fine-grained channels:
     *     - `file:meta:<path>` — content / dirty flag changed (cheap; editor uses this)
     *     - `openFiles:meta` — at least one file's dirty flag flipped
     *     - `openFiles` — list of open files changed (added / removed) [legacy alias]
     */
    setOpenFile(path, data) {
        const map = this._state.openFiles;
        const existing = map.get(path);

        if (!existing) {
            map.set(path, data);
            this._notify('openFiles', map);
            this._notify(`file:meta:${path}`, data);
            return;
        }

        let dirtyChanged = false;
        let listChanged = false;

        for (const key in data) {
            if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
            const next = data[key];
            if (existing[key] !== next) {
                if (key === 'dirty') dirtyChanged = true;
                if (key === 'file') listChanged = true;
                existing[key] = next;
            }
        }

        this._notify(`file:meta:${path}`, existing);
        if (dirtyChanged) {
            this._notify('openFiles:meta', map);
        }
        if (listChanged) {
            this._notify('openFiles', map);
        }
    }

    deleteOpenFile(path) {
        if (!this._state.openFiles.delete(path)) {
            return;
        }

        this._notify('openFiles', this._state.openFiles);
    }

    clearOpenFiles() {
        if (this._state.openFiles.size === 0) {
            return;
        }

        this._state.openFiles.clear();
        this._notify('openFiles', this._state.openFiles);
    }

    addOutput(entryOrMessage, options = {}) {
        const entry = normalizeOutputEntry(entryOrMessage, options);
        const list = this._state.output;
        list.push(entry);
        // Trim in place to keep array reference stable (cheaper than slice+spread).
        if (list.length > MAX_OUTPUT_ENTRIES) {
            list.splice(0, list.length - MAX_OUTPUT_ENTRIES);
            this._notify('output:reset', list);
        } else {
            this._notify('output:append', entry);
        }
        this._notify('output', list);
    }

    clearOutput() {
        if (this._state.output.length === 0) return;
        this._state.output.length = 0;
        this._notify('output:reset', this._state.output);
        this._notify('output', this._state.output);
    }

    setProblems(problems = []) {
        this._state.problems = Array.isArray(problems) ? problems.slice() : [];
        this._notify('problems', this._state.problems);
    }

    clearProblems() {
        this.setProblems([]);
    }

    setGitStatus(status) {
        this._state.gitStatus = status || null;
        this._notify('gitStatus', this._state.gitStatus);
    }

    setWorkspaceTooling(status) {
        this._state.workspaceTooling = status || null;
        this._notify('workspaceTooling', this._state.workspaceTooling);
    }

    setWorkspaceTree(tree) {
        this._state.workspaceTree = Array.isArray(tree) ? tree.slice() : [];
        this._notify('workspaceTree', this._state.workspaceTree);
    }

    updateTerminalState(partial) {
        this._state.terminalState = {
            ...(this._state.terminalState || {}),
            ...(partial || {})
        };
        this._notify('terminalState', this._state.terminalState);
    }

    setOutputFilter(level, visible) {
        const nextFilters = cloneFilters(this._state.outputFilters);
        nextFilters[level] = Boolean(visible);
        if (this._state.outputFilters[level] === nextFilters[level]) return;
        this._state.outputFilters = nextFilters;
        this._notify('outputFilters', this._state.outputFilters);
    }

    toggleOutputFilter(level) {
        const current = this._state.outputFilters[level] !== false;
        this.setOutputFilter(level, !current);
    }

    getVisibleOutput() {
        const filters = this._state.outputFilters;
        return this._state.output.filter(entry => filters[entry.level] !== false);
    }

    isOutputFilterEnabled(level) {
        return this._state.outputFilters[level] !== false;
    }

    countDirtyFiles() {
        let count = 0;
        for (const data of this._state.openFiles.values()) {
            if (data && data.dirty) count += 1;
        }
        return count;
    }
}

export const appState = new AppState();
export const STATE_LIMITS = Object.freeze({ MAX_OUTPUT_ENTRIES });
