(() => {
  "use strict";

  let SAVE_KEY = null;
  let currentUserUID = null;
  const SLOT_COUNT = 16;
  const FIELD_PRICE = 5000;
  const FIELD_CELL_PRICE = 10000;
  const INITIAL_EXTRA_UNLOCKED = 8;
  const MIN_PRICE = 0.25;
  const MAX_PRICE = 7;

  const GPU_TYPES = [
    { id: "starter", name: "Starter GPU", icon: "▰", price: 250, rate: 0.02, currency: "cryp" },
    { id: "rtx3060", name: "RTX 3060", icon: "▰", price: 600, rate: 0.06, currency: "cryp" },
    { id: "rtx4090", name: "RTX 4090", icon: "▰", price: 1200, rate: 0.15, currency: "cryp" },
    { id: "blue-rtx4060", name: "RTX 4060", icon: "▰", price: 2400, rate: 0.015, currency: "blue" },
    { id: "blue-rtx3070", name: "RTX 3070", icon: "▰", price: 10000, rate: 0.06, currency: "blue" },
    { id: "blue-rtx4070", name: "RTX 4070", icon: "▰", price: 15000, rate: 0.08, currency: "blue" }
  ];

  // Shared top-down pixel-art card illustrations for the farm, shop, and inventory.
  const GPU_ART = {
    starter: {
      label: "GPU I", centers: [24, 48], scale: 0.78,
      case: "#69747a", face: "#899398", shadow: "#39434b",
      trim: "#c3c9c8", fanRing: "#3d474d", fanFace: "#657178",
      blade: "#a5afb1", accent: "#d7dcda", metal: "#b7c0c1"
    },
    rtx3060: {
      label: "GPU II", centers: [18, 36, 54], scale: 0.62,
      case: "#1c293b", face: "#2a3b53", shadow: "#111c2a",
      trim: "#3e6892", fanRing: "#121e2b", fanFace: "#263b51",
      blade: "#5684aa", accent: "#53baff", metal: "#7b91a2"
    },
    rtx4090: {
      label: "GPU III", centers: [18, 36, 54], scale: 0.74,
      case: "#302b24", face: "#49402f", shadow: "#191916",
      trim: "#a17b3c", fanRing: "#1e1b17", fanFace: "#3a3124",
      blade: "#94713b", accent: "#f0c75b", metal: "#d0b77d"
    },
    "blue-rtx4060": {
      label: "BLUE I", centers: [24, 48], scale: 0.78,
      case: "#153750", face: "#1b5273", shadow: "#0c2435",
      trim: "#3488b6", fanRing: "#102f45", fanFace: "#1e5f82",
      blade: "#54b9e8", accent: "#9be5ff", metal: "#8bc9e0"
    },
    "blue-rtx3070": {
      label: "BLUE II", centers: [18, 36, 54], scale: 0.62,
      case: "#123d59", face: "#195d7d", shadow: "#0a263b",
      trim: "#2a91c4", fanRing: "#0d304a", fanFace: "#1b6285",
      blade: "#5ac7f3", accent: "#b0efff", metal: "#88cee8"
    },
    "blue-rtx4070": {
      label: "BLUE III", centers: [18, 36, 54], scale: 0.74,
      case: "#173d69", face: "#235b91", shadow: "#0b2445",
      trim: "#3c9ce0", fanRing: "#102d51", fanFace: "#24629b",
      blade: "#69c5ff", accent: "#c7f2ff", metal: "#9acbec"
    }
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgShape(parent, name, attributes) {
    const shape = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => shape.setAttribute(key, String(value)));
    parent.appendChild(shape);
    return shape;
  }

  function drawGpuFan(svg, x, y, scale, art) {
    const fan = svgShape(svg, "g", { transform: "translate(" + x + " " + y + ") scale(" + scale + ")" });
    const outer = "M-4 -12h8v2h4v3h3v4h2v8h-2v4h-3v3h-4v2h-8v-2h-4v-3h-3v-4h-2v-8h2v-4h3v-3h4z";
    const inner = "M-3 -9h6v2h3v3h2v6h-2v3h-3v2h-6v-2h-3v-3h-2v-6h2v-3h3z";
    svgShape(fan, "path", { d: outer, fill: art.shadow });
    svgShape(fan, "path", { d: inner, fill: art.fanRing });
    [0, 120, 240].forEach((angle) => {
      svgShape(fan, "path", {
        d: "M-2 -7h4v4L0 -1l-2-2z",
        fill: art.blade,
        transform: "rotate(" + angle + ")"
      });
    });
    svgShape(fan, "rect", { x: -4, y: -4, width: 8, height: 8, fill: art.fanFace });
    svgShape(fan, "rect", { x: -2, y: -2, width: 4, height: 4, fill: art.accent });
    svgShape(fan, "rect", { x: -1, y: -1, width: 2, height: 2, fill: art.shadow });
  }

  function createGpuIcon(gpu, className) {
    const art = GPU_ART[gpu?.id] || GPU_ART.starter;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", "0 0 72 48");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", gpu?.name || art.label);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("focusable", "false");
    const title = svgShape(svg, "title", {});
    title.textContent = gpu?.name || art.label;

    // Layered, square-edged shroud and exposed metal bracket.
    svgShape(svg, "path", {
      d: "M7 4h57v2h4v33h-4v2H7v-2H4V7h3z",
      fill: art.shadow
    });
    svgShape(svg, "path", {
      d: "M8 6h55v2h3v29h-3v2H8v-2H6V8h2z",
      fill: art.case
    });
    svgShape(svg, "path", {
      d: "M10 8h52v2h2v25h-2v2H10v-2H8V10h2z",
      fill: art.face
    });
    svgShape(svg, "rect", { x: 1, y: 13, width: 6, height: 15, fill: art.metal });
    svgShape(svg, "rect", { x: 2, y: 15, width: 2, height: 3, fill: art.shadow });
    svgShape(svg, "rect", { x: 2, y: 23, width: 2, height: 3, fill: art.shadow });

    // The reinforced third model has a wider, gold-edged armor rail.
    if (gpu?.id === "rtx4090") {
      svgShape(svg, "rect", { x: 9, y: 10, width: 2, height: 25, fill: art.trim });
      svgShape(svg, "rect", { x: 61, y: 10, width: 2, height: 25, fill: art.trim });
      svgShape(svg, "rect", { x: 12, y: 10, width: 48, height: 1, fill: art.accent });
      svgShape(svg, "rect", { x: 12, y: 35, width: 48, height: 1, fill: art.accent });
    } else {
      svgShape(svg, "rect", { x: 10, y: 9, width: 52, height: 1, fill: art.trim });
      svgShape(svg, "rect", { x: 10, y: 36, width: 52, height: 1, fill: art.trim });
    }

    art.centers.forEach((center) => drawGpuFan(svg, center, 22, art.scale, art));

    // Blocky screws, vents, and PCIe contacts stay legible at small sizes.
    [11, 62].forEach((x) => {
      svgShape(svg, "rect", { x, y: 12, width: 2, height: 2, fill: art.accent });
      svgShape(svg, "rect", { x, y: 31, width: 2, height: 2, fill: art.accent });
    });
    [13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57].forEach((x) => {
      svgShape(svg, "rect", { x, y: 40, width: 2, height: 4, fill: art.accent });
    });
    svgShape(svg, "rect", { x: 11, y: 41, width: 9, height: 2, fill: art.shadow });
    svgShape(svg, "rect", { x: 53, y: 41, width: 8, height: 2, fill: art.shadow });
    return svg;
  }

  const $ = (id) => document.getElementById(id);
  const els = {
    cash: $("cashValue"), cryp: $("crypValue"), rate: $("rateValue"),
    blue: $("blueValue"), blueRate: $("blueRateValue"), bluePrice: $("bluePriceValue"),
    gpuCount: $("gpuCount"), price: $("priceValue"), grid: $("farmGrid"),
    shop: $("shopList"), inventory: $("inventoryList"),
    inventoryHint: $("inventoryHint"), inventoryModal: $("inventoryModal"),
    gpuActionModal: $("gpuActionModal"), gpuActionDetails: $("gpuActionDetails"),
    playerName: $("playerName"), toast: $("toast"), saveStatus: $("saveStatus"),
    sellAmount: $("sellAmount"), sellPreview: $("sellPreview"), sellLabel: $("sellAmountLabel"),
    exchangePrice: $("exchangePrice"), exchangeBalance: $("exchangeBalance"), marketStatus: $("marketStatus"),
    blueExchangePrice: $("blueExchangePrice"), blueExchangeBalance: $("blueExchangeBalance"), blueMarketStatus: $("blueMarketStatus"),
    podiumRows: $("podiumRows"), podiumStatus: $("podiumStatus"), podiumUpdatedAt: $("podiumUpdatedAt"),
    farmSwitcher: $("farmSwitcher"), farmFieldLabel: $("farmFieldLabel"),
    farmSwipeHint: $("farmSwipeHint"), farmPrevious: $("farmPrevious"), farmNext: $("farmNext")
  };

  function newState() {
    return {
      playerName: "Гравець 1",
      cash: 490,
      cryp: 0,
      blue: 0,
      slots: Array(SLOT_COUNT).fill(null),
      inventory: [],
      hasExtraField: false,
      extraSlots: Array(SLOT_COUNT).fill(null),
      extraUnlockedSlots: Array.from({ length: SLOT_COUNT }, (_, index) => index < INITIAL_EXTRA_UNLOCKED)
    };
  }

  function normalizeSavedState(saved) {
    const normalized = { ...newState(), ...saved };
    const costFor = (gpu) => Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0);
    const normalizeGPU = (gpu) => {
      const knownType = GPU_TYPES.find((type) => type.id === gpu.id);
      return {
        ...gpu,
        currency: knownType?.currency || (gpu.currency === "blue" ? "blue" : "cryp"),
        cost: costFor(gpu)
      };
    };
    const blueBalance = Number(normalized.blue);
    normalized.blue = Number.isFinite(blueBalance) ? Math.max(0, blueBalance) : 0;
    normalized.slots = Array.from({ length: SLOT_COUNT }, (_, index) => saved.slots[index] || null)
      .map((gpu) => gpu ? normalizeGPU(gpu) : null);
    normalized.inventory = Array.isArray(saved.inventory) ? saved.inventory.map(normalizeGPU) : [];
    normalized.hasExtraField = saved.hasExtraField === true;
    normalized.extraSlots = Array.from({ length: SLOT_COUNT }, (_, index) => saved.extraSlots?.[index] || null);
    const savedUnlocks = Array.isArray(saved.extraUnlockedSlots) && saved.extraUnlockedSlots.length ? saved.extraUnlockedSlots : null;
    normalized.extraUnlockedSlots = Array.from({ length: SLOT_COUNT }, (_, index) => savedUnlocks ? savedUnlocks[index] === true : index < INITIAL_EXTRA_UNLOCKED);
    normalized.extraSlots = normalized.extraSlots.map((gpu) => gpu ? normalizeGPU(gpu) : null);
    return normalized;
  }

  const INITIAL_MARKET_STATE = {
    price: 1,
    trendDirection: 0,
    trendTicksLeft: 0,
    lastPriceAt: 0
  };
  let marketState = { ...INITIAL_MARKET_STATE };
  let marketRef = null;
  let marketUnsubscribe = null;
  let marketReady = false;
  let marketUpdateInProgress = false;
  const BLUE_MIN_PRICE = 4.25;
  const BLUE_MAX_PRICE = 13.75;
  const BLUE_PRICE_UPDATE_INTERVAL = 5000;
  const INITIAL_BLUE_MARKET_STATE = {
    price: BLUE_MIN_PRICE,
    trendDirection: 0,
    trendTicksLeft: 0,
    lastPriceAt: 0
  };
  let blueMarketState = { ...INITIAL_BLUE_MARKET_STATE };
  let blueMarketRef = null;
  let blueMarketUnsubscribe = null;
  let blueMarketReady = false;
  let blueMarketUpdateInProgress = false;
  // Market history writes are independent from the page-scoped chart reader.
  const getMarketDb = () => (window.crypFirebase && window.crypFirebase.db) || null;
  let marketChart = null;
  const marketHistoryRecorder = window.CrypMarketHistory
    ? window.CrypMarketHistory.createHistoryRecorder({
      getDb: getMarketDb,
      onChange: () => { if (marketChart) marketChart.render(); }
    })
    : null;
  marketChart = window.CrypChart
    ? window.CrypChart.create({
      document,
      getDb: getMarketDb,
      historyRecorder: marketHistoryRecorder,
      documentId: () => {
        const fieldPath = window.firebase && window.firebase.firestore && window.firebase.firestore.FieldPath;
        return fieldPath ? fieldPath.documentId() : null;
      }
    })
    : null;
  // Only chart reads and rendering follow page visibility.
  let currentPageName = "farm";
  function syncChartVisibility() {
    if (marketChart) marketChart.setVisible(currentPageName === "exchange");
  }
  function recordHistoryTick(currency, tickResult) {
    try { if (marketHistoryRecorder && tickResult) marketHistoryRecorder.recordTick(currency, tickResult); } catch (error) { console.warn("Історія курсу:", error); }
  }
  // Cloud writes are expensive (Firestore daily quota), so periodic saves are throttled and skipped when nothing changed.
  // A shared rate timestamp further in the future than this is treated as poisoned by a wrong device clock.
  const MAX_CLOCK_SKEW_MS = 60000;
  let podiumUnsubscribe = null;
  let podiumEntries = [];
  let podiumUpdatedAtValue = null;
  let podiumRenderKey = "";

  // Progress lives on the server. The local state is only what is shown until the server answers.
  function loadState() {
    return newState();
  }

  let state = loadState();
  let targetSlotIndex = null;
  let actionSlotIndex = null;
  let activeFarm = 0;
  let farmTouchStart = null;
  let suppressFarmClickUntil = 0;
  let lastVisibleTick = document.hidden ? null : Date.now();
  let hiddenAt = null;
  let toastTimeout = null;

  function money(value) {
    return Number(value || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴";
  }

  function number(value, digits = 3) {
    return Number(value || 0).toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function currencyLabel(currency) {
    return currency === "blue" ? "Blue" : "CRYP";
  }

  function allGPUs() {
    return state.slots.concat(state.hasExtraField ? state.extraSlots : []).filter(Boolean);
  }

  function totalRate(currency = "cryp") {
    return allGPUs().reduce((sum, gpu) => sum + (gpu.currency === currency ? (gpu.rate || 0) : 0), 0);
  }

  // save() always writes locally. Cloud writes happen shortly after player actions; the
  // once-per-5-seconds timer passes { periodic: true }, which is throttled and skips unchanged state.
  // The browser no longer stores or writes progress: balances live in Firestore and change only through
  // Cloud Functions. Kept as a no-op so older call sites stay harmless.
  function save() {}

  // ---- Server-authoritative game: every change goes through Cloud Functions. ----
  const HEARTBEAT_INTERVAL_MS = 60000;
  let actionBusy = false;
  let stateEpoch = 0;
  let heartbeatTimer = null;
  let serverReady = false;

  function functionsClient() {
    return window.crypFirebase && window.crypFirebase.functions ? window.crypFirebase.functions : null;
  }

  function makeOpId() {
    const random = window.crypto && window.crypto.getRandomValues
      ? Array.from(window.crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join("")
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return ("op" + Date.now().toString(36) + random).slice(0, 60);
  }

  // Replaces the local view with the server's state. Local mining counters are only an animation between syncs.
  function applyServerState(data) {
    if (!data || !data.state || !Array.isArray(data.state.slots)) return;
    state = normalizeSavedState(data.state);
    stateEpoch += 1;
    render();
  }

  function isRetryableError(error) {
    return !error || ["unavailable", "deadline-exceeded", "internal", "unknown"].includes(String(error.code || "").replace("functions/", ""));
  }

  function errorMessage(error) {
    const code = String((error && error.code) || "").replace("functions/", "");
    if (code === "unavailable" || code === "deadline-exceeded" || !code) return "Немає зв'язку із сервером. Спробуй ще раз.";
    return (error && error.message) || "Операція не виконана.";
  }

  // Sends one action. The same opId is reused on a retry, so a lost response can never apply an action twice.
  async function serverAction(type, payload = {}) {
    const functions = functionsClient();
    if (!functions || !serverReady) {
      showToast("Сервер ще не підключений. Спробуй за кілька секунд.");
      return null;
    }
    if (actionBusy) {
      showToast("Зачекай, попередня операція ще виконується.");
      return null;
    }
    actionBusy = true;
    const call = functions.httpsCallable("gameAction");
    const request = { type, payload, opId: makeOpId() };
    try {
      let response;
      try {
        response = await call(request);
      } catch (error) {
        if (!isRetryableError(error)) throw error;
        response = await call(request);
      }
      applyServerState(response.data);
      return response.data;
    } catch (error) {
      console.error("Серверна операція не виконана:", error);
      showToast(errorMessage(error));
      return null;
    } finally {
      actionBusy = false;
    }
  }

  async function sendHeartbeat(force = false) {
    const functions = functionsClient();
    if (!functions || !serverReady || (document.hidden && !force) || actionBusy) return;
    const epoch = stateEpoch;
    try {
      const response = await functions.httpsCallable("heartbeat")({});
      // An action finished while this request was in flight: its state is newer, keep it.
      if (epoch === stateEpoch && !actionBusy) applyServerState(response.data);
    } catch (error) {
      console.warn("Heartbeat не виконано:", error);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    serverReady = false;
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  function addMining(seconds) {
    if (seconds <= 0 || document.hidden) return;
    state.cryp += totalRate("cryp") * seconds;
    state.blue += totalRate("blue") * seconds;
  }

  // Shared Firestore market: one transaction advances the exchange rate for every player.
  // Оновлюємо курс раз на 5 секунд, але змінюємо його невеликими кроками.
  const PRICE_UPDATE_INTERVAL = 5000;
  const PRICE_BASELINE = 1;
  const MIN_TREND_TICKS = 1;
  const MAX_TREND_TICKS = 4;

  function clampPrice(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return PRICE_BASELINE;
    return Math.max(MIN_PRICE, Math.min(MAX_PRICE, parsed));
  }

  function nextPriceState(previous) {
    const currentPrice = clampPrice(previous.price);
    let direction = Number(previous.trendDirection);
    let ticksLeft = Number(previous.trendTicksLeft);

    // Give the market visible multi-step waves rather than tiny random reversals.
    // Lower prices favor recovery; near the ceiling, a decline becomes more likely.
    const upwardChance = currentPrice < 0.75 ? 0.78
      : currentPrice < 1.5 ? 0.72
      : currentPrice < 2.5 ? 0.66
      : currentPrice < 4 ? 0.60
      : currentPrice < 5.25 ? 0.53
      : currentPrice < 6.25 ? 0.43
      : 0.30;

    // Force the market to turn away from its limits instead of sticking there.
    if (currentPrice >= MAX_PRICE) {
      direction = -1;
      ticksLeft = 1;
    } else if (currentPrice <= MIN_PRICE) {
      direction = 1;
      ticksLeft = 1;
    }

    // A trend lasts 4–10 updates (20–50 seconds). When it ends, pick a fresh
    // direction; this creates climbs, pullbacks, recoveries and eventual downturns.
    if ((direction !== -1 && direction !== 1) || !Number.isFinite(ticksLeft) || ticksLeft <= 0) {
      direction = Math.random() < upwardChance ? 1 : -1;
      ticksLeft = 4 + Math.floor(Math.random() * 7); // 4–10 ticks
    }

    // Smooth but noticeable movement every 5 seconds.
    const change = 0.025 + Math.random() * 0.02; // 2.5–4.5%
    const factor = direction === 1 ? 1 + change : 1 - change;
    const price = clampPrice(currentPrice * factor);

    ticksLeft -= 1;
    if (price >= MAX_PRICE || price <= MIN_PRICE) ticksLeft = 0;
    return { price: Number(price.toFixed(4)), trendDirection: direction, trendTicksLeft: ticksLeft };
  }

  // A device with a wrong clock could write a timestamp far in the future and freeze the shared rate for everyone.
  // Such values are treated as stale so any correctly clocked client can move the rate again.
  function sanitizeLastPriceAt(value) {
    if (!Number.isFinite(value) || value <= 0) return Date.now();
    return value > Date.now() + MAX_CLOCK_SKEW_MS ? 0 : value;
  }

  function normalizedMarketState(data) {
    const parsedLastAt = Number(data.lastPriceAt);
    const direction = Number(data.trendDirection);
    const ticksLeft = Number(data.trendTicksLeft);
    return {
      price: clampPrice(data.price),
      trendDirection: direction === -1 || direction === 1 ? direction : 0,
      trendTicksLeft: Number.isFinite(ticksLeft) ? Math.max(0, Math.floor(ticksLeft)) : 0,
      lastPriceAt: sanitizeLastPriceAt(parsedLastAt)
    };
  }

  function stopMarketSync() {
    if (marketUnsubscribe) marketUnsubscribe();
    marketUnsubscribe = null;
    marketRef = null;
    marketReady = false;
    marketUpdateInProgress = false;
    marketState = { ...INITIAL_MARKET_STATE };
  }

  async function startMarketSync(db, expectedUID) {
    stopMarketSync();
    if (!db) {
      if (els.marketStatus) els.marketStatus.textContent = "Спільний курс недоступний: Firestore не підключився.";
      return false;
    }

    const ref = db.collection("market").doc("exchangeRate");
    const initialMarket = { ...INITIAL_MARKET_STATE, lastPriceAt: Date.now() };
    try {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
          transaction.set(ref, {
            ...initialMarket,
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      });

      if (expectedUID !== currentUserUID) return false;

      marketRef = ref;
      marketUnsubscribe = ref.onSnapshot((snapshot) => {
        if (!snapshot.exists) return;
        marketState = normalizedMarketState(snapshot.data());
        marketReady = true;
        if (marketChart) marketChart.setLiveRate("cryp", marketState.price, marketState.lastPriceAt);
        if (els.marketStatus) els.marketStatus.textContent = "";
        renderStats();
      }, (error) => {
        marketReady = false;
        console.error("Не вдалося синхронізувати спільний курс:", error);
        if (els.marketStatus) els.marketStatus.textContent = "Спільний курс недоступний — перевір правила Firestore.";
      });
      return true;
    } catch (error) {
      console.error("Не вдалося підключити спільний курс:", error);
      if (els.marketStatus) els.marketStatus.textContent = "Спільний курс недоступний — перевір правила Firestore.";
      return false;
    }
  }

  function updatePrice(now = Date.now()) {
    if (!marketReady || !marketRef || marketUpdateInProgress) return;
    if (now - marketState.lastPriceAt < PRICE_UPDATE_INTERVAL) return;

    const ref = marketRef;
    const uid = currentUserUID;
    marketUpdateInProgress = true;
    let tickResult = null;
    window.crypFirebase.db.runTransaction(async (transaction) => {
      tickResult = null;
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        transaction.set(ref, {
          ...INITIAL_MARKET_STATE,
          lastPriceAt: now,
          updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
        return;
      }

      const previous = normalizedMarketState(snapshot.data());
      if (now - previous.lastPriceAt < PRICE_UPDATE_INTERVAL) return;

      // Apply exactly one price movement per update. Never replay missed ticks at once:
      // that caused large instant jumps after a tab/device was inactive.
      const next = { ...previous, ...nextPriceState(previous) };

      transaction.set(ref, {
        price: next.price,
        trendDirection: next.trendDirection,
        trendTicksLeft: next.trendTicksLeft,
        lastPriceAt: now,
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
      tickResult = { previousAt: previous.lastPriceAt, previousPrice: previous.price, now, price: next.price };
    }).then(() => {
      recordHistoryTick("cryp", tickResult);
    }).catch((error) => {
      console.error("Не вдалося оновити спільний курс:", error);
      if (uid === currentUserUID && els.marketStatus) {
        els.marketStatus.textContent = "Не вдалося оновити спільний курс — перевір правила Firestore.";
      }
    }).finally(() => {
      marketUpdateInProgress = false;
    });
  }

  function clampBluePrice(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return BLUE_MIN_PRICE;
    return Math.max(BLUE_MIN_PRICE, Math.min(BLUE_MAX_PRICE, parsed));
  }

  function nextBluePriceState(previous) {
    const currentPrice = clampBluePrice(previous.price);
    const position = (currentPrice - BLUE_MIN_PRICE) / (BLUE_MAX_PRICE - BLUE_MIN_PRICE);
    let direction = Number(previous.trendDirection);
    let ticksLeft = Number(previous.trendTicksLeft);
    const upwardChance = Math.max(0.18, Math.min(0.82, 0.62 - position * 0.24));

    if (currentPrice >= BLUE_MAX_PRICE) {
      direction = -1;
      ticksLeft = 1;
    } else if (currentPrice <= BLUE_MIN_PRICE) {
      direction = 1;
      ticksLeft = 1;
    }

    if ((direction !== -1 && direction !== 1) || !Number.isFinite(ticksLeft) || ticksLeft <= 0) {
      direction = Math.random() < upwardChance ? 1 : -1;
      ticksLeft = 4 + Math.floor(Math.random() * 7);
    }

    const change = 0.0125 + Math.random() * 0.0175;
    const factor = direction === 1 ? 1 + change : 1 - change;
    const price = clampBluePrice(currentPrice * factor);
    ticksLeft -= 1;
    if (price >= BLUE_MAX_PRICE || price <= BLUE_MIN_PRICE) ticksLeft = 0;
    return { price: Number(price.toFixed(4)), trendDirection: direction, trendTicksLeft: ticksLeft };
  }

  function normalizedBlueMarketState(data) {
    const parsedLastAt = Number(data.lastPriceAt);
    const direction = Number(data.trendDirection);
    const ticksLeft = Number(data.trendTicksLeft);
    return {
      price: clampBluePrice(data.price),
      trendDirection: direction === -1 || direction === 1 ? direction : 0,
      trendTicksLeft: Number.isFinite(ticksLeft) ? Math.max(0, Math.floor(ticksLeft)) : 0,
      lastPriceAt: sanitizeLastPriceAt(parsedLastAt)
    };
  }

  function stopBlueMarketSync() {
    if (blueMarketUnsubscribe) blueMarketUnsubscribe();
    blueMarketUnsubscribe = null;
    blueMarketRef = null;
    blueMarketReady = false;
    blueMarketUpdateInProgress = false;
    blueMarketState = { ...INITIAL_BLUE_MARKET_STATE };
  }

  async function startBlueMarketSync(db, expectedUID) {
    stopBlueMarketSync();
    if (!db) {
      if (els.blueMarketStatus) els.blueMarketStatus.textContent = "Спільний курс Blue недоступний: Firestore не підключився.";
      return false;
    }

    const ref = db.collection("market").doc("blueExchangeRate");
    const initialMarket = { ...INITIAL_BLUE_MARKET_STATE, lastPriceAt: Date.now() };
    try {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
          transaction.set(ref, {
            ...initialMarket,
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      });

      if (expectedUID !== currentUserUID) return false;

      blueMarketRef = ref;
      blueMarketUnsubscribe = ref.onSnapshot((snapshot) => {
        if (!snapshot.exists) return;
        blueMarketState = normalizedBlueMarketState(snapshot.data());
        blueMarketReady = true;
        if (marketChart) marketChart.setLiveRate("blue", blueMarketState.price, blueMarketState.lastPriceAt);
        if (els.blueMarketStatus) els.blueMarketStatus.textContent = "";
        renderStats();
      }, (error) => {
        blueMarketReady = false;
        console.error("Не вдалося синхронізувати спільний курс Blue:", error);
        if (els.blueMarketStatus) els.blueMarketStatus.textContent = "Курс Blue недоступний — перевір правила Firestore.";
      });
      return true;
    } catch (error) {
      console.error("Не вдалося підключити спільний курс Blue:", error);
      if (els.blueMarketStatus) els.blueMarketStatus.textContent = "Курс Blue недоступний — перевір правила Firestore.";
      return false;
    }
  }

  function updateBluePrice(now = Date.now()) {
    if (!blueMarketReady || !blueMarketRef || blueMarketUpdateInProgress) return;
    if (now - blueMarketState.lastPriceAt < BLUE_PRICE_UPDATE_INTERVAL) return;

    const ref = blueMarketRef;
    const uid = currentUserUID;
    blueMarketUpdateInProgress = true;
    let tickResult = null;
    window.crypFirebase.db.runTransaction(async (transaction) => {
      tickResult = null;
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        transaction.set(ref, {
          ...INITIAL_BLUE_MARKET_STATE,
          lastPriceAt: now,
          updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
        return;
      }

      const previous = normalizedBlueMarketState(snapshot.data());
      if (now - previous.lastPriceAt < BLUE_PRICE_UPDATE_INTERVAL) return;

      const next = { ...previous, ...nextBluePriceState(previous) };
      transaction.set(ref, {
        price: next.price,
        trendDirection: next.trendDirection,
        trendTicksLeft: next.trendTicksLeft,
        lastPriceAt: now,
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
      tickResult = { previousAt: previous.lastPriceAt, previousPrice: previous.price, now, price: next.price };
    }).then(() => {
      recordHistoryTick("blue", tickResult);
    }).catch((error) => {
      console.error("Не вдалося оновити спільний курс Blue:", error);
      if (uid === currentUserUID && els.blueMarketStatus) {
        els.blueMarketStatus.textContent = "Не вдалося оновити курс Blue — перевір правила Firestore.";
      }
    }).finally(() => {
      blueMarketUpdateInProgress = false;
    });
  }

  function renderStats() {
    els.cash.textContent = money(state.cash);
    els.cryp.textContent = number(state.cryp) + " CRYP";
    els.rate.textContent = number(totalRate()) + " CRYP/с";
    if (els.blue) els.blue.textContent = number(state.blue, 6) + " Blue";
    if (els.blueRate) els.blueRate.textContent = number(totalRate("blue")) + " Blue/с";
    if (els.bluePrice) els.bluePrice.textContent = blueMarketReady ? money(blueMarketState.price) : "—";
    const availableSlots = SLOT_COUNT + (state.hasExtraField ? state.extraUnlockedSlots.filter(Boolean).length : 0);
    els.gpuCount.textContent = allGPUs().length + " / " + availableSlots + " встановлено";
    els.price.textContent = marketReady ? money(marketState.price) : "—";
    if (window.CrypBank) window.CrypBank.setBalances({ cash: state.cash, cryp: state.cryp, blue: state.blue });
    $("infoCash").textContent = money(state.cash);
    $("infoCryp").textContent = number(state.cryp) + " CRYP";
    $("infoRate").textContent = number(totalRate()) + " CRYP/с";
    $("infoInventory").textContent = String(state.inventory.length);
    $("infoPrice").textContent = marketReady ? money(marketState.price) : "—";
    $("infoBlue").textContent = number(state.blue, 6) + " Blue";
    $("infoBlueRate").textContent = number(totalRate("blue")) + " Blue/с";
    $("infoBluePrice").textContent = blueMarketReady ? money(blueMarketState.price) : "—";
    if (els.exchangePrice) els.exchangePrice.textContent = marketReady ? money(marketState.price) : "—";
    if (els.exchangeBalance) els.exchangeBalance.textContent = number(state.cryp) + " CRYP";
    if (els.blueExchangePrice) els.blueExchangePrice.textContent = blueMarketReady ? money(blueMarketState.price) : "—";
    if (els.blueExchangeBalance) els.blueExchangeBalance.textContent = number(state.blue, 6) + " Blue";
    updateSellPreview();
    renderPodium();
  }

  function renderPodiumMessage(message) {
    if (!els.podiumRows) return;
    const key = "message:" + message;
    if (podiumRenderKey === key) return;
    podiumRenderKey = key;
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "empty-podium";
    cell.textContent = message;
    row.appendChild(cell);
    els.podiumRows.replaceChildren(row);
  }

  function stopPodiumSync() {
    if (podiumUnsubscribe) podiumUnsubscribe();
    podiumUnsubscribe = null;
    podiumEntries = [];
    podiumUpdatedAtValue = null;
    podiumRenderKey = "";
  }


  function formatPodiumUpdatedAt(timestamp) {
    if (!timestamp) return "—";
    const date = typeof timestamp.toDate === "function"
      ? timestamp.toDate()
      : (timestamp instanceof Date ? timestamp : new Date(timestamp));
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("uk-UA", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  // The Podium is an hourly server snapshot (podium/current): the browser only reads and shows it.
  function renderPodium() {
    if (!els.podiumRows) return;
    const entries = podiumEntries.slice(0, 10).map((entry) => ({
      nickname: String(entry.nickname || "Гравець").slice(0, 20),
      cashBalance: Math.max(0, Number(entry.cashBalance) || 0),
      totalCapital: Math.max(0, Number(entry.totalCapital) || 0)
    }));

    if (!entries.length) {
      renderPodiumMessage("Рейтинг з’явиться після наступного погодинного оновлення.");
    } else {
      // Rebuild the table only when its visible content changed (render runs every second).
      const key = "rows:" + JSON.stringify(entries.map((entry) => [entry.nickname, money(entry.cashBalance), money(entry.totalCapital)]));
      if (key !== podiumRenderKey) {
        podiumRenderKey = key;
        els.podiumRows.replaceChildren();
        entries.forEach((entry, index) => {
          const row = document.createElement("tr");
          const rank = document.createElement("td");
          const nickname = document.createElement("td");
          const cash = document.createElement("td");
          const total = document.createElement("td");
          rank.textContent = String(index + 1);
          nickname.textContent = entry.nickname;
          cash.textContent = money(entry.cashBalance);
          total.textContent = money(entry.totalCapital);
          row.append(rank, nickname, cash, total);
          els.podiumRows.appendChild(row);
        });
      }
    }

    const latest = podiumUpdatedAtValue && typeof podiumUpdatedAtValue.toMillis === "function" ? podiumUpdatedAtValue : null;
    els.podiumUpdatedAt.textContent = formatPodiumUpdatedAt(latest);
    els.podiumUpdatedAt.dateTime = latest && typeof latest.toDate === "function" ? latest.toDate().toISOString() : "";
    els.podiumStatus.textContent = "";
  }

  function startPodiumSync(db, expectedUID) {
    stopPodiumSync();
    if (!db || expectedUID !== currentUserUID) return;
    els.podiumStatus.textContent = "Завантажуємо рейтинг…";
    renderPodiumMessage("Рейтинг з’явиться після наступного погодинного оновлення.");

    // One document, one read per hourly change.
    podiumUnsubscribe = db.collection("podium").doc("current").onSnapshot((snapshot) => {
      if (expectedUID !== currentUserUID) return;
      const data = snapshot.exists ? snapshot.data() : null;
      podiumEntries = data && Array.isArray(data.entries) ? data.entries : [];
      podiumUpdatedAtValue = data ? data.updatedAt : null;
      renderPodium();
    }, (error) => {
      if (expectedUID !== currentUserUID) return;
      console.error("Не вдалося завантажити рейтинг:", error);
      renderPodiumMessage("Не вдалося завантажити рейтинг.");
      els.podiumStatus.textContent = "Перевір правила Firestore для рейтингу.";
      els.podiumUpdatedAt.textContent = "—";
    });
  }

  function activeFarmSlots() {
    return activeFarm === 1 && state.hasExtraField ? state.extraSlots : state.slots;
  }

  function showFarmField(fieldIndex) {
    if (!state.hasExtraField) return;
    activeFarm = fieldIndex === 1 ? 1 : 0;
    renderFarm();
  }

  function renderFarm() {
    const isExtraField = activeFarm === 1 && state.hasExtraField;
    const slots = activeFarmSlots();
    els.grid.replaceChildren();
    els.farmSwitcher.hidden = !state.hasExtraField;
    els.farmSwipeHint.hidden = !state.hasExtraField;
    els.farmFieldLabel.textContent = isExtraField ? "Додаткове поле" : "Основне поле";
    els.farmPrevious.disabled = !isExtraField;
    els.farmNext.disabled = isExtraField;
    els.grid.setAttribute("aria-label", isExtraField ? "Слоти додаткового поля" : "Слоти основного поля");

    slots.forEach((gpu, index) => {
      const button = document.createElement("button");
      button.type = "button";
      if (isExtraField && !state.extraUnlockedSlots[index]) {
        button.className = "slot locked";
        button.setAttribute("aria-label", "Заблокована клітинка " + (index + 1) + ", відкрити за " + money(FIELD_CELL_PRICE));
        button.title = "Придбати клітинку за " + money(FIELD_CELL_PRICE);
        const lock = document.createElement("span");
        lock.className = "lock-icon";
        lock.textContent = "🔒";
        const label = document.createElement("strong");
        label.textContent = "Відкрити клітинку";
        const price = document.createElement("span");
        price.className = "locked-price";
        price.textContent = money(FIELD_CELL_PRICE);
        button.append(lock, label, price);
        button.addEventListener("click", () => purchaseExtraCell(index));
      } else {
        button.className = "slot" + (gpu ? " occupied" + (gpu.currency === "blue" ? " blue-gpu-slot" : "") : "");
        button.setAttribute("aria-label", gpu ? gpu.name + ", видобуває " + currencyLabel(gpu.currency) + ", слот " + (index + 1) : "Порожній слот " + (index + 1));
        if (gpu) {
          button.appendChild(createGpuIcon(gpu, "farm-gpu-icon"));
          button.title = gpu.name + " — видобуває " + currencyLabel(gpu.currency) + "; натисни для дій";
          button.addEventListener("click", () => openGPUActions(index));
        } else {
          const plus = document.createElement("span");
          plus.className = "plus";
          plus.textContent = "+";
          button.appendChild(plus);
          button.addEventListener("click", () => openInventory(index));
        }
      }
      els.grid.appendChild(button);
    });
  }

  function shopCard(gpuType) {
    const item = document.createElement("div");
    item.className = "shop-item";
    const icon = createGpuIcon(gpuType, "gpu-icon");
    const info = document.createElement("div");
    info.className = "shop-info";
    const title = document.createElement("strong");
    title.textContent = gpuType.name;
    const details = document.createElement("span");
    details.textContent = number(gpuType.rate) + " " + currencyLabel(gpuType.currency) + "/с · видобуває " + currencyLabel(gpuType.currency);
    info.append(title, details);
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "shop-buy";
    buy.textContent = money(gpuType.price);
    buy.disabled = state.cash < gpuType.price;
    buy.addEventListener("click", () => purchaseGPU(gpuType));
    item.append(icon, info, buy);
    return item;
  }

  function farmFieldShopCard() {
    const item = document.createElement("div");
    item.className = "shop-item";
    const icon = document.createElement("div");
    icon.className = "field-shop-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🌱";
    const info = document.createElement("div");
    info.className = "shop-info";
    const title = document.createElement("strong");
    title.textContent = "Додаткове поле ферми";
    const details = document.createElement("span");
    details.textContent = "Поле 4 × 4 з 8 доступними клітинками";
    info.append(title, details);
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "shop-buy";
    buy.textContent = state.hasExtraField ? "Придбано" : money(FIELD_PRICE);
    buy.disabled = state.hasExtraField || state.cash < FIELD_PRICE;
    buy.addEventListener("click", purchaseExtraField);
    item.append(icon, info, buy);
    return item;
  }

  function renderShop() {
    els.shop.replaceChildren();
    ["cryp", "blue"].forEach((currency) => {
      const group = document.createElement("section");
      group.className = "shop-currency-group " + currency + "-shop-group";
      const heading = document.createElement("h3");
      heading.className = "shop-currency-heading " + currency + "-shop-heading";
      heading.textContent = currency === "blue" ? "Відеокарти для майнінгу Blue" : "Відеокарти для майнінгу CRYP";
      group.appendChild(heading);
      GPU_TYPES.filter((gpu) => gpu.currency === currency).forEach((gpu) => group.appendChild(shopCard(gpu)));
      els.shop.appendChild(group);
    });
    els.shop.appendChild(farmFieldShopCard());
  }

  function renderInventory() {
    els.inventory.replaceChildren();
    if (!state.inventory.length) {
      const empty = document.createElement("div");
      empty.className = "empty-inventory";
      empty.textContent = "Інвентар порожній. Купи відеокарту в магазині.";
      els.inventory.appendChild(empty);
      els.inventoryHint.textContent = "Інвентар порожній. Закрий це вікно та купи відеокарту в магазині.";
      return;
    }
    els.inventoryHint.textContent = "Вибери відеокарту, щоб установити її у вибрану клітинку ферми.";
    state.inventory.forEach((gpu) => {
      const item = document.createElement("div");
      item.className = "shop-item inventory-item";
      const icon = createGpuIcon(gpu, "gpu-icon");
      const info = document.createElement("div");
      info.className = "shop-info";
      const title = document.createElement("strong");
      title.textContent = gpu.name;
      const details = document.createElement("span");
      details.textContent = number(gpu.rate) + " " + currencyLabel(gpu.currency) + "/с · видобуває " + currencyLabel(gpu.currency);
      info.append(title, details);
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "shop-buy";
      choose.textContent = "Установити";
      choose.addEventListener("click", () => installInventoryGPU(gpu.inventoryId));
      item.append(icon, info, choose);
      els.inventory.appendChild(item);
    });
  }

  async function purchaseGPU(gpuType) {
    if (state.cash < gpuType.price) {
      showToast("Недостатньо гривень для цієї відеокарти.");
      return;
    }
    if (await serverAction("buyGpu", { gpuId: gpuType.id })) showToast(gpuType.name + " додано в інвентар.");
  }

  async function purchaseExtraField() {
    if (state.hasExtraField) return;
    if (state.cash < FIELD_PRICE) {
      showToast("Для нового поля потрібно " + money(FIELD_PRICE) + ".");
      return;
    }
    if (await serverAction("buyExtraField")) {
      activeFarm = 0;
      render();
      showToast("Додаткове поле придбано. Проведи вліво у Фермі, щоб перейти до нього.");
    }
  }

  async function purchaseExtraCell(index) {
    if (!state.hasExtraField || state.extraUnlockedSlots[index]) return;
    if (state.cash < FIELD_CELL_PRICE) {
      showToast("Для клітинки потрібно " + money(FIELD_CELL_PRICE) + ".");
      return;
    }
    if (await serverAction("buyExtraCell", { index })) showToast("Клітинку " + (index + 1) + " відкрито.");
  }

  function openGPUActions(slotIndex) {
    const gpu = activeFarmSlots()[slotIndex];
    if (!gpu) return;
    actionSlotIndex = slotIndex;
    const resalePrice = (Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0)) * 0.5;
    els.gpuActionDetails.textContent = gpu.name + " · " + number(gpu.rate) + " " + currencyLabel(gpu.currency) + "/с · Продаж: " + money(resalePrice);
    els.gpuActionModal.hidden = false;
    $("removeGpuButton").focus();
  }

  function closeGPUActions() {
    els.gpuActionModal.hidden = true;
    actionSlotIndex = null;
  }

  async function removeGPUFromFarm() {
    if (actionSlotIndex === null) return;
    const slotIndex = actionSlotIndex;
    const gpu = activeFarmSlots()[slotIndex];
    if (!gpu) {
      closeGPUActions();
      return;
    }
    closeGPUActions();
    if (await serverAction("removeGpu", { field: activeFarm, index: slotIndex })) {
      showToast(gpu.name + " знято з ферми та повернуто в інвентар.");
    }
  }

  async function sellGPUFromFarm() {
    if (actionSlotIndex === null) return;
    const slotIndex = actionSlotIndex;
    const gpu = activeFarmSlots()[slotIndex];
    if (!gpu) {
      closeGPUActions();
      return;
    }
    const originalCost = Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0);
    const resalePrice = originalCost * 0.5;
    closeGPUActions();
    if (await serverAction("sellGpu", { field: activeFarm, index: slotIndex })) {
      showToast(gpu.name + " продано за " + money(resalePrice) + " (50% від собівартості).");
    }
  }

  function openInventory(slotIndex) {
    targetSlotIndex = slotIndex;
    renderInventory();
    els.inventoryModal.hidden = false;
    $("closeInventory").focus();
  }

  function closeInventory() {
    els.inventoryModal.hidden = true;
    targetSlotIndex = null;
  }

  async function installInventoryGPU(inventoryId) {
    const slots = activeFarmSlots();
    if (targetSlotIndex === null || slots[targetSlotIndex]) {
      closeInventory();
      return;
    }
    const gpu = state.inventory.find((item) => item.inventoryId === inventoryId);
    if (!gpu) return;
    const slotIndex = targetSlotIndex;
    const installedName = gpu.name;
    closeInventory();
    if (await serverAction("installGpu", { field: activeFarm, index: slotIndex, inventoryId })) {
      showToast(installedName + " встановлено на ферму.");
    }
  }

  const CRYP_DISPLAY_DIGITS = 3;
  const BLUE_DISPLAY_DIGITS = 6;

  // Accepts "1.5", "1,5" and numbers copied from the UI such as "1 234,5".
  function parseAmount(raw) {
    const text = String(raw ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
    return text === "" ? NaN : Number(text);
  }

  // Balances are displayed rounded, so the value a player types may exceed the real balance by up to
  // half of the last displayed digit. Allow that and sell no more than the actual balance.
  function resolveSellAmount(amount, balance, digits) {
    if (!Number.isFinite(amount) || amount <= 0) return { status: "empty", amount: 0 };
    const tolerance = 0.5 * Math.pow(10, -digits) + 1e-9;
    if (amount > balance + tolerance) return { status: "insufficient", amount: 0 };
    return { status: "ok", amount: Math.min(amount, balance) };
  }

  // One shared sell form; the toggle chooses which currency it sells.
  let sellCurrencyChoice = "cryp";

  function sellInfo(currency) {
    return currency === "blue"
      ? { name: "Blue", digits: BLUE_DISPLAY_DIGITS, balance: state.blue, price: blueMarketState.price, ready: blueMarketReady, notReady: "Спільний курс Blue ще не завантажився. Спробуй трохи пізніше." }
      : { name: "CRYP", digits: CRYP_DISPLAY_DIGITS, balance: state.cryp, price: marketState.price, ready: marketReady, notReady: "Спільний курс ще не завантажився. Спробуй трохи пізніше." };
  }

  function updateSellPreview() {
    if (!els.sellAmount || !els.sellPreview) return;
    const info = sellInfo(sellCurrencyChoice);
    const result = resolveSellAmount(parseAmount(els.sellAmount.value), info.balance, info.digits);
    if (result.status === "insufficient") {
      els.sellPreview.textContent = "Недостатньо " + info.name;
      return;
    }
    els.sellPreview.textContent = money(info.ready ? result.amount * info.price : 0);
  }

  function setSellCurrency(currency, clearAmount = true) {
    sellCurrencyChoice = currency === "blue" ? "blue" : "cryp";
    const info = sellInfo(sellCurrencyChoice);
    document.querySelectorAll("[data-sell-currency]").forEach((button) => {
      const active = button.dataset.sellCurrency === sellCurrencyChoice;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const crypGroup = $("tradeCryp");
    const blueGroup = $("tradeBlue");
    if (crypGroup) crypGroup.hidden = sellCurrencyChoice !== "cryp";
    if (blueGroup) blueGroup.hidden = sellCurrencyChoice !== "blue";
    if (els.sellLabel) els.sellLabel.textContent = "Скільки " + info.name + " продати?";
    if (els.sellAmount) {
      // A typed amount of one currency must never silently become an amount of the other.
      if (clearAmount) els.sellAmount.value = "";
      els.sellAmount.setAttribute("placeholder", sellCurrencyChoice === "blue" ? "Наприклад, 1.5" : "Наприклад, 10");
    }
    const sellButton = $("sellButton");
    const sellAllButton = $("sellAllButton");
    if (sellButton) sellButton.textContent = "Продати " + info.name;
    if (sellAllButton) sellAllButton.textContent = "Продати все " + info.name;
    updateSellPreview();
  }

  async function sellCurrency(currency, all = false) {
    const info = sellInfo(currency);
    if (!info.ready) {
      showToast(info.notReady);
      return;
    }
    const result = resolveSellAmount(all ? info.balance : parseAmount(els.sellAmount.value), info.balance, info.digits);
    if (result.status === "empty") {
      showToast("Введи кількість " + info.name + ", яку хочеш продати.");
      return;
    }
    if (result.status === "insufficient") {
      showToast("У тебе недостатньо " + info.name + " для цієї операції.");
      return;
    }
    // The server sells at the shared rate it reads itself; the amount is the only thing the browser sends.
    const cashBefore = state.cash;
    const done = await serverAction("sellCurrency", all ? { currency, all: true } : { currency, amount: result.amount });
    if (!done) return;
    els.sellAmount.value = "";
    showToast("Продано " + number(result.amount, info.digits) + " " + info.name + " за " + money(state.cash - cashBefore) + ".");
  }

  const sellCRYP = () => sellCurrency("cryp");
  const sellBlue = () => sellCurrency("blue");

  function showPage(pageName) {
    currentPageName = pageName;
    document.querySelectorAll(".page-section").forEach((section) => {
      section.hidden = section.id !== "page-" + pageName;
    });
    document.querySelectorAll(".nav-button").forEach((button) => {
      const active = button.dataset.page === pageName;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (pageName === "shop") renderShop();
    if (pageName === "farm") renderFarm();
    syncChartVisibility();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function render() {
    renderStats();
    renderFarm();
    renderInventory();
    renderShop();
  }

  function tick() {
    const now = Date.now();
    if (!document.hidden) {
      if (lastVisibleTick !== null) addMining(Math.max(0, Math.min(2, (now - lastVisibleTick) / 1000)));
      lastVisibleTick = now;
    } else {
      lastVisibleTick = null;
    }
    updatePrice(now);
    updateBluePrice(now);
    if (marketChart) marketChart.tick(now);
    renderStats();
  }

  document.addEventListener("visibilitychange", () => {
    const now = Date.now();
    if (document.hidden) {
      hiddenAt = now;
      lastVisibleTick = null;
      sendHeartbeat(true); // best effort: the server credits mining up to this moment
    } else {
      if (hiddenAt !== null) {
        const hiddenSeconds = Math.max(0, (now - hiddenAt) / 1000);
        addMining(Math.min(60, hiddenSeconds));
        hiddenAt = null;
      }
      lastVisibleTick = now;
      updatePrice(now);
      updateBluePrice(now);
      render();
      sendHeartbeat(); // the server decides how much of the break counts (60 s rule, server clock)
    }
  });

  window.addEventListener("resize", () => { if (marketChart) marketChart.render(); });

  els.farmPrevious.addEventListener("click", () => showFarmField(0));
  els.farmNext.addEventListener("click", () => showFarmField(1));

  els.grid.addEventListener("touchstart", (event) => {
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      farmTouchStart = { x: touch.clientX, y: touch.clientY };
    }
  }, { passive: true });
  els.grid.addEventListener("touchend", (event) => {
    if (!farmTouchStart || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - farmTouchStart.x;
    const deltaY = touch.clientY - farmTouchStart.y;
    farmTouchStart = null;
    if (!state.hasExtraField || Math.abs(deltaX) < 55 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
    suppressFarmClickUntil = Date.now() + 500;
    showFarmField(deltaX < 0 ? 1 : 0);
  }, { passive: true });
  els.grid.addEventListener("click", (event) => {
    if (Date.now() < suppressFarmClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  $("closeGpuAction").addEventListener("click", closeGPUActions);
  $("cancelGpuAction").addEventListener("click", closeGPUActions);
  $("removeGpuButton").addEventListener("click", removeGPUFromFarm);
  $("sellGpuButton").addEventListener("click", sellGPUFromFarm);
  els.gpuActionModal.addEventListener("click", (event) => {
    if (event.target === els.gpuActionModal) closeGPUActions();
  });

  $("closeInventory").addEventListener("click", closeInventory);
  els.inventoryModal.addEventListener("click", (event) => {
    if (event.target === els.inventoryModal) closeInventory();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.inventoryModal.hidden) closeInventory();
    if (event.key === "Escape" && !els.gpuActionModal.hidden) closeGPUActions();
  });

  document.querySelectorAll(".nav-button[data-page]").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });

  $("openShop").addEventListener("click", () => {
    showPage("shop");
    showToast("Обери відеокарту, щоб купити її в інвентар.");
  });

  els.sellAmount.addEventListener("input", updateSellPreview);
  document.querySelectorAll("[data-sell-currency]").forEach((button) => {
    button.addEventListener("click", () => setSellCurrency(button.dataset.sellCurrency));
  });
  $("sellButton").addEventListener("click", () => sellCurrency(sellCurrencyChoice));
  $("sellAllButton").addEventListener("click", () => {
    const info = sellInfo(sellCurrencyChoice);
    els.sellAmount.value = info.balance > 0 ? String(info.balance) : "";
    updateSellPreview();
    if (info.balance > 0) sellCurrency(sellCurrencyChoice, true);
    else showToast("Поки що немає " + info.name + " для продажу.");
  });

  els.playerName.value = state.playerName;
  els.playerName.addEventListener("change", () => {
    const name = els.playerName.value.trim().slice(0, 20) || "Гравець 1";
    els.playerName.value = name;
    serverAction("setPlayerName", { name }).then(() => { els.playerName.value = state.playerName; });
  });

  // Firebase Authentication: local saves are separated by Firebase UID.
  const firebase = window.crypFirebase;
  const authScreen = $("authScreen");
  const gameApp = $("gameApp");
  const authForm = $("authForm");
  const authUsername = $("authUsername");
  const authPassword = $("authPassword");
  const authSubmit = $("authSubmit");
  const authMessage = $("authMessage");
  const showLogin = $("showLogin");
  const showRegister = $("showRegister");
  const googleSignIn = $("googleSignIn");
  const signOutButton = $("signOutButton");
  let authMode = "login";

  function setAuthMode(mode) {
    authMode = mode;
    showLogin.classList.toggle("active", mode === "login");
    showRegister.classList.toggle("active", mode === "register");
    authSubmit.textContent = mode === "login" ? "Увійти" : "Створити акаунт";
    authPassword.autocomplete = mode === "login" ? "current-password" : "new-password";
    authMessage.textContent = "";
  }

  function authErrorMessage(error) {
    const code = error && error.code;
    const messages = {
      "auth/invalid-credential": "Неправильний нікнейм або пароль.",
      "auth/user-not-found": "Акаунт не знайдено. Перевір нікнейм або створи акаунт.",
      "auth/wrong-password": "Неправильний нікнейм або пароль.",
      "auth/email-already-in-use": "Цей нікнейм уже зайнятий.",
      "auth/weak-password": "Пароль має містити щонайменше 6 символів.",
      "auth/invalid-email": "Нікнейм має неправильний формат.",
      "auth/popup-closed-by-user": "Вікно Google було закрито до завершення входу.",
      "auth/popup-blocked": "Браузер заблокував вікно входу. Дозволь спливаючі вікна й повтори.",
      "auth/network-request-failed": "Немає з'єднання. Перевір інтернет і спробуй ще раз.",
      "auth/operation-not-allowed": "Цей спосіб входу не ввімкнено у Firebase Console.",
      "auth/unauthorized-domain": "Домен сайту не дозволений у Firebase. Додай jons-ms.github.io в Authentication → Settings → Authorized domains.",
      "auth/too-many-requests": "Забагато спроб. Зачекай трохи й повтори.",
      "auth/internal-error": "Внутрішня помилка Firebase. Перевір налаштування та спробуй ще раз."
    };
    return messages[code] || "Не вдалося увійти. Перевір налаштування Firebase та спробуй ще раз.";
  }

  function showAuthError(error) {
    console.error("Firebase Auth:", error);
    authMessage.textContent = authErrorMessage(error);
  }

  if (!firebase || !firebase.ready || !firebase.auth) {

    authScreen.hidden = false;
    gameApp.hidden = true;
    authMessage.textContent = "Firebase не завантажився. Перевір інтернет і конфігурацію Firebase.";
    authSubmit.disabled = true;
    googleSignIn.disabled = true;
  } else {
    const auth = firebase.auth;

    showLogin.addEventListener("click", () => setAuthMode("login"));
    showRegister.addEventListener("click", () => setAuthMode("register"));

    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      authMessage.textContent = "";
      const username = authUsername.value.trim();
      const normalized = username.toLowerCase();
      const password = authPassword.value;

      if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) {
        authMessage.textContent = "Нікнейм: 3–20 символів, лише латинські літери, цифри, _ або -.";
        return;
      }
      const syntheticEmail = normalized + "@players.cryp-togame.firebaseapp.com";
      authSubmit.disabled = true;
      showLogin.disabled = true;
      showRegister.disabled = true;
      googleSignIn.disabled = true;
      authMessage.textContent = authMode === "register" ? "Створюємо акаунт…" : "Входимо в акаунт…";

      try {
        if (authMode === "register") {
          const credential = await auth.createUserWithEmailAndPassword(syntheticEmail, password);
          authMessage.textContent = "Акаунт створено. Відкриваємо гру…";
          try {
            await credential.user.updateProfile({ displayName: username });
          } catch (profileError) {
            console.warn("Не вдалося зберегти нікнейм у профілі Firebase:", profileError);
          }
        } else {
          await auth.signInWithEmailAndPassword(syntheticEmail, password);
        }
      } catch (error) {
        showAuthError(error);
      } finally {
        authSubmit.disabled = false;
        showLogin.disabled = false;
        showRegister.disabled = false;
        googleSignIn.disabled = false;
      }
    });

    googleSignIn.addEventListener("click", async () => {
      authMessage.textContent = "";
      googleSignIn.disabled = true;
      try {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        await auth.signInWithPopup(provider);
      } catch (error) {
        showAuthError(error);
      } finally {
        googleSignIn.disabled = false;
      }
    });

    if (signOutButton) {
      signOutButton.addEventListener("click", async () => {
        signOutButton.disabled = true;
        try {
          await auth.signOut();
        } catch (error) {
          showToast("Не вдалося вийти з акаунта.");
          console.error(error);
        } finally {
          signOutButton.disabled = false;
        }
      });
    }

    auth.onAuthStateChanged(async (user) => {

      stopMarketSync();
      stopBlueMarketSync();
      if (marketChart) marketChart.stop();
      if (marketHistoryRecorder) marketHistoryRecorder.reset();
      stopPodiumSync();
      if (window.CrypBank) window.CrypBank.stop();
      stopHeartbeat();

      if (!user) {

        SAVE_KEY = null;
        currentUserUID = null;
        authScreen.hidden = false;
        gameApp.hidden = true;
        if (signOutButton) signOutButton.hidden = true;
        return;
      }

      try {
        currentUserUID = user.uid;
        SAVE_KEY = "cryp-mining-v01-" + user.uid;
        state = loadState();

        const db = firebase.db;
        const functions = firebase.functions;
        if (!functions) throw new Error("Cloud Functions недоступні");
        // The server creates the player (490 UAH) or returns the saved one. The browser sends nothing about progress.
        const init = await functions.httpsCallable("initPlayer")({});
        applyServerState(init.data);
        serverReady = true;
        startHeartbeat();

        // Independent shared rates start in parallel; a Blue failure never blocks CRYP or the game.
        await Promise.all([startMarketSync(db, user.uid), startBlueMarketSync(db, user.uid)]);
        startPodiumSync(db, user.uid);
        // CRYP BANK reads its own accounts and asks the server (openBankAccount) to open one; it never changes balances.
        if (window.CrypBank && db) window.CrypBank.start(db, user.uid, functions);

        els.playerName.value = state.playerName;
        render();
        if (user.displayName && (!state.playerName || state.playerName === "Гравець 1")) {
          serverAction("setPlayerName", { name: user.displayName.slice(0, 20) }).then(() => { els.playerName.value = state.playerName; });
        }

        authScreen.hidden = true;
        gameApp.hidden = false;
        if (signOutButton) signOutButton.hidden = false;
        syncChartVisibility();
        els.saveStatus.textContent = "Прогрес зберігається на сервері";
      } catch (error) {
        console.error("Не вдалося відкрити гру після входу:", error);

        authScreen.hidden = false;
        gameApp.hidden = true;
        authMessage.textContent = "Вхід виконано, але гра не змогла завантажитися. Перезавантаж сторінку; якщо проблема повториться, надішли скриншот.";
      }
    });
  }

  window.__crypAuthHandlersReady = Boolean(firebase && firebase.ready && firebase.auth);
  setAuthMode("login");
  // Run mining, price updates, and periodic saves once per second.
  window.setInterval(tick, 1000);
  window.addEventListener("beforeunload", save);
})();

