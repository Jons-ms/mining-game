#!/usr/bin/env node
"use strict";
/*
 * One-time migration of existing players to the server-managed format.
 *
 *   cd functions && npm install && cd ..
 *   (credentials come from Application Default Credentials: GitHub Actions provides them through Workload Identity Federation)
 *   node scripts/migrate-players.js            # dry run: checks every player, writes NOTHING
 *   node scripts/migrate-players.js --apply    # checks every player first; writes only if that check is completely clean
 *
 * How the "no writes if anything is wrong" rule is enforced:
 *   1. PREFLIGHT. All players are read once and checked by checkPlayer(), a pure function over plain data: it has no
 *      database handle, so it cannot write. The dry run is exactly this phase.
 *   2. If a single problem or catalog difference is found, the run ends right there (exit code 1). In --apply mode no
 *      player and no Podium document is written either.
 *   3. Only a clean preflight reaches the write phase. Each player is then written in its own transaction that reads the
 *      FRESH document and runs checkPlayer() again (card count and catalog match) before the write. A failed check, a
 *      failed verification or any Firestore error stops the run at once: the remaining players and the Podium are
 *      not touched.
 *   4. Re-running is safe: players that are already server-managed are skipped, each player is keyed by its Firebase
 *      UID (no duplicates) and nothing is ever deleted.
 *
 * Privacy: the repository is public and so are the CI logs. Nothing is written to disk (no backup files, no report
 * files, nothing to upload as an artifact) and the console output never contains UIDs, nicknames or per-player
 * balances. Players appear as "player #N", where N is the position in the Firestore document-ID order, so the owner can
 * find the document in the console (players collection, sorted by document ID). The primary backup is the full Firestore
 * export made by the workflow step `backup`, which stays inside Google Cloud.
 */
const path = require("node:path");
const { createRequire } = require("node:module");
const engine = require("../functions/lib/engine.js");
const { buildPodiumSnapshot } = require("../functions/lib/podium.js");

const MAX_PRINTED_ISSUES = 50;

// Raised inside the write transaction when the fresh document fails the check: the transaction is rolled back.
class MigrationAbort extends Error {}

// Text that comes from player documents (card ids, error messages) is cut to printable ASCII before it reaches the log.
const safe = (value) => String(value).replace(/[^\x20-\x7E]/g, "?").slice(0, 80);

function summary(state) {
  return {
    cash: state.cash, cryp: state.cryp, blue: state.blue,
    farm: state.slots.filter(Boolean).length, extra: state.extraSlots.filter(Boolean).length, inventory: state.inventory.length,
    hasExtraField: state.hasExtraField, unlocked: state.extraUnlockedSlots.filter(Boolean).length
  };
}

function catalogMismatches(state) {
  const found = [];
  const check = (gpu, where) => {
    const type = engine.GPU_TYPES.find((t) => t.id === gpu.id);
    if (!type) found.push(`unknown card id "${safe(gpu.id)}" (${where})`);
    else if (gpu.rate !== type.rate || gpu.cost !== type.price) {
      found.push(`${safe(gpu.id)} (${where}) rate=${gpu.rate} cost=${gpu.cost}, catalog rate=${type.rate} price=${type.price}`);
    }
  };
  state.slots.forEach((g) => g && check(g, "farm"));
  state.extraSlots.forEach((g) => g && check(g, "extra field"));
  state.inventory.forEach((g) => check(g, "inventory"));
  return found;
}

// Pure check of one raw player document. Used for the preflight AND again on the fresh document inside the write
// transaction. Returns plain data; it never touches the database.
function checkPlayer(raw) {
  let state;
  try {
    state = engine.normalizeState(raw, 0);
  } catch (error) {
    return { state: null, summary: null, problems: [`normalisation failed: ${safe(error && error.message)}`], catalogDifferences: [] };
  }
  const sum = summary(state);
  const problems = [];
  // normalisation must not lose cards
  const rawCards = [].concat(raw.slots || [], raw.extraSlots || [], raw.inventory || []).filter(Boolean).length;
  const stateCards = sum.farm + sum.extra + sum.inventory;
  if (rawCards !== stateCards) problems.push(`card count ${rawCards} -> ${stateCards}`);
  return { state, summary: sum, problems, catalogDifferences: catalogMismatches(state) };
}

function newReport(apply, total) {
  return {
    mode: apply ? "apply" : "dry-run",
    result: "ok",
    players: { total, alreadyMigrated: 0, toMigrate: 0, migrated: 0, verifiedOk: 0, goneBeforeWrite: 0 },
    totalsToMigrate: { cash: 0, cryp: 0, blue: 0, farmCards: 0, extraFieldCards: 0, inventoryCards: 0, cardsByType: {} },
    problems: [], catalogDifferences: [],
    stopped: null,
    writes: { playerDocuments: 0, podiumSnapshot: false },
    exitCode: 0
  };
}

function addTotals(totals, sum, state) {
  totals.cash = engine.roundCash(totals.cash + sum.cash);
  totals.cryp = engine.roundCoin(totals.cryp + sum.cryp);
  totals.blue = engine.roundCoin(totals.blue + sum.blue);
  totals.farmCards += sum.farm;
  totals.extraFieldCards += sum.extra;
  totals.inventoryCards += sum.inventory;
  for (const gpu of [].concat(state.slots, state.extraSlots, state.inventory)) {
    if (gpu) totals.cardsByType[safe(gpu.id)] = (totals.cardsByType[safe(gpu.id)] || 0) + 1;
  }
}

// WRITE PHASE, one player. Only reachable from run() after a clean preflight.
async function migrateOne(db, FieldValue, doc, label, report) {
  let outcome;
  await db.runTransaction(async (transaction) => {
    outcome = { skipped: null, written: null };
    const fresh = await transaction.get(doc.ref);
    if (!fresh.exists) { outcome.skipped = "gone"; return; }
    if (fresh.data().serverManaged === true) { outcome.skipped = "already"; return; }
    // The player may have saved since the preflight: check the FRESH document again before writing anything.
    const check = checkPlayer(fresh.data());
    const issues = check.problems.concat(check.catalogDifferences);
    if (issues.length) throw new MigrationAbort(`${label}: the document failed the check right before writing: ${issues.join("; ")}`);
    check.state.lastMiningAt = Date.now(); // no mining credit for the time before the migration
    outcome.written = check.summary;
    transaction.set(doc.ref, { ...check.state, serverManaged: true, schema: 2, migratedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  if (outcome.skipped === "gone") { report.players.goneBeforeWrite += 1; report.players.toMigrate -= 1; return; }
  if (outcome.skipped === "already") { report.players.alreadyMigrated += 1; report.players.toMigrate -= 1; return; }
  report.players.migrated += 1;
  report.writes.playerDocuments += 1;
  const after = summary(engine.normalizeState((await doc.ref.get()).data(), 0));
  const differing = Object.keys(outcome.written).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(outcome.written[key]));
  if (differing.length) throw new MigrationAbort(`${label}: verification after writing failed, fields differ: ${differing.join(", ")}`);
  report.players.verifiedOk += 1;
}

async function run({ db, FieldValue, apply = false, log = console.log }) {
  const snapshot = await db.collection("players").get();
  const docs = snapshot.docs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const report = newReport(apply, docs.length);
  const redact = (text) => docs.reduce((out, doc, index) => out.split(doc.id).join(`player #${index + 1}`), safe(text));

  // ---- PREFLIGHT: read-only, over plain data, covers every player before anything is written ----
  const pending = [];
  docs.forEach((doc, index) => {
    const label = `player #${index + 1}`;
    const raw = doc.data();
    if (raw.serverManaged === true) { report.players.alreadyMigrated += 1; return; }
    report.players.toMigrate += 1;
    const check = checkPlayer(raw);
    check.problems.forEach((line) => report.problems.push(`${label}: ${line}`));
    check.catalogDifferences.forEach((line) => report.catalogDifferences.push(`${label}: ${line}`));
    if (check.state) addTotals(report.totalsToMigrate, check.summary, check.state);
    pending.push({ doc, label });
  });

  if (report.problems.length || report.catalogDifferences.length) {
    report.result = "blocked: nothing was written";
    report.exitCode = 1;
  } else if (apply) {
    // ---- WRITE PHASE: only a completely clean preflight gets here; the first failure stops everything ----
    let current = null;
    try {
      for (const entry of pending) {
        current = entry.label;
        await migrateOne(db, FieldValue, entry.doc, entry.label, report);
      }
      current = "podium snapshot";
      report.writes.podiumSnapshot = (await buildPodiumSnapshot(db, FieldValue)) >= 0;
    } catch (error) {
      report.result = "stopped: the remaining players and the Podium were not touched";
      report.stopped = { at: current, reason: redact(error instanceof MigrationAbort ? error.message : `${error && error.code ? error.code + ": " : ""}${error && error.message}`) };
      report.exitCode = 1;
    }
  }

  print(report, log);
  return report;
}

function print(report, log) {
  const clip = (list) => (list.length > MAX_PRINTED_ISSUES ? list.slice(0, MAX_PRINTED_ISSUES).concat(`... and ${list.length - MAX_PRINTED_ISSUES} more`) : list);
  log(JSON.stringify({ ...report, problems: clip(report.problems), catalogDifferences: clip(report.catalogDifferences) }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) {
    console.error("Usage: node scripts/migrate-players.js [--apply]");
    process.exitCode = 2;
    return;
  }
  // Plain Firestore client (not the Admin SDK): it works with Workload Identity Federation credentials, so CI needs no key.
  const requireFromFunctions = createRequire(path.join(__dirname, "..", "functions", "package.json"));
  const { Firestore, FieldValue } = requireFromFunctions("@google-cloud/firestore");
  const report = await run({ db: new Firestore(), FieldValue, apply: args.includes("--apply") });
  process.exitCode = report.exitCode;
}

module.exports = { run, checkPlayer, MigrationAbort };

if (require.main === module) {
  main().catch((error) => {
    // Only the code and message: the full error object can carry document paths.
    console.error(`Migration failed before finishing: ${error && error.code ? error.code + ": " : ""}${safe(error && error.message)}`);
    process.exit(1);
  });
}
