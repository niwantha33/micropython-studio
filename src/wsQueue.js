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
const { samePort, normalizeSerialPort } = require('./devicePortSelection');

function getLogChannel() {
  return require('./studioOutput').getStudioOutputChannel();
}

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

function isPortLocked(port, daemonPid, isSuspended) {
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
    // The acknowledged suspension reserves this port for our own backend
    // children. It is not a foreign operation; the queue already serializes
    // those children. Never bypass another host's reservation or a live CLI.
    if (isSuspended && pid === process.pid && owner === 'suspended_lock') {
      return false;
    }
    
    // Never declare a live owner's lock stale merely because a transfer
    // takes longer than eight seconds. That can reopen the COM mid-upload.
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
   * @param {boolean} [runDirectIfConnected]
   * @param {string} [targetPort] device addressed by this operation
   * @returns {Promise<T>}
   */
  run(fn, label = '', runDirectIfConnected = false, targetPort) {
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

    const logToFile = () => {
      // Disabled debug file logging
    };

    const logMsg = (msg) => {
      console.log(msg);
      logToFile(msg);
      try {
        getLogChannel().appendLine(msg);
      } catch (_) {}
    };

    const wrappedFn = async () => {
      const connectionManager = require('./connectionManager');
      // Shell may still be starting its daemon when a file/package action is
      // clicked. Wait for that handshake before deciding who must release COM.
      if (connectionManager._connectPromise) await connectionManager._connectPromise;
      const port = normalizeSerialPort(targetPort || connectionManager.portName);
      const sharedPort = samePort(port, connectionManager.portName);
      const daemonPid = sharedPort && connectionManager.isConnected && connectionManager.daemonProcess
        ? connectionManager.daemonProcess.pid : null;

      logMsg(`[wsQueue] Requesting access for: ${label}`);

      const useDirect = runDirectIfConnected && sharedPort && connectionManager.isConnected &&
        !connectionManager.isSuspended && !connectionManager.isReconnecting;

      // If the port is locked by another process (e.g. terminal run session), wait for it to release
      if (!useDirect && port) {
        let lockChecked = false;
        const waitStart = Date.now();
        while (isPortLocked(port, daemonPid, sharedPort && connectionManager.isSuspended)) {
          if (Date.now() - waitStart > 12000) {
            throw new Error(`Serial port ${port} is still owned by another operation after 12 seconds. Close the other terminal or retry when upload completes.`);
          }
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
      const shouldSuspend = !useDirect && sharedPort && !wasSuspended && connectionManager.isConnected;
      if (shouldSuspend) {
        logMsg(`[wsQueue] Suspending connectionManager for: ${label}`);
        await connectionManager.suspend();
      }
      try {
        logMsg(`[wsQueue] Executing: ${label}`);
        return await fn();
      } finally {
        if (shouldSuspend) {
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
