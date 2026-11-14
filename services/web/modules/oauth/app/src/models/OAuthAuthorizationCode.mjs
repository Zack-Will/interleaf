import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

// A single-use authorization code, bound to the client, the redirect URI, the
// PKCE challenge and the user who approved it. A TTL index on expiresAt
// removes unused codes.
export const OAuthAuthorizationCodeSchema = new Schema(
  {
    hashedCode: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    user_id: { type: ObjectId, ref: 'User', required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    scope: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'mcpOAuthAuthorizationCodes', minimize: false }
)

export const OAuthAuthorizationCode = mongoose.model(
  'OAuthAuthorizationCode',
  OAuthAuthorizationCodeSchema
)

export default OAuthAuthorizationCode
