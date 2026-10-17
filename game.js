(() => {
  "use strict";

  let SAVE_KEY = null;
  let currentUserUID = null;
  let cloudSaveReady = false;
  let cloudSaveTimer = null;
  let cloudSaveInProgress = Promise.resolve();
  const SLOT_COUNT = 16;
  const MIN_PRICE = 0.25;
  const MAX_PRICE = 7;

  const GPU_TYPES = [
    { id: "starter", name: "Starter GPU", icon: "▰", price: 250, rate: 0.02 },
    { id: "rtx3060", name: "RTX 3060", icon: "▰", price: 600, rate: 0.06 },
    { id: "rtx4090", name: "RTX 4090", icon: "▰", price: 1200, rate: 0.15 }
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    cash: $("cashValue"), cryp: $("crypValue"), rate: $("rateValue"),
    gpuCount: $("gpuCount"), price: $("priceValue"), grid: $("farmGrid"),
    shop: $("shopList"), inventory: $("inventoryList"),
    inventoryHint: $("inventoryHint"), inventoryModal: $("inventoryModal"),
    gpuActionModal: $("gpuActionModal"), gpuActionDetails: $("gpuActionDetails"),
    playerName: $("playerName"), toast: $("toast"), saveStatus: $("saveStatus"),
    sellAmount: $("sellAmount"), sellPreview: $("sellPreview"),
    exchangePrice: $("exchangePrice"), exchangeBalance: $("exchangeBalance"), marketStatus: $("marketStatus"),
    podiumRows: $("podiumRows"), podiumStatus: $("podiumStatus"), podiumUpdatedAt: $("podiumUpdatedAt")
  };

  function newState() {
    return {
      playerName: "Гравець 1",
      cash: 490,
      cryp: 0,
      slots: Array(SLOT_COUNT).fill(null),
      inventory: []
    };
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
  let podiumUnsubscribe = null;
  let podiumPublishTimer = null;
  let podiumProfiles = [];
  let lastPodiumPublishAt = 0;
  let lastPodiumPublishSignature = "";

  function loadState() {
    try {
      const saved = SAVE_KEY ? JSON.parse(localStorage.getItem(SAVE_KEY)) : null;
      if (saved && Array.isArray(saved.slots)) {
        const state = { ...newState(), ...saved };
        state.slots = Array.from({ length: SLOT_COUNT }, (_, i) => state.slots[i] || null);
        state.inventory = Array.isArray(saved.inventory) ? saved.inventory : [];
        // Preserve purchase cost for old saves and new cards.
        const costFor = (gpu) => Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0);
        state.slots = state.slots.map((gpu) => gpu ? { ...gpu, cost: costFor(gpu) } : null);
        state.inventory = state.inventory.map((gpu) => ({ ...gpu, cost: costFor(gpu) }));
        // Update untouched older saves to the current starting balance without changing active progress.
        if ((saved.cash === 300 || saved.cash === 1000) && saved.cryp === 0 && state.slots.every((gpu) => !gpu) && state.inventory.length === 0) state.cash = 490;
        // Older local saves may contain a device-specific rate; the shared Firestore market is authoritative.
        delete state.price;
        delete state.lastPriceAt;
        delete state.trendDirection;
        delete state.trendTicksLeft;
        return state;
      }
    } catch (error) {
      console.warn("Не вдалося завантажити збереження:", error);
    }
    return newState();
  }

  let state = loadState();
  let targetSlotIndex = null;
  let actionSlotIndex = null;
  let lastVisibleTick = document.hidden ? null : Date.now();
  let hiddenAt = null;
  let toastTimeout = null;

  function money(value) {
    return Number(value || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴";
  }

  function number(value, digits = 3) {
    return Number(value || 0).toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function allGPUs() {
    return state.slots.filter(Boolean);
  }

  function totalRate() {
    return allGPUs().reduce((sum, gpu) => sum + (gpu.rate || 0), 0);
  }

  function save() {
    if (!SAVE_KEY) return;

    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      if (!cloudSaveReady || !currentUserUID || !window.crypFirebase?.db) {
        els.saveStatus.textContent = "Збережено на цьому пристрої";
        return;
      }

      clearTimeout(cloudSaveTimer);
      cloudSaveTimer = setTimeout(() => {
        const uid = currentUserUID;
        const stateToSave = JSON.parse(JSON.stringify(state));
        cloudSaveInProgress = cloudSaveInProgress
          .catch(() => {})
          .then(() => {
            if (uid !== currentUserUID || !cloudSaveReady) return;
            return window.crypFirebase.db.collection("players").doc(uid).set({
              ...stateToSave,
              updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
            }).then(() => {
              if (uid === currentUserUID) {
                els.saveStatus.textContent = "Збережено в хмарі";
                queuePodiumPublish(window.crypFirebase.db, uid);
              }
            });
          })
          .catch((error) => {
            console.error("Помилка хмарного збереження:", error);
            if (uid === currentUserUID) els.saveStatus.textContent = "Хмарне збереження не працює — перевір правила Firestore";
          });
      }, 500);
    } catch (error) {
      console.error("Не вдалося зберегти:", error);
      els.saveStatus.textContent = "Не вдалося зберегти";
    }
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  function addMining(seconds) {
    if (seconds <= 0 || document.hidden) return;
    state.cryp += totalRate() * seconds;
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

  function normalizedMarketState(data) {
    const parsedLastAt = Number(data.lastPriceAt);
    const direction = Number(data.trendDirection);
    const ticksLeft = Number(data.trendTicksLeft);
    return {
      price: clampPrice(data.price),
      trendDirection: direction === -1 || direction === 1 ? direction : 0,
      trendTicksLeft: Number.isFinite(ticksLeft) ? Math.max(0, Math.floor(ticksLeft)) : 0,
      lastPriceAt: Number.isFinite(parsedLastAt) && parsedLastAt > 0 ? parsedLastAt : Date.now()
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
        if (els.marketStatus) els.marketStatus.textContent = "Спільний курс синхронізується через Firestore.";
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
    window.crypFirebase.db.runTransaction(async (transaction) => {
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
    }).catch((error) => {
      console.error("Не вдалося оновити спільний курс:", error);
      if (uid === currentUserUID && els.marketStatus) {
        els.marketStatus.textContent = "Не вдалося оновити спільний курс — перевір правила Firestore.";
      }
    }).finally(() => {
      marketUpdateInProgress = false;
    });
  }

  function renderStats() {
    els.cash.textContent = money(state.cash);
    els.cryp.textContent = number(state.cryp) + " CRYP";
    els.rate.textContent = number(totalRate()) + " CRYP/с";
    els.gpuCount.textContent = allGPUs().length + " / " + SLOT_COUNT + " встановлено";
    els.price.textContent = marketReady ? money(marketState.price) : "—";
    $("infoCash").textContent = money(state.cash);
    $("infoCryp").textContent = number(state.cryp) + " CRYP";
    $("infoRate").textContent = number(totalRate()) + " CRYP/с";
    $("infoInventory").textContent = String(state.inventory.length);
    $("infoPrice").textContent = marketReady ? money(marketState.price) : "—";
    if (els.exchangePrice) els.exchangePrice.textContent = marketReady ? money(marketState.price) : "—";
    if (els.exchangeBalance) els.exchangeBalance.textContent = number(state.cryp) + " CRYP";
    updateSellPreview();
    renderPodium();
  }

  function renderPodiumMessage(message) {
    if (!els.podiumRows) return;
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
    if (podiumPublishTimer) clearTimeout(podiumPublishTimer);
    podiumPublishTimer = null;
    podiumProfiles = [];
  }

  function queuePodiumPublish(db, expectedUID) {
    if (!db || !expectedUID || expectedUID !== currentUserUID || !cloudSaveReady) return;
    if (podiumPublishTimer) return;

    const delay = Math.max(0, 60000 - (Date.now() - lastPodiumPublishAt));
    podiumPublishTimer = setTimeout(async () => {
      podiumPublishTimer = null;
      if (expectedUID !== currentUserUID || !cloudSaveReady) return;

      const profile = {
        nickname: String(state.playerName || "Гравець").trim().slice(0, 20) || "Гравець",
        cashBalance: Math.max(0, Number(state.cash) || 0),
        crypBalance: Math.max(0, Number(state.cryp) || 0)
      };
      const signature = JSON.stringify(profile);
      if (signature === lastPodiumPublishSignature) return;

      try {
        await db.collection("podiumPlayers").doc(expectedUID).set({
          ...profile,
          updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
        lastPodiumPublishSignature = signature;
        lastPodiumPublishAt = Date.now();
      } catch (error) {
        console.error("Не вдалося оновити публічний рядок Подіуму:", error);
        if (els.podiumStatus) els.podiumStatus.textContent = "Не вдалося оновити рейтинг — перевір правила Firestore.";
      }
    }, delay);
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

  function renderPodium() {
    if (!els.podiumRows) return;
    const entries = podiumProfiles.map((profile) => ({
      nickname: profile.nickname || "Гравець",
      cashBalance: Math.max(0, Number(profile.cashBalance) || 0),
      totalCapital: Math.max(0, Number(profile.cashBalance) || 0)
        + Math.max(0, Number(profile.crypBalance) || 0) * (marketReady ? marketState.price : 1),
      updatedAt: profile.updatedAt
    })).sort((a, b) => b.totalCapital - a.totalCapital || a.nickname.localeCompare(b.nickname, "uk")).slice(0, 10);
    els.podiumRows.replaceChildren();

    if (!entries.length) {
      renderPodiumMessage("Рейтинг з’явиться, коли гравці зайдуть у гру.");
    } else {
      entries.forEach((entry, index) => {
        const row = document.createElement("tr");
        const rank = document.createElement("td");
        const nickname = document.createElement("td");
        const cash = document.createElement("td");
        const total = document.createElement("td");
        rank.textContent = String(Number(entry.rank) || index + 1);
        nickname.textContent = String(entry.nickname || "Гравець").slice(0, 20);
        cash.textContent = money(entry.cashBalance);
        total.textContent = money(entry.totalCapital);
        row.append(rank, nickname, cash, total);
        els.podiumRows.appendChild(row);
      });
    }

    const latest = entries.map((entry) => entry.updatedAt)
      .filter(Boolean)
      .sort((a, b) => b.toMillis() - a.toMillis())[0] || null;
    els.podiumUpdatedAt.textContent = formatPodiumUpdatedAt(latest);
    els.podiumUpdatedAt.dateTime = latest && typeof latest.toDate === "function" ? latest.toDate().toISOString() : "";
    els.podiumStatus.textContent = "Показано " + entries.length + " із 10 місць. Дані оновлюються, коли гравці заходять у гру.";
  }

  function startPodiumSync(db, expectedUID) {
    stopPodiumSync();
    if (!db || expectedUID !== currentUserUID) return;
    els.podiumStatus.textContent = "Завантажуємо рейтинг…";
    renderPodiumMessage("Рейтинг з’явиться, коли гравці зайдуть у гру.");

    podiumUnsubscribe = db.collection("podiumPlayers").onSnapshot((snapshot) => {
      if (expectedUID !== currentUserUID) return;
      podiumProfiles = snapshot.docs.map((doc) => doc.data() || {});
      renderPodium();
    }, (error) => {
      if (expectedUID !== currentUserUID) return;
      console.error("Не вдалося завантажити рейтинг:", error);
      renderPodiumMessage("Не вдалося завантажити рейтинг.");
      els.podiumStatus.textContent = "Перевір правила Firestore для рейтингу.";
      els.podiumUpdatedAt.textContent = "—";
    });
  }

  function renderFarm() {
    els.grid.replaceChildren();
    state.slots.forEach((gpu, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot" + (gpu ? " occupied" : "");
      button.setAttribute("aria-label", gpu ? gpu.name + ", слот " + (index + 1) : "Порожній слот " + (index + 1));
      if (gpu) {
        const icon = document.createElement("span");
        icon.className = "farm-gpu-icon";
        icon.textContent = gpu.icon || "▰";
        button.appendChild(icon);
        button.title = gpu.name + " — натисни для дій";
        button.addEventListener("click", () => openGPUActions(index));
      } else {
        const plus = document.createElement("span");
        plus.className = "plus";
        plus.textContent = "+";
        button.appendChild(plus);
        button.addEventListener("click", () => openInventory(index));
      }
      els.grid.appendChild(button);
    });
  }

  function shopCard(gpuType) {
    const item = document.createElement("div");
    item.className = "shop-item";
    const icon = document.createElement("div");
    icon.className = "gpu-icon";
    icon.textContent = gpuType.icon;
    const info = document.createElement("div");
    info.className = "shop-info";
    const title = document.createElement("strong");
    title.textContent = gpuType.name;
    const details = document.createElement("span");
    details.textContent = number(gpuType.rate) + " CRYP/с · дохід від майнінгу";
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

  function renderShop() {
    els.shop.replaceChildren();
    GPU_TYPES.forEach((gpu) => els.shop.appendChild(shopCard(gpu)));
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
      const icon = document.createElement("div");
      icon.className = "gpu-icon";
      icon.textContent = gpu.icon || "▰";
      const info = document.createElement("div");
      info.className = "shop-info";
      const title = document.createElement("strong");
      title.textContent = gpu.name;
      const details = document.createElement("span");
      details.textContent = number(gpu.rate) + " CRYP/с";
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

  function purchaseGPU(gpuType) {
    if (state.cash < gpuType.price) {
      showToast("Недостатньо гривень для цієї відеокарти.");
      return;
    }
    state.cash -= gpuType.price;
    state.inventory.push({
      inventoryId: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
      id: gpuType.id,
      name: gpuType.name,
      icon: gpuType.icon,
      rate: gpuType.rate,
      cost: gpuType.price
    });
    render();
    save();
    showToast(gpuType.name + " додано в інвентар.");
  }

  function openGPUActions(slotIndex) {
    const gpu = state.slots[slotIndex];
    if (!gpu) return;
    actionSlotIndex = slotIndex;
    const resalePrice = (Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0)) * 0.5;
    els.gpuActionDetails.textContent = gpu.name + " · " + number(gpu.rate) + " CRYP/с · Продаж: " + money(resalePrice);
    els.gpuActionModal.hidden = false;
    $("removeGpuButton").focus();
  }

  function closeGPUActions() {
    els.gpuActionModal.hidden = true;
    actionSlotIndex = null;
  }

  function removeGPUFromFarm() {
    if (actionSlotIndex === null) return;
    const slotIndex = actionSlotIndex;
    const gpu = state.slots[slotIndex];
    if (!gpu) {
      closeGPUActions();
      return;
    }

    state.inventory.push({
      inventoryId: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
      id: gpu.id,
      name: gpu.name,
      icon: gpu.icon || "▰",
      rate: gpu.rate || 0,
      cost: Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0)
    });
    state.slots[slotIndex] = null;
    closeGPUActions();
    render();
    save();
    showToast(gpu.name + " знято з ферми та повернуто в інвентар.");
  }

  function sellGPUFromFarm() {
    if (actionSlotIndex === null) return;
    const slotIndex = actionSlotIndex;
    const gpu = state.slots[slotIndex];
    if (!gpu) {
      closeGPUActions();
      return;
    }
    const originalCost = Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0);
    const resalePrice = originalCost * 0.5;
    state.cash += resalePrice;
    state.slots[slotIndex] = null;
    closeGPUActions();
    render();
    save();
    showToast(gpu.name + " продано за " + money(resalePrice) + " (50% від собівартості).");
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

  function installInventoryGPU(inventoryId) {
    if (targetSlotIndex === null || state.slots[targetSlotIndex]) {
      closeInventory();
      return;
    }
    const inventoryIndex = state.inventory.findIndex((gpu) => gpu.inventoryId === inventoryId);
    if (inventoryIndex < 0) return;
    const gpu = state.inventory.splice(inventoryIndex, 1)[0];
    state.slots[targetSlotIndex] = { id: gpu.id, name: gpu.name, icon: gpu.icon, rate: gpu.rate, cost: Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0) };
    const installedName = gpu.name;
    closeInventory();
    render();
    save();
    showToast(installedName + " встановлено на ферму.");
  }

  function updateSellPreview() {
    if (!els.sellAmount || !els.sellPreview) return;
    const amount = Math.max(0, Number(els.sellAmount.value) || 0);
    els.sellPreview.textContent = money(marketReady ? Math.min(amount, state.cryp) * marketState.price : 0);
  }

  function sellCRYP() {
    if (!marketReady) {
      showToast("Спільний курс ще не завантажився. Спробуй трохи пізніше.");
      return;
    }
    const amount = Number(els.sellAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Введи кількість CRYP, яку хочеш продати.");
      return;
    }
    if (amount > state.cryp + 1e-9) {
      showToast("У тебе недостатньо CRYP для цієї операції.");
      return;
    }
    const proceeds = amount * marketState.price;
    state.cryp = Math.max(0, state.cryp - amount);
    state.cash += proceeds;
    els.sellAmount.value = "";
    render();
    save();
    showToast("Продано " + number(amount) + " CRYP за " + money(proceeds) + ".");
  }

  function showPage(pageName) {
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
    renderStats();
    if (Math.floor(now / 5000) !== Math.floor((now - 1000) / 5000)) save();
  }

  document.addEventListener("visibilitychange", () => {
    const now = Date.now();
    if (document.hidden) {
      hiddenAt = now;
      lastVisibleTick = null;
    } else {
      if (hiddenAt !== null) {
        const hiddenSeconds = Math.max(0, (now - hiddenAt) / 1000);
        addMining(Math.min(60, hiddenSeconds));
        hiddenAt = null;
      }
      lastVisibleTick = now;
      updatePrice(now);
      render();
      save();
    }
  });

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
  $("sellButton").addEventListener("click", sellCRYP);
  $("sellAllButton").addEventListener("click", () => {
    els.sellAmount.value = state.cryp > 0 ? String(state.cryp) : "";
    updateSellPreview();
    if (state.cryp > 0) sellCRYP();
    else showToast("Поки що немає CRYP для продажу.");
  });

  els.playerName.value = state.playerName;
  els.playerName.addEventListener("change", () => {
    state.playerName = els.playerName.value.trim().slice(0, 20) || "Гравець 1";
    els.playerName.value = state.playerName;
    save();
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
      stopPodiumSync();
      cloudSaveReady = false;
      clearTimeout(cloudSaveTimer);

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
        if (db) {
          const playerRef = db.collection("players").doc(user.uid);
          try {
            const snapshot = await playerRef.get();
            if (snapshot.exists) {
              const remote = snapshot.data();
              if (remote && Array.isArray(remote.slots)) {
                const costFor = (gpu) => Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0);
                state = { ...newState(), ...remote };
                delete state.price;
                delete state.lastPriceAt;
                delete state.trendDirection;
                delete state.trendTicksLeft;
                state.slots = Array.from({ length: SLOT_COUNT }, (_, i) => state.slots[i] || null)
                  .map((gpu) => gpu ? { ...gpu, cost: costFor(gpu) } : null);
                state.inventory = Array.isArray(remote.inventory) ? remote.inventory.map((gpu) => ({ ...gpu, cost: costFor(gpu) })) : [];
                // Update untouched older cloud saves to the current starting balance.
                if ((remote.cash === 300 || remote.cash === 1000) && remote.cryp === 0 && state.slots.every((gpu) => !gpu) && state.inventory.length === 0) state.cash = 490;
                localStorage.setItem(SAVE_KEY, JSON.stringify(state));
              }
            } else {
              // First login on a device uploads its existing local save instead of discarding it.
              const firstCloudSave = { ...state };
              await playerRef.set({
                ...firstCloudSave,
                updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
              });
            }
            cloudSaveReady = true;
          } catch (cloudError) {
            console.error("Не вдалося завантажити/створити хмарне збереження:", cloudError);
            els.saveStatus.textContent = "Не вдалося підключити хмарне збереження — перевір правила Firestore";
          }
        }

        await startMarketSync(db, user.uid);
        startPodiumSync(db, user.uid);

        if (user.displayName && (!state.playerName || state.playerName === "Гравець 1")) {
          state.playerName = user.displayName.slice(0, 20);
        }
        els.playerName.value = state.playerName;
        render();

        authScreen.hidden = true;
        gameApp.hidden = false;
        if (signOutButton) signOutButton.hidden = false;
        if (cloudSaveReady) {
          els.saveStatus.textContent = "Хмарне збереження підключено";
          save();
        } else {
          els.saveStatus.textContent = "Локальне збереження; хмара не підключена";
          save();
        }
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