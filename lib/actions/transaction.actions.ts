"use server";

import { ID, Query } from "node-appwrite";
import { createAdminClient } from "../appwrite";
import { parseMoney } from "../money";
import { parseStringify } from "../utils";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_TRANSACTION_COLLECTION_ID: TRANSACTION_COLLECTION_ID,
  APPWRITE_IDEMPOTENCY_COLLECTION_ID: IDEMPOTENCY_COLLECTION_ID,
} = process.env;

export const createTransaction = async (transaction: CreateTransactionProps) => {
  try {
    // ── Enforce DECIMAL(18, 4) on every currency amount ──────────────────
    // parseMoney throws if the value carries more than 4 decimal places or
    // exceeds the maximum integer precision, preventing float imprecision from
    // entering the data store.
    const normalizedAmount = parseMoney(transaction.amount);

    const { database } = await createAdminClient();

    // ── Idempotency check for internal transfers ──────────────────────────
    // When the caller supplies an idempotencyKey we verify it hasn't been used
    // before, preventing duplicate transactions from double-submits or retries.
    const idempotencyKey = transaction.idempotencyKey ?? ID.unique();

    if (transaction.idempotencyKey && IDEMPOTENCY_COLLECTION_ID) {
      const existing = await database.listDocuments(
        DATABASE_ID!,
        IDEMPOTENCY_COLLECTION_ID,
        [Query.equal("idempotencyKey", idempotencyKey)]
      );

      if (existing.total > 0) {
        console.warn(
          `[createTransaction] Duplicate idempotencyKey detected: "${idempotencyKey}". Returning existing transaction.`
        );
        return parseStringify(existing.documents[0]);
      }

      // Register the key before creating the transaction document.
      await database.createDocument(
        DATABASE_ID!,
        IDEMPOTENCY_COLLECTION_ID,
        ID.unique(),
        {
          idempotencyKey,
          eventTopic: "transfer:internal",
          processedAt: new Date().toISOString(),
        }
      );
    }

    const newTransaction = await database.createDocument(
      DATABASE_ID!,
      TRANSACTION_COLLECTION_ID!,
      ID.unique(),
      {
        channel: "online",
        category: "Transfer",
        ...transaction,
        amount: normalizedAmount,
        idempotencyKey,
      }
    );

    return parseStringify(newTransaction);
  } catch (error) {
    console.log(error);
  }
};

export const getTransactionsByBankId = async ({bankId}: getTransactionsByBankIdProps) => {
  try {
    const { database } = await createAdminClient();

    const senderTransactions = await database.listDocuments(
      DATABASE_ID!,
      TRANSACTION_COLLECTION_ID!,
      [Query.equal('senderBankId', bankId)],
    )

    const receiverTransactions = await database.listDocuments(
      DATABASE_ID!,
      TRANSACTION_COLLECTION_ID!,
      [Query.equal('receiverBankId', bankId)],
    );

    const transactions = {
      total: senderTransactions.total + receiverTransactions.total,
      documents: [
        ...senderTransactions.documents, 
        ...receiverTransactions.documents,
      ]
    }

    return parseStringify(transactions);
  } catch (error) {
    console.log(error);
  }
}