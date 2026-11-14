import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

// A pre-registered OAuth client. It belongs to the user who created it, and
// only that user can authorize it.
export const OAuthClientSchema = new Schema(
  {
    clientId: { type: String, required: true, unique: true },
    hashedSecret: { type: String, required: true },
    user_id: { type: ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    redirectUris: { type: [String], required: true },
    // false keeps a refresh token valid across refreshes (Gemini requires
    // it). Missing on older documents, which means true.
    rotateRefreshTokens: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
  },
  { collection: 'mcpOAuthClients', minimize: false }
)

export const OAuthClient = mongoose.model('OAuthClient', OAuthClientSchema)

export default OAuthClient
