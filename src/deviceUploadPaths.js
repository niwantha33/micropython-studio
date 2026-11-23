'use strict';

const path = require('path');
const fs = require('fs');

function localPathApi(...items) {
    return items.some(value => typeof value === 'string' &&
        (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')))
        ? path.win32 : path;
}

function relativeInside(root, selected) {
    if (!root || !selected) return null;
    const api = localPathApi(root, selected);
    const rel = api.relative(api.resolve(root), api.resolve(selected));
    if (rel === '') return '';
    if (api.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + api.sep)) return null;
    return rel.replace(/\\/g, '/');
}

function remoteJoin(root, relative) {
    if (!root || !root.startsWith('/') || root.includes('\\')) {
        throw new Error('Device destination must be an absolute POSIX path');
    }
    const parts = String(relative || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) {
        throw new Error('Device destination cannot escape its selected directory');
    }
    const base = root === '/' ? '' : root.replace(/\/+$/, '');
    return (base + '/' + parts.join('/')).replace(/\/+$/, '') || '/';
}

/**
 * Resolve the code folder from the CURRENT project, never a stale absolute
 * device.cfg path belonging to a cloned or moved Windows project.
 * Valid nested configured folders within the project remain supported.
 */
function resolveProjectCodeDir(projectDir, configuredDir, fileSystem = fs) {
    if (!projectDir) return null;
    const api = localPathApi(projectDir, configuredDir);
    const root = api.resolve(projectDir);
    const configured = configuredDir
        ? (api.isAbsolute(configuredDir) ? api.resolve(configuredDir) : api.resolve(root, configuredDir))
        : null;
    const isDirectory = candidate => {
        try { return fileSystem.statSync(candidate).isDirectory(); }
        catch (_) { return false; }
    };
    if (configured && relativeInside(root, configured) !== null && isDirectory(configured)) {
        return configured;
    }
    const main = api.join(root, 'main');
    if (isDirectory(main)) return main;
    // Support simple projects with main.py directly at their project root.
    try {
        if (fileSystem.statSync(api.join(root, 'main.py')).isFile()) return root;
    } catch (_) { /* No safe code directory available. */ }
    return null;
}

function fileRemotePath(filePath, codeRoot, deviceRoot = '/') {
    if (!filePath) throw new Error('No local file selected');
    const api = localPathApi(filePath, codeRoot);
    const relative = relativeInside(codeRoot, filePath);
    return remoteJoin(deviceRoot, relative || api.basename(filePath));
}

function folderRemotePath(folderPath, codeRoot, deviceRoot = '/') {
    if (!folderPath) throw new Error('No local folder selected');
    const api = localPathApi(folderPath, codeRoot);
    const relative = relativeInside(codeRoot, folderPath);
    return remoteJoin(deviceRoot, relative === null ? api.basename(folderPath) : relative);
}

module.exports = { relativeInside, remoteJoin, resolveProjectCodeDir, fileRemotePath, folderRemotePath };
