"use strict";

/*
 * Shared chart-history persistence. This module has no DOM or page-visibility dependencies.
 * The market transaction owner calls recordTick() after each successful rate change.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CrypMarketHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const COLLECTION = "marketHistory";
  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const RETENTION_MS = 3 * DAY_MS;
  const GAP_STEPS = 3;
  const WRITE_FAILURE_LIMIT = 3;
  const CURRENCIES = ["cryp", "blue"];
  const KINDS = {
    fine: { prefix: "h", bucketMs: HOUR_MS, stepMs: 5000, slots: 720 },
    coarse: { prefix: "d", bucketMs: DAY_MS, stepMs: 300000, slots: 288 }
  };

  function bucketIndex(kind, ms) {
    return Math.floor(ms / KINDS[kind].bucketMs);
  }

  function docId(kind, currency, index) {
    return KINDS[kind].prefix + "-" + currency + "-" + index;
  }

  function slotOf(kind, ms) {
    const spec = KINDS[kind];
    return Math.floor((ms - bucketIndex(kind, ms) * spec.bucketMs) / spec.stepMs);
  }

  function startsNewStep(kind, previousMs, nowMs) {
    const step = KINDS[kind].stepMs;
    if (!Number.isFinite(previousMs) || previousMs <= 0) return true;
    return Math.floor(nowMs / step) !== Math.floor(previousMs / step);
  }

  function buildPointWrite(kind, currency, nowMs, price) {
    const spec = KINDS[kind];
    const index = bucketIndex(kind, nowMs);
    const start = index * spec.bucketMs;
    return {
      id: docId(kind, currency, index),
      data: {
        cur: currency,
        start,
        expireAt: new Date(start + RETENTION_MS),
        ["t" + slotOf(kind, nowMs)]: Number(Number(price).toFixed(4))
      }
    };
  }

  function buildGapAnchorWrite(kind, currency, tick) {
    const step = KINDS[kind].stepMs;
    if (!tick || !Number.isFinite(tick.previousAt) || tick.previousAt <= 0) return null;
    if (!(Number(tick.previousPrice) > 0)) return null;
    if (tick.now - tick.previousAt < GAP_STEPS * step) return null;
    const anchorMs = (Math.floor(tick.previousAt / step) + 1) * step;
    if (anchorMs >= Math.floor(tick.now / step) * step) return null;
    return buildPointWrite(kind, currency, anchorMs, tick.previousPrice);
  }

  function parseDocument(kind, data) {
    const spec = KINDS[kind];
    const points = [];
    if (!data || typeof data !== "object") return points;
    const start = Number(data.start);
    if (!Number.isFinite(start) || start <= 0) return points;
    Object.keys(data).forEach((key) => {
      const match = /^t(\d{1,3})$/.exec(key);
      if (!match) return;
      const slot = Number(match[1]);
      const value = Number(data[key]);
      if (slot < 0 || slot >= spec.slots || !Number.isFinite(value) || value <= 0) return;
      points.push({ t: start + slot * spec.stepMs, v: value });
    });
    return points;
  }

  function createHistoryRecorder(options = {}) {
    const getDb = options.getDb;
    const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
    const failures = { fine: 0, coarse: 0 };
    const warned = { fine: false, coarse: false };

    function notify() {
      try { onChange({ ...failures }); } catch (error) { console.warn("Історія курсів:", error); }
    }

    function writePoint(db, kind, write, countFailure) {
      let request;
      try {
        request = db.collection(COLLECTION).doc(write.id).set(write.data, { merge: true });
      } catch (error) {
        if (countFailure) fail(kind, error);
        return;
      }

      Promise.resolve(request).then(() => {
        if (countFailure && failures[kind] !== 0) {
          failures[kind] = 0;
          warned[kind] = false;
          notify();
        }
      }).catch((error) => {
        if (countFailure) fail(kind, error);
      });
    }

    function fail(kind, error) {
      failures[kind] += 1;
      if (!warned[kind]) {
        warned[kind] = true;
        console.warn("Не вдалося записати історію курсу:", error);
      }
      notify();
    }

    function recordTick(currency, tick) {
      if (!CURRENCIES.includes(currency) || !tick) return;
      if (!Number.isFinite(tick.now) || !(Number(tick.price) > 0)) return;
      const db = getDb && getDb();
      if (!db) return;

      ["fine", "coarse"].forEach((kind) => {
        if (!startsNewStep(kind, tick.previousAt, tick.now)) return;
        writePoint(db, kind, buildPointWrite(kind, currency, tick.now, tick.price), true);

        // Preserve the last known rate at the start of a long idle interval.
        const gapAnchor = buildGapAnchorWrite(kind, currency, tick);
        if (gapAnchor) writePoint(db, kind, gapAnchor, false);
      });
    }

    function reset() {
      failures.fine = 0;
      failures.coarse = 0;
      warned.fine = false;
      warned.coarse = false;
      notify();
    }

    return {
      recordTick,
      getWriteFailures: () => ({ ...failures }),
      hasRepeatedWriteFailure: () => failures.fine >= WRITE_FAILURE_LIMIT || failures.coarse >= WRITE_FAILURE_LIMIT,
      reset
    };
  }

  return {
    COLLECTION, KINDS, RETENTION_MS, WRITE_FAILURE_LIMIT,
    bucketIndex, docId, slotOf, startsNewStep, buildPointWrite, buildGapAnchorWrite, parseDocument,
    createHistoryRecorder
  };
});

