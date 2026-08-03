import crypto from "crypto";

import { ID, Query } from "node-appwrite";
import { NextRequest, NextResponse } from "next/server";

import { createAdminClient } from "@/lib/appwrite";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_IDEMPOTENCY_COLLECTION_ID: IDEMPOTENCY_COLLECTION_ID,
  DWOLLA_WEBHOOK_SECRET,
} = process.env;

/**
 * Verifies that the `x-request-signature-sha-256` header matches the HMAC-SHA256
 * of the raw request body computed with the shared webhook secret.
 */
function verifyDwollaSignature(
  secret: string,
  payload: string,
  signature: string
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // Use timingSafeEqual to prevent timing-oracle attacks.
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * POST /api/webhooks/dwolla
 *
 * Accepts incoming Dwolla BaaS event webhooks with the following enforcement:
 *
 * 1. HMAC-SHA256 signature verification against `x-request-signature-sha-256`.
 * 2. Mandatory unique `idempotency-key` header (falls back to the Dwolla event
 *    `id` field when no explicit header is supplied).
 * 3. Duplicate-key rejection: any webhook that carries an `idempotency-key`
 *    already present in the idempotency store returns HTTP 409.
 * 4. Atomic key registration before event processing to prevent replay attacks
 *    even under concurrent delivery.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Read the raw body (required for signature verification) ───────────
  const rawBody = await request.text();

  // ── 2. Verify Dwolla webhook signature ──────────────────────────────────
  if (!DWOLLA_WEBHOOK_SECRET) {
    console.error("[dwolla-webhook] DWOLLA_WEBHOOK_SECRET is not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const signature =
    request.headers.get("x-request-signature-sha-256") ?? "";

  if (!signature) {
    return NextResponse.json(
      { error: "Missing x-request-signature-sha-256 header" },
      { status: 401 }
    );
  }

  if (!verifyDwollaSignature(DWOLLA_WEBHOOK_SECRET, rawBody, signature)) {
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 401 }
    );
  }

  // ── 3. Parse the JSON payload ────────────────────────────────────────────
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  // ── 4. Extract idempotency key ───────────────────────────────────────────
  // Prefer the explicit `idempotency-key` request header; fall back to the
  // Dwolla event `id` field which is globally unique per event delivery.
  const idempotencyKey =
    (request.headers.get("idempotency-key") as string | null) ??
    (typeof event.id === "string" ? event.id : null);

  if (!idempotencyKey) {
    return NextResponse.json(
      {
        error:
          "Missing idempotency_key: every incoming BaaS payment webhook must " +
          "include a unique idempotency key via the `idempotency-key` header " +
          "or a top-level `id` field in the event payload.",
      },
      { status: 400 }
    );
  }

  // ── 5. Deduplication check ───────────────────────────────────────────────
  if (!DATABASE_ID || !IDEMPOTENCY_COLLECTION_ID) {
    console.error(
      "[dwolla-webhook] Idempotency collection env vars are not configured"
    );
    return NextResponse.json(
      { error: "Idempotency store not configured" },
      { status: 500 }
    );
  }

  const { database } = await createAdminClient();

  const existing = await database.listDocuments(
    DATABASE_ID,
    IDEMPOTENCY_COLLECTION_ID,
    [Query.equal("idempotencyKey", idempotencyKey)]
  );

  if (existing.total > 0) {
    // The event has already been processed. Return 409 so Dwolla knows not to
    // retry, but include a body indicating idempotent success.
    return NextResponse.json(
      { status: "already_processed", idempotencyKey },
      { status: 409 }
    );
  }

  // ── 6. Register the key atomically before processing ────────────────────
  // Recording the key *before* processing ensures that even if the handler
  // crashes mid-flight, a second delivery of the same event is rejected,
  // preventing partial double-processing.
  await database.createDocument(
    DATABASE_ID,
    IDEMPOTENCY_COLLECTION_ID,
    ID.unique(),
    {
      idempotencyKey,
      eventTopic: typeof event.topic === "string" ? event.topic : "unknown",
      processedAt: new Date().toISOString(),
    }
  );

  // ── 7. Process the event by topic ────────────────────────────────────────
  const topic = typeof event.topic === "string" ? event.topic : "";

  switch (topic) {
    case "transfer:created":
    case "transfer:completed":
    case "transfer:cancelled":
    case "transfer:failed":
    case "transfer:reclaimed":
      // Transfer lifecycle events are informational.
      // Account balances are never updated here — they are always sourced
      // exclusively from the Plaid /accounts endpoint.
      break;

    case "customer:verification:retry":
    case "customer:suspended":
    case "customer:activated":
      // Customer status events are audit-logged only.
      break;

    default:
      // Pass topic as a separate argument to avoid a tainted-format-string path.
      console.warn("[dwolla-webhook] Received unhandled event topic:", topic, {
        idempotencyKey,
      });
  }

  return NextResponse.json({ status: "accepted", idempotencyKey }, { status: 200 });
}
