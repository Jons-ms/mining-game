"use strict";
/*
 * CRYP Mining Cloud Functions. The browser can no longer write balances: every economic change goes through
 * `gameAction` / `heartbeat` / `initPlayer`, runs in a Firestore transaction on the server clock, and is
 * computed by lib/engine.js (unit-tested without Firebase).
 *
 * Free-quota design: one read + one write per call; no realtime listeners on the player document;
 * ignored/no-op heartbeats cost no write; the Podium is one scheduled job per hour and one document.
 * Rates still come from the client-driven documents market/exchangeRate and market/blueExchangeRate
 * (their move to the server is a separate, postponed stage).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const engine = require("./lib/engine.js");
const bank = require("./lib/bank.js");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 5, memory: "256MiB" });

const PLAYERS = "players";
const FieldValue = admin.firestore.FieldValue;

function requireUid(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Потрібен вхід в акаунт.");
  return request.auth.uid;
}

function wrap(error) {
  if (error instanceof engine.GameError) return new HttpsError(error.code, error.message);
  if (error instanceof HttpsError) return error;
  console.error(error);
  return new HttpsError("internal", "Серверна помилка. Спробуй ще раз.");
}

// What the browser may see: the game state without internal bookkeeping.
function publicState(state) {
  const { recentOps, ...visible } = state; // eslint-disable-line no-unused-vars
  return visible;
}

function storedDoc(state) {
  return { ...state, serverManaged: true, schema: 2, updatedAt: FieldValue.serverTimestamp() };
}

async function readRates(transaction) {
  const [cryp, blue] = await Promise.all([
    transaction.get(db.collection("market").doc("exchangeRate")),
    transaction.get(db.collection("market").doc("blueExchangeRate"))
  ]);
  return {
    cryp: cryp.exists ? Number(cryp.data().price) : NaN,
    blue: blue.exists ? Number(blue.data().price) : NaN
  };
}

// Creates the server-managed player document, or returns the existing one.
// An existing pre-migration document is normalised in place (nothing is dropped);
// a newer pre-migration local save sent by the browser is used only for such a document.
exports.initPlayer = onCall(async (request) => {
  const uid = requireUid(request);
  try {
    const ref = db.collection(PLAYERS).doc(uid);
    const result = await db.runTransaction(async (transaction) => {
      const nowMs = Date.now();
      const snapshot = await transaction.get(ref);
      if (snapshot.exists && snapshot.data().serverManaged === true) {
        const existing = engine.normalizeState(snapshot.data(), nowMs);
        // A new session starts a fresh mining clock, so the first heartbeat pays exactly the time since login
        // (the time while the game was closed is never paid). One write per login, only after a real break.
        if (nowMs - existing.lastMiningAt > engine.MAX_GAP_MS) {
          existing.lastMiningAt = nowMs;
          transaction.set(ref, storedDoc(existing));
        }
        return existing;
      }
      let state;
      if (!snapshot.exists) {
        state = engine.newState(nowMs);
      } else {
        const stored = snapshot.data();
        const legacy = request.data && request.data.legacySave;
        const newer = legacy && Number(legacy.savedAt) > (Number(stored.savedAt) || 0) && Array.isArray(legacy.slots);
        state = engine.normalizeState(newer ? legacy : stored, 0);
        state.lastMiningAt = nowMs; // no mining credit for the time before the migration
      }
      transaction.set(ref, storedDoc(state));
      return state;
    });
    return { state: publicState(result), serverNow: Date.now() };
  } catch (error) {
    throw wrap(error);
  }
});

exports.gameAction = onCall(async (request) => {
  const uid = requireUid(request);
  const data = request.data || {};
  try {
    const ref = db.collection(PLAYERS).doc(uid);
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().serverManaged !== true) {
        throw new engine.GameError("failed-precondition", "Збереження ще не підключено до сервера. Перезавантаж гру.");
      }
      const nowMs = Date.now();
      const state = engine.normalizeState(snapshot.data(), nowMs);
      const rates = data.type === "sellCurrency" ? await readRates(transaction) : {};
      const applied = engine.applyAction(state, { type: data.type, payload: data.payload, opId: data.opId },
        { nowMs, rates, random: Math.random });
      if (!applied.duplicate) transaction.set(ref, storedDoc(applied.state));
      return applied;
    });
    return { state: publicState(result.state), duplicate: result.duplicate, serverNow: Date.now() };
  } catch (error) {
    throw wrap(error);
  }
});

exports.heartbeat = onCall(async (request) => {
  const uid = requireUid(request);
  try {
    const ref = db.collection(PLAYERS).doc(uid);
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().serverManaged !== true) {
        throw new engine.GameError("failed-precondition", "Збереження ще не підключено до сервера.");
      }
      const nowMs = Date.now();
      const state = engine.normalizeState(snapshot.data(), nowMs);
      const beat = engine.applyHeartbeat(state, nowMs);
      if (beat.changed) transaction.set(ref, storedDoc(beat.state));
      return beat.state;
    });
    return { state: publicState(result), serverNow: Date.now() };
  } catch (error) {
    throw wrap(error);
  }
});

// CRYP BANK: the server opens the account and picks a unique 16-digit number. One account per player and
// currency (the document id), idempotent: a repeated call returns the existing card and creates nothing.
const MAX_CARD_ATTEMPTS = 8;
exports.openBankAccount = onCall(async (request) => {
  const uid = requireUid(request);
  const currency = request.data && request.data.currency;
  if (!Object.prototype.hasOwnProperty.call(bank.CURRENCIES, currency)) {
    throw new HttpsError("invalid-argument", "Невідома валюта.");
  }
  try {
    const accountRef = db.collection("bankAccounts").doc(bank.accountId(uid, currency));
    for (let attempt = 1; attempt <= MAX_CARD_ATTEMPTS; attempt += 1) {
      const cardNumber = bank.generateCardNumber(currency);
      const cardRef = db.collection("cardNumbers").doc(cardNumber);
      const result = await db.runTransaction(async (transaction) => {
        const [account, card] = await Promise.all([transaction.get(accountRef), transaction.get(cardRef)]);
        if (account.exists) return { cardNumber: account.data().cardNumber, created: false };
        if (card.exists) return null; // number taken: try another one
        transaction.set(cardRef, { uid, currency, createdAt: FieldValue.serverTimestamp() });
        transaction.set(accountRef, { uid, currency, cardNumber, openedAt: FieldValue.serverTimestamp() });
        return { cardNumber, created: true };
      });
      if (result) return { currency, cardNumber: result.cardNumber, created: result.created };
    }
    throw new HttpsError("resource-exhausted", "Не вдалося підібрати номер картки. Спробуй ще раз.");
  } catch (error) {
    throw wrap(error);
  }
});

// Hourly Podium snapshot: one query, one write. Rates are read at the moment of the snapshot.
async function buildPodiumSnapshot() {
  const [players, cryp, blue] = await Promise.all([
    db.collection(PLAYERS).where("serverManaged", "==", true).get(),
    db.collection("market").doc("exchangeRate").get(),
    db.collection("market").doc("blueExchangeRate").get()
  ]);
  const rates = {
    cryp: cryp.exists ? Number(cryp.data().price) : 0.25,
    blue: blue.exists ? Number(blue.data().price) : 4.25
  };
  const entries = engine.buildPodium(players.docs.map((doc) => ({ uid: doc.id, state: doc.data() })), rates);
  await db.collection("podium").doc("current").set({
    entries, rates, playerCount: players.size, updatedAt: FieldValue.serverTimestamp()
  });
  return entries.length;
}
exports.buildPodiumSnapshot = buildPodiumSnapshot;

exports.hourlyPodium = onSchedule({ schedule: "every 60 minutes", timeZone: "Europe/Kyiv", retryCount: 1 }, async () => {
  await buildPodiumSnapshot();
});
