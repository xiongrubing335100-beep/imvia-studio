import assert from "node:assert/strict";
import test from "node:test";
import { assertM5Source, isAllowedM5Source } from "../src/domain/source-policy.js";

test("allows only IMVIA, fixture, mock Lovart, and explicit current-session sources", () => {
  assert.equal(isAllowedM5Source("imvia:import_result"), true);
  assert.equal(isAllowedM5Source("fixture:lovart_generate"), true);
  assert.equal(isAllowedM5Source("mock_lovart:status"), true);
  assert.equal(isAllowedM5Source("user:current_session", { allowUser: true }), true);
  assert.equal(isAllowedM5Source("user:current_session"), false);
  assert.equal(isAllowedM5Source("lovart:generate"), false);
  assert.equal(isAllowedM5Source("https://lovart.example"), false);
});

test("returns a structured validation error for an unknown source", () => {
  assert.throws(
    () => assertM5Source("lovart:real"),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "source",
  );
});
