const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { AiAssistanceProvider } = require('../src/aiAssistance');

const base = path.join(__dirname, '..');
function fakeProvider() {
    const provider = Object.create(AiAssistanceProvider.prototype);
    provider._models = [];
    provider._selectedModel = '';
    provider._view = { webview: { postMessage: () => {} } };
    provider._context = { workspaceState: { update: async () => {} } };
    return provider;
}
function mockStream(lines, status = 200) {
    const original = http.request;
    http.request = (_options, callback) => {
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.destroy = err => process.nextTick(() => req.emit('error', err || new Error('destroyed')));
        req.end = () => process.nextTick(() => {
            const res = new EventEmitter();
            res.statusCode = status;
            callback(res);
            for (const line of lines) res.emit('data', Buffer.from(line));
            res.emit('end');
        });
        return req;
    };
    return () => { http.request = original; };
}

suite('Local AI / Ollama reliability', () => {
    test('status check uses local HTTP and no Python subprocess or pip', () => {
        const src = fs.readFileSync(path.join(base, 'src', 'aiAssistance.js'), 'utf8');
        const helper = fs.readFileSync(path.join(base, 'src', 'ollama_helper.py'), 'utf8');
        const ext = fs.readFileSync(path.join(base, 'src', 'extension.js'), 'utf8');
        assert.ok(src.includes("path: '/api/tags'"));
        assert.ok(!src.includes('this._installModel(true);'));
        assert.ok(!ext.includes('onModelfileChanged'));
        assert.ok(!helper.includes('"pip", "install", "requests"'));
        assert.ok(!helper.includes('helper.delete_model("mycoder-mpy")'));
    });
    test('stream parses chunks split across TCP packets', async () => {
        const restore = mockStream([
            '{"message":{"content":"he"},"done":false}\n{"message":',
            '{"content":"llo"},"done":false}\n{"done":true}\n'
        ]);
        try {
            const received = [];
            await fakeProvider()._ollamaStream('/api/chat', {model:'test'}, x => received.push(x));
            assert.strictEqual(received.map(x => x.message?.content || '').join(''), 'hello');
        } finally { restore(); }
    });
    test('stream fails on model errors rather than reporting chat success', async () => {
        const restore = mockStream(['{"error":"model not found"}\n']);
        try {
            await assert.rejects(
                fakeProvider()._ollamaStream('/api/chat', {model:'missing'}, () => {}),
                /model not found/
            );
        } finally { restore(); }
    });
    test('stream refuses incomplete response', async () => {
        const restore = mockStream(['{"message":{"content":"partial"},"done":false}\n']);
        try {
            await assert.rejects(
                fakeProvider()._ollamaStream('/api/chat', {}, () => {}),
                /before completing/
            );
        } finally { restore(); }
    });
    test('installer reports failed model creation and does not delete working model', () => {
        const py = fs.readFileSync(path.join(base,'src','ollama_helper.py'),'utf8');
        assert.ok(py.includes('if not (ok_mpy and ok_cpy):'));
        assert.ok(py.includes('sys.exit(1)'));
        assert.ok(!py.includes('helper.delete_model("micro_ai-mpy")'));
    });
    test('UI offers installed model selection and offline rendering fallback', () => {
        const ui = fs.readFileSync(path.join(base,'resource','aiAssistant.html'),'utf8');
        assert.ok(ui.includes('id="model-select"'));
        assert.ok(ui.includes("type: 'setModel'"));
        assert.ok(ui.includes('const marked = window.marked ||'));
        assert.ok(ui.includes('html(token) { return escapeHtml('));
    });
    test('model-generated code requires explicit hardware execution consent', () => {
        const src = fs.readFileSync(path.join(base,'src','aiAssistance.js'),'utf8');
        assert.ok(src.includes("'Run on device'"));
        assert.ok(src.includes("approval === 'Run on device'"));
    });
});
