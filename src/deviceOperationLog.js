'use strict';

/**
 * One authoritative completion result per user-initiated device operation.
 * A process-exit code, successful shared-REPL write or verified drive copy
 * must be observed before success is reported.
 */
function createDeviceOperation(output, action, description) {
    if (!output || typeof output.appendLine !== 'function') {
        throw new Error('MicroPython IDE output channel is unavailable');
    }
    const started = Date.now();
    let finished = false;
    const kind = String(action || 'Device operation');
    if (typeof output.show === 'function') output.show(true);
    output.appendLine('[START] ' + kind + (description ? ' — ' + description : ''));

    function finish(state, details) {
        if (finished) return false;
        finished = true;
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const description = details ? ' — ' + String(details) : '';
        output.appendLine('[' + state + '] ' + kind + description + ' (' + elapsed + 's)');
        return true;
    }
    return {
        progress(message) {
            if (!finished) output.appendLine('[PROGRESS] ' + kind + ' — ' + String(message));
        },
        success(details) { return finish('SUCCESS', details || 'Completed'); },
        fail(error) {
            const detail = error instanceof Error ? error.message : String(error || 'Unknown error');
            return finish('ERROR', 'Failed: ' + detail);
        },
        cancel(reason) { return finish('CANCELLED', reason || 'Cancelled by user'); },
        get finished() { return finished; }
    };
}

/**
 * Adapt the existing callback-based process runner without treating process
 * launch as installation success. Ignore duplicate callbacks defensively.
 */
function waitForProcess(runProcess, executable, args) {
    if (typeof runProcess !== 'function') return Promise.reject(new Error('Process runner is unavailable'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = code => {
            if (settled) return;
            settled = true;
            resolve(code);
        };
        try {
            runProcess(executable, args, done, { suppressTaskSummary: true });
        } catch (error) {
            if (!settled) {
                settled = true;
                reject(error);
            }
        }
    });
}

function assertSuccessfulExit(code, task) {
    if (code !== 0) {
        throw new Error(task + ' failed (exit code ' +
            (code === null || code === undefined ? 'unknown' : code) +
            '). See the preceding process output for details.');
    }
}

module.exports = { createDeviceOperation, waitForProcess, assertSuccessfulExit };
