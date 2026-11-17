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
 *
 * The shared rate only moves while at least one client is in the game, so it simply holds its last value during a
 * break. The chart reflects that: a period always starts at its real start (now - period) with the rate that was in
 * force then, and a break is drawn as a flat segment instead of the line starting at the moment a player logs in.
 * To make that exact, the first tick after a break also stores the rate that was held through it ("gap anchor").
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
  // Two stored points further apart than this many storage steps mean nobody was in the game: the rate held its value.
  const GAP_STEPS = 3;
  const PERIOD_OF_KIND = { fine: "1h", coarse: "24h" };

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

  // After a break the first tick stores the rate that was held through it, at the first storage step boundary after the
  // last tick. (The last tick itself is usually not the first one of its step, so its own slot is taken or unrecorded.)
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

  // Last stored point strictly before the period start (from the loaded documents or the separately fetched anchor).
  function windowAnchor(map, extra, from) {
    let best = null;
    map.forEach((value, t) => {
      if (t < from && (!best || t > best.t)) best = { t, v: value };
    });
    if (extra && extra.t < from && (!best || extra.t > best.t)) best = extra;
    return best;
  }

  // A break between two stored points is a flat segment at the earlier value, then the step to the later one.
  function fillGaps(points, gapMs) {
    const out = [];
    points.forEach((point, index) => {
      if (index > 0 && point.t - points[index - 1].t > gapMs) out.push({ t: point.t - 1, v: points[index - 1].v });
      out.push(point);
    });
    return out;
  }

  // Series for one currency over the period [now - period, now]: the rate in force at the period start (when there was
  // a break), the stored points, the moment of the last rate change and the current live rate as the last point.
  function buildSeries(map, live, periodKey, nowMs, extraAnchor) {
    const period = PERIODS[periodKey];
    const from = nowMs - period.ms;
    const gapMs = GAP_STEPS * KINDS[period.kind].stepMs;
    const points = selectWindow(map, nowMs, period.ms);
    const hasLive = Boolean(live) && Number.isFinite(live.price) && live.price > 0;

    let anchor = null;
    if (hasLive && !points.length && Number.isFinite(live.at) && live.at < from) anchor = { t: live.at, v: live.price };
    else anchor = windowAnchor(map, extraAnchor, from);
    if (anchor && (!points.length || points[0].t - from > gapMs)) points.unshift({ t: from, v: anchor.v });

    if (hasLive) {
      const lastT = points.length ? points[points.length - 1].t : -Infinity;
      if (Number.isFinite(live.at) && live.at > lastT && live.at < nowMs) points.push({ t: live.at, v: live.price });
      const tail = points.length ? points[points.length - 1].t : -Infinity;
      points.push({ t: Math.max(nowMs, tail + 1), v: live.price });
    }
    return limitPoints(fillGaps(points, gapMs), MAX_CHART_POINTS);
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

  function buildModel(maps, live, periodKey, mode, nowMs, anchors) {
    const raw = {};
    const series = {};
    const changes = {};
    CURRENCIES.forEach((cur) => {
      const kind = PERIODS[periodKey].kind;
      raw[cur] = buildSeries(maps[kind][cur], live[cur], periodKey, nowMs, anchors && anchors[kind] ? anchors[kind][cur] : null);
      changes[cur] = periodChangePercent(raw[cur]);
      series[cur] = mode === "percent" ? toPercent(raw[cur]) : raw[cur];
    });
    // The axis always spans the real selected period, never the moment a player opened the game.
    const tMax = nowMs;
    const tMin = nowMs - PERIODS[periodKey].ms;
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
    // Last stored point before the loaded documents: where a period starts when the first loaded point comes after a break.
    const anchors = { fine: { cryp: null, blue: null }, coarse: { cryp: null, blue: null } };
    const anchorRequested = { fine: { cryp: false, blue: false }, coarse: { cryp: false, blue: false } };
    let period = "1h";
    let mode = "price";
    let visible = false;
    let unsubscribers = [];
    let subscribedHour = null;
    let coarseUnsubscribers = [];
    let subscribedDay = null;
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
      // Drop points older than the stored retention (never the ones the 24 h chart or its anchor still needs).
      const oldest = Date.now() - RETENTION_MS;
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

    function unsubscribeFine() {
      unsubscribers.forEach((fn) => { try { fn(); } catch (error) { /* already closed */ } });
      unsubscribers = [];
      subscribedHour = null;
    }

    function unsubscribeCoarse() {
      coarseUnsubscribers.forEach((fn) => { try { fn(); } catch (error) { /* already closed */ } });
      coarseUnsubscribers = [];
      subscribedDay = null;
    }

    function unsubscribeAll() {
      unsubscribeFine();
      unsubscribeCoarse();
    }

    // If no loaded point lies before the period start (a break reaches further back than the loaded documents), fetch the
    // last stored point before them once: one range query over document ids, which needs no composite index.
    // (Ids end with a number of constant length, so id order equals time order.)
    function ensureAnchor(kind, currency) {
      if (anchorRequested[kind][currency]) return;
      const db = getDb();
      const fieldPath = options.documentId ? options.documentId() : null;
      if (!db || !fieldPath) return;
      const nowMs = Date.now();
      const from = nowMs - PERIODS[PERIOD_OF_KIND[kind]].ms;
      for (const t of maps[kind][currency].keys()) if (t < from) return;
      const collection = db.collection(COLLECTION);
      if (typeof collection.where !== "function") return;
      anchorRequested[kind][currency] = true;
      const prefix = KINDS[kind].prefix + "-" + currency + "-";
      const earliestLoaded = docId(kind, currency, bucketIndex(kind, nowMs) - 1);
      collection.where(fieldPath, ">=", prefix).where(fieldPath, "<", earliestLoaded).orderBy(fieldPath, "desc").limit(1).get()
        .then((result) => {
          result.forEach((snapshot) => {
            const points = parseDocument(kind, snapshot.data()).sort((a, b) => a.t - b.t);
            if (points.length) anchors[kind][currency] = points[points.length - 1];
          });
          scheduleRender();
        })
        .catch(() => { anchorRequested[kind][currency] = false; });
    }

    // Live listener on the current hour (2 docs) plus a single read of the previous hour, only while the Exchange is open.
    function subscribeFine(nowMs) {
      const db = getDb();
      if (!db) return;
      const hour = bucketIndex("fine", nowMs);
      if (subscribedHour === hour) return;
      unsubscribeFine();
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
            ensureAnchor("fine", cur);
            scheduleRender();
          }).catch(warnOnce);
        }
      });
    }

    // 24 h chart: live listener on the current day's document plus a single read of the previous day, only while it is shown.
    function subscribeCoarse(nowMs) {
      const db = getDb();
      if (!db) return;
      const day = bucketIndex("coarse", nowMs);
      if (subscribedDay === day) return;
      unsubscribeCoarse();
      subscribedDay = day;
      CURRENCIES.forEach((cur) => {
        const current = db.collection(COLLECTION).doc(docId("coarse", cur, day));
        coarseUnsubscribers.push(current.onSnapshot((snapshot) => {
          if (snapshot.exists) ingest("coarse", cur, snapshot.data());
          historyError = false;
          scheduleRender();
        }, warnOnce));
        const previous = db.collection(COLLECTION).doc(docId("coarse", cur, day - 1));
        if (typeof previous.get === "function") {
          previous.get().then((snapshot) => {
            if (snapshot.exists) ingest("coarse", cur, snapshot.data());
            ensureAnchor("coarse", cur);
            historyError = false;
            scheduleRender();
          }).catch(warnOnce);
        }
      });
    }

    function syncPeriodSubscription(nowMs) {
      if (period === "24h") subscribeCoarse(nowMs);
      else unsubscribeCoarse();
    }

    // Called by the game once a second: hour/day rollover for the live listeners.
    function tick(nowMs) {
      if (!visible) return;
      subscribeFine(nowMs);
      syncPeriodSubscription(nowMs);
    }

    function setVisible(value) {
      if (value === visible) return;
      visible = value;
      if (visible) {
        const nowMs = Date.now();
        subscribeFine(nowMs);
        syncPeriodSubscription(nowMs);
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
        // First tick after a break: also keep the rate that was held through it. Best effort — if it cannot be
        // stored (slot taken, document too old for the rules) the chart falls back to the nearest stored point.
        const held = buildGapAnchorWrite(kind, currency, tick);
        if (held) db.collection(COLLECTION).doc(held.id).set(held.data, { merge: true }).catch(() => {});
      });
    }

    function stop() {
      unsubscribeAll();
      visible = false;
      Object.values(maps).forEach((byCur) => CURRENCIES.forEach((cur) => byCur[cur].clear()));
      Object.keys(anchors).forEach((kind) => CURRENCIES.forEach((cur) => {
        anchors[kind][cur] = null;
        anchorRequested[kind][cur] = false;
      }));
      live.cryp = null;
      live.blue = null;
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
      const model = buildModel(maps, live, period, mode, nowMs, anchors);
      updateControls();

      CURRENCIES.forEach((cur) => {
        const rateEl = $(cur === "cryp" ? "chartCrypRate" : "chartBlueRate");
        const changeEl = $(cur === "cryp" ? "chartCrypChange" : "chartBlueChange");
        if (rateEl) rateEl.textContent = live[cur] ? formatMoney(live[cur].price) : "—";
        if (changeEl) {
          changeEl.textContent = model.changes[cur] === null ? "" : "за " + (period === "1h" ? "годину" : "добу") + ": " + formatPercent(model.changes[cur]);
          changeEl.classList.toggle("chart-up", model.changes[cur] !== null && model.changes[cur] > 0);
          changeEl.classList.toggle("chart-down", model.changes[cur] !== null && model.changes[cur] < 0);
        }
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

      // Soft gradient under each line (purely decorative; the data and the line itself are unchanged).
      const defs = svgEl("defs");
      CURRENCIES.forEach((cur) => {
        const gradient = svgEl("linearGradient", { id: "chartFill-" + cur, x1: "0", y1: "0", x2: "0", y2: "1" });
        gradient.appendChild(svgEl("stop", { offset: "0%", class: "chart-fill-stop chart-fill-stop-" + cur, "stop-opacity": "0.3" }));
        gradient.appendChild(svgEl("stop", { offset: "100%", class: "chart-fill-stop chart-fill-stop-" + cur, "stop-opacity": "0" }));
        defs.appendChild(gradient);
      });
      svg.appendChild(defs);

      const baseY = margin.top + plotH;
      CURRENCIES.forEach((cur) => {
        const points = model.series[cur];
        if (points.length < 2) return;
        const line = points.map((p, index) => (index ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
        const area = line + " L" + x(points[points.length - 1].t).toFixed(1) + " " + baseY + " L" + x(points[0].t).toFixed(1) + " " + baseY + " Z";
        svg.appendChild(svgEl("path", { d: area, class: "chart-area", fill: "url(#chartFill-" + cur + ")", stroke: "none" }));
      });

      CURRENCIES.forEach((cur) => {
        const points = model.series[cur];
        if (!points.length) return;
        const path = points.map((p, index) => (index ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
        svg.appendChild(svgEl("path", { d: path, class: "chart-line chart-line-" + cur, fill: "none" }));
        const last = points[points.length - 1];
        svg.appendChild(svgEl("circle", { cx: x(last.t), cy: y(last.v), r: 6, class: "chart-pulse chart-pulse-" + cur }));
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
          if (visible) syncPeriodSubscription(Date.now());
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
    return { setVisible, setLiveRate, recordTick, tick, stop, render: () => { if (visible) render(); }, _maps: maps, _anchors: anchors };
  }

  return {
    COLLECTION, KINDS, PERIODS, RETENTION_MS, MAX_CHART_POINTS,
    bucketIndex, docId, slotOf, startsNewStep, buildPointWrite, buildGapAnchorWrite, parseDocument,
    selectWindow, windowAnchor, fillGaps, limitPoints, buildSeries, toPercent, periodChangePercent, buildModel,
    niceTicks, formatMoney, formatPercent, create
  };
});
