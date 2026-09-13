import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose

// One document per linked project. The two tokens are stored encrypted with
// `@overleaf/access-token-encryptor`; nothing else in here is a secret.
export const GithubBackupLinkSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      unique: true,
      required: true,
    },
    linkedBy: { type: Schema.Types.ObjectId, required: true },
    owner: { type: String, required: true },
    repo: { type: String, required: true },
    branch: { type: String, default: 'main', required: true },
    githubTokenEncrypted: { type: String, required: true },
    bridgeTokenEncrypted: { type: String, required: true },
    bridgeTokenId: { type: Schema.Types.ObjectId, default: null },
    enabled: { type: Boolean, default: true, required: true },
    status: {
      type: String,
      enum: ['idle', 'syncing', 'ok', 'error', 'diverged'],
      default: 'idle',
      required: true,
    },
    lastSyncedVersion: { type: Number, default: null },
    lastSyncedAt: { type: Date, default: null },
    lastPushedCommit: { type: String, default: null },
    lastError: {
      type: new Schema(
        {
          code: { type: String, required: true },
          message: { type: String, default: '' },
          at: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      default: null,
    },
    // Held while a sync runs, so that the scheduler and a "Back up now" click
    // cannot run git against the same mirror at the same time.
    leaseUntil: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'githubBackupLinks', minimize: false }
)

export const GithubBackupLink = mongoose.model(
  'GithubBackupLink',
  GithubBackupLinkSchema
)

export default GithubBackupLink
