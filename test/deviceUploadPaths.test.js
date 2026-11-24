'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    relativeInside, remoteJoin, resolveProjectCodeDir, fileRemotePath, folderRemotePath,
    countLocalUploadFiles
} = require('../src/deviceUploadPaths');
const { canUseSharedSerial } = require('../src/deviceFileExplorer');

suite('MicroPython upload source and destination paths', () => {
    test('current project main maps to MCU root, including nested library files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-upload-paths-'));
        const main = path.join(root, 'main');
        const lib = path.join(main, 'lib');
        try {
            fs.mkdirSync(lib, { recursive: true });
            fs.writeFileSync(path.join(main, 'main.py'), 'print(1)\n');
            fs.writeFileSync(path.join(lib, 'driver.py'), 'print(2)\n');
            assert.strictEqual(resolveProjectCodeDir(root, main), main);
            assert.strictEqual(countLocalUploadFiles(main), 2);
            assert.strictEqual(fileRemotePath(path.join(main, 'main.py'), main), '/main.py');
            assert.strictEqual(fileRemotePath(path.join(lib, 'driver.py'), main), '/lib/driver.py');
            assert.strictEqual(folderRemotePath(main, main), '/');
            assert.strictEqual(folderRemotePath(lib, main), '/lib');
            assert.strictEqual(folderRemotePath(main, main, '/flash'), '/flash');
            assert.strictEqual(fileRemotePath(path.join(lib, 'driver.py'), main, '/flash'), '/flash/lib/driver.py');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('empty source folders cannot be reported as completed uploads', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-upload-empty-'));
        try {
            assert.strictEqual(countLocalUploadFiles(root), 0);
            assert.throws(() => countLocalUploadFiles(path.join(root, 'missing')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('moved project must not use a stale absolute source from another checkout', () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-upload-moved-'));
        const original = path.join(temp, 'old', 'main');
        const current = path.join(temp, 'new');
        const currentMain = path.join(current, 'main');
        try {
            fs.mkdirSync(original, { recursive: true });
            fs.mkdirSync(currentMain, { recursive: true });
            assert.strictEqual(resolveProjectCodeDir(current, original), currentMain);
            assert.strictEqual(resolveProjectCodeDir(current, path.join('main')), currentMain);
            assert.strictEqual(resolveProjectCodeDir(current, path.join(current, 'missing')), currentMain);

        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    });

    test('Windows drive paths map to POSIX target paths on both host platforms', () => {
        const root = 'C:\\My-Projects\\picow\\main';
        assert.strictEqual(relativeInside(root, 'C:\\My-Projects\\picow\\main\\lib\\i2c.py'),
            'lib/i2c.py');
        assert.strictEqual(fileRemotePath('C:\\My-Projects\\picow\\main\\main.py', root), '/main.py');
        assert.strictEqual(fileRemotePath('C:\\My-Projects\\picow\\main\\lib\\i2c.py', root),
            '/lib/i2c.py');
        assert.strictEqual(folderRemotePath(root, root), '/');
        assert.strictEqual(folderRemotePath('C:\\My-Projects\\picow\\main\\lib', root), '/lib');
        assert.strictEqual(fileRemotePath('D:\\Downloads\\test.py', root), '/test.py');
    });

    test('cannot escape remote destination and never use Windows paths as remote roots', () => {
        assert.strictEqual(remoteJoin('/', 'main.py'), '/main.py');
        assert.strictEqual(remoteJoin('/flash', 'lib/i2c.py'), '/flash/lib/i2c.py');
        assert.throws(() => remoteJoin('/', '../boot.py'), /escape/);
        assert.throws(() => remoteJoin('C:\\temp', 'main.py'), /absolute POSIX/);
    });

    test('Device Files upload reuses COM7 even when device.cfg says com7', () => {
        const manager = {
            isConnected: true, isSuspended: false,
            isReconnecting: false, portName: 'COM7'
        };
        assert.strictEqual(canUseSharedSerial(manager, 'com7'), true);
        assert.strictEqual(canUseSharedSerial(manager, 'COM5'), false);
        manager.isSuspended = true;
        assert.strictEqual(canUseSharedSerial(manager, 'COM7'), false);
    });

    test('extension checks actual upload success before refreshing and uses port-insensitive shared serial', () => {
        const ext = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
        assert.ok(ext.includes('fileRemotePath(filePath, gDeviceCodeDir, deviceRoot)'));
        assert.ok(ext.includes('folderRemotePath(folderPath, gDeviceCodeDir, deviceRoot)'));
        assert.ok(ext.includes('samePort(connectionManager.portName, gRemoteDevicePort)'));
        assert.ok(ext.includes('if (code !== 0)'));
        assert.ok(ext.includes('await _runUploadQueued(venvPython'));
        assert.ok(ext.includes('Backend upload failed (exit code'));
        assert.ok(!ext.includes('const remoteFolder = isXBeeDevice() ? `/flash/${dest}` : `/${dest}`'));
    });
});
