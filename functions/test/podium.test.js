"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPodiumSnapshot } = require("../lib/podium.js");

function fakeDb({ players, cryp, blue }) {
  const writes = [];
  const doc = (collection, id) => ({
    get: async () => {
      const data = collection === "market" ? (id === "exchangeRate" ? cryp : blue) : undefined;
      return { exists: data !== undefined, data: () => data };
    },
    set: async (value) => { writes.push({ path: `${collection}/${id}`, value }); }
  });
  return {
    writes,
    collection: (name) => ({
      doc: (id) => doc(name, id),
      where: (field, op, value) => ({
        get: async () => {
          assert.deepEqual([name, field, op, value], ["players", "serverManaged", "==", true]);
          const docs = players.map(({ id, data }) => ({ id, data: () => data }));
          return { docs, size: docs.length };
        }
      })
    })
  };
}

test("the snapshot ranks only migrated players with the current rates and writes one document", async () => {
  const db = fakeDb({
    players: [
      { id: "a", data: { playerName: "Alpha", cash: 100, cryp: 10, blue: 1 } },
      { id: "b", data: { playerName: "Bravo", cash: 500, cryp: 0, blue: 0 } }
    ],
    cryp: { price: 2 }, blue: { price: 10 }
  });
  const marker = { serverTimestamp: true };
  const rows = await buildPodiumSnapshot(db, { serverTimestamp: () => marker });
  assert.equal(rows, 2);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].path, "podium/current");
  assert.deepEqual(db.writes[0].value.entries.map((e) => [e.rank, e.nickname, e.totalCapital]), [[1, "Bravo", 500], [2, "Alpha", 130]]);
  assert.equal(db.writes[0].value.updatedAt, marker);
  assert.ok(db.writes[0].value.entries.every((e) => !("uid" in e)));
});

test("missing rate documents fall back to the start rates instead of failing", async () => {
  const db = fakeDb({ players: [{ id: "a", data: { playerName: "Alpha", cash: 0, cryp: 4, blue: 0 } }] });
  await buildPodiumSnapshot(db, { serverTimestamp: () => 0 });
  assert.deepEqual(db.writes[0].value.rates, { cryp: 0.25, blue: 4.25 });
  assert.equal(db.writes[0].value.entries[0].totalCapital, 1);
});
