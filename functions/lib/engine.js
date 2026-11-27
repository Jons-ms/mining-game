"use strict";
/*
 * CRYP Mining: server-side game engine. Pure functions only (no Firebase), so every rule can be unit-tested.
 * Numbers mirror the client code in game.js; do not change prices, rates or mechanics here without
 * changing them everywhere and getting the owner's approval.
 */

const SLOT_COUNT = 16;
const FIELD_PRICE = 5000;
const FIELD_CELL_PRICE = 10000;
const INITIAL_EXTRA_UNLOCKED = 8;
const START_CASH = 490;
const SELL_BACK_RATE = 0.5;
const MIN_SELL_AMOUNT = 0.000001;
const SELL_TOLERANCE_DIGITS = { cryp: 3, blue: 6 }; // balances are shown rounded on screen
const MAX_RECENT_OPS = 30;
// Mining: the client sends a heartbeat every 60 s. A gap up to MAX_GAP_MS is credited in full
// (60 s rule + 15 s for network jitter); a longer gap credits nothing (no offline mining).
const HEARTBEAT_INTERVAL_MS = 60000;
const MAX_GAP_MS = 75000;
const MIN_HEARTBEAT_GAP_MS = 15000; // faster heartbeats are ignored (protects the free write quota)

const GPU_TYPES = [
  { id: "starter", name: "Starter GPU", icon: "▰", price: 250, rate: 0.02, currency: "cryp" },
  { id: "rtx3060", name: "RTX 3060", icon: "▰", price: 600, rate: 0.06, currency: "cryp" },
  { id: "rtx4090", name: "RTX 4090", icon: "▰", price: 1200, rate: 0.15, currency: "cryp" },
  { id: "blue-rtx4060", name: "RTX 4060", icon: "▰", price: 2400, rate: 0.015, currency: "blue" },
  { id: "blue-rtx3070", name: "RTX 3070", icon: "▰", price: 10000, rate: 0.06, currency: "blue" },
  { id: "blue-rtx4070", name: "RTX 4070", icon: "▰", price: 15000, rate: 0.08, currency: "blue" }
];

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // maps to a Firebase HttpsError code in index.js
  }
}

const round = (value, digits) => {
  const factor = Math.pow(10, digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const roundCash = (value) => round(value, 2);
const roundCoin = (value) => round(value, 6);
const finiteNonNegative = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

function gpuType(id) {
  return GPU_TYPES.find((type) => type.id === id) || null;
}

function newState(now = 0) {
  return {
    playerName: "Гравець 1",
    cash: START_CASH,
    cryp: 0,
    blue: 0,
    slots: Array(SLOT_COUNT).fill(null),
    inventory: [],
    hasExtraField: false,
    extraSlots: Array(SLOT_COUNT).fill(null),
    extraUnlockedSlots: Array.from({ length: SLOT_COUNT }, (_, index) => index < INITIAL_EXTRA_UNLOCKED),
    lastMiningAt: now,
    recentOps: []
  };
}

// Same shape rules as the client's normalizeSavedState. Existing cards keep their stored values
// (the migration report lists any that differ from the catalog); only unknown currencies are fixed.
function normalizeGpu(gpu) {
  if (!gpu || typeof gpu !== "object") return null;
  const known = gpuType(gpu.id);
  const stored = Number(gpu.cost);
  return {
    ...(gpu.inventoryId ? { inventoryId: String(gpu.inventoryId) } : {}),
    id: String(gpu.id),
    name: String(gpu.name || known?.name || gpu.id),
    icon: String(gpu.icon || known?.icon || "▰"),
    rate: finiteNonNegative(gpu.rate ?? known?.rate),
    currency: known?.currency || (gpu.currency === "blue" ? "blue" : "cryp"),
    cost: Number.isFinite(stored) && stored > 0 ? stored : (known?.price ?? 0)
  };
}

function normalizeState(saved, now = 0) {
  const base = newState(now);
  const source = saved && typeof saved === "object" ? saved : {};
  const slotsOf = (list) => Array.from({ length: SLOT_COUNT }, (_, index) => normalizeGpu(Array.isArray(list) ? list[index] : null));
  const unlocks = Array.isArray(source.extraUnlockedSlots) && source.extraUnlockedSlots.length ? source.extraUnlockedSlots : null;
  return {
    playerName: String(source.playerName || base.playerName).trim().slice(0, 20) || base.playerName,
    cash: roundCash(finiteNonNegative(source.cash ?? base.cash)),
    cryp: roundCoin(finiteNonNegative(source.cryp)),
    blue: roundCoin(finiteNonNegative(source.blue)),
    slots: slotsOf(source.slots),
    inventory: Array.isArray(source.inventory) ? source.inventory.map(normalizeGpu).filter(Boolean) : [],
    hasExtraField: source.hasExtraField === true,
    extraSlots: slotsOf(source.extraSlots),
    extraUnlockedSlots: Array.from({ length: SLOT_COUNT }, (_, index) => unlocks ? unlocks[index] === true : index < INITIAL_EXTRA_UNLOCKED),
    lastMiningAt: Number.isFinite(Number(source.lastMiningAt)) ? Number(source.lastMiningAt) : now,
    recentOps: Array.isArray(source.recentOps) ? source.recentOps.map(String).slice(-MAX_RECENT_OPS) : []
  };
}

function installedGpus(state) {
  return state.slots.concat(state.hasExtraField ? state.extraSlots : []).filter(Boolean);
}

function totalRate(state, currency) {
  return installedGpus(state).reduce((sum, gpu) => sum + (gpu.currency === currency ? (gpu.rate || 0) : 0), 0);
}

/*
 * Credits mining for the time since the last credit, using SERVER time only.
 * Every credit moves lastMiningAt forward, so the same seconds can never be paid twice,
 * whichever device or tab asks. Returns { state, credited: {cryp, blue}, gapMs }.
 */
function settleMining(state, nowMs) {
  const last = Number(state.lastMiningAt) || 0;
  const gapMs = nowMs - last;
  const result = { ...state, lastMiningAt: nowMs };
  const credited = { cryp: 0, blue: 0 };
  if (last > 0 && gapMs > 0 && gapMs <= MAX_GAP_MS) {
    credited.cryp = roundCoin(totalRate(state, "cryp") * gapMs / 1000);
    credited.blue = roundCoin(totalRate(state, "blue") * gapMs / 1000);
    result.cryp = roundCoin(state.cryp + credited.cryp);
    result.blue = roundCoin(state.blue + credited.blue);
  }
  return { state: result, credited, gapMs };
}

function fieldSlots(state, field) {
  if (field === 1) {
    if (!state.hasExtraField) throw new GameError("failed-precondition", "Додаткове поле ще не придбано.");
    return state.extraSlots;
  }
  if (field === 0) return state.slots;
  throw new GameError("invalid-argument", "Невідоме поле ферми.");
}

function slotIndexOf(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= SLOT_COUNT) throw new GameError("invalid-argument", "Невірна клітинка.");
  return index;
}

function newInventoryId(nowMs, random) {
  return String(nowMs) + "-" + Math.floor(random() * 0xffffff).toString(36).padStart(4, "0");
}

function toInventoryItem(gpu, nowMs, random) {
  return {
    inventoryId: newInventoryId(nowMs, random),
    id: gpu.id, name: gpu.name, icon: gpu.icon || "▰", rate: gpu.rate || 0,
    currency: gpu.currency || "cryp", cost: Number(gpu.cost) || (gpuType(gpu.id)?.price ?? 0)
  };
}

function toSlotItem(gpu) {
  return {
    id: gpu.id, name: gpu.name, icon: gpu.icon, rate: gpu.rate, currency: gpu.currency || "cryp",
    cost: Number(gpu.cost) || (gpuType(gpu.id)?.price ?? 0)
  };
}

function resolveSellAmount(amount, balance, digits) {
  if (!Number.isFinite(amount) || amount <= 0) throw new GameError("invalid-argument", "Введи кількість для продажу.");
  const tolerance = 0.5 * Math.pow(10, -digits) + 1e-9;
  if (amount > balance + tolerance) throw new GameError("failed-precondition", "Недостатньо коштів для цієї операції.");
  const result = Math.min(amount, balance);
  if (result < MIN_SELL_AMOUNT) throw new GameError("invalid-argument", "Занадто мала кількість для продажу.");
  return result;
}

const ACTIONS = {
  buyGpu(state, payload, ctx) {
    const type = gpuType(payload.gpuId);
    if (!type) throw new GameError("invalid-argument", "Невідома відеокарта.");
    if (state.cash < type.price) throw new GameError("failed-precondition", "Недостатньо гривень для цієї відеокарти.");
    state.cash = roundCash(state.cash - type.price);
    state.inventory.push({
      inventoryId: newInventoryId(ctx.nowMs, ctx.random), id: type.id, name: type.name, icon: type.icon,
      rate: type.rate, currency: type.currency, cost: type.price
    });
  },
  removeGpu(state, payload, ctx) {
    const slots = fieldSlots(state, Number(payload.field) || 0);
    const index = slotIndexOf(payload.index);
    const gpu = slots[index];
    if (!gpu) throw new GameError("failed-precondition", "У цій клітинці немає відеокарти.");
    state.inventory.push(toInventoryItem(gpu, ctx.nowMs, ctx.random));
    slots[index] = null;
  },
  installGpu(state, payload) {
    const field = Number(payload.field) || 0;
    const slots = fieldSlots(state, field);
    const index = slotIndexOf(payload.index);
    if (field === 1 && !state.extraUnlockedSlots[index]) throw new GameError("failed-precondition", "Ця клітинка ще заблокована.");
    if (slots[index]) throw new GameError("failed-precondition", "Клітинка зайнята.");
    const inventoryIndex = state.inventory.findIndex((gpu) => gpu.inventoryId === payload.inventoryId);
    if (inventoryIndex < 0) throw new GameError("not-found", "Цієї відеокарти немає в інвентарі.");
    slots[index] = toSlotItem(state.inventory.splice(inventoryIndex, 1)[0]);
  },
  sellGpu(state, payload) {
    const slots = fieldSlots(state, Number(payload.field) || 0);
    const index = slotIndexOf(payload.index);
    const gpu = slots[index];
    if (!gpu) throw new GameError("failed-precondition", "У цій клітинці немає відеокарти.");
    const originalCost = Number(gpu.cost) || (gpuType(gpu.id)?.price ?? 0);
    state.cash = roundCash(state.cash + originalCost * SELL_BACK_RATE);
    slots[index] = null;
  },
  sellCurrency(state, payload, ctx) {
    const currency = payload.currency === "blue" ? "blue" : (payload.currency === "cryp" ? "cryp" : null);
    if (!currency) throw new GameError("invalid-argument", "Невідома валюта.");
    const price = Number(ctx.rates && ctx.rates[currency]);
    if (!Number.isFinite(price) || price <= 0) throw new GameError("unavailable", "Спільний курс ще не завантажився.");
    // "all" sells the whole server-side balance, so the browser's animated counter can never cause a mismatch.
    const requested = payload.all === true ? state[currency] : Number(payload.amount);
    const amount = resolveSellAmount(requested, state[currency], SELL_TOLERANCE_DIGITS[currency]);
    state[currency] = roundCoin(Math.max(0, state[currency] - amount));
    state.cash = roundCash(state.cash + amount * price);
  },
  buyExtraField(state) {
    if (state.hasExtraField) throw new GameError("failed-precondition", "Додаткове поле вже придбано.");
    if (state.cash < FIELD_PRICE) throw new GameError("failed-precondition", "Недостатньо гривень для нового поля.");
    state.cash = roundCash(state.cash - FIELD_PRICE);
    state.hasExtraField = true;
  },
  buyExtraCell(state, payload) {
    const index = slotIndexOf(payload.index);
    if (!state.hasExtraField || state.extraUnlockedSlots[index]) throw new GameError("failed-precondition", "Цю клітинку не можна придбати.");
    if (state.cash < FIELD_CELL_PRICE) throw new GameError("failed-precondition", "Недостатньо гривень для клітинки.");
    state.cash = roundCash(state.cash - FIELD_CELL_PRICE);
    state.extraUnlockedSlots[index] = true;
  },
  setPlayerName(state, payload) {
    const name = String(payload.name ?? "").trim().slice(0, 20);
    state.playerName = name || "Гравець 1";
  }
};

/*
 * Applies one player action to a state. Mining is settled first (at the OLD rates), the action is applied
 * to a copy, and the operation id is remembered so a retried request cannot be applied twice.
 * Returns { state, duplicate }. Throws GameError and leaves the input untouched on any failure.
 */
function applyAction(state, action, ctx) {
  const type = action && action.type;
  const handler = typeof type === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, type) ? ACTIONS[type] : null;
  if (!handler) throw new GameError("invalid-argument", "Невідома дія.");
  const opId = String((action && action.opId) || "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(opId)) throw new GameError("invalid-argument", "Відсутній ідентифікатор операції.");
  if (state.recentOps.includes(opId)) return { state, duplicate: true };

  const settled = settleMining(state, ctx.nowMs).state;
  const next = JSON.parse(JSON.stringify(settled));
  handler(next, action.payload || {}, ctx);
  next.recentOps = state.recentOps.concat(opId).slice(-MAX_RECENT_OPS);
  return { state: next, duplicate: false };
}

// Heartbeat: credits mining; too-frequent calls are ignored so they cannot cost writes.
// A player with no installed cards earns nothing, so no write is needed either.
function applyHeartbeat(state, nowMs) {
  const gapMs = nowMs - (Number(state.lastMiningAt) || 0);
  if (gapMs >= 0 && gapMs < MIN_HEARTBEAT_GAP_MS) return { state, changed: false, credited: { cryp: 0, blue: 0 } };
  const settled = settleMining(state, nowMs);
  const earns = totalRate(state, "cryp") > 0 || totalRate(state, "blue") > 0;
  if (!earns) return { state, changed: false, credited: settled.credited };
  return { state: settled.state, changed: true, credited: settled.credited };
}

function capitalOf(state, rates) {
  return roundCash(state.cash + state.cryp * rates.cryp + state.blue * rates.blue);
}

// Podium snapshot: top 10 by cash + CRYP x rate + Blue x rate. Ties: nickname, then id (stable).
function buildPodium(players, rates, limit = 10) {
  const rows = players.map(({ uid, state }) => ({
    uid,
    nickname: String(state.playerName || "Гравець").trim().slice(0, 20) || "Гравець",
    cashBalance: roundCash(finiteNonNegative(state.cash)),
    totalCapital: capitalOf({ cash: finiteNonNegative(state.cash), cryp: finiteNonNegative(state.cryp), blue: finiteNonNegative(state.blue) }, rates)
  }));
  rows.sort((a, b) => b.totalCapital - a.totalCapital || a.nickname.localeCompare(b.nickname, "uk") || (a.uid < b.uid ? -1 : 1));
  // uid is dropped on purpose: the public ranking must not expose Firebase UIDs.
  return rows.slice(0, limit).map(({ nickname, cashBalance, totalCapital }, index) => ({ rank: index + 1, nickname, cashBalance, totalCapital }));
}

module.exports = {
  SLOT_COUNT, FIELD_PRICE, FIELD_CELL_PRICE, START_CASH, HEARTBEAT_INTERVAL_MS, MAX_GAP_MS, MIN_HEARTBEAT_GAP_MS,
  GPU_TYPES, GameError, newState, normalizeState, normalizeGpu, totalRate, settleMining, applyAction, applyHeartbeat,
  buildPodium, capitalOf, round, roundCash, roundCoin
};
