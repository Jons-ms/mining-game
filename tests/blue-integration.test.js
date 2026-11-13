'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
          ref.set = async (data) => { documents[ref.path] = { ...data }; notify(ref.path); };
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
      updateBlueSellPreview,
      sellBlue,
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
      setCloudSaveReady: (value) => { cloudSaveReady = value; },
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
      setPodiumProfiles: (profiles) => { podiumProfiles = profiles; },
      renderPodium,
      setRenderNoop: () => { render = () => {}; save = () => {}; },
      getElement: (id) => document.getElementById(id)
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

test('Blue GPUs buy into inventory, install and mine only Blue at their approved rates', () => {
  const { api } = createGame();
  api.setRenderNoop();
  const state = api.newState();
  state.cash = 30000;
  api.setState(state);
  const blueTypes = api.GPU_TYPES.filter((gpu) => gpu.currency === 'blue');

  blueTypes.forEach((gpu) => api.purchaseGPU(gpu));
  assert.deepEqual(JSON.parse(JSON.stringify(state.inventory.map((gpu) => [gpu.name, gpu.cost, gpu.rate, gpu.currency]))), [
    ['RTX 4060', 2400, 0.015, 'blue'],
    ['RTX 3070', 10000, 0.06, 'blue'],
    ['RTX 4070', 15000, 0.08, 'blue']
  ]);
  assert.equal(state.cash, 2600);
  assert.ok(state.slots.every((gpu) => gpu === null), 'purchase does not install cards');
  assert.equal(api.totalRate('blue'), 0, 'inventory does not mine');

  blueTypes.forEach((_gpu, index) => {
    api.setTargetSlotIndex(index);
    api.installInventoryGPU(state.inventory[0].inventoryId);
  });
  assert.equal(state.inventory.length, 0);
  assert.equal(api.totalRate('blue'), 0.155);
  state.slots[3] = { id: 'starter', name: 'Starter GPU', rate: 0.02, currency: 'cryp', cost: 250 };
  assert.equal(api.totalRate('cryp'), 0.02);

  api.addMining(10);
  assert.equal(state.blue, 1.55);
  assert.equal(state.cryp, 0.2);
});

test('background mining still accrues at most 60 seconds after the tab is hidden', () => {
  const { api } = createGame();
  const state = api.newState();
  state.slots[0] = { id: 'blue-rtx4060', name: 'RTX 4060', rate: 0.015, currency: 'blue', cost: 2400 };
  api.setState(state);

  api.setDocumentHidden(true);
  api.triggerVisibilityChange();
  api.advanceTime(70_000);
  api.setDocumentHidden(false);
  api.triggerVisibilityChange();

  assert.ok(Math.abs(state.blue - 0.9) < 1e-9);
  assert.equal(state.cryp, 0);
});

test('Blue cards preserve currency when removed and sell installed for exactly half price', () => {
  const { api } = createGame();
  api.setRenderNoop();
  const state = api.newState();
  state.cash = 50000;
  api.setState(state);
  const types = api.GPU_TYPES.filter((gpu) => gpu.currency === 'blue');
  types.forEach((gpu) => api.purchaseGPU(gpu));
  types.forEach((_gpu, index) => {
    api.setTargetSlotIndex(index);
    api.installInventoryGPU(state.inventory[0].inventoryId);
  });

  api.setActionSlotIndex(0);
  api.removeGPUFromFarm();
  assert.equal(state.slots[0], null);
  assert.equal(state.inventory[0].currency, 'blue');
  api.setTargetSlotIndex(0);
  api.installInventoryGPU(state.inventory[0].inventoryId);

  const cashBeforeSale = state.cash;
  [1200, 5000, 7500].forEach((expectedGain, index) => {
    api.setActionSlotIndex(index);
    api.sellGPUFromFarm();
    assert.equal(state.cash, cashBeforeSale + [1200, 5000, 7500].slice(0, index + 1).reduce((a, b) => a + b, 0));
    assert.equal(state.slots[index], null);
  });
});

test('Blue sales preview correctly, accept fractions and all, and reject overselling', () => {
  const { api, elements } = createGame();
  api.setRenderNoop();
  const state = api.newState();
  state.cash = 100;
  state.blue = 1.25;
  api.setState(state);
  api.setBlueMarket(10);
  const amount = elements.get('blueSellAmount');
  const preview = elements.get('blueSellPreview');

  amount.value = '0,25';
  api.updateBlueSellPreview();
  assert.equal(preview.textContent, '2,50 ₴');
  api.sellBlue();
  assert.equal(state.blue, 1);
  assert.equal(state.cash, 102.5);

  amount.value = '2';
  api.updateBlueSellPreview();
  assert.equal(preview.textContent, 'Недостатньо Blue');
  api.sellBlue();
  assert.equal(state.blue, 1);
  assert.equal(state.cash, 102.5);

  amount.value = '1';
  api.sellBlue();
  assert.equal(state.blue, 0);
  assert.equal(state.cash, 112.5);
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

test('Blue balance and installed cards persist through local reload and the player Firestore save', async () => {
  const { api } = createGame();
  const { database, documents } = makeDatabase();
  const state = api.newState();
  state.cash = 1234.5;
  state.cryp = 5.25;
  state.blue = 0.75;
  state.slots[2] = { id: 'blue-rtx4060', name: 'RTX 4060', rate: 0.015, cost: 2400 };
  api.setState(state);
  api.setUID('save-test-user');
  api.setSaveKey('cryp-mining-v01-save-test-user');
  api.setCloudSaveReady(true);
  api.setDatabase(database);

  api.save();
  await api.runPendingTimers();
  const localReload = api.loadState();
  const cloudReload = api.normalizeSavedState(documents['players/save-test-user']);

  for (const reloaded of [localReload, cloudReload]) {
    assert.equal(reloaded.cash, 1234.5);
    assert.equal(reloaded.cryp, 5.25);
    assert.equal(reloaded.blue, 0.75);
    assert.equal(reloaded.slots[2].currency, 'blue');
    assert.equal(reloaded.slots[2].cost, 2400);
  }
});

test('Podium includes Blue value in hryvnia using the independent Blue rate', () => {
  const { api, elements } = createGame();
  api.setCrypMarket(3);
  api.setBlueMarket(10);
  api.setPodiumProfiles([{ nickname: 'Miner', cashBalance: 100, crypBalance: 2, blueBalance: 0.5 }]);
  api.renderPodium();

  const rows = elements.get('podiumRows').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[3].textContent, '111,00 ₴');
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
    'blueExchangePrice', 'blueMarketStatus', 'blueSellAmount', 'blueSellPreview',
    'blueSellAllButton', 'blueSellButton', 'infoBlue', 'infoBlueRate', 'infoBluePrice'
  ]) assert.ok(ids.includes(id), `missing Blue UI element: ${id}`);
});

