'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createDeviceOperation, waitForProcess, assertSuccessfulExit } =
    require('../src/deviceOperationLog');
const connectionManager = require('../src/connectionManager');

function capture() {
    const lines = [];
    const output = { show() {}, appendLine(line) { lines.push(line); } };
    return { output, lines };
}
function terminalStatuses(lines) {
    return lines.filter(line => /^\[(?:SUCCESS|ERROR|CANCELLED)\]/.test(line));
}

suite('Upload and package completion integrity', () => {
    test('one operation emits exactly one terminal result, never early', () => {
        const { output, lines } = capture();
        const op = createDeviceOperation(output, 'File upload', 'main.py');
        assert.deepStrictEqual(terminalStatuses(lines), []);
        op.progress('main.py → /main.py');
        assert.strictEqual(op.success('1 file verified on device'), true);
        assert.strictEqual(op.success('duplicate result'), false);
        assert.strictEqual(op.fail('late error'), false);
        assert.strictEqual(op.cancel('late cancel'), false);
        assert.strictEqual(terminalStatuses(lines).length, 1);
        assert.ok(terminalStatuses(lines)[0].includes('1 file verified'));
    });

    test('partial failure and cancelled overwrite cannot produce a success line', () => {
        const first = capture();
        const op = createDeviceOperation(first.output, 'Folder upload', 'main');
        op.progress('1/3 files copied');
        op.fail('2nd file failed: 1/3 transferred');
        op.success('incorrect');
        assert.strictEqual(terminalStatuses(first.lines).length, 1);
        assert.ok(terminalStatuses(first.lines)[0].startsWith('[ERROR]'));
        assert.ok(terminalStatuses(first.lines)[0].includes('1/3'));

        const second = capture();
        const cancelled = createDeviceOperation(second.output, 'Project upload', 'main');
        cancelled.cancel('Overwrite declined');
        cancelled.success('incorrect');
        assert.strictEqual(terminalStatuses(second.lines).length, 1);
        assert.ok(terminalStatuses(second.lines)[0].startsWith('[CANCELLED]'));
    });

    test('package installation awaits process exit, preserves result, ignores duplicate callback', async () => {
        let complete, options, argsSeen;
        const pending = waitForProcess((exe, args, callback, opts) => {
            assert.strictEqual(exe, 'python');
            argsSeen = args;
            options = opts;
            complete = callback;
        }, 'python', ['mps_backend.py', 'mip']);
        assert.deepStrictEqual(argsSeen, ['mps_backend.py', 'mip']);
        assert.strictEqual(options.suppressTaskSummary, true);
        assert.strictEqual(typeof complete, 'function');
        complete(0);
        complete(2);
        assert.strictEqual(await pending, 0);
        assert.doesNotThrow(() => assertSuccessfulExit(0, 'Package aioble'));
        assert.throws(() => assertSuccessfulExit(1, 'Package aioble'), /exit code 1/);
        assert.throws(() => assertSuccessfulExit(null, 'Package aioble'), /unknown/);
        await assert.rejects(waitForProcess(() => { throw new Error('No executable'); }, 'py', []),
            /No executable/);
    });

    test('shared REPL upload requires byte-count acknowledgement, not a bare OK_PUT token', async () => {
        const original = connectionManager.runCodeSilently;
        let command = '';
        try {
            connectionManager.runCodeSilently = async script => {
                command = script;
                return { stdout: 'OK_PUT:4\r\n', stderr: '' };
            };
            await connectionManager.writeFile('/lib/a.bin', Buffer.from([0, 1, 2, 3]));
            assert.ok(command.includes('_o.stat("/lib/a.bin")[6] != 4'));
            assert.ok(command.includes("print('OK_PUT:4')"));

            connectionManager.runCodeSilently = async () => ({ stdout: 'OK_PUT', stderr: '' });
            await assert.rejects(connectionManager.writeFile('/lib/a.bin', Buffer.from([1, 2])),
                /byte count/);
            connectionManager.runCodeSilently = async () => ({ stdout: 'OK_PUT:3', stderr: '' });
            await assert.rejects(connectionManager.writeFile('/lib/a.bin', Buffer.from([1, 2])),
                /byte count/);
            connectionManager.runCodeSilently = async () =>
                ({ stdout: 'OK_PUT:2', stderr: 'OSError: disk full' });
            await assert.rejects(connectionManager.writeFile('/lib/a.bin', Buffer.from([1, 2])),
                /disk full/);
        } finally {
            connectionManager.runCodeSilently = original;
        }
    });

    test('production upload and package routes log final status only after completion', () => {
        const root = path.resolve(__dirname, '..');
        const ext = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
        const pkg = fs.readFileSync(path.join(root, 'src', 'packageManager.js'), 'utf8');
        const explorer = fs.readFileSync(path.join(root, 'src', 'deviceFileExplorer.js'), 'utf8');
        assert.ok(ext.includes('operation.success(filePath +'));
        assert.ok(ext.includes("operation.success(fileCount + ' file(s): ' + folderPath"));
        assert.ok(ext.includes("operation.success(fileCount + ' file(s): ' + gDeviceCodeDir"));
        assert.ok(ext.includes("operation.fail(error);"));
        assert.ok(ext.includes("operation.cancel('Overwrite not confirmed"));
        assert.ok(ext.includes("operation.success(completed + '/' + count"));
        assert.ok(pkg.includes("assertSuccessfulExit(code, 'Package ' + selected.pkgName)"));
        assert.ok(pkg.includes("if (typeof onAfterInstall === 'function')"));
        assert.ok(ext.includes('suppressTaskSummary'));
        assert.ok(explorer.includes("operation.success(completed + '/' + files.length"));
    });
});
