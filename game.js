(() => {
  "use strict";

  let SAVE_KEY = null;
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
    exchangePrice: $("exchangePrice"), exchangeBalance: $("exchangeBalance")
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
      const saved = SAVE_KEY ? JSON.parse(localStorage.getItem(SAVE_KEY)) : null;
      if (saved && Array.isArray(saved.slots)) {
        const state = { ...newState(), ...saved };
        state.slots = Array.from({ length: SLOT_COUNT }, (_, i) => state.slots[i] || null);
        state.inventory = Array.isArray(saved.inventory) ? saved.inventory : [];
        // Preserve purchase cost for old saves and new cards.
        const costFor = (gpu) => Number(gpu.cost) || (GPU_TYPES.find((type) => type.id === gpu.id)?.price ?? 0);
        state.slots = state.slots.map((gpu) => gpu ? { ...gpu, cost: costFor(gpu) } : null);
        state.inventory = state.inventory.map((gpu) => ({ ...gpu, cost: costFor(gpu) }));
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
    try {
      if (!SAVE_KEY) return;
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      els.saveStatus.textContent = "Збережено локально для цього акаунта";
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
    $("infoCash").textContent = money(state.cash);
    $("infoCryp").textContent = number(state.cryp) + " CRYP";
    $("infoRate").textContent = number(totalRate()) + " CRYP/с";
    $("infoInventory").textContent = String(state.inventory.length);
    $("infoPrice").textContent = money(state.price);
    if (els.exchangePrice) els.exchangePrice.textContent = money(state.price);
    if (els.exchangeBalance) els.exchangeBalance.textContent = number(state.cryp) + " CRYP";
    updateSellPreview();
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
    els.sellPreview.textContent = money(Math.min(amount, state.cryp) * state.price);
  }

  function sellCRYP() {
    const amount = Number(els.sellAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Введи кількість CRYP, яку хочеш продати.");
      return;
    }
    if (amount > state.cryp + 1e-9) {
      showToast("У тебе недостатньо CRYP для цієї операції.");
      return;
    }
    const proceeds = amount * state.price;
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

  document.querySelectorAll(".nav-button").forEach((button) => {
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
  let authListenerStarted = false;

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
      "auth/operation-not-allowed": "Цей спосіб входу не ввімкнено у Firebase Console."
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
    const auth = firebase.auth();

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

      try {
        if (authMode === "register") {
          const credential = await auth.createUserWithEmailAndPassword(syntheticEmail, password);
          await credential.user.updateProfile({ displayName: username });
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
        const provider = new firebase.app.auth.GoogleAuthProvider();
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

    auth.onAuthStateChanged((user) => {
      authListenerStarted = true;
      if (!user) {
        SAVE_KEY = null;
        authScreen.hidden = false;
        gameApp.hidden = true;
        if (signOutButton) signOutButton.hidden = true;
        return;
      }

      SAVE_KEY = "cryp-mining-v01-" + user.uid;
      state = loadState();
      if (user.displayName && (!state.playerName || state.playerName === "Гравець 1")) {
        state.playerName = user.displayName.slice(0, 20);
      }
      authScreen.hidden = true;
      gameApp.hidden = false;
      if (signOutButton) signOutButton.hidden = false;
      els.playerName.value = state.playerName;
      els.saveStatus.textContent = "Збереження лише на цьому пристрої; хмарна синхронізація ще не підключена";
      render();
      save();
    });
  }

  setAuthMode("login");
  window.addEventListener("beforeunload", save);
})();