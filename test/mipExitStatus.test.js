const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('MIP process exit status', () => {
  test('device-side install failure never exits with success', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mps_backend.py'), 'utf8');
    assert.ok(source.includes('sys.exit(rc if rc != 0 else 1)'));
    assert.ok(!source.includes('print(f"On-device installation failed.", file=sys.stderr)\n        sys.exit(rc)'));
  });
});
