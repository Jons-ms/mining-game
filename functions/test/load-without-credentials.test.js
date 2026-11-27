"use strict";

// Regression: loading functions/index.js must never start the Admin SDK. The deploy workflow loads it (through
// scripts/check-deploy-functions.js and the Firebase CLI) while GOOGLE_APPLICATION_CREDENTIALS points to a keyless
// Workload Identity Federation file ("type": "external_account"). Admin SDK 12 rejects such a file with
// "Invalid contents in the credentials file" as soon as initializeApp() runs, so initialisation has to wait for the
// first real request.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const functionsDir = path.join(__dirname, "..");
let sdkInstalled = true;
try {
  require.resolve("firebase-admin/app", { paths: [functionsDir] });
  require.resolve("firebase-functions/v2/https", { paths: [functionsDir] });
} catch {
  sdkInstalled = false;
}

test("index.js loads with a keyless (external_account) credentials file and still exports every function",
  { skip: sdkInstalled ? false : "firebase-admin / firebase-functions are not installed here (CI installs them before the tests)" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wif-"));
    const credentialsFile = path.join(dir, "credentials.json");
    fs.writeFileSync(credentialsFile, JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/github/providers/github-actions",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: path.join(dir, "token.txt") }
    }));
    try {
      const script = 'const m = require("./index.js"); console.log(Object.keys(m).sort().join(","));';
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: functionsDir,
        encoding: "utf8",
        env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: credentialsFile }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(),
        "buildPodiumSnapshot,gameAction,heartbeat,hourlyPodium,initPlayer,openBankAccount");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
