'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Bank = require('../bank.js');

function makeNode(tag = 'div') {
  return {
    tag, className: '', textContent: '', disabled: false, attributes: {}, children: [], listeners: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }
  };
}

function makeDocument() {
  const nodes = new Map();
  return {
    nodes,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); },
    createElement: makeNode
  };
}

function walk(node, visit) {
  visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}

function texts(node) {
  const out = [];
  walk(node, (item) => { if (item.textContent) out.push(item.textContent); });
  return out;
}

// Firestore double for the browser: it can only READ, like the real rules. Writes happen in the fake server below.
function makeDb(seed = {}, options = {}) {
  const documents = { ...seed };
  return {
    documents,
    collection(name) {
      return {
        doc(id) {
          const ref = { path: `${name}/${id}` };
          ref.get = async () => {
            if (options.failGet) throw new Error('permission-denied');
            const data = documents[ref.path];
            return { exists: data !== undefined, data: () => data };
          };
          return ref;
        }
      };
    }
  };
}

// Fake openBankAccount function: same rules as functions/index.js (one account per player and currency,
// unique numbers, retries on a taken number), using the real server card-number generator.
function makeFunctions(db, options = {}) {
  const serverBank = require('../functions/lib/bank.js');
  const calls = [];
  return {
    calls,
    httpsCallable: (name) => async (data) => {
      calls.push({ name, data });
      if (options.fail) throw new Error('unavailable');
      const uid = options.uid || 'u1';
      if (!serverBank.CURRENCIES[data.currency]) throw new Error('invalid-argument');
      const accountPath = `bankAccounts/${serverBank.accountId(uid, data.currency)}`;
      if (db.documents[accountPath]) return { data: { currency: data.currency, cardNumber: db.documents[accountPath].cardNumber, created: false } };
      for (let attempt = 0; attempt < 8; attempt++) {
        const cardNumber = serverBank.generateCardNumber(data.currency, options.randomDigit);
        if (db.documents[`cardNumbers/${cardNumber}`]) continue;
        db.documents[`cardNumbers/${cardNumber}`] = { uid, currency: data.currency };
        db.documents[accountPath] = { uid, currency: data.currency, cardNumber };
        return { data: { currency: data.currency, cardNumber, created: true } };
      }
      throw new Error('resource-exhausted');
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const stamp = () => ({ serverTimestamp: true });

function makeBank(overrides = {}) {
  const document = makeDocument();
  const bank = Bank.create({ document, ...overrides });
  return { bank, document };
}

// Starts a bank for `uid` wired to a fake server over `db`.
function startBank(db, uid = 'u1', serverOptions = {}) {
  const functions = makeFunctions(db, { uid, ...serverOptions });
  const made = makeBank();
  made.bank.start(db, uid, functions);
  return { ...made, functions };
}

test('the game has exactly three currencies and no EURO', () => {
  assert.deepEqual(Bank.CURRENCIES.map((currency) => currency.id), ['uah', 'cryp', 'blue']);
  assert.equal(Bank.currencyById('euro'), null);
});

test('card numbers have 16 digits, a currency prefix and a valid Luhn check digit', () => {
  Bank.CURRENCIES.forEach((currency) => {
    for (let index = 0; index < 50; index++) {
      const number = require('../functions/lib/bank.js').generateCardNumber(currency.id);
      assert.match(number, /^[0-9]{16}$/);
      assert.ok(number.startsWith(currency.prefix));
      assert.ok(Bank.isValidCardNumber(number));
    }
  });
  const valid = require('../functions/lib/bank.js').generateCardNumber('uah');
  const wrongCheck = valid.slice(0, 15) + String((Number(valid[15]) + 1) % 10);
  assert.equal(Bank.isValidCardNumber(wrongCheck), false);
  assert.equal(Bank.isValidCardNumber('abc'), false);
  assert.equal(Bank.formatCardNumber('9001123412341234'), '9001 1234 1234 1234');
});

test('no accounts are created on start; the cards offer to open them', async () => {
  const db = makeDb();
  const { bank, document, functions } = startBank(db);
  await flush();
  assert.equal(bank._state().status, 'ready');
  assert.equal(functions.calls.length, 0);
  assert.deepEqual(Object.keys(db.documents), []);
  const cards = document.getElementById('bankCards').children;
  assert.equal(cards.length, 3);
  cards.forEach((card) => assert.ok(card.className.includes('bank-card-empty')));
  assert.ok(texts(document.getElementById('bankCards')).some((text) => text.startsWith('Відкрити рахунок')));
});

test('opening an account stores it in Firestore and shows the existing balance unchanged', async () => {
  const db = makeDb();
  const { bank, document, functions } = startBank(db);
  bank.setBalances({ cash: 1234.5, cryp: 10.25, blue: 0.5 });
  await flush();
  assert.equal(await bank.openAccount('uah'), true);

  assert.deepEqual(functions.calls, [{ name: 'openBankAccount', data: { currency: 'uah' } }], 'the browser only asks the server');
  assert.deepEqual(Object.keys(db.documents).sort(), ['bankAccounts/u1_uah', `cardNumbers/${db.documents['bankAccounts/u1_uah'].cardNumber}`].sort());
  const account = db.documents['bankAccounts/u1_uah'];
  assert.equal(account.uid, 'u1');
  assert.equal(account.currency, 'uah');
  assert.ok(Bank.isValidCardNumber(account.cardNumber));
  assert.deepEqual(bank._state().balances, { cash: 1234.5, cryp: 10.25, blue: 0.5 });

  const shown = texts(document.getElementById('bankCards'));
  assert.ok(shown.includes(Bank.formatBalance('uah', 1234.5)));
  assert.ok(shown.includes(Bank.formatCardNumber(account.cardNumber)));
  // the other two currencies are still not opened
  assert.equal(document.getElementById('bankCards').children.filter((card) => card.className.includes('bank-card-empty')).length, 2);
});

test('one account per currency: a second opening is refused and nothing is written', async () => {
  const db = makeDb();
  const { bank, functions } = startBank(db);
  await flush();
  assert.equal(await bank.openAccount('blue'), true);
  const before = JSON.stringify(db.documents);
  assert.equal(await bank.openAccount('blue'), false);
  assert.equal(JSON.stringify(db.documents), before);
  assert.equal(functions.calls.length, 1, 'the second attempt is refused in the browser and never reaches the server');
});

test('accounts survive a new login or another device', async () => {
  const db = makeDb();
  const first = startBank(db).bank;
  await flush();
  await first.openAccount('cryp');
  const number = db.documents['bankAccounts/u1_cryp'].cardNumber;
  first.stop();

  const second = startBank(db);
  await flush();
  assert.equal(second.bank._state().accounts.cryp.cardNumber, number);
  assert.equal(second.bank._state().accounts.uah, undefined);
});

test("another player's accounts are not shown", async () => {
  const db = makeDb();
  const owner = startBank(db).bank;
  await flush();
  await owner.openAccount('uah');

  const other = startBank(db, 'u2').bank;
  await flush();
  assert.deepEqual(other._state().accounts, {});
});

test('a failed load shows a rules hint instead of cards', async () => {
  const db = makeDb({}, { failGet: true });
  const { bank, document } = makeBank();
  const originalError = console.error;
  console.error = () => {};
  try {
    bank.start(db, 'u1');
    await flush();
  } finally {
    console.error = originalError;
  }
  assert.equal(bank._state().status, 'error');
  assert.match(document.getElementById('bankStatus').textContent, /firestore\.rules/);
  assert.equal(document.getElementById('bankCards').children.length, 0);
});

test('logging out clears the accounts and ignores a late load', async () => {
  const db = makeDb();
  const { bank, document } = startBank(db);
  bank.stop();
  await flush();
  assert.equal(bank._state().status, 'idle');
  assert.equal(document.getElementById('bankCards').children.length, 0);
});

test('balances are formatted per currency and never negative', () => {
  assert.equal(Bank.formatBalance('uah', 1234.5), (1234.5).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴');
  assert.match(Bank.formatBalance('blue', 0.5), /0,500000 Blue$/);
  assert.match(Bank.formatBalance('cryp', -5), /^0,000 CRYP$/);
});

test('the page is wired in as the sixth menu item and the bank never writes players or the economy', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal((html.match(/class="nav-button[^"]*" type="button" data-page="/g) || []).length, 6);
  assert.match(html, /data-page="bank">Банк</);
  assert.match(html, /id="page-bank"/);
  const source = fs.readFileSync(path.join(root, 'bank.js'), 'utf8');
  assert.ok(!/collection\("players"\)|collection\("market|collection\("podiumPlayers"\)|runTransaction/.test(source));
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.match(rules, /match \/bankAccounts\/\{accountId\}/);
  assert.match(rules, /match \/cardNumbers\/\{cardNumber\}/);
});

test('a taken card number is retried by the server, and the other player\'s reservation is untouched', async () => {
  const serverBank = require('../functions/lib/bank.js');
  const taken = serverBank.generateCardNumber('uah', () => 0);
  const db = makeDb({ [`cardNumbers/${taken}`]: { uid: 'u9', currency: 'uah' } });
  let calls = 0;
  const { bank } = startBank(db, 'u1', { randomDigit: () => (calls++ < 11 ? 0 : 1) });
  await flush();
  assert.equal(await bank.openAccount('uah'), true);
  const account = db.documents['bankAccounts/u1_uah'];
  assert.notEqual(account.cardNumber, taken);
  assert.deepEqual(db.documents[`cardNumbers/${taken}`], { uid: 'u9', currency: 'uah' });
});

test('a failed server call shows a message and does not create a card', async () => {
  const db = makeDb();
  const { bank, document } = startBank(db, 'u1', { fail: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    await flush();
    assert.equal(await bank.openAccount('uah'), false);
  } finally {
    console.error = originalError;
  }
  assert.equal(bank._state().accounts.uah, undefined);
  assert.match(document.getElementById('bankStatus').textContent, /Не вдалося відкрити рахунок UAH/);
});

test('the browser cannot write bank documents: the rules are read-only and the registry is closed', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'bank.js'), 'utf8');
  assert.ok(!/\.set\(|\.batch\(|\.update\(|\.add\(/.test(source), 'bank.js has no Firestore writes');
  assert.match(source, /httpsCallable\("openBankAccount"\)/);
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.match(rules, /match \/bankAccounts\/\{accountId\}[\s\S]*?allow write: if false;/);
  assert.match(rules, /match \/cardNumbers\/\{cardNumber\}\s*\{\s*allow read, write: if false;/);
});
