'use strict';

// Device-side probe is read-only unless collect=true is explicitly requested.
// -1 marks unavailable APIs; never turn unsupported memory data into zero.
function buildProbeScript(collect = false) {
    const lines = [
        'import gc as _mps_gc',
        'def _mps_get(name):',
        '    try:',
        '        return int(getattr(_mps_gc, name)())',
        '    except Exception:',
        '        return -1',
        '_mps_alloc_before = _mps_get("mem_alloc")',
        '_mps_free_before = _mps_get("mem_free")',
        '_mps_threshold = _mps_get("threshold")',
        '_mps_gc_us = -1',
    ];
    if (collect) {
        lines.push(
            'try:',
            '    import time as _mps_time',
            '    _mps_start = _mps_time.ticks_us()',
            '    _mps_gc.collect()',
            '    _mps_gc_us = _mps_time.ticks_diff(_mps_time.ticks_us(), _mps_start)',
            'except Exception:',
            '    _mps_gc.collect()',
        );
    }
    lines.push(
        '_mps_alloc_after = _mps_get("mem_alloc")',
        '_mps_free_after = _mps_get("mem_free")',
        'print("MPS_MEMORY_V1:{},{},{},{},{},{}".format(_mps_alloc_before, _mps_free_before, _mps_alloc_after, _mps_free_after, _mps_gc_us, _mps_threshold))'
    );
    return lines.join('\n');
}

function parseMemorySample(stdout, collected = false, now = Date.now()) {
    if (typeof stdout !== 'string') throw new Error('Device returned no memory data.');
    const matches = [...stdout.matchAll(/^MPS_MEMORY_V1:(-?\d+(?:,-?\d+){5})\r?$/gm)];
    if (matches.length !== 1) throw new Error('Invalid or missing memory probe response.');
    const values = matches[0][1].split(',').map(Number);
    if (!values.every(Number.isSafeInteger) || !Number.isFinite(now)) {
        throw new Error('Invalid memory counters returned by device.');
    }
    const [allocatedBefore, freeBefore, allocatedAfter, freeAfter, gcTimeUs, threshold] = values;
    const safe = value => value >= 0 ? value : null;
    return {
        timestamp: now,
        collected: !!collected,
        allocatedBefore: safe(allocatedBefore),
        freeBefore: safe(freeBefore),
        allocated: safe(allocatedAfter),
        free: safe(freeAfter),
        total: allocatedAfter >= 0 && freeAfter >= 0 ? allocatedAfter + freeAfter : null,
        gcTimeUs: collected ? safe(gcTimeUs) : null,
        threshold: safe(threshold),
        reclaimed: collected && allocatedBefore >= 0 && allocatedAfter >= 0
            ? allocatedBefore - allocatedAfter : null,
    };
}

function summarizeMemory(samples) {
    const valid = samples.filter(s => Number.isFinite(s.allocated));
    const latest = samples.length ? samples[samples.length - 1] : null;
    const highWater = valid.length ? Math.max(...valid.map(s => s.allocated)) : null;
    const first = valid.length ? valid[0] : null;
    const last = valid.length ? valid[valid.length - 1] : null;
    return {
        count: samples.length,
        latest,
        allocatedHighWater: highWater,
        observedGrowth: first && last ? last.allocated - first.allocated : null,
        manualCollections: samples.filter(s => s.collected).length,
    };
}

module.exports = { buildProbeScript, parseMemorySample, summarizeMemory };
