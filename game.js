(() => {
  "use strict";

  const SAVE_KEY = "cryp-mining-v01";
  const SLOT_COUNT = 16;
  const BILL_INTERVAL = 30 * 60 * 1000;
  const BILL_GRACE = 10 * 60 * 1000;
  const INTEREST_INTERVAL = 60 * 60 * 1000;
  const INTEREST_RATE = 0.25;

  const GPU_TYPES = [
    { id: "starter", name: "Starter GPU", icon: "▰", price: 250, rate: 0.02, power: 2 },
    { id: "rtx3060", name: "RTX 3060", icon: "▰", price: 600, rate: 0.06, power: 4 },
    { id: "rtx4090", name: "RTX 4090", icon: "▰", price: 1200, rate: 0.15, power: 7 }
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    cash: $("cashValue"), cryp: $("crypValue"), rate: $("rateValue"),
    gpuCount: $("gpuCount"), price: $("priceValue"), grid: $("farmGrid"),
    shop: $("shopList"), dialog: $("shopDialog"), dialogShop: $("dialogShopList"),
    slotHint: $("slotHint"), playerName: $("playerName"), billAmount: $("billAmount"),
    nextBill: $("nextBill"), payTimer: $("payTimer"), billStatus: $("billStatus"),
    billMessage: $("billMessage"), toast: $("toast"), saveStatus: $("saveStatus")
  };

  function newState() {
    const now = Date.now();
    return {
      playerName: "Гравець 1",
      cash: 1000,
      cryp: 0,
      price: 10,
      slots: Array(SLOT_COUNT).fill(null),
      bills: [],
      nextBillAt: now + BILL_INTERVAL,
      lastInterestAt: now,
      lastPriceAt: now,
      lastSavedAt: now
    };
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (saved && Array.isArray(saved.slots)) {
        const state = { ...newState(), ...saved };
        state.slots = Array.from({ length: SLOT_COUNT }, (_, i) => state.slots[i] || null);
        state.bills = Array.isArray(state.bills) ? state.bills : [];
        return state;
      }
    } catch (error) {
      console.warn("Не вдалося завантажити збереження:", error);
    }
    return newState();
  }

  let state = loadState();
  let selectedSlot = null;
  let hiddenAt = null;
  let lastVisibleTick = document.hidden ? null : Date.now();
  let toastTimeout = null;

  function money(value) {
    return "$" + Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function number(value, digits = 3) {
    return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function allGPUs() {
    return state.slots.filter(Boolean);
  }

  function totalRate() {
    return allGPUs().reduce((sum, gpu) => sum + (gpu.rate || 0), 0);
  }

  function electricityCost() {
    return Math.max(2, allGPUs().reduce((sum, gpu) => sum + (gpu.power || 0), 0));
  }

  function totalDebt() {
    return state.bills.reduce((sum, bill) => sum + bill.amount, 0);
  }

  function save() {
    state.lastSavedAt = Date.now();
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

  function formatTimer(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return String(minutes).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }

  function addMining(seconds) {
    if (seconds <= 0 || document.hidden) return;
    state.cryp += totalRate() * seconds;
  }

  function updateBills(now) {
    // Create every missed electricity bill using wall-clock time, even after a closed tab.
    let safety = 0;
    while (state.nextBillAt <= now && safety < 1000) {
      const issuedAt = state.nextBillAt;
      state.bills.push({
        id: String(issuedAt),
        amount: electricityCost(),
        issuedAt,
        dueAt: issuedAt + BILL_GRACE,
        lastInterestAt: issuedAt + BILL_GRACE
      });
      state.nextBillAt += BILL_INTERVAL;
      safety++;
    }

    // Add 25% to each overdue bill for each full hour late.
    for (const bill of state.bills) {
      if (now < bill.dueAt) continue;
      while (now - bill.lastInterestAt >= INTEREST_INTERVAL) {
        bill.amount *= 1 + INTEREST_RATE;
        bill.lastInterestAt += INTEREST_INTERVAL;
      }
    }
  }

  function updatePrice(now) {
    if (now - state.lastPriceAt >= 30000) {
      const intervals = Math.min(20, Math.floor((now - state.lastPriceAt) / 30000));
      for (let i = 0; i < intervals; i++) {
        const change = (Math.random() - 0.48) * 0.08;
        state.price = Math.max(1, Math.min(100, state.price * (1 + change)));
      }
      state.lastPriceAt = now;
    }
  }

  function renderStats() {
    els.cash.textContent = money(state.cash);
    els.cryp.textContent = number(state.cryp) + " CRYP";
    els.rate.textContent = number(totalRate()) + " CRYP/с";
    els.gpuCount.textContent = allGPUs().length + " / " + SLOT_COUNT + " відеокарт";
    els.price.textContent = money(state.price);
  }

  function renderFarm() {
    els.grid.replaceChildren();
    state.slots.forEach((gpu, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot" + (gpu ? " occupied" : "");
      button.setAttribute("aria-label", gpu ? gpu.name + ", слот " + (index + 1) : "Порожній слот " + (index + 1));
      if (gpu) {
        button.innerHTML = '<span class="gpu-icon">▰</span><span class="gpu-name"></span><span class="gpu-rate"></span><span class="slot-number">СЛОТ ' + String(index + 1).padStart(2, "0") + '</span>';
        button.querySelector(".gpu-name").textContent = gpu.name;
        button.querySelector(".gpu-rate").textContent = "+" + number(gpu.rate) + " CRYP/с";
        button.title = "Натисни, щоб прибрати цю відеокарту та повернути її в магазин не можна";
        button.addEventListener("click", () => showToast("Продаж відеокарт поки не доступний."));
      } else {
        button.innerHTML = '<span class="plus">＋</span><span>Встановити GPU</span><span class="slot-number">СЛОТ ' + String(index + 1).padStart(2, "0") + '</span>';
        button.addEventListener("click", () => openShop(index));
      }
      els.grid.appendChild(button);
    });
  }

  function shopCard(gpuType, target) {
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
    details.textContent = number(gpuType.rate) + " CRYP/с · електрика $" + gpuType.power + "/рахунок";
    info.append(title, details);
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "shop-buy";
    buy.textContent = money(gpuType.price);
    buy.disabled = state.cash < gpuType.price || allGPUs().length >= SLOT_COUNT;
    buy.addEventListener("click", () => purchaseGPU(gpuType, target));
    item.append(icon, info, buy);
    return item;
  }

  function renderShop() {
    els.shop.replaceChildren();
    GPU_TYPES.forEach((gpu) => els.shop.appendChild(shopCard(gpu, null)));
  }

  function openShop(slotIndex) {
    selectedSlot = slotIndex;
    els.slotHint.textContent = "Встановлення у слот " + (slotIndex + 1) + ". Відеокарта коштує гроші та збільшує витрати на електроенергію.";
    els.dialogShop.replaceChildren();
    GPU_TYPES.forEach((gpu) => els.dialogShop.appendChild(shopCard(gpu, slotIndex)));
    if (typeof els.dialog.showModal === "function") els.dialog.showModal();
    else els.dialog.setAttribute("open", "");
  }

  function purchaseGPU(gpuType, targetSlot) {
    if (state.cash < gpuType.price) {
      showToast("Недостатньо грошей для цієї відеокарти.");
      return;
    }
    let slot = targetSlot;
    if (slot === null || slot === undefined) slot = state.slots.findIndex((item) => item === null);
    if (slot < 0 || slot >= SLOT_COUNT || state.slots[slot]) {
      showToast("Немає вільних слотів.");
      return;
    }
    state.cash -= gpuType.price;
    state.slots[slot] = { id: gpuType.id, name: gpuType.name, rate: gpuType.rate, power: gpuType.power };
    if (els.dialog.open) els.dialog.close();
    render();
    save();
    showToast(gpuType.name + " встановлено у слот " + (slot + 1) + ".");
  }

  function renderBills(now) {
    const debt = totalDebt();
    els.billAmount.textContent = money(debt);
    els.nextBill.textContent = formatTimer(state.nextBillAt - now);
    if (!state.bills.length) {
      els.payTimer.textContent = "—";
      els.billStatus.textContent = "Немає боргу";
      els.billMessage.textContent = "Наступний рахунок буде через " + formatTimer(state.nextBillAt - now) + ".";
      return;
    }
    const oldest = state.bills.reduce((a, b) => a.issuedAt < b.issuedAt ? a : b);
    const remaining = oldest.dueAt - now;
    if (remaining > 0) {
      els.payTimer.textContent = formatTimer(remaining);
      els.billStatus.textContent = "Очікує оплати";
      els.billMessage.textContent = "До прострочення найближчого рахунку залишилось " + formatTimer(remaining) + ".";
    } else {
      els.payTimer.textContent = "Прострочено";
      els.billStatus.textContent = "Є прострочений борг";
      els.billMessage.textContent = "На прострочені рахунки нараховується 25% за кожну повну годину.";
    }
  }

  function render() {
    renderStats();
    renderFarm();
    renderShop();
    renderBills(Date.now());
  }

  function tick() {
    const now = Date.now();
    if (!document.hidden) {
      if (lastVisibleTick !== null) addMining(Math.max(0, Math.min(2, (now - lastVisibleTick) / 1000)));
      lastVisibleTick = now;
    } else {
      lastVisibleTick = null;
    }
    updateBills(now);
    updatePrice(now);
    renderStats();
    renderBills(now);
    if (Math.floor(now / 5000) !== Math.floor((now - 1000) / 5000)) save();
  }

  document.addEventListener("visibilitychange", () => {
    const now = Date.now();
    if (document.hidden) {
      hiddenAt = now;
      lastVisibleTick = null;
    } else {
      if (hiddenAt !== null) {
        // One final 60-second mining interval is allowed after the tab becomes hidden.
        const hiddenSeconds = Math.max(0, (now - hiddenAt) / 1000);
        addMining(Math.min(60, hiddenSeconds));
        hiddenAt = null;
      }
      lastVisibleTick = now;
      updateBills(now);
      updatePrice(now);
      render();
      save();
    }
  });

  $("openShop").addEventListener("click", () => {
    const freeSlot = state.slots.findIndex((item) => item === null);
    if (freeSlot === -1) return showToast("Усі слоти зайняті.");
    openShop(freeSlot);
  });
  $("closeShop").addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) els.dialog.close();
  });
  $("payBill").addEventListener("click", () => {
    const debt = totalDebt();
    if (debt <= 0) return showToast("Зараз немає рахунків до сплати.");
    if (state.cash < debt) {
      showToast("Недостатньо грошей. Потрібно " + money(debt) + ".");
      return;
    }
    state.cash -= debt;
    state.bills = [];
    render();
    save();
    showToast("Рахунки сплачено.");
  });
  $("resetButton").addEventListener("click", () => {
    const confirmed = window.confirm("Скинути всі гроші, CRYP, відеокарти та рахунки на цьому пристрої?");
    if (!confirmed) return;
    state = newState();
    hiddenAt = null;
    lastVisibleTick = document.hidden ? null : Date.now();
    els.playerName.value = state.playerName;
    render();
    save();
    showToast("Прогрес скинуто.");
  });
  els.playerName.value = state.playerName;
  els.playerName.addEventListener("change", () => {
    state.playerName = els.playerName.value.trim().slice(0, 20) || "Гравець 1";
    els.playerName.value = state.playerName;
    save();
  });

  // Billing and overdue interest are caught up by real elapsed time; mining never runs offline.
  updateBills(Date.now());
  render();
  save();
  setInterval(tick, 1000);
  window.addEventListener("beforeunload", save);
})();