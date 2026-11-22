'use strict';

// Parse *representations*, never evaluate code returned by the device.
function splitReprEntries(value) {
    if (typeof value !== 'string' || value.length > 65536) return [];
    const out = [];
    let start = 0;
    let quote = null;
    let escape = false;
    let depth = 0;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (quote) {
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if ('([{'.includes(ch)) {
            depth++;
        } else if (')]}'.includes(ch)) {
            depth--;
            if (depth < 0) return [];
        } else if (ch === ',' && depth === 0) {
            out.push(value.slice(start, i).trim());
            start = i + 1;
            if (out.length >= 200) return out;
        }
    }
    if (quote || depth !== 0) return [];
    if (value.slice(start).trim()) out.push(value.slice(start).trim());
    return out;
}

function parseDebuggerReply(text, localNames = []) {
    if (typeof text !== 'string') return null;
    if (text.startsWith('stack=[')) {
        const frames = [];
        const re = /\((\d+),\s*(\d+)\)/g;
        let match;
        while ((match = re.exec(text)) !== null && frames.length < 32) {
            frames.push({ fun: Number(match[1]), ip: Number(match[2]) });
        }
        return { kind: 'stack', frames };
    }
    const local = text.match(/(?:frame=\(([^)]+)\)\s+)?(?:depth=\d+\s+)?state=\[([\s\S]*)\]$/);
    if (local) {
        const values = splitReprEntries(local[2]);
        const reported = local[1] ? Number.parseInt(local[1].split(',')[0], 10) : values.length;
        const count = Number.isSafeInteger(reported) && reported >= 0 ? reported : values.length;
        return { kind: 'locals', values: localNames.slice(0, 100).map((name, i) => ({
            name, value: values[count - i - 1] ?? '<unavailable>', variablesReference: 0
        })) };
    }
    const index = text.indexOf('globals={');
    if (index >= 0 && text.trimEnd().endsWith('}')) {
        const entries = splitReprEntries(text.slice(index + 'globals={'.length, text.lastIndexOf('}')));
        const values = [];
        for (const part of entries) {
            const match = part.match(/^(['"])([^'"]+)\1\s*:\s*([\s\S]+)$/);
            if (!match) continue;
            values.push({ name: match[2], value: match[3], variablesReference: 0 });
        }
        return { kind: 'globals', values };
    }
    return null;
}

/**
 * Firmware versions which cannot inspect the paused user frame may fall back
 * to trace_pump.globals(). Those are debugger control variables, not user
 * variables. Never display them as though they came from the program.
 */
function sanitizeTargetGlobals(values) {
    if (!Array.isArray(values)) return { values: [], diagnostic: 'Device globals reply is invalid.' };
    const names = new Set(values.map(value => value.name));
    const markers = ['PUMP_PROTOCOL', 'PUMP_BUILD', '_running', 'bytes_in', 'continues', 'cmds'];
    const markerCount = markers.filter(name => names.has(name)).length;
    if (markerCount >= 2 || (names.has('PUMP_PROTOCOL') && names.has('_thread'))) {
        return {
            values: [{
                name: '[unavailable]',
                value: 'Firmware returned trace_pump internals, not paused user globals. A firmware-side scope fix is required.',
                variablesReference: 0
            }],
            diagnostic: 'Debugger firmware returned trace_pump globals; user Globals cannot be trusted.'
        };
    }
    return { values, diagnostic: null };
}

module.exports = { splitReprEntries, parseDebuggerReply, sanitizeTargetGlobals };
