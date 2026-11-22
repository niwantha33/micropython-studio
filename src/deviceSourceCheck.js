'use strict';

const path = require('path');

function normalizePythonSource(value) {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
    // Windows editor and MicroPython filesystem may use different line endings.
    return text.replace(/\r\n?/g, '\n');
}

function comparePythonSource(local, target) {
    const expected = normalizePythonSource(local);
    const actual = normalizePythonSource(target);
    return {
        same: expected === actual,
        localBytes: Buffer.byteLength(expected, 'utf8'),
        deviceBytes: Buffer.byteLength(actual, 'utf8')
    };
}

function isInsideProject(projectRoot, candidate) {
    const relative = path.relative(path.resolve(projectRoot), path.resolve(candidate));
    return relative !== '' && relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

module.exports = { normalizePythonSource, comparePythonSource, isInsideProject };
