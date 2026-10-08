const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Frozen debugger connection workflow', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');

  test('connect-only is the default option and does not upload files', () => {
    const connectIdx = src.indexOf("id: 'connect'", src.indexOf('async function startDebugger('));
    const uploadIdx = src.indexOf("id: 'upload'", src.indexOf('async function startDebugger('));
    assert.ok(connectIdx !== -1 && uploadIdx !== -1 && connectIdx < uploadIdx);
    assert.ok(src.includes('Connect only — debugger already in firmware'));
    assert.ok(src.includes('Legacy Pico setup — upload debugger files'));
  });

  test('rejects choosing the same COM for REPL and debugger', () => {
    assert.ok(src.includes("candidate.toUpperCase() === replPort.trim().toUpperCase()"));
    assert.ok(src.includes('debugger requires the OTHER COM port'));
  });

  test('legacy Pico upload requires an explicit warning/consent', () => {
    assert.ok(src.includes('This legacy setup uploads and overwrites /boot.py'));
    assert.ok(src.includes('if (!answer) return;'));
  });
});
