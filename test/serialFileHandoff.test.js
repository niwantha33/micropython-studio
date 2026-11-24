'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ports = require('../src/devicePortSelection');

function load(name, dependencies, extra = {}) {
    const filename = path.join(__dirname, '..', 'src', name);
    const context = {
        module: { exports: {} }, __dirname: path.dirname(filename), Buffer,
        console: { log() {}, error() {} }, process, setTimeout,
        require(id) { return Object.hasOwn(dependencies, id) ? dependencies[id] : require(id); },
        ...extra
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context.module.exports;
}

function fixture() {
    let lock = null, clock = 0;
    const calls = [];
    const manager = {
        portName: 'COM7', isConnected: true, isSuspended: false,
        daemonProcess: { pid: 234 },
        async suspend() { calls.push('suspend'); this.isSuspended = true; },
        async resume() { calls.push('resume'); this.isSuspended = false; },
        async catFile(file) { calls.push('cat:' + file); return Buffer.from('print(7)'); }
    };
    const queue = load('wsQueue.js', {
        './connectionManager': manager, './devicePortSelection': ports,
        fs: { existsSync() { return lock !== null; }, readFileSync() { return lock; } }
    }, {
        process: { pid: 123, kill() {} }, Date: { now() { return clock; } },
        setTimeout(resolve, ms) { clock += ms; resolve(); }
    });
    const shown = [], errors = [];
    let backendCalls = 0;
    const execFile = () => { throw new Error('Unexpected callback backend'); };
    execFile[require('util').promisify.custom] = async (exe, args) => {
        backendCalls++;
        assert.strictEqual(args[args.indexOf('--port') + 1], 'COM8');
        return { stdout: 'backend file' };
    };
    const explorer = load('deviceFileExplorer.js', {
        vscode: {
            TreeItem: class {}, ProgressLocation: { Notification: 1 },
            window: {
                withProgress(options, fn) { return fn(); },
                async showTextDocument(doc) { shown.push(doc.content); },
                showErrorMessage(message) { errors.push(message); }
            },
            workspace: { async openTextDocument(doc) { return doc; } }
        },
        child_process: { execFile },
        './commonFxn': { getVenvPythonPathFolder() {}, getVenvPythonPath() { return 'python'; } },
        './wsQueue': queue, './connectionManager': manager,
        './pathSafety': {}, './devicePortSelection': ports,
        './deviceUploadPaths': {}, './deviceOperationLog': {}
    });
    return { queue, manager, calls, explorer, shown, errors,
        setLock(value) { lock = value; }, backendCalls() { return backendCalls; } };
}

suite('Serial file access and queued port handoff', () => {
    test('our acknowledged suspension reservation does not impose a 12 second wait', async () => {
        const f = fixture();
        f.manager.isSuspended = true;
        f.setLock('123:suspended_lock');
        assert.strictEqual(await f.queue.run(async () => 'read', 'Read File'), 'read');
        assert.strictEqual(f.queue.pending, 0);
    });

    for (const lock of ['456:suspended_lock', '456:cli_run', '123:cli_run']) {
        test('live owner is preserved: ' + lock, async () => {
            const f = fixture();
            f.manager.isSuspended = true;
            f.setLock(lock);
            await assert.rejects(f.queue.run(async () => f.calls.push('unsafe')), /still owned/);
            assert.deepStrictEqual(f.calls, []);
            assert.strictEqual(f.queue.pending, 0);
            f.setLock(null);
            assert.strictEqual(await f.queue.run(async () => 'recovered'), 'recovered');
        });
    }

    test('our reservation cannot be bypassed without acknowledged suspension', async () => {
        const f = fixture();
        f.setLock('123:suspended_lock');
        await assert.rejects(f.queue.run(async () => 'unsafe'), /still owned/);
    });

    for (const fails of [false, true]) {
        test('read clicked during upload uses restored REPL after ' + (fails ? 'failure' : 'success'), async () => {
            const f = fixture();
            let finish;
            const transfer = f.queue.run(() => new Promise((resolve, reject) => {
                finish = () => fails ? reject(new Error('upload failed')) : resolve();
            }), 'Upload');
            // Wait until the simulated child transfer owns the suspended port.
            while (!finish) await Promise.resolve();
            assert.strictEqual(f.manager.isSuspended, true);
            const read = f.explorer.readDeviceFile('COM7', '/main.py');
            const settled = transfer.catch(error => error);
            assert.deepStrictEqual(f.shown, []);
            finish();
            await settled;
            await read;
            assert.deepStrictEqual(f.calls, ['suspend', 'resume', 'cat:/main.py']);
            assert.deepStrictEqual(f.shown, ['print(7)']);
            assert.deepStrictEqual(f.errors, []);
            assert.strictEqual(f.backendCalls(), 0);
            assert.strictEqual(f.queue.pending, 0);
        });
    }

    test('reading a second device uses its port without suspending the first REPL', async () => {
        const f = fixture();
        await f.explorer.readDeviceFile('COM8', '/main.py');
        assert.deepStrictEqual(f.calls, []);
        assert.deepStrictEqual(f.errors, []);
        assert.deepStrictEqual(f.shown, ['backend file']);
        assert.strictEqual(f.backendCalls(), 1);
    });

    test('failed exclusive read restores REPL and does not block subsequent reads', async () => {
        const f = fixture();
        await assert.rejects(f.queue.run(async () => { throw new Error('USB read failed'); }), /USB read failed/);
        await f.explorer.readDeviceFile('COM7', '/main.py');
        assert.deepStrictEqual(f.calls, ['suspend', 'resume', 'cat:/main.py']);
        assert.strictEqual(f.manager.isSuspended, false);
        assert.strictEqual(f.queue.pending, 0);
    });
});
