import { api, clearSessionToken, getInstanceURL, normalizeInstanceURL, setInstanceURL } from "./api.js?v=ios17-pdf-v199";
import {
  base64ToBytes,
  decryptBytes,
  decryptEnvelope,
  decryptText,
  encryptBytes,
  encryptEnvelope,
  encryptText,
  exportShareKey,
  generateGroupKey,
  generateShareKey,
  importIdentityBundle,
  privateConversationKey,
  sha256Hex,
  signMessagePayload,
  upgradeIdentityEnvelope,
  verifyMessagePayload,
  unwrapGroupKey,
  wrapGroupKey,
} from "./crypto.js";
import {
  forgetRememberedIdentity,
  hasRememberedIdentity,
  loadRememberedIdentity,
  rememberIdentityBundle,
  resetLoginVerificationCounter,
} from "./device-vault.js";
import {
  enableNotifications,
  notificationStatus,
  registerServiceWorker,
  showGroupRemovalNotification,
  renewPushSubscription,
  showIncomingCallNotification,
  showIncomingMessageNotification,
  showLocalTestNotification,
  syncBrowserSubscription,
  testNotification,
} from "./notifications.js?v=passphrase-strength-v276";
import { ChatSocket } from "./websocket.js?v=ios17-pdf-v199";
import { actionIcon, bindSwipeActions, formatMessageTime, frenchErrorMessage, materialFileIcon, renderMessage, setBusy, toast } from "./ui.js?v=ios17-pdf-v211";
import { locale, t } from "./i18n.js";
import { runKeyedTask } from "./keyed-task-guard.js?v=ios17-pdf-v199";
import { nonWhiteImageBounds } from "./file-preview-image.js?v=ios17-pdf-v199";
import {
  needsInlinePDFWorker,
  pdfDocumentCompatibilityOptions,
} from "./pdf-preview-compat.js?v=ios17-pdf-v199";
import {
  clearOfficePreviewResources,
  modernOfficeKind,
  officeFallbackPreviewBlob,
  preloadModernOfficePreview,
  renderModernOfficePreview,
} from "./office-preview.js?v=office-faithful-preview-v265";
import { openConversationCache, sameMessageSnapshots } from "./conversation-cache.js?v=cache-v3";
import {
  acceptPendingIdentity,
  canonicalPublicKey,
  formatPublicKeyFingerprint,
  getIdentityTrust,
  markIdentityVerified,
  observeIdentityKey,
  publicKeyFingerprint,
} from "./identity-trust.js?v=passphrase-strength-v276";

const CALL_INVITE_TIMEOUT_MS = 45000;
const CALL_SIGNAL_LOSS_GRACE_MS = 15000;
const CALL_ICE_RESTART_TIMEOUT_MS = 15000;
const CALL_ICE_RESTART_MAX_ATTEMPTS = 2;
const FILE_PREVIEW_PREFETCH_BUDGET_BYTES = 8 * 1024 * 1024;
const BACKGROUND_CONVERSATION_PRELOAD_LIMIT = 6;
const BACKGROUND_CONVERSATION_PRELOAD_CONCURRENCY = 2;
const BACKGROUND_THUMBNAIL_PRELOAD_CONCURRENCY = 2;
const BACKGROUND_THUMBNAIL_PRELOAD_BUDGET_BYTES = 4 * 1024 * 1024;
const BACKGROUND_PRELOAD_TTL_MS = 2 * 60 * 1000;
const BACKGROUND_PRELOAD_NETWORK_FRESH_MS = 15 * 1000;
const WHITEBOARD_MESSAGE_TYPE = "whiteboard";
const APP_BUILD = "translated-call-status-v282";
const ADMIN_RETURN_HISTORY_KEY = "vibration.admin_return_history";

window.VIBRATION_BUILD = APP_BUILD;
console.info(`Vibration build ${APP_BUILD}`);

const state = {
  me: null,
  edition: { edition: "enterprise", admin_panel: true, manager_panel: true },
  cache: null,
  fileQuotas: null,
  privateKey: null,
  signingPrivateKey: null,
  signingKeyID: "",
  contacts: [],
  carnet: [],
  conversations: [],
  current: null,
  keys: new Map(),
  keyEnvelopes: new Map(),
  keyEnvelopeLoads: new Map(),
  members: new Map(),
  identityConfirmations: new Map(),
  identityWarnings: new Set(),
  conversationInfoIdentity: null,
  socket: null,
  typing: new Map(),
  typingTimers: new Map(),
  onlineUsers: new Set(),
  files: new Map(),
  fileLoads: new Map(),
  fileThumbnails: new Map(),
  fileThumbnailLoads: new Map(),
  fileThumbnailPayloadPreloads: new Map(),
  conversationPreloads: new Map(),
  preloadedMessages: new Map(),
  conversationPreloadVersions: new Map(),
  messageClears: new Map(),
  messageExpiryTimers: new Map(),
  messageAppendTasks: new Map(),
  filePreviewObservers: new Set(),
  previewURLs: new Set(),
  fileCacheGeneration: 0,
  callConfig: null,
  replyTo: null,
  messageExpirationSeconds: 0,
  call: null,
  pendingVoiceFile: null,
  pendingVoiceURL: null,
  recorder: null,
  recordingChunks: [],
  recordingStopTimer: null,
  editingPoll: null,
  editingEvent: null,
  calendarItems: [],
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  pendingFileShare: null,
  activeFileShareID: null,
  sharedCalendarFeedID: null,
};

let profileAvatar = null;
let groupAvatar = null;
const groupInvitedUsers = new Map();
let pdfJSModule;
let ios17PDFJSModule;
let conversationRenderVersion = 0;
let conversationListRenderKey = "";
let appReady = false;
const pdfScriptLoads = new Map();
const backgroundThumbnailQueue = [];
let activeBackgroundThumbnailPreloads = 0;
const CALENDAR_FEED_TOKEN_KEY = "vibration.calendar_feed_token";
let callPageExitHandled = false;
let callVideoResumeTimer = null;

const elements = {
  shell: document.querySelector("#app-shell"),
  conversations: document.querySelector("#conversation-list"),
  personalConversationButton: document.querySelector("#personal-conversation-button"),
  personalConversationPreview: document.querySelector("#personal-conversation-preview"),
  personalConversationUnread: document.querySelector("#personal-conversation-unread"),
  messages: document.querySelector("#message-list"),
  chatWorkspace: document.querySelector("#chat-workspace"),
  pinnedPanel: document.querySelector("#pinned-panel"),
  pinnedMessages: document.querySelector("#pinned-message-list"),
  pinnedWindowButton: document.querySelector("#pinned-window-button"),
  closePinnedPanel: document.querySelector("#close-pinned-panel"),
  chatAvatar: document.querySelector("#chat-avatar"),
  chatIdentity: document.querySelector("#chat-conversation-identity"),
  conversationInfoDialog: document.querySelector("#conversation-info-dialog"),
  conversationInfoAvatar: document.querySelector("#conversation-info-avatar"),
  conversationInfoTitle: document.querySelector("#conversation-info-title"),
  conversationInfoKind: document.querySelector("#conversation-info-kind"),
  conversationInfoName: document.querySelector("#conversation-info-name"),
  conversationInfoNameLabel: document.querySelector("#conversation-info-name-label"),
  conversationInfoDisplayName: document.querySelector("#conversation-info-display-name"),
  conversationInfoUsernameRow: document.querySelector("#conversation-info-username-row"),
  conversationInfoUsername: document.querySelector("#conversation-info-username"),
  conversationInfoAddressRow: document.querySelector("#conversation-info-address-row"),
  conversationInfoAddress: document.querySelector("#conversation-info-address"),
  conversationInfoInstance: document.querySelector("#conversation-info-instance"),
  conversationInfoDescription: document.querySelector("#conversation-info-description"),
  conversationInfoFingerprintRow: document.querySelector("#conversation-info-fingerprint-row"),
  conversationInfoFingerprint: document.querySelector("#conversation-info-fingerprint"),
  conversationInfoTrustStatus: document.querySelector("#conversation-info-trust-status"),
  conversationInfoVerify: document.querySelector("#conversation-info-verify"),
  conversationInfoMembersSection: document.querySelector("#conversation-info-members-section"),
  conversationInfoMembersCount: document.querySelector("#conversation-info-members-count"),
  conversationInfoMembers: document.querySelector("#conversation-info-members"),
  title: document.querySelector("#chat-title"),
  description: document.querySelector("#chat-description"),
  typing: document.querySelector("#typing-label"),
  threadTyping: ensureThreadTypingLabel(),
  audioCallButton: document.querySelector("#audio-call-button"),
  videoCallButton: document.querySelector("#video-call-button"),
  calendarButton: document.querySelector("#calendar-button"),
  carnetButton: document.querySelector("#carnet-button"),
  globalFilesButton: document.querySelector("#global-files-button"),
  callBanner: document.querySelector("#call-banner"),
  callBannerLabel: document.querySelector("#call-banner-label"),
  callTurnIndicator: document.querySelector("#call-turn-indicator"),
  remoteCallAudio: document.querySelector("#remote-call-audio"),
  remoteCallAudioPeers: document.querySelector("#remote-call-audio-peers"),
  callVideoStage: document.querySelector("#call-video-stage"),
  remoteCallVideos: document.querySelector("#remote-call-videos"),
  remoteCallVideo: document.querySelector("#remote-call-video"),
  localCallVideo: document.querySelector("#local-call-video"),
  callAndroidExitFullscreenButton: document.querySelector("#call-android-exit-fullscreen-button"),
  callOpenConversationButton: document.querySelector("#call-open-conversation-button"),
  callAcceptButton: document.querySelector("#call-accept-button"),
  callRejectButton: document.querySelector("#call-reject-button"),
  callMuteButton: document.querySelector("#call-mute-button"),
  callCameraButton: document.querySelector("#call-camera-button"),
  callFullscreenButton: document.querySelector("#call-fullscreen-button"),
  callSwitchCameraButton: document.querySelector("#call-switch-camera-button"),
  callScreenShareButton: ensureCallScreenShareButton(),
  callWhiteboardButton: document.querySelector("#call-whiteboard-button"),
  callWhiteboard: document.querySelector("#call-whiteboard"),
  whiteboardCanvas: document.querySelector("#whiteboard-canvas"),
  whiteboardColor: document.querySelector("#whiteboard-color"),
  whiteboardSize: document.querySelector("#whiteboard-size"),
  whiteboardUndo: document.querySelector("#whiteboard-undo"),
  whiteboardClear: document.querySelector("#whiteboard-clear"),
  whiteboardSave: document.querySelector("#whiteboard-save"),
  whiteboardFullscreen: document.querySelector("#whiteboard-fullscreen"),
  callHangupButton: document.querySelector("#call-hangup-button"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message-input"),
  send: document.querySelector("#send-button"),
  file: document.querySelector("#file-input"),
  voiceButton: document.querySelector("#voice-button"),
  pollButton: document.querySelector("#poll-button"),
  eventButton: document.querySelector("#event-button"),
  expirationOptions: document.querySelector("#expiration-options"),
  voiceDraft: document.querySelector("#voice-draft"),
  voiceDraftAudio: document.querySelector("#voice-draft-audio"),
  voiceDraftClear: document.querySelector("#voice-draft-clear"),
  replyTarget: document.querySelector("#reply-target"),
  replyClear: document.querySelector("#reply-clear"),
  emojiButton: document.querySelector("#emoji-button"),
  emojiPicker: document.querySelector("#emoji-picker"),
  pollDialog: document.querySelector("#poll-dialog"),
  pollQuestion: document.querySelector("#poll-question"),
  pollOptionInputs: document.querySelector("#poll-option-inputs"),
  pollAddOption: document.querySelector("#poll-add-option"),
  pollExpiration: document.querySelector("#poll-expiration"),
  pollSubmit: document.querySelector("#poll-submit"),
  eventDialog: document.querySelector("#event-dialog"),
  eventName: document.querySelector("#event-name"),
  eventDescription: document.querySelector("#event-description"),
  eventLocation: document.querySelector("#event-location"),
  eventStart: document.querySelector("#event-start"),
  eventEnd: document.querySelector("#event-end"),
  eventSubmit: document.querySelector("#event-submit"),
  calendarDialog: document.querySelector("#calendar-dialog"),
  calendarGrid: document.querySelector("#calendar-grid"),
  calendarMonthLabel: document.querySelector("#calendar-month-label"),
  calendarStatus: document.querySelector("#calendar-status"),
  carnetDialog: document.querySelector("#carnet-dialog"),
  carnetStatus: document.querySelector("#carnet-status"),
  carnetList: document.querySelector("#carnet-list"),
  carnetDeleteAll: document.querySelector("#carnet-delete-all"),
  globalFilesDialog: document.querySelector("#global-files-dialog"),
  globalFilesStatus: document.querySelector("#global-files-status"),
  globalFilesList: document.querySelector("#global-files-list"),
  fileShareDialog: document.querySelector("#file-share-dialog"),
  fileShareForm: document.querySelector("#file-share-form"),
  fileShareName: document.querySelector("#file-share-name"),
  fileShareExpiration: document.querySelector("#file-share-expiration"),
  fileShareError: document.querySelector("#file-share-error"),
  fileShareResult: document.querySelector("#file-share-result"),
  fileShareURL: document.querySelector("#file-share-url"),
  fileShareValidity: document.querySelector("#file-share-validity"),
  fileShareCreateActions: document.querySelector("#file-share-create-actions"),
  fileShareCreate: document.querySelector("#file-share-create"),
  fileShareCopy: document.querySelector("#file-share-copy"),
  fileShareRevoke: document.querySelector("#file-share-revoke"),
  fileShareExisting: document.querySelector("#file-share-existing"),
  fileShareExistingList: document.querySelector("#file-share-existing-list"),
};

const emojis = [
  "😀", "😂", "😊", "😍", "🥰", "😘",
  "😎", "🤔", "😢", "😭", "😡", "🥳",
  "👍", "👎", "👏", "🙏", "💪", "🤝",
  "❤️", "💔", "🔥", "✨", "🎉", "✅",
  "👋", "👌", "🤗", "😴", "🙈", "🚀",
];
const reactionEmojis = emojis;
let activeReactionPicker = null;

function ensureThreadTypingLabel() {
  const existing = document.querySelector("#thread-typing-label");
  if (existing) return existing;
  const label = document.createElement("div");
  label.id = "thread-typing-label";
  label.setAttribute("aria-live", "polite");
  label.hidden = true;
  document.querySelector("#composer")?.before(label);
  return label;
}

function ensureCallScreenShareButton() {
  const existing = document.querySelector("#call-screen-share-button");
  if (existing) return existing;
  const button = document.createElement("button");
  button.id = "call-screen-share-button";
  button.className = "outline call-action-button";
  button.type = "button";
  button.title = t("Partager l’écran");
  button.setAttribute("aria-label", t("Partager l’écran"));
  button.innerHTML = '<svg class="call-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v12H3Z"></path><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="m9 10 3-3 3 3"></path><path d="M12 7v7"></path></svg>';
  const actions = document.querySelector(".call-actions");
  const switchCamera = document.querySelector("#call-switch-camera-button");
  if (actions) actions.insertBefore(button, switchCamera || document.querySelector("#call-hangup-button"));
  return button;
}

function closeEmojiPicker() {
  elements.emojiPicker.hidden = true;
  elements.emojiButton.setAttribute("aria-expanded", "false");
}

function insertEmoji(emoji) {
  const input = elements.input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const nextValue = `${input.value.slice(0, start)}${emoji}${input.value.slice(end)}`;
  if (nextValue.length > input.maxLength) return;
  input.value = nextValue;
  const caret = start + emoji.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus({ preventScroll: true });
  closeEmojiPicker();
}

function bindEmojiPicker() {
  const fragment = document.createDocumentFragment();
  for (const emoji of emojis) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.setAttribute("aria-label", `Insérer ${emoji}`);
    button.onclick = () => insertEmoji(emoji);
    fragment.append(button);
  }
  elements.emojiPicker.append(fragment);
  elements.emojiButton.onclick = (event) => {
    event.stopPropagation();
    const open = elements.emojiPicker.hidden;
    elements.emojiPicker.hidden = !open;
    elements.emojiButton.setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".composer-tools")) closeEmojiPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEmojiPicker();
  });
}

function actionDialog({
  title, message = "", inputLabel = "", value = "", maxLength = 200000, singleLine = false,
  secondaryLabel = "", secondaryValue = "", secondaryMaxLength = 280,
  confirmLabel = "Confirmer", danger = false, messageValues = {},
}) {
  const dialog = document.querySelector("#action-dialog");
  const form = document.querySelector("#action-form");
  const inputRow = document.querySelector("#action-input-label");
  const textarea = document.querySelector("#action-input");
  const singleInput = document.querySelector("#action-single-input");
  const input = singleLine ? singleInput : textarea;
  const secondaryRow = document.querySelector("#action-secondary-label");
  const secondaryInput = document.querySelector("#action-secondary-input");
  document.querySelector("#action-title").textContent = t(title);
  document.querySelector("#action-message").textContent = t(message, messageValues);
  document.querySelector("#action-confirm").textContent = t(confirmLabel);
  document.querySelector("#action-confirm").classList.toggle("danger-button", danger);
  inputRow.hidden = !inputLabel;
  inputRow.querySelector("span").textContent = t(inputLabel);
  textarea.hidden = singleLine;
  singleInput.hidden = !singleLine;
  input.value = value;
  input.maxLength = maxLength;
  secondaryRow.hidden = !secondaryLabel;
  secondaryRow.querySelector("span").textContent = t(secondaryLabel);
  secondaryInput.value = secondaryValue;
  secondaryInput.maxLength = secondaryMaxLength;
  dialog.showModal();
  if (inputLabel) requestAnimationFrame(() => input.select());
  return new Promise((resolve) => {
    const finish = (result) => {
      form.removeEventListener("submit", submit);
      document.querySelector("#action-cancel").removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const submit = (event) => {
      event.preventDefault();
      if (secondaryLabel) {
        finish({ value: input.value.trim(), secondaryValue: secondaryInput.value.trim() });
      } else {
        finish(inputLabel ? input.value.trim() : true);
      }
    };
    const cancel = (event) => {
      event?.preventDefault();
      finish(null);
    };
    form.addEventListener("submit", submit);
    document.querySelector("#action-cancel").addEventListener("click", cancel);
    dialog.addEventListener("cancel", cancel);
  });
}

function appendGroupUserSearchResult(results, user, onInvite) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "picker-row";
  const identity = document.createElement("span");
  const displayName = document.createElement("strong");
  displayName.textContent = user.display_name || user.username;
  const description = document.createElement("small");
  description.className = "contact-description";
  description.textContent = user.description || "";
  description.hidden = !user.description;
  const username = document.createElement("small");
  username.textContent = `@${user.username}`;
  identity.append(displayName, description, username);
  const action = document.createElement("span");
  action.textContent = t("Inviter");
  row.append(identity, action);
  row.onclick = onInvite;
  results.append(row);
}

function groupEditDialog({ name, description, avatar, contacts, members }) {
  const dialog = document.querySelector("#group-edit-dialog");
  const form = document.querySelector("#group-edit-form");
  const nameInput = document.querySelector("#group-edit-name");
  const descriptionInput = document.querySelector("#group-edit-description");
  const avatarInput = document.querySelector("#group-edit-avatar-input");
  const avatarPreview = document.querySelector("#group-edit-avatar-preview");
  const removeButton = document.querySelector("#group-edit-avatar-remove");
  const errorRegion = document.querySelector("#group-edit-error");
  const memberList = document.querySelector("#group-edit-members");
  const userSearch = document.querySelector("#group-edit-user-search");
  const userResults = document.querySelector("#group-edit-user-results");
  let selectedAvatar = avatar || null;
  const selectedIDs = new Set(members.filter((member) => member.user_id !== state.me.id).map((member) => member.user_id));
  const extraUsers = new Map();

  const updatePreview = () => {
    renderGroupAvatarPreview(avatarPreview, selectedAvatar);
    removeButton.hidden = !selectedAvatar;
  };
  const renderMembers = () => renderGroupMemberPicker(memberList, contacts, {
    selectedIDs,
    existingMembers: members,
    extraUsers: [...extraUsers.values()],
    disabledIDs: new Set([state.me.id]),
    emptyText: "Aucun contact disponible.",
    onChange: (userID, checked) => {
      if (checked) selectedIDs.add(userID);
      else selectedIDs.delete(userID);
    },
  });
  const searchUsers = debounce(async () => {
    const query = userSearch.value.trim();
    userResults.replaceChildren();
    if (query.length < 2) return;
    try {
      const users = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
      const currentIDs = new Set([...members.map((member) => member.user_id), ...selectedIDs, ...extraUsers.keys()]);
      for (const user of users.filter((item) => item.id !== state.me.id && !currentIDs.has(item.id))) {
        appendGroupUserSearchResult(userResults, user, () => {
          extraUsers.set(user.id, user);
          selectedIDs.add(user.id);
          userSearch.value = "";
          userResults.replaceChildren();
          renderMembers();
        });
      }
      if (!userResults.children.length) {
        const empty = document.createElement("p");
        empty.className = "picker-empty";
        empty.textContent = t("Aucun nouveau membre trouvé.");
        userResults.append(empty);
      }
    } catch (error) {
      toast(frenchErrorMessage(error, "Recherche utilisateur impossible."), "error");
    }
  }, 300);

  nameInput.value = name;
  descriptionInput.value = description;
  avatarInput.value = "";
  userSearch.value = "";
  userResults.replaceChildren();
  errorRegion.textContent = "";
  updatePreview();
  renderMembers();

  return new Promise((resolve) => {
    const finish = (result) => {
      userSearch.removeEventListener("input", searchUsers);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    userSearch.addEventListener("input", searchUsers);
    avatarInput.onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      try {
        selectedAvatar = await resizeAvatar(file);
        errorRegion.textContent = "";
        updatePreview();
      } catch (error) {
        errorRegion.textContent = frenchErrorMessage(error);
      }
    };
    removeButton.onclick = () => {
      selectedAvatar = null;
      updatePreview();
    };
    document.querySelector("#group-edit-close").onclick = () => finish(null);
    document.querySelector("#group-edit-cancel").onclick = () => finish(null);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const editedName = nameInput.value.trim();
      if (!editedName) return;
      finish({
        name: editedName,
        description: descriptionInput.value.trim(),
        avatar: selectedAvatar,
        memberIDs: [...selectedIDs],
        invitedUsers: [...extraUsers.values()],
      });
    };
    dialog.showModal();
    requestAnimationFrame(() => nameInput.select());
  });
}

function pushFailureMessage(failures = []) {
  if (failures.includes("current_device_not_subscribed")) return "cet appareil n’est pas abonné";
  if (failures.includes("insecure_context")) return "ouvrez l’application en HTTPS";
  if (failures.includes("unsupported_protocol")) return "protocole non compatible";
  if (failures.includes("push_manager_missing") || failures.includes("service_worker_missing")) return "Web Push indisponible dans ce navigateur";
  if (failures.includes("native_only_no_remote_push")) return "notifications natives locales seulement";
  if (failures.includes("native_permission_denied")) return "permission système refusée";
  if (failures.includes("database_error")) return "erreur de consultation des abonnements";
  if (failures.includes("transport_error")) return "service de notification inaccessible";
  if (failures.includes("subscription_expired")) return "abonnement expiré";
  if (failures.some((failure) => failure.startsWith("push_service_http_"))) {
    return "requête refusée par le service de notification";
  }
  return "échec technique de livraison";
}

function clearRenderedFilePreviews() {
  clearOfficePreviewResources();
  for (const observer of state.filePreviewObservers) observer.disconnect();
  state.filePreviewObservers.clear();
  for (const url of state.previewURLs) URL.revokeObjectURL(url);
  state.previewURLs.clear();
}

function clearFileCache() {
  state.fileCacheGeneration++;
  clearRenderedFilePreviews();
  for (const file of state.files.values()) URL.revokeObjectURL(file.url);
  for (const thumbnail of state.fileThumbnails.values()) revokeFileThumbnail(thumbnail);
  state.files.clear();
  state.fileLoads.clear();
  state.fileThumbnails.clear();
  state.fileThumbnailLoads.clear();
}

function revokeFileThumbnail(thumbnail) {
  thumbnail.revoked = true;
  URL.revokeObjectURL(thumbnail.url);
  if (thumbnail.displayURL && thumbnail.displayURL !== thumbnail.url) URL.revokeObjectURL(thumbnail.displayURL);
}

function messageTimerKey(conversationID, messageID) {
  return `${conversationID}:${messageID}`;
}

function clearMessageExpiration(message) {
  const key = messageTimerKey(message.conversation_id, message.id);
  clearTimeout(state.messageExpiryTimers.get(key));
  state.messageExpiryTimers.delete(key);
}

function clearConversationMessageExpirations(conversationID) {
  const prefix = `${conversationID}:`;
  for (const [key, timer] of state.messageExpiryTimers) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(timer);
    state.messageExpiryTimers.delete(key);
  }
}

async function expireRenderedMessage(conversationID, messageID) {
  invalidateConversationPreload(conversationID);
  state.cache?.deleteMessage(conversationID, messageID);
  state.messageClears.get(conversationID)?.delete(messageID);
  const key = messageTimerKey(conversationID, messageID);
  clearTimeout(state.messageExpiryTimers.get(key));
  state.messageExpiryTimers.delete(key);
  if (state.current?.id === conversationID) {
    const row = elements.messages.querySelector(`[data-id="${messageID}"]`);
    row?.remove();
    if (!elements.messages.querySelector(".message")) {
      const empty = document.createElement("div");
      empty.id = "empty-chat";
      empty.textContent = t("Aucun message. Écrivez le premier message chiffré.");
      elements.messages.append(empty);
    }
  }
  try {
    state.conversations = await api("/api/conversations");
    await renderConversations();
  } catch {}
}

function scheduleMessageExpiration(message) {
  clearMessageExpiration(message);
  if (!message.expires_at) return true;
  const expiresAt = Date.parse(message.expires_at);
  if (!Number.isFinite(expiresAt)) return true;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    expireRenderedMessage(message.conversation_id, message.id).catch(() => {});
    return false;
  }
  const key = messageTimerKey(message.conversation_id, message.id);
  state.messageExpiryTimers.set(key, setTimeout(() => {
    expireRenderedMessage(message.conversation_id, message.id).catch(() => {});
  }, Math.min(remaining, 2147483647)));
  return true;
}

function defaultFileQuotas() {
  return {
    max_file_size: 25 * 1024 * 1024,
    max_user_storage: 1024 * 1024 * 1024,
    used_storage: 0,
  };
}

async function refreshFileQuotas() {
  try {
    state.fileQuotas = await api("/api/files/limits");
  } catch {
    state.fileQuotas ||= defaultFileQuotas();
  }
  updateProfileStorage();
  return state.fileQuotas;
}

async function boot() {
  sessionStorage.removeItem(ADMIN_RETURN_HISTORY_KEY);
  try {
    const [me, edition, terms] = await Promise.all([api("/api/me"), api("/api/edition"), api("/api/terms/status")]);
    if (!terms.accepted) {
      location.replace("/login.html?terms=required");
      return;
    }
    state.me = me;
    state.edition = edition;
    state.cache = await openConversationCache(getInstanceURL(), state.me);
    await refreshFileQuotas();
  } catch (error) {
    location.replace("/login.html");
    return;
  }
  elements.shell.hidden = false;
  updateIdentityLabel();
  const adminLink = document.querySelector("#admin-link");
  const canOpenAdmin = state.edition.admin_panel && (state.me.is_admin || state.me.is_manager);
  adminLink.hidden = !canOpenAdmin;
  adminLink.textContent = t(state.me.is_manager && !state.me.is_admin ? "Gestion" : "Administration");
  adminLink.addEventListener("click", prepareAdminNavigation);
  await unlock();
  bindUI();
  await trustedPublicKey(state.me, { interactive: true });
  connectSocket();
  await refreshAll();
  appReady = true;
  initializeNotificationsAfterBoot();
}

async function initializeNotificationsAfterBoot() {
  try {
    await registerServiceWorker();
  } catch (error) {
    console.warn("Initialisation du Service Worker impossible", error);
  }
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      await enableNotifications();
    } catch (error) {
      console.warn("Activation automatique des notifications impossible", error);
    }
  }
  await refreshNotificationStatus();
}

async function unlock() {
  const dialog = document.querySelector("#unlock-dialog");
  const error = document.querySelector("#unlock-error");
  const forceVerification = sessionStorage.getItem("force_identity_verification") === "true";
  const attempt = async (phrase, remember = false) => {
    const wasLegacyIdentity = !state.me.signing_key_id;
    let { bundle, update } = await upgradeIdentityEnvelope(state.me, phrase);
    if (update) {
      try {
        const identity = await api("/api/me/identity", { method: "PUT", body: update });
        state.me = { ...state.me, ...identity };
      } catch (migrationError) {
        // Another device may have completed the same one-time migration first.
        // Reloading the server envelope makes that race recoverable with the
        // same existing phrase instead of generating another signing key.
        const latestIdentity = await api("/api/me").catch(() => null);
        if (!latestIdentity?.signing_key_id) throw migrationError;
        const latest = await upgradeIdentityEnvelope(latestIdentity, phrase);
        if (latest.update) throw migrationError;
        state.me = latestIdentity;
        bundle = latest.bundle;
        update = null;
      }
    }
    if (wasLegacyIdentity && state.me.signing_public_key) {
      const trustInput = identityTrustInput(state.me);
      const observed = await observeIdentityKey(trustInput);
      if (observed.status === "changed" && !observed.record.signingPublicKey &&
          observed.record.pendingSigningPublicKey === canonicalPublicKey(state.me.signing_public_key) &&
          observed.record.pendingPublicKey === canonicalPublicKey(state.me.public_key)) {
        const preserveVerification = Boolean(observed.record.verifiedAt);
        const accepted = await acceptPendingIdentity(trustInput, observed.record.pendingFingerprint);
        if (preserveVerification) await markIdentityVerified(trustInput, accepted.record.fingerprint);
      }
    }
    const unlocked = remember
      ? await rememberIdentityBundle(state.me, bundle)
      : await importIdentityBundle(bundle);
    state.privateKey = unlocked.privateKey;
    state.signingPrivateKey = unlocked.signingPrivateKey;
    state.signingKeyID = unlocked.signingKeyID;
    if (remember) sessionStorage.removeItem("crypto_phrase");
    else sessionStorage.setItem("crypto_phrase", phrase);
  };
  if (!forceVerification && state.me.signing_key_id) {
    try {
      const unlocked = await loadRememberedIdentity(state.me);
      if (unlocked?.privateKey && unlocked?.signingPrivateKey) {
        state.privateKey = unlocked.privateKey;
        state.signingPrivateKey = unlocked.signingPrivateKey;
        state.signingKeyID = unlocked.signingKeyID;
        sessionStorage.removeItem("crypto_phrase");
        sessionStorage.removeItem("remember_encryption_key");
        return;
      }
    } catch (exception) {
      console.warn("Lecture de la clé locale impossible", exception);
    }
  }
  const saved = sessionStorage.getItem("crypto_phrase");
  if (saved && !forceVerification) {
    try {
      await attempt(saved, sessionStorage.getItem("remember_encryption_key") === "true");
      sessionStorage.removeItem("remember_encryption_key");
      return;
    } catch {
      sessionStorage.removeItem("crypto_phrase");
      sessionStorage.removeItem("remember_encryption_key");
    }
  }
  document.querySelector("#unlock-dialog h3").textContent = t(forceVerification
    ? "Vérification périodique de sécurité"
    : (state.me.signing_key_id ? "Déverrouiller les messages" : "Mettre à niveau la sécurité"));
  document.querySelector("#unlock-dialog p").textContent = t(forceVerification
    ? "Pour protéger votre identité, saisissez votre phrase secrète. Cette vérification est demandée à la première connexion puis périodiquement."
    : (state.me.signing_key_id
      ? "Entrez votre phrase secrète de chiffrement. Elle n’est jamais envoyée au serveur."
      : "Saisissez votre phrase secrète actuelle. Votre identité sera protégée par Argon2id et dotée d’une clé de signature, sans modifier votre phrase."));
  document.querySelector("#unlock-remember").checked = true;
  document.querySelector("#unlock-remember-label").hidden = forceVerification;
  dialog.showModal();
  await new Promise((resolve) => {
    document.querySelector("#unlock-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      try {
        await attempt(
          document.querySelector("#unlock-phrase").value,
          forceVerification || document.querySelector("#unlock-remember").checked,
        );
        if (forceVerification) {
          await resetLoginVerificationCounter(state.me.id);
          sessionStorage.removeItem("force_identity_verification");
        }
        document.querySelector("#unlock-phrase").value = "";
        dialog.close();
        resolve();
      } catch (exception) {
        error.textContent = frenchErrorMessage(exception);
      }
    });
  });
}

function bindUI() {
  bindEmojiPicker();
  bindDialogMediaIsolation();
  const profileDialog = document.querySelector("#profile-dialog");
  const profileForm = document.querySelector("#profile-form");
  const openProfileDialog = async () => {
    profileAvatar = state.me.avatar || null;
    updateProfileAvatarPreview();
    document.querySelector("#profile-username").value = state.me.username;
    document.querySelector("#profile-display-name").value = state.me.display_name;
    document.querySelector("#profile-description").value = state.me.description || "";
    document.querySelector("#profile-instance-url").value = getInstanceURL();
    document.querySelector("#profile-calendar-password").value = "";
    document.querySelector("#profile-calendar-url").value = "";
    document.querySelector("#profile-calendar-status").textContent = t("Vérification du flux calendrier…");
    document.querySelector("#profile-theme").value = window.ChatTheme?.getPreference() || "auto";
    document.querySelector("#profile-current-password").value = "";
    document.querySelector("#profile-new-password").value = "";
    document.querySelector("#profile-confirm-password").value = "";
    document.querySelector("#profile-error").textContent = "";
    updateProfileStorage();
    profileDialog.showModal();
    const profileTitle = document.querySelector("#profile-dialog h3");
    profileTitle?.setAttribute("tabindex", "-1");
    profileTitle?.focus({ preventScroll: true });
    await Promise.all([
      refreshFileQuotas(),
      refreshRememberedKeyStatus(),
      refreshNotificationStatus(),
      loadSharedCalendarFeedState(),
      refreshOwnIdentityFingerprint(),
    ]);
  };
  document.querySelector("#profile-button").onclick = openProfileDialog;
  document.querySelector("#close-sidebar-logo").onclick = openProfileDialog;
  document.querySelector("#profile-close").onclick = () => profileDialog.close();
  document.querySelector("#profile-calendar-copy").onclick = copyCalendarFeedURL;
  document.querySelector("#profile-calendar-create").onclick = createSharedCalendarFeed;
  document.querySelector("#profile-calendar-revoke").onclick = revokeSharedCalendarFeed;
  document.querySelector("#profile-calendar-export").onclick = exportCalendarICalendar;
  document.querySelector("#conversation-info-close").onclick = () => elements.conversationInfoDialog.close();
  elements.conversationInfoVerify.onclick = verifyCurrentConversationIdentity;
  elements.chatAvatar.onclick = () => {
    openCurrentConversationInfo().catch((error) => {
      if (!reportIdentitySecurityError(error)) {
        toast(frenchErrorMessage(error, "Impossible d’afficher ces informations."), "error");
      }
    });
  };
  elements.chatIdentity.onclick = () => {
    if (!elements.chatIdentity.classList.contains("conversation-info-trigger")) return;
    elements.chatAvatar.click();
  };
  elements.chatIdentity.addEventListener("keydown", (event) => {
    if (!elements.chatIdentity.classList.contains("conversation-info-trigger") || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    elements.chatAvatar.click();
  });
  document.querySelector("#profile-avatar-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      profileAvatar = await resizeAvatar(file);
      updateProfileAvatarPreview();
    } catch (error) {
      document.querySelector("#profile-error").textContent = frenchErrorMessage(error);
    }
  });
  document.querySelector("#profile-avatar-remove").onclick = () => {
    profileAvatar = null;
    updateProfileAvatarPreview();
  };
  document.querySelector("#profile-theme").onchange = (event) => {
    window.ChatTheme?.setPreference(event.target.value);
  };
  document.querySelector("#forget-key-button").onclick = async () => {
    await forgetRememberedIdentity(state.me.id);
    await refreshRememberedKeyStatus();
    toast("La clé mémorisée a été supprimée de cet appareil.", "success");
  };
  document.querySelector("#recovery-code-button").onclick = rotateRecoveryCode;
  profileForm.addEventListener("submit", updateProfile);
  document.querySelector("#logout-button").onclick = async () => {
    await api("/api/logout", { method: "POST", body: {} });
    clearSessionToken();
    sessionStorage.removeItem("crypto_phrase");
    location.href = "/login.html";
  };
  document.querySelector("#contact-button").onclick = () => document.querySelector("#contact-dialog").showModal();
  document.querySelector("#group-button").onclick = () => {
    openGroupDialog().catch((error) => toast(frenchErrorMessage(error, "Impossible de charger les contacts."), "error"));
  };
  elements.personalConversationButton.onclick = () => {
    const conversation = state.conversations.find((item) => item.is_personal);
    if (conversation) {
      keepConversationSelectedDuringMobileTransition(elements.personalConversationButton);
      selectConversation(conversation);
    }
  };
  const groupDialog = document.querySelector("#group-dialog");
  const groupCloseButton = groupDialog.querySelector("#group-close, .dialog-close");
  groupCloseButton.type = "button";
  groupCloseButton.onclick = () => groupDialog.close();
  document.querySelector("#group-avatar-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      groupAvatar = await resizeAvatar(file);
      updateGroupAvatarPreview();
    } catch (error) {
      toast(frenchErrorMessage(error), "error");
    }
  });
  document.querySelector("#group-avatar-remove").onclick = () => {
    groupAvatar = null;
    updateGroupAvatarPreview();
  };
  const sidebarButton = document.querySelector("#open-sidebar-logo");
  const pauseMessageVideos = () => {
    elements.messages.querySelectorAll("video").forEach((video) => {
      const fullscreen = video === document.fullscreenElement
        || video === document.webkitFullscreenElement
        || video.webkitDisplayingFullscreen;
      if (!fullscreen) video.pause();
    });
  };
  const setSidebarOpen = (open) => {
    if (open) pauseMessageVideos();
    elements.shell.classList.toggle("sidebar-open", open);
    sidebarButton.setAttribute("aria-expanded", String(open));
    sidebarButton.setAttribute("aria-label", t(open
      ? "Masquer les contacts, groupes et conversations"
      : "Afficher les contacts, groupes et conversations"));
    sidebarButton.title = t(open ? "Masquer les contacts et groupes" : "Afficher les contacts et groupes");
    if (open && window.matchMedia("(max-width: 720px)").matches) {
      elements.personalConversationButton.classList.remove("active");
      elements.conversations.querySelectorAll(".conversation-item.active").forEach((item) => item.classList.remove("active"));
    }
  };
  const mobileLayout = window.matchMedia("(max-width: 720px)");
  const syncResponsiveLayout = ({ matches }) => {
    if (matches && !state.current) setSidebarOpen(true);
    if (state.current) {
      refreshCurrentConversationHeader(state.current.id).catch((error) => {
        console.warn("Actualisation de l’avatar responsive impossible", error);
      });
    }
  };
  mobileLayout.addEventListener("change", syncResponsiveLayout);
  syncResponsiveLayout(mobileLayout);
  sidebarButton.onclick = () => setSidebarOpen(!elements.shell.classList.contains("sidebar-open"));
  elements.composer.addEventListener("submit", sendMessage);
  elements.file.addEventListener("change", sendFile);
  elements.voiceButton.addEventListener("click", toggleVoiceRecording);
  elements.pollButton.onclick = () => {
    try {
      openPollDialog();
    } catch (error) {
      console.error("Ouverture du sondage impossible", error);
      toast("Impossible d’ouvrir le formulaire de sondage. Rechargez l’application.", "error");
    }
  };
  elements.eventButton.addEventListener("click", () => openEventDialog());
  elements.pinnedWindowButton.addEventListener("click", () => setPinnedPanelOpen(elements.pinnedPanel.hidden));
  elements.closePinnedPanel.addEventListener("click", () => setPinnedPanelOpen(false));
  elements.calendarButton.addEventListener("click", () => openCalendar());
  elements.carnetButton.addEventListener("click", () => openCarnet());
  elements.globalFilesButton.addEventListener("click", () => openGlobalFiles());
  document.querySelector("#event-form").addEventListener("submit", submitEvent);
  document.querySelector("#event-close").addEventListener("click", closeEventDialog);
  document.querySelector("#event-cancel").addEventListener("click", closeEventDialog);
  document.querySelector("#calendar-close").addEventListener("click", () => elements.calendarDialog.close());
  document.querySelector("#carnet-close").addEventListener("click", () => elements.carnetDialog.close());
  elements.carnetDeleteAll.addEventListener("click", deleteAllCarnetEntries);
  document.querySelector("#global-files-close").addEventListener("click", () => elements.globalFilesDialog.close());
  elements.fileShareForm.addEventListener("submit", createFileShare);
  document.querySelector("#file-share-close").addEventListener("click", closeFileShareDialog);
  document.querySelector("#file-share-cancel").addEventListener("click", closeFileShareDialog);
  elements.fileShareCopy.addEventListener("click", copyFileShareLink);
  elements.fileShareRevoke.addEventListener("click", revokeFileShare);
  document.querySelector("#calendar-previous").addEventListener("click", () => changeCalendarMonth(-1));
  document.querySelector("#calendar-next").addEventListener("click", () => changeCalendarMonth(1));
  document.querySelector("#calendar-today").addEventListener("click", showCurrentCalendarMonth);
  document.querySelector("#poll-form").addEventListener("submit", submitPoll);
  elements.pollAddOption.addEventListener("click", addPollOptionInput);
  document.querySelector("#poll-close").addEventListener("click", closePollDialog);
  document.querySelector("#poll-cancel").addEventListener("click", closePollDialog);
  elements.audioCallButton.addEventListener("click", () => startCallInvite("audio"));
  elements.videoCallButton.addEventListener("click", () => startCallInvite("video"));
  elements.callBanner.addEventListener("click", (event) => {
    if (!state.call || sameID(state.call.conversationID, state.current?.id)) return;
    if (event.target.closest("button, input, canvas, audio, video")) return;
    openCallConversation();
  });
  elements.callOpenConversationButton.addEventListener("click", openCallConversation);
  elements.callAcceptButton.addEventListener("click", acceptIncomingCall);
  elements.callRejectButton.addEventListener("click", () => rejectIncomingCall("rejected"));
  elements.callMuteButton.addEventListener("click", toggleCallMicrophone);
  elements.callCameraButton.addEventListener("click", toggleCallCamera);
  elements.callFullscreenButton.addEventListener("click", enterCallFullscreen);
  elements.callAndroidExitFullscreenButton.addEventListener("click", exitCallFullscreen);
  elements.callSwitchCameraButton.addEventListener("click", switchCallCamera);
  elements.callScreenShareButton.addEventListener("click", toggleScreenShare);
  elements.callWhiteboardButton.addEventListener("click", toggleWhiteboard);
  bindWhiteboardControls();
  elements.callHangupButton.addEventListener("click", () => hangupCall("hangup"));
  window.addEventListener("pagehide", handleCallPageExit);
  window.addEventListener("beforeunload", handleCallPageExit);
  window.addEventListener("focus", refreshConversationListOnForeground);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshConversationListOnForeground();
  });
  document.addEventListener("fullscreenchange", handleCallFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleCallFullscreenChange);
  elements.voiceDraftClear.addEventListener("click", clearVoiceDraft);
  elements.replyClear.addEventListener("click", clearReplyTarget);
  bindExpirationDialog();
  elements.input.addEventListener("input", sendTyping);
  document.querySelector("#contact-search").addEventListener("input", debounce(searchContacts, 300));
  document.querySelector("#group-user-search").addEventListener("input", debounce(searchNewGroupMembers, 300));
  document.querySelector("#group-form").addEventListener("submit", createGroup);
  document.querySelector("#notification-button").onclick = async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, "Autorisation…");
    try {
      await enableNotifications((status) => {
        button.textContent = status;
      });
      toast("Notifications activées.", "success");
      await refreshNotificationStatus();
    } catch (error) {
      toast(frenchErrorMessage(error), "error");
    } finally {
      setBusy(button, false);
    }
  };
  document.querySelector("#notification-test-button").onclick = async () => {
    try {
      await syncBrowserSubscription();
      let result = await testNotification();
      if (result.failures?.some((failure) => failure.includes("Forbidden"))) {
        const button = document.querySelector("#notification-test-button");
        const originalLabel = button.textContent;
        button.disabled = true;
        try {
          await renewPushSubscription((status) => {
            button.textContent = status;
          });
          result = await testNotification();
        } finally {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
      if (result.sent > 0) {
        toast("Notification Web Push envoyée.", "success");
      } else if (result.subscriptions > 0) {
        const localShown = await showLocalTestNotification();
        const reason = pushFailureMessage(result.failures);
        toast(localShown
          ? `Abonnement enregistré, mais livraison Web Push échouée (${reason}). Un test local a été affiché.`
          : `Abonnement enregistré, mais livraison Web Push échouée (${reason}).`, "error");
      } else {
        const reason = pushFailureMessage(result.failures);
        toast(`Aucun abonnement Push enregistré pour cet appareil (${reason}). Cliquez d’abord sur Activer.`, "error");
      }
      await refreshNotificationStatus();
    } catch (error) {
      toast(frenchErrorMessage(error), "error");
    }
  };
}

function bindDialogMediaIsolation() {
  const dialogs = [...document.querySelectorAll("dialog")];
  const sync = () => {
    elements.shell.classList.toggle("modal-open", dialogs.some((dialog) => dialog.open));
  };
  const observer = new MutationObserver(sync);
  for (const dialog of dialogs) {
    observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
  sync();
}

function bindExpirationDialog() {
  const dialog = document.querySelector("#expiration-dialog");
  const form = document.querySelector("#expiration-form");
  const cancel = document.querySelector("#expiration-cancel");
  let timer;
  let openedByLongPress = false;
  const updateChoices = () => {
    for (const button of elements.expirationOptions.querySelectorAll("button[data-expiration]")) {
      const selected = Number(button.dataset.expiration) === state.messageExpirationSeconds;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-checked", String(selected));
      button.setAttribute("role", "radio");
    }
  };
  const open = () => {
    openedByLongPress = true;
    updateChoices();
    dialog.showModal();
  };
  elements.expirationOptions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-expiration]");
    if (!button) return;
    state.messageExpirationSeconds = Number(button.dataset.expiration || 0);
    updateChoices();
    updateSendButtonLabel();
  });
  elements.send.addEventListener("pointerdown", (event) => {
    if (elements.send.disabled || event.button !== 0) return;
    timer = setTimeout(open, 550);
  });
  for (const eventName of ["pointerup", "pointerleave", "pointercancel"]) {
    elements.send.addEventListener(eventName, () => clearTimeout(timer));
  }
  elements.send.addEventListener("click", (event) => {
    if (!openedByLongPress) return;
    event.preventDefault();
    event.stopPropagation();
    openedByLongPress = false;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    updateSendButtonLabel();
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    openedByLongPress = false;
  });
  cancel.addEventListener("click", () => dialog.close());
  updateSendButtonLabel();
  updateChoices();
}

function updateSendButtonLabel() {
  const labels = new Map([
    [0, "message permanent"],
    [300, "expiration 5 minutes"],
    [3600, "expiration 1 heure"],
    [86400, "expiration 1 jour"],
    [604800, "expiration 7 jours"],
  ]);
  const detail = labels.get(state.messageExpirationSeconds) || "message permanent";
  elements.send.textContent = t("Envoyer");
  elements.send.classList.toggle("has-expiration", state.messageExpirationSeconds > 0);
  elements.send.title = `Appui long : ${detail}`;
  elements.send.setAttribute("aria-label", `Envoyer, ${detail}. Appui long pour modifier l’expiration.`);
}

async function refreshRememberedKeyStatus() {
  const remembered = await hasRememberedIdentity(state.me.id);
  document.querySelector("#remembered-key-status").textContent = remembered
    ? "La clé est mémorisée et le déverrouillage sera automatique."
    : "La clé n’est pas mémorisée sur cet appareil.";
  document.querySelector("#forget-key-button").hidden = !remembered;
}

function updateIdentityLabel() {
  const identity = state.me.display_name
    ? `${state.me.display_name} · @${state.me.username}`
    : `@${state.me.username}`;
  document.querySelector("#identity-label").textContent = identity;
  for (const button of document.querySelectorAll(".brand-logo-button:not(#open-sidebar-logo)")) {
    const image = button.querySelector(".header-avatar");
    const mark = button.querySelector(".brand-mark");
    image.hidden = !state.me.avatar;
    mark.hidden = Boolean(state.me.avatar);
    if (state.me.avatar) image.src = state.me.avatar;
    else image.removeAttribute("src");
  }
}

function conversationAvatarFallback(display, conversation = null) {
  return (display?.title || (conversation?.type === "group" ? "G" : "?")).slice(0, 1).toUpperCase();
}

function renderPersonalNoteIcon(container) {
  const icon = elements.personalConversationButton.querySelector(".personal-note-avatar svg");
  container.replaceChildren(...(icon ? [icon.cloneNode(true)] : []));
}

function renderMobileNavigationAvatar(display = null, conversation = null) {
  const button = document.querySelector("#open-sidebar-logo");
  const image = button.querySelector(".header-avatar");
  const initial = button.querySelector(".header-conversation-initial");
  const fallback = display ? conversationAvatarFallback(display, conversation) : "";
  const showPersonalNote = Boolean(display && conversation?.is_personal);
  button.classList.toggle("has-conversation-avatar", Boolean(display));
  button.classList.toggle("personal-note-avatar", showPersonalNote);
  if (!display) {
    image.onerror = null;
    image.hidden = true;
    image.removeAttribute("src");
    initial.textContent = "";
    initial.hidden = true;
    return;
  }
  if (showPersonalNote) {
    image.onerror = null;
    image.hidden = true;
    image.removeAttribute("src");
    renderPersonalNoteIcon(initial);
    initial.hidden = false;
    return;
  }
  if (display.avatar) {
    image.src = display.avatar;
    image.hidden = false;
    initial.hidden = true;
    image.onerror = () => {
      if (image.getAttribute("src") !== display.avatar) return;
      image.hidden = true;
      image.removeAttribute("src");
      initial.textContent = fallback;
      initial.hidden = false;
    };
    return;
  }
  image.onerror = null;
  image.hidden = true;
  image.removeAttribute("src");
  initial.textContent = fallback;
  initial.hidden = false;
}

function replaceAvatarContent(container, avatar, fallback, trailingElements = []) {
  container.replaceChildren();
  if (avatar) {
    const image = document.createElement("img");
    image.src = avatar;
    image.alt = "";
    image.onerror = () => {
      if (container.firstElementChild !== image) return;
      replaceAvatarContent(container, null, fallback, trailingElements);
    };
    container.append(image);
  } else {
    container.textContent = fallback;
  }
  container.append(...trailingElements);
}

function conversationInstanceLabel(value) {
  if (!value) return t("Instance inconnue");
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function conversationContactAddress(username, instance) {
  const normalizedUsername = String(username || "").replace(/^@+/, "");
  const normalizedInstance = conversationInstanceLabel(instance);
  if (!normalizedUsername) return t("Non renseigné");
  if (!instance || normalizedInstance === t("Instance inconnue")) return `@${normalizedUsername}`;
  return `${normalizedUsername}@${normalizedInstance}`;
}

function identityTrustInput(identity) {
  const userID = identity?.user_id ?? identity?.contact_user_id ?? identity?.id;
  const input = {
    instanceURL: getInstanceURL(),
    userID,
    username: identity?.remote_username || identity?.username || "",
    displayName: identity?.display_name || "",
    publicKey: identity?.public_key,
  };
  if (Object.prototype.hasOwnProperty.call(identity || {}, "signing_public_key")) {
    input.signingPublicKey = identity.signing_public_key || "";
    input.signingKeyID = identity.signing_key_id || "";
  }
  return input;
}

function identityTrustLabel(identity) {
  return identity?.display_name || identity?.remote_username || identity?.username || t("ce contact");
}

function identitySecurityError(result, identity, message = "") {
  const error = new Error(message || t("La clé de sécurité de {name} a changé.", {
    name: identityTrustLabel(identity),
  }));
  error.code = "IDENTITY_KEY_CHANGED";
  error.identityTrust = result;
  error.identity = identity;
  return error;
}

function isIdentitySecurityError(error) {
  return ["IDENTITY_KEY_CHANGED", "IDENTITY_KEY_INVALID", "IDENTITY_TRUST_UNAVAILABLE"].includes(error?.code);
}

function reportIdentitySecurityError(error) {
  if (!isIdentitySecurityError(error)) return false;
  const warningID = error.identityTrust?.record?.id
    || `${getInstanceURL()}:${error.identity?.user_id ?? error.identity?.contact_user_id ?? error.identity?.id ?? "unknown"}`;
  if (!state.identityWarnings.has(warningID)) {
    state.identityWarnings.add(warningID);
    toast(error.message, "error");
  }
  return true;
}

async function updateAcceptedIdentityPublicKey(userID, publicKey, signingPublicKey = "", signingKeyID = "") {
  if (sameID(state.me?.id, userID)) Object.assign(state.me, { public_key: publicKey, signing_public_key: signingPublicKey, signing_key_id: signingKeyID });
  state.contacts = state.contacts.map((contact) => (
    sameID(contact.contact_user_id, userID) ? { ...contact, public_key: publicKey, signing_public_key: signingPublicKey, signing_key_id: signingKeyID } : contact
  ));
  for (const [conversationID, members] of state.members) {
    const updated = members.map((member) => (
      sameID(member.user_id, userID) ? { ...member, public_key: publicKey, signing_public_key: signingPublicKey, signing_key_id: signingKeyID } : member
    ));
    state.members.set(conversationID, updated);
    await state.cache?.saveMembers(conversationID, updated);
  }
  state.keys.clear();
  state.keyEnvelopes.clear();
  state.keyEnvelopeLoads.clear();
  state.preloadedMessages.clear();
}

async function confirmIdentityKeyChange(result, identity) {
  return runKeyedTask(state.identityConfirmations, result.record.id, async () => {
    const current = await getIdentityTrust(identityTrustInput(identity));
    if (current.status !== "changed") return current.record?.publicKey || null;
    const label = identityTrustLabel(identity);
    const confirmed = await actionDialog({
      title: "Clé de sécurité modifiée",
      message: t(
        "La clé de sécurité de {name} n’est plus la même. Comparez les deux empreintes avec cette personne par un autre moyen avant d’accepter.\n\nAncienne empreinte :\n{old}\n\nNouvelle empreinte :\n{next}",
        {
          name: label,
          old: formatPublicKeyFingerprint(current.record.fingerprint),
          next: formatPublicKeyFingerprint(current.record.pendingFingerprint),
        },
      ),
      confirmLabel: "Accepter la nouvelle clé",
      danger: true,
    });
    if (!confirmed) throw identitySecurityError(current, identity);
    const accepted = await acceptPendingIdentity(identityTrustInput(identity), current.record.pendingFingerprint);
    await updateAcceptedIdentityPublicKey(accepted.record.userID, accepted.record.publicKey, accepted.record.signingPublicKey, accepted.record.signingKeyID);
    state.identityWarnings.delete(accepted.record.id);
    toast(t("Nouvelle clé acceptée. Vérifiez son empreinte dès que possible."), "success");
    return accepted.record.publicKey;
  });
}

async function trustedPublicKey(identity, { interactive = false } = {}) {
  let result;
  try {
    result = await observeIdentityKey(identityTrustInput(identity));
  } catch (cause) {
    const invalidKey = cause?.message === "Clé publique invalide.";
    const error = new Error(invalidKey
      ? t("La clé de sécurité de {name} est invalide.", { name: identityTrustLabel(identity) })
      : t("Le registre local des identités est indisponible. La discussion reste bloquée."), { cause });
    error.code = invalidKey ? "IDENTITY_KEY_INVALID" : "IDENTITY_TRUST_UNAVAILABLE";
    error.identity = identity;
    throw error;
  }
  if (result.status !== "changed") {
    identity.signing_public_key = result.record.signingPublicKey || "";
    identity.signing_key_id = result.record.signingKeyID || "";
    return result.record.publicKey;
  }
  state.keys.clear();
  state.keyEnvelopes.clear();
  state.keyEnvelopeLoads.clear();
  state.preloadedMessages.clear();
  if (!interactive) throw identitySecurityError(result, identity);
  return confirmIdentityKeyChange(result, identity);
}

async function trustMembers(members, options = {}) {
  const trusted = [];
  for (const member of members || []) {
    const publicKey = await trustedPublicKey(member, options);
    trusted.push({ ...member, public_key: publicKey, signing_public_key: member.signing_public_key || "", signing_key_id: member.signing_key_id || "" });
  }
  return trusted;
}

function identityVerificationStatus(record) {
  if (!record?.verifiedAt) return t("Clé observée sur cet appareil, mais pas encore comparée.");
  return `${t("Identité vérifiée.")} ${new Date(record.verifiedAt).toLocaleString(locale)}`;
}

async function refreshOwnIdentityFingerprint() {
  const fingerprint = document.querySelector("#profile-identity-fingerprint");
  const status = document.querySelector("#profile-identity-status");
  if (!fingerprint || !status) return;
  const publicKey = await trustedPublicKey(state.me, { interactive: true });
  const trust = await getIdentityTrust({ ...identityTrustInput(state.me), publicKey });
  fingerprint.textContent = formatPublicKeyFingerprint(trust.record?.fingerprint);
  status.textContent = t("Cette empreinte identifie votre clé publique. Comparez-la avec vos correspondants par un autre moyen.");
}

async function refreshConversationIdentityTrust() {
  const identity = state.conversationInfoIdentity;
  if (!identity || !elements.conversationInfoDialog.open) return;
  const trust = await getIdentityTrust(identity);
  elements.conversationInfoFingerprint.textContent = formatPublicKeyFingerprint(trust.record?.fingerprint);
  elements.conversationInfoTrustStatus.textContent = identityVerificationStatus(trust.record);
  elements.conversationInfoVerify.hidden = Boolean(trust.record?.verifiedAt);
}

async function verifyCurrentConversationIdentity(event) {
  const identity = state.conversationInfoIdentity;
  if (!identity) return;
  const button = event.currentTarget;
  setBusy(button, true);
  try {
    const current = await getIdentityTrust(identity);
    await markIdentityVerified(identity, current.record?.fingerprint);
    await refreshConversationIdentityTrust();
    toast(t("Identité vérifiée."), "success");
  } catch (error) {
    if (!reportIdentitySecurityError(error)) toast(frenchErrorMessage(error), "error");
  } finally {
    setBusy(button, false);
  }
}

function setConversationInfoTrigger(conversation) {
  const enabled = Boolean(conversation && !conversation.is_personal && ["private", "group"].includes(conversation.type));
  const label = enabled
    ? t(conversation.type === "group" ? "Afficher les informations du groupe" : "Afficher les informations du contact")
    : "";
  elements.chatAvatar.disabled = !enabled;
  elements.chatAvatar.title = label;
  elements.chatAvatar.setAttribute("aria-label", label);
  elements.chatIdentity.classList.toggle("conversation-info-trigger", enabled);
  if (enabled) {
    elements.chatIdentity.setAttribute("role", "button");
    elements.chatIdentity.setAttribute("tabindex", "0");
    elements.chatIdentity.setAttribute("aria-haspopup", "dialog");
    elements.chatIdentity.setAttribute("aria-controls", "conversation-info-dialog");
    elements.chatIdentity.setAttribute("aria-label", label);
  } else {
    for (const attribute of ["role", "tabindex", "aria-haspopup", "aria-controls", "aria-label"]) {
      elements.chatIdentity.removeAttribute(attribute);
    }
  }
}

function renderConversationInfoMembers(members) {
  const sortedMembers = [...(members || [])].sort((left, right) => {
    const roleOrder = (member) => member.role === "owner" ? 0 : member.role === "pending" ? 2 : 1;
    const roleDifference = roleOrder(left) - roleOrder(right);
    if (roleDifference) return roleDifference;
    const leftName = left.display_name || left.remote_username || left.username || "";
    const rightName = right.display_name || right.remote_username || right.username || "";
    return leftName.localeCompare(rightName, locale, { sensitivity: "base" });
  });
  elements.conversationInfoMembersCount.textContent = String(sortedMembers.length);
  elements.conversationInfoMembers.replaceChildren();

  for (const member of sortedMembers) {
    const item = document.createElement("li");
    item.className = "conversation-info-member";

    const avatar = document.createElement("span");
    avatar.className = "conversation-info-member-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const displayName = member.display_name || member.remote_username || member.username || t("Non renseigné");
    replaceAvatarContent(avatar, member.avatar, displayName.slice(0, 1).toUpperCase());

    const identity = document.createElement("span");
    identity.className = "conversation-info-member-identity";
    const name = document.createElement("strong");
    name.textContent = displayName;
    const username = member.remote_username || member.username || "";
    const address = document.createElement("small");
    address.textContent = member.is_remote
      ? conversationContactAddress(username, member.federation_instance_url)
      : (username ? `@${String(username).replace(/^@+/, "")}` : t("Non renseigné"));
    identity.append(name, address);

    const statuses = document.createElement("span");
    statuses.className = "conversation-info-member-statuses";
    const statusLabels = [];
    if (member.role === "owner") statusLabels.push(t("Propriétaire"));
    if (member.role === "pending") statusLabels.push(t("Invitation en attente"));
    if (sameID(member.user_id, state.me.id)) statusLabels.push(t("Vous"));
    for (const label of statusLabels) {
      const status = document.createElement("small");
      status.className = "conversation-info-member-status";
      status.textContent = label;
      statuses.append(status);
    }

    item.append(avatar, identity, statuses);
    elements.conversationInfoMembers.append(item);
  }
}

async function openCurrentConversationInfo() {
  const conversation = state.current;
  if (!conversation || conversation.is_personal || !["private", "group"].includes(conversation.type)) return;
  const isGroup = conversation.type === "group";
  state.conversationInfoIdentity = null;
  elements.conversationInfoTitle.textContent = t(isGroup ? "Informations du groupe" : "Informations du contact");
  elements.conversationInfoKind.textContent = t(isGroup ? "Groupe" : "Contact");
  elements.conversationInfoName.textContent = t("Chargement…");
  elements.conversationInfoNameLabel.textContent = t(isGroup ? "Nom du groupe" : "Nom affiché");
  elements.conversationInfoDisplayName.textContent = "—";
  elements.conversationInfoUsernameRow.hidden = isGroup;
  elements.conversationInfoAddressRow.hidden = isGroup;
  elements.conversationInfoUsername.textContent = "—";
  elements.conversationInfoAddress.textContent = "—";
  elements.conversationInfoInstance.textContent = "—";
  elements.conversationInfoDescription.textContent = "—";
  elements.conversationInfoFingerprintRow.hidden = isGroup;
  elements.conversationInfoFingerprint.textContent = "—";
  elements.conversationInfoTrustStatus.textContent = "";
  elements.conversationInfoVerify.hidden = true;
  elements.conversationInfoMembersSection.hidden = !isGroup;
  elements.conversationInfoMembersCount.textContent = "0";
  elements.conversationInfoMembers.replaceChildren();
  replaceAvatarContent(elements.conversationInfoAvatar, null, isGroup ? "G" : "?");
  if (!elements.conversationInfoDialog.open) elements.conversationInfoDialog.showModal();
  elements.conversationInfoTitle.setAttribute("tabindex", "-1");
  elements.conversationInfoTitle.focus({ preventScroll: true });

  const members = await getMembers(conversation.id, { fresh: true, interactive: true });
  const display = await resolveConversationDisplay(conversation);
  if (!elements.conversationInfoDialog.open) return;
  const peer = isGroup ? null : members.find((member) => member.user_id !== state.me.id);
  if (!isGroup && !peer) throw new Error("Participant introuvable.");
  const displayName = isGroup
    ? display.title
    : peer?.display_name || peer?.username || display.title;
  const username = peer?.remote_username || peer?.username || conversation.remote_username || "";
  const instance = peer?.federation_instance_url
    || conversation.federation_instance_url
    || getInstanceURL();
  const description = isGroup
    ? (conversation.encrypted_description ? display.description : "")
    : peer?.description || "";
  elements.conversationInfoName.textContent = displayName;
  elements.conversationInfoDisplayName.textContent = displayName;
  elements.conversationInfoUsername.textContent = username
    ? (username.startsWith("@") ? username : `@${username}`)
    : t("Non renseigné");
  elements.conversationInfoAddress.textContent = conversationContactAddress(username, instance);
  elements.conversationInfoInstance.textContent = conversationInstanceLabel(instance);
  elements.conversationInfoInstance.title = instance || "";
  elements.conversationInfoDescription.textContent = description || t("Aucune description.");
  replaceAvatarContent(
    elements.conversationInfoAvatar,
    display.avatar,
    conversationAvatarFallback(display, conversation),
  );
  if (isGroup) renderConversationInfoMembers(members);
  if (peer) {
    state.conversationInfoIdentity = identityTrustInput(peer);
    await refreshConversationIdentityTrust();
  }
}

function renderConversationHeader(conversation, display) {
  elements.title.textContent = display.title;
  elements.description.textContent = display.description || t(
    conversation.is_personal ? "Messages et fichiers personnels" : conversation.type === "group" ? "Groupe" : "Contact",
  );
  elements.chatAvatar.hidden = false;
  elements.chatAvatar.classList.toggle("personal-note-avatar", Boolean(conversation.is_personal));
  if (conversation.is_personal) {
    renderPersonalNoteIcon(elements.chatAvatar);
  } else {
    replaceAvatarContent(
      elements.chatAvatar,
      display.avatar,
      conversationAvatarFallback(display, conversation),
    );
  }
  renderMobileNavigationAvatar(display, conversation);
  setConversationInfoTrigger(conversation);
}

async function refreshCurrentConversationHeader(expectedID = state.current?.id) {
  if (expectedID == null || !sameID(state.current?.id, expectedID)) return;
  const refreshed = state.conversations.find((conversation) => sameID(conversation.id, expectedID));
  if (refreshed) state.current = refreshed;
  const current = refreshed || state.current;
  const display = await resolveConversationDisplay(current);
  if (!sameID(state.current?.id, expectedID)) return;
  renderConversationHeader(current, display);
}

function syncCurrentUserProfileDisplay() {
  const fallback = (state.me.username || "?").slice(0, 1).toUpperCase();
  for (const [conversationID, members] of state.members) {
    state.members.set(conversationID, members.map((member) => (
      member.user_id === state.me.id
        ? {
            ...member,
            username: state.me.username,
            display_name: state.me.display_name,
            description: state.me.description || "",
            avatar: state.me.avatar || null,
          }
        : member
    )));
  }
  elements.messages.querySelectorAll(".message-row.mine .message-avatar").forEach((avatar) => {
    replaceAvatarContent(avatar, state.me.avatar, fallback);
  });
}

function messageWithCurrentUserProfile(message) {
  if (message.sender_id !== state.me.id) return message;
  return {
    ...message,
    sender_username: state.me.username,
    sender_avatar: state.me.avatar || null,
  };
}

function updateProfileAvatarPreview() {
  const preview = document.querySelector("#profile-avatar-preview");
  preview.src = profileAvatar || "/icons/person.svg";
  document.querySelector("#profile-avatar-remove").hidden = !profileAvatar;
}

function updateGroupAvatarPreview() {
  renderGroupAvatarPreview(document.querySelector("#group-avatar-preview"), groupAvatar);
  document.querySelector("#group-avatar-remove").hidden = !groupAvatar;
}

function renderGroupAvatarPreview(container, avatar) {
  container.replaceChildren();
  if (avatar) {
    const image = document.createElement("img");
    image.src = avatar;
    image.alt = "";
    container.append(image);
    return;
  }
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.classList.add("group-avatar-preview-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag, attributes) => {
    const element = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    svg.append(element);
  };
  shape("circle", { cx: "9", cy: "8", r: "3" });
  shape("circle", { cx: "16.5", cy: "9.5", r: "2.5" });
  shape("path", { d: "M3.5 20a5.5 5.5 0 0 1 11 0M13 20a4.5 4.5 0 0 1 8 0" });
  container.append(svg);
}

async function resizeAvatar(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Sélectionnez une image PNG, JPEG ou WebP.");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("L’image source dépasse 8 Mo.");
  }
  const sourceURL = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error("Impossible de lire cette image."));
      candidate.src = sourceURL;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - side) / 2;
    const sourceY = (image.naturalHeight - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 256, 256);
    context.drawImage(image, sourceX, sourceY, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/jpeg", 0.84);
  } finally {
    URL.revokeObjectURL(sourceURL);
  }
}

async function rotateRecoveryCode(event) {
  const button = event.currentTarget;
  const status = document.querySelector("#recovery-code-status");
  const password = prompt("Mot de passe actuel :");
  if (password === null) return;
  if (!password) {
    status.textContent = "Le mot de passe actuel est requis.";
    return;
  }
  setBusy(button, true, "Génération…");
  status.textContent = "";
  try {
    const result = await api("/api/me/recovery-code", {
      method: "POST",
      body: { password },
    });
    alert(`Nouveau code de récupération : ${result.recovery_code}`);
    status.textContent = "Nouveau code généré. L’ancien code n’est plus valide.";
  } catch (error) {
    status.textContent = frenchErrorMessage(error);
  } finally {
    setBusy(button, false);
  }
}

async function updateProfile(event) {
  event.preventDefault();
  const errorRegion = document.querySelector("#profile-error");
  const saveButton = document.querySelector("#profile-save");
  const username = document.querySelector("#profile-username").value.trim().toLowerCase();
  const displayName = document.querySelector("#profile-display-name").value.trim();
  const description = document.querySelector("#profile-description").value.trim();
  const currentInstanceURL = getInstanceURL();
  let nextInstanceURL;
  const currentPassword = document.querySelector("#profile-current-password").value;
  const newPassword = document.querySelector("#profile-new-password").value;
  const confirmation = document.querySelector("#profile-confirm-password").value;
  errorRegion.textContent = "";

  if (newPassword !== confirmation) {
    errorRegion.textContent = "Les nouveaux mots de passe diffèrent.";
    return;
  }
  if ((newPassword || username !== state.me.username) && !currentPassword) {
    errorRegion.textContent = "Saisissez votre mot de passe actuel pour modifier l’identifiant ou le mot de passe.";
    return;
  }
  try {
    nextInstanceURL = normalizeInstanceURL(document.querySelector("#profile-instance-url").value);
  } catch (error) {
    errorRegion.textContent = frenchErrorMessage(error);
    return;
  }
  const profileChanged = username !== state.me.username
    || displayName !== state.me.display_name
    || description !== (state.me.description || "")
    || profileAvatar !== (state.me.avatar || null)
    || Boolean(newPassword);
  if (!profileChanged && nextInstanceURL !== currentInstanceURL) {
    switchInstance(nextInstanceURL);
    return;
  }

  setBusy(saveButton, true, "Enregistrement…");
  try {
    const updated = await api("/api/me", {
      method: "PUT",
      body: {
        username,
        display_name: displayName,
        description,
        current_password: currentPassword,
        new_password: newPassword,
        avatar: profileAvatar,
      },
    });
    state.me = { ...state.me, ...updated };
    updateIdentityLabel();
    syncCurrentUserProfileDisplay();
    document.querySelector("#profile-current-password").value = "";
    document.querySelector("#profile-new-password").value = "";
    document.querySelector("#profile-confirm-password").value = "";
    if (nextInstanceURL !== currentInstanceURL) {
      switchInstance(nextInstanceURL);
      return;
    }
    toast("Profil mis à jour.", "success");
  } catch (error) {
    errorRegion.textContent = error.status === 401
      ? "Le mot de passe actuel est incorrect."
      : frenchErrorMessage(error);
  } finally {
    setBusy(saveButton, false);
  }
}

function switchInstance(instanceURL) {
  setInstanceURL(instanceURL);
  clearSessionToken();
  localStorage.removeItem(CALENDAR_FEED_TOKEN_KEY);
  sessionStorage.removeItem("crypto_phrase");
  state.socket?.close();
  toast("Instance modifiée. Reconnexion nécessaire.", "success");
  setTimeout(() => { location.href = "/login.html"; }, 600);
}

function sharedCalendarFeedURL(token) {
  return new URL(`/api/calendar-feed/${encodeURIComponent(token)}/calendar.ics`, `${getInstanceURL() || location.origin}/`).toString();
}

function renderSharedCalendarFeedState(feed, token = localStorage.getItem(CALENDAR_FEED_TOKEN_KEY) || "") {
  const input = document.querySelector("#profile-calendar-url");
  const copy = document.querySelector("#profile-calendar-copy");
  const revoke = document.querySelector("#profile-calendar-revoke");
  const status = document.querySelector("#profile-calendar-status");
  const link = feed?.active && token ? sharedCalendarFeedURL(token) : "";
  input.value = link;
  copy.disabled = !link;
  revoke.disabled = !feed?.active;
  status.textContent = !feed?.active
    ? t("Aucun flux partagé actif.")
    : link
      ? t("Flux calendrier actif et publié sur le serveur.")
      : t("Flux actif, mais son adresse n’est pas disponible sur cet appareil. Créez un nouveau flux pour obtenir une adresse.");
}

async function loadSharedCalendarFeedState() {
  try {
    const feeds = await api("/api/calendar/feeds");
    const active = feeds.find((feed) => feed.active) || null;
    state.sharedCalendarFeedID = active?.id || null;
    renderSharedCalendarFeedState(active);
    return active;
  } catch (error) {
    state.sharedCalendarFeedID = null;
    document.querySelector("#profile-calendar-status").textContent = frenchErrorMessage(error, "Impossible de consulter le flux calendrier.");
    return null;
  }
}

async function createSharedCalendarFeed() {
  const button = document.querySelector("#profile-calendar-create");
  const passwordInput = document.querySelector("#profile-calendar-password");
  const password = passwordInput.value;
  if (!password) {
    document.querySelector("#profile-calendar-status").textContent = t("Le mot de passe du compte est requis.");
    passwordInput.focus();
    return;
  }
  setBusy(button, true, t("Publication…"));
  try {
    const items = await loadCalendarItems();
    const exportable = items.filter((item) => item.decrypted && item.clear?.type === "event");
    const result = await api("/api/calendar/feeds", {
      method: "POST",
      body: { password, snapshot: buildCalendarICalendar(exportable) },
    });
    state.sharedCalendarFeedID = result.id;
    localStorage.setItem(CALENDAR_FEED_TOKEN_KEY, result.token);
    passwordInput.value = "";
    renderSharedCalendarFeedState({ active: true }, result.token);
    toast(t("Flux calendrier créé et publié."), "success");
  } catch (error) {
    document.querySelector("#profile-calendar-status").textContent = frenchErrorMessage(error, "Impossible de créer le flux calendrier.");
  } finally {
    setBusy(button, false);
  }
}

async function syncSharedCalendarFeed() {
  const feeds = await api("/api/calendar/feeds");
  const active = feeds.find((feed) => feed.active);
  if (!active) {
    state.sharedCalendarFeedID = null;
    return false;
  }
  const items = await loadCalendarItems();
  if (items.some((item) => !item.decrypted)) return false;
  await api(`/api/calendar/feeds/${active.id}`, {
    method: "PUT",
    body: { snapshot: buildCalendarICalendar(items) },
  });
  state.sharedCalendarFeedID = active.id;
  return true;
}

async function revokeSharedCalendarFeed() {
  if (!state.sharedCalendarFeedID) {
    await loadSharedCalendarFeedState();
  }
  if (!state.sharedCalendarFeedID) return;
  const button = document.querySelector("#profile-calendar-revoke");
  setBusy(button, true, t("Révocation…"));
  try {
    await api(`/api/calendar/feeds/${state.sharedCalendarFeedID}`, { method: "DELETE" });
    state.sharedCalendarFeedID = null;
    localStorage.removeItem(CALENDAR_FEED_TOKEN_KEY);
    renderSharedCalendarFeedState(null);
    toast(t("Flux calendrier révoqué."), "success");
  } catch (error) {
    document.querySelector("#profile-calendar-status").textContent = frenchErrorMessage(error, "Impossible de révoquer le flux calendrier.");
  } finally {
    setBusy(button, false);
    button.disabled = !state.sharedCalendarFeedID;
  }
}

async function copyCalendarFeedURL() {
  const input = document.querySelector("#profile-calendar-url");
  const link = input.value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    input.focus();
    input.select();
    if (!document.execCommand("copy")) {
      toast(t("Sélectionnez puis copiez l’adresse manuellement."), "error");
      return;
    }
  }
  toast(t("Adresse du calendrier copiée."), "success");
}

async function exportCalendarICalendar() {
  const button = document.querySelector("#profile-calendar-export");
  setBusy(button, true, t("Exportation…"));
  try {
    const items = await loadCalendarItems();
    state.calendarItems = items;
    const exportable = items.filter((item) => item.decrypted && item.clear?.type === "event");
    if (!exportable.length) {
      toast(t("Aucun évènement déchiffrable à exporter."), "error");
      return;
    }
    const ical = buildCalendarICalendar(exportable);
    const blob = new Blob([ical], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vibration-calendar-${new Date().toISOString().slice(0, 10)}.ics`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t("{count} évènements exportés.", { count: exportable.length }), "success");
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible d’exporter le calendrier."), "error");
  } finally {
    setBusy(button, false);
  }
}

function buildCalendarICalendar(items) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vibration//Local calendar export//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icalEscape(t("Calendrier Vibration"))}`,
  ];
  for (const item of items) {
    const start = formatICalendarDate(item.message.event.starts_at);
    const end = formatICalendarDate(item.message.event.ends_at);
    const stamp = formatICalendarDate(item.message.updated_at || item.message.created_at) || formatICalendarDate(new Date());
    if (!start || !end || !stamp) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${calendarEventUID(item.message)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `LAST-MODIFIED:${stamp}`,
      `SUMMARY:${icalEscape(item.clear.name)}`,
    );
    if (item.clear.description) lines.push(`DESCRIPTION:${icalEscape(item.clear.description)}`);
    if (item.clear.location) lines.push(`LOCATION:${icalEscape(item.clear.location)}`);
    lines.push("STATUS:CONFIRMED", "SEQUENCE:0", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(foldICalendarLine).join("\r\n") + "\r\n";
}

function calendarEventUID(message) {
  let host = "vibration";
  try {
    host = new URL(getInstanceURL() || location.origin).host || host;
  } catch {}
  return `vibration-event-${message.id}@${host}`;
}

function formatICalendarDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icalEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/([;,])/g, "\\$1");
}

function foldICalendarLine(line) {
  const characters = Array.from(String(line));
  const encoder = new TextEncoder();
  const result = [];
  let chunk = "";
  let first = true;
  let limit = 75;
  for (const character of characters) {
    if (chunk && encoder.encode(chunk + character).length > limit) {
      result.push(first ? chunk : ` ${chunk}`);
      first = false;
      limit = 74;
      chunk = "";
    }
    chunk += character;
  }
  result.push(first ? chunk : ` ${chunk}`);
  return result;
}

async function refreshNotificationStatus() {
  const label = document.querySelector("#notification-status");
  const button = document.querySelector("#notification-button");
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      await syncBrowserSubscription();
    }
    const status = await notificationStatus();
    if (status.supportIssue === "insecure_context") {
      label.textContent = t("Notifications Push Android indisponibles hors HTTPS");
      button.textContent = t("HTTPS requis");
      button.disabled = true;
    } else if (status.mode === "native" && status.nativeGranted && !status.pushSupported) {
      label.textContent = t("Notifications natives seulement, indisponibles si l’application est arrêtée");
      button.textContent = t("Web Push indisponible");
      button.disabled = true;
    } else if (status.permission === "unsupported") {
      label.textContent = t("Notifications non prises en charge par ce navigateur");
      button.textContent = t("Notifications indisponibles");
      button.disabled = true;
    } else if (status.permission === "denied") {
      label.textContent = t("Notifications bloquées par le navigateur");
      button.textContent = t("Notifications bloquées");
      button.disabled = false;
    } else if (status.browserSubscription && status.currentDeviceServerSubscription) {
      label.textContent = t("Notifications activées");
      button.textContent = t("Réactiver les notifications");
      button.disabled = false;
    } else if (status.browserSubscription && status.serverSubscriptions > 0) {
      label.textContent = t("Abonnement de cet appareil non enregistré sur le serveur");
      button.textContent = t("Réactiver les notifications");
      button.disabled = false;
    } else if (status.permission === "granted") {
      label.textContent = t("Permission accordée, abonnement incomplet");
      button.textContent = t("Réactiver les notifications");
      button.disabled = false;
    } else {
      label.textContent = t("Notifications désactivées");
      button.textContent = t("Activer les notifications");
      button.disabled = false;
    }
  } catch {
    label.textContent = t("État des notifications indisponible");
  }
}

function connectSocket() {
  state.socket = new ChatSocket();
  document.querySelector("#ws-dot").classList.remove("online");
  document.querySelector("#ws-label").textContent = t("Connexion…");
  state.socket.addEventListener("status", ({ detail }) => {
    document.querySelector("#ws-dot").classList.toggle("online", detail);
    document.querySelector("#ws-label").textContent = t(detail ? "Connecté" : "Reconnexion…");
    if (detail) {
      clearCallSignalLossTimer();
      resumePendingCallIceRestarts();
      if (appReady && state.conversations.length) {
        refreshConversationList().catch(() => {});
        if (state.current) loadMessages(null, false).catch(() => {});
      }
    } else {
      state.onlineUsers.clear();
      if (appReady) renderConversations().catch(() => {});
      scheduleCallInterruptForSignalLoss();
    }
    updateCallButtons();
  });
  state.socket.addEventListener("event", ({ detail }) => handleSocketEvent(detail));
  state.socket.connect();
}

let adminNavigationPending = false;

function prepareAdminNavigation(event) {
  const nonPrimaryClick = typeof event.button === "number" && event.button !== 0;
  if (event.defaultPrevented || nonPrimaryClick || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  adminNavigationPending = true;
  try {
    sessionStorage.setItem(ADMIN_RETURN_HISTORY_KEY, location.href);
  } catch (error) {
    console.warn("Mémorisation du retour depuis l’administration impossible", error);
  }
}

function finishAdminNavigation() {
  if (!adminNavigationPending) return;
  adminNavigationPending = false;
  try {
    handleCallPageExit();
    clearConversationSelectionForAdmin();
    state.socket?.close();
    window.removeEventListener("beforeunload", handleCallPageExit);
  } catch (error) {
    console.warn("Préparation de la page d’administration incomplète", error);
  }
}

function clearConversationSelectionForAdmin() {
  const currentConversationID = state.current?.id;
  if (currentConversationID != null) closeCurrentConversation(currentConversationID);
  elements.personalConversationButton.classList.remove("active");
  elements.conversations.querySelectorAll(".conversation-item.active").forEach((item) => item.classList.remove("active"));
}

function restoreChatFromHistory(event) {
  if (!event.persisted || !sessionStorage.getItem(ADMIN_RETURN_HISTORY_KEY)) return;
  sessionStorage.removeItem(ADMIN_RETURN_HISTORY_KEY);
  callPageExitHandled = false;
  window.addEventListener("beforeunload", handleCallPageExit);
  if (!state.socket || state.socket.closed) connectSocket();
  refreshConversationListOnForeground();
}

function conversationPreloadKey(conversationID) {
  return String(conversationID);
}

function conversationPreloadVersion(conversationID) {
  return state.conversationPreloadVersions.get(conversationPreloadKey(conversationID)) || 0;
}

function invalidateConversationPreload(conversationID) {
  const key = conversationPreloadKey(conversationID);
  state.conversationPreloadVersions.set(key, conversationPreloadVersion(conversationID) + 1);
  state.preloadedMessages.delete(key);
}

function updateConversationPreloadReceipt(event) {
  const key = conversationPreloadKey(event.conversation_id);
  const prepared = state.preloadedMessages.get(key);
  if (!prepared) {
    if (state.conversationPreloads.has(key)) invalidateConversationPreload(event.conversation_id);
    return;
  }
  const message = prepared.messages.find((item) => sameID(item.id, event.message_id));
  if (!message) return;
  if (event.type === "message_read") message.status = "read";
  else if (message.status !== "read") message.status = "delivered";
}

function preparedConversationMessages(conversation) {
  const key = conversationPreloadKey(conversation.id);
  const prepared = state.preloadedMessages.get(key);
  if (!prepared) return null;
  const currentVersion = conversationPreloadVersion(conversation.id);
  const sameLastMessage = String(prepared.lastMessageAt || "") === String(conversation.last_message_at || "");
  if (prepared.version !== currentVersion || !sameLastMessage || Date.now() - prepared.loadedAt > BACKGROUND_PRELOAD_TTL_MS) {
    state.preloadedMessages.delete(key);
    return null;
  }
  return prepared;
}

function backgroundConversationCandidates(conversations) {
  return conversations
    .map((conversation, position) => ({ conversation, position }))
    .filter(({ conversation }) => conversation.role !== "pending" && !sameID(conversation.id, state.current?.id))
    .sort((left, right) => {
      const unread = Number(Boolean(right.conversation.unread_count)) - Number(Boolean(left.conversation.unread_count));
      if (unread) return unread;
      const favorite = Number(Boolean(right.conversation.favorite_at)) - Number(Boolean(left.conversation.favorite_at));
      if (favorite) return favorite;
      const recent = Date.parse(right.conversation.last_message_at || 0) - Date.parse(left.conversation.last_message_at || 0);
      return recent || left.position - right.position;
    })
    .slice(0, BACKGROUND_CONVERSATION_PRELOAD_LIMIT)
    .map(({ conversation }) => conversation);
}

async function runBackgroundTasks(tasks, concurrency) {
  let nextTask = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask++];
      try {
        await task();
      } catch (error) {
        console.warn("Préchargement d’une discussion impossible", error);
      }
    }
  });
  await Promise.all(workers);
}

function pumpBackgroundThumbnailQueue() {
  while (activeBackgroundThumbnailPreloads < BACKGROUND_THUMBNAIL_PRELOAD_CONCURRENCY && backgroundThumbnailQueue.length) {
    const task = backgroundThumbnailQueue.shift();
    activeBackgroundThumbnailPreloads++;
    Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        activeBackgroundThumbnailPreloads--;
        pumpBackgroundThumbnailQueue();
      });
  }
}

function queueBackgroundThumbnailPreload(task) {
  backgroundThumbnailQueue.push(task);
  pumpBackgroundThumbnailQueue();
}

function preloadFileThumbnailPayload(message, session) {
  if (!state.cache || message.file?.has_preview !== true) return Promise.resolve();
  const fileKey = String(message.file.id);
  const pending = state.fileThumbnailPayloadPreloads.get(fileKey);
  if (pending) return pending;
  const preload = (async () => {
    try {
      const cached = await state.cache.getFilePreview(message.file.id);
      if (cached) return;
      const previewSize = Number(message.file.preview_size) || FILE_PREVIEW_MAX_BYTES;
      if (previewSize <= 0 || previewSize > FILE_PREVIEW_MAX_BYTES + 64 || previewSize > session.remainingThumbnailBytes) return;
      session.remainingThumbnailBytes -= previewSize;
      const payload = await api(`/api/files/${message.file.id}/preview`);
      const payloadSize = Number(payload.size) || previewSize;
      if (payloadSize <= 0 || payloadSize > FILE_PREVIEW_MAX_BYTES + 64) return;
      await state.cache.saveFilePreview(message.file.id, payload);
    } finally {
      state.fileThumbnailPayloadPreloads.delete(fileKey);
    }
  })();
  state.fileThumbnailPayloadPreloads.set(fileKey, preload);
  return preload;
}

function queueConversationThumbnailPreloads(messages, session) {
  for (const message of [...messages].reverse()) {
    if (message.file?.has_preview !== true) continue;
    queueBackgroundThumbnailPreload(() => preloadFileThumbnailPayload(message, session));
  }
}

function preloadConversationInBackground(conversation, session) {
  const key = conversationPreloadKey(conversation.id);
  const prepared = preparedConversationMessages(conversation);
  if (prepared) return Promise.resolve(prepared);
  const pending = state.conversationPreloads.get(key);
  if (pending) return pending;
  const version = conversationPreloadVersion(conversation.id);
  const preload = (async () => {
    try {
      const messages = await api(`/api/conversations/${conversation.id}/messages?limit=50`);
      await state.cache?.putMessages(messages);
      const keyedMessages = await Promise.all(messages.map(async (message) => ({
        message,
        key: await getMessageKey(message, conversation),
      })));
      const decrypted = await Promise.all(keyedMessages.map(async ({ message, key }) => ({
        message,
        key,
        clear: await decryptMessageContent(message, key),
      })));
      if (conversationPreloadVersion(conversation.id) !== version) return null;
      const result = {
        messages,
        decrypted,
        loadedAt: Date.now(),
        lastMessageAt: conversation.last_message_at || "",
        version,
      };
      state.preloadedMessages.set(key, result);
      queueConversationThumbnailPreloads(messages, session);
      return result;
    } finally {
      state.conversationPreloads.delete(key);
    }
  })();
  state.conversationPreloads.set(key, preload);
  return preload;
}

function scheduleBackgroundConversationPreloads(conversations = state.conversations) {
  const candidates = backgroundConversationCandidates(conversations);
  const candidateKeys = new Set(candidates.map((conversation) => conversationPreloadKey(conversation.id)));
  for (const key of state.preloadedMessages.keys()) {
    if (!candidateKeys.has(key)) state.preloadedMessages.delete(key);
  }
  if (!candidates.length) return Promise.resolve();
  const session = { remainingThumbnailBytes: BACKGROUND_THUMBNAIL_PRELOAD_BUDGET_BYTES };
  const tasks = candidates.map((conversation) => () => preloadConversationInBackground(conversation, session));
  return runBackgroundTasks(tasks, BACKGROUND_CONVERSATION_PRELOAD_CONCURRENCY);
}

function dismissStartupSplash() {
  document.documentElement.classList.remove("ios-pwa-starting", "ios-pwa-splash-positioned");
  window.ChatTheme?.refresh();
  document.querySelector("#startup-splash")?.setAttribute("hidden", "");
}

async function refreshAll() {
  const cachedConversations = !state.conversations.length
    ? await state.cache?.getConversations()
    : null;
  if (cachedConversations?.length) {
    state.conversations = cachedConversations;
    state.members.clear();
    await renderConversations();
  }
  try {
    let [contacts, conversations, carnetEntries] = await Promise.all([
      api("/api/contacts"),
      api("/api/conversations"),
      api("/api/carnet"),
    ]);
    if (!conversations.some((conversation) => conversation.is_personal)) {
      await api("/api/conversations/personal", { method: "POST" });
      conversations = await api("/api/conversations");
    }
    state.contacts = contacts;
    state.carnet = carnetEntries;
    state.conversations = conversations;
    state.members.clear();
    state.cache?.saveConversations(conversations);
    await renderConversations({ freshMembers: true });
    const preload = scheduleBackgroundConversationPreloads(conversations);
    if (document.documentElement.classList.contains("ios-pwa-starting")) await preload;
    dismissStartupSplash();
    syncSharedCalendarFeed().catch(() => {});
  } catch (error) {
    if (!cachedConversations?.length) throw error;
    state.conversations = cachedConversations;
    state.members.clear();
    await renderConversations();
    const preload = scheduleBackgroundConversationPreloads(cachedConversations);
    if (document.documentElement.classList.contains("ios-pwa-starting")) await preload;
    dismissStartupSplash();
  }
}

async function refreshConversationList() {
  const [conversations, carnetEntries] = await Promise.all([api("/api/conversations"), api("/api/carnet")]);
  state.conversations = conversations;
  state.carnet = carnetEntries;
  state.cache?.saveConversations(state.conversations);
  await renderConversations({ freshMembers: true });
  void scheduleBackgroundConversationPreloads(state.conversations);
}

async function toggleConversationFavorite(conversation, button) {
  const favorite = !conversation.favorite_at;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await api(`/api/conversations/${conversation.id}/favorite`, {
      method: "PATCH",
      body: { favorite },
    });
    conversation.favorite_at = result.favorite_at;
    await refreshConversationList();
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de modifier ce favori."), "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function refreshConversationListOnForeground() {
  if (!state.me || !appReady) return;
  refreshConversationList().catch((error) => {
    console.warn("Actualisation des conversations au retour impossible", error);
  });
  if (state.current) loadMessages(null, false).catch(() => {});
}

function conversationCallState(conversation) {
  if (!state.call || !sameID(state.call.conversationID, conversation.id)) return null;
  const incoming = state.call.direction === "incoming" && state.call.status === "ringing";
  const outgoing = state.call.direction === "outgoing" && state.call.status === "ringing";
  return {
    incoming,
    outgoing,
    media: state.call.media,
  };
}

function refreshConversationCallIndicators() {
  if (!state.me || !appReady) return;
  renderConversations().catch((error) => {
    console.warn("Actualisation de l’indicateur d’appel impossible", error);
  });
}

function conversationListActiveID() {
  const mobileSidebarOpen = window.matchMedia("(max-width: 720px)").matches
    && elements.shell.classList.contains("sidebar-open");
  return mobileSidebarOpen ? null : state.current?.id;
}

function keepConversationSelectedDuringMobileTransition(button) {
  if (!window.matchMedia("(max-width: 720px)").matches) return;
  elements.personalConversationButton.classList.remove("active");
  elements.conversations.querySelectorAll(".conversation-item.active").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
}

async function renderPersonalConversation(isCurrentRender = () => true) {
  const conversation = state.conversations.find((item) => item.is_personal);
  if (!conversation) {
    if (isCurrentRender()) elements.personalConversationButton.hidden = true;
    return;
  }
  const unreadCount = Number(conversation.unread_count || 0);
  let preview;
  try {
    preview = await conversationListPreview(conversation, {
      description: t("Messages et fichiers personnels"),
    });
  } catch {
    preview = t("Messages et fichiers personnels");
  }
  if (!isCurrentRender()) return;
  elements.personalConversationButton.hidden = false;
  elements.personalConversationButton.classList.toggle("active", sameID(conversationListActiveID(), conversation.id));
  elements.personalConversationUnread.hidden = unreadCount === 0;
  elements.personalConversationUnread.textContent = unreadCount > 99 ? "99+" : String(unreadCount || "");
  elements.personalConversationUnread.setAttribute("aria-label", t(
    unreadCount === 1 ? "{count} message non lu" : "{count} messages non lus",
    { count: unreadCount },
  ));
  elements.personalConversationPreview.textContent = preview;
}

async function renderConversations({ freshMembers = false } = {}) {
  const renderVersion = ++conversationRenderVersion;
  const isCurrentRender = () => renderVersion === conversationRenderVersion;
  await renderPersonalConversation(isCurrentRender);
  if (!isCurrentRender()) return;
  const pendingContacts = state.contacts.filter((contact) => contact.status === "pending");
  const listedConversations = state.conversations.filter((conversation) => !conversation.is_personal);
  const displays = await Promise.all(listedConversations.map(async (conversation) => {
    try {
      return await resolveConversationDisplay(conversation, { freshMembers });
    } catch (error) {
      error.conversationID = conversation.id;
      if (reportIdentitySecurityError(error)) {
        return {
          title: conversation.type === "group" ? t("Groupe") : identityTrustLabel(error.identity),
          description: t("Vérification de sécurité requise"),
          avatar: conversation.type === "group" ? null : error.identity?.avatar || null,
          securityBlocked: true,
        };
      }
      return null;
    }
  }));
  if (!isCurrentRender()) return;
  const details = await Promise.all(listedConversations.map(async (conversation, index) => {
    const display = displays[index];
    const callState = conversationCallState(conversation);
    const [typing, online] = await Promise.all([
      typingIndicator(conversation).catch(() => null),
      conversationOnline(conversation).catch(() => false),
    ]);
    let preview = "";
    if (display && !display.securityBlocked && !typing && !callState) {
      preview = await conversationListPreview(conversation, display).catch(() => "");
    } else if (display?.securityBlocked) {
      preview = display.description;
    }
    return { conversation, display, callState, typing, online, preview };
  }));
  if (!isCurrentRender()) return;
  const activeID = conversationListActiveID();
  const renderKey = JSON.stringify({
    activeID,
    personalVisible: !elements.personalConversationButton.hidden,
    pendingContacts: pendingContacts.map((contact) => [
      contact.id,
      contact.status,
      contact.direction,
      contact.display_name,
      contact.username,
      contact.avatar,
    ]),
    conversations: details.map(({ conversation, display, callState, typing, online, preview }) => [
      conversation.id,
      conversation.type,
      conversation.role,
      conversation.unread_count,
      conversation.favorite_at,
      display?.title || "",
      display?.avatar || "",
      display?.securityBlocked || false,
      callState?.media || "",
      callState?.incoming || false,
      callState?.outgoing || false,
      typing?.label || "",
      online,
      preview,
    ]),
  });
  if (renderKey === conversationListRenderKey) return;
  const list = document.createDocumentFragment();
  for (const contact of pendingContacts) {
    list.append(renderContactRequest(contact));
  }
  if (!listedConversations.length && !pendingContacts.length && elements.personalConversationButton.hidden) {
    const empty = document.createElement("p");
    empty.className = "muted sidebar-empty";
    empty.textContent = t("Aucune conversation");
    list.append(empty);
    conversationListRenderKey = renderKey;
    elements.conversations.replaceChildren(list);
    return;
  }
  for (const { conversation, display, callState, typing, online, preview } of details) {
    if (conversation.type === "group" && conversation.role === "pending") {
      list.append(renderGroupInvitation(conversation, display));
      continue;
    }
    const row = document.createElement("div");
    row.className = "conversation-row swipe-row";
    const actions = document.createElement("div");
    actions.className = "swipe-actions conversation-swipe-actions";
    const button = document.createElement("button");
    button.className = [
      "conversation-item",
      "swipe-surface",
      sameID(activeID, conversation.id) ? "active" : "",
      display?.securityBlocked ? "identity-warning" : "",
      callState ? "call-highlight" : "",
      callState?.incoming ? "call-incoming" : "",
    ].filter(Boolean).join(" ");
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = conversation.type === "group" ? "G" : "@";
    const copy = document.createElement("span");
    const titleRow = document.createElement("span");
    titleRow.className = "conversation-title-row";
    const title = document.createElement("strong");
    title.textContent = display?.title || "";
    title.hidden = !display?.title;
    const presence = document.createElement("span");
    presence.className = "presence-indicator";
    presence.hidden = true;
    avatar.append(presence);
    const unread = document.createElement("span");
    unread.className = "unread-badge";
    unread.hidden = !conversation.unread_count;
    unread.textContent = conversation.unread_count > 99 ? "99+" : String(conversation.unread_count || "");
    unread.setAttribute("aria-label", `${conversation.unread_count || 0} message${conversation.unread_count > 1 ? "s" : ""} non lu${conversation.unread_count > 1 ? "s" : ""}`);
    const callBadge = document.createElement("span");
    callBadge.className = "call-conversation-badge";
    callBadge.hidden = !callState;
    callBadge.textContent = callState?.incoming
      ? "Appel entrant"
      : callState?.outgoing
        ? "Appel lancé"
        : "Appel en cours";
    const subtitle = document.createElement("small");
    subtitle.className = "conversation-description";
    if (typing) {
      renderTypingIndicator(subtitle, typing);
    } else if (callState?.incoming) {
      subtitle.textContent = `${callLabel(callState.media)} entrant. Touchez ici pour répondre.`;
      subtitle.classList.add("call-description");
    } else if (callState) {
      subtitle.textContent = callState.outgoing
        ? `${pendingCallLabel(callState.media)}.`
        : `${activeCallLabel(callState.media)}.`;
      subtitle.classList.add("call-description");
    } else {
      subtitle.textContent = preview;
    }
    const favoriteIndicator = document.createElement("span");
    favoriteIndicator.className = "favorite-indicator";
    favoriteIndicator.textContent = "★";
    favoriteIndicator.hidden = !conversation.favorite_at;
    favoriteIndicator.title = t("Favori");
    favoriteIndicator.setAttribute("aria-label", favoriteIndicator.title);
    titleRow.append(title, favoriteIndicator, callBadge, unread);
    copy.append(titleRow, subtitle);
    button.append(avatar, copy);
    button.onclick = () => {
      keepConversationSelectedDuringMobileTransition(button);
      selectConversation(conversation);
    };
    const canEdit = conversation.type === "group" && conversation.created_by === state.me.id;
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `swipe-favorite${conversation.favorite_at ? " active" : ""}`;
    favorite.append(actionIcon("favorite"));
    favorite.title = t(conversation.favorite_at ? "Retirer des favoris" : "Ajouter aux favoris");
    favorite.setAttribute("aria-label", favorite.title);
    favorite.onclick = () => toggleConversationFavorite(conversation, favorite);
    actions.append(favorite);
    if (canEdit) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "swipe-edit";
      edit.append(actionIcon("edit"));
      edit.title = t("Modifier le groupe");
      edit.setAttribute("aria-label", edit.title);
      edit.onclick = () => editConversation(conversation, row);
      actions.append(edit);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "swipe-delete";
    remove.append(actionIcon("delete"));
    remove.title = t(conversation.type === "group" && conversation.created_by !== state.me.id
      ? "Quitter le groupe"
      : conversation.type === "private"
        ? "Supprimer le contact"
        : "Supprimer la discussion");
    remove.setAttribute("aria-label", remove.title);
    remove.onclick = () => deleteConversation(conversation, row);
    actions.append(remove);
    row.append(actions, button);
    const swipe = bindSwipeActions(button, row, canEdit ? 168 : 112);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "conversation-actions-toggle";
    toggle.textContent = "•••";
    toggle.title = t("Afficher les actions");
    toggle.setAttribute("aria-label", toggle.title);
    toggle.onclick = (event) => {
      event.stopPropagation();
      swipe.toggle();
    };
    row.append(toggle);
    list.append(row);
    if (display) {
      replaceAvatarContent(
        avatar,
        display.avatar,
        conversationAvatarFallback(display, conversation),
        [presence],
      );
    }
    applyConversationPresence(presence, online);
  }
  if (isCurrentRender()) {
    conversationListRenderKey = renderKey;
    elements.conversations.replaceChildren(list);
  }
}

function renderGroupInvitation(conversation, display = null) {
  const row = document.createElement("div");
  row.className = "contact-request-row";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = "G";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = display?.title || "";
  title.hidden = !display?.title;
  const subtitle = document.createElement("small");
  subtitle.textContent = display ? t("Invitation de groupe") : t("En attente de votre acceptation");
  copy.append(title, subtitle);
  const actions = document.createElement("span");
  actions.className = "contact-request-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = t("Accepter");
  accept.onclick = () => acceptGroupInvitation(conversation, accept);
  const refuse = document.createElement("button");
  refuse.type = "button";
  refuse.className = "outline";
  refuse.textContent = t("Refuser");
  refuse.onclick = () => refuseGroupInvitation(conversation, refuse);
  actions.append(accept, refuse);
  row.append(avatar, copy, actions);
  if (display?.avatar) {
    const image = document.createElement("img");
    image.src = display.avatar;
    image.alt = "";
    avatar.replaceChildren(image);
  }
  return row;
}

async function acceptGroupInvitation(conversation, button) {
  setBusy(button, true);
  try {
    await api(`/api/conversations/${conversation.id}/accept`, { method: "POST" });
    await refreshAll();
    const accepted = state.conversations.find((item) => item.id === conversation.id);
    if (accepted) await selectConversation(accepted);
    toast("Invitation de groupe acceptée.", "success");
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible d’accepter ce groupe."), "error");
  } finally {
    setBusy(button, false);
  }
}

async function refuseGroupInvitation(conversation, button) {
  setBusy(button, true);
  try {
    await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    clearConversationKeys(conversation.id);
    state.members.delete(conversation.id);
    await refreshAll();
    toast("Invitation de groupe refusée.", "success");
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de refuser ce groupe."), "error");
  } finally {
    setBusy(button, false);
  }
}

function renderContactRequest(contact) {
  const row = document.createElement("div");
  row.className = "contact-request-row";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  if (contact.avatar) {
    const image = document.createElement("img");
    image.src = contact.avatar;
    image.alt = "";
    avatar.append(image);
  } else {
    avatar.textContent = (contact.display_name || contact.username || "?").slice(0, 1).toUpperCase();
  }
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = contact.display_name || contact.username;
  const subtitle = document.createElement("small");
  subtitle.textContent = t(contact.direction === "incoming" ? "Demande de contact" : "En attente d’acceptation");
  copy.append(title, subtitle);
  row.append(avatar, copy);
  const actions = document.createElement("span");
  actions.className = "contact-request-actions";
  if (contact.direction === "incoming") {
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = t("Accepter");
    accept.onclick = () => acceptContact(contact, accept);
    actions.append(accept);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "outline";
  remove.textContent = t(contact.direction === "incoming" ? "Refuser" : "Annuler");
  remove.onclick = () => deleteContactRequest(contact, remove);
  actions.append(remove);
  row.append(actions);
  return row;
}

async function acceptContact(contact, button) {
  setBusy(button, true);
  try {
    const result = await api(`/api/contacts/${contact.id}/accept`, { method: "POST" });
    await refreshAll();
    const conversation = state.conversations.find((item) => item.id === result.conversation_id);
    if (conversation) {
      await selectConversation(conversation);
      await renderConversations();
    }
    toast("Contact accepté.", "success");
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible d’accepter ce contact."), "error");
  } finally {
    setBusy(button, false);
  }
}

async function deleteContactRequest(contact, button) {
  setBusy(button, true);
  try {
    await api(`/api/contacts/${contact.id}`, { method: "DELETE" });
    await refreshAll();
    toast(contact.direction === "incoming" ? "Demande refusée." : "Demande annulée.", "success");
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de modifier cette demande."), "error");
  } finally {
    setBusy(button, false);
  }
}

async function editConversation(conversation, row) {
  const current = await resolveConversationDisplay(conversation);
  const currentDescription = current.description === "Groupe" ? "" : current.description;
  const [key, contacts, members] = await Promise.all([
    getConversationKey(conversation),
    api("/api/contacts"),
    getMembers(conversation.id),
  ]);
  state.contacts = contacts;
  const currentMemberIDs = new Set(members.filter((member) => member.user_id !== state.me.id).map((member) => member.user_id));
  const result = await groupEditDialog({
    name: current.title,
    description: currentDescription,
    avatar: current.customAvatar,
    contacts,
    members,
  });
  const selectedMemberIDs = new Set(result?.memberIDs || []);
  const addedMemberIDs = result
    ? [...selectedMemberIDs].filter((userID) => !currentMemberIDs.has(userID))
    : [];
  const removedMemberIDs = result
    ? [...currentMemberIDs].filter((userID) => !selectedMemberIDs.has(userID))
    : [];
  const needsRotation = addedMemberIDs.length > 0 || removedMemberIDs.length > 0 || conversation.rotation_required === true;
  if (!result || (
    result.name === current.title
    && result.description === currentDescription
    && result.avatar === current.customAvatar
    && !needsRotation
  )) {
    row.dispatchEvent(new Event("swipe-close"));
    return;
  }
  try {
    let metadataKey = key;
    let encryptedKeys = null;
    let nextEpoch = conversationKeyEpoch(conversation);
    if (needsRotation) {
      metadataKey = await generateGroupKey();
      nextEpoch += 1;
      encryptedKeys = {};
      const finalMembers = [
        { ...state.me, user_id: state.me.id },
        ...[...selectedMemberIDs].map((userID) => {
          const existing = members.find((member) => sameID(member.user_id, userID));
          const contact = state.contacts.find((item) => sameID(item.contact_user_id, userID));
          const invited = result.invitedUsers?.find((item) => sameID(item.id, userID));
          return existing || contact || { ...invited, id: userID, user_id: userID };
        }),
      ];
      for (const member of finalMembers) {
        const memberID = Number(member.user_id ?? member.contact_user_id ?? member.id);
        if (!memberID || !member.public_key) throw new Error("Utilisateur introuvable.");
        const trustedMemberPublicKey = await trustedPublicKey(member, { interactive: true });
        try {
          encryptedKeys[String(memberID)] = await wrapGroupKey(
            metadataKey,
            state.privateKey,
            trustedMemberPublicKey,
            state.me.id,
          );
        } catch {
          const memberLabel = member.display_name || member.username || "ce membre";
          throw new Error(`La clé de chiffrement de ${memberLabel} est invalide. Ce compte doit être recréé.`);
        }
      }
    }
    const encryptedTitle = await encryptEnvelope(metadataKey, result.name);
    const encryptedDescription = result.description ? await encryptEnvelope(metadataKey, result.description) : null;
    const encryptedAvatar = result.avatar ? await encryptEnvelope(metadataKey, result.avatar) : null;
    if (needsRotation) {
      await api(`/api/conversations/${conversation.id}/rotate-keys`, {
        method: "POST",
        body: {
          key_epoch: nextEpoch,
          removed_user_ids: removedMemberIDs,
          added_user_ids: addedMemberIDs,
          encrypted_keys: encryptedKeys,
          encrypted_title: encryptedTitle,
          encrypted_description: encryptedDescription,
          encrypted_avatar: encryptedAvatar,
        },
      });
      conversation.current_key_epoch = nextEpoch;
      conversation.rotation_required = false;
      conversation.encrypted_conversation_key = encryptedKeys[String(state.me.id)];
      clearConversationKeys(conversation.id);
      state.keys.set(conversationKeyCacheID(conversation.id, nextEpoch), metadataKey);
    } else {
      await api(`/api/conversations/${conversation.id}`, {
        method: "PUT",
        body: {
          encrypted_title: encryptedTitle,
          encrypted_description: encryptedDescription,
          encrypted_avatar: encryptedAvatar,
        },
      });
    }
    conversation.encrypted_title = encryptedTitle;
    conversation.encrypted_description = encryptedDescription;
    conversation.encrypted_avatar = encryptedAvatar;
    state.members.delete(conversation.id);
    if (state.current?.id === conversation.id) {
      renderConversationHeader(conversation, {
        title: result.name,
        description: result.description,
        avatar: result.avatar,
      });
    }
    await refreshAll();
    await renderConversations();
    toast("Groupe modifié.", "success");
  } catch (error) {
    row.dispatchEvent(new Event("swipe-close"));
    toast(frenchErrorMessage(error, "Impossible de modifier le groupe."), "error");
  }
}

async function repairRequiredGroupRotation(conversation) {
  if (conversation.type !== "group" || conversation.rotation_required !== true || !sameID(conversation.created_by, state.me.id)) return false;
  const members = await getMembers(conversation.id, { fresh: true, interactive: true });
  const previousKey = await getConversationKey(conversation);
  const [title, description, avatar] = await Promise.all([
    decryptEnvelope(previousKey, conversation.encrypted_title),
    conversation.encrypted_description ? decryptEnvelope(previousKey, conversation.encrypted_description) : null,
    conversation.encrypted_avatar ? decryptEnvelope(previousKey, conversation.encrypted_avatar) : null,
  ]);
  const nextKey = await generateGroupKey();
  const nextEpoch = conversationKeyEpoch(conversation) + 1;
  const encryptedKeys = {};
  for (const member of members) {
    const trustedMemberPublicKey = await trustedPublicKey(member, { interactive: true });
    encryptedKeys[String(member.user_id)] = await wrapGroupKey(
      nextKey,
      state.privateKey,
      trustedMemberPublicKey,
      state.me.id,
    );
  }
  const encryptedTitle = await encryptEnvelope(nextKey, title);
  const encryptedDescription = description ? await encryptEnvelope(nextKey, description) : null;
  const encryptedAvatar = avatar ? await encryptEnvelope(nextKey, avatar) : null;
  await api(`/api/conversations/${conversation.id}/rotate-keys`, {
    method: "POST",
    body: {
      key_epoch: nextEpoch,
      removed_user_ids: [],
      added_user_ids: [],
      encrypted_keys: encryptedKeys,
      encrypted_title: encryptedTitle,
      encrypted_description: encryptedDescription,
      encrypted_avatar: encryptedAvatar,
    },
  });
  Object.assign(conversation, {
    current_key_epoch: nextEpoch,
    rotation_required: false,
    encrypted_conversation_key: encryptedKeys[String(state.me.id)],
    encrypted_title: encryptedTitle,
    encrypted_description: encryptedDescription,
    encrypted_avatar: encryptedAvatar,
  });
  clearConversationKeys(conversation.id);
  state.keys.set(conversationKeyCacheID(conversation.id, nextEpoch), nextKey);
  return true;
}

function closeCurrentConversation(conversationID) {
  if (!sameID(state.current?.id, conversationID)) return;
  closeReactionPicker();
  clearCallState(conversationID);
  state.current = null;
  clearFileCache();
  state.messageClears.delete(conversationID);
  clearConversationMessageExpirations(conversationID);
  elements.input.value = "";
  elements.input.disabled = true;
  elements.send.disabled = true;
  elements.emojiButton.disabled = true;
  elements.pollButton.disabled = true;
  elements.eventButton.disabled = true;
  elements.pinnedWindowButton.disabled = true;
  setPinnedPanelOpen(false);
  updateCallUI();
  closeEmojiPicker();
  elements.title.textContent = t("Sélectionnez une conversation");
  elements.description.textContent = "";
  elements.chatAvatar.hidden = true;
  setConversationInfoTrigger(null);
  elements.chatAvatar.classList.remove("personal-note-avatar");
  elements.chatAvatar.replaceChildren();
  renderMobileNavigationAvatar();
  renderTypingIndicator(elements.typing, null);
  renderTypingIndicator(elements.threadTyping, null);
  elements.threadTyping.hidden = true;
  elements.messages.replaceChildren();
  const empty = document.createElement("div");
  empty.id = "empty-chat";
  empty.textContent = t("Sélectionnez une conversation ou créez-en une nouvelle.");
  elements.messages.append(empty);
}

async function deleteConversation(conversation, button) {
  const isOwner = conversation.created_by === state.me.id;
  const question = conversation.type === "private"
    ? "Supprimer ce contact et la discussion privée pour les deux participants ?"
    : isOwner
      ? "Supprimer définitivement ce groupe pour tous les membres ?"
      : "Quitter ce groupe ?";
  const confirmed = await actionDialog({
    title: conversation.type === "private"
      ? "Supprimer le contact"
      : conversation.type === "group" && !isOwner
        ? "Quitter le groupe"
        : "Supprimer la discussion",
    message: question,
    confirmLabel: conversation.type === "group" && !isOwner ? "Quitter" : "Supprimer",
    danger: true,
  });
  if (!confirmed) {
    button.dispatchEvent(new Event("swipe-close"));
    return;
  }
  button.classList.add("action-pending");
  try {
    const result = await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    closeCurrentConversation(conversation.id);
    clearConversationKeys(conversation.id);
    state.members.delete(conversation.id);
    state.messageClears.delete(conversation.id);
    state.cache?.deleteConversation(conversation.id);
    await refreshAll();
    toast(result.action === "left" ? "Vous avez quitté le groupe." : conversation.type === "private" ? "Contact supprimé." : "Discussion supprimée.", "success");
  } catch (error) {
    button.classList.remove("action-pending");
    button.dispatchEvent(new Event("swipe-close"));
    toast(frenchErrorMessage(error, "Impossible de supprimer la discussion."), "error");
  }
}

async function getMembers(conversationID, { fresh = false, interactive = false } = {}) {
  if (fresh) {
    try {
      const members = await trustMembers(
        await api(`/api/conversations/${conversationID}/members`),
        { interactive },
      );
      state.members.set(conversationID, members);
      await state.cache?.saveMembers(conversationID, members);
      return members;
    } catch (error) {
      if (isIdentitySecurityError(error)) throw error;
      if (state.members.has(conversationID)) {
        return trustMembers(state.members.get(conversationID), { interactive });
      }
      const cached = await state.cache?.getMembers(conversationID);
      if (cached?.length) {
        const members = await trustMembers(cached, { interactive });
        state.members.set(conversationID, members);
        return members;
      }
      throw error;
    }
  }
  if (!state.members.has(conversationID)) {
    const cached = await state.cache?.getMembers(conversationID);
    if (cached?.length) {
      state.members.set(conversationID, await trustMembers(cached, { interactive }));
      api(`/api/conversations/${conversationID}/members`)
        .then((members) => trustMembers(members))
        .then(async (members) => {
          state.members.set(conversationID, members);
          await state.cache?.saveMembers(conversationID, members);
        })
        .catch((error) => reportIdentitySecurityError(error));
    } else {
      const members = await trustMembers(
        await api(`/api/conversations/${conversationID}/members`),
        { interactive },
      );
      state.members.set(conversationID, members);
      await state.cache?.saveMembers(conversationID, members);
    }
  }
  return trustMembers(state.members.get(conversationID), { interactive });
}

async function conversationOnline(conversation) {
  const members = await getMembers(conversation.id);
  return members.some((member) => (
    member.user_id !== state.me.id
    && member.role !== "pending"
    && state.onlineUsers.has(String(member.user_id))
  ));
}

function applyConversationPresence(dot, online) {
  dot.hidden = !online;
  dot.classList.toggle("online", online);
  dot.title = online ? t("En ligne") : "";
  dot.setAttribute("aria-label", t(online ? "Contact en ligne" : "Contact hors ligne"));
}

function activeTypingUsers(conversationID) {
  return [...(state.typing.get(conversationID)?.keys() || [])];
}

function clearTypingUser(conversationID, userID) {
  const timerKey = `${conversationID}:${userID}`;
  clearTimeout(state.typingTimers.get(timerKey));
  state.typingTimers.delete(timerKey);
  const users = state.typing.get(conversationID);
  if (!users) return;
  users.delete(userID);
  if (!users.size) state.typing.delete(conversationID);
}

function typingFallbackLabel(conversationID) {
  const count = activeTypingUsers(conversationID).length;
  if (!count) return "";
  return count === 1 ? "écrit…" : "écrivent…";
}

async function typingIndicator(conversation) {
  const userIDs = activeTypingUsers(conversation.id);
  if (!userIDs.length) return null;
  const members = await getMembers(conversation.id);
  const names = userIDs
    .map((userID) => members.find((member) => member.user_id === userID))
    .filter(Boolean)
    .map((member) => member.display_name || member.username);
  if (!names.length) return { prefix: "", label: typingFallbackLabel(conversation.id) };
  if (conversation.type === "private") return { prefix: "", label: `${names[0]} écrit…` };
  if (names.length === 1) return { prefix: names[0], label: `${names[0]} écrit…` };
  if (names.length === 2) {
    const prefix = `${names[0]} et ${names[1]}`;
    return { prefix, label: `${prefix} écrivent…` };
  }
  const prefix = `${names[0]} et ${names.length - 1} autres`;
  return { prefix, label: `${prefix} écrivent…` };
}

function renderTypingIndicator(container, indicator) {
  if (!container) return;
  container.replaceChildren();
  container.classList.toggle("typing", Boolean(indicator));
  if (!indicator) {
    container.removeAttribute("aria-label");
    return;
  }
  container.setAttribute("aria-label", indicator.label);
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index++) {
    dots.append(document.createElement("span"));
  }
  container.append(dots);
}

async function refreshTypingIndicators(conversationID) {
  if (state.current?.id === conversationID) {
    const indicator = state.current ? await typingIndicator(state.current) : null;
    renderTypingIndicator(elements.typing, indicator);
    renderTypingIndicator(elements.threadTyping, indicator);
    elements.threadTyping.hidden = !indicator;
  }
  await renderConversations();
}

async function setTypingUser(conversationID, userID, typing) {
  if (userID === state.me.id) return;
  clearTypingUser(conversationID, userID);
  if (typing) {
    if (!state.typing.has(conversationID)) state.typing.set(conversationID, new Map());
    state.typing.get(conversationID).set(userID, Date.now());
    const timerKey = `${conversationID}:${userID}`;
    state.typingTimers.set(timerKey, setTimeout(() => {
      clearTypingUser(conversationID, userID);
      refreshTypingIndicators(conversationID).catch(() => {});
    }, 3500));
  }
  await refreshTypingIndicators(conversationID);
}

function conversationKeyEpoch(conversation) {
  return conversation?.type === "group" ? Math.max(1, Number(conversation.current_key_epoch) || 1) : 1;
}

function messageKeyEpoch(message, conversation) {
  return conversation?.type === "group" ? Math.max(1, Number(message?.key_epoch) || 1) : 1;
}

function conversationKeyCacheID(conversationID, keyEpoch) {
  return `${conversationID}:${Math.max(1, Number(keyEpoch) || 1)}`;
}

function clearConversationKeys(conversationID) {
  const prefix = `${conversationID}:`;
  for (const key of state.keys.keys()) {
    if (String(key).startsWith(prefix) || sameID(key, conversationID)) state.keys.delete(key);
  }
  state.keyEnvelopes.delete(String(conversationID));
  state.keyEnvelopeLoads.delete(String(conversationID));
}

async function getConversationKeyEnvelopes(conversation, { fresh = false } = {}) {
  const conversationID = String(conversation.id);
  if (!fresh && state.keyEnvelopes.has(conversationID)) return state.keyEnvelopes.get(conversationID);
  if (!fresh && state.keyEnvelopeLoads.has(conversationID)) return state.keyEnvelopeLoads.get(conversationID);
  const load = (async () => {
    let envelopes = [];
    try {
      envelopes = await api(`/api/conversations/${conversation.id}/keys`);
      await state.cache?.saveKeyEnvelopes(conversation.id, envelopes);
    } catch (error) {
      envelopes = await state.cache?.getKeyEnvelopes(conversation.id) || [];
      if (!envelopes.length) throw error;
    }
    const byEpoch = new Map(envelopes.map((envelope) => [Math.max(1, Number(envelope.key_epoch) || 1), envelope]));
    state.keyEnvelopes.set(conversationID, byEpoch);
    return byEpoch;
  })().finally(() => state.keyEnvelopeLoads.delete(conversationID));
  state.keyEnvelopeLoads.set(conversationID, load);
  return load;
}

async function getConversationKey(conversation, requestedEpoch = conversationKeyEpoch(conversation)) {
  const members = await getMembers(conversation.id);
  const keyEpoch = conversation?.type === "group" ? Math.max(1, Number(requestedEpoch) || 1) : 1;
  const cacheID = conversationKeyCacheID(conversation.id, keyEpoch);
  if (state.keys.has(cacheID)) return state.keys.get(cacheID);
  let key;
  if (conversation.is_personal) {
    const ownMember = members.find((member) => member.user_id === state.me.id);
    if (!ownMember) throw new Error("Identité personnelle introuvable.");
    key = await privateConversationKey(state.privateKey, ownMember.public_key, conversation.id);
  } else if (conversation.type === "private") {
    const peer = members.find((member) => member.user_id !== state.me.id);
    if (!peer) throw new Error("Participant introuvable.");
    key = await privateConversationKey(state.privateKey, peer.public_key, conversation.id, conversation.federation_key_id || "");
  } else {
    const envelopes = await getConversationKeyEnvelopes(conversation);
    const stored = envelopes.get(keyEpoch);
    if (stored) {
      const envelope = JSON.parse(stored.encrypted_conversation_key);
      if (!sameID(envelope.sender_id, conversation.created_by)) throw new Error("Auteur de l’enveloppe de groupe invalide.");
      const sender = members.find((member) => sameID(member.user_id, envelope.sender_id));
      if (!sender) throw new Error("Créateur du groupe introuvable.");
      const storedSenderKey = canonicalPublicKey(stored.sender_public_key);
      if (storedSenderKey !== canonicalPublicKey(sender.public_key)) {
        const trust = await getIdentityTrust(identityTrustInput(sender));
        const storedFingerprint = await publicKeyFingerprint(storedSenderKey);
        if (!trust.record?.history?.some((entry) => entry.fingerprint === storedFingerprint)) {
          throw new Error("La clé ayant créé cette enveloppe de groupe n’est pas une identité connue.");
        }
      }
      key = await unwrapGroupKey(stored.encrypted_conversation_key, state.privateKey, storedSenderKey);
    } else if (keyEpoch === conversationKeyEpoch(conversation) && conversation.encrypted_conversation_key) {
      const envelope = JSON.parse(conversation.encrypted_conversation_key);
      if (!sameID(envelope.sender_id, conversation.created_by)) throw new Error("Auteur de l’enveloppe de groupe invalide.");
      const sender = members.find((member) => sameID(member.user_id, envelope.sender_id));
      if (!sender) throw new Error("Créateur du groupe introuvable.");
      key = await unwrapGroupKey(conversation.encrypted_conversation_key, state.privateKey, sender.public_key);
    } else {
      throw new Error(`Clé de groupe historique ${keyEpoch} introuvable.`);
    }
  }
  state.keys.set(cacheID, key);
  return key;
}

async function getMessageKey(message, conversation) {
  return getConversationKey(conversation, messageKeyEpoch(message, conversation));
}

async function resolveConversationTitle(conversation) {
  return (await resolveConversationDisplay(conversation)).title;
}

async function resolveConversationDisplay(conversation, { freshMembers = false } = {}) {
  const members = await getMembers(conversation.id, { fresh: freshMembers });
  if (conversation.is_personal) {
    return {
      title: t("Mes notes"),
      description: t("Messages et fichiers personnels"),
      avatar: null,
      customAvatar: null,
    };
  }
  if (conversation.type === "private") {
    const peer = members.find((member) => member.user_id !== state.me.id);
    return {
      title: peer?.display_name || peer?.username || "",
      description: conversation.federation_instance_url
        ? `${peer?.username || conversation.remote_username}@${new URL(conversation.federation_instance_url).host}`
        : peer?.description || "",
      avatar: peer?.avatar || null,
      customAvatar: peer?.avatar || null,
    };
  }
  const key = await getConversationKey(conversation);
  const description = conversation.encrypted_description
    ? await decryptEnvelope(key, conversation.encrypted_description)
    : "Groupe";
  const avatar = conversation.encrypted_avatar
    ? await decryptEnvelope(key, conversation.encrypted_avatar)
    : null;
  return {
    title: await decryptEnvelope(key, conversation.encrypted_title),
    description,
    avatar,
    customAvatar: conversation.encrypted_avatar ? avatar : null,
  };
}

async function conversationListPreview(conversation, display) {
  if (conversation.last_message_has_file) return "Fichier chiffré";
  if (conversation.last_message_encrypted_content && conversation.last_message_iv) {
    try {
      const key = await getConversationKey(conversation, conversation.last_message_key_epoch || 1);
      const clear = await decryptText(key, conversation.last_message_encrypted_content, conversation.last_message_iv);
      try {
        const structured = JSON.parse(clear);
        if (structured?.v === 1 && typeof structured.question === "string" && Array.isArray(structured.options)) {
          return compactPreviewText(`Sondage : ${structured.question}`);
        }
        if (structured?.v === 1 && structured.type === "event" && typeof structured.name === "string") {
          return compactPreviewText(`Évènement : ${structured.name}`);
        }
      } catch {}
      return compactPreviewText(clear) || "Message chiffré";
    } catch {
      return "Message chiffré";
    }
  }
  return display.description || (conversation.type === "group" ? "Groupe" : "Contact");
}

function compactPreviewText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

async function selectConversation(conversation, targetMessageID = null) {
  if (conversation.role === "pending") {
    toast("Acceptez cette invitation avant d’ouvrir le groupe.", "error");
    return;
  }
  try {
    await getMembers(conversation.id, { fresh: true, interactive: true });
    if (conversation.rotation_required && sameID(conversation.created_by, state.me.id)) {
      await repairRequiredGroupRotation(conversation);
      toast("La clé du groupe a été renouvelée après le départ d’un membre.", "success");
    }
  } catch (error) {
    error.conversationID = conversation.id;
    if (!reportIdentitySecurityError(error)) {
      toast(frenchErrorMessage(error, "Impossible de vérifier les participants de cette discussion."), "error");
    }
    return;
  }
  const conversationChanged = !sameID(state.current?.id, conversation.id);
  if (conversationChanged) {
    clearVoiceDraft();
    clearFileCache();
    const loading = document.createElement("div");
    loading.id = "empty-chat";
    loading.textContent = t("Chargement…");
    elements.messages.replaceChildren(loading);
  }
  closeReactionPicker();
  state.current = conversation;
  conversation.unread_count = 0;
  const listed = state.conversations.find((item) => sameID(item.id, conversation.id));
  if (listed) listed.unread_count = 0;
  elements.shell.classList.remove("sidebar-open");
  const sidebarButton = document.querySelector("#open-sidebar-logo");
  sidebarButton.setAttribute("aria-expanded", "false");
  sidebarButton.setAttribute("aria-label", t("Afficher les contacts, groupes et conversations"));
  sidebarButton.title = t("Afficher les contacts et groupes");
  elements.input.disabled = false;
  elements.send.disabled = false;
  elements.emojiButton.disabled = false;
  elements.voiceButton.disabled = false;
  elements.pollButton.disabled = false;
  elements.eventButton.disabled = false;
  elements.pinnedWindowButton.disabled = false;
  if (conversation.rotation_required) {
    elements.input.disabled = true;
    elements.send.disabled = true;
    elements.voiceButton.disabled = true;
    elements.pollButton.disabled = true;
    elements.eventButton.disabled = true;
    toast("Les nouveaux envois sont suspendus jusqu’au renouvellement de la clé par le propriétaire du groupe.", "error");
  }
  updateCallButtons();
  const selectedID = conversation.id;
  const messagesLoading = loadMessages(targetMessageID).then(() => null, (error) => error);
  const display = await resolveConversationDisplay(conversation);
  if (!sameID(state.current?.id, selectedID)) return;
  renderConversationHeader(conversation, display);
  const typing = await typingIndicator(conversation);
  renderTypingIndicator(elements.typing, typing);
  renderTypingIndicator(elements.threadTyping, typing);
  elements.threadTyping.hidden = !typing;
  const [, messageLoadError] = await Promise.all([renderConversations(), messagesLoading]);
  if (messageLoadError) throw messageLoadError;
  if (!elements.pinnedPanel.hidden) await loadPinnedMessages();
  updateCallUI();
  elements.input.focus({ preventScroll: true });
  if (targetMessageID) {
    await revealMessage(targetMessageID);
  } else {
    await scrollMessagesToLatest(selectedID);
  }
}

function canSignalCall(conversation = state.current) {
  return Boolean(conversation && !conversation.is_personal && ["private", "group"].includes(conversation.type) && state.socket?.socket?.readyState === WebSocket.OPEN);
}

function sameID(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function updateCallButtons() {
  const enabled = canSignalCall() && !state.call;
  elements.audioCallButton.disabled = !enabled;
  elements.videoCallButton.disabled = !enabled;
  elements.audioCallButton.title = t(state.current?.type === "group" ? "Appel audio de groupe" : "Appel audio");
  elements.videoCallButton.title = t(state.current?.type === "group" ? "Appel vidéo de groupe" : "Appel vidéo");
}

function callLabel(media) {
  return media === "video" ? "appel vidéo" : "appel audio";
}

function callHistoryLabel(media) {
  return media === "video" ? "Appel vidéo" : "Appel audio";
}

function pendingCallLabel(media) {
  return t(media === "video" ? "Appel vidéo en attente" : "Appel audio en attente");
}

function activeCallLabel(media) {
  return t(media === "video" ? "Appel vidéo en cours" : "Appel audio en cours");
}

function configureCallVideoElement(video) {
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("controlslist", "nofullscreen nodownload noremoteplayback");
  bindCallVideoPlaybackGuards(video);
}

function bindCallVideoPlaybackGuards(video) {
  if (!video || video.dataset.callPlaybackGuard === "true") return;
  video.dataset.callPlaybackGuard = "true";
  video.addEventListener("webkitendfullscreen", () => scheduleCallVideoPlaybackResume());
  video.addEventListener("pause", () => {
    if (callVideoShouldKeepPlaying(video)) scheduleCallVideoPlaybackResume(80);
  });
}

function callVideoShouldKeepPlaying(video) {
  if (!state.call || state.call.closing || state.call.media !== "video" || document.hidden) return false;
  if (!video?.srcObject || video.hidden) return false;
  const tracks = typeof video.srcObject.getVideoTracks === "function" ? video.srcObject.getVideoTracks() : [];
  return tracks.some((track) => track.readyState === "live");
}

function callVideoElements() {
  return [elements.localCallVideo, ...elements.remoteCallVideos.querySelectorAll("video")];
}

function resumeCallVideoPlayback() {
  if (!state.call || state.call.closing || state.call.media !== "video") return;
  for (const video of callVideoElements()) {
    if (!callVideoShouldKeepPlaying(video)) continue;
    configureCallVideoElement(video);
    video.play().catch(() => {});
  }
}

function scheduleCallVideoPlaybackResume(delay = 120) {
  window.clearTimeout(callVideoResumeTimer);
  callVideoResumeTimer = window.setTimeout(() => {
    resumeCallVideoPlayback();
    window.setTimeout(resumeCallVideoPlayback, 350);
  }, delay);
}

function callRejectMessage(reason) {
  if (reason === "busy") return "Correspondant occupé.";
  if (reason === "timeout") return "Appel sans réponse.";
  if (reason === "media_error") return "Microphone ou caméra indisponible chez le correspondant.";
  return "Appel refusé.";
}

function currentCallTitle() {
  return state.call?.callerName || "un contact";
}

function callConversation(call = state.call) {
  if (!call) return null;
  return state.conversations.find((item) => item.id === call.conversationID) || null;
}

function isGroupCall(call = state.call) {
  return callConversation(call)?.type === "group";
}

function callPeers(call = state.call) {
  if (!call) return new Map();
  if (!call.peers) call.peers = new Map();
  return call.peers;
}

function getCallPeer(userID) {
  if (!state.call || !userID) return null;
  const peers = callPeers();
  if (!peers.has(userID)) {
    peers.set(userID, {
      userID,
      peer: null,
      pendingCandidates: [],
      remoteStream: null,
      audioElement: null,
      videoElement: null,
      connected: false,
      needsIceRestart: false,
      iceRestarting: false,
      iceRestartAttempts: 0,
      iceRestartTimeout: null,
      whiteboardChannel: null,
    });
  }
  return peers.get(userID);
}

function activeCallPeerCount() {
  if (!state.call?.peers) return 0;
  return [...state.call.peers.values()].filter((peer) => peer.connected || peer.remoteStream).length;
}

async function memberDisplayName(conversationID, userID, fallback = "un contact") {
  const members = await getMembers(conversationID).catch(() => []);
  const member = members.find((item) => item.user_id === userID);
  return member?.display_name || member?.username || fallback;
}

function newCallID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sendCallSignal(type, extra = {}) {
  const conversationID = extra.conversation_id || state.call?.conversationID || state.current?.id;
  if (!conversationID) return;
  const { conversation_id: ignoredConversationID, ...payload } = extra;
  state.socket.send({
    type,
    conversation_id: conversationID,
    ...payload,
  });
}

async function startCallInvite(media) {
  if (!canSignalCall() || state.call) return;
  const call = {
    id: newCallID(),
    conversationID: state.current.id,
    media,
    direction: "outgoing",
    status: "ringing",
    facingMode: "user",
    peers: new Map(),
    acceptedUserIDs: new Set(),
  };
  state.call = call;
  sendCallSignal("call_invite", { call_id: call.id, media });
  startOutgoingCallTimeout(call);
  updateCallUI();
  refreshConversationCallIndicators();
}

async function acceptIncomingCall() {
  if (!state.call || state.call.direction !== "incoming") return;
  clearCallAlerts();
  state.call.status = "connecting";
  updateCallUI();
  refreshConversationCallIndicators();
  try {
    await openCallConversation();
    await ensureLocalCallStream();
    state.call.status = "accepted";
    sendCallSignal("call_accept", { call_id: state.call.id, media: state.call.media });
    await connectAcceptedCallPeers();
    updateCallUI();
    refreshConversationCallIndicators();
  } catch (error) {
    sendCallSignal("call_reject", {
      call_id: state.call.id,
      media: state.call.media,
      reason: "media_error",
      target_user_id: state.call.callerID,
    });
    clearCallState();
    toast(frenchErrorMessage(error, "Microphone ou caméra inaccessible."), "error");
  }
}

async function openCallConversation() {
  const conversationID = state.call?.conversationID;
  if (!conversationID || sameID(state.current?.id, conversationID)) return;
  let conversation = state.conversations.find((item) => sameID(item.id, conversationID));
  if (!conversation) {
    state.conversations = await api("/api/conversations");
    await renderConversations();
    conversation = state.conversations.find((item) => sameID(item.id, conversationID));
  }
  if (!conversation) {
    toast("Conversation d’appel introuvable.", "error");
    return;
  }
  await selectConversation(conversation);
}

function rejectIncomingCall(reason) {
  if (!state.call || state.call.direction !== "incoming") return;
  if (reason === "rejected") {
    logCallHistory(state.call, `${callHistoryLabel(state.call.media)} refusé.`);
  }
  sendCallSignal("call_reject", { call_id: state.call.id, media: state.call.media, reason, target_user_id: state.call.callerID });
  clearCallState();
}

function hangupCall(reason) {
  if (!state.call) return;
  if (state.call.closing) return;
  logCallHistory(state.call, callHangupHistoryText(state.call, reason));
  sendCallSignal("call_hangup", { call_id: state.call.id, media: state.call.media, reason });
  clearCallState();
}

function handleCallPageExit() {
  if (callPageExitHandled || !state.call) return;
  callPageExitHandled = true;
  const call = state.call;
  const isUnansweredIncoming = call.direction === "incoming" && call.status === "ringing";
  const payload = {
    type: isUnansweredIncoming ? "call_reject" : "call_hangup",
    conversation_id: call.conversationID,
    call_id: call.id,
    media: call.media,
    reason: "reload",
  };
  if (isUnansweredIncoming && call.callerID) payload.target_user_id = call.callerID;
  try {
    if (state.socket?.socket?.readyState === WebSocket.OPEN) {
      state.socket.socket.send(JSON.stringify(payload));
    }
  } catch (error) {
    console.warn("Signal de fin d’appel avant rechargement impossible", error);
  }
  closeCallResources();
  state.call = null;
}

function scheduleCallInterruptForSignalLoss() {
  if (!state.call || state.call.signalLossTimeout) return;
  const call = state.call;
  call.signalLossTimeout = setTimeout(() => {
    if (!state.call || state.call !== call || state.socket?.socket?.readyState === WebSocket.OPEN) return;
    call.signalLossTimeout = null;
    interruptCallForSignalLoss();
  }, CALL_SIGNAL_LOSS_GRACE_MS);
  toast("Connexion au serveur instable. L’appel reste actif pendant la reconnexion.", "error");
}

function clearCallSignalLossTimer(call = state.call) {
  if (!call?.signalLossTimeout) return;
  clearTimeout(call.signalLossTimeout);
  call.signalLossTimeout = null;
}

function interruptCallForSignalLoss() {
  if (!state.call) return;
  logCallHistory(state.call, `${callHistoryLabel(state.call.media)} interrompu : connexion perdue.`);
  clearCallState();
  toast("Appel interrompu : connexion au serveur perdue.", "error");
}

function callHangupHistoryText(call, reason) {
  if (call.status === "ringing" && call.direction === "outgoing") return `${callHistoryLabel(call.media)} annulé.`;
  if (reason === "connection_failed" || reason === "media_error") return `${callHistoryLabel(call.media)} interrompu.`;
  return `${callHistoryLabel(call.media)} terminé.`;
}

function logCallHistory(call, text) {
  if (!call || call.historyLogged) return;
  call.historyLogged = true;
  sendCallHistoryMessage(call.conversationID, text).catch((error) => {
    console.warn("Journalisation d’appel impossible", error);
  });
}

async function sendCallHistoryMessage(conversationID, text) {
  const conversation = state.conversations.find((item) => item.id === conversationID);
  if (!conversation || !text) return;
  const key = await getConversationKey(conversation);
  const encrypted = await encryptText(key, text);
  const keyEpoch = conversationKeyEpoch(conversation);
  const signature = await messageSignature("text", conversationID, {
    encrypted_content: encrypted.data, iv: encrypted.iv, key_epoch: keyEpoch, reply_to: null,
  });
  const message = await api(`/api/conversations/${conversationID}/messages`, {
    method: "POST",
    body: {
      encrypted_content: encrypted.data,
      iv: encrypted.iv,
      reply_to: null,
      expires_in_seconds: 86400,
      key_epoch: keyEpoch,
      ...signature,
    },
  });
  if (state.current?.id === conversationID) await appendMessage(message, false);
  else await refreshAll();
}

async function messageSignature(kind, conversationID, body, existingMessage = null) {
  return signMessagePayload(state.signingPrivateKey, state.signingKeyID, {
    kind,
    conversation_id: conversationID,
    sender_id: state.me.id,
    client_message_id: existingMessage?.client_message_id || undefined,
    revision: existingMessage?.signature_version ? Number(existingMessage.revision || 1) + 1 : 1,
    key_epoch: Number(body.key_epoch || existingMessage?.key_epoch || 1),
    reply_to: body.reply_to ?? existingMessage?.reply_to ?? null,
    encrypted_content: body.encrypted_content || "",
    iv: body.iv || "",
    option_count: body.option_count || 0,
    starts_at: body.starts_at || "",
    ends_at: body.ends_at || "",
    encrypted_name: body.encrypted_name || "",
    encrypted_mime: body.encrypted_mime || "",
    ciphertext_sha256: body.ciphertext_sha256 || "",
    preview_sha256: body.preview_sha256 || "",
  });
}

async function clearCallState(conversationID = state.call?.conversationID) {
  if (state.call && conversationID && !sameID(state.call.conversationID, conversationID)) return;
  const call = state.call;
  if (call?.closing) return;
  if (call) call.closing = true;
  clearCallSignalLossTimer(call);
  await exitCallFullscreen();
  closeCallResources(call);
  if (state.call === call) state.call = null;
  updateCallUI();
  refreshConversationCallIndicators();
}

function closeCallResources(call = state.call) {
  window.clearTimeout(callVideoResumeTimer);
  callVideoResumeTimer = null;
  clearCallAlerts(call);
  if (call?.peers) {
    for (const peerState of call.peers.values()) {
      closeCallPeer(peerState);
    }
  }
  call?.localStream?.getTracks().forEach((track) => track.stop());
  call?.screenStream?.getTracks().forEach((track) => track.stop());
  elements.remoteCallAudio.pause();
  elements.remoteCallAudio.srcObject = null;
  delete elements.remoteCallAudio.dataset.peerId;
  elements.remoteCallAudio.hidden = true;
  elements.remoteCallAudioPeers.replaceChildren();
  elements.remoteCallAudioPeers.hidden = true;
  elements.remoteCallVideo.pause();
  elements.localCallVideo.pause();
  elements.remoteCallVideo.srcObject = null;
  delete elements.remoteCallVideo.dataset.peerId;
  for (const video of [...elements.remoteCallVideos.querySelectorAll("video")]) {
    if (video !== elements.remoteCallVideo) video.remove();
  }
  elements.localCallVideo.srcObject = null;
  elements.callVideoStage.hidden = true;
}

function closeCallPeer(peerState) {
  if (!peerState) return;
  clearPeerIceRestartTimer(peerState);
  if (peerState.peer) {
    peerState.peer.onicecandidate = null;
    peerState.peer.ontrack = null;
    peerState.peer.ondatachannel = null;
    peerState.peer.onconnectionstatechange = null;
    peerState.peer.oniceconnectionstatechange = null;
    peerState.peer.onsignalingstatechange = null;
    peerState.peer.close();
    peerState.peer = null;
  }
  if (peerState.whiteboardChannel) {
    peerState.whiteboardChannel.onopen = null;
    peerState.whiteboardChannel.onmessage = null;
    peerState.whiteboardChannel.onclose = null;
    peerState.whiteboardChannel.close();
    peerState.whiteboardChannel = null;
  }
  clearRemoteMediaForPeer(peerState);
}

function clearRemoteMediaForPeer(peerState) {
  if (peerState.audioElement) {
    peerState.audioElement.pause();
    peerState.audioElement.srcObject = null;
    if (peerState.audioElement === elements.remoteCallAudio) {
      delete elements.remoteCallAudio.dataset.peerId;
      elements.remoteCallAudio.hidden = true;
    } else {
      peerState.audioElement.remove();
    }
    peerState.audioElement = null;
  }
  if (peerState.videoElement) {
    peerState.videoElement.pause();
    peerState.videoElement.srcObject = null;
    if (peerState.videoElement === elements.remoteCallVideo) {
      delete elements.remoteCallVideo.dataset.peerId;
    } else {
      peerState.videoElement.remove();
    }
    peerState.videoElement = null;
  }
  peerState.remoteStream = null;
  elements.remoteCallAudioPeers.hidden = !elements.remoteCallAudioPeers.children.length;
}

function clearPeerIceRestartTimer(peerState) {
  if (!peerState?.iceRestartTimeout) return;
  clearTimeout(peerState.iceRestartTimeout);
  peerState.iceRestartTimeout = null;
}

function clearCallAlerts(call = state.call) {
  if (!call) return;
  if (call.timeout) {
    clearTimeout(call.timeout);
    call.timeout = null;
  }
  if (call.ringtone?.interval) clearInterval(call.ringtone.interval);
  call.ringtone?.audioContext?.close().catch(() => {});
  call.ringtone = null;
}

function startOutgoingCallTimeout(call) {
  call.timeout = setTimeout(() => {
    if (!state.call || state.call.id !== call.id || state.call.status !== "ringing") return;
    logCallHistory(call, `${callHistoryLabel(call.media)} manqué.`);
    sendCallSignal("call_hangup", { call_id: call.id, media: call.media, reason: "no_answer" });
    toast("Appel sans réponse.");
    clearCallState(call.conversationID);
  }, CALL_INVITE_TIMEOUT_MS);
}

function startIncomingCallAlerts(call) {
  clearCallAlerts(call);
  startIncomingRingtone(call);
  call.timeout = setTimeout(() => {
    if (!state.call || state.call.id !== call.id || state.call.status !== "ringing") return;
    sendCallSignal("call_reject", {
      conversation_id: call.conversationID,
      call_id: call.id,
      media: call.media,
      reason: "timeout",
      target_user_id: call.callerID,
    });
    toast("Appel manqué.");
    clearCallState(call.conversationID);
  }, CALL_INVITE_TIMEOUT_MS);
}

function startIncomingRingtone(call) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const audioContext = new AudioContextClass();
    const gain = audioContext.createGain();
    gain.gain.value = 0.0001;
    gain.connect(audioContext.destination);
    const ring = () => {
      if (!state.call || state.call.id !== call.id || state.call.status !== "ringing") return;
      audioContext.resume().catch(() => {});
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.connect(gain);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      oscillator.start(now);
      oscillator.stop(now + 0.55);
    };
    ring();
    call.ringtone = {
      audioContext,
      interval: setInterval(ring, 1600),
    };
  } catch (error) {
    console.warn("Sonnerie d’appel indisponible", error);
  }
}

function updateCallUI() {
  updateCallButtons();
  if (!state.call) {
    elements.callBanner.hidden = true;
    elements.callBanner.classList.remove("navigate");
    elements.callTurnIndicator.hidden = true;
    elements.callTurnIndicator.className = "call-turn-indicator";
    elements.callTurnIndicator.textContent = "";
    elements.callTurnIndicator.removeAttribute("aria-label");
    elements.callTurnIndicator.removeAttribute("title");
    elements.callOpenConversationButton.hidden = true;
    elements.callAcceptButton.hidden = true;
    elements.callRejectButton.hidden = true;
    elements.callHangupButton.hidden = true;
    elements.callMuteButton.hidden = true;
    elements.callCameraButton.hidden = true;
    elements.callFullscreenButton.hidden = true;
    elements.callSwitchCameraButton.hidden = true;
    elements.callScreenShareButton.hidden = true;
    elements.callWhiteboardButton.hidden = true;
    elements.callWhiteboardButton.classList.remove("selected");
    elements.callWhiteboard.hidden = true;
    elements.callBanner.classList.remove("whiteboard-open");
    elements.callBanner.classList.remove("whiteboard-fullscreen");
    elements.callVideoStage.classList.remove("screen-sharing");
    elements.callVideoStage.classList.remove("android-fullscreen");
    return;
  }
  const currentConversation = sameID(state.call.conversationID, state.current?.id);
  const incoming = state.call.direction === "incoming" && state.call.status === "ringing";
  const accepted = state.call.status === "accepted";
  const connecting = state.call.status === "connecting";
  const outgoing = state.call.direction === "outgoing" && state.call.status === "ringing";
  const peerCount = activeCallPeerCount();
  const groupSuffix = isGroupCall() && peerCount ? ` (${peerCount + 1} participants)` : "";
  elements.callBanner.hidden = !currentConversation;
  elements.callBanner.classList.toggle("navigate", false);
  elements.callBannerLabel.textContent = incoming
    ? `${callLabel(state.call.media)} entrant de ${currentCallTitle()}`
    : outgoing
      ? pendingCallLabel(state.call.media)
      : connecting
        ? `${callLabel(state.call.media)} en connexion`
        : `${activeCallLabel(state.call.media)}${groupSuffix}`;
  syncCallRouteIndicator();
  elements.callOpenConversationButton.hidden = true;
  elements.callAcceptButton.hidden = !(currentConversation && incoming);
  elements.callRejectButton.hidden = !(currentConversation && incoming);
  elements.callHangupButton.hidden = !currentConversation || incoming || !(outgoing || connecting || accepted);
  const controlsVisible = currentConversation && (connecting || accepted);
  elements.callMuteButton.hidden = !controlsVisible;
  elements.callCameraButton.hidden = !controlsVisible || state.call.media !== "video";
  elements.callFullscreenButton.hidden = !controlsVisible || state.call.media !== "video";
  elements.callSwitchCameraButton.hidden = !controlsVisible || state.call.media !== "video" || state.call.screenSharing;
  elements.callScreenShareButton.hidden = !controlsVisible;
  elements.callWhiteboardButton.hidden = !controlsVisible || state.call.media !== "video" || !currentConversation;
  elements.callVideoStage.classList.toggle("screen-sharing", Boolean(state.call.screenSharing));
  updateWhiteboardVisibility();
  syncCallControlLabels();
  elements.callVideoStage.hidden = !currentConversation || state.call.media !== "video" || incoming || outgoing;
  elements.remoteCallAudio.hidden = !currentConversation || state.call.media !== "audio" || incoming || outgoing;
  elements.remoteCallAudioPeers.hidden = elements.remoteCallAudioPeers.hidden || !currentConversation || state.call.media !== "audio" || incoming || outgoing;
}

function syncCallControlLabels() {
  if (!state.call?.localStream) {
    setCallActionButton(elements.callMuteButton, "Couper le micro", "mic");
    setCallActionButton(elements.callCameraButton, "Couper la caméra", "video");
    setCallActionButton(elements.callScreenShareButton, "Partager l’écran", "screen-share");
    return;
  }
  const audioTrack = state.call.localStream.getAudioTracks()[0];
  const videoTrack = state.call.localStream.getVideoTracks()[0];
  setCallActionButton(
    elements.callMuteButton,
    audioTrack?.enabled === false ? "Réactiver le micro" : "Couper le micro",
    audioTrack?.enabled === false ? "mic-off" : "mic",
  );
  setCallActionButton(
    elements.callCameraButton,
    state.call.screenSharing
      ? videoTrack?.enabled === false ? "Afficher le partage" : "Masquer le partage"
      : videoTrack?.enabled === false ? "Réactiver la caméra" : "Couper la caméra",
    state.call.screenSharing
      ? videoTrack?.enabled === false ? "screen-off" : "screen"
      : videoTrack?.enabled === false ? "video-off" : "video",
  );
  setCallActionButton(
    elements.callScreenShareButton,
    state.call.screenSharing ? "Arrêter le partage d’écran" : "Partager l’écran",
    state.call.screenSharing ? "screen-stop" : "screen-share",
  );
}

function setCallActionButton(button, label, icon) {
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = callActionIconMarkup(icon);
}

function callActionIconMarkup(icon) {
  const paths = {
    mic: ["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M19 10v2a7 7 0 0 1-14 0v-2", "M12 19v3", "M8 22h8"],
    "mic-off": ["m2 2 20 20", "M9 9v3a3 3 0 0 0 5.12 2.12", "M15 9.34V5a3 3 0 0 0-5.94-.6", "M17 16.95A7 7 0 0 1 5 12v-2", "M19 10v2a6.9 6.9 0 0 1-.7 3", "M12 19v3", "M8 22h8"],
    video: ["M15 10.5V6.8A2.8 2.8 0 0 0 12.2 4H5.8A2.8 2.8 0 0 0 3 6.8v10.4A2.8 2.8 0 0 0 5.8 20h6.4a2.8 2.8 0 0 0 2.8-2.8v-3.7l4.15 3.05A1.15 1.15 0 0 0 21 15.62V8.38a1.15 1.15 0 0 0-1.85-.93L15 10.5Z"],
    "video-off": ["m2 2 20 20", "M10.66 4H5.8A2.8 2.8 0 0 0 3 6.8v10.4A2.8 2.8 0 0 0 5.8 20h6.4A2.8 2.8 0 0 0 15 17.2v-2.54", "M15 10.5V6.8c0-.77-.31-1.47-.82-1.98", "m19.15 7.45 1.7-1.25A1.15 1.15 0 0 1 22 9.13v5.74c0 .91-1.03 1.45-1.78.93L17 13.43"],
    screen: ["M3 5h18v12H3Z", "M8 21h8", "M12 17v4"],
    "screen-off": ["m2 2 20 20", "M9.5 5H21v12h-4", "M13 17H3V7.5", "M8 21h8", "M12 17v4"],
    "screen-share": ["M3 5h18v12H3Z", "M8 21h8", "M12 17v4", "m9 10 3-3 3 3", "M12 7v7"],
    "screen-stop": ["M3 5h18v12H3Z", "M8 21h8", "M12 17v4", "M9 8h6v6H9Z"],
  }[icon] || [];
  return `<svg class="call-action-icon" viewBox="0 0 24 24" aria-hidden="true">${paths.map((path) => `<path d="${path}"></path>`).join("")}</svg>`;
}

function bindWhiteboardControls() {
  elements.callWhiteboard.querySelectorAll("[data-whiteboard-tool]").forEach((button) => {
    button.addEventListener("click", () => setWhiteboardTool(button.dataset.whiteboardTool));
  });
  elements.whiteboardColor.addEventListener("input", () => {
    const board = whiteboardState();
    if (board) board.color = elements.whiteboardColor.value;
  });
  elements.whiteboardSize.addEventListener("input", () => {
    const board = whiteboardState();
    if (board) board.size = Number(elements.whiteboardSize.value) || 4;
  });
  elements.whiteboardUndo.addEventListener("click", undoWhiteboardOperation);
  elements.whiteboardClear.addEventListener("click", clearWhiteboard);
  elements.whiteboardSave.addEventListener("click", saveWhiteboardPNG);
  elements.whiteboardFullscreen.addEventListener("click", toggleWhiteboardFullscreen);
  elements.whiteboardCanvas.addEventListener("pointerdown", startWhiteboardPointer);
  elements.whiteboardCanvas.addEventListener("pointermove", moveWhiteboardPointer);
  elements.whiteboardCanvas.addEventListener("pointerup", finishWhiteboardPointer);
  elements.whiteboardCanvas.addEventListener("pointercancel", cancelWhiteboardPointer);
  window.addEventListener("resize", () => {
    if (!elements.callWhiteboard.hidden) renderWhiteboard();
  });
}

function whiteboardState() {
  if (!state.call) return null;
  if (!state.call.whiteboard) {
    state.call.whiteboard = {
      open: false,
      tool: "pen",
      color: elements.whiteboardColor.value || "#111827",
      size: Number(elements.whiteboardSize.value) || 4,
      operations: [],
      draft: null,
      fullscreen: false,
    };
  }
  return state.call.whiteboard;
}

function toggleWhiteboard() {
  const board = whiteboardState();
  if (!board || state.call.media !== "video") return;
  board.open = !board.open;
  if (!board.open) board.fullscreen = false;
  if (board.open) elements.shell.classList.remove("sidebar-open");
  updateWhiteboardVisibility();
}

function updateWhiteboardVisibility() {
  const board = state.call?.whiteboard || null;
  const visible = Boolean(board?.open && state.call?.media === "video" && sameID(state.call.conversationID, state.current?.id));
  elements.callWhiteboard.hidden = !visible;
  elements.callWhiteboardButton.classList.toggle("selected", visible);
  elements.callBanner.classList.toggle("whiteboard-open", visible);
  elements.callBanner.classList.toggle("whiteboard-fullscreen", Boolean(visible && board.fullscreen));
  elements.whiteboardFullscreen.classList.toggle("selected", Boolean(visible && board.fullscreen));
  if (visible) {
    syncWhiteboardToolbar();
    requestAnimationFrame(renderWhiteboard);
  }
}

function syncWhiteboardToolbar() {
  const board = whiteboardState();
  if (!board) return;
  elements.whiteboardColor.value = board.color;
  elements.whiteboardSize.value = String(board.size);
  elements.whiteboardFullscreen.classList.toggle("selected", Boolean(board.fullscreen));
  elements.whiteboardFullscreen.title = t(board.fullscreen ? "Quitter le plein écran" : "Plein écran");
  elements.whiteboardFullscreen.setAttribute("aria-label", t(board.fullscreen ? "Quitter le plein écran" : "Plein écran"));
  elements.callWhiteboard.querySelectorAll("[data-whiteboard-tool]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.whiteboardTool === board.tool);
  });
}

function setWhiteboardTool(tool) {
  const board = whiteboardState();
  if (!board) return;
  board.tool = tool;
  syncWhiteboardToolbar();
}

function toggleWhiteboardFullscreen() {
  const board = whiteboardState();
  if (!board) return;
  board.fullscreen = !board.fullscreen;
  if (board.fullscreen) elements.shell.classList.remove("sidebar-open");
  updateWhiteboardVisibility();
}

function whiteboardPoint(event) {
  const rect = elements.whiteboardCanvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1))),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(rect.height, 1))),
  };
}

function startWhiteboardPointer(event) {
  const board = whiteboardState();
  if (!board || elements.callWhiteboard.hidden || event.button !== 0) return;
  event.preventDefault();
  const point = whiteboardPoint(event);
  if (board.tool === "text") {
    placeWhiteboardText(point).catch((error) => {
      console.warn("Ajout de texte au tableau impossible", error);
    });
    return;
  }
  elements.whiteboardCanvas.setPointerCapture(event.pointerId);
  const base = {
    id: newWhiteboardOperationID(),
    author: state.me.id,
    tool: board.tool,
    color: board.color,
    size: board.tool === "brush" ? board.size * 2 : board.size,
  };
  board.draft = ["pen", "brush", "eraser"].includes(board.tool)
    ? { ...base, kind: "path", points: [point] }
    : { ...base, kind: board.tool, start: point, end: point };
  renderWhiteboard();
}

function moveWhiteboardPointer(event) {
  const board = whiteboardState();
  if (!board?.draft) return;
  event.preventDefault();
  const point = whiteboardPoint(event);
  if (board.draft.kind === "path") {
    board.draft.points.push(point);
  } else {
    board.draft.end = point;
  }
  renderWhiteboard();
}

function finishWhiteboardPointer(event) {
  const board = whiteboardState();
  if (!board?.draft) return;
  event.preventDefault();
  elements.whiteboardCanvas.releasePointerCapture(event.pointerId);
  const operation = board.draft;
  board.draft = null;
  if (operation.kind === "path" && operation.points.length < 2) return;
  addWhiteboardOperation(operation, true);
}

function cancelWhiteboardPointer(event) {
  const board = whiteboardState();
  if (!board?.draft) return;
  board.draft = null;
  if (elements.whiteboardCanvas.hasPointerCapture(event.pointerId)) {
    elements.whiteboardCanvas.releasePointerCapture(event.pointerId);
  }
  renderWhiteboard();
}

async function placeWhiteboardText(point) {
  const board = whiteboardState();
  if (!board) return;
  const text = await actionDialog({
    title: "Texte",
    inputLabel: "Texte",
    singleLine: true,
    maxLength: 120,
    confirmLabel: "Ajouter",
  });
  if (!text) return;
  addWhiteboardOperation({
    id: newWhiteboardOperationID(),
    author: state.me.id,
    kind: "text",
    tool: "text",
    color: board.color,
    size: Math.max(12, board.size * 5),
    x: point.x,
    y: point.y,
    text,
  }, true);
}

function newWhiteboardOperationID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `wb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function addWhiteboardOperation(operation, broadcast) {
  const board = whiteboardState();
  if (!board || board.operations.some((item) => item.id === operation.id)) return;
  board.operations.push(operation);
  renderWhiteboard();
  if (broadcast) sendWhiteboardPayload({ action: "op", operation });
}

function undoWhiteboardOperation() {
  const board = whiteboardState();
  if (!board?.operations.length) return;
  const index = findLastIndex(board.operations, (operation) => operation.author === state.me.id);
  const fallbackIndex = board.operations.length - 1;
  const [removed] = board.operations.splice(index >= 0 ? index : fallbackIndex, 1);
  renderWhiteboard();
  if (removed) sendWhiteboardPayload({ action: "undo", operation_id: removed.id });
}

function clearWhiteboard() {
  const board = whiteboardState();
  if (!board || !board.operations.length) return;
  board.operations = [];
  board.draft = null;
  renderWhiteboard();
  sendWhiteboardPayload({ action: "clear" });
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

function renderWhiteboard() {
  const board = whiteboardState();
  if (!board) return;
  const canvas = elements.whiteboardCanvas;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  for (const operation of board.operations) drawWhiteboardOperation(context, operation, width, height);
  if (board.draft) drawWhiteboardOperation(context, board.draft, width, height);
}

function drawWhiteboardOperation(context, operation, width, height) {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1, operation.size || 4);
  context.strokeStyle = operation.tool === "eraser" ? "#ffffff" : operation.color || "#111827";
  context.fillStyle = operation.color || "#111827";
  if (operation.kind === "path") {
    const [first, ...rest] = operation.points || [];
    if (!first) {
      context.restore();
      return;
    }
    context.beginPath();
    context.moveTo(first.x * width, first.y * height);
    for (const point of rest) context.lineTo(point.x * width, point.y * height);
    context.stroke();
  } else if (operation.kind === "line") {
    context.beginPath();
    context.moveTo(operation.start.x * width, operation.start.y * height);
    context.lineTo(operation.end.x * width, operation.end.y * height);
    context.stroke();
  } else if (operation.kind === "rect") {
    const x = operation.start.x * width;
    const y = operation.start.y * height;
    context.strokeRect(x, y, operation.end.x * width - x, operation.end.y * height - y);
  } else if (operation.kind === "ellipse") {
    const centerX = ((operation.start.x + operation.end.x) / 2) * width;
    const centerY = ((operation.start.y + operation.end.y) / 2) * height;
    const radiusX = Math.max(1, Math.abs(operation.end.x - operation.start.x) * width / 2);
    const radiusY = Math.max(1, Math.abs(operation.end.y - operation.start.y) * height / 2);
    context.beginPath();
    context.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
    context.stroke();
  } else if (operation.kind === "text") {
    context.font = `${Math.max(10, operation.size || 20)}px system-ui, sans-serif`;
    context.textBaseline = "top";
    context.fillText(operation.text || "", operation.x * width, operation.y * height);
  }
  context.restore();
}

function saveWhiteboardPNG() {
  renderWhiteboard();
  elements.whiteboardCanvas.toBlob((blob) => {
    if (!blob) {
      toast("Export PNG impossible.", "error");
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `tableau-blanc-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, "image/png");
}

function setupWhiteboardChannel(peerState, channel) {
  peerState.whiteboardChannel = channel;
  channel.onopen = () => sendWhiteboardState(channel);
  channel.onmessage = (event) => receiveWhiteboardPayload(event.data);
  channel.onclose = () => {
    if (peerState.whiteboardChannel === channel) peerState.whiteboardChannel = null;
  };
}

function sendWhiteboardState(channel) {
  const board = whiteboardState();
  if (!board || channel.readyState !== "open") return;
  channel.send(JSON.stringify({
    type: WHITEBOARD_MESSAGE_TYPE,
    action: "state",
    operations: board.operations,
  }));
}

function sendWhiteboardPayload(payload) {
  if (!state.call?.peers) return;
  const message = JSON.stringify({ type: WHITEBOARD_MESSAGE_TYPE, ...payload });
  for (const peerState of state.call.peers.values()) {
    const channel = peerState.whiteboardChannel;
    if (channel?.readyState === "open") channel.send(message);
  }
}

function receiveWhiteboardPayload(data) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (payload?.type !== WHITEBOARD_MESSAGE_TYPE) return;
  const board = whiteboardState();
  if (!board) return;
  if (payload.action === "state" && Array.isArray(payload.operations)) {
    const known = new Set(board.operations.map((operation) => operation.id));
    for (const operation of payload.operations) {
      if (operation?.id && !known.has(operation.id)) {
        board.operations.push(operation);
        known.add(operation.id);
      }
    }
  } else if (payload.action === "op" && payload.operation?.id) {
    if (!board.operations.some((operation) => operation.id === payload.operation.id)) {
      board.operations.push(payload.operation);
    }
  } else if (payload.action === "undo" && payload.operation_id) {
    board.operations = board.operations.filter((operation) => operation.id !== payload.operation_id);
  } else if (payload.action === "clear") {
    board.operations = [];
    board.draft = null;
  }
  if (!elements.callWhiteboard.hidden) renderWhiteboard();
}

function toggleCallMicrophone() {
  const track = state.call?.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  syncCallControlLabels();
}

function toggleCallCamera() {
  const track = state.call?.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  syncCallControlLabels();
}

function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent || "");
}

function syncAndroidFullscreenExitButton() {
  const stageFullscreen = document.fullscreenElement === elements.callVideoStage
    || document.webkitFullscreenElement === elements.callVideoStage;
  elements.callVideoStage.classList.toggle("android-fullscreen", Boolean(isAndroidDevice() && stageFullscreen));
}

function handleCallFullscreenChange() {
  syncAndroidFullscreenExitButton();
  scheduleCallVideoPlaybackResume();
}

async function enterCallFullscreen() {
  if (!state.call || state.call.media !== "video") return;
  const target = elements.callVideoStage;
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await exitCallFullscreen();
      return;
    }
    if (target.requestFullscreen) {
      if (isAndroidDevice()) elements.callVideoStage.classList.add("android-fullscreen");
      await target.requestFullscreen({ navigationUI: "hide" });
    } else if (target.webkitRequestFullscreen) {
      if (isAndroidDevice()) elements.callVideoStage.classList.add("android-fullscreen");
      target.webkitRequestFullscreen();
    } else if (elements.remoteCallVideo.webkitEnterFullscreen) {
      elements.remoteCallVideo.webkitEnterFullscreen();
    } else {
      toast("Le plein écran vidéo n’est pas disponible dans ce navigateur.", "error");
    }
  } catch (error) {
    syncAndroidFullscreenExitButton();
    scheduleCallVideoPlaybackResume();
    toast(frenchErrorMessage(error, "Impossible d’afficher la vidéo en plein écran."), "error");
  }
}

async function exitCallFullscreen() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (elements.remoteCallVideo.webkitDisplayingFullscreen && elements.remoteCallVideo.webkitExitFullscreen) {
      elements.remoteCallVideo.webkitExitFullscreen();
    }
  } catch (error) {
    console.warn("Sortie du plein écran vidéo impossible", error);
  } finally {
    syncAndroidFullscreenExitButton();
    scheduleCallVideoPlaybackResume();
  }
}

async function switchCallCamera() {
  if (!state.call || state.call.media !== "video" || state.call.screenSharing || !state.call.peers?.size) return;
  const nextFacingMode = state.call.facingMode === "user" ? "environment" : "user";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: nextFacingMode } });
    const [nextTrack] = stream.getVideoTracks();
    if (!nextTrack) throw new Error("Caméra indisponible.");
    const previousVideoEnabled = state.call.localStream.getVideoTracks()[0]?.enabled;
    if (previousVideoEnabled === false) nextTrack.enabled = false;
    await replaceLocalCallVideoTrack(nextTrack);
    state.call.facingMode = nextFacingMode;
    syncCallControlLabels();
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de changer de caméra."), "error");
  }
}

async function toggleScreenShare() {
  if (!state.call) return;
  if (state.call.media !== "video") {
    toast("Le partage d’écran est disponible dans un appel vidéo.", "error");
    return;
  }
  if (state.call.screenSharing) await stopScreenShare();
  else await startScreenShare();
}

async function startScreenShare() {
  if (!state.call || state.call.media !== "video") return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast(screenShareUnavailableMessage(), "error");
    return;
  }
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "always" },
      audio: false,
    });
    const [screenTrack] = displayStream.getVideoTracks();
    if (!screenTrack) throw new Error("Aucune piste d’écran disponible.");
    if (!state.call || state.call.media !== "video") {
      displayStream.getTracks().forEach((track) => track.stop());
      return;
    }
    const call = state.call;
    screenTrack.addEventListener("ended", () => {
      if (state.call === call && call.screenSharing) {
        stopScreenShare().catch((error) => {
          console.warn("Arrêt du partage d’écran impossible", error);
        });
      }
    }, { once: true });
    call.screenStream = displayStream;
    call.screenSharing = true;
    await replaceLocalCallVideoTrack(screenTrack);
    updateCallUI();
  } catch (error) {
    state.call?.screenStream?.getTracks().forEach((track) => track.stop());
    if (state.call) {
      state.call.screenStream = null;
      state.call.screenSharing = false;
    }
    toast(frenchErrorMessage(error, "Impossible de partager l’écran."), "error");
    updateCallUI();
  }
}

function screenShareUnavailableMessage() {
  if (!window.isSecureContext) return "Le partage d’écran nécessite HTTPS ou localhost.";
  if (!navigator.mediaDevices) return "Les médias du navigateur sont indisponibles dans ce contexte.";
  return "Le partage d’écran n’est pas disponible dans ce navigateur ou cette vue.";
}

async function stopScreenShare() {
  if (!state.call || state.call.media !== "video") return;
  const call = state.call;
  const wasScreenSharing = Boolean(call.screenSharing);
  call.screenSharing = false;
  call.screenStream?.getTracks().forEach((track) => track.stop());
  call.screenStream = null;
  if (!wasScreenSharing) {
    updateCallUI();
    return;
  }
  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: call.facingMode || "user" },
    });
    const [cameraTrack] = cameraStream.getVideoTracks();
    if (!cameraTrack) throw new Error("Caméra indisponible.");
    await replaceLocalCallVideoTrack(cameraTrack);
  } catch (error) {
    await replaceLocalCallVideoTrack(null);
    toast(frenchErrorMessage(error, "Partage arrêté, caméra indisponible."), "error");
  } finally {
    updateCallUI();
  }
}

async function replaceLocalCallVideoTrack(nextTrack) {
  const call = state.call;
  if (!call?.localStream) {
    nextTrack?.stop();
    return;
  }
  const senders = [...callPeers(call).values()]
    .map((peerState) => peerState.peer?.getSenders().find((item) => item.track?.kind === "video"))
    .filter(Boolean);
  await Promise.all(senders.map((sender) => sender.replaceTrack(nextTrack || null)));
  if (state.call !== call) {
    nextTrack?.stop();
    return;
  }
  for (const track of call.localStream.getVideoTracks()) {
    call.localStream.removeTrack(track);
    if (track !== nextTrack) track.stop();
  }
  if (nextTrack) call.localStream.addTrack(nextTrack);
  configureCallVideoElement(elements.localCallVideo);
  elements.localCallVideo.srcObject = call.localStream;
  resumeCallVideoPlayback();
  syncCallControlLabels();
}

async function ensureLocalCallStream() {
  if (state.call.localStream) return state.call.localStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Le microphone ou la caméra n’est pas disponible dans cet environnement.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: state.call.media === "video" ? { facingMode: state.call.facingMode || "user" } : false,
  });
  state.call.localStream = stream;
  if (state.call.media === "video") {
    configureCallVideoElement(elements.localCallVideo);
    elements.localCallVideo.srcObject = stream;
    resumeCallVideoPlayback();
  }
  return stream;
}

async function ensureCallPeer(userID) {
  if (!state.call) throw new Error("Aucun appel actif.");
  const peerState = getCallPeer(userID);
  if (!peerState) throw new Error("Participant d’appel introuvable.");
  if (peerState.peer) return peerState.peer;
  if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC n’est pas disponible dans ce navigateur.");
  const peer = new RTCPeerConnection(await callRTCConfiguration());
  peerState.peer = peer;
  peerState.pendingCandidates ||= [];
  peer.onicecandidate = ({ candidate }) => {
    if (!candidate || !state.call) return;
    sendCallSignal("ice_candidate", {
      call_id: state.call.id,
      media: state.call.media,
      target_user_id: userID,
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      },
    });
  };
  peer.ontrack = ({ streams }) => {
    const [stream] = streams;
    if (!stream) return;
    attachRemoteCallStream(peerState, stream);
  };
  peer.ondatachannel = ({ channel }) => {
    if (channel?.label === WHITEBOARD_MESSAGE_TYPE) setupWhiteboardChannel(peerState, channel);
  };
  if (isCallNegotiationInitiator(userID)) {
    setupWhiteboardChannel(peerState, peer.createDataChannel(WHITEBOARD_MESSAGE_TYPE));
  }
  peer.onconnectionstatechange = () => {
    if (!state.call) return;
    if (peer.connectionState === "connected") {
      peerState.connected = true;
      resetPeerIceRestartState(peerState);
      state.call.status = "accepted";
      refreshCallRouteIndicator(peerState).catch(() => {});
      updateCallUI();
    } else if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
      handleCallPeerConnectionFailure(peerState, userID);
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (!state.call) return;
    if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
      resetPeerIceRestartState(peerState);
      return;
    }
    if (peer.iceConnectionState === "failed" || peer.iceConnectionState === "disconnected") {
      handleCallPeerConnectionFailure(peerState, userID);
    }
  };
  peer.onsignalingstatechange = () => {
    if (!state.call || peer.signalingState !== "stable" || !peerState.needsIceRestart) return;
    if (!isCallNegotiationInitiator(userID) || state.socket?.socket?.readyState !== WebSocket.OPEN) return;
    restartPeerIce(peerState, userID).catch((error) => {
      console.warn("Reprise ICE après négociation impossible", error);
      finishCallPeerConnectionFailure(userID);
    });
  };
  const stream = await ensureLocalCallStream();
  for (const track of stream.getTracks()) peer.addTrack(track, stream);
  return peer;
}

function attachRemoteCallStream(peerState, stream) {
  peerState.remoteStream = stream;
  if (state.call?.media === "video") {
    let video = peerState.videoElement;
    if (!video) {
      if (!elements.remoteCallVideo.srcObject && !elements.remoteCallVideo.dataset.peerId) {
        video = elements.remoteCallVideo;
      } else {
        video = document.createElement("video");
        elements.remoteCallVideos.append(video);
      }
      configureCallVideoElement(video);
      video.dataset.peerId = String(peerState.userID);
      peerState.videoElement = video;
    }
    video.hidden = false;
    video.srcObject = stream;
    elements.callVideoStage.hidden = false;
    resumeCallVideoPlayback();
  } else {
    let audio = peerState.audioElement;
    if (!audio) {
      if (!elements.remoteCallAudio.srcObject && !elements.remoteCallAudio.dataset.peerId) {
        audio = elements.remoteCallAudio;
      } else {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.controls = true;
        elements.remoteCallAudioPeers.append(audio);
      }
      audio.dataset.peerId = String(peerState.userID);
      peerState.audioElement = audio;
    }
    audio.srcObject = stream;
    audio.hidden = false;
    elements.remoteCallAudioPeers.hidden = !elements.remoteCallAudioPeers.children.length;
    audio.play().catch(() => {});
  }
  updateCallUI();
}

async function callRTCConfiguration() {
  if (!state.callConfig) {
    state.callConfig = api("/api/calls/config")
      .then((config) => {
        const iceServers = Array.isArray(config.ice_servers) && config.ice_servers.length
          ? config.ice_servers
          : [{ urls: "stun:stun.l.google.com:19302" }];
        const publicFallbackURLs = Array.isArray(config.public_fallback_urls) && config.public_fallback_urls.length
          ? config.public_fallback_urls
          : ["stun:stun.l.google.com:19302"];
        return {
          rtcConfig: { iceServers },
          publicFallbackURLs,
          privateTurnURLs: iceServers.flatMap((server) => urlsOfIceServer(server))
            .filter((url) => /^turns?:/i.test(url) && !publicFallbackURLs.includes(url)),
          privateTurnConfigured: Boolean(config.private_turn_configured),
        };
      })
      .catch((error) => {
        console.warn("Configuration WebRTC indisponible, STUN par défaut utilisé", error);
        return {
          rtcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
          publicFallbackURLs: ["stun:stun.l.google.com:19302"],
          privateTurnURLs: [],
          privateTurnConfigured: false,
        };
      });
  }
  const config = await state.callConfig;
  return config.rtcConfig;
}

function urlsOfIceServer(server) {
  if (!server?.urls) return [];
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

async function callNetworkConfig() {
  if (!state.callConfig) await callRTCConfiguration();
  return state.callConfig;
}

function syncCallRouteIndicator() {
  if (!state.call) return;
  const peerStates = [...callPeers().values()];
  const route = peerStates.find((peerState) => peerState.routeKind)?.routeKind || state.call.routeKind;
  if (!route) {
    callNetworkConfig().then((config) => {
      if (!state.call || state.call.routeKind) return;
      state.call.routeKind = config.privateTurnConfigured ? "coturn" : "public";
      syncCallRouteIndicator();
    }).catch(() => {});
    elements.callTurnIndicator.hidden = true;
    return;
  }
  elements.callTurnIndicator.hidden = false;
  elements.callTurnIndicator.className = `call-turn-indicator ${route === "coturn" ? "coturn" : "public"}`;
  const label = route === "coturn" ? "Connexion via Coturn privé" : "Connexion via STUN public";
  elements.callTurnIndicator.textContent = "";
  elements.callTurnIndicator.setAttribute("aria-label", label);
  elements.callTurnIndicator.title = label;
}

async function refreshCallRouteIndicator(peerState) {
  const localCandidate = await selectedLocalCandidate(peerState.peer);
  if (!localCandidate || !state.call) return;
  const config = await callNetworkConfig();
  const sourceURL = localCandidate.url || "";
  if (localCandidate.candidateType === "relay" && config.privateTurnURLs.some((url) => sourceURL.startsWith(url))) {
    peerState.routeKind = "coturn";
  } else if (localCandidate.candidateType === "relay" && sourceURL) {
    peerState.routeKind = "public";
  } else if (config.publicFallbackURLs.some((url) => sourceURL.startsWith(url)) || localCandidate.candidateType === "srflx") {
    peerState.routeKind = "public";
  } else if (config.privateTurnConfigured) {
    peerState.routeKind = "coturn";
  } else {
    peerState.routeKind = "public";
  }
  state.call.routeKind = peerState.routeKind;
  syncCallRouteIndicator();
}

async function selectedLocalCandidate(peer) {
  if (!peer?.getStats) return null;
  const stats = await peer.getStats();
  let selectedPair = null;
  for (const item of stats.values()) {
    if (item.type === "transport" && item.selectedCandidatePairId) {
      selectedPair = stats.get(item.selectedCandidatePairId);
      break;
    }
    if (item.type === "candidate-pair" && item.selected && item.state === "succeeded") {
      selectedPair = item;
    }
  }
  if (!selectedPair?.localCandidateId) return null;
  return stats.get(selectedPair.localCandidateId) || null;
}

function isCallNegotiationInitiator(userID) {
  return Boolean(state.me?.id && userID && state.me.id < userID);
}

function callPeerIsConnected(peerState) {
  return peerState?.peer?.connectionState === "connected";
}

function handleCallParticipantOffline(userID) {
  const numericUserID = Number(userID);
  const peerState = state.call?.peers?.get(numericUserID);
  if (!peerState?.peer || state.call?.closing) return;
  handleCallPeerConnectionFailure(peerState, numericUserID);
}

function startPeerIceRestartTimeout(peerState, userID) {
  clearPeerIceRestartTimer(peerState);
  const call = state.call;
  peerState.iceRestartTimeout = setTimeout(() => {
    peerState.iceRestartTimeout = null;
    if (!state.call || state.call !== call || callPeerIsConnected(peerState)) return;
    finishCallPeerConnectionFailure(userID);
  }, CALL_ICE_RESTART_TIMEOUT_MS);
}

function resetPeerIceRestartState(peerState) {
  if (!peerState) return;
  peerState.needsIceRestart = false;
  peerState.iceRestarting = false;
  peerState.iceRestartAttempts = 0;
  clearPeerIceRestartTimer(peerState);
}

function handleCallPeerConnectionFailure(peerState, userID) {
  if (!state.call || !peerState?.peer || peerState.iceRestarting) return;
  if (peerState.needsIceRestart && peerState.iceRestartTimeout) return;
  peerState.needsIceRestart = true;
  if (isCallNegotiationInitiator(userID)) {
    restartPeerIce(peerState, userID).catch((error) => {
      console.warn("Reprise ICE impossible", error);
      finishCallPeerConnectionFailure(userID);
    });
    return;
  }
  startPeerIceRestartTimeout(peerState, userID);
  toast("Connexion média instable. Tentative de reprise de l’appel.", "error");
}

async function restartPeerIce(peerState, userID) {
  if (!state.call || !peerState?.peer || callPeerIsConnected(peerState)) return;
  if (state.socket?.socket?.readyState !== WebSocket.OPEN) {
    startPeerIceRestartTimeout(peerState, userID);
    return;
  }
  if (peerState.iceRestartAttempts >= CALL_ICE_RESTART_MAX_ATTEMPTS) {
    finishCallPeerConnectionFailure(userID);
    return;
  }
  if (peerState.peer.signalingState !== "stable") {
    startPeerIceRestartTimeout(peerState, userID);
    return;
  }
  peerState.needsIceRestart = false;
  peerState.iceRestarting = true;
  peerState.iceRestartAttempts += 1;
  peerState.peer.restartIce?.();
  const offer = await peerState.peer.createOffer({ iceRestart: true });
  await peerState.peer.setLocalDescription(offer);
  sendCallSignal("call_offer", {
    call_id: state.call.id,
    media: state.call.media,
    target_user_id: userID,
    sdp: { type: peerState.peer.localDescription.type, sdp: peerState.peer.localDescription.sdp },
  });
  startPeerIceRestartTimeout(peerState, userID);
  toast("Connexion média instable. Reprise de l’appel en cours.", "error");
}

function resumePendingCallIceRestarts() {
  if (!state.call?.peers) return;
  for (const peerState of state.call.peers.values()) {
    if (!peerState.needsIceRestart || !isCallNegotiationInitiator(peerState.userID)) continue;
    restartPeerIce(peerState, peerState.userID).catch((error) => {
      console.warn("Reprise ICE différée impossible", error);
      finishCallPeerConnectionFailure(peerState.userID);
    });
  }
}

function finishCallPeerConnectionFailure(userID) {
  if (!state.call) return;
  const peerState = state.call.peers?.get(userID);
  if (callPeerIsConnected(peerState)) return;
  if (isGroupCall()) {
    removeCallPeer(userID);
    toast("Un participant a perdu la connexion d’appel.", "error");
  } else {
    toast("Connexion d’appel interrompue.", "error");
    hangupCall("connection_failed");
  }
}

async function addPendingIceCandidates(userID) {
  const peerState = getCallPeer(userID);
  if (!peerState?.peer || !peerState.pendingCandidates?.length) return;
  const candidates = peerState.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    await peerState.peer.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

async function beginOutgoingPeerOffer(userID) {
  clearCallAlerts();
  state.call.status = "connecting";
  updateCallUI();
  const peer = await ensureCallPeer(userID);
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  sendCallSignal("call_offer", {
    call_id: state.call.id,
    media: state.call.media,
    target_user_id: userID,
    sdp: { type: peer.localDescription.type, sdp: peer.localDescription.sdp },
  });
}

async function maybeBeginOutgoingPeerOffer(userID) {
  if (!state.call || !userID || userID === state.me.id) return;
  if (state.call.peers?.get(userID)?.peer) return;
  if (state.me.id > userID) return;
  await beginOutgoingPeerOffer(userID);
}

async function connectAcceptedCallPeers() {
  if (!state.call?.acceptedUserIDs) return;
  for (const userID of state.call.acceptedUserIDs) {
    await maybeBeginOutgoingPeerOffer(userID);
  }
}

async function acceptRemoteOffer(userID, sdp) {
  clearCallAlerts();
  state.call.status = "connecting";
  updateCallUI();
  const peer = await ensureCallPeer(userID);
  const peerState = getCallPeer(userID);
  const recoveringIce = Boolean(peer.remoteDescription || peerState?.needsIceRestart || peerState?.iceRestarting || peerState?.iceRestartTimeout);
  if (recoveringIce) clearPeerIceRestartTimer(peerState);
  await peer.setRemoteDescription(new RTCSessionDescription(sdp));
  await addPendingIceCandidates(userID);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  sendCallSignal("call_answer", {
    call_id: state.call.id,
    media: state.call.media,
    target_user_id: userID,
    sdp: { type: peer.localDescription.type, sdp: peer.localDescription.sdp },
  });
  if (recoveringIce && peerState) {
    peerState.needsIceRestart = false;
    peerState.iceRestarting = true;
    startPeerIceRestartTimeout(peerState, userID);
  }
}

async function acceptRemoteAnswer(userID, sdp) {
  const peerState = getCallPeer(userID);
  if (!peerState?.peer) return;
  await peerState.peer.setRemoteDescription(new RTCSessionDescription(sdp));
  await addPendingIceCandidates(userID);
  peerState.needsIceRestart = false;
}

async function handleRemoteIceCandidate(userID, candidate) {
  if (!candidate) return;
  const peerState = getCallPeer(userID);
  if (!peerState?.peer || !peerState.peer.remoteDescription) {
    peerState.pendingCandidates ||= [];
    peerState.pendingCandidates.push(candidate);
    return;
  }
  await peerState.peer.addIceCandidate(new RTCIceCandidate(candidate));
}

function removeCallPeer(userID) {
  const peerState = state.call?.peers?.get(userID);
  if (!peerState) return;
  closeCallPeer(peerState);
  state.call.peers.delete(userID);
  updateCallUI();
  refreshConversationCallIndicators();
}

async function handleCallSignal(event) {
  if (event.user_id === state.me.id) return;
  if (event.target_user_id && event.target_user_id !== state.me.id) return;
  const conversation = state.conversations.find((item) => sameID(item.id, event.conversation_id));
  if (!conversation || !["private", "group"].includes(conversation.type)) return;
  if (event.type === "call_invite") {
    if (state.call) {
      state.socket.send({
        type: "call_reject",
        conversation_id: event.conversation_id,
        call_id: event.call_id,
        media: event.media || "audio",
        reason: "busy",
        target_user_id: event.user_id,
      });
      return;
    }
    const callerName = await memberDisplayName(event.conversation_id, event.user_id, "un contact");
    const conversationTitle = await resolveConversationTitle(conversation).catch(() => callerName);
    state.call = {
      id: event.call_id,
      conversationID: event.conversation_id,
      media: event.media || "audio",
      direction: "incoming",
      status: "ringing",
      facingMode: "user",
      callerID: event.user_id,
      callerName: conversation.type === "group" ? `${callerName} (${conversationTitle})` : callerName,
      peers: new Map(),
      acceptedUserIDs: new Set([event.user_id]),
    };
    startIncomingCallAlerts(state.call);
    showIncomingCallNotification(`${callLabel(state.call.media)} entrant`, `${callerName} vous appelle.`).catch(() => {});
    if (!sameID(state.current?.id, event.conversation_id)) {
      toast(`${callLabel(state.call.media)} entrant de ${callerName}. Ouvrez la conversation pour répondre.`);
    }
    updateCallUI();
    refreshConversationCallIndicators();
    return;
  }
  if (!state.call || state.call.id !== event.call_id || !sameID(state.call.conversationID, event.conversation_id)) return;
  if (event.type === "call_accept") {
    state.call.acceptedUserIDs ||= new Set();
    state.call.acceptedUserIDs.add(event.user_id);
    if (!["ringing", "connecting", "accepted"].includes(state.call.status)) return;
    if (state.call.direction === "incoming" && state.call.status === "ringing") return;
    if (state.call.peers?.get(event.user_id)?.peer) return;
    try {
      clearCallAlerts();
      state.call.status = "connecting";
      updateCallUI();
      refreshConversationCallIndicators();
      await maybeBeginOutgoingPeerOffer(event.user_id);
    } catch (error) {
      toast(frenchErrorMessage(error, "Impossible de démarrer l’appel."), "error");
      if (isGroupCall()) {
        sendCallSignal("call_hangup", {
          call_id: state.call.id,
          media: state.call.media,
          reason: "media_error",
          target_user_id: event.user_id,
        });
        removeCallPeer(event.user_id);
      } else {
        hangupCall("media_error");
      }
    }
  } else if (event.type === "call_reject") {
    if (state.call.direction === "outgoing" && !isGroupCall() && ["busy", "timeout", "media_error"].includes(event.reason)) {
      const text = event.reason === "busy"
        ? `${callHistoryLabel(state.call.media)} impossible : correspondant occupé.`
        : event.reason === "media_error"
          ? `${callHistoryLabel(state.call.media)} impossible : média indisponible.`
          : `${callHistoryLabel(state.call.media)} manqué.`;
      logCallHistory(state.call, text);
    }
    if (isGroupCall()) {
      const name = await memberDisplayName(event.conversation_id, event.user_id);
      toast(`${name} : ${callRejectMessage(event.reason)}`);
    } else {
      toast(callRejectMessage(event.reason));
      clearCallState();
    }
  } else if (event.type === "call_hangup") {
    if (isGroupCall() && event.user_id !== state.call.callerID) {
      removeCallPeer(event.user_id);
      toast("Un participant a quitté l’appel.");
      if (!activeCallPeerCount() && state.call.direction === "outgoing" && state.call.status !== "ringing") clearCallState();
    } else {
      const wasMissed = state.call.direction === "incoming" && state.call.status === "ringing";
      toast(wasMissed ? "Appel manqué." : "Appel terminé.");
      clearCallState();
    }
  } else if (event.type === "call_offer") {
    if (!["accepted", "connecting"].includes(state.call.status)) return;
    try {
      await acceptRemoteOffer(event.user_id, event.sdp);
    } catch (error) {
      toast(frenchErrorMessage(error, "Impossible d’accepter l’appel."), "error");
      hangupCall("media_error");
    }
  } else if (event.type === "call_answer") {
    await acceptRemoteAnswer(event.user_id, event.sdp);
  } else if (event.type === "ice_candidate") {
    if (!["accepted", "connecting"].includes(state.call.status)) return;
    await handleRemoteIceCandidate(event.user_id, event.candidate);
  }
}

async function loadMessages(targetMessageID = null, useCache = true) {
  const conversation = state.current;
  if (!conversation) return;
  const conversationID = conversation.id;
  closeReactionPicker();
  let cachedDisplayed = false;
  let displayedMessages = null;
  let prepared = null;
  if (!targetMessageID && useCache) {
    prepared = preparedConversationMessages(conversation);
    if (prepared && sameID(state.current?.id, conversationID)) {
      try {
        await renderMessages(prepared.messages, conversation, prepared.decrypted);
        cachedDisplayed = true;
        displayedMessages = prepared.messages;
        await scrollMessagesToLatest(conversationID);
      } catch (error) {
        console.warn("Affichage du préchargement impossible", error);
      }
    } else {
      const cachedMessages = await state.cache?.getMessages(conversationID);
      if (cachedMessages?.length && sameID(state.current?.id, conversationID)) {
        try {
          await renderMessages(cachedMessages, conversation);
          cachedDisplayed = true;
          displayedMessages = cachedMessages;
          await scrollMessagesToLatest(conversationID);
        } catch (error) {
          console.warn("Affichage du cache local impossible", error);
        }
      }
    }
  }
  try {
    let messages;
    if (targetMessageID) {
      const target = Number(targetMessageID);
      const [older, newer] = await Promise.all([
        api(`/api/conversations/${conversationID}/messages?limit=25&before=${target + 1}`),
        api(`/api/conversations/${conversationID}/messages?limit=25&after=${target}`),
      ]);
      if (!sameID(state.current?.id, conversationID)) return;
      messages = [...new Map([...older, ...newer].map((message) => [String(message.id), message])).values()]
        .sort((left, right) => Number(left.id) - Number(right.id));
      state.cache?.putMessages(messages);
    } else {
      if (useCache && prepared && Date.now() - prepared.loadedAt <= BACKGROUND_PRELOAD_NETWORK_FRESH_MS) return;
      if (useCache) {
        const pending = state.conversationPreloads.get(conversationPreloadKey(conversationID));
        if (pending) {
          prepared = await pending.catch(() => null);
          if (!sameID(state.current?.id, conversationID)) return;
          if (prepared) {
            await renderMessages(prepared.messages, conversation, prepared.decrypted);
            return;
          }
        }
      }
      messages = await api(`/api/conversations/${conversationID}/messages?limit=50`);
      if (!sameID(state.current?.id, conversationID)) return;
      state.cache?.replaceMessages(conversationID, messages);
    }
    // Safari laisse le premier rendu Office visible assez longtemps pour que
    // la reconstruction cache -> réseau ressemble à un double aperçu. Si la
    // réponse réseau est identique au snapshot déjà affiché, conserver le DOM
    // actuel évite ce second rendu sans masquer les véritables changements.
    if (cachedDisplayed && sameMessageSnapshots(displayedMessages, messages, ["status"])) {
      updateRenderedMessageStatuses(messages);
      return;
    }
    await renderMessages(messages, conversation);
  } catch (error) {
    if (cachedDisplayed && sameID(state.current?.id, conversationID)) {
      console.warn("Synchronisation de la discussion impossible, cache local conservé", error);
      return;
    }
    throw error;
  }
}

function updateRenderedMessageStatuses(messages) {
  for (const message of messages) {
    if (!sameID(message.sender_id, state.me?.id)) continue;
    const time = elements.messages.querySelector(`[data-id="${message.id}"] time`);
    if (!time) continue;
    const status = { sent: " ✓", delivered: " ✓✓", read: " ✓✓" }[message.status] || "";
    time.textContent = `${time.textContent.replace(/\s✓✓?$/, "")}${status}`;
    time.classList.toggle("read", message.status === "read");
  }
}

async function renderMessages(messages, conversation, preparedDecrypted = null) {
  const conversationID = conversation.id;
  if (!sameID(state.current?.id, conversationID)) return;
  clearRenderedFilePreviews();
  clearConversationMessageExpirations(conversationID);
  state.messageClears.set(conversationID, new Map());
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.id = "empty-chat";
    empty.textContent = t("Aucun message. Écrivez le premier message chiffré.");
    elements.messages.replaceChildren(empty);
    return;
  }
  const decrypted = preparedDecrypted || await Promise.all(messages.map(async (message) => {
    const key = await getMessageKey(message, conversation);
    return { message, key, clear: await decryptMessageContent(message, key) };
  }));
  if (!sameID(state.current?.id, conversationID)) return;
  prefetchRecentFileThumbnails(decrypted);
  prewarmFilePreviewRenderers(decrypted);
  prefetchRecentFullFilePreviews(decrypted);
  const clearByID = messageClearCache(conversationID);
  for (const { message, clear } of [...decrypted].reverse()) {
    clearByID.set(message.id, { clear, keyEpoch: messageKeyEpoch(message, conversation) });
  }
  const fragment = document.createDocumentFragment();
  const previews = [];
  for (const { message, clear, key } of decrypted) {
    if (!scheduleMessageExpiration(message)) continue;
    const displayMessage = withReplyPreview(messageWithCurrentUserProfile(message), clearByID);
    renderMessage(
      fragment,
      displayMessage,
      clear,
      displayMessage.sender_id === state.me.id,
      (fileMessage, preview) => previews.push([fileMessage, preview, key]),
      downloadFile,
      editMessage,
      deleteMessage,
      setReplyTarget,
      reactToMessage,
      togglePinnedMessage,
      (replyPreview, container) => scheduleReplyFilePreview(replyPreview, container, conversation),
      votePoll,
      openFileShareDialog,
    );
    if (message.sender_id !== state.me.id) {
      api(`/api/messages/${message.id}/read`, { method: "POST", body: {} }).catch(() => {});
    }
  }
  elements.messages.replaceChildren(fragment);
  for (const [message, preview, key] of previews) scheduleFilePreview(message, preview, key);
}

async function decryptMessageContent(message, key) {
  try {
    const signature = await verifyStoredMessageSignature(message);
    message.signature_valid = signature.legacy ? null : signature.valid;
    if (!signature.legacy && !signature.valid) throw new Error("invalid authenticated message");
    if (message.file) {
      return {
          name: await decryptEnvelope(key, message.file.encrypted_name),
          mime: await decryptEnvelope(key, message.file.encrypted_mime),
          fileID: message.file.id,
          size: message.file.size,
          hasPreview: message.file.has_preview === true,
          previewSize: message.file.preview_size || 0,
        };
    }
    const clear = await decryptText(key, message.encrypted_content, message.iv);
    if (message.poll) {
      const poll = JSON.parse(clear);
      if (poll?.v !== 1 || typeof poll.question !== "string" || !Array.isArray(poll.options)) throw new Error("invalid poll");
      return poll;
    }
    if (message.event) {
      const event = JSON.parse(clear);
      if (event?.v !== 1 || event.type !== "event" || typeof event.name !== "string") throw new Error("invalid event");
      return event;
    }
    return clear;
  } catch {
    const invalidSignature = message.signature_valid === false;
    if (message.poll) return { v: 1, question: t(invalidSignature ? "Sondage bloqué : signature invalide" : "Sondage impossible à déchiffrer"), options: [] };
    if (message.event) return { v: 1, type: "event", name: t(invalidSignature ? "Évènement bloqué : signature invalide" : "Évènement impossible à déchiffrer"), description: "", location: "" };
    return message.file
      ? { name: t(invalidSignature ? "Fichier bloqué : signature invalide" : "Fichier impossible à déchiffrer"), mime: "application/octet-stream", fileID: message.file.id, size: message.file.size }
      : t(invalidSignature ? "Message bloqué : signature invalide" : "Contenu impossible à déchiffrer");
  }
}

async function verifyStoredMessageSignature(message) {
  if (!message?.signature_version) return { valid: false, legacy: true };
  let members = await getMembers(message.conversation_id);
  let sender = members.find((member) => sameID(member.user_id, message.sender_id));
  if (!sender?.signing_public_key || sender.signing_key_id !== message.signing_key_id) {
    members = await getMembers(message.conversation_id, { fresh: true });
    sender = members.find((member) => sameID(member.user_id, message.sender_id));
  }
  if (!sender?.signing_public_key || sender.signing_key_id !== message.signing_key_id) return { valid: false, legacy: false };
  return verifyMessagePayload(sender.signing_public_key, message);
}

function replyLabel(message, clear) {
  const author = message.sender_id === state.me.id ? "Vous" : message.sender_username;
  const text = message.file ? clear.name : message.poll ? `Sondage : ${clear.question}` : message.event ? `Évènement : ${clear.name}` : String(clear || "");
  return `${author} : ${text}`.slice(0, 120);
}

function isCallHistoryText(clear) {
  return typeof clear === "string" && /^Appel (audio|vidéo) (annulé|refusé|terminé|manqué|interrompu|impossible)(?:[ :.].*)?\.$/.test(clear);
}

async function isIncomingCallHistoryMessage(message) {
  if (!message || message.file || !message.encrypted_content || !message.iv) return false;
  const conversation = state.conversations.find((item) => sameID(item.id, message.conversation_id));
  if (!conversation) return false;
  const clear = await decryptMessageContent(message, await getMessageKey(message, conversation));
  return isCallHistoryText(clear);
}

function withReplyPreview(message, clearByID) {
  if (!message.reply_to || !clearByID.has(message.reply_to)) return message;
  const cachedParent = clearByID.get(message.reply_to);
  const parent = cachedParent?.clear ?? cachedParent;
  const parentKeyEpoch = cachedParent?.keyEpoch || 1;
  const replyPreview = typeof parent === "string"
    ? { type: "text", text: parent.slice(0, 120) }
    : parent?.question
      ? { type: "text", text: `Sondage : ${parent.question}`.slice(0, 120) }
      : parent?.type === "event"
        ? { type: "text", text: `Évènement : ${parent.name}`.slice(0, 120) }
        : {
            type: "file",
            name: parent.name,
            mime: parent.mime,
            fileID: parent.fileID,
            size: parent.size,
            hasPreview: parent.hasPreview,
            previewSize: parent.previewSize,
            keyEpoch: parentKeyEpoch,
          };
  return {
    ...message,
    reply_preview: replyPreview,
  };
}

function messageClearCache(conversationID) {
  if (!state.messageClears.has(conversationID)) {
    state.messageClears.set(conversationID, new Map());
  }
  return state.messageClears.get(conversationID);
}

function setReplyTarget(message, clear) {
  state.replyTo = { id: message.id, label: replyLabel(message, clear) };
  elements.replyTarget.querySelector("span").textContent = `Réponse à ${state.replyTo.label}`;
  elements.replyTarget.hidden = false;
  elements.input.focus({ preventScroll: true });
}

function clearReplyTarget() {
  state.replyTo = null;
  elements.replyTarget.hidden = true;
  elements.replyTarget.querySelector("span").textContent = "";
}

function closeReactionPicker({ restoreFocus = false } = {}) {
  if (!activeReactionPicker) return;
  const { picker, anchor, outsideTimer, onOutsideClick, onKeyDown, onViewportChange } = activeReactionPicker;
  activeReactionPicker = null;
  clearTimeout(outsideTimer);
  document.removeEventListener("click", onOutsideClick);
  document.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", onViewportChange);
  elements.messages.removeEventListener("scroll", onViewportChange);
  anchor?.setAttribute("aria-expanded", "false");
  picker.remove();
  if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
}

function positionReactionPicker(picker, anchor) {
  if (!picker.isConnected || !anchor?.isConnected) {
    closeReactionPicker();
    return;
  }
  const margin = 8;
  const anchorRect = anchor.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  let top = anchorRect.top - pickerRect.height - margin;
  if (top < margin) top = anchorRect.bottom + margin;
  top = Math.min(top, window.innerHeight - pickerRect.height - margin);
  const centered = anchorRect.left + (anchorRect.width - pickerRect.width) / 2;
  const left = Math.max(margin, Math.min(centered, window.innerWidth - pickerRect.width - margin));
  picker.style.left = `${Math.round(left)}px`;
  picker.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function openReactionPicker(message, anchor) {
  if (activeReactionPicker?.messageID === message.id && activeReactionPicker.anchor === anchor) {
    closeReactionPicker({ restoreFocus: true });
    return;
  }
  closeEmojiPicker();
  closeReactionPicker();
  const picker = document.createElement("section");
  picker.id = "message-reaction-picker";
  picker.className = "message-reaction-picker";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", t("Choisir une réaction"));
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = t("Réagir");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "reaction-picker-close";
  close.textContent = "×";
  close.title = t("Fermer");
  close.setAttribute("aria-label", close.title);
  close.onclick = () => closeReactionPicker({ restoreFocus: true });
  header.append(title, close);
  const grid = document.createElement("div");
  grid.className = "reaction-picker-grid";
  for (const emoji of reactionEmojis) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.title = t("Réagir avec {emoji}", { emoji });
    button.setAttribute("aria-label", button.title);
    button.onclick = () => {
      closeReactionPicker();
      updateMessageReaction(message, emoji);
    };
    grid.append(button);
  }
  picker.append(header, grid);
  document.body.append(picker);
  anchor?.setAttribute("aria-controls", picker.id);
  anchor?.setAttribute("aria-expanded", "true");
  const onOutsideClick = (event) => {
    if (!picker.contains(event.target) && event.target !== anchor) closeReactionPicker();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closeReactionPicker({ restoreFocus: true });
  };
  const onViewportChange = () => positionReactionPicker(picker, anchor);
  const outsideTimer = setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
  activeReactionPicker = { picker, anchor, messageID: message.id, outsideTimer, onOutsideClick, onKeyDown, onViewportChange };
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onViewportChange);
  elements.messages.addEventListener("scroll", onViewportChange);
  positionReactionPicker(picker, anchor);
  grid.querySelector("button")?.focus({ preventScroll: true });
}

async function updateMessageReaction(message, emoji) {
  try {
    await api(`/api/messages/${message.id}/reactions`, {
      method: "POST",
      body: { emoji },
    });
    await loadMessages(null, false);
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible d’ajouter la réaction."), "error");
  }
}

async function reactToMessage(message, presetEmoji = "", anchor = null) {
  if (presetEmoji) {
    await updateMessageReaction(message, presetEmoji);
    return;
  }
  if (anchor) openReactionPicker(message, anchor);
}

async function togglePinnedMessage(message) {
  try {
    await api(`/api/messages/${message.id}/pin`, {
      method: "POST",
      body: { pinned: !message.is_pinned },
    });
    await loadMessages(null, false);
    if (!elements.pinnedPanel.hidden) await loadPinnedMessages();
    toast(message.is_pinned ? "Message désépinglé." : "Message épinglé.", "success");
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de modifier l’épinglage."), "error");
  }
}

async function setPinnedPanelOpen(open) {
  if (open && !state.current) return;
  elements.pinnedPanel.hidden = !open;
  elements.chatWorkspace.classList.toggle("pinned-open", open);
  elements.pinnedWindowButton.setAttribute("aria-expanded", String(open));
  elements.pinnedWindowButton.title = t(open ? "Masquer vos messages épinglés" : "Afficher vos messages épinglés");
  elements.pinnedWindowButton.setAttribute("aria-label", elements.pinnedWindowButton.title);
  if (!open) return;
  await loadPinnedMessages();
}

async function loadPinnedMessages() {
  if (!state.current || elements.pinnedPanel.hidden) return;
  const conversation = state.current;
  const loading = document.createElement("p");
  loading.className = "pinned-message-empty";
  loading.textContent = t("Chargement…");
  elements.pinnedMessages.replaceChildren(loading);
  try {
    const messages = await api(`/api/conversations/${conversation.id}/pinned-messages`);
    if (!sameID(state.current?.id, conversation.id) || elements.pinnedPanel.hidden) return;
    if (!messages.length) {
      const empty = document.createElement("p");
      empty.className = "pinned-message-empty";
      empty.textContent = t("Vous n’avez épinglé aucun message dans cette conversation.");
      elements.pinnedMessages.replaceChildren(empty);
      return;
    }
    const decrypted = await Promise.all(messages.map(async (message) => ({
      message: messageWithCurrentUserProfile(message),
      clear: await decryptMessageContent(message, await getMessageKey(message, conversation)),
    })));
    const fragment = document.createDocumentFragment();
    for (const { message, clear } of decrypted) {
      const card = document.createElement("article");
      card.className = "pinned-message-card";
      const meta = document.createElement("div");
      meta.className = "pinned-message-meta";
      const author = document.createElement("strong");
      author.textContent = sameID(message.sender_id, state.me.id) ? t("Vous") : message.sender_username;
      const date = document.createElement("time");
      date.dateTime = message.created_at;
      date.textContent = formatMessageTime(message.created_at);
      meta.append(author, date);
      const preview = document.createElement("p");
      preview.className = "pinned-message-preview";
      preview.textContent = pinnedMessagePreview(message, clear);
      const actions = document.createElement("div");
      actions.className = "pinned-message-actions";
      const show = document.createElement("button");
      show.type = "button";
      show.textContent = t("Afficher");
      show.addEventListener("click", async () => {
        await loadMessages(message.id);
        await revealMessage(message.id);
        if (window.matchMedia("(max-width: 720px)").matches) await setPinnedPanelOpen(false);
      });
      const unpin = document.createElement("button");
      unpin.type = "button";
      unpin.className = "unpin-button";
      unpin.textContent = t("Désépingler");
      unpin.addEventListener("click", () => togglePinnedMessage(message));
      actions.append(show, unpin);
      card.append(meta, preview, actions);
      fragment.append(card);
    }
    elements.pinnedMessages.replaceChildren(fragment);
  } catch (error) {
    if (!sameID(state.current?.id, conversation.id) || elements.pinnedPanel.hidden) return;
    const failure = document.createElement("p");
    failure.className = "pinned-message-empty";
    failure.textContent = frenchErrorMessage(error, "Impossible de charger les messages épinglés.");
    elements.pinnedMessages.replaceChildren(failure);
  }
}

function pinnedMessagePreview(message, clear) {
  if (message.file) return `Fichier : ${clear.name}`;
  if (message.poll) return `Sondage : ${clear.question}`;
  if (message.event) return `Évènement : ${clear.name}`;
  return compactPreviewText(clear) || "Message vide";
}

async function appendMessage(message, scroll = true) {
  invalidateConversationPreload(message.conversation_id);
  state.cache?.putMessages([message]);
  if (elements.messages.querySelector(`[data-id="${message.id}"]`)) return;
  const conversation = state.current;
  if (!conversation || !sameID(conversation.id, message.conversation_id)) return;
  const appendKey = `${message.conversation_id}:${message.id}`;
  return runKeyedTask(state.messageAppendTasks, appendKey, async () => {
    if (elements.messages.querySelector(`[data-id="${message.id}"]`)) return;
    if (!scheduleMessageExpiration(message)) return;
    const key = await getMessageKey(message, conversation);
    prefetchFileThumbnail(message, key);
    const clear = await decryptMessageContent(message, key);
    prewarmFilePreviewRenderers([{ message, clear }]);
    prefetchRecentFullFilePreviews([{ message, clear, key }]);
    if (!sameID(state.current?.id, conversation.id)) return;
    if (elements.messages.querySelector(`[data-id="${message.id}"]`)) return;
    document.querySelector("#empty-chat")?.remove();
    const clearByID = messageClearCache(conversation.id);
    clearByID.set(message.id, { clear, keyEpoch: messageKeyEpoch(message, conversation) });
    const fragment = document.createDocumentFragment();
    const displayMessage = withReplyPreview(messageWithCurrentUserProfile(message), clearByID);
    let filePreview;
    renderMessage(
      fragment,
      displayMessage,
      clear,
      displayMessage.sender_id === state.me.id,
      (fileMessage, preview) => { filePreview = [fileMessage, preview]; },
      downloadFile,
      editMessage,
      deleteMessage,
      setReplyTarget,
      reactToMessage,
      togglePinnedMessage,
      (replyPreview, container) => scheduleReplyFilePreview(replyPreview, container, conversation),
      votePoll,
      openFileShareDialog,
    );
    elements.messages.prepend(fragment);
    if (filePreview) scheduleFilePreview(filePreview[0], filePreview[1], key);
    while (elements.messages.querySelectorAll(".message").length > 200) {
      const renderedMessages = elements.messages.querySelectorAll(".message");
      renderedMessages[renderedMessages.length - 1]?.closest(".message-row")?.remove();
    }
    if (message.sender_id !== state.me.id && !document.hidden) {
      api(`/api/messages/${message.id}/read`, { method: "POST", body: {} }).catch(() => {});
    }
    if (scroll) scrollToBottom();
  });
}

function pollOptionValues() {
  return [...elements.pollOptionInputs.querySelectorAll("input")].map((input) => input.value);
}

function renderPollOptionInputs(values) {
  elements.pollOptionInputs.replaceChildren();
  values.forEach((value, index) => {
    const row = document.createElement("div");
    row.className = "poll-editor-row";
    const input = document.createElement("input");
    input.required = true;
    input.maxLength = 160;
    input.value = value;
    input.placeholder = `Réponse ${index + 1}`;
    input.setAttribute("aria-label", input.placeholder);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = t("Supprimer cette réponse");
    remove.setAttribute("aria-label", remove.title);
    remove.disabled = values.length <= 2;
    remove.onclick = () => {
      const next = pollOptionValues();
      next.splice(index, 1);
      renderPollOptionInputs(next);
    };
    row.append(input, remove);
    elements.pollOptionInputs.append(row);
  });
  elements.pollAddOption.disabled = values.length >= 10;
}

function addPollOptionInput() {
  const values = pollOptionValues();
  if (values.length >= 10) return;
  values.push("");
  renderPollOptionInputs(values);
  elements.pollOptionInputs.querySelector(".poll-editor-row:last-child input")?.focus();
}

function openPollDialog(message = null, clear = null) {
  if (!state.current) {
    toast("Sélectionnez d’abord une conversation.", "error");
    return;
  }
  state.editingPoll = message ? { message, clear } : null;
  document.querySelector("#poll-dialog-title").textContent = t(message ? "Modifier le sondage" : "Nouveau sondage");
  elements.pollSubmit.textContent = t(message ? "Enregistrer" : "Publier");
  const help = document.querySelector(".poll-editor-help");
  help.textContent = message
    ? "La modification des réponses remet tous les votes à zéro."
    : "De 2 à 10 réponses. Chaque participant ne peut voter qu’une fois.";
  elements.pollQuestion.value = clear?.question || "";
  elements.pollExpiration.value = String(message ? pollDurationSeconds(message) : 86400);
  renderPollOptionInputs(clear?.options?.length >= 2 ? clear.options.slice(0, 10) : ["", ""]);
  if (!elements.pollDialog.open) {
    if (typeof elements.pollDialog.showModal === "function") elements.pollDialog.showModal();
    else elements.pollDialog.setAttribute("open", "");
  }
  elements.pollQuestion.focus();
}

function closePollDialog() {
  state.editingPoll = null;
  if (typeof elements.pollDialog.close === "function") elements.pollDialog.close();
  else elements.pollDialog.removeAttribute("open");
}

async function submitPoll(event) {
  event.preventDefault();
  if (!state.current) return;
  const question = elements.pollQuestion.value.trim();
  const options = pollOptionValues().map((value) => value.trim());
  const expiresInSeconds = Number(elements.pollExpiration.value);
  if (!question || options.length < 2 || options.length > 10 || options.some((value) => !value)) {
    toast("Saisissez une question et entre 2 et 10 réponses.", "error");
    return;
  }
  if (new Set(options.map((value) => value.toLocaleLowerCase("fr"))).size !== options.length) {
    toast("Chaque réponse doit être différente.", "error");
    return;
  }
  const editing = state.editingPoll;
  setBusy(elements.pollSubmit, true, "…");
  try {
    const key = editing
      ? await getMessageKey(editing.message, state.current)
      : await getConversationKey(state.current);
    const encrypted = await encryptText(key, JSON.stringify({ v: 1, question, options }));
    if (editing) {
      const body = { encrypted_content: encrypted.data, iv: encrypted.iv, option_count: options.length, expires_in_seconds: expiresInSeconds };
      Object.assign(body, await messageSignature("poll", state.current.id, body, editing.message));
      await api(`/api/messages/${editing.message.id}/poll`, {
        method: "PUT",
        body,
      });
      closePollDialog();
      await loadMessages(null, false);
      await refreshConversationList();
      toast("Sondage modifié. Les votes ont été remis à zéro.", "success");
    } else {
      const body = {
        encrypted_content: encrypted.data,
        iv: encrypted.iv,
        option_count: options.length,
        expires_in_seconds: expiresInSeconds,
        key_epoch: conversationKeyEpoch(state.current),
      };
      Object.assign(body, await messageSignature("poll", state.current.id, body));
      const message = await api(`/api/conversations/${state.current.id}/polls`, {
        method: "POST",
        body,
      });
      closePollDialog();
      await appendMessage(message);
      await refreshConversationList();
      toast("Sondage publié.", "success");
    }
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible d’enregistrer le sondage."), "error");
  } finally {
    setBusy(elements.pollSubmit, false);
  }
}

async function votePoll(message, optionID) {
  if (message.poll?.has_voted) return;
  if (message.poll?.closed || (message.poll?.expires_at && Date.parse(message.poll.expires_at) <= Date.now())) {
    toast("Ce sondage est terminé.", "error");
    await loadMessages(null, false);
    return;
  }
  try {
    await api(`/api/messages/${message.id}/poll/vote`, {
      method: "POST",
      body: { option_id: optionID },
    });
    await loadMessages(null, false);
    toast("Vote enregistré.", "success");
  } catch (error) {
    const messageText = /poll expired/i.test(error?.message || "")
      ? "Ce sondage est terminé."
      : frenchErrorMessage(error, "Impossible d’enregistrer le vote.");
    toast(messageText, "error");
  }
}

function pollDurationSeconds(message) {
  const deadline = Date.parse(message.poll?.expires_at || "");
  if (!Number.isFinite(deadline)) return 0;
  const base = Date.parse(message.updated_at || message.created_at || "");
  if (!Number.isFinite(base)) return 86400;
  const duration = Math.max(0, Math.round((deadline - base) / 1000));
  return [300, 3600, 86400, 604800].reduce((closest, value) => (
    Math.abs(value - duration) < Math.abs(closest - duration) ? value : closest
  ), 300);
}

function openEventDialog(message = null, clear = null) {
  if (!state.current) {
    toast("Sélectionnez d’abord une conversation.", "error");
    return;
  }
  state.editingEvent = message ? { message, clear } : null;
  document.querySelector("#event-dialog-title").textContent = t(message ? "Modifier l’évènement" : "Nouvel évènement");
  elements.eventSubmit.textContent = t(message ? "Enregistrer" : "Publier");
  const defaultStart = new Date(Math.ceil((Date.now() + 30 * 60 * 1000) / 3600000) * 3600000);
  const defaultEnd = new Date(defaultStart.getTime() + 3600000);
  elements.eventName.value = clear?.name || "";
  elements.eventDescription.value = clear?.description || "";
  elements.eventLocation.value = clear?.location || "";
  elements.eventStart.value = datetimeLocalValue(message?.event?.starts_at || defaultStart);
  elements.eventEnd.value = datetimeLocalValue(message?.event?.ends_at || defaultEnd);
  if (!elements.eventDialog.open) elements.eventDialog.showModal();
  elements.eventName.focus();
}

function closeEventDialog() {
  state.editingEvent = null;
  if (elements.eventDialog.open) elements.eventDialog.close();
}

async function submitEvent(event) {
  event.preventDefault();
  if (!state.current) return;
  const name = elements.eventName.value.trim();
  const description = elements.eventDescription.value.trim();
  const location = elements.eventLocation.value.trim();
  const start = new Date(elements.eventStart.value);
  const end = new Date(elements.eventEnd.value);
  if (!name || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    toast("Saisissez un nom et une fin postérieure au début.", "error");
    return;
  }
  const editing = state.editingEvent;
  setBusy(elements.eventSubmit, true, "…");
  try {
    const key = editing
      ? await getMessageKey(editing.message, state.current)
      : await getConversationKey(state.current);
    const encrypted = await encryptText(key, JSON.stringify({ v: 1, type: "event", name, description, location }));
    const body = {
      encrypted_content: encrypted.data,
      iv: encrypted.iv,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
    };
    if (editing) {
      Object.assign(body, await messageSignature("event", state.current.id, body, editing.message));
      await api(`/api/messages/${editing.message.id}/event`, { method: "PUT", body });
      closeEventDialog();
      await loadMessages(null, false);
      await refreshConversationList();
      syncSharedCalendarFeed().catch(() => {});
      toast("Évènement modifié.", "success");
    } else {
      body.key_epoch = conversationKeyEpoch(state.current);
      Object.assign(body, await messageSignature("event", state.current.id, body));
      const message = await api(`/api/conversations/${state.current.id}/events`, { method: "POST", body });
      closeEventDialog();
      await appendMessage(message);
      await refreshConversationList();
      syncSharedCalendarFeed().catch(() => {});
      toast("Évènement publié.", "success");
    }
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible d’enregistrer l’évènement."), "error");
  } finally {
    setBusy(elements.eventSubmit, false);
  }
}

function datetimeLocalValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function openGlobalFiles() {
  elements.globalFilesStatus.textContent = t("Chargement des fichiers…");
  elements.globalFilesList.replaceChildren();
  if (!elements.globalFilesDialog.open) {
    elements.globalFilesDialog.showModal();
    document.querySelector("#global-files-close").focus({ preventScroll: true });
  }
  try {
    const messages = await api("/api/files");
    const items = await Promise.all(messages.map(async (message) => {
      const conversation = state.conversations.find((item) => sameID(item.id, message.conversation_id));
      if (!conversation) return null;
      try {
        const key = await getMessageKey(message, conversation);
        const clear = await decryptMessageContent(message, key);
        const display = await resolveConversationDisplay(conversation);
        return {
          message,
          clear,
          conversation,
          conversationTitle: display.title,
          conversationAvatar: display.avatar || null,
          conversationInitial: display.title.slice(0, 1).toUpperCase(),
        };
      } catch {
        return {
          message,
          clear: { name: t("Fichier impossible à déchiffrer"), mime: "application/octet-stream" },
          conversation,
          conversationTitle: t("Conversation"),
          conversationAvatar: null,
          conversationInitial: conversation.is_personal ? "N" : conversation.type === "group" ? "G" : "@",
        };
      }
    }));
    renderGlobalFiles(items.filter(Boolean));
  } catch (error) {
    elements.globalFilesStatus.textContent = frenchErrorMessage(error, "Impossible de charger les fichiers.");
  }
}

function renderGlobalFiles(items) {
  elements.globalFilesList.replaceChildren();
  elements.globalFilesStatus.textContent = items.length
    ? t(items.length === 1 ? "{count} fichier dans vos discussions." : "{count} fichiers dans vos discussions.", { count: items.length })
    : t("Aucun fichier dans vos discussions.");
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "global-files-empty";
    empty.textContent = t("Les pièces jointes envoyées dans vos discussions apparaîtront ici.");
    elements.globalFilesList.append(empty);
    return;
  }
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "global-file-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "global-file-open";
    const kind = document.createElement("span");
    kind.className = "global-file-kind";
    kind.append(materialFileIcon(fileKindIcon(item.clear.mime)));
    const content = document.createElement("span");
    content.className = "global-file-content";
    const name = document.createElement("strong");
    name.textContent = item.clear.name;
    const meta = document.createElement("span");
    meta.className = "global-file-meta";
    const updateMeta = () => {
      const shareCount = Number(item.message.file.active_share_count || 0);
      const shared = shareCount > 0
        ? ` · ${t(shareCount === 1 ? "Partagé ({count} lien)" : "Partagé ({count} liens)", { count: shareCount })}`
        : "";
      meta.textContent = `${formatFileSize(item.message.file.size)} · ${dateFormatter.format(new Date(item.message.created_at))}${shared}`;
    };
    updateMeta();
    const source = document.createElement("span");
    source.className = "global-file-conversation";
    const avatar = createConversationBadge(item.conversationAvatar, item.conversationInitial, "global-file-conversation-avatar");
    const title = document.createElement("span");
    title.className = "global-file-conversation-title";
    title.textContent = item.conversationTitle;
    source.append(avatar, title);
    content.append(name, meta, source);
    open.append(kind, content);
    open.title = t("Ouvrir {conversation}", { conversation: item.conversationTitle });
    open.addEventListener("click", () => openGlobalFile(item));
    const share = document.createElement("button");
    share.type = "button";
    share.className = "file-share-button global-file-share";
    share.title = t("Partager {name}", { name: item.clear.name });
    share.setAttribute("aria-label", share.title);
    share.innerHTML = '<svg class="file-share-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.6 10.7 6.8-4.4"></path><path d="m8.6 13.3 6.8 4.4"></path></svg>';
    share.addEventListener("click", () => {
      elements.globalFilesDialog.close();
      openFileShareDialog(item.message, item.clear, item.conversation);
    });
    const actions = document.createElement("div");
    actions.className = "global-file-actions";
    actions.append(share);
    if (Number(item.message.file.active_share_count || 0) > 0) {
      const cancelShare = document.createElement("button");
      cancelShare.type = "button";
      cancelShare.className = "file-share-button global-file-unshare";
      cancelShare.title = t("Annuler le partage de {name}", { name: item.clear.name });
      cancelShare.setAttribute("aria-label", cancelShare.title);
      cancelShare.innerHTML = '<svg class="file-share-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 7h2a5 5 0 0 1 0 10h-2"></path><path d="M8 17H6A5 5 0 0 1 6 7h2"></path><path d="M9 12h6"></path><path d="m3 3 18 18"></path></svg>';
      cancelShare.addEventListener("click", async () => {
        const count = Number(item.message.file.active_share_count || 0);
        const confirmation = count === 1
          ? t("Désactiver ce lien de partage ? La personne qui le possède ne pourra plus télécharger le fichier.")
          : t("Désactiver ces {count} liens de partage ? Les personnes qui les possèdent ne pourront plus télécharger le fichier.", { count });
        if (!confirm(confirmation)) return;
        cancelShare.disabled = true;
        cancelShare.setAttribute("aria-busy", "true");
        try {
          await api(`/api/files/${item.message.file.id}/shares`, { method: "DELETE" });
          item.message.file.active_share_count = 0;
          cancelShare.remove();
          updateMeta();
          toast(t(count === 1 ? "Partage du fichier annulé." : "Partages du fichier annulés."), "success");
        } catch (error) {
          cancelShare.disabled = false;
          cancelShare.removeAttribute("aria-busy");
          toast(frenchErrorMessage(error, "Impossible d’annuler le partage du fichier."), "error");
        }
      });
      actions.append(cancelShare);
    }
    row.append(open, actions);
    elements.globalFilesList.append(row);
  }
}

async function openGlobalFile(item) {
  elements.globalFilesDialog.close();
  await selectConversation(item.conversation);
  const row = elements.messages.querySelector(`[data-id="${item.message.id}"]`);
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function fileKindIcon(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function formatFileSize(bytes) {
  if (bytes < 1024) return t("{count} o", { count: bytes });
  if (bytes < 1024 * 1024) return t("{count} Ko", { count: Math.ceil(bytes / 1024) });
  return t("{count} Mo", {
    count: (bytes / (1024 * 1024)).toLocaleString(locale, { maximumFractionDigits: 1 }),
  });
}

async function openCalendar() {
  showCurrentCalendarMonth();
  elements.calendarStatus.textContent = t("Chargement des évènements…");
  elements.calendarGrid.setAttribute("aria-busy", "true");
  if (!elements.calendarDialog.open) elements.calendarDialog.showModal();
  try {
    state.calendarItems = await loadCalendarItems();
    renderCalendarMonth();
  } catch (error) {
    state.calendarItems = [];
    elements.calendarStatus.textContent = frenchErrorMessage(error, "Impossible de charger le calendrier.");
    renderCalendarMonth(false);
  } finally {
    elements.calendarGrid.removeAttribute("aria-busy");
  }
}

async function openCarnet() {
  elements.carnetStatus.textContent = t("Chargement du carnet…");
  elements.carnetList.replaceChildren();
  elements.carnetList.setAttribute("aria-busy", "true");
  if (!elements.carnetDialog.open) elements.carnetDialog.showModal();
  try {
    state.carnet = await api("/api/carnet");
    renderCarnet();
  } catch (error) {
    elements.carnetStatus.textContent = frenchErrorMessage(error, "Impossible de charger le carnet.");
    renderCarnet(false);
  } finally {
    elements.carnetList.removeAttribute("aria-busy");
  }
}

function renderCarnet(loaded = true) {
  const entries = loaded ? state.carnet : [];
  const oldEntries = entries.filter((entry) => !entry.active);
  elements.carnetStatus.textContent = loaded
    ? t(entries.length === 1 ? "{count} contact dans votre carnet." : "{count} contacts dans votre carnet.", { count: entries.length })
    : t("Impossible de charger le carnet.");
  elements.carnetDeleteAll.disabled = oldEntries.length === 0;
  elements.carnetList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "carnet-empty";
    empty.textContent = t("Aucun contact ancien dans votre carnet.");
    elements.carnetList.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("article");
    row.className = "carnet-row";
    const avatar = createConversationBadge(entry.avatar, (entry.display_name || entry.username || "?").slice(0, 1).toUpperCase(), "carnet-avatar");
    const copy = document.createElement("span");
    copy.className = "carnet-copy";
    const name = document.createElement("strong");
    name.textContent = entry.display_name || entry.username;
    const username = document.createElement("small");
    username.textContent = `@${entry.username}`;
    const status = document.createElement("small");
    status.className = entry.active ? "carnet-active" : "";
    status.textContent = entry.active ? t("Discussion actuelle") : t("Contact ancien");
    copy.append(name, username, status);
    const actions = document.createElement("span");
    actions.className = "carnet-actions";
    if (entry.can_resume) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "outline";
      open.textContent = t(entry.has_private_conversation ? "Ouvrir" : "Contacter");
      open.title = entry.has_private_conversation
        ? t("Ouvrir une discussion avec {name}", { name: entry.display_name || entry.username })
        : t("Contacter {name}", { name: entry.display_name || entry.username });
      open.setAttribute("aria-label", open.title);
      open.onclick = () => resumeCarnetEntry(entry, open);
      actions.append(open);
    }
    if (!entry.active) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "outline danger-text";
      remove.textContent = t("Supprimer");
      remove.title = t("Supprimer {name} du carnet", { name: entry.display_name || entry.username });
      remove.setAttribute("aria-label", remove.title);
      remove.onclick = () => deleteCarnetEntry(entry, remove);
      actions.append(remove);
    }
    row.append(avatar, copy, actions);
    elements.carnetList.append(row);
  }
}

async function deleteCarnetEntry(entry, button) {
  const name = entry.display_name || entry.username;
  const confirmed = await actionDialog({
    title: "Supprimer du carnet",
    message: "Supprimer {name} du carnet ? Cette personne pourra être ajoutée à nouveau plus tard.",
    messageValues: { name },
    confirmLabel: "Supprimer",
    danger: true,
  });
  if (!confirmed) return;
  setBusy(button, true);
  try {
    await api(`/api/carnet/${entry.id}`, { method: "DELETE" });
    state.carnet = state.carnet.filter((item) => !sameID(item.id, entry.id));
    renderCarnet();
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de supprimer ce contact du carnet."), "error");
  } finally {
    setBusy(button, false);
  }
}

async function deleteAllCarnetEntries() {
  const oldCount = state.carnet.filter((entry) => !entry.active).length;
  if (!oldCount) return;
  const confirmed = await actionDialog({
    title: "Supprimer les anciens contacts",
    message: "Supprimer les {count} anciens contacts du carnet ? Les discussions actuelles seront conservées.",
    messageValues: { count: oldCount },
    confirmLabel: "Supprimer",
    danger: true,
  });
  if (!confirmed) return;
  elements.carnetDeleteAll.disabled = true;
  elements.carnetDeleteAll.setAttribute("aria-busy", "true");
  try {
    await api("/api/carnet", { method: "DELETE" });
    state.carnet = state.carnet.filter((entry) => entry.active);
    renderCarnet();
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de supprimer les anciens contacts."), "error");
  } finally {
    elements.carnetDeleteAll.removeAttribute("aria-busy");
    elements.carnetDeleteAll.disabled = state.carnet.every((entry) => entry.active);
  }
}

async function resumeCarnetEntry(entry, button) {
  const row = button.closest(".carnet-row");
  if (row?.dataset.busy === "true") return;
  if (row) row.dataset.busy = "true";
  setBusy(button, true);
  try {
    let conversation;
    if (entry.is_remote) {
      conversation = await api("/api/conversations/federated/private", {
        method: "POST",
        body: { instance_id: entry.remote_instance_id, username: entry.remote_username || entry.username },
      });
    } else {
      let contact = state.contacts.find((item) => sameID(item.contact_user_id, entry.contact_user_id));
      if (!contact) {
        await api("/api/contacts", { method: "POST", body: { user_id: entry.contact_user_id } });
        await refreshAll();
        contact = state.contacts.find((item) => sameID(item.contact_user_id, entry.contact_user_id));
      }
      if (contact?.status !== "accepted" && contact?.direction === "incoming") {
        await api(`/api/contacts/${contact.id}/accept`, { method: "POST" });
        await refreshAll();
        contact = state.contacts.find((item) => sameID(item.contact_user_id, entry.contact_user_id));
      }
      if (contact?.status !== "accepted") {
        elements.carnetDialog.close();
        toast(t("Demande envoyée. La discussion sera disponible après acceptation."), "success");
        return;
      }
      conversation = await api("/api/conversations/private", { method: "POST", body: { user_id: entry.contact_user_id } });
    }
    elements.carnetDialog.close();
    await refreshAll();
    const selected = state.conversations.find((item) => sameID(item.id, conversation.id));
    if (selected) await selectConversation(selected);
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible de reprendre cette discussion."), "error");
  } finally {
    setBusy(button, false);
    if (row) delete row.dataset.busy;
  }
}

async function loadCalendarItems() {
  const messages = await api("/api/events");
  const items = await Promise.all(messages.map(async (message) => {
    const conversation = state.conversations.find((item) => sameID(item.id, message.conversation_id));
    if (!conversation) return null;
    try {
      const key = await getMessageKey(message, conversation);
      const clear = await decryptMessageContent(message, key);
      let display;
      try {
        display = await resolveConversationDisplay(conversation);
      } catch {
        display = {
          title: t("Conversation"),
          avatar: null,
        };
      }
      return {
        message,
        clear,
        decrypted: clear?.type === "event",
        conversation,
        conversationTitle: display.title,
        conversationAvatar: display.avatar || null,
        conversationInitial: display.title.slice(0, 1).toUpperCase(),
      };
    } catch {
      return {
        message,
        clear: { name: t("Évènement impossible à déchiffrer"), description: "", location: "" },
        decrypted: false,
        conversation,
        conversationTitle: t("Conversation"),
        conversationAvatar: null,
        conversationInitial: conversation.is_personal ? "N" : conversation.type === "group" ? "G" : "@",
      };
    }
  }));
  return items.filter(Boolean).sort((left, right) => (
    Date.parse(left.message.event.starts_at) - Date.parse(right.message.event.starts_at)
  ));
}

function renderCalendarMonth(updateStatus = true) {
  const month = state.calendarMonth;
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const monthName = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(month);
  elements.calendarMonthLabel.textContent = monthName.charAt(0).toLocaleUpperCase(locale) + monthName.slice(1);
  const firstWeekday = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const firstCellDate = new Date(year, monthIndex, 1 - firstWeekday);
  const todayKey = calendarDayKey(new Date());
  const fragment = document.createDocumentFragment();
  const monthStart = new Date(year, monthIndex, 1).getTime();
  const monthEnd = new Date(year, monthIndex + 1, 1).getTime();
  const visibleEvents = state.calendarItems.filter((item) => (
    Date.parse(item.message.event.starts_at) < monthEnd && Date.parse(item.message.event.ends_at) > monthStart
  )).length;
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(firstCellDate.getFullYear(), firstCellDate.getMonth(), firstCellDate.getDate() + index);
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    const key = calendarDayKey(date);
    const cell = document.createElement("section");
    cell.className = "calendar-day";
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-label", new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(date));
    if (date.getMonth() !== monthIndex) cell.classList.add("outside-month");
    if (key === todayKey) cell.classList.add("today");
    const number = document.createElement("time");
    number.dateTime = key;
    number.className = "calendar-day-number";
    number.textContent = String(date.getDate());
    cell.append(number);
    const dayItems = state.calendarItems.filter((item) => {
      const start = Date.parse(item.message.event.starts_at);
      const end = Date.parse(item.message.event.ends_at);
      return Number.isFinite(start) && Number.isFinite(end) && start < dayEnd.getTime() && end > dayStart.getTime();
    });
    const events = document.createElement("div");
    events.className = "calendar-day-events";
    for (const item of dayItems) events.append(calendarEventButton(item, date));
    cell.append(events);
    fragment.append(cell);
  }
  elements.calendarGrid.replaceChildren(fragment);
  if (updateStatus) {
    const total = state.calendarItems.length;
    elements.calendarStatus.textContent = total
      ? t(visibleEvents === 1
        ? "{visible} évènement ce mois · {total} au total"
        : "{visible} évènements ce mois · {total} au total", { visible: visibleEvents, total })
      : t("Aucun évènement dans vos conversations.");
  }
}

function calendarEventButton(item, date) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "calendar-day-event";
  const start = new Date(item.message.event.starts_at);
  const end = new Date(item.message.event.ends_at);
  const startsToday = calendarDayKey(start) === calendarDayKey(date);
  // Une fin à minuit appartient visuellement à la journée précédente.
  const effectiveEnd = new Date(end.getTime() - 1);
  const endsToday = calendarDayKey(effectiveEnd) === calendarDayKey(date);
  const timeFormatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const startTime = timeFormatter.format(start);
  const endTime = timeFormatter.format(end);
  const time = startsToday && endsToday
    ? `${startTime}–${endTime}`
    : startsToday
      ? `${startTime} →`
      : endsToday
        ? `→ ${endTime}`
        : "↔";
  const timeLabel = document.createElement("span");
  timeLabel.className = "calendar-day-event-time";
  timeLabel.textContent = time;
  const name = document.createElement("span");
  name.className = "calendar-day-event-name";
  name.textContent = item.clear.name;
  const conversationIcon = createConversationBadge(item.conversationAvatar, item.conversationInitial, "calendar-day-event-avatar");
  button.append(conversationIcon, name, timeLabel);
  const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  button.title = `${item.clear.name}\n${fullDate.format(start)} → ${fullDate.format(end)}${item.clear.location ? `\n${item.clear.location}` : ""}\n${item.conversationTitle}`;
  button.setAttribute("aria-label", t("{name}, dans {conversation}", {
    name: item.clear.name,
    conversation: item.conversationTitle,
  }));
  button.addEventListener("click", () => openCalendarEvent(item));
  return button;
}

function createConversationBadge(avatar, initial, className) {
  const icon = document.createElement(avatar ? "img" : "span");
  icon.className = className;
  if (avatar) {
    icon.src = avatar;
    icon.alt = "";
  } else {
    icon.textContent = initial;
  }
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

async function openCalendarEvent(item) {
  elements.calendarDialog.close();
  await selectConversation(item.conversation, item.message.id);
}

async function revealMessage(messageID) {
  const row = [...elements.messages.querySelectorAll(".message-row")]
    .find((candidate) => sameID(candidate.dataset.id, messageID));
  if (!row) {
    toast(t("L’évènement n’est plus disponible dans cette discussion."), "error");
    return;
  }
  row.classList.add("navigation-target");
  row.tabIndex = -1;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  row.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
  row.focus({ preventScroll: true });
  window.setTimeout(() => row.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }), 280);
  window.setTimeout(() => {
    row.classList.remove("navigation-target");
    row.removeAttribute("tabindex");
  }, 3200);
}

function changeCalendarMonth(offset) {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + offset, 1);
  renderCalendarMonth();
}

function showCurrentCalendarMonth() {
  const now = new Date();
  state.calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  renderCalendarMonth();
}

function calendarDayKey(date) {
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function sendMessage(event) {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (!state.current) return;
  if (state.pendingVoiceFile) {
    const file = state.pendingVoiceFile;
    clearVoiceDraft();
    setBusy(elements.send, true, "…");
    try {
      const sent = await sendEncryptedFile(file, "Message vocal chiffré envoyé.");
      if (!sent) setVoiceDraft(file);
    } finally {
      setBusy(elements.send, false);
    }
    return;
  }
  if (!text) return;
  elements.input.value = "";
  setBusy(elements.send, true, "…");
  try {
    const key = await getConversationKey(state.current);
    const encrypted = await encryptText(key, text);
    const keyEpoch = conversationKeyEpoch(state.current);
    const replyTo = state.replyTo?.id || null;
    const signature = await messageSignature("text", state.current.id, {
      encrypted_content: encrypted.data, iv: encrypted.iv, key_epoch: keyEpoch, reply_to: replyTo,
    });
    const message = await api(`/api/conversations/${state.current.id}/messages`, {
      method: "POST",
      body: {
        encrypted_content: encrypted.data,
        iv: encrypted.iv,
        reply_to: replyTo,
        expires_in_seconds: state.messageExpirationSeconds,
        key_epoch: keyEpoch,
        ...signature,
      },
    });
    clearReplyTarget();
    await appendMessage(message);
    await refreshConversationList();
    state.socket.send({ type: "typing", conversation_id: state.current.id, typing: false });
  } catch (error) {
    elements.input.value = text;
    toast(frenchErrorMessage(error), "error");
  } finally {
    setBusy(elements.send, false);
  }
}

async function sendFile(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !state.current) return;
  await sendEncryptedFile(file, "Fichier chiffré envoyé.");
}

const FILE_PREVIEW_MAX_BYTES = 512 * 1024;

function canvasJPEG(canvas, quality = 0.76) {
  return new Promise((resolve) => {
    const fallback = () => {
      try {
        const dataURL = canvas.toDataURL("image/jpeg", quality);
        const [header, payload] = dataURL.split(",");
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        resolve(new Blob([bytes], { type: header.match(/data:([^;]+)/)?.[1] || "image/jpeg" }));
      } catch {
        resolve(null);
      }
    };
    try {
      if (typeof canvas.toBlob !== "function") {
        fallback();
        return;
      }
      canvas.toBlob((blob) => blob ? resolve(blob) : fallback(), "image/jpeg", quality);
    } catch {
      fallback();
    }
  });
}

function croppedPDFPreviewCanvas(canvas, targetAspect = canvas.width / canvas.height) {
  try {
    const context = canvas.getContext("2d", { alpha: false });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const bounds = nonWhiteImageBounds(pixels.data, canvas.width, canvas.height);
    if (!bounds || (bounds.width >= canvas.width - 2 && bounds.height >= canvas.height - 2)) return canvas;
    let cropX = bounds.x;
    let cropY = bounds.y;
    let cropWidth = bounds.width;
    let cropHeight = bounds.height;
    if (Number.isFinite(targetAspect) && targetAspect > 0) {
      const contentAspect = cropWidth / cropHeight;
      if (contentAspect < targetAspect) {
        cropWidth = Math.min(canvas.width, Math.ceil(cropHeight * targetAspect));
      } else if (contentAspect > targetAspect) {
        cropHeight = Math.min(canvas.height, Math.ceil(cropWidth / targetAspect));
      }
      cropX = Math.min(canvas.width - cropWidth, Math.max(0, Math.round(bounds.x + bounds.width / 2 - cropWidth / 2)));
      cropY = Math.min(canvas.height - cropHeight, Math.max(0, Math.round(bounds.y + bounds.height / 2 - cropHeight / 2)));
    }
    const cropped = document.createElement("canvas");
    cropped.width = cropWidth;
    cropped.height = cropHeight;
    const croppedContext = cropped.getContext("2d", { alpha: false });
    croppedContext.fillStyle = "#ffffff";
    croppedContext.fillRect(0, 0, cropped.width, cropped.height);
    croppedContext.drawImage(
      canvas,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );
    return cropped;
  } catch (error) {
    console.warn("Recadrage de l’aperçu PDF impossible", error);
    return canvas;
  }
}

async function rasterFilePreview(file, data) {
  const blob = new Blob([data], { type: normalizedFileMIME(file.type, file.name) });
  let source;
  let cleanup = () => {};
  if (typeof createImageBitmap === "function") {
    source = await createImageBitmap(blob);
    cleanup = () => source.close?.();
  } else {
    const url = URL.createObjectURL(blob);
    source = new Image();
    cleanup = () => URL.revokeObjectURL(url);
    await new Promise((resolve, reject) => {
      source.onload = resolve;
      source.onerror = () => reject(new Error("Image illisible."));
      source.src = url;
    });
  }
  try {
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, 640 / width, 640 / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvasJPEG(canvas);
  } finally {
    cleanup();
  }
}

async function videoFilePreview(file, data) {
  const mime = normalizedFileMIME(file.type, file.name);
  const sourceURL = URL.createObjectURL(new Blob([data], { type: mime }));
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = sourceURL;

  let timeout;
  const waitFor = (eventName, timeoutMs) => new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Vidéo illisible."));
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Le chargement de la vidéo a expiré."));
    }, timeoutMs);
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });

  try {
    video.load();
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitFor("loadedmetadata", 12000);
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitFor("loadeddata", 12000);
    }
    if (Number.isFinite(video.duration) && video.duration > 0.5) {
      const target = Math.min(3, video.duration * 0.1);
      try {
        video.currentTime = target;
        await waitFor("seeked", 3000);
      } catch {
        // La première image reste une miniature acceptable si la recherche
        // d’une image plus représentative n’est pas supportée.
      }
    }
    const scale = Math.min(1, 640 / width, 640 / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvasJPEG(canvas, 0.78);
  } finally {
    clearTimeout(timeout);
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(sourceURL);
  }
}

async function pdfFilePreview(data) {
  const pdfjs = await compatiblePDFJS();
  let loadingTask;
  let pdfDocument;
  try {
    ({ loadingTask, pdfDocument } = await openPDFDocument(pdfjs, data, 20000, "La préparation de l’aperçu PDF"));
    const page = await pdfOperationWithTimeout(pdfDocument.getPage(1), 10000, "La lecture de la première page");
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(640 / base.width, 800 / base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: context, viewport });
    await pdfOperationWithTimeout(task.promise, 15000, "Le rendu de l’aperçu PDF");
    return canvasJPEG(croppedPDFPreviewCanvas(canvas, base.width / base.height));
  } finally {
    if (pdfDocument) {
      await pdfDocument.destroy().catch(() => {});
    } else if (loadingTask) {
      await loadingTask.destroy().catch(() => {});
    }
  }
}

async function officeFilePreview(file, data) {
  const container = document.createElement("div");
  container.className = "file-preview office-file-preview";
  container.style.position = "fixed";
  container.style.left = "-100000px";
  container.style.top = "0";
  container.style.width = "620px";
  container.style.maxWidth = "620px";
  document.body.append(container);
  try {
    const officeFile = { name: file.name, mime: normalizedFileMIME(file.type, file.name), data };
    let preview = null;
    try {
      preview = await renderModernOfficePreview(
        officeFile,
        container,
        { rasterOnly: true, locale, translate: t },
      );
    } catch (error) {
      console.warn("Création de la miniature Office fidèle impossible", error);
    }
    if (preview?.size > 0 && preview.size <= FILE_PREVIEW_MAX_BYTES) return preview;
    if (preview?.size > FILE_PREVIEW_MAX_BYTES) {
      console.warn("Miniature Office fidèle trop volumineuse, utilisation de la miniature de secours");
    }
    const fallback = await officeFallbackPreviewBlob(officeFile);
    return fallback?.size > 0 && fallback.size <= FILE_PREVIEW_MAX_BYTES ? fallback : null;
  } finally {
    container.remove();
  }
}

async function renderTemporaryOfficeThumbnail(container) {
  const file = { name: container.dataset.fileName || "", mime: container.dataset.fileMime || "" };
  if (!modernOfficeKind(file)) return "";
  const blob = await officeFallbackPreviewBlob(file);
  if (!blob || !container.isConnected) return "";
  const url = URL.createObjectURL(blob);
  const image = document.createElement("img");
  image.className = "office-page-preview office-fallback-preview";
  image.src = url;
  image.alt = t("Aperçu");
  image.decoding = "async";
  image.loading = "eager";
  container.classList.add("office-file-preview", `office-${modernOfficeKind(file)}-file-preview`);
  container.closest(".message-row")?.classList.add("office-message");
  container.replaceChildren(image);
  return url;
}

async function encryptedFilePreview(file, data, key) {
  try {
    const mime = mimeEssence(normalizedFileMIME(file.type, file.name));
    let blob = null;
    if (/^image\/(avif|bmp|gif|jpeg|png|webp)$/i.test(mime)) {
      blob = await rasterFilePreview(file, data);
    } else if (mime.startsWith("video/")) {
      blob = await videoFilePreview(file, data);
    } else if (mime === "application/pdf") {
      blob = await pdfFilePreview(data);
    } else if (modernOfficeKind({ name: file.name, mime })) {
      blob = await officeFilePreview(file, data);
    }
    if (!blob || blob.size === 0 || blob.size > FILE_PREVIEW_MAX_BYTES) return null;
    return encryptBytes(key, await blob.arrayBuffer());
  } catch (error) {
    console.warn("Création de l’aperçu chiffré impossible", error);
    return null;
  }
}

async function sendEncryptedFile(file, successMessage) {
  const maxFileSize = Number(state.fileQuotas?.max_file_size || 25 * 1024 * 1024);
  const maxUserStorage = Number(state.fileQuotas?.max_user_storage || 1024 * 1024 * 1024);
  const usedStorage = Number(state.fileQuotas?.used_storage || 0);
  if (file.size > maxFileSize) {
    toast(`Le fichier dépasse la limite de ${formatFileQuotaSize(maxFileSize)}.`, "error");
    return false;
  }
  if (usedStorage > maxUserStorage || file.size + 16 > maxUserStorage - usedStorage) {
    toast("Le quota total de fichiers de votre compte est atteint.", "error");
    return false;
  }
  const conversation = state.current;
  if (!conversation) return false;
  const expiresInSeconds = state.messageExpirationSeconds;
  toast("Chiffrement et envoi du fichier…");
  try {
    const key = await getConversationKey(conversation);
    const data = await file.arrayBuffer();
    const [encrypted, encryptedName, encryptedMIME, preview] = await Promise.all([
      encryptBytes(key, data),
      encryptEnvelope(key, file.name),
      encryptEnvelope(key, file.type || "application/octet-stream"),
      encryptedFilePreview(file, data, key),
    ]);
    const body = {
      conversation_id: conversation.id,
      encrypted_name: encryptedName,
      encrypted_mime: encryptedMIME,
      encrypted_data: encrypted.data,
      iv: encrypted.iv,
      encrypted_preview_data: preview?.data || "",
      preview_iv: preview?.iv || "",
      expires_in_seconds: expiresInSeconds,
      key_epoch: conversationKeyEpoch(conversation),
      ciphertext_sha256: await sha256Hex(base64ToBytes(encrypted.data)),
      preview_sha256: preview?.data ? await sha256Hex(base64ToBytes(preview.data)) : "",
    };
    Object.assign(body, await messageSignature("file", conversation.id, body));
    const message = await api("/api/files", {
      method: "POST",
      body,
    });
    state.fileQuotas.used_storage = usedStorage + data.byteLength + 16;
    updateProfileStorage();
    await appendMessage(message);
    await refreshConversationList();
    toast(successMessage, "success");
    return true;
  } catch (error) {
    toast(frenchErrorMessage(error), "error");
    return false;
  }
}

function formatFileQuotaSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2).replace(/\.00$/, "")} Go`;
  return `${(bytes / (1024 * 1024)).toFixed(2).replace(/\.00$/, "")} Mo`;
}

function formatStorageMegabytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  return t("{count} Mo", {
    count: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value),
  });
}

function updateProfileStorage() {
  const progress = document.querySelector("#profile-storage-progress");
  const status = document.querySelector("#profile-storage-status");
  if (!progress || !status) return;
  const max = Number(state.fileQuotas?.max_user_storage);
  const used = Math.max(0, Number(state.fileQuotas?.used_storage) || 0);
  if (!Number.isFinite(max) || max <= 0) {
    progress.hidden = true;
    status.textContent = t("Espace de stockage indisponible.");
    return;
  }
  const boundedUsed = Math.min(used, max);
  const percent = Math.min(100, Math.round((boundedUsed / max) * 100));
  progress.hidden = false;
  progress.max = max;
  progress.value = boundedUsed;
  progress.classList.toggle("near-limit", percent >= 80 && percent < 100);
  progress.classList.toggle("at-limit", percent >= 100);
  progress.setAttribute("aria-label", t("Espace de stockage"));
  progress.setAttribute("aria-valuetext", t("{used} utilisés sur {max} ({percent} %)", {
    used: formatStorageMegabytes(boundedUsed),
    max: formatStorageMegabytes(max),
    percent,
  }));
  status.textContent = progress.getAttribute("aria-valuetext");
}

function setVoiceDraft(file) {
  clearVoiceDraft();
  state.pendingVoiceFile = file;
  state.pendingVoiceURL = URL.createObjectURL(file);
  elements.voiceDraftAudio.src = state.pendingVoiceURL;
  elements.voiceDraftAudio.load();
  elements.voiceDraft.hidden = false;
  elements.input.placeholder = "Message vocal en attente…";
}

function clearVoiceDraft() {
  if (state.pendingVoiceURL) URL.revokeObjectURL(state.pendingVoiceURL);
  state.pendingVoiceFile = null;
  state.pendingVoiceURL = null;
  elements.voiceDraftAudio.removeAttribute("src");
  elements.voiceDraftAudio.load();
  elements.voiceDraft.hidden = true;
  elements.input.placeholder = "Message chiffré…";
}

function supportedAudioRecordingType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  return [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ].find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
}

function audioExtensionForMIME(mime) {
  if (/ogg/i.test(mime)) return "ogg";
  if (/mp4|aac/i.test(mime)) return "m4a";
  return "webm";
}

async function toggleVoiceRecording() {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("L’enregistrement vocal n’est pas disponible dans cet environnement.", "error");
    return;
  }
  try {
    clearVoiceDraft();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = supportedAudioRecordingType();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.recorder = recorder;
    state.recordingChunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) state.recordingChunks.push(event.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      clearTimeout(state.recordingStopTimer);
      state.recordingStopTimer = null;
      elements.voiceButton.classList.remove("recording");
      const recordedMime = recorder.mimeType || mime || "audio/webm";
      const blob = new Blob(state.recordingChunks, { type: recordedMime });
      state.recorder = null;
      state.recordingChunks = [];
      if (!blob.size) return;
      const extension = audioExtensionForMIME(recordedMime);
      const file = new File([blob], `message-vocal-${Date.now()}.${extension}`, { type: blob.type || recordedMime });
      setVoiceDraft(file);
      toast("Message vocal prêt à envoyer.");
    };
    recorder.start();
    state.recordingStopTimer = setTimeout(() => {
      if (state.recorder?.state === "recording") state.recorder.stop();
    }, 120000);
    elements.voiceButton.classList.add("recording");
    toast("Enregistrement vocal en cours.");
  } catch (error) {
    toast(frenchErrorMessage(error, "Microphone inaccessible."), "error");
  }
}

function openFileShareDialog(message, clear, conversation = state.current) {
  state.pendingFileShare = { message, clear, conversation };
  state.activeFileShareID = null;
  elements.fileShareName.textContent = clear.name;
  elements.fileShareExpiration.value = "604800";
  elements.fileShareError.textContent = "";
  elements.fileShareURL.value = "";
  elements.fileShareValidity.textContent = "";
  elements.fileShareResult.hidden = true;
  elements.fileShareCreateActions.hidden = false;
  elements.fileShareExpiration.disabled = false;
  elements.fileShareCopy.disabled = false;
  elements.fileShareRevoke.disabled = false;
  elements.fileShareExisting.hidden = true;
  elements.fileShareExistingList.replaceChildren();
  elements.fileShareDialog.showModal();
  loadExistingFileShares(message.file.id);
}

async function loadExistingFileShares(fileID) {
  try {
    const shares = await api(`/api/files/${fileID}/shares`);
    elements.fileShareExistingList.replaceChildren();
    const active = shares.filter((share) => share.active);
    elements.fileShareExisting.hidden = active.length === 0;
    for (const share of active) {
      const row = document.createElement("div");
      row.className = "file-share-existing-row";
      const details = document.createElement("span");
      const label = document.createElement("strong");
      label.textContent = t("Valable jusqu’au {date}", { date: new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(share.expires_at)) });
      const downloads = document.createElement("small");
      downloads.textContent = `${share.download_count} téléchargement${share.download_count === 1 ? "" : "s"}`;
      details.append(label, downloads);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "outline danger-text";
      revoke.textContent = t("Désactiver");
      revoke.addEventListener("click", async () => {
        setBusy(revoke, true, "…");
        try {
          await api(`/api/file-shares/${share.id}`, { method: "DELETE" });
          row.remove();
          elements.fileShareExisting.hidden = !elements.fileShareExistingList.children.length;
          toast("Lien de partage désactivé.", "success");
        } catch (error) {
          setBusy(revoke, false);
          elements.fileShareError.textContent = frenchErrorMessage(error, "Impossible de désactiver le lien.");
        }
      });
      row.append(details, revoke);
      elements.fileShareExistingList.append(row);
    }
  } catch {
    elements.fileShareExisting.hidden = true;
  }
}

function closeFileShareDialog() {
  elements.fileShareDialog.close();
  state.pendingFileShare = null;
  state.activeFileShareID = null;
}

async function createFileShare(event) {
  event.preventDefault();
  if (!state.pendingFileShare?.conversation) return;
  elements.fileShareError.textContent = "";
  setBusy(elements.fileShareCreate, true, "Chiffrement…");
  try {
    const { message, conversation } = state.pendingFileShare;
    const conversationKey = await getMessageKey(message, conversation);
    const file = await loadDecryptedFile(message, conversationKey);
    const shareKey = await generateShareKey();
    const [encrypted, encryptedName, encryptedMIME, exportedKey] = await Promise.all([
      encryptBytes(shareKey, file.data),
      encryptEnvelope(shareKey, file.name),
      encryptEnvelope(shareKey, file.mime || "application/octet-stream"),
      exportShareKey(shareKey),
    ]);
    const share = await api(`/api/files/${message.file.id}/shares`, {
      method: "POST",
      body: {
        encrypted_name: encryptedName,
        encrypted_mime: encryptedMIME,
        encrypted_data: encrypted.data,
        iv: encrypted.iv,
        size: file.data.byteLength,
        expires_in_seconds: Number(elements.fileShareExpiration.value),
      },
    });
    const publicURL = new URL("/share.html", `${getInstanceURL() || location.origin}/`);
    publicURL.searchParams.set("token", share.token);
    publicURL.hash = new URLSearchParams({ key: exportedKey }).toString();
    elements.fileShareURL.value = publicURL.toString();
    elements.fileShareValidity.textContent = t("Valable jusqu’au {date}.", { date: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(share.expires_at)) });
    elements.fileShareResult.hidden = false;
    elements.fileShareCreateActions.hidden = true;
    elements.fileShareExpiration.disabled = true;
    state.activeFileShareID = share.id;
    loadExistingFileShares(message.file.id);
    toast("Lien de partage sécurisé créé.", "success");
  } catch (error) {
    elements.fileShareError.textContent = frenchErrorMessage(error, "Impossible de créer le lien de partage.");
  } finally {
    setBusy(elements.fileShareCreate, false);
  }
}

async function copyFileShareLink() {
  const link = elements.fileShareURL.value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    elements.fileShareURL.focus();
    elements.fileShareURL.select();
    if (!document.execCommand("copy")) {
      toast("Sélectionnez puis copiez le lien manuellement.", "error");
      return;
    }
  }
  toast("Lien copié.", "success");
}

async function revokeFileShare() {
  if (!state.activeFileShareID) return;
  setBusy(elements.fileShareRevoke, true, "Désactivation…");
  try {
    await api(`/api/file-shares/${state.activeFileShareID}`, { method: "DELETE" });
    state.activeFileShareID = null;
    elements.fileShareURL.value = "";
    elements.fileShareValidity.textContent = t("Ce lien a été désactivé.");
    elements.fileShareCopy.disabled = true;
    toast("Lien de partage désactivé.", "success");
    if (state.pendingFileShare?.message?.file?.id) loadExistingFileShares(state.pendingFileShare.message.file.id);
  } catch (error) {
    elements.fileShareError.textContent = frenchErrorMessage(error, "Impossible de désactiver le lien.");
  } finally {
    setBusy(elements.fileShareRevoke, false);
    elements.fileShareRevoke.disabled = !state.activeFileShareID;
  }
}

async function downloadFile(message, name, button) {
  const confirmed = await actionDialog({
    title: "Télécharger le fichier",
    message: `Télécharger « ${name} » ?`,
    confirmLabel: "Télécharger",
  });
  if (!confirmed) return;
  if (button) {
    button.disabled = true;
    button.textContent = "…";
  }
  try {
    const key = await getMessageKey(message, state.current);
    const file = await loadDecryptedFile(message, key);
    const link = document.createElement("a");
    link.href = file.url;
    link.download = file.name;
    link.click();
  } catch (error) {
    toast(`Téléchargement impossible : ${frenchErrorMessage(error)}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "↓";
    }
  }
}

async function editMessage(message, clear, row) {
  if (message.signature_valid === false) {
    toast(t("Modification impossible : la signature du message est invalide."), "error");
    return;
  }
  if (message.poll) {
    row.dispatchEvent(new Event("swipe-close"));
    openPollDialog(message, clear);
    return;
  }
  if (message.event) {
    row.dispatchEvent(new Event("swipe-close"));
    openEventDialog(message, clear);
    return;
  }
  const text = await actionDialog({
    title: "Modifier le message",
    inputLabel: "Message",
    value: clear,
    confirmLabel: "Enregistrer",
  });
  if (!text || text === clear) {
    row.dispatchEvent(new Event("swipe-close"));
    return;
  }
  row.classList.add("action-pending");
  try {
    const key = await getMessageKey(message, state.current);
    const encrypted = await encryptText(key, text);
    const body = { encrypted_content: encrypted.data, iv: encrypted.iv };
    Object.assign(body, await messageSignature("text", message.conversation_id, body, message));
    await api(`/api/messages/${message.id}`, {
      method: "PUT",
      body,
    });
    await loadMessages(null, false);
    toast("Message modifié.", "success");
  } catch (error) {
    row.classList.remove("action-pending");
    row.dispatchEvent(new Event("swipe-close"));
    toast(frenchErrorMessage(error, "Impossible de modifier le message."), "error");
  }
}

async function deleteMessage(message, row) {
  const confirmed = await actionDialog({
    title: "Supprimer le message",
    message: "Supprimer définitivement ce message ?",
    confirmLabel: "Supprimer",
    danger: true,
  });
  if (!confirmed) {
    row.dispatchEvent(new Event("swipe-close"));
    return;
  }
  row.classList.add("message-deleting");
  try {
    await api(`/api/messages/${message.id}`, { method: "DELETE" });
    state.cache?.deleteMessage(message.conversation_id, message.id);
    if (message.file) {
      const cached = state.files.get(message.file.id);
      if (cached) URL.revokeObjectURL(cached.url);
      const thumbnail = state.fileThumbnails.get(message.file.id);
      if (thumbnail) revokeFileThumbnail(thumbnail);
      state.files.delete(message.file.id);
      state.fileLoads.delete(message.file.id);
      state.fileThumbnails.delete(message.file.id);
      state.fileThumbnailLoads.delete(message.file.id);
    }
    clearMessageExpiration(message);
    state.messageClears.get(message.conversation_id)?.delete(message.id);
    row.remove();
    if (!elements.messages.querySelector(".message")) {
      const empty = document.createElement("div");
      empty.id = "empty-chat";
      empty.textContent = t("Aucun message. Écrivez le premier message chiffré.");
      elements.messages.append(empty);
    }
    toast("Message supprimé.", "success");
    await refreshAll();
  } catch (error) {
    row.classList.remove("message-deleting");
    row.dispatchEvent(new Event("swipe-close"));
    toast(frenchErrorMessage(error, "Impossible de supprimer le message."), "error");
  }
}

async function loadDecryptedFile(message, key) {
  if (message.signature_valid === false) throw new Error("La signature du fichier est invalide.");
  const cached = state.files.get(message.file.id);
  if (cached) return cached;
  const pending = state.fileLoads.get(message.file.id);
  if (pending) return pending;
  const generation = state.fileCacheGeneration;
  const load = (async () => {
    let payload = await state.cache?.getFilePayload(message.file.id);
    if (!payload) {
      payload = await api(`/api/files/${message.file.id}`);
      state.cache?.saveFilePayload(message.file.id, payload);
    }
    if (message.signature_version && (!message.file.ciphertext_sha256 ||
        message.file.ciphertext_sha256 !== payload.ciphertext_sha256 ||
        message.file.ciphertext_sha256 !== await sha256Hex(base64ToBytes(payload.encrypted_data)))) {
      throw new Error("La signature du fichier est invalide.");
    }
    const [name, mime, data] = await Promise.all([
      decryptEnvelope(key, payload.encrypted_name),
      decryptEnvelope(key, payload.encrypted_mime),
      decryptBytes(key, payload.encrypted_data, payload.iv),
    ]);
    const safeMIME = normalizedFileMIME(mime, name);
    const blob = new Blob([data], { type: safeMIME });
    const file = { name, mime: safeMIME, data, url: URL.createObjectURL(blob) };
    if (generation !== state.fileCacheGeneration) {
      URL.revokeObjectURL(file.url);
      throw new Error("L’aperçu n’est plus disponible.");
    }
    state.files.set(message.file.id, file);
    return file;
  })();
  state.fileLoads.set(message.file.id, load);
  try {
    return await load;
  } finally {
    if (state.fileLoads.get(message.file.id) === load) state.fileLoads.delete(message.file.id);
  }
}

async function loadDecryptedFileThumbnail(message, key) {
  if (message.signature_valid === false) return null;
  if (message.file.has_preview !== true) return null;
  const cached = state.fileThumbnails.get(message.file.id);
  if (cached) return cached;
  const pending = state.fileThumbnailLoads.get(message.file.id);
  if (pending) return pending;
  const generation = state.fileCacheGeneration;
  const load = (async () => {
    let payload = await state.cache?.getFilePreview(message.file.id);
    if (!payload) {
      payload = await api(`/api/files/${message.file.id}/preview`);
      state.cache?.saveFilePreview(message.file.id, payload);
    }
    if (message.signature_version && (!message.file.preview_sha256 ||
        message.file.preview_sha256 !== payload.preview_sha256 ||
        message.file.preview_sha256 !== await sha256Hex(base64ToBytes(payload.encrypted_data)))) {
      throw new Error("La signature de l’aperçu est invalide.");
    }
    const data = await decryptBytes(key, payload.encrypted_data, payload.iv);
    if (data.byteLength === 0 || data.byteLength > FILE_PREVIEW_MAX_BYTES) {
      throw new Error("L’aperçu du fichier est invalide.");
    }
    const thumbnail = {
      // The preview is normally JPEG, but Office rendering can fall back to
      // PNG on Safari/WebView. Let the browser sniff the self-describing image
      // bytes instead of forcing a possibly wrong MIME type.
      url: URL.createObjectURL(new Blob([data])),
    };
    if (generation !== state.fileCacheGeneration) {
      URL.revokeObjectURL(thumbnail.url);
      throw new Error("L’aperçu n’est plus disponible.");
    }
    state.fileThumbnails.set(message.file.id, thumbnail);
    return thumbnail;
  })();
  state.fileThumbnailLoads.set(message.file.id, load);
  try {
    return await load;
  } finally {
    if (state.fileThumbnailLoads.get(message.file.id) === load) state.fileThumbnailLoads.delete(message.file.id);
  }
}

async function renderEncryptedFileThumbnail(message, container, key) {
  if (message.file.has_preview !== true) return false;
  try {
    const thumbnail = state.fileThumbnails.get(message.file.id) || await loadDecryptedFileThumbnail(message, key);
    if (!thumbnail || !container.isConnected) return false;
    const previewMIME = mimeEssence(normalizedFileMIME(container.dataset.fileMime, container.dataset.fileName));
    const display = previewMIME === "application/pdf"
      ? await preparedPDFThumbnail(thumbnail)
      : { url: thumbnail.url };
    if (!container.isConnected) return false;
    const image = document.createElement("img");
    image.src = display.url;
    image.alt = previewMIME.startsWith("video/") ? t("Aperçu de la vidéo") : t("Aperçu");
    image.decoding = "async";
    image.loading = "eager";
    if (previewMIME === "application/pdf" && !container.classList.contains("message-reply-file-thumb")) {
      markPDFFilePreview(container);
      fitPDFPreviewToAspect(container, display.width || image.naturalWidth, display.height || image.naturalHeight);
    }
    if (previewMIME.startsWith("video/") && !container.classList.contains("message-reply-file-thumb")) {
      const frame = document.createElement("div");
      frame.className = "video-file-thumbnail";
      const play = document.createElement("button");
      play.type = "button";
      play.className = "video-file-play-button";
      play.textContent = "▶";
      play.title = t("Lire la vidéo");
      play.setAttribute("aria-label", t("Lire la vidéo"));
      play.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        play.disabled = true;
        play.setAttribute("aria-busy", "true");
        try {
          const file = await loadDecryptedFile(message, key);
          if (container.isConnected) renderVideoPlayer(file, container, { poster: thumbnail.url, autoplay: true });
        } catch (error) {
          play.disabled = false;
          play.removeAttribute("aria-busy");
          toast(frenchErrorMessage(error, "Impossible de charger la vidéo."), "error");
        }
      });
      frame.append(image, play);
      container.replaceChildren(frame);
    } else {
      container.replaceChildren(image);
    }
    return true;
  } catch (error) {
    console.warn("Chargement de l’aperçu chiffré impossible, utilisation du fichier original", error);
    return false;
  }
}

function loadPreviewImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("L’image de l’aperçu PDF est illisible."));
    image.src = url;
  });
}

async function preparedPDFThumbnail(thumbnail) {
  if (thumbnail.displayURL) {
    return { url: thumbnail.displayURL, width: thumbnail.displayWidth, height: thumbnail.displayHeight };
  }
  if (!thumbnail.displayLoad) {
    thumbnail.displayLoad = (async () => {
      const source = await loadPreviewImage(thumbnail.url);
      if (thumbnail.revoked) throw new Error("L’aperçu PDF n’est plus disponible.");
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0);
      const cropped = croppedPDFPreviewCanvas(canvas, source.naturalWidth / source.naturalHeight);
      let url = thumbnail.url;
      if (cropped !== canvas) {
        const blob = await canvasJPEG(cropped, 0.82);
        if (blob) url = URL.createObjectURL(blob);
      }
      if (thumbnail.revoked) {
        if (url !== thumbnail.url) URL.revokeObjectURL(url);
        throw new Error("L’aperçu PDF n’est plus disponible.");
      }
      thumbnail.displayURL = url;
      thumbnail.displayWidth = cropped.width;
      thumbnail.displayHeight = cropped.height;
      return { url, width: cropped.width, height: cropped.height };
    })().finally(() => {
      delete thumbnail.displayLoad;
    });
  }
  return thumbnail.displayLoad;
}

function normalizedFileMIME(mime, name) {
  const normalized = (mime || "").trim().toLowerCase();
  const essence = mimeEssence(normalized);
  if (essence && essence !== "application/octet-stream" && /^[\w.+-]+\/[\w.+-]+$/i.test(essence)) return normalized;
  const extension = name.split(".").pop()?.toLowerCase();
  return {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    m4v: "video/mp4",
    mov: "video/quicktime",
    mp4: "video/mp4",
    webm: "video/webm",
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    csv: "text/csv",
    json: "application/json",
    log: "text/plain",
    md: "text/markdown",
    txt: "text/plain",
    xml: "application/xml",
  }[extension] || "application/octet-stream";
}

function mimeEssence(mime) {
  return (mime || "").split(";")[0].trim().toLowerCase();
}

function markPDFFilePreview(container) {
  container.classList.add("pdf-file-preview");
  container.closest(".message-row")?.classList.add("pdf-message");
}

function fitPDFPreviewToAspect(container, width, height) {
  if (width <= 0 || height <= 0 || container.classList.contains("message-reply-file-thumb")) return;
  const row = container.closest(".message-row");
  if (!row) return;
  // La boîte suit le ratio exact de la première page : Safari n’a ainsi plus
  // à centrer le JPEG dans un cadre fixe de 620 × 420 px.
  const previewWidth = Math.min(620, Math.max(1, 420 * (width / height)));
  container.classList.add("fitted-pdf-preview");
  row.classList.add("fitted-pdf-message");
  row.style.setProperty("--pdf-preview-width", `${Math.round(previewWidth)}px`);
}

function prefetchFileThumbnail(message, key) {
  if (message.file?.has_preview !== true) return;
  void loadDecryptedFileThumbnail(message, key).catch(() => {});
}

function prefetchRecentFileThumbnails(decryptedMessages, limit = 16) {
  let scheduled = 0;
  for (const { message, key } of decryptedMessages) {
    if (message.file?.has_preview !== true) continue;
    prefetchFileThumbnail(message, key);
    scheduled++;
    if (scheduled >= limit) break;
  }
}

function prewarmFilePreviewRenderers(decryptedMessages) {
  for (const { message, clear } of decryptedMessages) {
    if (!message.file || message.file.has_preview === true || !clear) continue;
    const file = { name: clear.name || "", mime: clear.mime || "" };
    if (mimeEssence(file.mime) === "application/pdf") {
      void pdfJS().catch(() => {});
    } else if (modernOfficeKind(file)) {
      void preloadModernOfficePreview(file).catch(() => {});
    }
  }
}

function supportsFullFilePreview(file) {
  const mime = mimeEssence(file.mime);
  return /^image\//i.test(mime) || /^(?:video|audio)\//i.test(mime) ||
    mime === "application/pdf" || mime.startsWith("text/") ||
    /(?:json|xml|javascript)$/i.test(mime) || Boolean(modernOfficeKind(file));
}

function prefetchRecentFullFilePreviews(
  decryptedMessages,
  limit = 4,
  byteBudget = FILE_PREVIEW_PREFETCH_BUDGET_BYTES,
) {
  let scheduled = 0;
  let remainingBytes = byteBudget;
  for (const { message, clear, key } of decryptedMessages) {
    if (!message.file || message.file.has_preview === true || !supportsFullFilePreview(clear || {})) continue;
    const size = Number(message.file.size) || 0;
    if (size <= 0 || size > remainingBytes) continue;
    void loadDecryptedFile(message, key).catch(() => {});
    remainingBytes -= size;
    scheduled++;
    if (scheduled >= limit || remainingBytes <= 0) break;
  }
}

function scheduleFilePreview(message, container, key) {
  if (!("IntersectionObserver" in window)) {
    renderFilePreview(message, container, key);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    state.filePreviewObservers.delete(observer);
    renderFilePreview(message, container, key);
  }, { root: elements.messages, rootMargin: "1200px 0px" });
  state.filePreviewObservers.add(observer);
  observer.observe(container.closest(".file-attachment") || container);
}

function scheduleReplyFilePreview(replyPreview, container, conversation) {
  if (!replyPreview.fileID) {
    renderUnavailableReplyPreview(container);
    return;
  }
  const message = {
    file: {
      id: replyPreview.fileID,
      size: replyPreview.size || 0,
      has_preview: replyPreview.hasPreview === true,
      preview_size: replyPreview.previewSize || 0,
    },
  };
  const render = async () => {
    try {
      const key = await getConversationKey(conversation, replyPreview.keyEpoch || 1);
      renderReplyFilePreview(message, container, key);
    } catch {
      renderUnavailableReplyPreview(container);
    }
  };
  if (!("IntersectionObserver" in window)) {
    void render();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    state.filePreviewObservers.delete(observer);
    void render();
  }, { root: elements.messages, rootMargin: "1200px 0px" });
  state.filePreviewObservers.add(observer);
  observer.observe(container.closest(".message-reply-preview") || container);
}

function loadPDFScript(source, available) {
  if (available()) return Promise.resolve();
  if (pdfScriptLoads.has(source)) return pdfScriptLoads.get(source);
  const load = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(() => {
      script.remove();
      reject(new Error(`Le chargement du moteur PDF a expiré (${source}).`));
    }, 12000);
    script.src = source;
    script.async = true;
    script.onload = () => {
      clearTimeout(timeout);
      if (available()) resolve();
      else reject(new Error(`Le moteur PDF ${source} n’est pas disponible.`));
    };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      reject(new Error(`Impossible de charger le moteur PDF ${source}.`));
    };
    document.head.append(script);
  }).catch((error) => {
    pdfScriptLoads.delete(source);
    throw error;
  });
  pdfScriptLoads.set(source, load);
  return load;
}

async function ios17PDFJS() {
  if (!ios17PDFJSModule) {
    ios17PDFJSModule = (async () => {
      // PDF.js 4.x ne prend officiellement en charge Safari qu’à partir de la
      // version 18. iOS 17 utilise donc le build classique 3.11 : aucun module
      // ES et aucun vrai Web Worker, deux chemins instables dans WKWebView 17.
      await loadPDFScript(
        "/vendor/pdfjs-ios17/pdf.worker.min.js?v=ios17-pdf-v199",
        () => typeof globalThis.pdfjsWorker?.WorkerMessageHandler === "function",
      );
      await loadPDFScript(
        "/vendor/pdfjs-ios17/pdf.min.js?v=ios17-pdf-v199",
        () => globalThis.pdfjsLib?.version === "3.11.174",
      );
      const module = globalThis.pdfjsLib;
      module.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs-ios17/pdf.worker.min.js?v=ios17-pdf-v199";
      return module;
    })().catch((error) => {
      ios17PDFJSModule = null;
      throw error;
    });
  }
  return ios17PDFJSModule;
}

async function pdfJS() {
  if (needsInlinePDFWorker()) return ios17PDFJS();
  if (!pdfJSModule) {
    pdfJSModule = import("/vendor/pdfjs/pdf.compat.mjs?v=ios17-pdf-v199")
      .then(async () => {
        const module = await import("/vendor/pdfjs/pdf.min.mjs?v=ios17-pdf-v199");
        module.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.compat.mjs?v=ios17-pdf-v199";
        return module;
      })
      .catch((error) => {
        // Une coupure réseau pendant le chargement ne doit pas condamner tous
        // les aperçus suivants jusqu'au prochain rechargement de l'application.
        pdfJSModule = null;
        throw error;
      });
  }
  return pdfJSModule;
}

async function compatiblePDFJS() {
  try {
    return await pdfJS();
  } catch (error) {
    // Certains Firefox/WebViews refusent le module PDF.js moderne ou son
    // worker. Le build classique reste un moteur de rendu, jamais un lecteur
    // natif : la sortie est toujours convertie en JPEG.
    console.warn("PDF.js moderne indisponible, essai du moteur compatible", error);
    return ios17PDFJS();
  }
}

function pdfOperationWithTimeout(operation, timeoutMS, label) {
  let timeout;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} a expiré.`)), timeoutMS);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function openPDFDocument(pdfjs, data, timeoutMS, label) {
  const options = pdfDocumentCompatibilityOptions();
  let loadingTask = pdfjs.getDocument({ data: data.slice(0), ...options });
  try {
    const pdfDocument = await pdfOperationWithTimeout(loadingTask.promise, timeoutMS, label);
    return { loadingTask, pdfDocument };
  } catch (firstError) {
    await loadingTask.destroy().catch(() => {});
    if (needsInlinePDFWorker()) throw firstError;
    loadingTask = pdfjs.getDocument({ data: data.slice(0), ...options, disableWorker: true });
    try {
      const pdfDocument = await pdfOperationWithTimeout(loadingTask.promise, timeoutMS, label);
      return { loadingTask, pdfDocument };
    } catch (secondError) {
      await loadingTask.destroy().catch(() => {});
      throw secondError;
    }
  }
}

async function renderPDFPreview(file, container) {
  let pdfDocument;
  let loadingTask;
  let renderTask;
  try {
    const pdfjs = await compatiblePDFJS();
    ({ loadingTask, pdfDocument } = await openPDFDocument(
      pdfjs,
      file.data,
      needsInlinePDFWorker() ? 20000 : 15000,
      "Le chargement du PDF",
    ));
    const page = await pdfOperationWithTimeout(pdfDocument.getPage(1), 10000, "La lecture de la première page");
    const baseViewport = page.getViewport({ scale: 1 });
    const isReplyPreview = container.classList.contains("message-reply-file-thumb");
    const availableWidth = Math.round(container.getBoundingClientRect().width);
    const renderWidth = isReplyPreview ? 160 : Math.min(Math.max(availableWidth, 240), 620);
    const scale = renderWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width * pixelRatio);
    canvas.height = Math.ceil(viewport.height * pixelRatio);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Le contexte de rendu PDF est indisponible.");
    renderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      background: "#ffffff",
    });
    await pdfOperationWithTimeout(
      renderTask.promise,
      needsInlinePDFWorker() ? 20000 : 15000,
      "Le rendu de la première page",
    );
    const displayedCanvas = croppedPDFPreviewCanvas(canvas, baseViewport.width / baseViewport.height);
    const previewBlob = await canvasJPEG(displayedCanvas, 0.82);
    if (!previewBlob) throw new Error("La conversion JPEG de l’aperçu PDF est indisponible.");
    const previewURL = URL.createObjectURL(previewBlob);
    const image = document.createElement("img");
    image.className = "pdf-page-preview";
    image.src = previewURL;
    image.alt = t("Aperçu");
    image.decoding = "async";
    image.loading = "eager";
    image.draggable = false;
    image.style.width = "100%";
    image.style.maxWidth = "100%";
    image.style.aspectRatio = `${displayedCanvas.width} / ${displayedCanvas.height}`;
    const releasePreviewURL = () => URL.revokeObjectURL(previewURL);
    image.addEventListener("load", releasePreviewURL, { once: true });
    image.addEventListener("error", releasePreviewURL, { once: true });
    container.append(image);
    fitPDFPreviewToAspect(container, displayedCanvas.width, displayedCanvas.height);
  } catch (error) {
    try {
      renderTask?.cancel();
    } catch {}
    console.warn("Rendu JPEG de la première page PDF impossible", error);
    throw error;
  } finally {
    if (pdfDocument) {
      try {
        await pdfOperationWithTimeout(pdfDocument.destroy(), 5000, "La fermeture du moteur PDF");
      } catch (error) {
        // Le document est déjà affiché : un échec de fermeture du worker ne
        // doit pas remplacer l’aperçu par un message d’erreur.
        console.warn("Fermeture du moteur PDF impossible", error);
      }
    } else if (loadingTask) {
      try {
        await pdfOperationWithTimeout(loadingTask.destroy(), 5000, "L’arrêt du chargement PDF");
      } catch {}
    }
  }
}

function recordedVoiceNeedsStableContainer(file) {
  const mime = mimeEssence(file.mime);
  return /^message-vocal-\d+\.(?:webm|ogg|oga)$/i.test(file.name) && /^audio\/(?:webm|ogg)$/i.test(mime);
}

async function stableAudioSourceURL(file) {
  if (!recordedVoiceNeedsStableContainer(file)) return file.url;
  const url = await decodedWAVURL(file.data);
  return url || file.url;
}

async function decodedWAVURL(data) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(data.slice(0));
    const wav = audioBufferToWAV(buffer);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    state.previewURLs.add(url);
    return url;
  } catch (error) {
    console.warn("Préparation WAV du message vocal impossible", error);
    return null;
  } finally {
    if (typeof context.close === "function") {
      context.close().catch(() => {});
    }
  }
}

function audioBufferToWAV(buffer) {
  const channels = Math.min(buffer.numberOfChannels, 2);
  const sampleRate = buffer.sampleRate;
  const samples = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = samples * blockAlign;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  let offset = 0;

  const writeString = (value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset++, value.charCodeAt(i));
  };
  const writeUint32 = (value) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const writeUint16 = (value) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };

  writeString("RIFF");
  writeUint32(36 + dataSize);
  writeString("WAVE");
  writeString("fmt ");
  writeUint32(16);
  writeUint16(1);
  writeUint16(channels);
  writeUint32(sampleRate);
  writeUint32(sampleRate * blockAlign);
  writeUint16(blockAlign);
  writeUint16(16);
  writeString("data");
  writeUint32(dataSize);

  const channelData = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
  for (let i = 0; i < samples; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return output;
}

async function renderAudioPreview(file, container) {
  const audio = document.createElement("audio");
  audio.src = await stableAudioSourceURL(file);
  audio.controls = true;
  audio.preload = "auto";
  audio.setAttribute("aria-label", `Lire ${file.name}`);
  container.replaceChildren(audio);
}

function renderVideoPlayer(file, container, { poster = "", preload = "auto", autoplay = false } = {}) {
  const video = document.createElement("video");
  video.src = file.url;
  video.controls = true;
  video.preload = preload;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-label", t("Lire {name}", { name: file.name }));
  if (poster) video.poster = poster;
  container.replaceChildren(video);
  if (autoplay) video.play().catch(() => {});
  return video;
}

async function renderFilePreview(message, container, key) {
  let temporaryOfficeThumbnailURL = "";
  try {
    if (await renderEncryptedFileThumbnail(message, container, key) || !container.isConnected) return;
    if (message.file.has_preview !== true) {
      temporaryOfficeThumbnailURL = await renderTemporaryOfficeThumbnail(container);
    }
    const file = await loadDecryptedFile(message, key);
    if (!container.isConnected) return;
    const mime = mimeEssence(file.mime);
    container.replaceChildren();
    if (/^image\/(avif|bmp|gif|jpeg|png|webp)$/i.test(mime)) {
      const image = document.createElement("img");
      image.src = file.url;
      image.alt = file.name;
      image.decoding = "async";
      image.loading = "eager";
      container.append(image);
      return;
    }
    if (mime === "image/svg+xml") {
      const image = document.createElement("img");
      const svgURL = sanitizedSVGURL(file.data);
      image.src = svgURL;
      image.alt = file.name;
      container.append(image);
      return;
    }
    if (mime.startsWith("video/")) {
      renderVideoPlayer(file, container);
      return;
    }
    if (mime.startsWith("audio/")) {
      await renderAudioPreview(file, container);
      return;
    }
    if (mime === "application/pdf") {
      markPDFFilePreview(container);
      await renderPDFPreview(file, container);
      return;
    }
    if (modernOfficeKind(file)) {
      container.closest(".message-row")?.classList.add("office-message");
      await renderModernOfficePreview(file, container, { locale, translate: t });
      return;
    }
    if (mime.startsWith("text/") || /(?:json|xml|javascript)$/i.test(mime)) {
      const text = new TextDecoder().decode(file.data.subarray(0, 12000));
      const pre = document.createElement("pre");
      pre.className = "document-page-preview text-document-preview";
      pre.textContent = text;
      container.append(pre);
      if (file.data.length > 12000) {
        const note = document.createElement("small");
        note.textContent = t("Aperçu limité à la première page.");
        container.append(note);
      }
      return;
    }
    const unavailable = document.createElement("div");
    unavailable.className = "file-preview-unavailable";
    const icon = document.createElement("span");
    icon.append(materialFileIcon("file"));
    const label = document.createElement("span");
    label.textContent = t("Aperçu non disponible pour ce format");
    unavailable.append(icon, label);
    container.append(unavailable);
  } catch (error) {
    if (!container.isConnected) return;
    console.error("Chargement de l’aperçu impossible", error);
    container.textContent = frenchErrorMessage(error, "Impossible de charger l’aperçu.");
    container.classList.add("file-preview-error");
  } finally {
    if (temporaryOfficeThumbnailURL) URL.revokeObjectURL(temporaryOfficeThumbnailURL);
  }
}

async function renderReplyFilePreview(message, container, key) {
  try {
    if (await renderEncryptedFileThumbnail(message, container, key) || !container.isConnected) return;
    const file = await loadDecryptedFile(message, key);
    if (!container.isConnected) return;
    const mime = mimeEssence(file.mime);
    container.replaceChildren();
    if (/^image\/(avif|bmp|gif|jpeg|png|webp)$/i.test(mime)) {
      const image = document.createElement("img");
      image.src = file.url;
      image.alt = file.name;
      image.decoding = "async";
      image.loading = "eager";
      container.append(image);
      return;
    }
    if (mime === "image/svg+xml") {
      const image = document.createElement("img");
      image.src = sanitizedSVGURL(file.data);
      image.alt = file.name;
      container.append(image);
      return;
    }
    if (mime.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = file.url;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      container.append(video);
      return;
    }
    if (mime === "application/pdf") {
      await renderPDFPreview(file, container);
      return;
    }
    if (modernOfficeKind(file)) {
      await renderModernOfficePreview(file, container, { compact: true, locale, translate: t });
      return;
    }
    if (mime.startsWith("text/") || /(?:json|xml|javascript)$/i.test(mime)) {
      const text = new TextDecoder().decode(file.data.subarray(0, 800));
      const pre = document.createElement("pre");
      pre.textContent = text;
      container.append(pre);
      return;
    }
    renderUnavailableReplyPreview(container, mime.startsWith("audio/") ? "Audio" : "Doc");
  } catch (error) {
    if (!container.isConnected) return;
    console.error("Chargement de l’aperçu de réponse impossible", error);
    renderUnavailableReplyPreview(container);
  }
}

function renderUnavailableReplyPreview(container, label = "Doc") {
  container.replaceChildren();
  container.textContent = label;
}

function sanitizedSVGURL(data) {
  const source = new TextDecoder().decode(data);
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg") {
    throw new Error("Le fichier SVG est invalide.");
  }
  document.querySelectorAll("script, foreignObject, iframe, object, embed").forEach((element) => element.remove());
  document.querySelectorAll("style").forEach((element) => {
    element.textContent = sanitizeSVGStyles(element.textContent);
  });
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on")
        || ((name === "href" || name.endsWith(":href")) && value && !safeSVGReference(value))
      ) {
        element.removeAttribute(attribute.name);
      } else if (name === "style") {
        element.setAttribute(attribute.name, sanitizeSVGStyles(value));
      } else if (/url\s*\(\s*(['"]?)(?!#)/i.test(value)) {
        element.setAttribute(attribute.name, "none");
      }
    }
  });
  const clean = new XMLSerializer().serializeToString(document.documentElement);
  const url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
  state.previewURLs.add(url);
  return url;
}

function safeSVGReference(value) {
  return value.startsWith("#") || /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(value);
}

function sanitizeSVGStyles(value) {
  return value
    .replace(/@import[^;]+;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, "none")
    .replace(/javascript\s*:/gi, "");
}

async function searchContacts(event) {
  const query = event.target.value.trim();
  const results = document.querySelector("#contact-results");
  results.replaceChildren();
  if (query.length < 2) return;
  try {
    const endpoint = state.edition.federation && query.includes("@") ? "/api/federation/search" : "/api/users/search";
    const users = await api(`${endpoint}?q=${encodeURIComponent(query)}`);
    const availableUsers = users.filter((user) => !state.contacts.some((contact) => (
      contact.status === "accepted" && sameID(contact.contact_user_id, user.id)
    )));
    if (!availableUsers.length) {
      const empty = document.createElement("p");
      empty.className = "picker-empty";
      empty.textContent = "Aucun nouveau contact trouvé.";
      results.append(empty);
      return;
    }
    for (const user of availableUsers) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "picker-row";
      const description = user.description
        ? `<small class="contact-description">${escapeText(user.description)}</small>`
        : "";
      const identity = user.federated
        ? `@${escapeText(user.username)} · ${escapeText(new URL(user.instance_url).host)}`
        : `@${escapeText(user.username)}`;
      row.innerHTML = `<span><strong>${escapeText(user.display_name)}</strong>${description}<small>${identity}</small></span><span>Ajouter</span>`;
      row.onclick = async () => {
        try {
          let conversation;
          if (user.federated) {
            conversation = await api("/api/conversations/federated/private", {
              method: "POST",
              body: { instance_id: user.instance_id, username: user.username },
            });
          } else {
            let contact = state.contacts.find((item) => item.contact_user_id === user.id);
            if (!contact) {
              await api("/api/contacts", { method: "POST", body: { user_id: user.id } });
              await refreshAll();
              contact = state.contacts.find((item) => item.contact_user_id === user.id);
            }
            if (contact?.status !== "accepted" && contact?.direction === "incoming") {
              await api(`/api/contacts/${contact.id}/accept`, { method: "POST" });
              await refreshAll();
              contact = state.contacts.find((item) => item.contact_user_id === user.id);
            }
            if (contact?.status !== "accepted") {
              document.querySelector("#contact-dialog").close();
              await refreshAll();
              toast("Demande envoyée. La discussion sera disponible après acceptation.", "success");
              return;
            }
            conversation = await api("/api/conversations/private", { method: "POST", body: { user_id: user.id } });
          }
          document.querySelector("#contact-dialog").close();
          await refreshAll();
          const selected = state.conversations.find((item) => item.id === conversation.id);
          if (selected) await selectConversation(selected);
        } catch (error) {
          toast(frenchErrorMessage(error), "error");
        }
      };
      results.append(row);
    }
  } catch (error) {
    toast(frenchErrorMessage(error), "error");
  }
}

function renderGroupMemberPicker(list, contacts, options = {}) {
  const {
    selectedIDs = new Set(),
    existingMembers = [],
    extraUsers = [],
    disabledIDs = new Set(),
    emptyText = "Aucun contact. Ajoutez d’abord un contact.",
    onChange = null,
  } = options;
  const acceptedContacts = new Map(contacts
    .filter((contact) => contact.status === "accepted")
    .map((contact) => [contact.contact_user_id, {
      userID: contact.contact_user_id,
      username: contact.username,
      displayName: contact.display_name || contact.username,
      description: contact.description || "",
      accepted: true,
    }]));
  for (const member of existingMembers) {
    if (member.user_id === state.me.id) continue;
    if (!acceptedContacts.has(member.user_id)) {
      acceptedContacts.set(member.user_id, {
        userID: member.user_id,
        username: member.username,
        displayName: member.display_name || member.username,
        description: member.role === "pending" ? "Invitation en attente" : member.description || "",
        accepted: false,
      });
    } else if (member.role === "pending") {
      const contact = acceptedContacts.get(member.user_id);
      contact.description = contact.description || "Invitation en attente";
    }
  }
  for (const user of extraUsers) {
    if (user.id === state.me.id || acceptedContacts.has(user.id)) continue;
    acceptedContacts.set(user.id, {
      userID: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      description: user.description || t("Invitation sans contact privé"),
      accepted: false,
    });
  }
  const candidates = [...acceptedContacts.values()]
    .sort((left, right) => left.username.localeCompare(right.username, "fr"));
  list.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement("p");
    empty.className = "picker-empty";
    empty.textContent = emptyText;
    list.append(empty);
    return;
  }
  for (const contact of candidates) {
    const label = document.createElement("label");
    label.className = "picker-row check";
    const identity = document.createElement("span");
    const displayName = document.createElement("strong");
    displayName.textContent = contact.displayName;
    const description = document.createElement("small");
    description.className = "contact-description";
    description.textContent = contact.description;
    description.hidden = !contact.description;
    const username = document.createElement("small");
    username.textContent = `@${contact.username}`;
    identity.append(displayName, description, username);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(contact.userID);
    checkbox.checked = selectedIDs.has(contact.userID);
    checkbox.disabled = disabledIDs.has(contact.userID);
    checkbox.addEventListener("change", () => onChange?.(contact.userID, checkbox.checked));
    checkbox.setAttribute("aria-label", `${checkbox.checked ? "Retirer" : "Ajouter"} ${contact.displayName} du groupe`);
    label.append(identity, checkbox);
    list.append(label);
  }
}

function selectedNewGroupMemberIDs() {
  return new Set(
    [...document.querySelectorAll("#group-members input:checked")]
      .map((input) => Number(input.value))
      .filter(Boolean),
  );
}

function renderNewGroupMembers(selectedIDs = selectedNewGroupMemberIDs()) {
  renderGroupMemberPicker(document.querySelector("#group-members"), state.contacts, {
    selectedIDs,
    extraUsers: [...groupInvitedUsers.values()],
  });
}

async function searchNewGroupMembers(event) {
  const input = event.target;
  const query = input.value.trim();
  const results = document.querySelector("#group-user-results");
  results.replaceChildren();
  if (query.length < 2) return;
  try {
    const users = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
    if (input.value.trim() !== query) return;
    const listedIDs = new Set([
      ...state.contacts
        .filter((contact) => contact.status === "accepted")
        .map((contact) => contact.contact_user_id),
      ...groupInvitedUsers.keys(),
    ]);
    const availableUsers = users.filter((user) => !sameID(user.id, state.me.id) && !listedIDs.has(user.id));
    for (const user of availableUsers) {
      appendGroupUserSearchResult(results, user, () => {
        const selectedIDs = selectedNewGroupMemberIDs();
        selectedIDs.add(user.id);
        groupInvitedUsers.set(user.id, user);
        input.value = "";
        results.replaceChildren();
        renderNewGroupMembers(selectedIDs);
      });
    }
    if (!availableUsers.length) {
      const empty = document.createElement("p");
      empty.className = "picker-empty";
      empty.textContent = t("Aucun nouveau membre trouvé.");
      results.append(empty);
    }
  } catch (error) {
    toast(frenchErrorMessage(error, "Recherche utilisateur impossible."), "error");
  }
}

async function openGroupDialog() {
  groupAvatar = null;
  groupInvitedUsers.clear();
  document.querySelector("#group-user-search").value = "";
  document.querySelector("#group-user-results").replaceChildren();
  updateGroupAvatarPreview();
  const [contacts, conversations] = await Promise.all([
    api("/api/contacts"),
    api("/api/conversations"),
  ]);
  state.contacts = contacts;
  state.conversations = conversations;
  renderNewGroupMembers(new Set());
  document.querySelector("#group-dialog").showModal();
}

async function createGroup(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const name = document.querySelector("#group-name").value.trim();
  const description = document.querySelector("#group-description").value.trim();
  const selectedIDs = [...selectedNewGroupMemberIDs()];
  if (!name || !selectedIDs.length) {
    toast("Sélectionnez au moins un membre.", "error");
    return;
  }
  setBusy(button, true);
  try {
    const groupKey = await generateGroupKey();
    const selectedMembers = selectedIDs.map((userID) => {
      const contact = state.contacts.find((item) => (
        item.status === "accepted" && sameID(item.contact_user_id, userID)
      ));
      return contact
        ? { ...contact, id: contact.contact_user_id }
        : groupInvitedUsers.get(userID);
    });
    if (selectedMembers.some((member) => !member)) throw new Error("Utilisateur introuvable.");
    const members = [
      state.me,
      ...selectedMembers,
    ];
    const encryptedKeys = {};
    for (const member of members) {
      const memberID = member.contact_user_id ?? member.id;
      const trustedMemberPublicKey = await trustedPublicKey(member, { interactive: true });
      try {
        encryptedKeys[String(memberID)] = await wrapGroupKey(
          groupKey,
          state.privateKey,
          trustedMemberPublicKey,
          state.me.id,
        );
      } catch {
        const identity = memberID === state.me.id
          ? "votre compte"
          : member.display_name || member.username || "ce membre";
        throw new Error(`La clé de chiffrement de ${identity} est invalide. Ce compte doit être recréé.`);
      }
    }
    const encryptedTitle = await encryptEnvelope(groupKey, name);
    const encryptedDescription = description ? await encryptEnvelope(groupKey, description) : null;
    const encryptedAvatar = groupAvatar ? await encryptEnvelope(groupKey, groupAvatar) : null;
    const result = await api("/api/conversations/group", {
      method: "POST",
      body: {
        encrypted_title: encryptedTitle,
        encrypted_description: encryptedDescription,
        encrypted_avatar: encryptedAvatar,
        member_ids: selectedIDs,
        encrypted_keys: encryptedKeys,
      },
    });
    document.querySelector("#group-dialog").close();
    event.currentTarget.reset();
    groupAvatar = null;
    groupInvitedUsers.clear();
    document.querySelector("#group-user-results").replaceChildren();
    updateGroupAvatarPreview();
    await refreshAll();
    const conversation = state.conversations.find((item) => item.id === result.id);
    if (conversation) {
      state.keys.set(conversationKeyCacheID(conversation.id, 1), groupKey);
      await selectConversation(conversation);
    }
  } catch (error) {
    console.error("Création du groupe impossible", error);
    toast(frenchErrorMessage(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function handleSocketEvent(event) {
  if (event.type === "terms_updated") {
    state.socket?.close();
    location.href = "/login.html?terms=required";
  } else if (event.type === "account_banned" || event.type === "sessions_revoked" || event.type === "role_changed") {
    sessionStorage.removeItem("crypto_phrase");
    location.href = "/login.html";
  } else if (event.type === "new_message") {
    invalidateConversationPreload(event.message.conversation_id);
    state.cache?.putMessages([event.message]);
    const isCallHistory = await isIncomingCallHistoryMessage(event.message).catch(() => false);
    const sentFromOwnAccount = sameID(event.message.sender_id, state.me.id);
    if (!isCallHistory && !sentFromOwnAccount) await showIncomingMessageNotification().catch(() => {});
    clearTypingUser(event.message.conversation_id, event.message.sender_id);
    if (state.current?.id === event.message.conversation_id) {
      await appendMessage(event.message);
      await refreshConversationList();
    } else {
      if (!isCallHistory && !sentFromOwnAccount) toast("Nouveau message.");
      await refreshAll();
    }
    await refreshTypingIndicators(event.message.conversation_id);
    if (event.message.event) syncSharedCalendarFeed().catch(() => {});
  } else if (event.type === "message_deleted") {
    await expireRenderedMessage(event.conversation_id, event.message_id);
    syncSharedCalendarFeed().catch(() => {});
  } else if (event.type === "contact_updated") {
    await refreshAll();
    await refreshCurrentConversationHeader();
  } else if (event.type === "presence_state") {
    state.onlineUsers = new Set((event.online_user_ids || []).map(String));
    await renderConversations();
  } else if (event.type === "user_online" || event.type === "user_offline") {
    if (event.type === "user_online") state.onlineUsers.add(String(event.user_id));
    else {
      state.onlineUsers.delete(String(event.user_id));
      handleCallParticipantOffline(event.user_id);
    }
    await renderConversations();
  } else if (event.type === "conversation_updated") {
    invalidateConversationPreload(event.conversation_id);
    const currentID = state.current?.id;
    let profileIdentityBlocked = false;
    state.members.delete(event.conversation_id);
    if (event.profile_updated) {
      try {
        await getMembers(event.conversation_id, { fresh: true });
      } catch (error) {
        error.conversationID = event.conversation_id;
        if (!reportIdentitySecurityError(error)) throw error;
        profileIdentityBlocked = true;
      }
    }
    if (event.removal_notice) {
      const title = t("Retrait d’un groupe");
      const body = t("Vous ne faites plus partie de ce groupe.");
      await showGroupRemovalNotification(title, body, event.conversation_id).catch(() => {});
      toast(body);
    }
    if ((event.deleted || event.removed) && sameID(currentID, event.conversation_id)) {
      closeCurrentConversation(event.conversation_id);
      clearConversationKeys(event.conversation_id);
    }
    state.conversations = await api("/api/conversations");
    const refreshedCurrent = state.conversations.find((conversation) => sameID(conversation.id, currentID));
    if (refreshedCurrent?.rotation_required && sameID(refreshedCurrent.created_by, state.me.id)) {
      try {
        await repairRequiredGroupRotation(refreshedCurrent);
        toast("La clé du groupe a été renouvelée après le départ d’un membre.", "success");
      } catch (error) {
        toast(frenchErrorMessage(error, "Impossible de renouveler immédiatement la clé du groupe."), "error");
      }
    }
    state.cache?.saveConversations(state.conversations);
    await renderConversations();
    if (event.deleted || event.removed) state.cache?.deleteConversation(event.conversation_id);
    if (!profileIdentityBlocked && !(event.deleted || event.removed) && sameID(currentID, event.conversation_id)) {
      await refreshCurrentConversationHeader(currentID);
    }
    if (!profileIdentityBlocked && (event.deleted_message_id || event.updated_message_id || event.reaction_message_id || event.pinned_message_id || event.poll_message_id || event.profile_updated) && sameID(currentID, event.conversation_id)) {
      await loadMessages(null, false);
      if (event.pinned_message_id && !elements.pinnedPanel.hidden) await loadPinnedMessages();
    }
    if (event.deleted_message_id || event.updated_message_id) syncSharedCalendarFeed().catch(() => {});
  } else if (event.type === "typing") {
    await setTypingUser(event.conversation_id, event.user_id, event.typing);
  } else if (event.type?.startsWith("call_") || event.type === "ice_candidate") {
    await handleCallSignal(event);
  } else if (event.type === "message_delivered" || event.type === "message_read") {
    updateConversationPreloadReceipt(event);
    if (state.current?.id === event.conversation_id) {
      const time = elements.messages.querySelector(`[data-id="${event.message_id}"] time`);
      if (time) {
        time.textContent = `${time.textContent.replace(/\s✓✓?$/, "")} ✓✓`;
        time.classList.toggle("read", event.type === "message_read");
      }
    }
  }
}

function sendTyping() {
  if (!state.current) return;
  const conversationID = state.current.id;
  const typing = Boolean(elements.input.value.trim());
  state.socket.send({ type: "typing", conversation_id: conversationID, typing });
  clearTimeout(sendTyping.timer);
  if (!typing) return;
  sendTyping.timer = setTimeout(() => {
    state.socket.send({ type: "typing", conversation_id: conversationID, typing: false });
  }, 1800);
}

function scrollToBottom() {
  elements.messages.scrollTop = 0;
}

async function scrollMessagesToLatest(conversationID) {
  // Firefox conserve parfois l'ancien scrollTop négatif d'un conteneur
  // column-reverse lorsque le placeholder est remplacé. Deux frames laissent
  // le moteur recalculer la hauteur, l'ordre CSS et la transition du panneau.
  scrollToBottom();
  for (let frame = 0; frame < 2; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!sameID(state.current?.id, conversationID)) return;
    scrollToBottom();
  }
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function escapeText(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

boot().catch((error) => {
  dismissStartupSplash();
  console.error(error);
  toast(frenchErrorMessage(error, "Erreur de démarrage."), "error");
});

window.addEventListener("pageshow", restoreChatFromHistory);
window.addEventListener("pagehide", finishAdminNavigation);
