'use strict';

const { EventEmitter } = require('events');

const events = new EventEmitter();
events.setMaxListeners(30);

let current = Object.freeze({ status: 'detached', debugPort: '', replPort: '', location: null });

function getDebugExecutionState() {
    return current;
}

function setDebugExecutionState(update) {
    const next = Object.freeze({
        status: update.status || 'detached',
        debugPort: update.debugPort || '',
        replPort: update.replPort || '',
        location: update.location || null
    });
    const prevLocation = current.location;
    if (current.status === next.status && current.debugPort === next.debugPort &&
        current.replPort === next.replPort &&
        prevLocation?.path === next.location?.path && prevLocation?.line === next.location?.line) {
        return;
    }
    current = next;
    events.emit('change', next);
}

function onDebugExecutionState(listener) {
    events.on('change', listener);
    return { dispose: () => events.off('change', listener) };
}

module.exports = { getDebugExecutionState, setDebugExecutionState, onDebugExecutionState };
