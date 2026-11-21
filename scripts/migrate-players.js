#!/usr/bin/env node
"use strict";
/*
 * One-time migration of existing players to the server-managed format.
 *
 *   cd functions && npm install && cd ..
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   node scripts/migrate-players.js            # dry run: backup + report, writes nothing
 *   node scripts/migrate-players.js --apply    # migrates, then verifies every player
 *
 * It never deletes anything. A JSON backup of the affected collections is written to backups/<timestamp>/ first
 * (also take a full `gcloud firestore export gs://<bucket>/<folder>` before --apply).
 * Re-running is safe: players that are already migrated are skipped, and each player is keyed by its Firebase UID,
 * so no duplicates can appear.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const requireFromFunctions = createRequire(path.join(__dirname, "..", "functions", "package.json"));
const admin = requireFromFunctions("firebase-admin");
const engine = require("../functions/lib/engine.js");

const APPLY = process.argv.includes("--apply");
const BACKUP_COLLECTIONS = ["players", "podiumPlayers", "bankAccounts", "market"];

function plain(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (v && typeof v.toDate === "function" ? v.toDate().toISOString() : v)));
}

function catalogMismatches(uid, state) {
  const found = [];
  const check = (gpu, where) => {
    const type = engine.GPU_TYPES.find((t) => t.id === gpu.id);
    if (!type) found.push(`${uid}: unknown card id "${gpu.id}" (${where})`);
    else if (gpu.rate !== type.rate || gpu.cost !== type.price) found.push(`${uid}: ${gpu.id} (${where}) rate=${gpu.rate} cost=${gpu.cost}, catalog rate=${type.rate} price=${type.price}`);
  };
  state.slots.forEach((g) => g && check(g, "farm"));
  state.extraSlots.forEach((g) => g && check(g, "extra field"));
  state.inventory.forEach((g) => check(g, "inventory"));
  return found;
}

const summary = (s) => ({
  cash: s.cash, cryp: s.cryp, blue: s.blue,
  farm: s.slots.filter(Boolean).length, extra: s.extraSlots.filter(Boolean).length, inventory: s.inventory.length,
  hasExtraField: s.hasExtraField, unlocked: s.extraUnlockedSlots.filter(Boolean).length
});

async function main() {
  admin.initializeApp();
  const db = admin.firestore();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(__dirname, "..", "backups", stamp);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of BACKUP_COLLECTIONS) {
    const snap = await db.collection(name).get();
    fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) })), null, 2));
    console.log(`backup: ${name} -> ${snap.size} documents`);
  }
  console.log(`backup folder: ${dir}`);

  const players = await db.collection("players").get();
  const report = { total: players.size, alreadyMigrated: 0, toMigrate: 0, migrated: 0, verifiedOk: 0, problems: [], catalogDifferences: [] };

  for (const doc of players.docs) {
    const raw = doc.data();
    if (raw.serverManaged === true) { report.alreadyMigrated += 1; continue; }
    report.toMigrate += 1;
    const state = engine.normalizeState(raw, 0);
    const before = summary(engine.normalizeState(raw, 0));
    report.catalogDifferences.push(...catalogMismatches(doc.id, state));
    // sanity: normalisation must not lose money or cards
    const rawCards = [].concat(raw.slots || [], raw.extraSlots || [], raw.inventory || []).filter(Boolean).length;
    const stateCards = before.farm + before.extra + before.inventory;
    if (rawCards !== stateCards) report.problems.push(`${doc.id}: card count ${rawCards} -> ${stateCards}`);
    if (!APPLY) continue;

    state.lastMiningAt = Date.now();
    await doc.ref.set({ ...state, serverManaged: true, schema: 2, migratedAt: admin.firestore.FieldValue.serverTimestamp() });
    report.migrated += 1;
    const after = summary(engine.normalizeState((await doc.ref.get()).data(), 0));
    if (JSON.stringify(after) === JSON.stringify(before)) report.verifiedOk += 1;
    else report.problems.push(`${doc.id}: verification mismatch ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  }

  if (APPLY) {
    const { buildPodiumSnapshot } = requireFromFunctions("./index.js");
    console.log(`podium snapshot written (${await buildPodiumSnapshot()} rows)`);
  }

  fs.writeFileSync(path.join(dir, "migration-report.json"), JSON.stringify({ apply: APPLY, ...report }, null, 2));
  console.log(JSON.stringify({ apply: APPLY, ...report, catalogDifferences: report.catalogDifferences.length + " (see report file)" }, null, 2));
  if (report.problems.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
