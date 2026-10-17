"use strict";

const { initializeApp } = require("firebase-admin/app");
const { FieldPath, getFirestore } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");

initializeApp();

const db = getFirestore();
const PAGE_SIZE = 500;
const MAX_AMOUNT = 1_000_000_000_000;
const MIN_PRICE = 0.25;
const MAX_PRICE = 7;

function amount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_AMOUNT);
}

function currentPrice(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, parsed));
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

exports.updatePodiumHourly = onSchedule({
  schedule: "every 60 minutes",
  timeZone: "Europe/Kyiv",
  region: "europe-west1",
  timeoutSeconds: 300,
}, async () => {
  const marketSnapshot = await db.doc("market/exchangeRate").get();
  const rate = currentPrice(marketSnapshot.exists ? marketSnapshot.get("price") : 1);
  const playersRef = db.collection("players");
  const ranked = [];
  let cursor = null;

  while (true) {
    let query = playersRef.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const page = await query.get();
    if (page.empty) break;

    page.forEach((playerDoc) => {
      const player = playerDoc.data();
      const cashBalance = amount(player.cash);
      const crypBalance = amount(player.cryp);
      const totalCapital = cashBalance + crypBalance * rate;
      if (!Number.isFinite(totalCapital)) return;

      const nickname = typeof player.playerName === "string" && player.playerName.trim()
        ? player.playerName.trim().slice(0, 20)
        : "Гравець";

      ranked.push({
        uid: playerDoc.id,
        nickname,
        cashBalance,
        totalCapital,
      });
    });

    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) break;
  }

  ranked.sort((a, b) =>
    b.totalCapital - a.totalCapital
      || b.cashBalance - a.cashBalance
      || a.nickname.localeCompare(b.nickname, "uk")
      || a.uid.localeCompare(b.uid)
  );

  const players = ranked.slice(0, 10).map((player, index) => ({
    rank: index + 1,
    nickname: player.nickname,
    cashBalance: roundMoney(player.cashBalance),
    totalCapital: roundMoney(player.totalCapital),
  }));

  await db.doc("podium/current").set({
    players,
    updatedAt: require("firebase-admin/firestore").Timestamp.now(),
  });

  console.info("Hourly podium updated", { playerCount: players.length });
});
