// Public API of the notifications module. Other modules import only from here.
export { countUnread, createNotifications, listNotifications, listPreferences, markRead, setPreference, type NotificationView, type PreferenceRow } from "./service";
export {
  CHANNELS, DEFAULT_ENABLED, describeNotification, isNotificationType, NOTIFICATION_TYPES, PAYLOADS, TYPE_LABEL,
  type Channel, type NotificationType, type PayloadOf,
} from "./types";
