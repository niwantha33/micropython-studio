const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Breakpoint manager panel', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'),
        'utf8'
    );

    test('shows live breakpoint table with target slot and IP state', () => {
        assert.ok(source.includes('id="panel-breakpoints"'));
        assert.ok(source.includes('id="breakpoints-body"'));
        assert.ok(source.includes('<th>Slot</th><th>IP</th>'));
        assert.ok(source.includes("evt: 'breakpoints'"));
        assert.ok(source.includes("state = 'VERIFIED'"));
        assert.ok(source.includes("state = 'PENDING'"));
        assert.ok(source.includes("state = 'DISABLED'"));
    });

    test('set breakpoint uses VS Code breakpoint API as source of truth', () => {
        assert.ok(source.includes('vscode.debug.addBreakpoints(['));
        assert.ok(source.includes('new vscode.SourceBreakpoint(location, true)'));
        assert.ok(source.includes('breakpoint already exists at'));
    });

    test('supports enable disable remove and clear all actions', () => {
        assert.ok(source.includes("msg.op === 'bp_toggle'"));
        assert.ok(source.includes("msg.op === 'bp_remove'"));
        assert.ok(source.includes("msg.op === 'bp_clear_all'"));
        assert.ok(source.includes('clearSourceBreakpoint(bp.location.uri.fsPath'));
        assert.ok(source.includes('vscode.debug.removeBreakpoints([bp])'));
        assert.ok(source.includes('vscode.debug.removeBreakpoints(pythonBps)'));
    });

    test('disabled breakpoints are not registered on the target', () => {
        assert.match(source, /function registerSourceBreakpoint[\s\S]*if \(!info\.enabled\) \{[\s\S]*return;/);
        assert.match(source, /if \(!info\.enabled\) \{[\s\S]*clearSourceBreakpoint/);
    });

    test('target breakpoint replies refresh the visible table', () => {
        assert.ok(source.includes("/^(?:bp |cleared bp |cleared all bp slots|no code on )/"));
        assert.ok(source.includes('postBreakpointSnapshot();'));
    });
});
