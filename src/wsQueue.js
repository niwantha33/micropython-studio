'use strict';

/**
 * wsQueue.js
 * Singleton promise-chain queue for device operations (Serial and WebSocket).
 *
 * MicroPython WebREPL only supports ONE concurrent WebSocket connection.
 * Similarly, Serial COM ports on Windows can be unstable or "Busy" if
 * multiple processes (File Explorer, Dashboard, etc.) try to open them at once.
 *
 * Every subprocess call (gatherDeviceMetrics, runDeviceScript, upload,
 * download, ls, read, delete …) should be wrapped with wsQueue.run(fn) so
 * they are serialised and never overlap on the same device.
 *
 * Usage:
 *   const deviceQueue = require('./wsQueue');
 *   result = await deviceQueue.run(() => doDeviceOperation());
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function getLockFilePath(port) {
  if (!port) return null;
  const lockName = `mps_lock_${port.replace(/\//g, '_').replace(/\\/g, '_').replace(/:/g, '_')}.lock`;
  return path.join(os.tmpdir(), lockName);
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function isPortLocked(port, daemonPid) {
  const lockPath = getLockFilePath(port);
  if (!lockPath || !fs.existsSync(lockPath)) {
    return false;
  }
  try {
    const content = fs.readFileSync(lockPath, 'utf8').trim();
    const parts = content.split(':');
    const pid = parseInt(parts[0], 10);
    const owner = parts[1] || 'unknown';
    if (isNaN(pid)) {
      return false;
    }
    if (daemonPid && pid === daemonPid) {
      return false;
    }
    
    // If it's a temporary suspended lock written by the extension,
    // we check the age of the file. If it is older than 8 seconds,
    // we assume the spawned process failed to claim it or start,
    // so we treat it as stale/unlocked.
    if (owner === 'suspended_lock') {
      const stats = fs.statSync(lockPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs > 8000) {
        return false;
      }
    }
    
    return isPidRunning(pid);
  } catch (err) {
    return false;
  }
}

class DeviceOperationQueue {
  constructor() {
    /** @type {Promise<void>} always resolves — never rejects */
    this._tail = Promise.resolve();
    this._pending = 0; // number of operations waiting or running
  }

  /**
   * Enqueue an async operation behind any currently-running device operations.
   *
   * The callback `fn` is only called after all previously enqueued operations
   * have settled (resolved OR rejected).  The returned promise resolves/rejects
   * with fn's own result so callers get the real error/value.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {string} [label]
   * @returns {Promise<T>}
   */
  run(fn, label = '') {
    this._pending++;

    if (!label) {
      const fnStr = fn.toString();
      if (fnStr.includes('lsOp') || fnStr.includes('list_files') || fnStr.includes('ilistdir') || fnStr.includes('ls')) {
        label = 'List Files';
      } else if (fnStr.includes('rmOp') || fnStr.includes('deleteDeviceFile') || fnStr.includes('rm')) {
        label = 'Delete File';
      } else if (fnStr.includes('rmTreeOp') || fnStr.includes('deleteDeviceFolder')) {
        label = 'Delete Folder';
      } else if (fnStr.includes('moveOp') || fnStr.includes('renameDeviceFile') || fnStr.includes('mv')) {
        label = 'Rename/Move';
      } else if (fnStr.includes('execOp') || fnStr.includes('exec_code')) {
        label = 'Execute Code';
      } else if (fnStr.includes('hrArgs') || fnStr.includes('hard_reset')) {
        label = 'Hard Reset';
      } else if (fnStr.includes('upload') || fnStr.includes('uploadArgs')) {
        label = 'Upload';
      } else if (fnStr.includes('download') || fnStr.includes('downloadArgs') || fnStr.includes('baseArgs')) {
        label = 'Download';
      } else if (fn.name) {
        label = fn.name;
      } else {
        label = 'Device Operation';
      }
    }

    const logToFile = (msg) => {
      // Disabled debug file logging
    };

    const logMsg = (msg) => {
      console.log(msg);
      logToFile(msg);
      try {
        const vscode = require('vscode');
        const channel = vscode.window.createOutputChannel('MicroPython IDE');
        channel.appendLine(msg);
      } catch (_) {}
    };

    const wrappedFn = async () => {
      const connectionManager = require('./connectionManager');
      const port = connectionManager.portName;
      const daemonPid = connectionManager.daemonProcess ? connectionManager.daemonProcess.pid : null;

      logMsg(`[wsQueue] Requesting access for: ${label}`);

      // If the port is locked by another process (e.g. terminal run session), wait for it to release
      if (port) {
        let lockChecked = false;
        while (isPortLocked(port, daemonPid)) {
          const lockPath = getLockFilePath(port);
          let lockerInfo = 'unknown process';
          if (lockPath && fs.existsSync(lockPath)) {
            try {
              const content = fs.readFileSync(lockPath, 'utf8').trim();
              const parts = content.split(':');
              const pid = parts[0];
              const owner = parts[1] || 'unknown';
              lockerInfo = `PID ${pid} (${owner})`;
            } catch (_) {}
          }
          logMsg(`[wsQueue] Port ${port} is currently locked by ${lockerInfo}. Waiting for release...`);
          lockChecked = true;
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (lockChecked) {
          logMsg(`[wsQueue] Port ${port} has been released.`);
        }
      }

      const wasSuspended = connectionManager.isSuspended;
      if (!wasSuspended) {
        logMsg(`[wsQueue] Suspending connectionManager for: ${label}`);
        await connectionManager.suspend();
      }
      try {
        logMsg(`[wsQueue] Executing: ${label}`);
        return await fn();
      } finally {
        if (!wasSuspended) {
          logMsg(`[wsQueue] Resuming connectionManager after: ${label}`);
          await connectionManager.resume();
        }
      }
    };

    const result = this._tail.then(wrappedFn, wrappedFn);

    // Advance the tail regardless of whether fn succeeds or fails,
    // so later callers are never permanently blocked.
    this._tail = result.then(
      () => { this._pending = Math.max(0, this._pending - 1); },
      () => { this._pending = Math.max(0, this._pending - 1); },
    );

    return result;
  }

  /** Number of ws: operations currently waiting or running. */
  get pending() {
    return this._pending;
  }
}

module.exports = new DeviceOperationQueue();
