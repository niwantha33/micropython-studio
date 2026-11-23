'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NativeMicroPythonAdapter } = require('../src/nativeDebugger');
const { defaultAttachConfiguration, resolveReplPort } = require('../src/debugProjectConfig');
const { sanitizeTargetGlobals, parseDebuggerReply } = require('../src/nativeDebugParser');

suite('Native DAP workflow and real target scopes', () => {
    const root = path.resolve(__dirname, '..');
    const source = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');

    test('a missing firmware handshake preserves the native session and diagnosis', () => {
        const adapter = new NativeMicroPythonAdapter({}, { replPort: 'COM7', debugPort: 'COM5' }, 'python');
        const messages = [];
        const listener = adapter.onDidSendMessage(msg => messages.push(msg));
        try {
            adapter._onBridgeEvent({ evt: 'handshake_timeout', msg: 'Firmware did not answer' });
            assert.strictEqual(adapter.terminated, false);
            assert.strictEqual(adapter.ready, false);
            assert.ok(messages.some(msg => msg.event === 'output' && msg.body.output.includes('MicroPython Debugger')));
            assert.ok(!messages.some(msg => msg.event === 'terminated'));
        } finally {
            listener.dispose();
            adapter.dispose();
        }
    });

    test('Run and Debug defaults to MicroPython ATTACH, not generic Python host runner', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const debuggerEntry = manifest.contributes.debuggers.find(d => d.type === 'micropython-studio');
        assert.strictEqual(debuggerEntry.initialConfigurations[0].request, 'attach');
        assert.ok(debuggerEntry.configurationAttributes.attach);
        assert.ok(manifest.activationEvents.includes('onDebugDynamicConfigurations:micropython-studio'));
        assert.ok(manifest.activationEvents.includes('onDebugResolve:micropython-studio'));
        assert.strictEqual(defaultAttachConfiguration().request, 'attach');
        assert.ok(source('nativeDebugger.js').includes('DebugConfigurationProviderTriggerKind.Dynamic'));
        assert.ok(source('createNewProject.js').includes("path.join(config.settingsDir, 'launch.json')"));
        assert.ok(source('extension.js').includes('micropython-ide.configureNativeDebug'));
        assert.ok(source('nativeDebugger.js').includes('getBuildInfo(this.context.extensionPath'));
        assert.ok(source('nativeDebugger.js').includes("' (commit '"));
    });

    test('saved project COM7 takes priority over stale in-memory COM3', async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-debug-project-'));
        try {
            fs.writeFileSync(path.join(temp, 'device.cfg'), '[device]\nport = "com7"\n');
            const folder = { uri: { fsPath: temp } };
            assert.strictEqual(await resolveReplPort('', 'COM3', folder), 'COM7');
            assert.strictEqual(await resolveReplPort('COM9', 'COM3', folder), 'COM9');
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    });

    test('native debug preserves original detailed panel beside VS Code with one COM owner', () => {
        const bridge = source('mpyDebugger.js');
        assert.ok(bridge.includes('openDebuggerPanel(context, debugPort, venvPython, true)'));
        assert.ok(bridge.includes('function createNativeDetailPanel(context, port)'));
        assert.ok(bridge.includes('panel = createNativeDetailPanel(context, port)'));
        assert.ok(bridge.includes('vscode.ViewColumn.Beside'));
        assert.ok(bridge.includes('function showDebuggerDetails()'));
        assert.ok(bridge.includes('onDidDispose: session.onDidDispose'));
        assert.ok(bridge.includes('if (nativeOnly) return; // DAP'));
        assert.ok(bridge.includes("nativeEventSink = onEvent"));
        assert.strictEqual((bridge.match(/bridge = spawn\(pyCmd/g) || []).length, 1);
    });

    test('bridge globals from trace pump are not presented as application globals', () => {
        const globals = parseDebuggerReply(
            "depth=0 globals={'PUMP_PROTOCOL': 5, '_running': True, '_thread': <module '_thread'>}");
        assert.strictEqual(globals.kind, 'globals');
        const result = sanitizeTargetGlobals(globals.values);
        assert.ok(result.diagnostic.includes('trace_pump'));
        assert.deepStrictEqual(result.values.map(x => x.name), ['[unavailable]']);
        const actual = sanitizeTargetGlobals(
            parseDebuggerReply("depth=0 globals={'counter': 9, 'message': 'hi'}").values
        );
        assert.strictEqual(actual.diagnostic, null);
        assert.deepStrictEqual(actual.values.map(x => x.name), ['counter', 'message']);
    });

    test('second location event for same breakpoint does not wipe already received locals', async () => {
        const adapter = new NativeMicroPythonAdapter({}, {
            replPort: 'COM7', debugPort: 'COM5'
        }, 'python');
        const events = [];
        const subscriber = adapter.onDidSendMessage(msg => events.push(msg));
        try {
            adapter._onBridgeEvent({
                evt: 'bp_hit', location: { path: '/project/main.py', line: 7, name: 'main:fxn' },
                localNames: ['count']
            });
            adapter._onBridgeEvent({
                evt: 'reply', text: 'frame=(1,0,0,0) state=[17]'
            });
            assert.deepStrictEqual(adapter.locals.map(v => [v.name, v.value]), [['count', '17']]);
            adapter._onBridgeEvent({
                evt: 'step_line', file: '/project/main.py', line: 7,
                func: 'fxn', localNames: ['count']
            });
            assert.strictEqual(adapter.paused, true);
            assert.deepStrictEqual(adapter.locals.map(v => [v.name, v.value]), [['count', '17']]);
            assert.strictEqual(events.filter(e => e.event === 'stopped').length, 1);

            adapter._onBridgeEvent({
                evt: 'reply',
                text: "depth=0 globals={'PUMP_PROTOCOL': 5, '_running': True, '_thread': 1}"
            });
            assert.strictEqual(adapter.globals[0].name, '[unavailable]');
            assert.ok(events.some(e => e.event === 'output' &&
                String(e.body.output).includes('trace_pump')));
            const request = {
                type: 'request', seq: 9, command: 'scopes', arguments: { frameId: 2 }
            };
            await adapter.handleMessage(request);
            const response = events.find(e => e.request_seq === 9);
            assert.deepStrictEqual(response.body.scopes, []);
        } finally {
            subscriber.dispose();
            adapter.dispose();
        }
    });

    test('native debugger attach must not run user code or alter boot.py', () => {
        const bridge = source('mpyDebugger.js');
        const native = source('nativeDebugger.js');
        assert.ok(!bridge.includes('uploadDebuggerFiles('));
        assert.ok(!bridge.includes('verifyUploadedPumpFile('));
        assert.ok(!native.includes('connectionManager.runInTerminal('));
        assert.ok(native.includes('Attach does not automatically execute main.py'));
    });
});
