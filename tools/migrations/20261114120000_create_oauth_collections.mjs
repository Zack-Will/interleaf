import Helpers from "./lib/helpers.mjs";
import { getCollectionInternal } from "./lib/mongodb.mjs";

const tags = ["server-ce", "server-pro", "saas"];

const indexes = {
  oauthClients: [
    {
      key: { clientId: 1 },
      name: "clientId_1",
      unique: true,
    },
    {
      key: { user_id: 1 },
      name: "user_id_1",
    },
  ],
  oauthAuthorizationCodes: [
    {
      key: { hashedCode: 1 },
      name: "hashedCode_1",
      unique: true,
    },
    {
      key: { clientId: 1 },
      name: "clientId_1",
    },
    {
      // remove codes as soon as they expire
      key: { expiresAt: 1 },
      name: "expiresAt_1",
      expireAfterSeconds: 0,
    },
  ],
  oauthGrants: [
    {
      key: { hashedRefreshToken: 1 },
      name: "hashedRefreshToken_1",
      unique: true,
    },
    {
      key: { rotatedRefreshTokenHashes: 1 },
      name: "rotatedRefreshTokenHashes_1",
    },
    {
      key: { clientId: 1 },
      name: "clientId_1",
    },
    {
      key: { user_id: 1 },
      name: "user_id_1",
    },
    {
      key: { tokenId: 1 },
      name: "tokenId_1",
    },
    {
      // remove grants whose refresh token has expired
      key: { refreshExpiresAt: 1 },
      name: "refreshExpiresAt_1",
      expireAfterSeconds: 0,
    },
  ],
  personalAccessTokens: [
    {
      key: { clientId: 1 },
      name: "clientId_1",
    },
  ],
};

const migrate = async () => {
  for (const [name, collectionIndexes] of Object.entries(indexes)) {
    const collection = await getCollectionInternal(name);
    await Helpers.addIndexesToCollection(collection, collectionIndexes);
  }
};

const rollback = async () => {
  for (const [name, collectionIndexes] of Object.entries(indexes)) {
    const collection = await getCollectionInternal(name);
    await Helpers.dropIndexesFromCollection(collection, collectionIndexes);
  }
};

export { tags, migrate, rollback };
export default { tags, migrate, rollback };
