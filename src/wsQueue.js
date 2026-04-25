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
   * @returns {Promise<T>}
   */
  run(fn) {
    this._pending++;

    const result = this._tail.then(fn, fn);

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
