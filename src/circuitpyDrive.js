/**
 * CircuitPython USB drive detection for Windows.
 *
 * Strategy (layered):
 *  1. PowerShell Win32_Volume — find removable drives with label "CIRCUITPY*"
 *  2. For every removable drive — check boot_out.txt contains "CircuitPython"
 *  3. Fallback letter scan A–Z — same boot_out.txt check (if PowerShell fails)
 *
 * MicroPython projects are never affected — callers must check device_firmware first.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Find the CircuitPython USB drive root (e.g. "E:\").
 * Returns the drive path string, or null if not found.
 * @returns {string|null}
 */
function findCircuitPyDrive() {
    // ── Layer 1 & 2: PowerShell Win32_Volume ───────────────────────────────
    try {
        const ps =
            'Get-CimInstance Win32_Volume | ' +
            'Where-Object {$_.DriveType -eq 2 -and $_.DriveLetter -ne $null} | ' +
            'Select-Object DriveLetter,Label | ConvertTo-Json -Compress';

        const out = execSync(
            `powershell -NoProfile -NonInteractive -Command "${ps}"`,
            { encoding: 'utf8', timeout: 5000 }
        ).trim();

        if (out) {
            const raw = JSON.parse(out);
            const volumes = Array.isArray(raw) ? raw : [raw];

            // Pass 1 — exact CIRCUITPY label
            for (const v of volumes) {
                if (v.DriveLetter && v.Label === 'CIRCUITPY') {
                    const p = v.DriveLetter.replace(/[/\\]+$/, '') + '\\';
                    if (_confirmCircuitPy(p)) return p;
                }
            }

            // Pass 2 — label starts with CIRCUITPY (e.g. CIRCUITPY1)
            for (const v of volumes) {
                if (v.DriveLetter && v.Label && v.Label.startsWith('CIRCUITPY')) {
                    const p = v.DriveLetter.replace(/[/\\]+$/, '') + '\\';
                    if (_confirmCircuitPy(p)) return p;
                }
            }

            // Pass 3 — any removable drive whose boot_out.txt says CircuitPython
            for (const v of volumes) {
                if (v.DriveLetter) {
                    const p = v.DriveLetter.replace(/[/\\]+$/, '') + '\\';
                    if (_confirmCircuitPy(p)) return p;
                }
            }
        }
    } catch (_) {
        // PowerShell not available or returned unexpected output — fall through
    }

    // ── Layer 3: Letter scan fallback ──────────────────────────────────────
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drivePath = `${letter}:\\`;
        if (_confirmCircuitPy(drivePath)) return drivePath;
    }

    return null;
}

/**
 * Confirm a drive is CircuitPython by checking boot_out.txt content.
 * @param {string} drivePath  e.g. "E:\"
 * @returns {boolean}
 */
function _confirmCircuitPy(drivePath) {
    try {
        const bootOut = path.join(drivePath, 'boot_out.txt');
        if (!fs.existsSync(bootOut)) return false;
        const content = fs.readFileSync(bootOut, 'utf8');
        return content.includes('CircuitPython');
    } catch (_) {
        return false;
    }
}

/**
 * Read board info from boot_out.txt on the CircuitPython drive.
 * Returns { version, board } or null.
 * @param {string} drivePath
 * @returns {{ version: string, board: string }|null}
 */
function readCircuitPyBootInfo(drivePath) {
    try {
        const bootOut = path.join(drivePath, 'boot_out.txt');
        const content = fs.readFileSync(bootOut, 'utf8');
        // e.g. "Adafruit CircuitPython 9.2.4 on 2024-11-22; Raspberry Pi Pico 2 W with rp2350"
        const match = content.match(/CircuitPython\s+([\d.]+)\s+on\s+[\d-]+;\s+(.+)/);
        if (match) {
            return { version: match[1], board: match[2].trim() };
        }
        return null;
    } catch (_) {
        return null;
    }
}

/**
 * Copy a local file to the CircuitPython drive, preserving relative path.
 * e.g. copyToCircuitPyDrive("E:\", "C:\project\main\code.py", "C:\project\main")
 *      → copies to "E:\code.py"
 *
 * @param {string} drivePath   Root of the CP drive, e.g. "E:\"
 * @param {string} localFile   Absolute path to the source file
 * @param {string} localRoot   The local root to strip when computing relative path
 */
function copyToCircuitPyDrive(drivePath, localFile, localRoot) {
    const rel = path.relative(localRoot, localFile);
    const dest = path.join(drivePath, rel);
    const destDir = path.dirname(dest);
    try {
        fs.mkdirSync(destDir, { recursive: true });
    } catch (err) {
        // Ignore EPERM/EEXIST for root directory creations like "E:\"
        if (err.code !== 'EPERM' && err.code !== 'EEXIST') {
            throw err;
        }
    }
    fs.copyFileSync(localFile, dest);
    return dest;
}

/**
 * Files/folders to never copy from the CIRCUITPY drive to local.
 * Excludes credentials, system files, and auto-generated boot logs.
 */
const SYNC_EXCLUDE = new Set([
    'settings.toml',             // Wi-Fi credentials + API password
    'boot_out.txt',              // auto-generated on every boot
    '.Trashes',                  // macOS system
    '.fseventsd',                // macOS system
    '.Spotlight-V100',           // macOS system
    'System Volume Information', // Windows system
    '$RECYCLE.BIN',              // Windows system
]);

/**
 * Sync all files from the CIRCUITPY drive to a local destination folder.
 * Skips files in SYNC_EXCLUDE. Creates subdirectories as needed.
 *
 * @param {string} drivePath   e.g. 'E:\'
 * @param {string} localDest   Absolute path to local main/ folder
 * @returns {{ copied: number, skipped: string[], errors: string[] }}
 */
function syncFromCircuitPyDrive(drivePath, localDest) {
    // Guard: if localDest IS the drive itself, there is nothing to sync to locally
    const normDrive = path.resolve(drivePath).replace(/[/\\]+$/, '');
    const normDest  = path.resolve(localDest).replace(/[/\\]+$/, '');
    if (normDrive.toLowerCase() === normDest.toLowerCase()) {
        return { copied: 0, skipped: [], errors: ['Destination is the same as the source drive — sync skipped.'] };
    }

    const skipped = [];
    const errors  = [];
    let copiedCount = 0;

    /** @param {string} srcDir @param {string} destDir */
    function walk(srcDir, destDir) {
        let entries;
        try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); }
        catch (_) { return; }

        for (const entry of entries) {
            if (SYNC_EXCLUDE.has(entry.name) || entry.name.startsWith('.')) {
                skipped.push(path.join(srcDir, entry.name));
                continue;
            }
            const srcPath  = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);

            if (entry.isDirectory()) {
                try { fs.mkdirSync(destPath, { recursive: true }); } catch (_) {}
                walk(srcPath, destPath);
            } else {
                try {
                    fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(srcPath, destPath);
                    copiedCount++;
                } catch (err) {
                    errors.push(`${srcPath}: ${err.message}`);
                }
            }
        }
    }

    walk(drivePath, localDest);
    return { copied: copiedCount, skipped, errors };
}

module.exports = { findCircuitPyDrive, readCircuitPyBootInfo, copyToCircuitPyDrive, syncFromCircuitPyDrive };
