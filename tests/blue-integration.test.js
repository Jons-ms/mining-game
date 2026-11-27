'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const engine = require('../functions/lib/engine.js');

function makeElement(id = '') {
  return {
    id,
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    children: [],
    attributes: {},
    style: {},
    className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes; },
    focus() {},
    remove() {}
  };
}

function makeDatabase(seed = {}) {
  const documents = { ...seed };
  const listeners = new Map();
  const notify = (documentPath) => {
    for (const callback of listeners.get(documentPath) || []) {
      const data = documents[documentPath];
      callback({ exists: data !== undefined, data: () => data });
    }
  };
  const database = {
    collection(collectionName) {
      return {
        doc(documentId) {
          const ref = { path: `${collectionName}/${documentId}` };
          ref.onSnapshot = (callback) => {
            if (!listeners.has(ref.path)) listeners.set(ref.path, new Set());
            listeners.get(ref.path).add(callback);
            notify(ref.path);
            return () => listeners.get(ref.path)?.delete(callback);
          };
          ref.set = async (data, options) => { documents[ref.path] = options && options.merge ? { ...(documents[ref.path] || {}), ...data } : { ...data }; notify(ref.path); };
          return ref;
        }
      };
    },
    runTransaction(callback) {
      return Promise.resolve().then(() => callback({
        get: async (ref) => {
          const data = documents[ref.path];
          return { exists: data !== undefined, data: () => data };
        },
        set: (ref, data) => { documents[ref.path] = { ...data }; notify(ref.path); }
      }));
    }
  };
  return { database, documents };
}

function createGame() {
  const gamePath = path.join(__dirname, '..', 'game.js');
  const source = fs.readFileSync(gamePath, 'utf8');
  const elements = new Map();
  const localSaves = new Map();
  const pendingTimers = new Map();
  const documentListeners = new Map();
  let nextTimerId = 1;
  let currentTime = 1_700_000_000_000;
  class TestDate extends Date {
    static now() { return currentTime; }
  }
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const document = {
    hidden: false,
    body: makeElement('body'),
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(callback);
    },
    createElement: (tag) => makeElement(tag),
    createElementNS: (_namespace, tag) => makeElement(tag)
  };
  let randomSeed = 0.137;
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => {
    randomSeed = (randomSeed + 0.137) % 1;
    return randomSeed;
  };
  const window = {
    CrypChart: require('../market-chart.js'),
    crypFirebase: null,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => ({ serverTimestamp: true }) } } },
    setInterval: () => 1,
    addEventListener() {},
    scrollTo() {}
  };
  const schedule = (callback) => {
    const id = nextTimerId++;
    pendingTimers.set(id, callback);
    return id;
  };
  const cancel = (id) => pendingTimers.delete(id);
  const hook = `
    window.__blueTest = {
      getState: () => state,
      setState: (value) => { state = value; },
      newState,
      normalizeSavedState,
      GPU_TYPES,
      totalRate,
      addMining,
      purchaseGPU,
      installInventoryGPU,
      removeGPUFromFarm,
      sellGPUFromFarm,
      renderFarm,
      renderShop,
      setSellCurrency,
      sellBlue,
      sellCRYP,
      sellCurrency,
      purchaseExtraField,
      gameNow: () => Date.now(),
      updateSellPreview,
      normalizedMarketState,
      normalizedBlueMarketState,
      clampBluePrice,
      nextBluePriceState,
      startBlueMarketSync,
      updateBluePrice,
      money,
      setTargetSlotIndex: (value) => { targetSlotIndex = value; },
      setActionSlotIndex: (value) => { actionSlotIndex = value; },
      setUID: (value) => { currentUserUID = value; },
      setDatabase: (db) => { window.crypFirebase = { db }; },
      setSaveKey: (key) => { SAVE_KEY = key; },
      setServer: (functions) => { window.crypFirebase = { db: null, functions }; serverReady = true; currentUserUID = 'test-user'; },
      sendHeartbeat,
      applyServerState,
      save,
      loadState,
      setBlueMarket: (price, ready = true, lastPriceAt = Date.now()) => {
        blueMarketState = { ...INITIAL_BLUE_MARKET_STATE, price, lastPriceAt };
        blueMarketReady = ready;
      },
      setCrypMarket: (price, ready = true) => {
        marketState = { ...INITIAL_MARKET_STATE, price };
        marketReady = ready;
      },
      getBlueMarket: () => ({ ...blueMarketState, ready: blueMarketReady }),
      setPodiumEntries: (entries) => { podiumEntries = entries; },
      renderPodium,
      setRenderNoop: () => { render = () => {}; save = () => {}; },
      getElement: (id) => document.getElementById(id),
      showPage,
      syncChartVisibility,
      stopChart: () => marketChart.stop()
    };
  `;
  const instrumented = source.replace(/\}\)\(\);\s*$/, `${hook}\n})();`);
  assert.notEqual(instrumented, source, 'test hook insertion point exists');
  const context = {
    window,
    document,
    localStorage: {
      getItem: (key) => localSaves.get(key) ?? null,
      setItem: (key, value) => localSaves.set(key, value),
      removeItem: (key) => localSaves.delete(key)
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: schedule,
    clearTimeout: cancel,
    setInterval: () => 1,
    clearInterval() {},
    Date: TestDate,
    Intl,
    Math: deterministicMath
  };
  vm.runInNewContext(instrumented, context, { filename: gamePath });
  window.__blueTest.runPendingTimers = async () => {
    while (pendingTimers.size) {
      const callbacks = [...pendingTimers.values()];
      pendingTimers.clear();
      callbacks.forEach((callback) => callback());
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  window.__blueTest.setDocumentHidden = (hidden) => { document.hidden = hidden; };
  window.__blueTest.triggerVisibilityChange = () => {
    for (const callback of documentListeners.get('visibilitychange') || []) callback();
  };
  window.__blueTest.advanceTime = (milliseconds) => { currentTime += milliseconds; };
  return { api: window.__blueTest, elements };
}

test('legacy saves gain Blue=0 without losing CRYP progress or farm contents', () => {
  const { api } = createGame();
  const legacy = api.normalizeSavedState({
    playerName: 'Miner', cash: 321.5, cryp: 2.75,
    slots: [{ id: 'starter', name: 'Starter GPU', rate: 0.02, cost: 250 }],
    inventory: [], hasExtraField: true,
    extraSlots: [{ id: 'rtx3060', name: 'RTX 3060', rate: 0.06, cost: 600 }]
  });

  assert.equal(legacy.blue, 0);
  assert.equal(legacy.cash, 321.5);
  assert.equal(legacy.cryp, 2.75);
  assert.equal(legacy.slots[0].currency, 'cryp');
  assert.equal(legacy.extraSlots[0].currency, 'cryp');
  assert.equal(legacy.hasExtraField, true);
  assert.equal(legacy.slots.length, 16);
  assert.equal(legacy.extraSlots.length, 16);
});

test('Blue rate uses its own Firestore document, starts at 4.25, and stays in range', async () => {
  const { api } = createGame();
  const { api: otherDevice } = createGame();
  const originalCrypRate = { price: 3, lastPriceAt: 123 };
  const { database, documents } = makeDatabase({ 'market/exchangeRate': originalCrypRate });
  api.setUID('synthetic-test-user');
  api.setDatabase(database);
  otherDevice.setUID('synthetic-other-device');

  await api.startBlueMarketSync(database, 'synthetic-test-user');
  await otherDevice.startBlueMarketSync(database, 'synthetic-other-device');
  assert.equal(documents['market/blueExchangeRate'].price, 4.25);
  assert.equal(api.getBlueMarket().ready, true);
  assert.equal(otherDevice.getBlueMarket().price, 4.25);
  assert.deepEqual(documents['market/exchangeRate'], originalCrypRate);

  const nextTick = api.getBlueMarket().lastPriceAt + 5000;
  api.updateBluePrice(nextTick);
  await new Promise((resolve) => setImmediate(resolve));
  const price = documents['market/blueExchangeRate'].price;
  assert.ok(price >= 4.25 && price <= 13.75);
  assert.notEqual(price, 4.25, 'the first tick moves Blue independently from its initial value');
  assert.equal(otherDevice.getBlueMarket().price, price, 'other signed-in clients receive the same Firestore rate');
  assert.deepEqual(documents['market/exchangeRate'], originalCrypRate);
  assert.equal(api.clampBluePrice(1), 4.25);
  assert.equal(api.clampBluePrice(99), 13.75);
  assert.equal(api.money(4.25), '4,25 ₴');
});

test('shop and farm distinguish Blue cards visually and by currency label', () => {
  const { api, elements } = createGame();
  api.setRenderNoop();
  api.renderShop();
  const groups = elements.get('shopList').children.filter((child) => child.className.includes('shop-currency-group'));
  assert.equal(groups.length, 2);
  assert.match(groups[0].children[0].textContent, /CRYP/);
  assert.match(groups[1].children[0].textContent, /Blue/);
  assert.match(groups[1].children[1].children[1].children[1].textContent, /Blue\/с/);

  const state = api.newState();
  state.slots[0] = { id: 'blue-rtx4060', name: 'RTX 4060', rate: 0.015, currency: 'blue', cost: 2400 };
  api.setState(state);
  api.renderFarm();
  assert.match(elements.get('farmGrid').children[0].className, /blue-gpu-slot/);
});

test('Blue balances, rates and exchange controls have unique page elements', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'page element IDs stay unique');
  for (const id of [
    'blueValue', 'blueRateValue', 'bluePriceValue', 'blueExchangeBalance',
    'blueExchangePrice', 'blueMarketStatus', 'sellAmount', 'sellPreview',
    'sellAllButton', 'sellButton', 'infoBlue', 'infoBlueRate', 'infoBluePrice'
  ]) assert.ok(ids.includes(id), `missing Blue UI element: ${id}`);
});

test('a far-future lastPriceAt from a wrong device clock cannot freeze either shared rate', () => {
  const { api } = createGame();
  const now = api.gameNow();
  const day = 24 * 60 * 60 * 1000;
  for (const normalize of [api.normalizedMarketState, api.normalizedBlueMarketState]) {
    assert.equal(normalize({ price: 5, lastPriceAt: now + day }).lastPriceAt, 0, 'poisoned timestamp counts as stale');
    assert.equal(normalize({ price: 5, lastPriceAt: now + 30_000 }).lastPriceAt, now + 30_000, 'small clock skew is tolerated');
    assert.equal(normalize({ price: 5, lastPriceAt: now - 10_000 }).lastPriceAt, now - 10_000);
  }
});

test('farm slot labels use Ukrainian wording', () => {
  const { api, elements } = createGame();
  api.setRenderNoop();
  const state = api.newState();
  state.slots[0] = { id: 'blue-rtx4060', name: 'RTX 4060', rate: 0.015, currency: 'blue', cost: 2400 };
  api.setState(state);
  api.renderFarm();
  const label = elements.get('farmGrid').children[0].attributes['aria-label'];
  assert.match(label, /видобуває Blue/);
  assert.doesNotMatch(label, /майнить/);
});

test('Firestore rules validate both shared rates, including the server-time check', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  assert.match(rules, /match \/market\/exchangeRate[\s\S]*?validRateData\(0\.25, 7\)/);
  assert.match(rules, /match \/market\/blueExchangeRate[\s\S]*?validRateData\(4\.25, 13\.75\)/);
  assert.match(rules, /request\.time\.toMillis\(\) - 60000/);
  assert.match(rules, /request\.time\.toMillis\(\) \+ 60000/);
  // Server-owned data: players may read their own save but never write it; the Podium snapshot is read-only.
  assert.match(rules, /match \/players\/\{playerId\}\s*\{\s*(?:\/\/[^\n]*\n\s*)*allow read: if request\.auth != null && request\.auth\.uid == playerId;\s*allow write: if false;/);
  assert.match(rules, /match \/podium\/\{docId\}\s*\{\s*allow read: if request\.auth != null;\s*allow write: if false;/);
  assert.doesNotMatch(rules, /podiumPlayers/);
});

test('every rate tick (5 s step) and every 5 min step also writes shared history points, without touching the rate logic', async () => {
  const { api } = createGame();
  const { database, documents } = makeDatabase();
  api.setUID('synthetic-test-user');
  api.setDatabase(database);
  await api.startBlueMarketSync(database, 'synthetic-test-user');

  const start = api.getBlueMarket().lastPriceAt;
  // Align to the first second of a 5-minute step so both the 5 s and the 5 min boundary are crossed.
  const aligned = Math.ceil((start + 5000) / 300000) * 300000;
  api.advanceTime(aligned - api.gameNow());
  api.setBlueMarket(documents['market/blueExchangeRate'].price, true, aligned - 5000);
  documents['market/blueExchangeRate'].lastPriceAt = aligned - 5000;
  api.updateBluePrice(aligned);
  await new Promise((resolve) => setImmediate(resolve));

  const price = documents['market/blueExchangeRate'].price;
  const historyDocs = Object.keys(documents).filter((key) => key.startsWith('marketHistory/'));
  assert.equal(historyDocs.length, 2, 'one fine and one coarse history document');
  const fine = documents[`marketHistory/h-blue-${Math.floor(aligned / 3600000)}`];
  const coarse = documents[`marketHistory/d-blue-${Math.floor(aligned / 86400000)}`];
  assert.equal(fine.cur, 'blue');
  assert.equal(fine[`t${Math.floor((aligned % 3600000) / 5000)}`], price);
  assert.equal(coarse[`t${Math.floor((aligned % 86400000) / 300000)}`], price);

  // The next tick, 5 s later, is a new 5 s step: the fine chart gets another point, the 5-minute one does not.
  api.advanceTime(5000);
  api.updateBluePrice(aligned + 5000);
  await new Promise((resolve) => setImmediate(resolve));
  const next = documents['market/blueExchangeRate'];
  assert.notEqual(next.lastPriceAt, aligned, 'the rate itself still advances every 5 seconds');
  assert.equal(Object.keys(documents).filter((key) => key.startsWith('marketHistory/')).length, 2);
  const slot = Math.floor((aligned % 3600000) / 5000);
  const fineNow = documents[`marketHistory/h-blue-${Math.floor(aligned / 3600000)}`];
  const coarseNow = documents[`marketHistory/d-blue-${Math.floor(aligned / 86400000)}`];
  assert.equal(fineNow[`t${slot + 1}`], next.price, 'the next 5 s rate change is stored as its own chart point');
  assert.equal(Object.keys(fineNow).filter((key) => /^t\d+$/.test(key)).length, 2);
  assert.equal(Object.keys(coarseNow).filter((key) => /^t\d+$/.test(key)).length, 1, 'the 5-minute history is not written again');
});

test('Firestore rules protect the shared rate history (range, write-once points, bounded slots)', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  assert.match(rules, /match \/marketHistory\/\{docId\}/);
  assert.match(rules, /allow delete: if false/);
  assert.match(rules, /cur == 'cryp' && price >= 0\.25 && price <= 7/);
  assert.match(rules, /cur == 'blue' && price >= 4\.25 && price <= 13\.75/);
  assert.match(rules, /affectedKeys\(\)\.size\(\) == 1/);
  assert.match(rules, /\[1-6\]\[0-9\]\[0-9\]\|7\[01\]\[0-9\]/);
  assert.match(rules, /28\[0-7\]/);
});

test('the first tick after a break stores the rate held through it next to the new point, without touching the rate logic', async () => {
  const { api } = createGame();
  const { database, documents } = makeDatabase();
  api.setUID('synthetic-test-user');
  api.setDatabase(database);
  await api.startBlueMarketSync(database, 'synthetic-test-user');

  const hour = 3600000;
  const now = api.gameNow();
  const previousAt = now - 3 * hour - 12000;
  const heldPrice = documents['market/blueExchangeRate'].price;
  documents['market/blueExchangeRate'].lastPriceAt = previousAt;
  api.setBlueMarket(heldPrice, true, previousAt);
  api.updateBluePrice(now);
  await new Promise((resolve) => setImmediate(resolve));

  const boundary = (Math.floor(previousAt / 5000) + 1) * 5000;
  const anchorDoc = documents[`marketHistory/h-blue-${Math.floor(boundary / hour)}`];
  assert.ok(anchorDoc, 'the break anchor is stored in the shared history');
  assert.equal(anchorDoc[`t${Math.floor((boundary % hour) / 5000)}`], Number(heldPrice.toFixed(4)));
  const fresh = documents[`marketHistory/h-blue-${Math.floor(now / hour)}`];
  assert.equal(fresh[`t${Math.floor((now % hour) / 5000)}`], documents['market/blueExchangeRate'].price, 'and the new point is stored too');
  assert.ok(documents['market/blueExchangeRate'].price >= 4.25 && documents['market/blueExchangeRate'].price <= 13.75);
});

test('after sign-out and a new sign-in the chart is re-armed on the open Exchange page', () => {
  const { api } = createGame();
  const { database } = makeDatabase();
  let historyListeners = 0;
  const collection = database.collection.bind(database);
  database.collection = (name) => {
    const handle = collection(name);
    const doc = handle.doc.bind(handle);
    handle.doc = (id) => {
      const ref = doc(id);
      const onSnapshot = ref.onSnapshot;
      ref.onSnapshot = (callback) => { if (name === 'marketHistory') historyListeners += 1; return onSnapshot(callback); };
      return ref;
    };
    return handle;
  };
  api.setUID('synthetic-test-user');
  api.setDatabase(database);

  api.showPage('exchange');
  assert.equal(historyListeners, 2, 'one live listener per currency on the current hour while the Exchange is open');
  api.stopChart();                       // what onAuthStateChanged does on every sign-out / sign-in
  api.syncChartVisibility();             // what the game now does at the end of a sign-in
  assert.equal(historyListeners, 4, 'the shared history is loaded again after the new sign-in');

  api.showPage('farm');
  api.stopChart();
  api.syncChartVisibility();
  assert.equal(historyListeners, 4, 'no history reads while another page is open');
});

// ---------------------------------------------------------------------------------------------
// Server-authoritative game: the browser only calls Cloud Functions. The fake server below runs the real
// engine (functions/lib/engine.js), so these tests cover the browser and the game rules together.
// ---------------------------------------------------------------------------------------------
function makeServer(api, setup = (state) => state, rates = { cryp: 2, blue: 10 }) {
  const server = { state: setup(engine.newState(api.gameNow())), rates, calls: [] };
  const strip = (state) => { const { recentOps, ...visible } = JSON.parse(JSON.stringify(state)); return visible; };
  server.functions = {
    httpsCallable: (name) => async (data) => {
      server.calls.push({ name, data });
      if (server.failNext) { const error = server.failNext; server.failNext = null; throw error; }
      const nowMs = api.gameNow();
      if (name === 'gameAction') {
        const applied = engine.applyAction(server.state, { type: data.type, payload: data.payload, opId: data.opId }, { nowMs, rates: server.rates, random: Math.random });
        server.state = applied.state;
        return { data: { state: strip(server.state), duplicate: applied.duplicate, serverNow: nowMs } };
      }
      if (name === 'heartbeat') {
        server.state = engine.applyHeartbeat(server.state, nowMs).state;
        return { data: { state: strip(server.state), serverNow: nowMs } };
      }
      throw new Error('unknown function ' + name);
    }
  };
  api.setServer(server.functions);
  api.applyServerState({ state: strip(server.state) });
  return server;
}

test('the browser never writes players or podium data directly: only Cloud Functions change progress', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
  assert.ok(!/collection\("players"\)/.test(source), 'no direct access to players/{uid}');
  assert.ok(!/podiumPlayers/.test(source));
  assert.ok(!/localStorage\.setItem/.test(source), 'progress is not stored in the browser any more');
  assert.match(source, /httpsCallable\("gameAction"\)/);
  assert.match(source, /httpsCallable\("heartbeat"\)/);
  assert.match(source, /httpsCallable\("initPlayer"\)/);
  assert.ok(!/legacySave/.test(source), 'the browser never sends a saved game to the server');
});

test('Blue cards: buy, install, remove and sell through the server at the approved prices and 50% resale', async () => {
  const { api } = createGame();
  api.setRenderNoop();
  const server = makeServer(api, (state) => ({ ...state, cash: 50000 }));
  const blueTypes = api.GPU_TYPES.filter((gpu) => gpu.currency === 'blue');

  for (const gpu of blueTypes) await api.purchaseGPU(gpu);
  assert.deepEqual(JSON.parse(JSON.stringify(api.getState().inventory.map((gpu) => [gpu.name, gpu.cost, gpu.rate, gpu.currency]))), [
    ['RTX 4060', 2400, 0.015, 'blue'], ['RTX 3070', 10000, 0.06, 'blue'], ['RTX 4070', 15000, 0.08, 'blue']
  ]);
  assert.equal(api.getState().cash, 22600);
  assert.equal(api.totalRate('blue'), 0, 'inventory does not mine');

  for (let index = 0; index < blueTypes.length; index += 1) {
    api.setTargetSlotIndex(index);
    await api.installInventoryGPU(api.getState().inventory[0].inventoryId);
  }
  assert.equal(api.getState().inventory.length, 0);
  assert.equal(api.totalRate('blue'), 0.155);

  api.setActionSlotIndex(0);
  await api.removeGPUFromFarm();
  assert.equal(api.getState().slots[0], null);
  assert.equal(api.getState().inventory[0].currency, 'blue');
  api.setTargetSlotIndex(0);
  await api.installInventoryGPU(api.getState().inventory[0].inventoryId);

  const before = api.getState().cash;
  for (let index = 0; index < 3; index += 1) { api.setActionSlotIndex(index); await api.sellGPUFromFarm(); }
  assert.equal(api.getState().cash, before + 1200 + 5000 + 7500);
  assert.equal(server.state.cash, api.getState().cash, 'browser and server agree');
});

test('a purchase without enough money is refused and changes nothing on the server', async () => {
  const { api } = createGame();
  api.setRenderNoop();
  const server = makeServer(api);
  await api.purchaseGPU(api.GPU_TYPES.find((gpu) => gpu.id === 'rtx4090'));
  assert.equal(server.state.cash, 490);
  assert.equal(server.calls.length, 0, 'refused locally, no server call needed');
});

test('a failed server call keeps the previous state and a retry reuses the same operation id', async () => {
  const { api } = createGame();
  api.setRenderNoop();
  const server = makeServer(api);
  const starter = api.GPU_TYPES[0];
  server.failNext = Object.assign(new Error('offline'), { code: 'unavailable' });
  await api.purchaseGPU(starter);
  const ids = server.calls.filter((call) => call.name === 'gameAction').map((call) => call.data.opId);
  assert.equal(ids.length, 2, 'one automatic retry after a network error');
  assert.equal(ids[0], ids[1], 'same operation id, so it can never be applied twice');
  assert.equal(server.state.cash, 240);
  assert.equal(server.state.inventory.length, 1);
});

test('selling uses the server rate; fractions, comma input and "sell all" work; overselling is rejected', async () => {
  const { api, elements } = createGame();
  api.setRenderNoop();
  const server = makeServer(api, (state) => ({ ...state, cash: 100, blue: 1.25 }), { cryp: 2, blue: 10 });
  api.setBlueMarket(10);
  api.setCrypMarket(2);
  api.setSellCurrency('blue');
  const amount = elements.get('sellAmount');

  amount.value = '0,25';
  api.updateSellPreview();
  assert.equal(elements.get('sellPreview').textContent, '2,50 ₴');
  await api.sellBlue();
  assert.equal(api.getState().blue, 1);
  assert.equal(api.getState().cash, 102.5);

  amount.value = '2';
  api.updateSellPreview();
  assert.equal(elements.get('sellPreview').textContent, 'Недостатньо Blue');
  const callsBefore = server.calls.length;
  await api.sellBlue();
  assert.equal(server.calls.length, callsBefore, 'an impossible sale never reaches the server');

  await api.sellCurrency('blue', true);
  assert.equal(api.getState().blue, 0);
  assert.equal(api.getState().cash, 112.5);
});

test('selling accepts the rounded balance shown on screen', async () => {
  const { api, elements } = createGame();
  api.setRenderNoop();
  makeServer(api, (state) => ({ ...state, blue: 1.234568, cryp: 5.0004 }), { cryp: 2, blue: 10 });
  api.setBlueMarket(10);
  api.setCrypMarket(2);
  elements.get('sellAmount').value = '1,234568';
  await api.sellBlue();
  assert.equal(api.getState().blue, 0);
  elements.get('sellAmount').value = '5.0005';
  await api.sellCRYP();
  assert.equal(api.getState().cryp, 0);
});

test('one shared sell form: the toggle picks the currency and each currency sells at its own server rate', async () => {
  const { api, elements } = createGame();
  api.setRenderNoop();
  makeServer(api, (state) => ({ ...state, cash: 0, cryp: 10, blue: 2 }), { cryp: 2, blue: 10 });
  api.setCrypMarket(2);
  api.setBlueMarket(10);
  const amount = elements.get('sellAmount');
  amount.value = '3';
  api.updateSellPreview();
  assert.equal(elements.get('sellPreview').textContent, '6,00 ₴');
  api.setSellCurrency('blue');
  assert.equal(amount.value, '', 'switching currency clears the typed amount');
  amount.value = '1,5';
  await api.sellBlue();
  assert.equal(api.getState().blue, 0.5);
  assert.equal(api.getState().cryp, 10);
  assert.equal(api.getState().cash, 15);
  api.setSellCurrency('cryp');
  amount.value = '4';
  await api.sellCRYP();
  assert.equal(api.getState().cryp, 6);
  assert.equal(api.getState().cash, 23);
});

test('mining is credited by the server heartbeat, never twice, and a long break credits nothing', async () => {
  const { api } = createGame();
  api.setRenderNoop();
  const server = makeServer(api, (state) => {
    state.slots[0] = { id: 'blue-rtx4060', name: 'RTX 4060', rate: 0.015, currency: 'blue', cost: 2400 };
    return state;
  });
  api.advanceTime(60_000);
  await api.sendHeartbeat();
  assert.ok(Math.abs(api.getState().blue - 0.9) < 1e-9, 'a normal 60 s heartbeat pays 60 s');
  await api.sendHeartbeat();
  assert.ok(Math.abs(server.state.blue - 0.9) < 1e-9, 'an immediate second heartbeat (other device or tab) pays nothing');

  api.advanceTime(10 * 60_000);
  await api.sendHeartbeat();
  assert.ok(Math.abs(server.state.blue - 0.9) < 1e-9, 'a break over the limit is not paid');
});

test('returning to the tab triggers a server heartbeat that decides how much of the break counts', async () => {
  const { api } = createGame();
  api.setRenderNoop();
  const server = makeServer(api, (state) => {
    state.slots[0] = { id: 'blue-rtx4060', name: 'RTX 4060', rate: 0.015, currency: 'blue', cost: 2400 };
    return state;
  });
  api.setDocumentHidden(true);
  api.triggerVisibilityChange();
  await new Promise((resolve) => setImmediate(resolve));
  api.advanceTime(50_000);
  api.setDocumentHidden(false);
  api.triggerVisibilityChange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(Math.abs(server.state.blue - 0.75) < 1e-9, '50 s away is credited by the server');
});

test('the Podium shows the hourly server snapshot and is not rebuilt when nothing changed', () => {
  const { api, elements } = createGame();
  api.setPodiumEntries([
    { rank: 1, nickname: 'Miner', cashBalance: 100, totalCapital: 111 },
    { rank: 2, nickname: 'Second', cashBalance: 5, totalCapital: 20 }
  ]);
  api.renderPodium();
  const rows = elements.get('podiumRows').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[1].textContent, 'Miner');
  assert.equal(rows[0].children[3].textContent, '111,00 ₴');
  const first = rows[0];
  api.renderPodium();
  assert.equal(elements.get('podiumRows').children[0], first, 'unchanged snapshot keeps the same DOM rows');
  api.setPodiumEntries([{ rank: 1, nickname: 'Miner', cashBalance: 100, totalCapital: 150 }]);
  api.renderPodium();
  assert.notEqual(elements.get('podiumRows').children[0], first);
});
