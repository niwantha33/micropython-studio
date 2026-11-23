'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function controller(state, interrupt) {
    const actions = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/stopExecution.js'), 'utf8'), {
        module, exports: module.exports,
        require(name) {
            if (name === './connectionManager') return { portName: 'COM7', interrupt: async () => {
                actions.push('interrupt');
                await interrupt?.();
            } };
            if (name === './debugExecutionState') return { getDebugExecutionState: () => state };
            if (name === './mpyDebugger') return { sendNativeCommand(op) { actions.push(op); return true; } };
            return require('../src/devicePortSelection');
        }
    });
    return { stop: module.exports.stopExecution, actions };
}

suite('Explicit Stop ordering', () => {
    test('only releases a known debug pause after the REPL interrupt is delivered', async () => {
        let release;
        const c = controller({ status: 'paused', replPort: 'COM7' }, () => new Promise(r => { release = r; }));
        const stop = c.stop('com7');
        assert.deepStrictEqual(c.actions, ['interrupt']);
        release();
        await stop;
        assert.deepStrictEqual(c.actions, ['interrupt', 'continue']);
    });
    test('a running or unconfirmed debugger never receives an automatic Continue', async () => {
        for (const status of ['running', 'attached', 'detached']) {
            const c = controller({ status, replPort: 'COM7' });
            await c.stop('COM7');
            assert.deepStrictEqual(c.actions, ['interrupt']);
        }
    });
    test('a failed interrupt or different REPL cannot resume the target', async () => {
        const c = controller({ status: 'paused', replPort: 'COM7' }, async () => { throw new Error('No COM'); });
        await assert.rejects(c.stop('COM7'), /No COM/);
        assert.deepStrictEqual(c.actions, ['interrupt']);
        await assert.rejects(c.stop('COM8'), /selected REPL/);
        assert.deepStrictEqual(c.actions, ['interrupt']);
    });
});
