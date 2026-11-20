(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CrypBank = api.create();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /*
   * CRYP BANK (beta): the "Банк" page shows one card per currency with the player's balance.
   *
   * Scope of the beta: view balances and open accounts. There are no transfers, no history and no EURO.
   *
   * The card shows the balance that already exists in the game (players/{uid}: cash, cryp, blue). Opening an
   * account only creates a card; it never creates money, moves money or touches the player's save, the
   * rates, mining or the Podium.
   *
   * Storage (Cloud Firestore):
   *  - bankAccounts/{uid}_{currency}: { uid, currency, cardNumber, openedAt } — the player's own account.
   *    The document id is fixed per player and currency, and the document can only be created, so a player
   *    can hold at most one account per currency.
   *  - cardNumbers/{cardNumber}: { uid, currency, createdAt } — a write-only reservation that keeps the
   *    16-digit card number unique. Both documents are written in one batch.
   */

  const COLLECTION_ACCOUNTS = "bankAccounts";
  const COLLECTION_CARD_NUMBERS = "cardNumbers";
  const MAX_OPEN_ATTEMPTS = 4;

  // The card number starts with a bank prefix per currency, then 11 random digits and a Luhn check digit.
  const CURRENCIES = [
    { id: "uah", code: "UAH", name: "Українська гривня", symbol: "₴", digits: 2, prefix: "9001", balanceKey: "cash" },
    { id: "cryp", code: "CRYP", name: "Криптовалюта CRYP", symbol: "CRYP", digits: 3, prefix: "9002", balanceKey: "cryp" },
    { id: "blue", code: "Blue", name: "Криптовалюта Blue", symbol: "Blue", digits: 6, prefix: "9003", balanceKey: "blue" }
  ];

  function currencyById(id) {
    return CURRENCIES.find((currency) => currency.id === id) || null;
  }

  function accountDocId(uid, currencyId) {
    return uid + "_" + currencyId;
  }

  function luhnCheckDigit(payload) {
    let sum = 0;
    for (let index = 0; index < payload.length; index++) {
      let digit = Number(payload[payload.length - 1 - index]);
      if (index % 2 === 0) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    return String((10 - (sum % 10)) % 10);
  }

  function isValidCardNumber(value) {
    if (typeof value !== "string" || !/^[0-9]{16}$/.test(value)) return false;
    return luhnCheckDigit(value.slice(0, 15)) === value[15];
  }

  // randomDigit(): returns an integer 0-9. The default uses the browser's cryptographic generator.
  function defaultRandomDigit() {
    const cryptoApi = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      const buffer = new Uint8Array(1);
      do { cryptoApi.getRandomValues(buffer); } while (buffer[0] >= 250);
      return buffer[0] % 10;
    }
    return Math.floor(Math.random() * 10);
  }

  function generateCardNumber(currencyId, randomDigit = defaultRandomDigit) {
    const currency = currencyById(currencyId);
    if (!currency) throw new Error("Невідома валюта: " + currencyId);
    let payload = currency.prefix;
    while (payload.length < 15) payload += String(randomDigit());
    return payload + luhnCheckDigit(payload);
  }

  function formatCardNumber(value) {
    return String(value || "").replace(/(\d{4})(?=\d)/g, "$1 ");
  }

  function formatBalance(currencyId, value) {
    const currency = currencyById(currencyId);
    const amount = Math.max(0, Number(value) || 0);
    const text = amount.toLocaleString("uk-UA", { minimumFractionDigits: currency.digits, maximumFractionDigits: currency.digits });
    return text + " " + currency.symbol;
  }

  // The documents of one opening, built in one place so the tests can check exactly what is written.
  function buildOpenAccountWrites(uid, currencyId, cardNumber, serverTimestamp) {
    return {
      accountId: accountDocId(uid, currencyId),
      account: { uid, currency: currencyId, cardNumber, openedAt: serverTimestamp },
      cardNumber,
      reservation: { uid, currency: currencyId, createdAt: serverTimestamp }
    };
  }

  function parseAccount(uid, currencyId, data) {
    if (!data || data.uid !== uid || data.currency !== currencyId || !isValidCardNumber(data.cardNumber)) return null;
    return { currency: currencyId, cardNumber: data.cardNumber };
  }

  function create(options = {}) {
    const doc = options.document || (typeof document !== "undefined" ? document : null);
    const randomDigit = options.randomDigit || defaultRandomDigit;
    const serverTimestamp = options.serverTimestamp || (() => (
      typeof window !== "undefined" && window.firebase && window.firebase.firestore
        ? window.firebase.firestore.FieldValue.serverTimestamp()
        : { serverTimestamp: true }
    ));

    let db = null;
    let uid = null;
    let session = 0;
    let status = "idle"; // idle | loading | ready | error
    let message = "";
    let accounts = {};
    let balances = { cash: 0, cryp: 0, blue: 0 };
    let opening = {};

    const element = (id) => (doc ? doc.getElementById(id) : null);

    function make(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function buildCard(currency, account) {
      const card = make("article", "bank-card bank-card-" + currency.id);
      card.setAttribute("aria-label", "Картка " + currency.code);

      const top = make("div", "bank-card-top");
      top.append(make("span", "bank-card-brand", "CRYP BANK"), make("span", "bank-card-code", currency.code));

      const balance = make("div", "bank-card-balance");
      balance.append(make("span", "bank-card-label", "Баланс"), make("strong", "bank-card-amount", formatBalance(currency.id, balances[currency.balanceKey])));

      const number = make("div", "bank-card-number", formatCardNumber(account.cardNumber));
      card.append(top, make("div", "bank-card-chip"), balance, number, make("div", "bank-card-name", currency.name));
      return card;
    }

    function buildEmptyCard(currency) {
      const card = make("article", "bank-card bank-card-empty bank-card-" + currency.id);
      card.setAttribute("aria-label", "Рахунок " + currency.code + " не відкрито");
      const top = make("div", "bank-card-top");
      top.append(make("span", "bank-card-brand", "CRYP BANK"), make("span", "bank-card-code", currency.code));
      const button = make("button", "primary-button bank-open-button", opening[currency.id] ? "Відкриваємо…" : "Відкрити рахунок " + currency.code);
      button.setAttribute("type", "button");
      button.disabled = Boolean(opening[currency.id]) || status !== "ready";
      button.addEventListener("click", () => openAccount(currency.id));
      card.append(top, make("div", "bank-card-name", currency.name), make("p", "bank-card-note", "Рахунок ще не відкрито."), button);
      return card;
    }

    function render() {
      const list = element("bankCards");
      const statusNode = element("bankStatus");
      if (statusNode) {
        statusNode.textContent = status === "loading" ? "Завантажуємо рахунки…" : message;
      }
      if (!list || !doc) return;
      if (status === "idle" || status === "loading") {
        list.replaceChildren();
        return;
      }
      if (status === "error" && !Object.keys(accounts).length) {
        list.replaceChildren();
        return;
      }
      list.replaceChildren(...CURRENCIES.map((currency) => (
        accounts[currency.id] ? buildCard(currency, accounts[currency.id]) : buildEmptyCard(currency)
      )));
    }

    function setBalances(next) {
      if (!next) return;
      const updated = {
        cash: Math.max(0, Number(next.cash) || 0),
        cryp: Math.max(0, Number(next.cryp) || 0),
        blue: Math.max(0, Number(next.blue) || 0)
      };
      // Mining changes the balances every second: redraw only when a displayed value actually changed.
      const shownChanged = CURRENCIES.some((currency) => (
        formatBalance(currency.id, updated[currency.balanceKey]) !== formatBalance(currency.id, balances[currency.balanceKey])
      ));
      balances = updated;
      if (status === "ready" && shownChanged) render();
    }

    async function load() {
      const mySession = session;
      status = "loading";
      message = "";
      render();
      try {
        const snapshots = await Promise.all(CURRENCIES.map((currency) => (
          db.collection(COLLECTION_ACCOUNTS).doc(accountDocId(uid, currency.id)).get()
        )));
        if (mySession !== session) return;
        accounts = {};
        snapshots.forEach((snapshot, index) => {
          if (!snapshot.exists) return;
          const account = parseAccount(uid, CURRENCIES[index].id, snapshot.data());
          if (account) accounts[CURRENCIES[index].id] = account;
        });
        status = "ready";
        message = "";
      } catch (error) {
        if (mySession !== session) return;
        console.error("Не вдалося завантажити банківські рахунки:", error);
        status = "error";
        message = "Банк недоступний — перевір правила Firestore (опублікуй оновлений firestore.rules).";
      }
      render();
    }

    async function openAccount(currencyId) {
      const currency = currencyById(currencyId);
      if (!currency || !db || !uid || status !== "ready") return false;
      if (accounts[currencyId] || opening[currencyId]) return false;
      const mySession = session;
      opening[currencyId] = true;
      message = "";
      render();
      let opened = false;
      try {
        for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS && !opened; attempt++) {
          const cardNumber = generateCardNumber(currencyId, randomDigit);
          const writes = buildOpenAccountWrites(uid, currencyId, cardNumber, serverTimestamp());
          const batch = db.batch();
          batch.set(db.collection(COLLECTION_CARD_NUMBERS).doc(writes.cardNumber), writes.reservation);
          batch.set(db.collection(COLLECTION_ACCOUNTS).doc(writes.accountId), writes.account);
          try {
            await batch.commit();
            opened = true;
            if (mySession === session) accounts[currencyId] = { currency: currencyId, cardNumber };
          } catch (error) {
            // A taken number (or a rules problem) is rejected as permission-denied: try another number a few times.
            if (attempt === MAX_OPEN_ATTEMPTS) throw error;
          }
        }
      } catch (error) {
        console.error("Не вдалося відкрити рахунок " + currency.code + ":", error);
        if (mySession === session) message = "Не вдалося відкрити рахунок " + currency.code + ". Спробуй ще раз або перевір правила Firestore.";
      }
      if (mySession === session) {
        delete opening[currencyId];
        render();
      }
      return opened;
    }

    function start(database, playerUid) {
      stop();
      if (!database || !playerUid) return;
      db = database;
      uid = playerUid;
      load();
    }

    function stop() {
      session += 1;
      db = null;
      uid = null;
      status = "idle";
      message = "";
      accounts = {};
      opening = {};
      render();
    }

    return {
      start, stop, setBalances, render, openAccount,
      _state: () => ({ status, message, accounts: { ...accounts }, balances: { ...balances } })
    };
  }

  return {
    COLLECTION_ACCOUNTS, COLLECTION_CARD_NUMBERS, CURRENCIES, MAX_OPEN_ATTEMPTS,
    currencyById, accountDocId, luhnCheckDigit, isValidCardNumber, generateCardNumber,
    formatCardNumber, formatBalance, buildOpenAccountWrites, parseAccount, create
  };
});
