'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCommand } = require('../src/runCommand');
const { getConfigValue, updateCfgComponent } = require('../src/commonFxn');
const { initializeSecretStorage, getDeviceSecret, setDeviceSecret } = require('../src/deviceSecrets');

suite('Security and reliability hardening', () => {
    test('process runner passes shell metacharacters as literal argv', async () => {
        let output = '';
        const outputChannel = {
            append: value => { output += value; },
            appendLine: value => { output += value + '\n'; }
        };
        const payload = 'literal "quoted" & | ; $(echo unsafe) ^ % !';
        await runCommand(outputChannel, process.execPath,
            ['-e', 'process.stdout.write(process.argv[1])', payload], os.tmpdir());
        assert.ok(output.includes(payload), 'the complete argument must survive unchanged');
        assert.ok(output.includes('Command completed successfully'));
    });

    test('process runner rejects nonzero exit status and invalid argv', async () => {
        const output = { append() {}, appendLine() {} };
        await assert.rejects(runCommand(output, process.execPath,
            ['-e', 'process.exit(7)'], os.tmpdir()), /exit code 7/);
        await assert.rejects(runCommand(output, process.execPath,
            ['--version', { untrusted: true }], os.tmpdir()), /array of string arguments/);
    });

    test('plaintext passwords and embedded WebREPL port credentials migrate to SecretStorage', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-security-'));
        const config = path.join(dir, 'device.cfg');
        const other = path.join(dir, 'other.cfg');
        const entries = new Map();
        initializeSecretStorage({ secrets: {
            get: async key => entries.get(key),
            store: async (key, value) => { entries.set(key, value); },
            delete: async key => { entries.delete(key); }
        } });
        try {
            fs.writeFileSync(config, '[device]\nport = "ws:192.168.0.4,legacy-pass"\n[remote]\nwebrepl_password = "legacy-pass"\nwebworkflow_password = "workflow-pass"\n');
            assert.strictEqual(await getDeviceSecret(config, 'webrepl_password'), 'legacy-pass');
            assert.strictEqual(await getDeviceSecret(config, 'webworkflow_password'), 'workflow-pass');

            const migrated = fs.readFileSync(config, 'utf8');
            assert.ok(!migrated.includes('legacy-pass'), 'legacy WebREPL credential must be erased');
            assert.ok(!migrated.includes('workflow-pass'), 'legacy Web Workflow credential must be erased');
            assert.strictEqual(await getConfigValue(config, 'device', 'port'), 'NOT_SET');

            await updateCfgComponent(config, 'device', 'port', 'ws:10.0.0.1,never-write-me');
            assert.ok(!fs.readFileSync(config, 'utf8').includes('never-write-me'));

            await setDeviceSecret(config, 'webrepl_password', 'new-password');
            assert.strictEqual(await getDeviceSecret(config, 'webrepl_password'), 'new-password');
            assert.ok(!fs.readFileSync(config, 'utf8').includes('new-password'));

            fs.writeFileSync(other, '[remote]\nwebrepl_password = ""\n');
            await setDeviceSecret(other, 'webrepl_password', 'another-project');
            assert.strictEqual(await getDeviceSecret(other, 'webrepl_password'), 'another-project');
            assert.strictEqual(await getDeviceSecret(config, 'webrepl_password'), 'new-password');
            await assert.rejects(getDeviceSecret(config, 'not_a_secret'), /Unsupported credential key/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('device operations cannot interpolate paths into shell commands', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'deviceFileExplorer.js'), 'utf8');
        assert.ok(source.includes("const { execFile } = require('child_process');"));
        assert.ok(source.includes("function backendExec("));
        assert.ok(!/\bexec\(cmd\b/.test(source));
        assert.ok(!/shell:\s*true/.test(source));
    });

    test('TCP REPL bridge is loopback-only unless remote exposure is explicitly permitted', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'rfc_server.py'), 'utf8');
        assert.ok(source.includes('host="127.0.0.1"'));
        assert.ok(source.includes('--allow-remote'));
        assert.ok(source.includes('reader.join(timeout=2.0)'));
    });
});
