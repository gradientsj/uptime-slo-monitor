import test from "node:test";
import assert from "node:assert/strict";
import { deriveCurrentState } from "../src/lib/state";

const quiet = { firing: false, highestSeverity: null } as const;
const ticket = { firing: true, highestSeverity: "ticket" } as const;
const page = { firing: true, highestSeverity: "page" } as const;

test("deriveCurrentState is unknown with no probe data", () => {
  assert.equal(deriveCurrentState([], quiet), "unknown");
});

test("deriveCurrentState is up when recent probes pass and no alert fires", () => {
  assert.equal(deriveCurrentState([true, true, true], quiet), "up");
});

test("deriveCurrentState ignores old failures once probes recover", () => {
  // Failures deeper in history must not affect the current state — that is
  // what SLO compliance reports, not the live status.
  assert.equal(
    deriveCurrentState([true, true, false, false, false], quiet),
    "up"
  );
});

test("deriveCurrentState treats a single fresh failure as degraded", () => {
  assert.equal(deriveCurrentState([false, true, true], quiet), "degraded");
});

test("deriveCurrentState treats consecutive fresh failures as down", () => {
  assert.equal(deriveCurrentState([false, false, true], quiet), "down");
});

test("deriveCurrentState marks down on a firing page alert even if the last probe passed", () => {
  assert.equal(deriveCurrentState([true, true, true], page), "down");
});

test("deriveCurrentState marks degraded on a firing ticket alert", () => {
  assert.equal(deriveCurrentState([true, true, true], ticket), "degraded");
});
