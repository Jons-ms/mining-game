(() => {
  "use strict";

  const SAVE_KEY = "cryp-mining-v01";
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
    inventoryCount: $("inventoryCount"), inventoryHint: $("inventoryHint"),
    playerName: $("playerName"), toast: $("toast"), saveStatus: $("saveStatus")
  };

  function newState() {
    const now = Date.now();
    return {
      playerName: "Гравець 1",
      cash: 300,
      cryp: 0,
      price: 1,
      slots: Array(SLOT_COUNT).fill(null),
      inventory: [],
      lastPriceAt: now
    };
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (saved && Array.isArray(saved.slots)) {
        const state = { ...newState(), ...saved };
        state.slots = Array.from({ length: SLOT_COUNT }, (_, i) => state.slots[i] || null);
        state.inventory = Array.isArray(saved.inventory) ? saved.inventory : [];
        // Convert the previous prototype's untouched starting balance to the new starting balance.
        if (saved.cash === 1000 && saved.cryp === 0 && state.slots.every((gpu) => !gpu)) state.cash = 300;
        state.price = Math.max(MIN_PRICE, Math.min(MAX_PRICE, Number(state.price) || 1));
        return state;
      }
    } catch (error) {
      console.warn("Не вдалося завантажити збереження:", error);
    }
    return newState();
  }

  let state = loadState();
  let selectedInventoryId = null;
  let lastVisibleTick = document.hidden ? null : Date.now();
  let hiddenAt = null;
  let toastTimeout = null;

  function money(value) {
    return Number(value || 0).toLocaleString("uk-UA", { style: "currency", currency: "EUR" })
      .replace("€", "₴").replace(/\u00a0/g, " ");
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
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      els.saveStatus.textContent = "Збережено на цьому пристрої";
    } catch (error) {
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

  function updatePrice(now) {
    if (now - state.lastPriceAt >= 30000) {
      const intervals = Math.min(20, Math.floor((now - state.lastPriceAt) / 30000));
      for (let i = 0; i < intervals; i++) {
        const change = (Math.random() - 0.5) * 0.18;
        state.price = Math.max(MIN_PRICE, Math.min(MAX_PRICE, state.price * (1 + change)));
      }
      state.lastPriceAt = now;
    }
  }

  function renderStats() {
    els.cash.textContent = money(state.cash);
    els.cryp.textContent = number(state.cryp) + " CRYP";
    els.rate.textContent = number(totalRate()) + " CRYP/с";
    els.gpuCount.textContent = allGPUs().length + " / " + SLOT_COUNT + " встановлено";
    els.price.textContent = money(state.price);
  }

  function renderFarm() {
    els.grid.replaceChildren();
    state.slots.forEach((gpu, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot" + (gpu ? " occupied" : "") +
        (selectedInventoryId && !gpu ? " farm-slot-selected" : "");
      button.setAttribute("aria-label", gpu ? gpu.name + ", слот " + (index + 1) : "Порожній слот " + (index + 1));
      if (gpu) {
        const icon = document.createElement("span");
        icon.className = "farm-gpu-icon";
        icon.textContent = gpu.icon || "▰";
        button.appendChild(icon);
        button.title = gpu.name;
        button.addEventListener("click", () => showToast("Щоб перемістити карту, ця функція поки недоступна."));
      } else {
        const plus = document.createElement("span");
        plus.className = "plus";
        plus.textContent = "+";
        button.appendChild(plus);
        button.addEventListener("click", () => installSelectedGPU(index));
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
    els.inventoryCount.textContent = state.inventory.length + " відеокарт";
    if (!state.inventory.length) {
      const empty = document.createElement("div");
      empty.className = "empty-inventory";
      empty.textContent = "Інвентар порожній. Купи відеокарту в магазині.";
      els.inventory.appendChild(empty);
      els.inventoryHint.textContent = "Куплені відеокарти зберігатимуться тут, доки ти не встановиш їх на ферму.";
      return;
    }
    els.inventoryHint.textContent = selectedInventoryId
      ? "Тепер натисни «+» у вільній клітинці ферми, щоб установити вибрану карту."
      : "Натисни «Обрати», а потім «+» у вільній клітинці ферми.";
    state.inventory.forEach((gpu) => {
      const item = document.createElement("div");
      item.className = "shop-item inventory-item" + (selectedInventoryId === gpu.inventoryId ? " selected" : "");
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
      choose.textContent = selectedInventoryId === gpu.inventoryId ? "Обрано" : "Обрати";
      choose.addEventListener("click", () => {
        selectedInventoryId = selectedInventoryId === gpu.inventoryId ? null : gpu.inventoryId;
        renderInventory();
        renderFarm();
      });
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
      rate: gpuType.rate
    });
    render();
    save();
    showToast(gpuType.name + " додано в інвентар.");
  }

  function installSelectedGPU(slotIndex) {
    if (!selectedInventoryId) {
      showToast("Спочатку обери відеокарту в інвентарі.");
      return;
    }
    if (state.slots[slotIndex]) {
      showToast("Ця клітинка вже зайнята.");
      return;
    }
    const inventoryIndex = state.inventory.findIndex((gpu) => gpu.inventoryId === selectedInventoryId);
    if (inventoryIndex < 0) {
      selectedInventoryId = null;
      renderInventory();
      return;
    }
    const gpu = state.inventory.splice(inventoryIndex, 1)[0];
    state.slots[slotIndex] = { id: gpu.id, name: gpu.name, icon: gpu.icon, rate: gpu.rate };
    selectedInventoryId = null;
    render();
    save();
    showToast(gpu.name + " встановлено на ферму.");
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

  $("openShop").addEventListener("click", () => {
    document.querySelector(".shop-list").scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("Обери відеокарту в магазині, щоб купити її в інвентар.");
  });

  els.playerName.value = state.playerName;
  els.playerName.addEventListener("change", () => {
    state.playerName = els.playerName.value.trim().slice(0, 20) || "Гравець 1";
    els.playerName.value = state.playerName;
    save();
  });

  render();
  save();
  setInterval(tick, 1000);
  window.addEventListener("beforeunload", save);
})();