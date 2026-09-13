import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose

export const SyncBranchSchema = new Schema(
  {
    branchProjectId: {
      type: Schema.Types.ObjectId,
      unique: true,
      required: true,
    },
    parentProjectId: { type: Schema.Types.ObjectId, required: true },
    baseVersion: { type: Number, required: true },
    name: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['open', 'merged', 'archived'],
      default: 'open',
      required: true,
    },
    mergedVersion: { type: Number, default: null },
    mergedAt: { type: Date, default: null },
  },
  { collection: 'syncBranches', minimize: false }
)

export const SyncBranch = mongoose.model('SyncBranch', SyncBranchSchema)

export default SyncBranch
