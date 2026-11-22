"use strict";
/* CRYP BANK card numbers, generated on the server so a player can never pick or forge a number. */
const crypto = require("node:crypto");

const CURRENCIES = { uah: "9001", cryp: "9002", blue: "9003" };

function luhnCheckDigit(payload) {
  let sum = 0;
  for (let index = 0; index < payload.length; index += 1) {
    let digit = Number(payload[payload.length - 1 - index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

function isValidCardNumber(value) {
  return typeof value === "string" && /^[0-9]{16}$/.test(value) && luhnCheckDigit(value.slice(0, 15)) === value[15];
}

// randomDigit(): integer 0-9; defaults to a cryptographic generator.
function generateCardNumber(currency, randomDigit = () => crypto.randomInt(10)) {
  const prefix = CURRENCIES[currency];
  if (!prefix) return null;
  let payload = prefix;
  while (payload.length < 15) payload += String(randomDigit());
  return payload + luhnCheckDigit(payload);
}

const accountId = (uid, currency) => uid + "_" + currency;

module.exports = { CURRENCIES, luhnCheckDigit, isValidCardNumber, generateCardNumber, accountId };
