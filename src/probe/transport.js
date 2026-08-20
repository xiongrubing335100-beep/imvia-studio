import { createHmac, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";

import { DomainError } from "../domain/errors.js";
import {
  LOVART_BODY,
  LOVART_MAX_RESPONSE_BYTES,
  LOVART_METHOD,
  LOVART_ORIGIN,
  LOVART_PATH,
  LOVART_TIMEOUT_MS,
} from "./constants.js";

const LOVART_HOSTNAME = new URL(LOVART_ORIGIN).hostname;
const LOVART_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LovartAgentSkill/1.0";

const FAILURE_MESSAGES = Object.freeze({
  UPSTREAM_UNREACHABLE: "Lovart upstream is unreachable",
  UPSTREAM_SECURITY_REJECTED: "Lovart upstream security check failed",
  AUTHENTICATION_FAILED: "Lovart authentication was rejected",
  UPSTREAM_RATE_LIMITED: "Lovart upstream rate limit was reached",
  UPSTREAM_UNAVAILABLE: "Lovart upstream is unavailable",
  UPSTREAM_SCHEMA_UNRECOGNIZED: "Lovart upstream response was not recognized",
});

const TLS_VERIFICATION_ERROR_CODES = new Set([
  "APPLICATION_VERIFICATION",
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CRL_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EPROTO",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "OUT_OF_MEM",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function stableFailure(code) {
  return new DomainError(code, FAILURE_MESSAGES[code]);
}

function isTlsFailure(error) {
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  return TLS_VERIFICATION_ERROR_CODES.has(code)
    || code.startsWith("ERR_SSL_")
    || code.startsWith("ERR_TLS_");
}

function mapRequestFailure(error) {
  return stableFailure(isTlsFailure(error)
    ? "UPSTREAM_SECURITY_REJECTED"
    : "UPSTREAM_UNREACHABLE");
}

function mapStatusFailure(statusCode) {
  if (statusCode >= 300 && statusCode < 400)
    return stableFailure("UPSTREAM_SECURITY_REJECTED");
  if (statusCode === 401 || statusCode === 403)
    return stableFailure("AUTHENTICATION_FAILED");
  if (statusCode === 429)
    return stableFailure("UPSTREAM_RATE_LIMITED");
  if (statusCode >= 500 && statusCode <= 599)
    return stableFailure("UPSTREAM_UNAVAILABLE");
  if (statusCode < 200 || statusCode >= 300)
    return stableFailure("UPSTREAM_UNAVAILABLE");
  return null;
}

function parseResponse(chunks) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw stableFailure("UPSTREAM_SCHEMA_UNRECOGNIZED");
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw stableFailure("UPSTREAM_SCHEMA_UNRECOGNIZED");
  }

  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw stableFailure("UPSTREAM_SCHEMA_UNRECOGNIZED");
  return value;
}

export async function requestLovartModeQuery({
  accessKey,
  secretKey,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  randomId = randomUUID,
  requestImpl = httpsRequest,
}) {
  if (typeof accessKey !== "string" || typeof secretKey !== "string")
    throw new TypeError("Lovart credentials must be strings");

  const timestamp = Math.floor(nowSeconds());
  const idempotencyKey = randomId().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(idempotencyKey))
    throw new TypeError("Lovart idempotency identifier must contain 32 hexadecimal characters");

  const signaturePayload = `${LOVART_METHOD}\n${LOVART_PATH}\n${timestamp}`;
  const signature = createHmac("sha256", secretKey)
    .update(signaturePayload, "utf8")
    .digest("hex");
  const options = {
    protocol: "https:",
    hostname: LOVART_HOSTNAME,
    port: 443,
    agent: false,
    method: LOVART_METHOD,
    path: LOVART_PATH,
    rejectUnauthorized: true,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(LOVART_BODY),
      "User-Agent": LOVART_USER_AGENT,
      "X-Access-Key": accessKey,
      "X-Timestamp": String(timestamp),
      "X-Signature": signature,
      "X-Signed-Method": LOVART_METHOD,
      "X-Signed-Path": LOVART_PATH,
      "Idempotency-Key": idempotencyKey,
    },
  };

  return new Promise((resolve, reject) => {
    let request;
    let settled = false;

    const finish = (error, value, response, destroyRequest = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        response?.destroy();
        if (destroyRequest) request?.destroy(error);
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onResponse = (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      const statusFailure = mapStatusFailure(response.statusCode ?? 0);
      if (statusFailure) {
        finish(statusFailure, undefined, response);
        return;
      }

      const chunks = [];
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += bytes.byteLength;
        if (receivedBytes > LOVART_MAX_RESPONSE_BYTES) {
          finish(stableFailure("UPSTREAM_SCHEMA_UNRECOGNIZED"), undefined, response);
          return;
        }
        chunks.push(bytes);
      });
      response.once("error", (error) => finish(mapRequestFailure(error), undefined, response));
      response.once("aborted", () => finish(stableFailure("UPSTREAM_UNREACHABLE"), undefined, response));
      response.once("end", () => {
        if (settled) return;
        try {
          finish(undefined, parseResponse(chunks));
        } catch (error) {
          finish(error, undefined, response);
        }
      });
    };

    const timer = setTimeout(() => {
      finish(stableFailure("UPSTREAM_UNREACHABLE"));
    }, LOVART_TIMEOUT_MS);

    try {
      request = requestImpl(options, onResponse);
      if (settled) {
        request?.destroy();
        return;
      }
      request.once("error", (error) => finish(mapRequestFailure(error), undefined, undefined, false));
      if (settled) {
        request.destroy();
        return;
      }
      request.write(LOVART_BODY);
      if (settled) {
        request.destroy();
        return;
      }
      request.end();
    } catch (error) {
      finish(mapRequestFailure(error));
    }
  });
}
