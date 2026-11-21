"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const E = require("../lib/engine.js");

const T0 = 1_700_000_000_000;
const ctxAt = (nowMs, rates = { cryp: 2, blue: 5 }) => ({ nowMs, rates, random: () => 0.5 });
let opCounter = 0;
const act = (type, payload = {}) => ({ type, payload, opId: "op-" + String(++opCounter).padStart(8, "0") });
const withCards = (extra = {}) => {
  const state = E.newState(T0);
  state.slots[0] = { id: "rtx4090", name: "RTX 4090", icon: "▰", rate: 0.15, currency: "cryp", cost: 1200 };
  state.slots[1] = { id: "blue-rtx4060", name: "RTX 4060", icon: "▰", rate: 0.015, currency: "blue", cost: 2400 };
  return Object.assign(state, extra);
};

test("server catalog matches the GPU_TYPES in game.js (prices, rates and currencies must not drift)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "game.js"), "utf8");
  const block = source.match(/const GPU_TYPES = \[([\s\S]*?)\n  \];/)[1];
  const client = [...block.matchAll(/\{ id: "([^"]+)", name: "([^"]+)", icon: "[^"]*", price: (\d+), rate: ([\d.]+), currency: "(\w+)" \}/g)]
    .map((m) => ({ id: m[1], name: m[2], price: Number(m[3]), rate: Number(m[4]), currency: m[5] }));
  assert.equal(client.length, E.GPU_TYPES.length);
  client.forEach((gpu, i) => {
    const server = E.GPU_TYPES[i];
    assert.deepEqual({ id: server.id, name: server.name, price: server.price, rate: server.rate, currency: server.currency }, gpu);
  });
});

test("new player starts with 490 UAH and no cards", () => {
  const state = E.newState(T0);
  assert.equal(state.cash, 490);
  assert.equal(state.cryp, 0);
  assert.equal(state.blue, 0);
  assert.equal(E.totalRate(state, "cryp"), 0);
});

test("mining credits the gap in full when it is within the limit, using the rates of the installed cards", () => {
  const { state, credited } = E.settleMining(withCards(), T0 + 60000);
  assert.equal(credited.cryp, 9);        // 0.15 x 60
  assert.equal(credited.blue, 0.9);      // 0.015 x 60
  assert.equal(state.cryp, 9);
  assert.equal(state.lastMiningAt, T0 + 60000);
});

test("a break longer than the limit credits nothing, and the clock still moves forward", () => {
  const { state, credited } = E.settleMining(withCards(), T0 + E.MAX_GAP_MS + 1);
  assert.equal(credited.cryp, 0);
  assert.equal(state.cryp, 0);
  assert.equal(state.lastMiningAt, T0 + E.MAX_GAP_MS + 1);
});

test("two devices sending heartbeats can never be paid twice for the same seconds", () => {
  let state = withCards();
  let paid = 0;
  for (let second = 20; second <= 120; second += 20) {
    // device A and device B both report at the same server second
    for (let device = 0; device < 2; device += 1) {
      const result = E.applyHeartbeat(state, T0 + second * 1000);
      paid += result.credited.cryp;
      state = result.state;
    }
  }
  assert.equal(state.cryp, 18);          // exactly 0.15 x 120 s, not double
  assert.equal(paid, 18);
});

test("heartbeats faster than 15 s are ignored (no credit, no write)", () => {
  const result = E.applyHeartbeat(withCards(), T0 + 5000);
  assert.equal(result.changed, false);
  assert.equal(result.state.cryp, 0);
});

test("a player without installed cards causes no write on heartbeat", () => {
  const result = E.applyHeartbeat(E.newState(T0), T0 + 60000);
  assert.equal(result.changed, false);
});

test("a stored state without lastMiningAt gets no credit on the first settle", () => {
  const legacy = E.normalizeState({ cash: 10, slots: [{ id: "rtx4090", name: "RTX 4090", rate: 0.15, currency: "cryp", cost: 1200 }] });
  const { state, credited } = E.settleMining(legacy, T0);
  assert.equal(credited.cryp, 0);
  assert.equal(state.lastMiningAt, T0);
});

test("buying a card spends the exact price and adds it to the inventory, never to the farm", () => {
  const { state } = E.applyAction(E.newState(T0), act("buyGpu", { gpuId: "starter" }), ctxAt(T0 + 1000));
  assert.equal(state.cash, 240);
  assert.equal(state.inventory.length, 1);
  assert.equal(state.inventory[0].id, "starter");
  assert.equal(state.slots.filter(Boolean).length, 0);
});

test("buying is refused without enough money and does not change the original state", () => {
  const original = E.newState(T0);
  assert.throws(() => E.applyAction(original, act("buyGpu", { gpuId: "rtx4090" }), ctxAt(T0)), (e) => e.code === "failed-precondition");
  assert.equal(original.cash, 490);
  assert.equal(original.inventory.length, 0);
});

test("the client cannot name its own price or card: unknown ids are rejected", () => {
  assert.throws(() => E.applyAction(E.newState(T0), act("buyGpu", { gpuId: "free-gpu", price: 0 }), ctxAt(T0)), (e) => e.code === "invalid-argument");
});

test("a retried operation id is not applied twice", () => {
  const action = act("buyGpu", { gpuId: "starter" });
  const first = E.applyAction(E.newState(T0), action, ctxAt(T0 + 1000));
  const second = E.applyAction(first.state, action, ctxAt(T0 + 2000));
  assert.equal(second.duplicate, true);
  assert.equal(second.state.cash, 240);
  assert.equal(second.state.inventory.length, 1);
});

test("an action without a valid operation id is rejected", () => {
  assert.throws(() => E.applyAction(E.newState(T0), { type: "buyGpu", payload: { gpuId: "starter" } }, ctxAt(T0)), (e) => e.code === "invalid-argument");
});

test("install, remove and sell: selling an installed card returns exactly 50% of its stored cost", () => {
  let state = E.applyAction(E.newState(T0), act("buyGpu", { gpuId: "starter" }), ctxAt(T0)).state;
  const inventoryId = state.inventory[0].inventoryId;
  state = E.applyAction(state, act("installGpu", { field: 0, index: 3, inventoryId }), ctxAt(T0)).state;
  assert.equal(state.slots[3].id, "starter");
  assert.equal(state.inventory.length, 0);
  state = E.applyAction(state, act("removeGpu", { field: 0, index: 3 }), ctxAt(T0)).state;
  assert.equal(state.inventory.length, 1);
  assert.equal(state.slots[3], null);
  state = E.applyAction(state, act("installGpu", { field: 0, index: 3, inventoryId: state.inventory[0].inventoryId }), ctxAt(T0)).state;
  state = E.applyAction(state, act("sellGpu", { field: 0, index: 3 }), ctxAt(T0)).state;
  assert.equal(state.cash, 240 + 125);
  assert.equal(state.slots[3], null);
});

test("an occupied cell, a missing inventory card and the locked extra field are all refused", () => {
  const state = withCards();
  state.inventory.push({ inventoryId: "inv-1", id: "starter", name: "Starter GPU", icon: "▰", rate: 0.02, currency: "cryp", cost: 250 });
  assert.throws(() => E.applyAction(state, act("installGpu", { field: 0, index: 0, inventoryId: "inv-1" }), ctxAt(T0)), (e) => e.code === "failed-precondition");
  assert.throws(() => E.applyAction(state, act("installGpu", { field: 0, index: 5, inventoryId: "nope" }), ctxAt(T0)), (e) => e.code === "not-found");
  assert.throws(() => E.applyAction(state, act("installGpu", { field: 1, index: 0, inventoryId: "inv-1" }), ctxAt(T0)), (e) => e.code === "failed-precondition");
});

test("an action settles mining at the OLD rates before the card set changes", () => {
  const state = withCards({ cash: 0 });
  const { state: after } = E.applyAction(state, act("sellGpu", { field: 0, index: 0 }), ctxAt(T0 + 60000));
  assert.equal(after.cryp, 9);           // the sold card still earned its last 60 s
  assert.equal(E.totalRate(after, "cryp"), 0);
});

test("selling CRYP uses the server-side rate, accepts the rounded on-screen amount and never goes negative", () => {
  const state = withCards({ cryp: 10.0004 });
  const { state: after } = E.applyAction(state, act("sellCurrency", { currency: "cryp", amount: 10.0004 }), ctxAt(T0, { cryp: 2, blue: 5 }));
  assert.equal(after.cryp, 0);
  assert.equal(after.cash, E.roundCash(490 + 10.0004 * 2));
  assert.throws(() => E.applyAction(after, act("sellCurrency", { currency: "cryp", amount: 1 }), ctxAt(T0)), (e) => e.code === "failed-precondition");
});

test("selling Blue works with fractions and rejects overselling, zero, negative and NaN amounts", () => {
  const state = withCards({ blue: 1.5 });
  const { state: after } = E.applyAction(state, act("sellCurrency", { currency: "blue", amount: 0.5 }), ctxAt(T0, { cryp: 2, blue: 6 }));
  assert.equal(after.blue, 1);
  assert.equal(after.cash, 493);
  for (const amount of [0, -1, NaN, "abc", 5]) {
    assert.throws(() => E.applyAction(state, act("sellCurrency", { currency: "blue", amount }), ctxAt(T0)));
  }
});

test("selling needs a loaded server rate", () => {
  const state = withCards({ cryp: 5 });
  assert.throws(() => E.applyAction(state, act("sellCurrency", { currency: "cryp", amount: 1 }), { nowMs: T0, rates: {}, random: Math.random }), (e) => e.code === "unavailable");
});

test("extra field and extra cells cost 5 000 and 10 000 UAH and cannot be bought twice", () => {
  let state = E.newState(T0);
  state.cash = 16000;
  state = E.applyAction(state, act("buyExtraField"), ctxAt(T0)).state;
  assert.equal(state.hasExtraField, true);
  assert.equal(state.cash, 11000);
  assert.throws(() => E.applyAction(state, act("buyExtraField"), ctxAt(T0)));
  state = E.applyAction(state, act("buyExtraCell", { index: 9 }), ctxAt(T0)).state;
  assert.equal(state.extraUnlockedSlots[9], true);
  assert.equal(state.cash, 1000);
  assert.throws(() => E.applyAction(state, act("buyExtraCell", { index: 9 }), ctxAt(T0)));
});

test("player name is trimmed to 20 characters", () => {
  const { state } = E.applyAction(E.newState(T0), act("setPlayerName", { name: "  " + "x".repeat(40) + "  " }), ctxAt(T0));
  assert.equal(state.playerName.length, 20);
});

test("normalizing an old save keeps cash, CRYP, cards and fields, and gives Blue 0", () => {
  const saved = {
    playerName: "Оля", cash: 1234.5, cryp: 7.25,
    slots: [{ id: "starter", name: "Starter GPU", icon: "▰", rate: 0.02, cost: 250 }],
    inventory: [{ inventoryId: "a", id: "rtx3060", name: "RTX 3060", rate: 0.06, cost: 600 }],
    hasExtraField: true
  };
  const state = E.normalizeState(saved);
  assert.equal(state.cash, 1234.5);
  assert.equal(state.cryp, 7.25);
  assert.equal(state.blue, 0);
  assert.equal(state.slots[0].currency, "cryp");
  assert.equal(state.inventory[0].inventoryId, "a");
  assert.equal(state.hasExtraField, true);
  assert.equal(state.extraUnlockedSlots.filter(Boolean).length, 8);
});

test("normalizing never produces negative or non-numeric balances", () => {
  const state = E.normalizeState({ cash: -5, cryp: "abc", blue: NaN });
  assert.equal(state.cash, 0);
  assert.equal(state.cryp, 0);
  assert.equal(state.blue, 0);
});

test("podium ranks by cash + CRYP x rate + Blue x rate, keeps only 10 and never exposes UIDs", () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ uid: "uid-" + i, state: { playerName: "P" + i, cash: i * 100, cryp: 0, blue: 0 } }));
  players.push({ uid: "rich-cryp", state: { playerName: "Rich", cash: 0, cryp: 1000, blue: 10 } });
  const board = E.buildPodium(players, { cryp: 2, blue: 5 });
  assert.equal(board.length, 10);
  assert.equal(board[0].nickname, "Rich");
  assert.equal(board[0].totalCapital, 2050);
  assert.equal(board[0].rank, 1);
  assert.ok(board.every((row) => !("uid" in row)));
  assert.deepEqual(board.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
