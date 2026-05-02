const INVALID_NAME_PATTERN = /[\\/:*?"<>|\u0000]/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;

export function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
}

export function formatBytes(bytes) {
    const value = Number(bytes || 0);

    if (value < 1024) {
        return `${value} B`;
    }

    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
    }

    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function validateEntityName(value) {
    const name = String(value || '').trim();

    if (!name) {
        return 'Name is required.';
    }

    if (name.length > 255) {
        return 'Name must be 255 characters or less.';
    }

    if (name === '.' || name === '..') {
        return 'Reserved names are not allowed.';
    }

    if (name.startsWith('.')) {
        return 'Hidden names are not supported here.';
    }

    if (INVALID_NAME_PATTERN.test(name)) {
        return 'Name contains invalid characters.';
    }

    return '';
}

export function toContextText(context) {
    if (!context) {
        return '';
    }

    if (typeof context === 'string') {
        return context;
    }

    let result = '';
    for (const key in context) {
        if (!Object.prototype.hasOwnProperty.call(context, key)) continue;
        const value = context[key];
        if (value === undefined || value === null || value === '') continue;
        if (result) result += ' | ';
        result += `${key}: ${value}`;
    }
    return result;
}

const NORMALIZE_CACHE = new Map();
const NORMALIZE_CACHE_LIMIT = 512;

export function normalizePath(value) {
    const raw = value == null ? '' : String(value);
    const cached = NORMALIZE_CACHE.get(raw);
    if (cached !== undefined) {
        return cached;
    }
    const normalized = raw.replace(/\\/g, '/').toLowerCase();
    if (NORMALIZE_CACHE.size >= NORMALIZE_CACHE_LIMIT) {
        const firstKey = NORMALIZE_CACHE.keys().next().value;
        if (firstKey !== undefined) NORMALIZE_CACHE.delete(firstKey);
    }
    NORMALIZE_CACHE.set(raw, normalized);
    return normalized;
}

export function getFileName(path) {
    return String(path || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop() || '';
}

export function getFileExtension(path) {
    const filename = getFileName(path);
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function validatePackageName(value) {
    const name = String(value || '').trim();

    if (!name) {
        return 'Package name is required.';
    }

    if (!PACKAGE_NAME_PATTERN.test(name)) {
        return 'Package name contains unsupported characters.';
    }

    return '';
}

export function debounce(callback, delay = 150) {
    let timer = null;

    const wrapped = (...args) => {
        if (timer) {
            clearTimeout(timer);
        }

        timer = setTimeout(() => {
            timer = null;
            try {
                callback(...args);
            } catch (error) {
                console.error('[debounce] callback failed:', error);
            }
        }, delay);
    };

    wrapped.cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    return wrapped;
}

export function throttle(callback, delay = 150) {
    let last = 0;
    let timer = null;
    let lastArgs = null;

    return (...args) => {
        const now = Date.now();
        const remaining = delay - (now - last);
        lastArgs = args;

        if (remaining <= 0) {
            last = now;
            try {
                callback(...args);
            } catch (error) {
                console.error('[throttle] callback failed:', error);
            }
        } else if (!timer) {
            timer = setTimeout(() => {
                last = Date.now();
                timer = null;
                try {
                    callback(...lastArgs);
                } catch (error) {
                    console.error('[throttle] callback failed:', error);
                }
            }, remaining);
        }
    };
}

const RAF_QUEUE = new Map();
let rafScheduled = false;

function flushRafQueue() {
    rafScheduled = false;
    const queue = Array.from(RAF_QUEUE.values());
    RAF_QUEUE.clear();
    queue.forEach(fn => {
        try {
            fn();
        } catch (error) {
            console.error('[rafBatch] callback failed:', error);
        }
    });
}

export function rafBatch(key, callback) {
    RAF_QUEUE.set(key, callback);
    if (!rafScheduled) {
        rafScheduled = true;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(flushRafQueue);
        } else {
            setTimeout(flushRafQueue, 16);
        }
    }
}

export function getRelativePath(basePath, targetPath) {
    const base = normalizePath(basePath);
    const target = normalizePath(targetPath);

    if (!base || !target || !target.startsWith(base)) {
        return String(targetPath || '');
    }

    return String(targetPath || '')
        .slice(basePath.length)
        .replace(/^[\\/]+/, '');
}

export function flattenTree(nodes, result = []) {
    const stack = Array.isArray(nodes) ? [...nodes] : [];
    while (stack.length > 0) {
        const node = stack.shift();
        result.push(node);
        if (Array.isArray(node.children) && node.children.length > 0) {
            stack.unshift(...node.children);
        }
    }
    return result;
}

export function buildTreeIndex(nodes, index = new Map(), parents = new Map(), parentPath = '') {
    const stack = [];
    (Array.isArray(nodes) ? nodes : []).forEach(node => stack.push({ node, parent: parentPath }));

    while (stack.length > 0) {
        const { node, parent } = stack.pop();
        index.set(node.path, node);
        if (parent) {
            parents.set(node.path, parent);
        }
        if (Array.isArray(node.children) && node.children.length > 0) {
            for (let i = node.children.length - 1; i >= 0; i -= 1) {
                stack.push({ node: node.children[i], parent: node.path });
            }
        }
    }

    return { index, parents };
}

export function collectAncestorPaths(path, parentMap) {
    const ancestors = [];
    let current = parentMap.get(path);
    let guard = 0;

    while (current && guard < 1000) {
        ancestors.push(current);
        current = parentMap.get(current);
        guard += 1;
    }

    return ancestors.reverse();
}

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const IDENTIFIER_CACHE = new Map();
const IDENTIFIER_CACHE_LIMIT = 64;

export function extractIdentifiers(source) {
    const text = String(source || '');
    if (!text) return [];

    const cached = IDENTIFIER_CACHE.get(text);
    if (cached) return cached;

    const matches = text.match(IDENTIFIER_RE) || [];
    const unique = [...new Set(matches)];

    if (IDENTIFIER_CACHE.size >= IDENTIFIER_CACHE_LIMIT) {
        const firstKey = IDENTIFIER_CACHE.keys().next().value;
        if (firstKey !== undefined) IDENTIFIER_CACHE.delete(firstKey);
    }
    IDENTIFIER_CACHE.set(text, unique);
    return unique;
}

export function safeByteLength(value) {
    const text = String(value || '');
    if (!text) return 0;
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
            bytes += 4;
            i += 1;
        } else bytes += 3;
    }
    return bytes;
}
