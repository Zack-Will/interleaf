import Helpers from "./lib/helpers.mjs";
import { getCollectionInternal } from "./lib/mongodb.mjs";

const tags = ["server-ce", "server-pro", "saas"];

const indexes = [
  {
    key: { branchProjectId: 1 },
    name: "branchProjectId_1",
    unique: true,
  },
  {
    key: { parentProjectId: 1, status: 1 },
    name: "parentProjectId_1_status_1",
  },
];

const migrate = async () => {
  const collection = await getCollectionInternal("syncBranches");
  await Helpers.addIndexesToCollection(collection, indexes);
};

const rollback = async () => {
  const collection = await getCollectionInternal("syncBranches");
  await Helpers.dropIndexesFromCollection(collection, indexes);
};

export { tags, migrate, rollback };
export default { tags, migrate, rollback };
