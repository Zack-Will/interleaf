import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

export const PersonalAccessTokenSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', index: true, required: true },
    tokenPrefix: { type: String, required: true },
    hashedToken: { type: String, required: true, unique: true, index: true },
    scopes: {
      type: [String],
      enum: ['git_bridge', 'mcp'],
      required: true,
      default: ['git_bridge'],
    },
    label: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    // 'oauth' rows are the access tokens of an OAuth grant (module oauth): the
    // grant rotates the secret in place, so one row stands for one connection.
    source: { type: String, enum: ['user', 'oauth'], default: 'user' },
    clientId: { type: String, default: null },
  },
  {
    collection: 'personalAccessTokens',
    minimize: false,
  }
)

export const PersonalAccessToken = mongoose.model(
  'PersonalAccessToken',
  PersonalAccessTokenSchema
)

export default PersonalAccessToken
