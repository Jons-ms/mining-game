"use strict";
/* Podium snapshot shared by the hourly Cloud Function and the migration script (db is passed in, so no SDK is loaded here). */
const engine = require("./engine.js");

// One query for players, two reads for the rates, one write. Rates are read at the moment of the snapshot.
async function buildPodiumSnapshot(db, FieldValue) {
  const [players, cryp, blue] = await Promise.all([
    db.collection("players").where("serverManaged", "==", true).get(),
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

module.exports = { buildPodiumSnapshot };
