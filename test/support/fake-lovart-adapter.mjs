import assert from "node:assert/strict";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createFakeLovartAdapter(fixture) {
  if (!fixture || !Array.isArray(fixture.script)) throw new TypeError("A scripted fixture is required.");
  let cursor = 0;
  const ledger = [];
  async function invoke(tool, argumentsValue) {
    const step = fixture.script[cursor];
    if (!step) throw new Error(`Unexpected ${tool}; fixture ${fixture.name} is exhausted.`);
    if (step.tool !== tool) throw new Error(`Expected ${step.tool}, received ${tool}.`);
    cursor += 1;
    ledger.push(Object.freeze({ index: ledger.length, tool, arguments: clone(argumentsValue) }));
    if (step.error) throw Object.assign(new Error(step.error.message), { code: step.error.code });
    return clone(step.response);
  }
  return Object.freeze({
    get ledger() { return clone(ledger); },
    lovart_upload: (input) => invoke("lovart_upload", input),
    lovart_generate: (input) => invoke("lovart_generate", input),
    lovart_confirm: (input) => invoke("lovart_confirm", input),
    lovart_status: (input) => invoke("lovart_status", input),
    lovart_result: (input) => invoke("lovart_result", input),
    lovart_query_billing_mode: (input = {}) => invoke("lovart_query_billing_mode", input),
    remaining: () => fixture.script.length - cursor,
    assertComplete: () => assert.equal(cursor, fixture.script.length, `Fixture ${fixture.name} has unconsumed steps.`),
  });
}
