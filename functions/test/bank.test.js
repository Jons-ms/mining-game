"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const bank = require("../lib/bank.js");

test("card numbers have 16 digits, the currency prefix and a valid Luhn check digit", () => {
  for (const [currency, prefix] of Object.entries(bank.CURRENCIES)) {
    for (let i = 0; i < 100; i += 1) {
      const number = bank.generateCardNumber(currency);
      assert.match(number, /^[0-9]{16}$/);
      assert.ok(number.startsWith(prefix));
      assert.ok(bank.isValidCardNumber(number));
    }
  }
});

test("unknown currencies (EURO) get no card, and a wrong check digit is invalid", () => {
  assert.equal(bank.generateCardNumber("euro"), null);
  const valid = bank.generateCardNumber("uah");
  assert.equal(bank.isValidCardNumber(valid.slice(0, 15) + String((Number(valid[15]) + 1) % 10)), false);
  assert.equal(bank.isValidCardNumber("abc"), false);
});

test("the account id is tied to one player and currency", () => {
  assert.equal(bank.accountId("u1", "cryp"), "u1_cryp");
});

test("the server client's Luhn rule matches the browser's (same numbers validate on both sides)", () => {
  const Browser = require("../../bank.js");
  for (let i = 0; i < 50; i += 1) {
    const number = bank.generateCardNumber("blue");
    assert.ok(Browser.isValidCardNumber(number));
  }
  assert.deepEqual(Browser.CURRENCIES.map((c) => [c.id, c.prefix]), Object.entries(bank.CURRENCIES));
});
