'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const chart = require('../market-chart.js');

const HOUR = 3600000;
const DAY = 86400000;

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
  assert.deepEqual(hour.raw.cryp.map((p) => p.v), [2, 3, 4]);
  assert.deepEqual(hour.raw.blue.map((p) => p.v), [8, 10]);
  assert.equal(hour.tMax, now);
  assert.equal(hour.tMin, now - 1800000, 'short history fills the width');

  const percent = chart.buildModel(maps, live, '1h', 'percent', now);
  assert.equal(percent.series.cryp[0].v, 0);
  assert.equal(percent.series.cryp[2].v, 100);
  assert.equal(percent.series.blue[1].v, 25);
  assert.ok(percent.yMin <= 0 && percent.yMax >= 100);

  const day = chart.buildModel(maps, live, '24h', 'price', now);
  assert.deepEqual(day.raw.cryp.map((p) => p.v), [1, 4]);
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
