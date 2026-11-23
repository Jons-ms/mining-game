#!/usr/bin/env node
"use strict";
/*
 * Checks that the list of functions the deploy workflow publishes (DEPLOY_ONLY) is EXACTLY the set of Cloud Functions
 * that functions/index.js exports.
 *
 *   node scripts/check-deploy-functions.js "functions:initPlayer,functions:gameAction,..."
 *
 * It loads the real functions/index.js, like the Firebase CLI does, and treats an export as a deployable function when
 * the Firebase SDK marked it with `__endpoint` (every onCall / onRequest / onSchedule / trigger does this). Plain helper
 * exports, such as buildPodiumSnapshot, carry no marker and are correctly ignored. This replaces the earlier text
 * search (grep) that only recognised three trigger names on lines starting with "exports.".
 *
 * Exit code 0 = the lists are equal; 1 = they differ (or the list/code is malformed); nothing is printed except
 * function names.
 */
const path = require("node:path");
const { createRequire } = require("node:module");

const ENTRY = /^functions:([A-Za-z][A-Za-z0-9_]*)$/;

// Names of the top-level exports the Firebase SDK marked as deployable functions. Function groups (nested objects) are
// not used by this project and not supported by DEPLOY_ONLY, so an endpoint hidden inside one is an error, not a silent skip.
function exportedFunctions(moduleExports) {
  const names = [];
  const nested = [];
  for (const key of Object.keys(moduleExports || {})) {
    const value = moduleExports[key];
    if (typeof value === "function" && value.__endpoint && typeof value.__endpoint === "object") names.push(key);
    else if (value && typeof value === "object" && Object.values(value).some((inner) => typeof inner === "function" && inner.__endpoint)) nested.push(key);
  }
  return { names: names.sort(), nested };
}

function parseDeployList(text) {
  const entries = String(text || "").split(",").map((part) => part.trim());
  const bad = entries.filter((entry) => !ENTRY.test(entry));
  const names = entries.filter((entry) => ENTRY.test(entry)).map((entry) => entry.match(ENTRY)[1]);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  return { names: names.sort(), bad, duplicates };
}

// Returns { ok, errors[], exported[], listed[] }.
function compare(deployOnly, moduleExports) {
  const listed = parseDeployList(deployOnly);
  const exported = exportedFunctions(moduleExports);
  const errors = [];
  if (!deployOnly || listed.bad.length) errors.push(`DEPLOY_ONLY has malformed entries (expected functions:<name>): ${listed.bad.map((b) => JSON.stringify(b)).join(", ") || "empty list"}`);
  if (listed.duplicates.length) errors.push(`DEPLOY_ONLY lists a function twice: ${[...new Set(listed.duplicates)].join(", ")}`);
  if (exported.nested.length) errors.push(`functions/index.js exports function groups, which this check does not support: ${exported.nested.join(", ")}`);
  const missing = exported.names.filter((name) => !listed.names.includes(name));
  const extra = listed.names.filter((name) => !exported.names.includes(name));
  if (missing.length) errors.push(`exported by the code but missing from DEPLOY_ONLY (they would NOT be deployed): ${missing.join(", ")}`);
  if (extra.length) errors.push(`listed in DEPLOY_ONLY but not exported by the code: ${extra.join(", ")}`);
  if (!exported.names.length) errors.push("functions/index.js exports no Cloud Functions at all");
  return { ok: errors.length === 0, errors, exported: exported.names, listed: listed.names };
}

function main() {
  const functionsDir = path.join(__dirname, "..", "functions");
  const requireFromFunctions = createRequire(path.join(functionsDir, "package.json"));
  const result = compare(process.argv[2], requireFromFunctions("./index.js"));
  const lines = [`Cloud Functions exported by functions/index.js (${result.exported.length}): ${result.exported.join(", ")}`,
    `Functions listed in DEPLOY_ONLY (${result.listed.length}): ${result.listed.join(", ")}`];
  if (result.ok) lines.push("OK: the lists are identical.");
  else result.errors.forEach((error) => lines.push(`ERROR: ${error}`));
  // Exit only after the text is flushed; loading the SDK may leave handles open.
  process.stdout.write(lines.join("\n") + "\n", () => process.exit(result.ok ? 0 : 1));
}

module.exports = { exportedFunctions, parseDeployList, compare };

if (require.main === module) main();
