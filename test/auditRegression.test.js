'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDeviceDrivePath } = require('../src/pathSafety');
const { writeSettingsToml } = require('../src/circuitpyWebWorkflow');
const { loadVerifiedManifest } = require('../src/simulator');

suite('Audit-driven security regression gates', () => {
    test('unsafe CircuitPython paths and off-drive traversal are rejected', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-drive-'));
        try {
            const root = path.join(dir, 'CIRCUITPY');
            fs.mkdirSync(root);
            assert.strictEqual(resolveDeviceDrivePath(root, '/code.py'),
                path.join(root, 'code.py'));
            for (const bad of ['/../outside', '/a/../../outside', '/a\\b', '/C:/Windows', '/./escape']) {
                assert.throws(() => resolveDeviceDrivePath(root, bad), /Unsafe|Invalid|escapes/);
            }
            const outside = path.join(dir, 'outside');
            fs.mkdirSync(outside);
            const link = path.join(root, 'linked');
            try {
                fs.symlinkSync(outside, link, 'dir');
                assert.throws(() => resolveDeviceDrivePath(root, '/linked/delete_me'), /symlink/i);
            } catch (error) {
                if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
            }
        } finally {
            fs.rmSync(dir, { force: true, recursive: true });
        }
    });

    test('CircuitPython TOML handles quotes and backslashes literally', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-toml-'));
        try {
            const values = { ssid: 'AP "guest" \\ WiFi', wifiPassword: 'p"\\x', apiPassword: 'a"b', apiPort: 80 };
            assert.deepStrictEqual(writeSettingsToml(dir, values), { ok: true });
            const toml = fs.readFileSync(path.join(dir, 'settings.toml'), 'utf8');
            assert.ok(toml.includes('CIRCUITPY_WIFI_SSID = ' + JSON.stringify(values.ssid)));
            assert.ok(toml.includes('CIRCUITPY_WIFI_PASSWORD = ' + JSON.stringify(values.wifiPassword)));
            assert.ok(toml.includes('CIRCUITPY_WEB_API_PASSWORD = ' + JSON.stringify(values.apiPassword)));
            assert.strictEqual(writeSettingsToml(dir, { ...values, apiPort: 70000 }).ok, false);
        } finally {
            fs.rmSync(dir, { force: true, recursive: true });
        }
    });

    test('simulator refuses unverified binaries instead of downloading or executing them', () => {
        const ctx = { extensionPath: path.join(__dirname, '..') };
        assert.throws(() => loadVerifiedManifest(ctx), /disabled|unverified|unavailable/i);
        const simulator = fs.readFileSync(path.join(__dirname, '..', 'src', 'simulator.js'), 'utf8');
        assert.ok(simulator.includes("digest('hex')"));
        assert.ok(simulator.includes('verifySha256(qemuBin, assets.qemu.executableSha256)'));
        assert.ok(!simulator.includes("'-semihosting'"));
        assert.ok(!simulator.includes('/raw/main/qemu/'));
    });

    test('debugger and dashboard block untrusted inline scripts with CSP nonces', () => {
        const debuggerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');
        const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'deviceDashboard.js'), 'utf8');
        for (const source of [debuggerSource, dashboard]) {
            assert.ok(source.includes("script-src 'nonce-"));
            assert.ok(source.includes('crypto.randomBytes(16)'));
            assert.ok(!/\bon(click|change)=/.test(source));
        }
        assert.ok(dashboard.includes('escapeDashboardHtml(metrics.bootLog.ip)'));
        assert.ok(dashboard.includes("document.getElementById('connectedSsid').textContent"));
        assert.ok(dashboard.includes("statusEl.textContent = String(msg.message || '')"));
        assert.ok(debuggerSource.includes('escapeHtml(lm[2])'));
        assert.ok(debuggerSource.includes('escapeHtml(currentNames[i])'));
    });

    test('AI webview has no third-party scripts and status text cannot inject HTML', () => {
        const ai = fs.readFileSync(path.join(__dirname, '..', 'resource', 'aiAssistant.html'), 'utf8');
        assert.ok(ai.includes('Content-Security-Policy'));
        assert.ok(ai.includes("script-src 'nonce-__MPS_CSP_NONCE__'"));
        assert.ok(ai.includes('data-code-action="run"'));
        assert.ok(!ai.includes('onclick='));
        assert.ok(ai.includes("querySelector('.thinking-status').textContent"));
        assert.ok(!/<script\s+src=["']https?:/i.test(ai));
        assert.ok(!/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(ai));
    });
});