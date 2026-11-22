'use strict';

const path = require('path');

/** Validate a single filesystem entry, not a path or a parent reference. */
function isSafeDeviceEntryName(name) {
    return typeof name === 'string' &&
        name.length > 0 && name.length <= 255 &&
        name !== '.' && name !== '..' &&
        !/[\\/\x00-\x1f\x7f]/.test(name);
}

/** Avoid directory escapes and invalid cross-platform project names. */
function isSafeProjectName(name) {
    return isSafeDeviceEntryName(name) &&
        name.length <= 100 &&
        name.trim() === name &&
        !/[<>:"|?*]/.test(name) &&
        !/[. ]$/.test(name) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name);
}

function resolveProjectDirectory(parent, name) {
    if (typeof parent !== 'string' || !isSafeProjectName(name)) {
        throw new Error('Project name is not a safe directory name.');
    }
    const root = path.resolve(parent);
    const dest = path.resolve(root, name);
    if (path.dirname(dest) !== root) {
        throw new Error('Project directory must remain inside the chosen parent.');
    }
    return dest;
}

module.exports = { isSafeDeviceEntryName, isSafeProjectName, resolveProjectDirectory };
