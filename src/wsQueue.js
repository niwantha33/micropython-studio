'use strict';

/**
 * wsQueue.js
 * Singleton promise-chain queue for WebSocket device connections.
 *
 * MicroPython WebREPL only supports ONE concurrent WebSocket connection.
 * If two operations both try to open ws: at the same time the device
 * rejects the second one immediately.
 *
 * Every ws: subprocess call (gatherDeviceMetrics, runDeviceScript, upload,
 * download, ls, read, delete …) must be wrapped with wsQueue.run(fn) so
 * they are serialised and never overlap.
 *
 * Usage:
 *   const wsQueue = require('./wsQueue');
 *   // Only queue when the port is ws:
 *   if (port.startsWith('ws:')) {
 *     result = await wsQueue.run(() => doWsOperation());
 *   } else {
 *     result = await doOperation();
 *   }
 */

class WsConnectionQueue {
  constructor() {
    /** @type {Promise<void>} always resolves — never rejects */
    this._tail = Promise.resolve();
    this._pending = 0; // number of operations waiting or running
  }

  /**
   * Enqueue an async operation behind any currently-running ws: operations.
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

module.exports = new WsConnectionQueue();
