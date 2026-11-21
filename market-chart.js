"use strict";

/*
 * Exchange chart display. Firestore history writes live in market-history.js so hiding this page
 * can only stop chart reads and drawing; it cannot stop recording rate changes.
 */
(function (root, factory) {
  const history = typeof module === "object" && module.exports
    ? require("./market-history.js")
    : root && root.CrypMarketHistory;
  const api = factory(history);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CrypChart = api;
})(typeof window !== "undefined" ? window : globalThis, function (history) {
  if (!history) throw new Error("market-history.js must load before market-chart.js");

  const COLLECTION = history.COLLECTION;
  const KINDS = history.KINDS;
  const CURRENCIES = ["cryp", "blue"];
  const NAMES = { cryp: "CRYP", blue: "Blue" };
  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const MAX_CHART_POINTS = 800;
  const GAP_STEPS = 3;
  const PERIODS = {
    "1h": { ms: HOUR_MS, kind: "fine" },
    "24h": { ms: DAY_MS, kind: "coarse" }
  };
  const PERIOD_OF_KIND = { fine: "1h", coarse: "24h" };

  const {
    bucketIndex, docId, slotOf, startsNewStep, buildPointWrite, buildGapAnchorWrite, parseDocument
  } = history;

  function selectWindow(map, nowMs, periodMs) {
    const from = nowMs - periodMs;
    const points = [];
    map.forEach((value, time) => {
      if (time >= from && time <= nowMs + 60000) points.push({ t: time, v: value });
    });
    return points.sort((a, b) => a.t - b.t);
  }

  function windowAnchor(map, extra, from) {
    let best = null;
    map.forEach((value, time) => {
      if (time < from && (!best || time > best.t)) best = { t: time, v: value };
    });
    if (extra && extra.t < from && (!best || extra.t > best.t)) best = extra;
    return best;
  }

  function fillGaps(points, gapMs) {
    const result = [];
    points.forEach((point, index) => {
      if (index > 0 && point.t - points[index - 1].t > gapMs) {
        result.push({ t: point.t - 1, v: points[index - 1].v });
      }
      result.push(point);
    });
    return result;
  }

  function limitPoints(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const stride = Math.ceil(points.length / maxPoints);
    const reduced = points.filter((_, index) => index % stride === 0);
    const last = points[points.length - 1];
    if (reduced[reduced.length - 1] !== last) reduced.push(last);
    return reduced;
  }

  function buildSeries(map, live, periodKey, nowMs, extraAnchor) {
    const period = PERIODS[periodKey] || PERIODS["1h"];
    const from = nowMs - period.ms;
    const gapMs = GAP_STEPS * KINDS[period.kind].stepMs;
    const points = selectWindow(map, nowMs, period.ms);
    const hasLive = Boolean(live) && Number.isFinite(live.price) && live.price > 0;

    let anchor = null;
    if (hasLive && !points.length && Number.isFinite(live.at) && live.at < from) {
      anchor = { t: live.at, v: live.price };
    } else {
      anchor = windowAnchor(map, extraAnchor, from);
    }
    if (anchor && (!points.length || points[0].t - from > gapMs)) {
      points.unshift({ t: from, v: anchor.v });
    }

    if (hasLive) {
      const lastTime = points.length ? points[points.length - 1].t : -Infinity;
      if (Number.isFinite(live.at) && live.at > lastTime && live.at < nowMs) {
        points.push({ t: live.at, v: live.price });
      }
      const tailTime = points.length ? points[points.length - 1].t : -Infinity;
      points.push({ t: Math.max(nowMs, tailTime + 1), v: live.price });
    }

    return limitPoints(fillGaps(points, gapMs), MAX_CHART_POINTS);
  }

  function toPercent(points) {
    if (!points.length) return [];
    const base = points[0].v;
    if (!(base > 0)) return points.map((point) => ({ t: point.t, v: 0 }));
    return points.map((point) => ({ t: point.t, v: (point.v - base) / base * 100 }));
  }

  function periodChangePercent(points) {
    if (points.length < 2 || !(points[0].v > 0)) return null;
    return (points[points.length - 1].v - points[0].v) / points[0].v * 100;
  }

  function buildModel(maps, live, periodKey, mode, nowMs, anchors) {
    const selectedPeriod = PERIODS[periodKey] || PERIODS["1h"];
    const actualMode = mode === "percent" ? "percent" : "price";
    const raw = {};
    const series = {};
    const changes = {};

    CURRENCIES.forEach((currency) => {
      const kind = selectedPeriod.kind;
      const kindAnchors = anchors && anchors[kind];
      raw[currency] = buildSeries(
        maps[kind][currency],
        live[currency],
        periodKey,
        nowMs,
        kindAnchors ? kindAnchors[currency] : null
      );
      changes[currency] = periodChangePercent(raw[currency]);
      series[currency] = actualMode === "percent" ? toPercent(raw[currency]) : raw[currency];
    });

    let yMin = Infinity;
    let yMax = -Infinity;
    CURRENCIES.forEach((currency) => series[currency].forEach((point) => {
      yMin = Math.min(yMin, point.v);
      yMax = Math.max(yMax, point.v);
    }));
    if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
    if (actualMode === "percent") { yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0); }
    if (yMax - yMin < 1e-9) { yMin -= 0.5; yMax += 0.5; }
    const padding = (yMax - yMin) * 0.08;
    yMin -= padding;
    yMax += padding;
    if (actualMode !== "percent") yMin = Math.max(0, yMin);

    const tMax = nowMs;
    return {
      series, raw, changes,
      tMin: nowMs - selectedPeriod.ms,
      tMax, yMin, yMax, mode: actualMode, periodKey
    };
  }

  function niceTicks(min, max, count) {
    const span = max - min;
    if (!(span > 0)) return [min];
    const roughStep = span / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const step = [1, 2, 2.5, 5, 10].map((multiplier) => multiplier * magnitude).find((value) => value >= roughStep) || 10 * magnitude;
    const ticks = [];
    for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
      ticks.push(Number(value.toFixed(10)));
    }
    return ticks;
  }

  function formatMoney(value) {
    return Number(value).toFixed(2).replace(".", ",") + " ₴";
  }

  function formatPercent(value, digits = 1) {
    if (value === null || !Number.isFinite(value)) return "—";
    const rounded = Number(value.toFixed(digits));
    return (rounded > 0 ? "+" : "") + rounded.toFixed(digits).replace(".", ",") + "%";
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatTime(ms) {
    const date = new Date(ms);
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  function formatTimeSeconds(ms) {
    const date = new Date(ms);
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
  }

  function timeTicks(min, max, periodMs) {
    const step = periodMs <= HOUR_MS ? 600000 : 3 * HOUR_MS;
    const offset = -new Date(min).getTimezoneOffset() * 60000;
    const ticks = [];
    for (let time = Math.ceil((min + offset) / step) * step - offset; time <= max; time += step) ticks.push(time);
    return ticks;
  }

  function valueAt(points, time) {
    let best = null;
    for (const point of points) {
      if (point.t <= time) best = point;
      else break;
    }
    return best;
  }

  function create(options) {
    const doc = options.document;
    const getDb = options.getDb;
    const historyRecorder = options.historyRecorder || history.createHistoryRecorder({ getDb, onChange: scheduleRender });
    const maps = {
      fine: { cryp: new Map(), blue: new Map() },
      coarse: { cryp: new Map(), blue: new Map() }
    };
    const live = { cryp: null, blue: null };
    const anchors = { fine: { cryp: null, blue: null }, coarse: { cryp: null, blue: null } };
    const anchorRequested = { fine: { cryp: null, blue: null }, coarse: { cryp: null, blue: null } };

    let period = "1h";
    let mode = "price";
    let visible = false;
    let readError = false;
    let readErrorLogged = false;
    let renderQueued = false;
    let hoverX = null;
    let subscribedKey = null;
    let subscriptionGeneration = 0;
    let lastRenderBucket = -1;
    let unsubscribeFns = [];

    const $ = (id) => doc.getElementById(id);
    const canvas = $("chartCanvas");
    const statusEl = $("chartStatus");
    const readoutEl = $("chartReadout");

    function ingest(kind, currency, data) {
      const store = maps[kind][currency];
      parseDocument(kind, data).forEach((point) => store.set(point.t, point.v));
      const oldest = Date.now() - history.RETENTION_MS;
      store.forEach((_, time) => { if (time < oldest) store.delete(time); });
    }

    function setReadError(error) {
      readError = true;
      if (!readErrorLogged) {
        readErrorLogged = true;
        console.warn("Історія курсів недоступна:", error);
      }
      scheduleRender();
    }

    function clearSubscriptions() {
      subscriptionGeneration += 1;
      unsubscribeFns.forEach((unsubscribe) => {
        try { unsubscribe(); } catch (error) { /* listener already closed */ }
      });
      unsubscribeFns = [];
      subscribedKey = null;
    }

    function ensureAnchor(kind, currency, nowMs, generation) {
      const db = getDb && getDb();
      const fieldPath = options.documentId ? options.documentId() : null;
      if (!db || !fieldPath) return;

      const from = nowMs - PERIODS[PERIOD_OF_KIND[kind]].ms;
      for (const time of maps[kind][currency].keys()) if (time < from) return;

      const loadedBucket = bucketIndex(kind, nowMs) - 1;
      if (anchorRequested[kind][currency] === loadedBucket) return;
      anchorRequested[kind][currency] = loadedBucket;

      const prefix = KINDS[kind].prefix + "-" + currency + "-";
      const earliestLoaded = docId(kind, currency, loadedBucket);
      try {
        db.collection(COLLECTION)
          .where(fieldPath, ">=", prefix)
          .where(fieldPath, "<", earliestLoaded)
          .orderBy(fieldPath, "desc")
          .limit(1)
          .get()
          .then((result) => {
            if (generation !== subscriptionGeneration || !visible) return;
            result.forEach((snapshot) => {
              const points = parseDocument(kind, snapshot.data()).sort((a, b) => a.t - b.t);
              if (points.length) anchors[kind][currency] = points[points.length - 1];
            });
            scheduleRender();
          })
          .catch((error) => {
            if (generation === subscriptionGeneration) setReadError(error);
            anchorRequested[kind][currency] = null;
          });
      } catch (error) {
        anchorRequested[kind][currency] = null;
        setReadError(error);
      }
    }

    function subscribePeriod(nowMs) {
      const db = getDb && getDb();
      if (!db) return;
      const kind = PERIODS[period].kind;
      const bucket = bucketIndex(kind, nowMs);
      const key = kind + ":" + bucket;
      if (subscribedKey === key) return;

      clearSubscriptions();
      subscribedKey = key;
      const generation = subscriptionGeneration;

      CURRENCIES.forEach((currency) => {
        try {
          const current = db.collection(COLLECTION).doc(docId(kind, currency, bucket));
          unsubscribeFns.push(current.onSnapshot((snapshot) => {
            if (generation !== subscriptionGeneration || !visible) return;
            if (snapshot.exists) ingest(kind, currency, snapshot.data());
            readError = false;
            scheduleRender();
          }, setReadError));

          const previous = db.collection(COLLECTION).doc(docId(kind, currency, bucket - 1));
          if (typeof previous.get === "function") {
            previous.get().then((snapshot) => {
              if (generation !== subscriptionGeneration || !visible) return;
              if (snapshot.exists) ingest(kind, currency, snapshot.data());
              readError = false;
              ensureAnchor(kind, currency, nowMs, generation);
              scheduleRender();
            }).catch((error) => {
              if (generation === subscriptionGeneration) setReadError(error);
            });
          }
        } catch (error) {
          setReadError(error);
        }
      });
    }

    function scheduleRender() {
      if (!visible || renderQueued) return;
      renderQueued = true;
      setTimeout(() => {
        renderQueued = false;
        if (visible) render();
      }, 0);
    }

    function tick(nowMs) {
      if (!visible) return;
      subscribePeriod(nowMs);
      const bucket = Math.floor(nowMs / 5000);
      if (bucket !== lastRenderBucket) scheduleRender();
    }

    function setVisible(value) {
      if (value === visible) return;
      visible = value;
      if (visible) {
        const nowMs = Date.now();
        subscribePeriod(nowMs);
        scheduleRender();
      } else {
        clearSubscriptions();
        hoverX = null;
      }
    }

    function setLiveRate(currency, price, at) {
      if (!CURRENCIES.includes(currency) || !Number.isFinite(price) || price <= 0) return;
      live[currency] = { price, at: Number.isFinite(at) && at > 0 ? at : Date.now() };
      scheduleRender();
    }

    // Kept for existing callers/tests; the writer itself has no page visibility state.
    function recordTick(currency, tick) {
      historyRecorder.recordTick(currency, tick);
    }

    function stop() {
      clearSubscriptions();
      visible = false;
      Object.values(maps).forEach((byCurrency) => CURRENCIES.forEach((currency) => byCurrency[currency].clear()));
      Object.keys(anchors).forEach((kind) => CURRENCIES.forEach((currency) => {
        anchors[kind][currency] = null;
        anchorRequested[kind][currency] = null;
      }));
      live.cryp = null;
      live.blue = null;
      readError = false;
      readErrorLogged = false;
      hoverX = null;
      lastRenderBucket = -1;
    }

    function svgElement(name, attrs = {}, text) {
      const node = doc.createElementNS("http://www.w3.org/2000/svg", name);
      Object.keys(attrs).forEach((key) => node.setAttribute(key, attrs[key]));
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function updateControls() {
      doc.querySelectorAll("[data-chart-period]").forEach((button) => {
        const active = button.dataset.chartPeriod === period;
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.classList.toggle("active", active);
      });
      doc.querySelectorAll("[data-chart-mode]").forEach((button) => {
        const active = button.dataset.chartMode === mode;
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.classList.toggle("active", active);
      });
    }

    function render() {
      if (!canvas) return;
      const nowMs = Date.now();
      lastRenderBucket = Math.floor(nowMs / 5000);
      const model = buildModel(maps, live, period, mode, nowMs, anchors);
      updateControls();

      CURRENCIES.forEach((currency) => {
        const rateEl = $(currency === "cryp" ? "chartCrypRate" : "chartBlueRate");
        const changeEl = $(currency === "cryp" ? "chartCrypChange" : "chartBlueChange");
        if (rateEl) rateEl.textContent = live[currency] ? formatMoney(live[currency].price) : "—";
        if (!changeEl) return;
        const change = model.changes[currency];
        changeEl.textContent = change === null ? "" : "за " + (period === "1h" ? "годину" : "добу") + ": " + formatPercent(change);
        changeEl.classList.toggle("chart-up", change !== null && change > 0);
        changeEl.classList.toggle("chart-down", change !== null && change < 0);
      });

      const pointCount = Math.max(model.raw.cryp.length, model.raw.blue.length);
      const failures = historyRecorder.getWriteFailures ? historyRecorder.getWriteFailures() : { fine: 0, coarse: 0 };
      const writeErrors = historyRecorder.getWriteErrors ? historyRecorder.getWriteErrors() : { fine: "", coarse: "" };
      const failingKind = failures.fine >= history.WRITE_FAILURE_LIMIT ? "fine"
        : failures.coarse >= history.WRITE_FAILURE_LIMIT ? "coarse" : null;
      const writeErrorCode = failingKind ? writeErrors[failingKind] : "";
      const writeFailing = failingKind !== null;
      if (statusEl) {
        statusEl.textContent = readError
          ? "Історія курсів недоступна — перевір підключення та правила Firestore."
          : writeFailing
            ? "Нові точки історії не записуються (Firestore: " + (writeErrorCode || "unknown") + ")."
            : pointCount < 3 ? "Історія накопичується разом зі зміною курсу." : "";
      }

      const width = Math.max(260, Math.floor(canvas.clientWidth || 320));
      const height = width < 480 ? 240 : 290;
      const margin = { left: 48, right: 12, top: 14, bottom: 28 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const x = (time) => margin.left + (time - model.tMin) / Math.max(1, model.tMax - model.tMin) * plotWidth;
      const y = (value) => margin.top + (1 - (value - model.yMin) / (model.yMax - model.yMin)) * plotHeight;

      const svg = svgElement("svg", {
        viewBox: "0 0 " + width + " " + height,
        width: "100%",
        height: String(height),
        role: "img",
        "aria-label": "Графік курсів CRYP і Blue"
      });

      niceTicks(model.yMin, model.yMax, 4).forEach((value) => {
        const zero = mode === "percent" && Math.abs(value) < 1e-9;
        svg.appendChild(svgElement("line", {
          x1: margin.left, x2: width - margin.right,
          y1: y(value), y2: y(value),
          class: zero ? "chart-grid chart-zero" : "chart-grid"
        }));
        svg.appendChild(svgElement("text", {
          x: margin.left - 7, y: y(value) + 4, "text-anchor": "end", class: "chart-axis-label"
        }, mode === "percent" ? formatPercent(value, Math.abs(value) < 10 ? 1 : 0) : value.toFixed(value % 1 === 0 ? 0 : 1).replace(".", ",")));
      });

      timeTicks(model.tMin, model.tMax, PERIODS[period].ms).forEach((time) => {
        const tx = x(time);
        if (tx < margin.left + 14 || tx > width - margin.right - 14) return;
        svg.appendChild(svgElement("line", {
          x1: tx, x2: tx, y1: margin.top, y2: margin.top + plotHeight,
          class: "chart-grid chart-grid-v"
        }));
        svg.appendChild(svgElement("text", {
          x: tx, y: height - 8, "text-anchor": "middle", class: "chart-axis-label"
        }, formatTime(time)));
      });
      svg.appendChild(svgElement("text", {
        x: margin.left - 7, y: margin.top - 3, "text-anchor": "end", class: "chart-axis-unit"
      }, mode === "percent" ? "%" : "₴"));

      CURRENCIES.forEach((currency) => {
        const points = model.series[currency];
        if (!points.length) return;
        const path = points.map((point, index) =>
          (index ? "L" : "M") + x(point.t).toFixed(1) + " " + y(point.v).toFixed(1)
        ).join(" ");
        svg.appendChild(svgElement("path", {
          d: path, class: "chart-line chart-line-" + currency, fill: "none"
        }));
        const last = points[points.length - 1];
        svg.appendChild(svgElement("circle", {
          cx: x(last.t), cy: y(last.v), r: 6, class: "chart-pulse chart-pulse-" + currency
        }));
        svg.appendChild(svgElement("circle", {
          cx: x(last.t), cy: y(last.v), r: 3.5, class: "chart-dot chart-dot-" + currency
        }));
      });

      let hoverTime = null;
      if (hoverX !== null) {
        const clampedX = Math.max(margin.left, Math.min(width - margin.right, hoverX));
        hoverTime = model.tMin + (clampedX - margin.left) / plotWidth * (model.tMax - model.tMin);
        svg.appendChild(svgElement("line", {
          x1: clampedX, x2: clampedX, y1: margin.top, y2: margin.top + plotHeight, class: "chart-cursor"
        }));
      }
      const move = (event) => {
        const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, width };
        hoverX = (event.clientX - rect.left) * (width / (rect.width || width));
        scheduleRender();
      };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerdown", move);
      svg.addEventListener("pointerleave", () => { hoverX = null; scheduleRender(); });
      canvas.replaceChildren(svg);

      if (readoutEl) {
        if (hoverTime === null) {
          readoutEl.textContent = "";
        } else {
          const values = [formatTime(hoverTime)];
          CURRENCIES.forEach((currency) => {
            const point = valueAt(model.series[currency], hoverTime);
            if (!point) return;
            const rawPoint = valueAt(model.raw[currency], hoverTime);
            const value = mode === "percent"
              ? formatPercent(point.v, 2) + (rawPoint ? " (" + formatMoney(rawPoint.v) + ")" : "")
              : formatMoney(point.v);
            values.push(NAMES[currency] + " " + value);
          });
          readoutEl.textContent = values.join(" · ");
        }
      }
    }

    function bindControls() {
      doc.querySelectorAll("[data-chart-period]").forEach((button) => {
        button.addEventListener("click", () => {
          period = PERIODS[button.dataset.chartPeriod] ? button.dataset.chartPeriod : "1h";
          hoverX = null;
          if (visible) subscribePeriod(Date.now());
          scheduleRender();
        });
      });
      doc.querySelectorAll("[data-chart-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          mode = button.dataset.chartMode === "percent" ? "percent" : "price";
          hoverX = null;
          scheduleRender();
        });
      });
    }

    bindControls();
    return {
      setVisible, setLiveRate, recordTick, tick, stop,
      render: () => { if (visible) render(); },
      _maps: maps, _anchors: anchors
    };
  }

  return {
    COLLECTION, KINDS, PERIODS, RETENTION_MS: history.RETENTION_MS, MAX_CHART_POINTS,
    bucketIndex, docId, slotOf, startsNewStep, buildPointWrite, buildGapAnchorWrite, parseDocument,
    selectWindow, windowAnchor, fillGaps, limitPoints, buildSeries, toPercent, periodChangePercent,
    buildModel, niceTicks, timeTicks, formatMoney, formatPercent, formatTimeSeconds, create
  };
});

