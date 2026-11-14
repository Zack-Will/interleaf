import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

// One connection of a client to a user: the current refresh token and the
// personal access token row (source 'oauth') that holds its access token.
// Refresh tokens are rotated on every use; the recent rotated hashes are kept
// so that replaying one can be detected and the grant revoked.
export const OAuthGrantSchema = new Schema(
  {
    hashedRefreshToken: { type: String, required: true, unique: true },
    rotatedRefreshTokenHashes: { type: [String], default: [] },
    clientId: { type: String, required: true },
    user_id: { type: ObjectId, ref: 'User', required: true },
    tokenId: { type: ObjectId, required: true },
    scope: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    refreshExpiresAt: { type: Date, required: true },
  },
  { collection: 'oauthGrants', minimize: false }
)

export const OAuthGrant = mongoose.model('OAuthGrant', OAuthGrantSchema)

export default OAuthGrant
