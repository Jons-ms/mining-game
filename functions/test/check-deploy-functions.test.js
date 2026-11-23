"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { exportedFunctions, parseDeployList, compare } = require("../../scripts/check-deploy-functions.js");

// What the Firebase SDK does to every trigger it creates: a function carrying an `__endpoint` object.
const trigger = () => Object.assign(() => {}, { __endpoint: { platform: "gcfv2" } });
const helper = () => () => {};

const code = { initPlayer: trigger(), gameAction: trigger(), hourlyPodium: trigger(), buildPodiumSnapshot: helper(), VERSION: "1" };

test("only SDK-marked exports count as functions; helpers and constants are ignored", () => {
  assert.deepEqual(exportedFunctions(code), { names: ["gameAction", "hourlyPodium", "initPlayer"], nested: [] });
});

test("an identical list passes, whatever its order", () => {
  const result = compare("functions:initPlayer, functions:hourlyPodium,functions:gameAction", code);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("a function missing from DEPLOY_ONLY is reported (it would silently not be deployed)", () => {
  const result = compare("functions:initPlayer,functions:gameAction", code);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing from DEPLOY_ONLY.*hourlyPodium/);
});

test("a listed name that the code does not export is reported, including a helper that is not a function", () => {
  const result = compare("functions:initPlayer,functions:gameAction,functions:hourlyPodium,functions:buildPodiumSnapshot,functions:ghost", code);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /not exported by the code: buildPodiumSnapshot, ghost/);
});

test("malformed, empty and duplicated entries fail", () => {
  assert.equal(compare("", code).ok, false);
  assert.equal(compare("initPlayer,gameAction,hourlyPodium", code).ok, false); // no functions: prefix
  assert.equal(compare("functions:initPlayer,functions:gameAction,functions:hourlyPodium,functions:gameAction", code).ok, false);
  assert.deepEqual(parseDeployList("functions:a,functions:a").duplicates, ["a"]);
  assert.deepEqual(parseDeployList("functions:a b").bad, ["functions:a b"]);
});

test("a function hidden in a group is an error, not a silent skip; no functions at all is an error", () => {
  const grouped = { ...code, admin: { reset: trigger() } };
  const result = compare("functions:initPlayer,functions:gameAction,functions:hourlyPodium", grouped);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /function groups.*admin/);
  assert.equal(compare("functions:a", { a: helper() }).ok, false);
});
