"use strict";

/*
 * Exchange chart: one shared chart with the CRYP and Blue rate history.
 *
 * Storage (Cloud Firestore, collection "marketHistory", shared by all players):
 *  - fine docs   "h-<cur>-<hourIndex>": one point per 30 s, up to 120 points per UTC hour (1-hour chart)
 *  - coarse docs "d-<cur>-<dayIndex>":  one point per 5 min, up to 288 points per UTC day (24-hour chart)
 * A point is a top-level field "t<slot>" holding the rate. It is written by the client whose transaction
 * has just advanced the shared rate, only when that tick is the first one in a new 30 s / 5 min step.
 * The chart only reads and displays this history; it never changes the rates themselves.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CrypChart = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const COLLECTION = "marketHistory";
  const CURRENCIES = ["cryp", "blue"];
  const NAMES = { cryp: "CRYP", blue: "Blue" };
  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const KINDS = {
    fine: { prefix: "h", bucketMs: HOUR_MS, stepMs: 30000, slots: 120 },
    coarse: { prefix: "d", bucketMs: DAY_MS, stepMs: 300000, slots: 288 }
  };
  const PERIODS = {
    "1h": { ms: HOUR_MS, kind: "fine" },
    "24h": { ms: DAY_MS, kind: "coarse" }
  };
  // Documents are kept longer than the 24 h the chart needs; an optional Firestore TTL policy on "expireAt" removes them.
  const RETENTION_MS = 3 * DAY_MS;
  const MAX_CHART_POINTS = 300;
  const COARSE_REFRESH_MS = 300000;

  // ---------- Pure helpers (covered by tests) ----------

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

  // True when this rate tick is the first one in a new storage step compared with the previous tick.
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

  function parseDocument(kind, data) {
    const spec = KINDS[kind];
    const points = [];
    if (!data || typeof data !== "object") return points;
    const start = Number(data.start);
    if (!Number.isFinite(start) || start <= 0) return points;
    for (const key of Object.keys(data)) {
      const match = /^t(\d{1,3})$/.exec(key);
      if (!match) continue;
      const slot = Number(match[1]);
      const value = Number(data[key]);
      if (slot >= spec.slots || !Number.isFinite(value) || value <= 0) continue;
      points.push({ t: start + slot * spec.stepMs, v: value });
    }
    return points;
  }

  function selectWindow(map, nowMs, periodMs) {
    const from = nowMs - periodMs;
    const points = [];
    map.forEach((value, t) => {
      if (t >= from && t <= nowMs + 60000) points.push({ t, v: value });
    });
    return points.sort((a, b) => a.t - b.t);
  }

  function limitPoints(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const stride = Math.ceil(points.length / maxPoints);
    const reduced = points.filter((_, index) => index % stride === 0);
    const last = points[points.length - 1];
    if (reduced[reduced.length - 1] !== last) reduced.push(last);
    return reduced;
  }

  // Series for one currency: stored points of the period plus the current live rate as the last point.
  function buildSeries(map, live, periodKey, nowMs) {
    const points = selectWindow(map, nowMs, PERIODS[periodKey].ms);
    if (live && Number.isFinite(live.price) && live.price > 0) {
      const lastT = points.length ? points[points.length - 1].t : -Infinity;
      points.push({ t: Math.max(nowMs, lastT + 1), v: live.price });
    }
    return limitPoints(points, MAX_CHART_POINTS);
  }

  // (current - start) / start * 100, where start is the first point of the selected period.
  function toPercent(points) {
    if (!points.length) return [];
    const base = points[0].v;
    if (!(base > 0)) return points.map((p) => ({ t: p.t, v: 0 }));
    return points.map((p) => ({ t: p.t, v: (p.v - base) / base * 100 }));
  }

  function periodChangePercent(points) {
    if (points.length < 2 || !(points[0].v > 0)) return null;
    return (points[points.length - 1].v - points[0].v) / points[0].v * 100;
  }

  function buildModel(maps, live, periodKey, mode, nowMs) {
    const raw = {};
    const series = {};
    const changes = {};
    let tMin = Infinity;
    CURRENCIES.forEach((cur) => {
      raw[cur] = buildSeries(maps[PERIODS[periodKey].kind][cur], live[cur], periodKey, nowMs);
      changes[cur] = periodChangePercent(raw[cur]);
      series[cur] = mode === "percent" ? toPercent(raw[cur]) : raw[cur];
      if (raw[cur].length) tMin = Math.min(tMin, raw[cur][0].t);
    });
    const tMax = nowMs;
    // A short history fills the whole width instead of leaving an empty left part.
    tMin = Number.isFinite(tMin) ? Math.max(nowMs - PERIODS[periodKey].ms, Math.min(tMin, tMax - 1)) : nowMs - PERIODS[periodKey].ms;
    let yMin = Infinity;
    let yMax = -Infinity;
    CURRENCIES.forEach((cur) => series[cur].forEach((p) => {
      if (p.v < yMin) yMin = p.v;
      if (p.v > yMax) yMax = p.v;
    }));
    if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
    if (mode === "percent") { yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0); }
    if (yMax - yMin < 1e-9) { yMin -= 0.5; yMax += 0.5; }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad;
    yMax += pad;
    if (mode !== "percent") yMin = Math.max(0, yMin);
    return { series, raw, changes, tMin, tMax, yMin, yMax, mode, periodKey };
  }

  function niceTicks(min, max, count) {
    const span = max - min;
    if (!(span > 0)) return [min];
    const rough = span / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) || 10 * magnitude;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
  }

  function formatMoney(value) {
    return value.toFixed(2).replace(".", ",") + " ₴";
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

  function valueAt(points, t) {
    let best = null;
    for (const p of points) {
      if (p.t <= t) best = p;
      else break;
    }
    return best;
  }

  // ---------- Controller: Firestore wiring and SVG rendering ----------

  function create(options) {
    const doc = options.document;
    const getDb = options.getDb;
    const maps = {
      fine: { cryp: new Map(), blue: new Map() },
      coarse: { cryp: new Map(), blue: new Map() }
    };
    const live = { cryp: null, blue: null };
    let period = "1h";
    let mode = "price";
    let visible = false;
    let unsubscribers = [];
    let subscribedHour = null;
    let lastCoarseFetchAt = 0;
    let renderQueued = false;
    let historyError = false;
    let warned = false;
    let hoverX = null;

    const $ = (id) => doc.getElementById(id);
    const canvas = $("chartCanvas");
    const statusEl = $("chartStatus");
    const readoutEl = $("chartReadout");

    function ingest(kind, currency, data) {
      const store = maps[kind][currency];
      parseDocument(kind, data).forEach((p) => store.set(p.t, p.v));
      // Drop points older than the retention needed by the chart.
      const oldest = Date.now() - DAY_MS - 2 * HOUR_MS;
      store.forEach((_, t) => { if (t < oldest) store.delete(t); });
    }

    function warnOnce(error) {
      historyError = true;
      if (!warned) {
        warned = true;
        console.warn("Історія курсів недоступна:", error);
      }
      scheduleRender();
    }

    function unsubscribeAll() {
      unsubscribers.forEach((fn) => { try { fn(); } catch (error) { /* already closed */ } });
      unsubscribers = [];
      subscribedHour = null;
    }

    // Live listener on the current hour (2 docs) plus a single read of the previous hour, only while the Exchange is open.
    function subscribeFine(nowMs) {
      const db = getDb();
      if (!db) return;
      const hour = bucketIndex("fine", nowMs);
      if (subscribedHour === hour) return;
      unsubscribeAll();
      subscribedHour = hour;
      CURRENCIES.forEach((cur) => {
        const current = db.collection(COLLECTION).doc(docId("fine", cur, hour));
        unsubscribers.push(current.onSnapshot((snapshot) => {
          if (snapshot.exists) ingest("fine", cur, snapshot.data());
          historyError = false;
          scheduleRender();
        }, warnOnce));
        const previous = db.collection(COLLECTION).doc(docId("fine", cur, hour - 1));
        if (typeof previous.get === "function") {
          previous.get().then((snapshot) => {
            if (snapshot.exists) ingest("fine", cur, snapshot.data());
            scheduleRender();
          }).catch(warnOnce);
        }
      });
    }

    function loadCoarse(nowMs) {
      const db = getDb();
      if (!db) return;
      lastCoarseFetchAt = nowMs;
      const day = bucketIndex("coarse", nowMs);
      CURRENCIES.forEach((cur) => {
        [day, day - 1].forEach((index) => {
          const ref = db.collection(COLLECTION).doc(docId("coarse", cur, index));
          if (typeof ref.get !== "function") return;
          ref.get().then((snapshot) => {
            if (snapshot.exists) ingest("coarse", cur, snapshot.data());
            historyError = false;
            scheduleRender();
          }).catch(warnOnce);
        });
      });
    }

    // Called by the game once a second: hour rollover for the live listener and a 5-minute refresh for the 24 h chart.
    function tick(nowMs) {
      if (!visible) return;
      subscribeFine(nowMs);
      if (period === "24h" && nowMs - lastCoarseFetchAt >= COARSE_REFRESH_MS) loadCoarse(nowMs);
    }

    function setVisible(value) {
      if (value === visible) return;
      visible = value;
      if (visible) {
        const nowMs = Date.now();
        subscribeFine(nowMs);
        if (period === "24h") loadCoarse(nowMs);
        scheduleRender();
      } else {
        unsubscribeAll();
      }
    }

    function setLiveRate(currency, price, at) {
      if (!CURRENCIES.includes(currency) || !Number.isFinite(price)) return;
      live[currency] = { price, at: at || Date.now() };
      if (visible) scheduleRender();
    }

    // Called by the game right after a successful rate transaction; failures never affect the rate.
    function recordTick(currency, tick) {
      const db = getDb();
      if (!db || !tick) return;
      ["fine", "coarse"].forEach((kind) => {
        if (!startsNewStep(kind, tick.previousAt, tick.now)) return;
        const write = buildPointWrite(kind, currency, tick.now, tick.price);
        db.collection(COLLECTION).doc(write.id).set(write.data, { merge: true }).catch((error) => {
          if (!warned) {
            warned = true;
            console.warn("Не вдалося записати історію курсу:", error);
          }
        });
      });
    }

    function stop() {
      unsubscribeAll();
      visible = false;
      Object.values(maps).forEach((byCur) => CURRENCIES.forEach((cur) => byCur[cur].clear()));
      live.cryp = null;
      live.blue = null;
      lastCoarseFetchAt = 0;
      historyError = false;
    }

    function scheduleRender() {
      if (renderQueued || !visible) return;
      renderQueued = true;
      setTimeout(() => {
        renderQueued = false;
        render();
      }, 0);
    }

    function svgEl(name, attrs, text) {
      const node = doc.createElementNS("http://www.w3.org/2000/svg", name);
      Object.keys(attrs || {}).forEach((key) => node.setAttribute(key, attrs[key]));
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function updateControls() {
      doc.querySelectorAll("[data-chart-period]").forEach((button) => {
        button.setAttribute("aria-pressed", button.dataset.chartPeriod === period ? "true" : "false");
        button.classList.toggle("active", button.dataset.chartPeriod === period);
      });
      doc.querySelectorAll("[data-chart-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", button.dataset.chartMode === mode ? "true" : "false");
        button.classList.toggle("active", button.dataset.chartMode === mode);
      });
    }

    function render() {
      if (!canvas) return;
      const nowMs = Date.now();
      const model = buildModel(maps, live, period, mode, nowMs);
      updateControls();

      CURRENCIES.forEach((cur) => {
        const rateEl = $(cur === "cryp" ? "chartCrypRate" : "chartBlueRate");
        const changeEl = $(cur === "cryp" ? "chartCrypChange" : "chartBlueChange");
        if (rateEl) rateEl.textContent = live[cur] ? formatMoney(live[cur].price) : "—";
        if (changeEl) changeEl.textContent = model.changes[cur] === null ? "" : "за " + (period === "1h" ? "годину" : "добу") + ": " + formatPercent(model.changes[cur]);
      });

      const pointCount = Math.max(model.raw.cryp.length, model.raw.blue.length);
      if (statusEl) {
        statusEl.textContent = historyError
          ? "Історія курсів недоступна — перевір правила Firestore."
          : pointCount < 3 ? "Історія ще накопичується: графік поповнюється разом зі зміною курсу." : "";
      }

      const width = Math.max(260, Math.floor(canvas.clientWidth || 320));
      const height = width < 480 ? 210 : 250;
      const margin = { left: 50, right: 12, top: 10, bottom: 24 };
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;
      const x = (t) => margin.left + (t - model.tMin) / Math.max(1, model.tMax - model.tMin) * plotW;
      const y = (v) => margin.top + (1 - (v - model.yMin) / (model.yMax - model.yMin)) * plotH;

      const svg = svgEl("svg", {
        viewBox: "0 0 " + width + " " + height,
        width: "100%",
        height: String(height),
        role: "img",
        "aria-label": "Графік курсів CRYP і Blue"
      });

      niceTicks(model.yMin, model.yMax, height < 230 ? 3 : 4).forEach((tick) => {
        const zero = mode === "percent" && Math.abs(tick) < 1e-9;
        svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: zero ? "chart-grid chart-zero" : "chart-grid" }));
        svg.appendChild(svgEl("text", { x: margin.left - 6, y: y(tick) + 4, "text-anchor": "end", class: "chart-axis-label" },
          mode === "percent" ? formatPercent(tick, Math.abs(tick) < 10 ? 1 : 0) : tick.toFixed(tick % 1 === 0 ? 0 : 1).replace(".", ",")));
      });

      [0, 0.5, 1].forEach((fraction) => {
        const t = model.tMin + (model.tMax - model.tMin) * fraction;
        svg.appendChild(svgEl("text", { x: margin.left + plotW * fraction, y: height - 6, "text-anchor": fraction === 0 ? "start" : fraction === 1 ? "end" : "middle", class: "chart-axis-label" }, formatTime(t)));
      });

      CURRENCIES.forEach((cur) => {
        const points = model.series[cur];
        if (!points.length) return;
        const path = points.map((p, index) => (index ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
        svg.appendChild(svgEl("path", { d: path, class: "chart-line chart-line-" + cur, fill: "none" }));
        const last = points[points.length - 1];
        svg.appendChild(svgEl("circle", { cx: x(last.t), cy: y(last.v), r: 3.5, class: "chart-dot chart-dot-" + cur }));
      });

      let hoverTime = null;
      if (hoverX !== null) {
        const clamped = Math.max(margin.left, Math.min(width - margin.right, hoverX));
        hoverTime = model.tMin + (clamped - margin.left) / plotW * (model.tMax - model.tMin);
        svg.appendChild(svgEl("line", { x1: clamped, x2: clamped, y1: margin.top, y2: margin.top + plotH, class: "chart-cursor" }));
        CURRENCIES.forEach((cur) => {
          const p = valueAt(model.series[cur], hoverTime);
          if (p) svg.appendChild(svgEl("circle", { cx: x(p.t), cy: y(p.v), r: 3, class: "chart-dot chart-dot-" + cur }));
        });
      }

      const move = (event) => {
        const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, width };
        hoverX = (event.clientX - rect.left) * (width / (rect.width || width));
        scheduleRender();
      };
      const leave = () => { hoverX = null; scheduleRender(); };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerdown", move);
      svg.addEventListener("pointerleave", leave);

      canvas.replaceChildren(svg);

      if (readoutEl) {
        if (hoverTime === null) {
          readoutEl.textContent = "";
        } else {
          const parts = [formatTime(hoverTime)];
          CURRENCIES.forEach((cur) => {
            const p = valueAt(model.series[cur], hoverTime);
            if (!p) return;
            const rawPoint = valueAt(model.raw[cur], hoverTime);
            parts.push(NAMES[cur] + " " + (mode === "percent" ? formatPercent(p.v, 2) + (rawPoint ? " (" + formatMoney(rawPoint.v) + ")" : "") : formatMoney(p.v)));
          });
          readoutEl.textContent = parts.join(" · ");
        }
      }
    }

    function bindControls() {
      doc.querySelectorAll("[data-chart-period]").forEach((button) => {
        button.addEventListener("click", () => {
          period = PERIODS[button.dataset.chartPeriod] ? button.dataset.chartPeriod : "1h";
          hoverX = null;
          if (visible && period === "24h") loadCoarse(Date.now());
          scheduleRender();
        });
      });
      doc.querySelectorAll("[data-chart-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          mode = button.dataset.chartMode === "percent" ? "percent" : "price";
          scheduleRender();
        });
      });
    }

    bindControls();
    return { setVisible, setLiveRate, recordTick, tick, stop, render: () => { if (visible) render(); }, _maps: maps };
  }

  return {
    COLLECTION, KINDS, PERIODS, RETENTION_MS, MAX_CHART_POINTS,
    bucketIndex, docId, slotOf, startsNewStep, buildPointWrite, parseDocument,
    selectWindow, limitPoints, buildSeries, toPercent, periodChangePercent, buildModel,
    niceTicks, formatMoney, formatPercent, create
  };
});
