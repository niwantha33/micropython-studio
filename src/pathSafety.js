'use strict';

const path = require('path');
const fs = require('fs');

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


/**
 * Resolve a CircuitPython drive path without allowing ../ traversal or a
 * symlink to redirect reads, writes, moves or recursive deletion off-drive.
 */
function resolveDeviceDrivePath(driveRoot, devicePath) {
    if (typeof driveRoot !== 'string' || !driveRoot ||
        typeof devicePath !== 'string' || !devicePath.startsWith('/')) {
        throw new Error('Invalid CircuitPython drive or device path');
    }
    const segments = devicePath.split('/').filter((p, i) => !(i === 0 && p === ''));
    if (segments.some(segment => !isSafeDeviceEntryName(segment) || segment.includes(':'))) {
        throw new Error('Unsafe CircuitPython device path');
    }
    const root = path.resolve(driveRoot);
    const destination = path.resolve(root, ...segments);
    const relative = path.relative(root, destination);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('CircuitPython path escapes selected drive');
    }
    // Treat symlinks on the device drive as unsafe, including intermediate
    // directories, to prevent a symlink redirecting a recursive delete.
    let current = root;
    for (const segment of segments) {
        current = path.join(current, segment);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                throw new Error('CircuitPython symlink paths are not allowed');
            }
        } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
    }
    return destination;
}

module.exports = { isSafeDeviceEntryName, isSafeProjectName, resolveProjectDirectory, resolveDeviceDrivePath };
