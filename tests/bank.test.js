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

// Minimal Firestore double: get(), and a batch that fails like the rules do when a document already exists.
function makeDb(seed = {}, options = {}) {
  const documents = { ...seed };
  const commits = [];
  const db = {
    documents, commits,
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
    },
    batch() {
      const operations = [];
      return {
        set(ref, data) { operations.push({ ref, data }); },
        async commit() {
          if (options.failCommit) throw new Error('permission-denied');
          if (operations.some((operation) => documents[operation.ref.path] !== undefined)) throw new Error('already-exists');
          operations.forEach((operation) => { documents[operation.ref.path] = { ...operation.data }; });
          commits.push(operations.map((operation) => operation.ref.path));
        }
      };
    }
  };
  return db;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const stamp = () => ({ serverTimestamp: true });

function makeBank(overrides = {}) {
  const document = makeDocument();
  let counter = 0;
  const bank = Bank.create({ document, serverTimestamp: stamp, randomDigit: () => (counter++ * 7 + 3) % 10, ...overrides });
  return { bank, document };
}

test('the game has exactly three currencies and no EURO', () => {
  assert.deepEqual(Bank.CURRENCIES.map((currency) => currency.id), ['uah', 'cryp', 'blue']);
  assert.equal(Bank.currencyById('euro'), null);
});

test('card numbers have 16 digits, a currency prefix and a valid Luhn check digit', () => {
  Bank.CURRENCIES.forEach((currency) => {
    for (let index = 0; index < 50; index++) {
      const number = Bank.generateCardNumber(currency.id);
      assert.match(number, /^[0-9]{16}$/);
      assert.ok(number.startsWith(currency.prefix));
      assert.ok(Bank.isValidCardNumber(number));
    }
  });
  assert.throws(() => Bank.generateCardNumber('euro'));
  const valid = Bank.generateCardNumber('uah');
  const wrongCheck = valid.slice(0, 15) + String((Number(valid[15]) + 1) % 10);
  assert.equal(Bank.isValidCardNumber(wrongCheck), false);
  assert.equal(Bank.isValidCardNumber('abc'), false);
  assert.equal(Bank.formatCardNumber('9001123412341234'), '9001 1234 1234 1234');
});

test('open-account documents carry no money and are tied to one player and currency', () => {
  const writes = Bank.buildOpenAccountWrites('u1', 'cryp', '9002000000000007', stamp());
  assert.equal(writes.accountId, 'u1_cryp');
  assert.deepEqual(Object.keys(writes.account).sort(), ['cardNumber', 'currency', 'openedAt', 'uid']);
  assert.deepEqual(Object.keys(writes.reservation).sort(), ['createdAt', 'currency', 'uid']);
  assert.ok(!('balance' in writes.account));
});

test('no accounts are created on start; the cards offer to open them', async () => {
  const db = makeDb();
  const { bank, document } = makeBank();
  bank.start(db, 'u1');
  await flush();
  assert.equal(bank._state().status, 'ready');
  assert.equal(db.commits.length, 0);
  assert.deepEqual(Object.keys(db.documents), []);
  const cards = document.getElementById('bankCards').children;
  assert.equal(cards.length, 3);
  cards.forEach((card) => assert.ok(card.className.includes('bank-card-empty')));
  assert.ok(texts(document.getElementById('bankCards')).some((text) => text.startsWith('Відкрити рахунок')));
});

test('opening an account stores it in Firestore and shows the existing balance unchanged', async () => {
  const db = makeDb();
  const { bank, document } = makeBank();
  bank.start(db, 'u1');
  bank.setBalances({ cash: 1234.5, cryp: 10.25, blue: 0.5 });
  await flush();
  assert.equal(await bank.openAccount('uah'), true);

  assert.equal(db.commits.length, 1);
  assert.deepEqual(db.commits[0].sort(), ['bankAccounts/u1_uah', `cardNumbers/${db.documents['bankAccounts/u1_uah'].cardNumber}`].sort());
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
  const { bank } = makeBank();
  bank.start(db, 'u1');
  await flush();
  assert.equal(await bank.openAccount('blue'), true);
  const before = JSON.stringify(db.documents);
  assert.equal(await bank.openAccount('blue'), false);
  assert.equal(JSON.stringify(db.documents), before);
  assert.equal(db.commits.length, 1);
});

test('accounts survive a new login or another device', async () => {
  const db = makeDb();
  const first = makeBank().bank;
  first.start(db, 'u1');
  await flush();
  await first.openAccount('cryp');
  const number = db.documents['bankAccounts/u1_cryp'].cardNumber;
  first.stop();

  const second = makeBank();
  second.bank.start(db, 'u1');
  await flush();
  assert.equal(second.bank._state().accounts.cryp.cardNumber, number);
  assert.equal(second.bank._state().accounts.uah, undefined);
});

test("another player's accounts are not shown", async () => {
  const db = makeDb();
  const owner = makeBank().bank;
  owner.start(db, 'u1');
  await flush();
  await owner.openAccount('uah');

  const other = makeBank().bank;
  other.start(db, 'u2');
  await flush();
  assert.deepEqual(other._state().accounts, {});
});

test('a taken card number is retried with another number', async () => {
  // First attempt generates all zeros (already reserved by someone else), the second all ones.
  const taken = Bank.generateCardNumber('uah', () => 0);
  const db = makeDb({ [`cardNumbers/${taken}`]: { uid: 'u9', currency: 'uah' } });
  let calls = 0;
  const { bank } = makeBank({ randomDigit: () => (calls++ < 11 ? 0 : 1) });
  bank.start(db, 'u1');
  await flush();
  assert.equal(await bank.openAccount('uah'), true);
  const account = db.documents['bankAccounts/u1_uah'];
  assert.notEqual(account.cardNumber, taken);
  assert.ok(Bank.isValidCardNumber(account.cardNumber));
  // the other player's reservation is untouched and exactly one new reservation was added
  assert.deepEqual(db.documents[`cardNumbers/${taken}`], { uid: 'u9', currency: 'uah' });
  assert.equal(Object.keys(db.documents).filter((key) => key.startsWith('cardNumbers/')).length, 2);
});

test('gives up after the maximum number of attempts when every number is taken', async () => {
  const taken = Bank.generateCardNumber('uah', () => 0);
  const db = makeDb({ [`cardNumbers/${taken}`]: { uid: 'u9', currency: 'uah' } });
  const { bank } = makeBank({ randomDigit: () => 0 });
  const originalError = console.error;
  console.error = () => {};
  try {
    bank.start(db, 'u1');
    await flush();
    assert.equal(await bank.openAccount('uah'), false);
  } finally {
    console.error = originalError;
  }
  assert.equal(db.documents['bankAccounts/u1_uah'], undefined);
});

test('a failed write shows a message and does not create a card', async () => {
  const db = makeDb({}, { failCommit: true });
  const { bank, document } = makeBank();
  const originalError = console.error;
  console.error = () => {};
  try {
    bank.start(db, 'u1');
    await flush();
    assert.equal(await bank.openAccount('uah'), false);
  } finally {
    console.error = originalError;
  }
  assert.equal(bank._state().accounts.uah, undefined);
  assert.match(document.getElementById('bankStatus').textContent, /Не вдалося відкрити рахунок UAH/);
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
  const { bank, document } = makeBank();
  bank.start(db, 'u1');
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
