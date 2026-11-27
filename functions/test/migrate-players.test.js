"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { run, checkPlayer } = require("../../scripts/migrate-players.js");

const FieldValue = { serverTimestamp: () => "SERVER_TIMESTAMP" };
const STARTER = { id: "starter", name: "Starter GPU", icon: "▰", rate: 0.02, cost: 250, currency: "cryp" };
const RTX3060 = { id: "rtx3060", name: "RTX 3060", icon: "▰", rate: 0.06, cost: 600, currency: "cryp" };

const player = (name, overrides = {}) => ({
  playerName: name, cash: 490, cryp: 1.5, blue: 0,
  slots: [{ ...STARTER }, ...Array(15).fill(null)], inventory: [{ ...RTX3060, inventoryId: "inv-1" }],
  hasExtraField: false, extraSlots: Array(16).fill(null), ...overrides
});

// A Firestore stand-in that records EVERY mutation (transactional or direct) in `writes`.
// `beforeTransactionRead(id, store)` lets a test change a document between the preflight and the write.
function fakeDb(initial, { beforeTransactionRead, failTransactionFor } = {}) {
  const store = new Map(Object.entries(initial).map(([id, data]) => [id, structuredClone(data)]));
  const writes = [];
  const state = { transactions: 0 };
  const snap = (id) => ({ id, ref: ref(id), exists: store.has(id), data: () => structuredClone(store.get(id)) });
  const ref = (id) => ({ id, path: `players/${id}`, get: async () => snap(id) });
  const db = {
    writes, state, store,
    collection: (name) => ({
      get: async () => {
        assert.equal(name, "players");
        return { docs: [...store.keys()].map(snap), size: store.size };
      },
      where: (field, op, value) => ({
        get: async () => {
          const docs = [...store.entries()].filter(([, data]) => data[field] === value).map(([id]) => snap(id));
          return { docs, size: docs.length };
        }
      }),
      doc: (id) => (name === "players" ? ref(id) : {
        get: async () => ({ exists: false, data: () => undefined }),
        set: async (value) => { writes.push({ path: `${name}/${id}`, value }); }
      })
    }),
    runTransaction: async (callback) => {
      state.transactions += 1;
      const staged = [];
      const transaction = {
        get: async (docRef) => {
          if (failTransactionFor === docRef.id) throw Object.assign(new Error(`boom on players/${docRef.id}`), { code: "unavailable" });
          if (beforeTransactionRead) beforeTransactionRead(docRef.id, store);
          return snap(docRef.id);
        },
        set: (docRef, value, options) => { staged.push({ docRef, value, options }); }
      };
      const result = await callback(transaction); // a throw here means nothing below runs: the transaction is rolled back
      for (const { docRef, value } of staged) {
        store.set(docRef.id, { ...store.get(docRef.id), ...value });
        writes.push({ path: docRef.path, value });
      }
      return result;
    }
  };
  return db;
}

const quiet = () => { const lines = []; const log = (text) => lines.push(text); log.lines = lines; return log; };

test("dry run on clean data checks everything, writes nothing and prints no UIDs or nicknames", async () => {
  const db = fakeDb({ "uidAAA111": player("Alpha"), "uidBBB222": player("Bravo") });
  const log = quiet();
  const report = await run({ db, FieldValue, apply: false, log });
  assert.equal(report.exitCode, 0);
  assert.equal(report.players.toMigrate, 2);
  assert.equal(db.writes.length, 0);
  assert.equal(db.state.transactions, 0);
  assert.deepEqual(report.totalsToMigrate.cardsByType, { starter: 2, rtx3060: 2 });
  const printed = log.lines.join("\n");
  for (const secret of ["uidAAA111", "uidBBB222", "Alpha", "Bravo"]) assert.ok(!printed.includes(secret), `${secret} must not be printed`);
});

test("apply on clean data migrates every player, verifies them and writes only players/* and podium/current", async () => {
  const db = fakeDb({ uidAAA111: player("Alpha"), uidBBB222: player("Bravo") });
  const report = await run({ db, FieldValue, apply: true, log: quiet() });
  assert.equal(report.exitCode, 0);
  assert.deepEqual([report.players.migrated, report.players.verifiedOk], [2, 2]);
  assert.deepEqual(report.writes, { playerDocuments: 2, podiumSnapshot: true });
  assert.deepEqual(db.writes.map((w) => w.path).sort(), ["players/uidAAA111", "players/uidBBB222", "podium/current"]);
  for (const id of ["uidAAA111", "uidBBB222"]) {
    const doc = db.store.get(id);
    assert.equal(doc.serverManaged, true);
    assert.equal(doc.schema, 2);
    assert.equal(doc.migratedAt, "SERVER_TIMESTAMP");
    assert.equal(doc.slots.filter(Boolean).length, 1);
    assert.equal(doc.inventory.length, 1);
  }
});

test("a second apply is safe: migrated players are skipped and their documents are untouched", async () => {
  const db = fakeDb({ uidAAA111: player("Alpha"), uidBBB222: player("Bravo") });
  await run({ db, FieldValue, apply: true, log: quiet() });
  const before = structuredClone([...db.store.entries()]);
  db.writes.length = 0;
  db.state.transactions = 0;
  const report = await run({ db, FieldValue, apply: true, log: quiet() });
  assert.equal(report.exitCode, 0);
  assert.deepEqual([report.players.alreadyMigrated, report.players.toMigrate, report.players.migrated], [2, 0, 0]);
  assert.equal(db.state.transactions, 0);
  assert.deepEqual([...db.store.entries()], before);
  assert.deepEqual(db.writes.map((w) => w.path), ["podium/current"]);
});

test("a problem in the LAST player means no player and no Podium document is written in --apply", async () => {
  // "zzz" sorts last: the earlier, perfectly healthy players must stay untouched too.
  const lostCard = player("Zed", { inventory: [], slots: [...Array(16).fill({ ...STARTER }), { ...STARTER }] }); // the 17th card would be lost
  const db = fakeDb({ aaa: player("Alpha"), bbb: player("Bravo"), zzz: lostCard });
  const log = quiet();
  const report = await run({ db, FieldValue, apply: true, log });
  assert.equal(report.exitCode, 1);
  assert.match(report.result, /blocked: nothing was written/);
  assert.equal(db.writes.length, 0, "no write of any kind");
  assert.equal(db.state.transactions, 0, "no transaction was even opened");
  assert.deepEqual(report.writes, { playerDocuments: 0, podiumSnapshot: false });
  assert.deepEqual(report.problems, ["player #3: card count 17 -> 16"]);
  assert.ok(!db.store.get("aaa").serverManaged && !db.store.get("bbb").serverManaged);
  assert.ok(!log.lines.join("\n").includes("zzz"));
});

test("a catalog difference blocks --apply (and fails the dry run) without any write", async () => {
  const cheaper = player("Alpha", { slots: [{ ...STARTER, cost: 100 }, ...Array(15).fill(null)] });
  const db = fakeDb({ aaa: cheaper, bbb: player("Bravo") });
  for (const apply of [false, true]) {
    const report = await run({ db, FieldValue, apply, log: quiet() });
    assert.equal(report.exitCode, 1);
    assert.equal(report.catalogDifferences.length, 1);
    assert.match(report.catalogDifferences[0], /^player #1: starter \(farm\) rate=0.02 cost=100, catalog rate=0.02 price=250$/);
  }
  assert.equal(db.writes.length, 0);
  assert.equal(db.state.transactions, 0);
});

test("an unknown card id blocks --apply without any write", async () => {
  const db = fakeDb({ aaa: player("Alpha", { inventory: [{ id: "mystery-card", rate: 1, cost: 5 }] }), bbb: player("Bravo") });
  const report = await run({ db, FieldValue, apply: true, log: quiet() });
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.catalogDifferences, ['player #1: unknown card id "mystery-card" (inventory)']);
  assert.equal(db.writes.length, 0);
});

test("a document that stops matching the catalog after the preflight stops the run: later players and the Podium are untouched", async () => {
  let changed = false;
  const db = fakeDb({ aaa: player("Alpha"), bbb: player("Bravo"), ccc: player("Cleo") }, {
    beforeTransactionRead: (id, store) => {
      if (id === "bbb" && !changed) { // Bravo saved a card with a wrong price after the preflight passed
        changed = true;
        store.set("bbb", player("Bravo", { slots: [{ ...STARTER, cost: 1 }, ...Array(15).fill(null)] }));
      }
    }
  });
  const log = quiet();
  const report = await run({ db, FieldValue, apply: true, log });
  assert.equal(report.exitCode, 1);
  assert.equal(report.stopped.at, "player #2");
  assert.match(report.stopped.reason, /^player #2: the document failed the check right before writing: starter \(farm\)/);
  assert.deepEqual(db.writes.map((w) => w.path), ["players/aaa"], "only the player migrated before the failure is written");
  assert.ok(!db.store.get("bbb").serverManaged);
  assert.ok(!db.store.get("ccc").serverManaged, "the player after the failure is not touched");
  assert.equal(report.writes.podiumSnapshot, false);
  assert.ok(!log.lines.join("\n").includes("bbb"));
});

test("a card count mismatch on the fresh document is also caught inside the transaction", async () => {
  const db = fakeDb({ aaa: player("Alpha") }, {
    beforeTransactionRead: (id, store) => store.set(id, player("Alpha", { inventory: [{ ...RTX3060 }, "not-a-card-object"] }))
  });
  const report = await run({ db, FieldValue, apply: true, log: quiet() });
  assert.equal(report.exitCode, 1);
  assert.match(report.stopped.reason, /card count 3 -> 2/);
  assert.equal(db.writes.length, 0);
});

test("a player that became server-managed after the preflight is skipped, not overwritten", async () => {
  const managed = { ...player("Alpha"), serverManaged: true, schema: 2, cash: 12345 };
  const db = fakeDb({ aaa: player("Alpha") }, { beforeTransactionRead: (id, store) => store.set(id, managed) });
  const report = await run({ db, FieldValue, apply: true, log: quiet() });
  assert.equal(report.exitCode, 0);
  assert.deepEqual([report.players.alreadyMigrated, report.players.migrated, report.players.toMigrate], [1, 0, 0]);
  assert.equal(db.store.get("aaa").cash, 12345);
  assert.deepEqual(db.writes.map((w) => w.path), ["podium/current"]);
});

test("a Firestore error stops the run, leaves later players alone and does not leak UIDs", async () => {
  const db = fakeDb({ uidAAA111: player("Alpha"), uidBBB222: player("Bravo") }, { failTransactionFor: "uidAAA111" });
  const log = quiet();
  const report = await run({ db, FieldValue, apply: true, log });
  assert.equal(report.exitCode, 1);
  assert.equal(report.stopped.at, "player #1");
  assert.equal(report.stopped.reason, "unavailable: boom on players/player #1");
  assert.equal(db.writes.length, 0);
  assert.ok(!db.store.get("uidBBB222").serverManaged);
  assert.ok(!log.lines.join("\n").includes("uidAAA111"));
});

test("checkPlayer is pure and reports a normalisation failure as a problem, not a crash", () => {
  const ok = checkPlayer(player("Alpha"));
  assert.deepEqual([ok.problems, ok.catalogDifferences], [[], []]);
  assert.equal(ok.summary.farm, 1);
  const hostile = { get slots() { throw new Error("cannot read"); } };
  const broken = checkPlayer(hostile);
  assert.deepEqual(broken.problems, ["normalisation failed: cannot read"]);
});

test("the command line rejects unknown arguments before it touches Google Cloud", () => {
  const script = path.join(__dirname, "..", "..", "scripts", "migrate-players.js");
  const result = spawnSync(process.execPath, [script, "--aply"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node scripts\/migrate-players.js \[--apply\]/);
});
