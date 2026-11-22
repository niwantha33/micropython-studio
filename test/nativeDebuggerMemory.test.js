'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildProbeScript, parseMemorySample, summarizeMemory } = require('../src/memoryProbe');
const { splitReprEntries, parseDebuggerReply } = require('../src/nativeDebugParser');

suite('Native Debug Adapter + Memory and GC analyzer', () => {
    test('heap sampling is read-only and does not force GC', () => {
        const script = buildProbeScript(false);
        assert.ok(script.includes('mem_alloc'));
        assert.ok(script.includes('mem_free'));
        assert.ok(!script.includes('_mps_gc.collect()'));
        assert.ok(script.includes('MPS_MEMORY_V1'));
    });

    test('manual GC is explicit and measures before and after', () => {
        const script = buildProbeScript(true);
        assert.ok(script.includes('_mps_alloc_before ='));
        assert.ok(script.includes('_mps_gc.collect()'));
        assert.ok(script.includes('_mps_alloc_after ='));
        assert.ok(script.includes('ticks_diff'));
        assert.strictEqual((script.match(/_mps_gc\.collect\(\)/g) || []).length, 1,
            'manual GC must only run once, even if timing is unsupported');
    });

    test('parse sample accurately and reject damaged or ambiguous responses', () => {
        const sample = parseMemorySample('noise\nMPS_MEMORY_V1:800,200,500,500,1250,-1\n', true, 100);
        assert.strictEqual(sample.total, 1000);
        assert.strictEqual(sample.reclaimed, 300);
        assert.strictEqual(summarizeMemory([sample]).allocatedHighWater, 800,
            'peak must include pre-GC allocation');
        assert.strictEqual(sample.gcTimeUs, 1250);
        assert.strictEqual(sample.threshold, null);
        assert.strictEqual(sample.collected, true);
        const manual = parseMemorySample('MPS_MEMORY_V1:0,4096,0,4096,-1,-1', false, 110);
        assert.strictEqual(manual.allocated, 0);
        assert.strictEqual(manual.gcTimeUs, null);
        assert.strictEqual(manual.reclaimed, null);
        const unsupported = parseMemorySample('MPS_MEMORY_V1:-1,-1,-1,-1,-1,-1', false);
        assert.strictEqual(unsupported.total, null);
        assert.strictEqual(unsupported.free, null);
        for (const raw of [
            '', 'MPS_MEMORY_V1:100,200,300',
            'MPS_MEMORY_V1:100,200,300,400,500,600\nMPS_MEMORY_V1:100,200,300,400,500,600',
            'MPS_MEMORY_V1:9999999999999999999,0,0,0,0,0'
        ]) {
            assert.throws(() => parseMemorySample(raw), Error);
        }
    });

    test('summary is observational only and excludes unavailable memory', () => {
        const samples = [
            parseMemorySample('MPS_MEMORY_V1:-1,-1,-1,-1,-1,-1', false, 10),
            parseMemorySample('MPS_MEMORY_V1:100,900,100,900,-1,-1', false, 11),
            parseMemorySample('MPS_MEMORY_V1:200,800,200,800,-1,-1', false, 12),
        ];
        const summary = summarizeMemory(samples);
        assert.strictEqual(summary.count, 3);
        assert.strictEqual(summary.allocatedHighWater, 200);
        assert.strictEqual(summary.observedGrowth, 100);
        assert.strictEqual(summary.manualCollections, 0);
    });

    test('native DAP parser never evaluates target representations', () => {
        assert.deepStrictEqual(splitReprEntries("2, {'a': [1,2]}, 'a,b'"),
            ['2', "{'a': [1,2]}", "'a,b'"]);
        assert.deepStrictEqual(
            parseDebuggerReply('frame=(3,0,2,42) state=[7, 8, 9]', ['a', 'b']).values,
            [
                { name: 'a', value: '9', variablesReference: 0 },
                { name: 'b', value: '8', variablesReference: 0 }
            ]);
        const globals = parseDebuggerReply("depth=0 globals={'mode': 'test, value', 'flag': True}");
        assert.strictEqual(globals.kind, 'globals');
        assert.strictEqual(globals.values[0].name, 'mode');
        assert.strictEqual(globals.values[0].value, "'test, value'");
        assert.strictEqual(parseDebuggerReply('stack=[(23, 10), (42, 2)]').frames.length, 2);
        assert.deepStrictEqual(splitReprEntries("1, 'unterminated"), []);
    });

    test('native adapter only shares existing bridge; no firmware upload or extra COM owner', () => {
        const root = path.resolve(__dirname, '..');
        const native = fs.readFileSync(path.join(root, 'src', 'nativeDebugger.js'), 'utf8');
        const bridge = fs.readFileSync(path.join(root, 'src', 'mpyDebugger.js'), 'utf8');
        const memory = fs.readFileSync(path.join(root, 'src', 'memoryAnalyzer.js'), 'utf8');
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.ok(native.includes('DebugAdapterInlineImplementation'));
        assert.ok(native.includes('registerDebugConfigurationProvider'));
        assert.ok(native.includes('registerDebugAdapterDescriptorFactory'));
        assert.ok(native.includes('supportsSetVariable: false'));
        assert.ok(native.includes('connectNativeDebugger'));
        assert.ok(bridge.includes('nativeEventSink'));
        assert.ok(bridge.includes("emitNative({ evt: 'pump_ready'"));
        assert.ok(bridge.includes("sendNativeCommand('call_stack')"));
        assert.ok(!native.includes('flashFirmware('));
        assert.ok(!native.includes('spawn('));
        assert.ok(memory.includes('connectionManager.runCodeSilently(buildProbeScript(collect))'));
        assert.ok(memory.includes('if (vscode.debug.activeDebugSession?.type'));
        assert.ok(manifest.contributes.debuggers.some(d => d.type === 'micropython-studio'));
    });
});
