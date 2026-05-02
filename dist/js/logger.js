import { appState } from './state.js';
import { toContextText } from './utils.js';

function safeConsole(level, message, payload) {
    try {
        if (level === 'ERR') {
            console.error(message, payload);
        } else if (level === 'INFO') {
            console.info(message, payload);
        } else {
            console.log(message, payload);
        }
    } catch (_error) {
        // ignore — console may be unavailable in some embed contexts
    }
}

function write(level, message, options = {}) {
    let context = '';
    let details = '';
    let problems = [];

    try {
        context = toContextText(options.context);
        details = options.details ? String(options.details) : '';
        problems = Array.isArray(options.problems) ? options.problems : [];
    } catch (error) {
        details = `Logger payload error: ${error?.message || String(error)}`;
    }

    const normalizedMessage = String(message || '').trim() || 'Empty log message';

    try {
        appState.addOutput({
            level,
            message: normalizedMessage,
            context,
            details,
            problems
        });
    } catch (error) {
        safeConsole('ERR', '[logger] failed to push entry', error);
    }

    safeConsole(level, `[${level}] ${normalizedMessage}`, context || details || '');
}

export const logger = {
    sys(message, options) {
        write('SYS', message, options);
    },
    info(message, options) {
        write('INFO', message, options);
    },
    err(message, options) {
        write('ERR', message, options);
    }
};
