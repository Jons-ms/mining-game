"use strict";

const PROJECT_ID = "cryp-togame";
const DATABASE_ROOT = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents";
const PAGE_SIZE = 500;
const MAX_AMOUNT = 1_000_000_000_000;
const MIN_PRICE = 0.25;
const MAX_PRICE = 7;

function requireAccessToken() {
  const token = process.env.FIREBASE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing FIREBASE_ACCESS_TOKEN.");
  return token;
}

async function firestoreRequest(path, options = {}) {
  const url = DATABASE_ROOT + (path.startsWith(":") ? path : "/" + path);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + requireAccessToken(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (response.status === 404 && options.notFoundIsNull) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const status = payload && payload.error && payload.error.status
      ? payload.error.status
      : response.statusText || "request failed";
    throw new Error("Firestore API returned " + response.status + " (" + status + ").");
  }
  return payload;
}

function firestoreNumber(document, fieldName) {
  const field = document && document.fields && document.fields[fieldName];
  if (!field) return 0;
  const raw = field.integerValue ?? field.doubleValue ?? field.stringValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedAmount(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, MAX_AMOUNT);
}

function currentRate(document) {
  const value = document ? firestoreNumber(document, "price") : 1;
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, value));
}

function playerNickname(document) {
  const value = document && document.fields && document.fields.playerName;
  const name = value && typeof value.stringValue === "string" ? value.stringValue.trim() : "";
  return (name || "Гравець").slice(0, 20);
}

function comparePlayers(a, b) {
  return b.totalCapital - a.totalCapital
    || b.cashBalance - a.cashBalance
    || a.nickname.localeCompare(b.nickname, "uk")
    || a.uid.localeCompare(b.uid);
}

function firestorePlayerValue(player, index) {
  return {
    mapValue: {
      fields: {
        rank: { integerValue: String(index + 1) },
        nickname: { stringValue: player.nickname },
        cashBalance: { doubleValue: player.cashBalance },
        totalCapital: { doubleValue: player.totalCapital },
      },
    },
  };
}

async function readCurrentRate() {
  const query = new URLSearchParams();
  query.append("mask.fieldPaths", "price");
  const market = await firestoreRequest("market/exchangeRate?" + query.toString(), { notFoundIsNull: true });
  return currentRate(market);
}

async function readTopPlayers(rate) {
  const topPlayers = [];
  let pageToken = null;

  do {
    const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    query.append("mask.fieldPaths", "playerName");
    query.append("mask.fieldPaths", "cash");
    query.append("mask.fieldPaths", "cryp");
    if (pageToken) query.set("pageToken", pageToken);

    const page = await firestoreRequest("players?" + query.toString());
    for (const document of page.documents || []) {
      const uid = document.name ? document.name.slice(document.name.lastIndexOf("/") + 1) : "";
      const cashBalance = boundedAmount(firestoreNumber(document, "cash"));
      const crypBalance = boundedAmount(firestoreNumber(document, "cryp"));
      const totalCapital = cashBalance + crypBalance * rate;
      if (!Number.isFinite(totalCapital)) continue;

      topPlayers.push({
        uid,
        nickname: playerNickname(document),
        cashBalance,
        totalCapital,
      });
      topPlayers.sort(comparePlayers);
      if (topPlayers.length > 10) topPlayers.length = 10;
    }

    pageToken = page.nextPageToken || null;
  } while (pageToken);

  return topPlayers.map(firestorePlayerValue);
}

async function main() {
  const rate = await readCurrentRate();
  const players = await readTopPlayers(rate);

  await firestoreRequest(":commit", {
    method: "POST",
    body: {
      writes: [{
        update: {
          name: "projects/" + PROJECT_ID + "/databases/(default)/documents/podium/current",
          fields: {
            players: { arrayValue: { values: players } },
          },
        },
        updateMask: { fieldPaths: ["players"] },
        updateTransforms: [{
          fieldPath: "updatedAt",
          setToServerValue: "REQUEST_TIME",
        }],
      }],
    },
  });

  console.info("Podium updated.", { playerCount: players.length });
}

main().catch((error) => {
  console.error("Podium update failed.", {
    code: error && error.code ? error.code : "unknown",
    message: error && error.message ? error.message : "Unexpected error.",
  });
  process.exitCode = 1;
});
