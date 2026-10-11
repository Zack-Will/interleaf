import { getBackgroundColorForUserId } from '@/shared/utils/colors'

export function livePreviewUserColor(userId: string) {
  if (userId.startsWith('anonymous:') || userId === 'anonymous-user') {
    return '#808080'
  }
  return getBackgroundColorForUserId(userId)
}
