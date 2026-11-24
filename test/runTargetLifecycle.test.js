'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');

suite('Run target selection and extension shutdown', () => {
    test('opening, highlighting and cancelling the picker retain MCU until accepted', () => {
        let command, accepted, hidden;
        const picker = {
            selectedItems: [],
            onDidAccept(fn) { accepted = fn; },
            onDidHide(fn) { hidden = fn; },
            hide() { hidden(); }, dispose() {}, show() {}
        };
        const state = {
            currentTarget: 'MCU', context: { subscriptions: [] }, console: { log() {} },
            updateRunTargetButton() {},
            vscode: {
                commands: { registerCommand(id, fn) { command = fn; } },
                window: { createQuickPick() { return picker; } }
            }
        };
        const start = source.indexOf('    // Choose Run Target (Host / MCU)');
        const end = source.indexOf('\n    );', start) + '\n    );'.length;
        assert.ok(start > 0 && end > start);
        vm.runInNewContext(source.slice(start, end), state);
        command();
        assert.strictEqual(picker.activeItems[0].target, 'MCU');
        picker.selectedItems = [picker.items[0]];
        assert.strictEqual(state.currentTarget, 'MCU');
        hidden();
        assert.strictEqual(state.currentTarget, 'MCU');
        command();
        accepted();
        assert.strictEqual(state.currentTarget, 'Host');
    });

    test('deactivation waits for the serial daemon to exit before disposing output', async () => {
        const calls = [];
        let release;
        const state = {
            console: { log() {} }, gMpremoteTerminal: null,
            connectionManager: { disconnect() {
                calls.push('disconnect');
                return new Promise(resolve => { release = resolve; });
            } },
            require(name) {
                if (name === './simulator') return { stopSimulator() {} };
                return { disposeStudioOutputChannel() { calls.push('dispose output'); } };
            }
        };
        const start = source.indexOf('async function deactivate()');
        assert.ok(start > 0);
        vm.runInNewContext(source.slice(start, source.indexOf('\nmodule.exports', start)), state);
        const shutdown = state.deactivate();
        assert.deepStrictEqual(calls, ['disconnect']);
        release();
        await shutdown;
        assert.deepStrictEqual(calls, ['disconnect', 'dispose output']);
    });

    test('Python breakpoint gutters are declared independently of Python extensions', () => {
        const manifest = require('../package.json');
        assert.ok(manifest.contributes.breakpoints.some(item => item.language === 'python'));
    });
});
