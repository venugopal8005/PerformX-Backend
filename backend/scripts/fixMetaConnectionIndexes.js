import dotenv from "dotenv";
import mongoose from "mongoose";

const defaultEnvPath = process.cwd().endsWith("/backend") ? ".env" : "backend/.env";
dotenv.config({ path: process.env.ENV_FILE || defaultEnvPath });

const LEGACY_ACCOUNT_INDEX_NAME = "client_id_1_ad_account_id_1";
const LEGACY_ACCOUNT_INDEX_KEYS = { client_id: 1, ad_account_id: 1 };
const LEGACY_ACCOUNT_INDEX_FILTER = {
  client_id: { $type: "objectId" },
  ad_account_id: { $type: "string" },
};

const filtersMatch = (left = {}, right = {}) =>
  JSON.stringify(left) === JSON.stringify(right);

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");

  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    autoCreate: false,
  });

  const collection = mongoose.connection.db.collection("meta_connections");
  const indexes = await collection.indexes();
  const oldIndex = indexes.find((index) => index.name === LEGACY_ACCOUNT_INDEX_NAME);

  if (
    oldIndex &&
    (!oldIndex.unique ||
      !filtersMatch(oldIndex.partialFilterExpression, LEGACY_ACCOUNT_INDEX_FILTER))
  ) {
    await collection.dropIndex(LEGACY_ACCOUNT_INDEX_NAME);
    console.log(`Dropped stale ${LEGACY_ACCOUNT_INDEX_NAME} index.`);
  } else if (oldIndex) {
    console.log(`${LEGACY_ACCOUNT_INDEX_NAME} already has the correct partial filter.`);
  }

  const refreshedIndexes = await collection.indexes();
  const hasCorrectIndex = refreshedIndexes.some(
    (index) =>
      index.name === LEGACY_ACCOUNT_INDEX_NAME &&
      index.unique &&
      filtersMatch(index.partialFilterExpression, LEGACY_ACCOUNT_INDEX_FILTER)
  );

  if (!hasCorrectIndex) {
    await collection.createIndex(LEGACY_ACCOUNT_INDEX_KEYS, {
      name: LEGACY_ACCOUNT_INDEX_NAME,
      unique: true,
      partialFilterExpression: LEGACY_ACCOUNT_INDEX_FILTER,
    });
    console.log(`Created partial ${LEGACY_ACCOUNT_INDEX_NAME} index.`);
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
