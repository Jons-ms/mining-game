'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const chart = require('../market-chart.js');

const HOUR = 3600000;
const DAY = 86400000;
const STEP = 30000;

test('history storage keys: hour docs hold 30 s slots, day docs hold 5 min slots', () => {
  const t = 1_700_000_000_000;
  const fine = chart.buildPointWrite('fine', 'cryp', t, 3.123456);
  assert.equal(fine.id, `h-cryp-${Math.floor(t / HOUR)}`);
  assert.equal(fine.data.start, Math.floor(t / HOUR) * HOUR);
  assert.equal(fine.data[`t${Math.floor((t % HOUR) / 30000)}`], 3.1235);
  assert.equal(fine.data.expireAt.getTime(), fine.data.start + chart.RETENTION_MS);
  const coarse = chart.buildPointWrite('coarse', 'blue', t, 9);
  assert.equal(coarse.id, `d-blue-${Math.floor(t / DAY)}`);
  assert.ok(chart.slotOf('fine', t) >= 0 && chart.slotOf('fine', t) < 120);
  assert.ok(chart.slotOf('coarse', t) >= 0 && chart.slotOf('coarse', t) < 288);
  assert.equal(chart.slotOf('fine', Math.floor(t / HOUR) * HOUR + HOUR - 1), 119);
  assert.equal(chart.slotOf('coarse', Math.floor(t / DAY) * DAY + DAY - 1), 287);
});

test('write volume: a point is stored only when a tick enters a new step', () => {
  const base = Math.floor(1_700_000_000_000 / 300000) * 300000;
  let fine = 0;
  let coarse = 0;
  let previous = base - 5000;
  for (let now = base; now < base + HOUR; now += 5000) {
    if (chart.startsNewStep('fine', previous, now)) fine += 1;
    if (chart.startsNewStep('coarse', previous, now)) coarse += 1;
    previous = now;
  }
  assert.equal(fine, 120, '120 points per hour instead of 720 rate ticks');
  assert.equal(coarse, 12, '12 points per hour for the 24 h chart');
  assert.equal(chart.startsNewStep('fine', 0, base), true);
});

test('stored documents parse back into timestamped points; junk fields are ignored', () => {
  const start = 10 * HOUR;
  const points = chart.parseDocument('fine', { cur: 'cryp', start, expireAt: new Date(), t0: 1.5, t119: 2, t120: 9, tx: 3, t5: -1, t7: 'bad' });
  assert.deepEqual(points.sort((a, b) => a.t - b.t), [
    { t: start, v: 1.5 },
    { t: start + 119 * 30000, v: 2 }
  ]);
  assert.deepEqual(chart.parseDocument('fine', null), []);
});

test('percent mode: start of the period is 0% and the spec examples hold', () => {
  const cryp = chart.toPercent([{ t: 1, v: 4 }, { t: 2, v: 5 }]);
  const blue = chart.toPercent([{ t: 1, v: 10 }, { t: 2, v: 12 }]);
  assert.equal(cryp[0].v, 0);
  assert.equal(blue[0].v, 0);
  assert.equal(cryp[1].v, 25);
  assert.ok(Math.abs(blue[1].v - 20) < 1e-9);
  assert.equal(chart.periodChangePercent([{ t: 1, v: 4 }, { t: 2, v: 5 }]), 25);
  assert.equal(chart.periodChangePercent([{ t: 1, v: 4 }]), null);
  assert.equal(chart.formatPercent(25), '+25,0%');
  assert.equal(chart.formatPercent(-3.46), '-3,5%');
});

test('model windows the data to the selected period and appends the live rate', () => {
  const now = 1_700_000_000_000;
  const maps = { fine: { cryp: new Map(), blue: new Map() }, coarse: { cryp: new Map(), blue: new Map() } };
  maps.fine.cryp.set(now - 2 * HOUR, 9);     // outside 1 h
  maps.fine.cryp.set(now - 1800000, 2);
  maps.fine.cryp.set(now - 600000, 3);
  maps.fine.blue.set(now - 1800000, 8);
  maps.coarse.cryp.set(now - 2 * DAY, 9);    // outside 24 h
  maps.coarse.cryp.set(now - 6 * HOUR, 1);
  const live = { cryp: { price: 4 }, blue: { price: 10 } };

  const hour = chart.buildModel(maps, live, '1h', 'price', now);
  const distinct = (points) => points.map((p) => p.v).filter((v, i, all) => i === 0 || v !== all[i - 1]);
  // The point from 2 h ago is not drawn at its own time; it only supplies the rate held at the period start.
  assert.ok(hour.raw.cryp.every((p) => p.t >= now - HOUR && p.t <= now));
  assert.deepEqual(distinct(hour.raw.cryp), [9, 2, 3, 4]);
  assert.deepEqual(hour.raw.cryp[0], { t: now - HOUR, v: 9 });
  assert.deepEqual(distinct(hour.raw.blue), [8, 10]);
  assert.equal(hour.tMax, now);
  assert.equal(hour.tMin, now - HOUR, 'the axis starts at the real start of the selected period, not at the first point');

  const percent = chart.buildModel(maps, live, '1h', 'percent', now);
  assert.equal(percent.series.cryp[0].v, 0, 'the start of the period is 0%');
  assert.equal(percent.series.cryp[percent.series.cryp.length - 1].v, (4 - 9) / 9 * 100);
  assert.ok(percent.yMin <= 0 && percent.yMax >= 0);

  const day = chart.buildModel(maps, live, '24h', 'price', now);
  assert.ok(day.raw.cryp.every((p) => p.t >= now - DAY && p.t <= now));
  assert.deepEqual(distinct(day.raw.cryp), [9, 1, 4]);
  assert.equal(day.tMin, now - DAY);
});

test('points sent to the chart are capped', () => {
  const points = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: 1 }));
  const limited = chart.limitPoints(points, chart.MAX_CHART_POINTS);
  assert.ok(limited.length <= chart.MAX_CHART_POINTS + 1);
  assert.equal(limited[limited.length - 1], points[999]);
  assert.equal(chart.PERIODS['24h'].ms / chart.KINDS.coarse.stepMs, 288);
});

test('nice axis ticks stay inside the domain', () => {
  const ticks = chart.niceTicks(0.37, 7.4, 4);
  assert.ok(ticks.length >= 3 && ticks.every((v) => v >= 0.37 && v <= 7.4));
});

function fakeDom() {
  const byId = new Map();
  const make = (tag) => ({
    tag, attrs: {}, children: [], textContent: '', dataset: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(n) { this.children.push(n); return n; },
    replaceChildren(...n) { this.children = n; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    classList: { toggle() {} },
    getBoundingClientRect: () => ({ left: 0, width: 400 }),
    clientWidth: 400
  });
  ['chartCanvas', 'chartStatus', 'chartReadout', 'chartCrypRate', 'chartBlueRate', 'chartCrypChange', 'chartBlueChange']
    .forEach((id) => byId.set(id, make('div')));
  return {
    byId,
    getElementById: (id) => byId.get(id),
    querySelectorAll: () => [],
    createElementNS: (_ns, tag) => make(tag)
  };
}

test('controller renders both lines and current rates from shared history, and survives a reload', async () => {
  const dom = fakeDom();
  const now = Date.now();
  const hour = Math.floor(now / HOUR);
  const docs = {};
  const db = {
    collection: () => ({
      doc: (id) => ({
        onSnapshot: (cb) => { cb({ exists: id in docs, data: () => docs[id] }); return () => {}; },
        get: async () => ({ exists: id in docs, data: () => docs[id] }),
        set: async (data) => { docs[id] = { ...(docs[id] || {}), ...data }; }
      })
    })
  };
  const controller = chart.create({ document: dom, getDb: () => db });

  // Two players' ticks write points; a freshly created controller (page reload) reads the same history back.
  const base = hour * HOUR + 600000;
  [['cryp', 2], ['cryp', 3], ['blue', 8], ['blue', 9]].forEach(([cur, price], i) => {
    controller.recordTick(cur, { previousAt: base + i * 60000 - 5000, now: base + (i % 2 + 1) * 60000, price });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(Object.keys(docs).some((id) => id.startsWith(`h-cryp-${hour}`)));

  const reloaded = chart.create({ document: dom, getDb: () => db });
  reloaded.setLiveRate('cryp', 3.5, now);
  reloaded.setLiveRate('blue', 9.5, now);
  reloaded.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const svg = dom.byId.get('chartCanvas').children[0];
  assert.equal(svg.tag, 'svg');
  const paths = svg.children.filter((n) => n.tag === 'path');
  assert.equal(paths.length, 2, 'one line per cryptocurrency');
  assert.notEqual(paths[0].attrs.class, paths[1].attrs.class);
  assert.equal(dom.byId.get('chartCrypRate').textContent, '3,50 ₴');
  assert.equal(dom.byId.get('chartBlueRate').textContent, '9,50 ₴');
  reloaded.stop();
});

// ---------- History across breaks, sessions and devices ----------

function emptyMaps() {
  return { fine: { cryp: new Map(), blue: new Map() }, coarse: { cryp: new Map(), blue: new Map() } };
}

test('a break before login: the period still starts at its real start with the rate that was in force', () => {
  const now = 1_700_000_000_000;
  const maps = emptyMaps();
  maps.fine.cryp.set(now - 3 * HOUR, 2.5);          // last point before a 3 h break (outside the 1 h window)
  maps.fine.cryp.set(now - 4 * 60000, 2.7);         // player logged in 4 minutes ago
  maps.fine.cryp.set(now - 3 * 60000, 2.8);
  const model = chart.buildModel(maps, { cryp: { price: 2.9, at: now - 5000 }, blue: null }, '1h', 'price', now);
  const raw = model.raw.cryp;
  assert.equal(model.tMin, now - HOUR);
  assert.deepEqual(raw[0], { t: now - HOUR, v: 2.5 }, 'starts at the period start with the held value');
  assert.deepEqual(raw[1], { t: now - 4 * 60000 - 1, v: 2.5 }, 'the break is a flat segment');
  assert.equal(raw[2].v, 2.7);
  assert.ok(raw.every((p, i) => i === 0 || p.t > raw[i - 1].t), 'strictly sorted by time');
  assert.equal(raw[raw.length - 1].v, 2.9);
  // percent mode: the period start is 0%
  const percent = chart.buildModel(maps, { cryp: { price: 2.9, at: now - 5000 }, blue: null }, '1h', 'percent', now);
  assert.equal(percent.series.cryp[0].v, 0);
});

test('nobody played for the whole period: the live rate is held flat across the whole axis', () => {
  const now = 1_700_000_000_000;
  const series = chart.buildSeries(new Map(), { price: 4.2, at: now - 5 * HOUR }, '1h', now, null);
  assert.ok(series.every((p) => p.v === 4.2), 'flat: nothing changed while nobody was in the game');
  assert.equal(series[0].t, now - HOUR);
  assert.equal(series[series.length - 1].t, now);
  const day = chart.buildSeries(new Map(), { price: 4.2, at: now - 3 * DAY }, '24h', now, null);
  assert.equal(day[0].t, now - DAY);
});

test('a normal session without breaks is not given an invented anchor', () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  for (let t = now - HOUR + 10000; t <= now - 10000; t += STEP) map.set(t, 3);
  map.set(now - HOUR - 20000, 99);                 // older than the window, close to its start
  const series = chart.buildSeries(map, { price: 3, at: now - 2000 }, '1h', now, null);
  assert.equal(series[0].t, now - HOUR + 10000, 'starts at the first stored point');
  assert.ok(series.every((p) => p.v === 3), 'the old point did not leak into the chart');
});

test('a fetched anchor older than the loaded documents is used, and only if it is the latest point before the period', () => {
  const now = 1_700_000_000_000;
  const map = new Map([[now - 10 * 60000, 3]]);
  const far = { t: now - 6 * HOUR, v: 2 };
  assert.deepEqual(chart.windowAnchor(map, far, now - HOUR), far);
  map.set(now - HOUR - 60000, 2.2);                // a loaded point closer to the period start wins
  assert.deepEqual(chart.windowAnchor(map, far, now - HOUR), { t: now - HOUR - 60000, v: 2.2 });
  assert.equal(chart.windowAnchor(new Map(), null, now), null);
});

test('after a break the first tick stores the held rate once, at the first step boundary after the last tick', () => {
  const previousAt = 1_700_000_000_000 + 12000;
  const now = previousAt + 3 * HOUR + 7000;
  const fine = chart.buildGapAnchorWrite('fine', 'cryp', { previousAt, previousPrice: 3.14159, now, price: 3.2 });
  const boundary = (Math.floor(previousAt / STEP) + 1) * STEP;
  assert.equal(fine.id, `h-cryp-${Math.floor(boundary / HOUR)}`);
  assert.equal(fine.data[`t${Math.floor((boundary % HOUR) / STEP)}`], 3.1416);
  assert.ok(chart.buildGapAnchorWrite('coarse', 'cryp', { previousAt, previousPrice: 3, now, price: 3.2 }));
  // no break, no poisoned clock, no previous price: nothing extra is written
  assert.equal(chart.buildGapAnchorWrite('fine', 'cryp', { previousAt: now - 5000, previousPrice: 3, now, price: 3.2 }), null);
  assert.equal(chart.buildGapAnchorWrite('fine', 'cryp', { previousAt: 0, previousPrice: 3, now, price: 3.2 }), null);
  assert.equal(chart.buildGapAnchorWrite('fine', 'cryp', { previousAt, now, price: 3.2 }), null);
});

// Firestore stand-in with the production rule semantics for marketHistory: a point is written once, never overwritten.
function sharedHistoryDb(docs) {
  const rejected = [];
  const listeners = new Map();
  const notify = (id) => (listeners.get(id) || []).forEach((cb) => cb({ exists: id in docs, data: () => docs[id] }));
  const collection = {
    doc: (id) => ({
      onSnapshot: (cb) => {
        if (!listeners.has(id)) listeners.set(id, new Set());
        listeners.get(id).add(cb);
        cb({ exists: id in docs, data: () => docs[id] });
        return () => listeners.get(id).delete(cb);
      },
      get: async () => ({ exists: id in docs, data: () => docs[id] }),
      set: async (data) => {
        const existing = docs[id];
        if (existing) {
          const added = Object.keys(data).filter((k) => !(k in existing));
          const changed = Object.keys(data).filter((k) => k in existing && String(existing[k]) !== String(data[k]));
          if (added.length !== 1 || changed.length) { rejected.push(id); throw new Error('permission-denied'); }
        }
        docs[id] = { ...(existing || {}), ...data };
        notify(id);
      }
    }),
    where(_field, op1, lower) {
      return {
        where: (_f, _op2, upper) => ({
          orderBy: () => ({
            limit: () => ({
              get: async () => {
                const ids = Object.keys(docs).filter((id) => id >= lower && id < upper).sort().reverse().slice(0, 1);
                return { forEach: (fn) => ids.forEach((id) => fn({ data: () => docs[id] })) };
              }
            })
          })
        })
      };
    }
  };
  return { db: { collection: () => collection }, rejected };
}

test('two devices writing the same step: history is never duplicated or overwritten and stays sorted', async () => {
  const docs = {};
  const { db, rejected } = sharedHistoryDb(docs);
  const a = chart.create({ document: fakeDom(), getDb: () => db });
  const b = chart.create({ document: fakeDom(), getDb: () => db });
  const base = Math.floor(Date.now() / HOUR) * HOUR + 10 * STEP;
  for (let i = 0; i < 6; i++) {
    const tick = { previousAt: base + i * STEP - 5000, now: base + i * STEP, price: 2 + i / 10 };
    a.recordTick('cryp', tick);
    b.recordTick('cryp', { ...tick, price: 9 });   // the second device reports the same step with another value
  }
  await new Promise((resolve) => setImmediate(resolve));
  const id = `h-cryp-${Math.floor(base / HOUR)}`;
  const points = chart.parseDocument('fine', docs[id]).sort((x, y) => x.t - y.t);
  assert.equal(points.length, 6, 'one point per step');
  assert.deepEqual(points.map((p) => p.v), [2, 2.1, 2.2, 2.3, 2.4, 2.5], 'first write wins, no overwrite');
  assert.ok(rejected.length >= 6, 'the duplicates were refused');
});

test('login after a break on another device: shared history, the break anchor and the live rate are all loaded', async () => {
  const now = Date.now();
  const hour = Math.floor(now / HOUR);
  const docs = {};
  const { db } = sharedHistoryDb(docs);
  // Device A played 5 hours ago, then the game was closed everywhere.
  const earlier = (hour - 5) * HOUR + 600000;
  const deviceA = chart.create({ document: fakeDom(), getDb: () => db });
  deviceA.recordTick('cryp', { previousAt: earlier - 5000, now: earlier, price: 2 });
  // Device B opens the game now: its first tick follows the break and carries the previous state.
  const deviceB = chart.create({ document: fakeDom(), getDb: () => db, documentId: () => 'id' });
  const resume = now - 120000;
  deviceB.recordTick('cryp', { previousAt: earlier + 20000, previousPrice: 2.2, now: resume, price: 2.3 });
  await new Promise((resolve) => setImmediate(resolve));

  // Device C: a fresh page load on another device.
  const dom = fakeDom();
  const deviceC = chart.create({ document: dom, getDb: () => db, documentId: () => 'id' });
  deviceC.setLiveRate('cryp', 2.4, now - 2000);
  deviceC.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const model = chart.buildModel(deviceC._maps, { cryp: { price: 2.4, at: now - 2000 } }, '1h', 'price', now, deviceC._anchors);
  const series = model.raw.cryp;
  assert.equal(series[0].t, now - HOUR, 'the chart starts at the real period start, not at the login');
  assert.equal(series[0].v, 2.2, 'with the rate held through the break');
  assert.ok(series.every((p, i) => i === 0 || p.t > series[i - 1].t));
  assert.equal(series[series.length - 1].v, 2.4);
  deviceC.stop();
});

test('page switch after a re-login keeps the chart armed', async () => {
  const dom = fakeDom();
  const db = { collection: () => ({ doc: () => ({ onSnapshot: () => () => {}, get: async () => ({ exists: false }), set: async () => {} }) }) };
  const controller = chart.create({ document: dom, getDb: () => db });
  controller.setVisible(true);
  controller.stop();                                // sign-out / sign-in clears the chart and its visibility
  controller.setVisible(true);                      // the game re-arms it on the next sign-in
  controller.setLiveRate('cryp', 1.5, Date.now());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dom.byId.get('chartCanvas').children[0].tag, 'svg');
  controller.stop();
});
