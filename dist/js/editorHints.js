import { debounce, extractIdentifiers } from './utils.js';
import { api } from './tauri.js';
import { logger } from './logger.js';

const C_KEYWORDS = [
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
    'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
    'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
    'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool',
    '_Complex', '_Imaginary'
];

const CPP_KEYWORDS = [
    'class', 'namespace', 'template', 'typename', 'public', 'private', 'protected',
    'virtual', 'override', 'constexpr', 'nullptr', 'using', 'new', 'delete'
];

const STD_SYMBOLS = [
    'printf', 'fprintf', 'snprintf', 'scanf', 'fgets', 'puts', 'putchar', 'malloc',
    'calloc', 'realloc', 'free', 'memcpy', 'memset', 'strlen', 'strcmp', 'strcpy',
    'exit', 'qsort', 'time', 'clock', 'fopen', 'fclose'
];

const SNIPPETS = [
    {
        text: 'for (int i = 0; i < count; i += 1) {\n    \n}',
        displayText: 'for loop'
    },
    {
        text: 'if (${condition}) {\n    \n}',
        displayText: 'if block'
    },
    {
        text: 'while (${condition}) {\n    \n}',
        displayText: 'while loop'
    },
    {
        text: '#include <stdio.h>',
        displayText: 'include stdio'
    },
    {
        text: '#include <stdlib.h>',
        displayText: 'include stdlib'
    },
    {
        text: '#include <string.h>',
        displayText: 'include string'
    }
];

let backendCache = new Map();
let lastTyped = '';
let pendingRequest = null;

async function fetchBackendCompletions(code, prefix) {
    if (!prefix || prefix.length < 2) {
        return [];
    }
    
    const cacheKey = `${code.slice(0, 500)}|${prefix}`;
    if (backendCache.has(cacheKey)) {
        return backendCache.get(cacheKey);
    }
    
    if (pendingRequest) {
        try {
            await pendingRequest;
        } catch (e) {
            // ignore
        }
    }
    
    pendingRequest = (async () => {
        try {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Backend timeout')), 2000);
            });
            
            const completionsPromise = api.getCompletions(code, prefix);
            const completions = await Promise.race([completionsPromise, timeoutPromise]);
            
            const results = Array.isArray(completions) ? completions : [];
            backendCache.set(cacheKey, results);
            
            if (backendCache.size > 50) {
                const firstKey = backendCache.keys().next().value;
                backendCache.delete(firstKey);
            }
            
            return results;
        } catch (error) {
            logger.err('Backend completions failed', { details: error?.message });
            return [];
        } finally {
            pendingRequest = null;
        }
    })();
    
    return pendingRequest;
}

function buildLocalHintList(editor, appState, typed) {
    const openFiles = [...appState.get('openFiles').values()];
    const identifiers = new Set([
        ...C_KEYWORDS,
        ...CPP_KEYWORDS,
        ...STD_SYMBOLS
    ]);

    openFiles.forEach(openFile => {
        const content = openFile.content || '';
        const preview = content.length > 5000 ? content.slice(0, 5000) : content;
        extractIdentifiers(preview).forEach(token => {
            if (token.length > 1) identifiers.add(token);
        });
    });

    const currentContent = editor.getValue();
    const currentPreview = currentContent.length > 5000 ? currentContent.slice(0, 5000) : currentContent;
    extractIdentifiers(currentPreview).forEach(token => {
        if (token.length > 1) identifiers.add(token);
    });

    let results = [...identifiers];
    
    if (typed && typed.length > 0) {
        const lowerTyped = typed.toLowerCase();
        results = results.filter(candidate => 
            candidate.toLowerCase().startsWith(lowerTyped)
        );
    }
    
    return results.sort((a, b) => a.localeCompare(b));
}

async function provideSmartHintsAsync(editor, fileTree, appState) {
    const cursor = editor.getCursor();
    const token = editor.getTokenAt(cursor);
    const currentLine = editor.getLine(cursor.line) || '';
    const trimmedLine = currentLine.trim();
    const tokenStart = token?.start ?? cursor.ch;
    const tokenEnd = token?.end ?? cursor.ch;
    const typed = currentLine.slice(tokenStart, cursor.ch);
    
    lastTyped = typed;
    
    const wordRange = {
        from: CodeMirror.Pos(cursor.line, tokenStart),
        to: CodeMirror.Pos(cursor.line, tokenEnd)
    };

    if (/^\s*#include\s+[<"][^>"]*$/.test(currentLine)) {
        const headers = fileTree.getHeaderSuggestions().map(header => ({
            text: header,
            displayText: header,
            className: 'cm-smart-hint',
            render: null
        }));

        return {
            list: headers.slice(0, 30),
            from: CodeMirror.Pos(cursor.line, currentLine.lastIndexOf('"') + 1 || currentLine.lastIndexOf('<') + 1),
            to: CodeMirror.Pos(cursor.line, cursor.ch)
        };
    }

    const localCandidates = buildLocalHintList(editor, appState, typed)
        .map(candidate => ({
            text: candidate,
            displayText: candidate,
            className: 'cm-smart-hint'
        }));

    let backendCandidates = [];
    if (typed && typed.length >= 2) {
        backendCandidates = await fetchBackendCompletions(editor.getValue(), typed);
        backendCandidates = backendCandidates
            .filter(c => !localCandidates.some(lc => lc.text === c))
            .map(c => ({
                text: c,
                displayText: c,
                className: 'cm-smart-hint cm-backend-hint'
            }));
    }

    let snippetMatches = [];
    if (!typed || typed.length <= 3) {
        snippetMatches = SNIPPETS
            .filter(snippet => !typed || 
                snippet.displayText.toLowerCase().includes(typed.toLowerCase()) || 
                snippet.text.toLowerCase().includes(typed.toLowerCase()))
            .map(snippet => ({
                text: snippet.text.replace(/\${[^}]+}/g, ''),
                displayText: snippet.displayText,
                className: 'cm-smart-hint cm-smart-hint-snippet'
            }));
    }

    let list = [...snippetMatches, ...localCandidates, ...backendCandidates].slice(0, 60);

    if (trimmedLine.startsWith('#') && !list.some(item => item.text === '#include <stdio.h>')) {
        list.unshift({
            text: '#include <stdio.h>',
            displayText: 'preprocessor include',
            className: 'cm-smart-hint cm-smart-hint-snippet'
        });
    }

    return {
        list,
        ...wordRange
    };
}

function provideSmartHintsSync(editor, fileTree, appState) {
    const cursor = editor.getCursor();
    const token = editor.getTokenAt(cursor);
    const tokenStart = token?.start ?? cursor.ch;
    const tokenEnd = token?.end ?? cursor.ch;
    const typed = (editor.getLine(cursor.line) || '').slice(tokenStart, cursor.ch);
    
    const localCandidates = buildLocalHintList(editor, appState, typed)
        .slice(0, 30)
        .map(candidate => ({
            text: candidate,
            displayText: candidate,
            className: 'cm-smart-hint'
        }));
    
    if (typed && typed.length >= 2) {
        fetchBackendCompletions(editor.getValue(), typed).catch(() => {});
    }
    
    return {
        list: localCandidates,
        from: CodeMirror.Pos(cursor.line, tokenStart),
        to: CodeMirror.Pos(cursor.line, tokenEnd)
    };
}

export function installSmartHints(editor, fileTree, appState) {
    if (typeof editor?.showHint !== 'function' || typeof CodeMirror?.Pos !== 'function') {
        logger.err('Cannot install smart hints: CodeMirror hint API not available');
        return;
    }

    const showHintsDebounced = debounce(() => {
        if (!editor.hasFocus()) {
            return;
        }
        
        if (editor._hintTimeout) {
            clearTimeout(editor._hintTimeout);
        }
        
        editor._hintTimeout = setTimeout(() => {
            editor.showHint({
                hint: (cm) => provideSmartHintsSync(cm, fileTree, appState),
                completeSingle: false,
                alignWithWord: true,
                closeOnUnfocus: true,
                extraKeys: {
                    Up: (cm, handle) => handle.moveFocus(-1),
                    Down: (cm, handle) => handle.moveFocus(1),
                    Enter: (cm, handle) => {
                        handle.pick();
                        cm.focus();
                    },
                    Tab: (cm, handle) => {
                        handle.pick();
                        cm.focus();
                    }
                }
            });
            editor._hintTimeout = null;
        }, 30);
    }, 150);

    editor.on('inputRead', (_editor, change) => {
        const text = Array.isArray(change.text) ? change.text.join('') : '';
        if (!text || /^\s$/.test(text)) {
            return;
        }
        
        const cursor = editor.getCursor();
        const token = editor.getTokenAt(cursor);
        if (token && (token.type === 'string' || token.type === 'comment')) {
            return;
        }
        
        showHintsDebounced();
    });

    editor.addKeyMap({
        'Ctrl-Space': (cm) => {
            cm.showHint({
                hint: (instance) => provideSmartHintsSync(instance, fileTree, appState),
                completeSingle: true,
                alignWithWord: true
            });
        }
    });
    
    const clearCache = () => {
        backendCache.clear();
        lastTyped = '';
    };
    
    editor.on('beforeChange', clearCache);
    
    logger.sys('Smart hints installed with backend integration');
}