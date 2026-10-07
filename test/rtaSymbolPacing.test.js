const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('RTA symbol refresh pacing', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');

  test('paces symbol chunks instead of requesting them back-to-back', () => {
    assert.ok(source.includes('let rtaSymTimer = null;'));
    assert.ok(source.includes('function scheduleNextSymbolMapChunk(delayMs = 25)'));
    assert.ok(source.includes('scheduleNextSymbolMapChunk();'));
  });

  test('cleans up the symbol pacing timer with the debugger panel', () => {
    assert.ok(source.includes('clearTimeout(rtaSymTimer)'));
    assert.ok(source.includes('rtaSymTimer = null;'));
  });
});
