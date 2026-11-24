'use strict';

const connectionManager = require('./connectionManager');
const { samePort } = require('./devicePortSelection');
const { getDebugExecutionState } = require('./debugExecutionState');

async function stopExecution(replPort) {
    if (!samePort(connectionManager.portName, replPort)) {
        throw new Error('Stop requires the selected REPL connection. Open Shell first.');
    }
    // First deliver the user interrupt on the REPL, independently of raw
    // operation queues. Only an explicit Stop may release a known debug pause.
    const confirmation = connectionManager.observeStop();
    try {
        await connectionManager.interrupt();
        const state = getDebugExecutionState();
        if (state.status === 'paused' && samePort(state.replPort, replPort)) {
            const { sendNativeCommand } = require('./mpyDebugger');
            if (!sendNativeCommand('continue')) {
                throw new Error('Ctrl+C was delivered, but the paused debugger transport is unavailable.');
            }
        }
        await confirmation.wait;
    } finally {
        confirmation.cancel();
    }
}

module.exports = { stopExecution };
