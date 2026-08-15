import { api, clearSessionToken, getInstanceURL, isDesktopClient, normalizeInstanceURL, setInstanceURL } from "./api.js?v=community-1-0-25-v380";
import {
  base64ToBytes,
  bytesToBase64,
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
} from "./crypto.js?v=community-1-0-25-v380";
import {
  forgetRememberedIdentity,
	forgetTrustedDeviceCredential,
  hasRememberedIdentity,
  loadRememberedIdentity,
  rememberIdentityBundle,
  resetLoginVerificationCounter,
	trustedDeviceCredential,
} from "./device-vault.js?v=trusted-device-v300";
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
} from "./notifications.js?v=community-1-0-25-v380";
import { ChatSocket } from "./websocket.js?v=community-1-0-25-v380";
import { actionIcon, bindSwipeActions, formatMessageTime, frenchErrorMessage, materialFileIcon, renderMessage, setBusy, toast } from "./ui.js?v=community-1-0-25-v380";
import { locale, t } from "./i18n.js?v=community-1-0-25-v380";
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
import {
  CALL_EVENT_TTL_MS,
  callCapabilityMessage,
  callFailureMessage,
  callIdentity,
  callRTCConfigurationFrom,
  canonicalCallIdentity,
  createCallSequencer,
  createCallSignalLedger,
  createPeerLink,
  newCallEventID,
  sameCallIdentity,
  shouldOfferAfterAccept,
  shouldOfferInGroup,
} from "./call-negotiation.js?v=community-1-0-25-v380";
import { openConversationCache, sameMessageSnapshots } from "./conversation-cache.js?v=cache-v3";
import { decodeQRImageData, sessionApprovalTokenFromQR } from "./qr-scanner.js?v=qr-scanner-v296";
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
const BOOT_API_TIMEOUT_MS = 8000;
const FILE_PREVIEW_PREFETCH_BUDGET_BYTES = 8 * 1024 * 1024;
const BACKGROUND_CONVERSATION_PRELOAD_LIMIT = 6;
const BACKGROUND_CONVERSATION_PRELOAD_CONCURRENCY = 2;
const BACKGROUND_THUMBNAIL_PRELOAD_CONCURRENCY = 2;
const BACKGROUND_THUMBNAIL_PRELOAD_BUDGET_BYTES = 4 * 1024 * 1024;
const BACKGROUND_PRELOAD_TTL_MS = 2 * 60 * 1000;
const BACKGROUND_PRELOAD_NETWORK_FRESH_MS = 15 * 1000;
const GLOBAL_FILES_PAGE_SIZE = 40;
const GLOBAL_FILES_SCROLL_THRESHOLD_PX = 240;
const GLOBAL_FILES_BACKGROUND_CONCURRENCY = 2;
const WHITEBOARD_MESSAGE_TYPE = "whiteboard";
const APP_BUILD = "community-1-0-25-v380";
const ADMIN_RETURN_HISTORY_KEY = "vibration.admin_return_history";
const ADMIN_BOOTSTRAP_CACHE_KEY = "vibration.admin_bootstrap";
const ADMIN_BOOTSTRAP_MAX_AGE_MS = 60 * 1000;
const ADMIN_PAGE_SIZE = 10;

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
  carnetLoaded: false,
  conversations: [],
  current: null,
  keys: new Map(),
  keyEnvelopes: new Map(),
  keyEnvelopeLoads: new Map(),
  members: new Map(),
  verifiedConversationMembers: new Set(),
  conversationDisplays: new Map(),
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
  globalFileClears: new Map(),
  globalFileClearLoads: new Map(),
  globalFileMessages: [],
  globalFilesLoaded: false,
  globalFilesHasMore: true,
  globalFilesNextBefore: null,
  globalFilesGeneration: 0,
  globalFilesFirstPageLoad: null,
  globalFilesNextPageLoad: null,
  messageExpiryTimers: new Map(),
  messageAppendTasks: new Map(),
  filePreviewObservers: new Set(),
  previewURLs: new Set(),
  fileCacheGeneration: 0,
  callConfig: null,
  // callIdentity is this browser's canonical federated identity, served by
  // /api/calls/config. It is what decides who offers, never a numeric user id.
  callIdentity: null,
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
let contactSearchVersion = 0;
const groupInvitedUsers = new Map();
let pdfJSModule;
let ios17PDFJSModule;
let conversationRenderVersion = 0;
let conversationListRenderKey = "";
let conversationSelectionVersion = 0;
let conversationInfoLoadVersion = 0;
let globalFilesLoadVersion = 0;
let globalFilesPreloadScheduled = false;
let carnetLoadVersion = 0;
let calendarOpenTask = null;
let pinnedPanelOpenTask = null;
let pinnedPanelLoadVersion = 0;
let fileShareOpenTask = null;
let fileShareOpenVersion = 0;
let appReady = false;
let appShellPrepared = false;
let appUIBound = false;
let appIdentityTrusted = false;
let appNotificationsStarted = false;
let bootAttempt = null;
let bootRetryTimer = 0;
let bootRetryDelay = 1000;
let bootFailureNotified = false;
let appHiddenAt = 0;
const pdfScriptLoads = new Map();
const backgroundThumbnailQueue = [];
let activeBackgroundThumbnailPreloads = 0;
const CALENDAR_FEED_TOKEN_KEY = "vibration.calendar_feed_token";
let callPageExitHandled = false;
let callVideoResumeTimer = null;
let sessionQRScannerStream = null;
let sessionQRScannerFrame = 0;
let sessionQRScannerBusy = false;
let sessionQRScannerLastFrame = 0;
let sessionQRScannerGeneration = 0;

const elements = {
  shell: document.querySelector("#app-shell"),
  conversationLists: document.querySelector("#conversation-lists"),
  conversationListLoading: document.querySelector("#conversation-list-loading"),
  conversationSearch: document.querySelector("#conversation-search"),
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

function appendGroupUserSearchResult(results, user, onInvite, directoryRole = "") {
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
  if (directoryRole) {
    const roleBadge = document.createElement("small");
    roleBadge.className = "contact-role-badge";
    roleBadge.textContent = t(directoryRole === "administrator" ? "Administrateur" : "Gestionnaire");
    identity.append(roleBadge);
  }
  const action = document.createElement("span");
  action.textContent = t("Inviter");
  row.append(identity, action);
  row.onclick = onInvite;
  results.append(row);
}

function normalizedPrivateDiscoveryCode(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "");
  return /^(?:[A-Z2-7]{15}|VIB[A-Z2-7]{32})$/.test(normalized) ? normalized : "";
}

function isPrivateDiscoveryCode(value) {
  return Boolean(normalizedPrivateDiscoveryCode(value));
}

async function searchInstanceUsers(query, role = "") {
  return api("/api/users/search", {
    method: "POST",
    body: role ? { query, role } : { query },
  });
}

function contactDirectoryRole(query) {
  const normalized = String(query || "").trim().toLocaleLowerCase(locale);
  const roles = [
    { role: "administrator", labels: ["administrateur", "administrateurs", t("Administrateur"), t("Administrateurs")] },
    { role: "manager", labels: ["gestionnaire", "gestionnaires", t("Gestionnaire"), t("Gestionnaires")] },
  ];
  return roles.find(({ labels }) => labels.some((label) => normalized === label.toLocaleLowerCase(locale)))?.role || "";
}

function userWithDiscoveryCode(user, query) {
  return isPrivateDiscoveryCode(query) ? { ...user, discovery_code: query } : user;
}

function groupEditDialog({ name, description, avatar, members }) {
  const dialog = document.querySelector("#group-edit-dialog");
  const form = document.querySelector("#group-edit-form");
  const nameInput = document.querySelector("#group-edit-name");
  const descriptionInput = document.querySelector("#group-edit-description");
  const avatarInput = document.querySelector("#group-edit-avatar-input");
  const avatarPreview = document.querySelector("#group-edit-avatar-preview");
  const removeButton = document.querySelector("#group-edit-avatar-remove");
  const errorRegion = document.querySelector("#group-edit-error");
  const memberList = document.querySelector("#group-edit-members");
  const memberCount = document.querySelector("#group-edit-members-count");
  const userSearch = document.querySelector("#group-edit-user-search");
  const userResults = document.querySelector("#group-edit-user-results");
  let selectedAvatar = avatar || null;
  const selectedIDs = new Set(members
    .filter((member) => !sameID(member.user_id, state.me.id))
    .map((member) => Number(member.user_id))
    .filter(Boolean));
  const existingMembers = new Map(members
    .filter((member) => !sameID(member.user_id, state.me.id))
    .map((member) => [Number(member.user_id), member]));
  const extraUsers = new Map();

  const updatePreview = () => {
    renderGroupAvatarPreview(avatarPreview, selectedAvatar);
    removeButton.hidden = !selectedAvatar;
  };
  const renderMembers = () => {
    const selectedMembers = [...selectedIDs]
      .map((userID) => extraUsers.get(userID) || existingMembers.get(userID))
      .filter(Boolean);
    renderSelectedGroupMembers(memberList, [state.me, ...selectedMembers], {
      countElement: memberCount,
      onRemove: (userID) => {
        selectedIDs.delete(userID);
        extraUsers.delete(userID);
        renderMembers();
      },
    });
  };
  const searchUsers = debounce(async () => {
    const query = userSearch.value.trim();
    const directoryRole = contactDirectoryRole(query);
    userResults.replaceChildren();
    if (query.length < 2) return;
    try {
      const users = await searchInstanceUsers(query, directoryRole);
      if (userSearch.value.trim() !== query) return;
      const currentIDs = new Set([state.me.id, ...selectedIDs]);
      for (const user of users.filter((item) => !sameID(item.id, state.me.id) && !currentIDs.has(Number(item.id)))) {
        appendGroupUserSearchResult(userResults, user, () => {
          const userID = Number(user.id);
          extraUsers.set(userID, userWithDiscoveryCode(user, query));
          selectedIDs.add(userID);
          userSearch.value = "";
          userResults.replaceChildren();
          renderMembers();
        }, directoryRole);
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

function createConversationExchangeState(conversation, empty = null) {
  const exchangeKind = conversation?.is_personal
    ? "notes"
    : conversation?.type === "group"
      ? "group"
      : conversation?.type === "private"
        ? "direct"
        : null;
  if (!exchangeKind) return empty;

  const container = document.createElement("div");
  container.className = `conversation-exchange-state ${exchangeKind}-exchange-state`;

  const intro = document.createElement("div");
  intro.className = "conversation-exchange-intro";

  const icon = document.createElement("span");
  icon.className = `conversation-exchange-icon ${exchangeKind}-exchange-icon`;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = exchangeKind === "group"
    ? `<svg viewBox="0 0 120 120" focusable="false">
        <g transform="translate(36 21) scale(.78)">
          <path vector-effect="non-scaling-stroke" d="M22 56c0-20 17-35 38-35s38 15 38 35c0 8-3 15-8 21l2 20-20-9c-4 2-8 3-12 3-21 0-38-15-38-35Z"></path>
          <circle cx="44" cy="56" r="3.5"></circle><circle cx="60" cy="56" r="3.5"></circle><circle cx="76" cy="56" r="3.5"></circle>
        </g>
        <g transform="translate(-7 13) scale(.88)">
          <path vector-effect="non-scaling-stroke" d="M22 56c0-20 17-35 38-35s38 15 38 35c0 8-3 15-8 21l2 20-20-9c-4 2-8 3-12 3-21 0-38-15-38-35Z"></path>
          <circle cx="44" cy="56" r="3.5"></circle><circle cx="60" cy="56" r="3.5"></circle><circle cx="76" cy="56" r="3.5"></circle>
        </g>
      </svg>`
    : exchangeKind === "notes"
      ? `<svg viewBox="0 0 120 120" focusable="false">
          <rect x="24" y="27" width="72" height="76" rx="8"></rect>
          <path d="M42 17v24M60 17v24M78 17v24M40 54h40M40 69h40M40 84h26"></path>
        </svg>`
      : `<svg viewBox="0 0 120 120" focusable="false">
        <path d="M22 56c0-20 17-35 38-35s38 15 38 35c0 8-3 15-8 21l2 20-20-9c-4 2-8 3-12 3-21 0-38-15-38-35Z"></path>
        <circle cx="44" cy="56" r="3.5"></circle>
        <circle cx="60" cy="56" r="3.5"></circle>
        <circle cx="76" cy="56" r="3.5"></circle>
      </svg>`;

  const exchangeLabels = {
    direct: ["Échange direct", "de personne à personne"],
    group: ["Échange de groupe", "communication entre plusieurs membres"],
    notes: ["Mes notes", "documents, enregistrements et évènements personnels"],
  }[exchangeKind];
  const copy = document.createElement("span");
  copy.className = "conversation-exchange-copy";
  const title = document.createElement("strong");
  title.textContent = t(exchangeLabels[0]);
  const subtitle = document.createElement("span");
  subtitle.textContent = t(exchangeLabels[1]);
  copy.append(title, subtitle);

  intro.append(icon, copy);
  container.append(intro);
  if (empty) container.append(empty);
  return container;
}

async function expireRenderedMessage(conversationID, messageID) {
  invalidateConversationPreload(conversationID);
  forgetGlobalFileClearByMessageID(messageID);
  invalidateGlobalFilesIndex();
  if (appReady) scheduleGlobalFilesPreload();
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
      elements.messages.querySelector(".conversation-exchange-state")?.remove();
      elements.messages.append(createConversationExchangeState(state.current, empty));
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

async function refreshFileQuotas({ timeoutMS = 0 } = {}) {
  try {
    state.fileQuotas = await api("/api/files/limits", { timeoutMS });
  } catch {
    state.fileQuotas ||= defaultFileQuotas();
  }
  updateProfileStorage();
  return state.fileQuotas;
}

async function boot() {
  sessionStorage.removeItem(ADMIN_RETURN_HISTORY_KEY);
  sessionStorage.removeItem(ADMIN_BOOTSTRAP_CACHE_KEY);
  if (!state.me) {
    const [me, edition, terms] = await Promise.all([
      api("/api/me", { timeoutMS: BOOT_API_TIMEOUT_MS }),
      api("/api/edition", { timeoutMS: BOOT_API_TIMEOUT_MS }),
      api("/api/terms/status", { timeoutMS: BOOT_API_TIMEOUT_MS }),
    ]);
    if (!terms.accepted) {
      location.replace("/login.html?terms=required");
      return;
    }
    state.me = me;
    state.edition = edition;
    await ensureTrustedDeviceEnrollment({ timeoutMS: BOOT_API_TIMEOUT_MS }).catch((error) => {
      if (error?.status !== 409) console.warn("Enregistrement de l’appareil de confiance impossible", error);
    });
    state.cache = await openConversationCache(getInstanceURL(), state.me);
    await refreshFileQuotas({ timeoutMS: BOOT_API_TIMEOUT_MS });
  }
  if (!appShellPrepared) {
    elements.shell.hidden = false;
    elements.conversationListLoading.textContent = t("Chargement des discussions…");
    updateIdentityLabel();
    const adminLink = document.querySelector("#admin-link");
    const canOpenAdmin = state.edition.admin_panel && (state.me.is_admin || state.me.is_manager);
    adminLink.hidden = !canOpenAdmin;
    adminLink.querySelector(".admin-link-label").textContent = t(state.me.is_manager && !state.me.is_admin ? "Gestion" : "Administration");
    adminLink.addEventListener("click", prepareAdminNavigation);
    if (canOpenAdmin) bindAdminPanelPreload(adminLink);
    appShellPrepared = true;
  }
  if (!state.privateKey || !state.signingPrivateKey) await unlock();
  if (!appUIBound) {
    bindUI();
    appUIBound = true;
  }
  if (!appIdentityTrusted) {
    await trustedPublicKey(state.me, { interactive: true });
    appIdentityTrusted = true;
  }
  if (!state.socket || state.socket.closed) connectSocket();
  await refreshAll({ requestTimeoutMS: BOOT_API_TIMEOUT_MS });
  appReady = true;
  scheduleAdminPanelPreload();
  scheduleGlobalFilesPreload();
  if (!appNotificationsStarted) {
    appNotificationsStarted = true;
    initializeNotificationsAfterBoot();
  }
}

function startupAuthenticationFailed(error) {
  return error?.status === 401 || error?.status === 403;
}

function scheduleBootRetry() {
  if (appReady || bootRetryTimer) return;
  const delay = bootRetryDelay;
  bootRetryDelay = Math.min(bootRetryDelay * 2, 15000);
  bootRetryTimer = window.setTimeout(() => {
    bootRetryTimer = 0;
    startBoot();
  }, delay);
}

function startBoot() {
  if (appReady) return Promise.resolve();
  if (bootAttempt) return bootAttempt;
  bootAttempt = boot().then(() => {
    if (!appReady) return;
    window.clearTimeout(bootRetryTimer);
    bootRetryTimer = 0;
    bootRetryDelay = 1000;
    bootFailureNotified = false;
  }).catch((error) => {
    dismissStartupSplash();
    if (startupAuthenticationFailed(error)) {
      location.replace("/login.html");
      return;
    }
    console.warn("Démarrage temporairement interrompu, nouvelle tentative programmée", error);
    document.querySelector("#ws-dot").classList.remove("online");
    document.querySelector("#ws-label").textContent = t("Reconnexion…");
    if (!bootFailureNotified) {
      bootFailureNotified = true;
      toast(t("Connexion temporairement indisponible. Nouvelle tentative automatique…"), "error");
    }
    scheduleBootRetry();
  }).finally(() => {
    bootAttempt = null;
  });
  return bootAttempt;
}

function retryIncompleteBoot() {
  if (appReady || bootAttempt || document.hidden) return;
  window.clearTimeout(bootRetryTimer);
  bootRetryTimer = 0;
  startBoot();
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
    document.querySelector("#profile-invisible").checked = state.me.is_discoverable === false;
    document.querySelector("#profile-discovery-code").value = "";
    document.querySelector("#profile-discovery-code-row").hidden = true;
    updateProfileDiscoveryControls();
    document.querySelector("#profile-calendar-password").value = "";
    document.querySelector("#profile-calendar-url").value = "";
    document.querySelector("#profile-calendar-status").textContent = t("Vérification du flux calendrier…");
    document.querySelector("#profile-theme").value = window.ChatTheme?.getPreference() || "auto";
    document.querySelector("#profile-current-password").value = "";
    document.querySelector("#profile-new-password").value = "";
    document.querySelector("#profile-confirm-password").value = "";
    document.querySelector("#profile-error").textContent = "";
    document.querySelector("#profile-session-code").value = "";
    document.querySelector("#profile-session-status").textContent = t("Chargement des sessions…");
    document.querySelector("#profile-trusted-device-status").textContent = t("Chargement des appareils de confiance…");
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
      loadDeviceSecurity(),
    ]);
  };
  document.querySelector("#profile-button").onclick = openProfileDialog;
  document.querySelector("#close-sidebar-logo").onclick = openProfileDialog;
  document.querySelector("#profile-close").onclick = () => profileDialog.close();
  profileDialog.addEventListener("close", () => {
    closeSessionQRScanner();
    document.querySelector("#profile-discovery-code").value = "";
    document.querySelector("#profile-discovery-code-row").hidden = true;
  });
  document.querySelector("#profile-calendar-copy").onclick = copyCalendarFeedURL;
  document.querySelector("#profile-calendar-create").onclick = createSharedCalendarFeed;
  document.querySelector("#profile-calendar-revoke").onclick = revokeSharedCalendarFeed;
  document.querySelector("#profile-calendar-export").onclick = exportCalendarICalendar;
  document.querySelector("#profile-invisible").onchange = () => updateProfileDiscoveryControls();
  document.querySelector("#profile-discovery-generate").onclick = generateProfileDiscoveryCode;
  document.querySelector("#profile-discovery-copy").onclick = copyProfileDiscoveryCode;
  document.querySelector("#profile-session-approve-code").onclick = approveDeviceSessionCode;
  const sessionQRScannerDialog = document.querySelector("#session-qr-scanner-dialog");
  const sessionQRScannerButton = document.querySelector("#profile-session-scan-qr");
  const sessionQRScannerClose = document.querySelector("#session-qr-scanner-close");
  const sessionQRScannerCancel = document.querySelector("#session-qr-scanner-cancel");
  const sessionQRScannerFile = document.querySelector("#session-qr-scanner-file");
  if (sessionQRScannerDialog && sessionQRScannerButton && sessionQRScannerClose && sessionQRScannerCancel && sessionQRScannerFile) {
    sessionQRScannerButton.onclick = openSessionQRScanner;
    sessionQRScannerClose.onclick = closeSessionQRScanner;
    sessionQRScannerCancel.onclick = closeSessionQRScanner;
    sessionQRScannerDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeSessionQRScanner();
    });
    sessionQRScannerDialog.addEventListener("close", stopSessionQRScanner);
    sessionQRScannerFile.addEventListener("change", scanSessionQRCodeFile);
  }
  const profileSessionCode = document.querySelector("#profile-session-code");
  profileSessionCode.addEventListener("input", formatDeviceSessionCode);
  profileSessionCode.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    document.querySelector("#profile-session-approve-code").click();
  });
  document.querySelector("#conversation-info-close").onclick = (event) => {
    const closedWithPointer = event.detail > 0;
    elements.conversationInfoDialog.close();
    if (!closedWithPointer) return;
    requestAnimationFrame(() => {
      if (document.activeElement === elements.chatAvatar || document.activeElement === elements.chatIdentity) {
        document.activeElement.blur();
      }
    });
  };
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
  document.querySelector("#contact-button").onclick = () => {
    contactSearchVersion += 1;
    document.querySelector("#contact-search").value = "";
    document.querySelector("#contact-results").replaceChildren();
    document.querySelector("#contact-dialog").showModal();
  };
  document.querySelector("#group-button").onclick = () => {
    openGroupDialog().catch((error) => toast(frenchErrorMessage(error, "Impossible d’ouvrir la création de groupe."), "error"));
  };
  elements.personalConversationButton.onclick = () => {
    const conversation = state.conversations.find((item) => item.is_personal);
    if (conversation) {
      keepConversationSelectedDuringTransition(elements.personalConversationButton);
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
  elements.pinnedWindowButton.addEventListener("click", () => {
    void setPinnedPanelOpen(elements.pinnedPanel.hidden);
  });
  elements.closePinnedPanel.addEventListener("click", () => {
    void setPinnedPanelOpen(false);
  });
  elements.calendarButton.addEventListener("click", () => {
    void openCalendar();
  });
  elements.carnetButton.addEventListener("click", () => openCarnet());
  elements.globalFilesButton.addEventListener("click", () => openGlobalFiles());
  document.querySelector("#event-form").addEventListener("submit", submitEvent);
  document.querySelector("#event-close").addEventListener("click", closeEventDialog);
  document.querySelector("#event-cancel").addEventListener("click", closeEventDialog);
  document.querySelector("#calendar-close").addEventListener("click", () => elements.calendarDialog.close());
  document.querySelector("#carnet-close").addEventListener("click", () => elements.carnetDialog.close());
  elements.carnetDialog.addEventListener("close", () => {
    carnetLoadVersion += 1;
    elements.carnetList.removeAttribute("aria-busy");
  });
  elements.carnetDeleteAll.addEventListener("click", deleteAllCarnetEntries);
  document.querySelector("#global-files-close").addEventListener("click", () => elements.globalFilesDialog.close());
  elements.globalFilesList.addEventListener("scroll", handleGlobalFilesScroll, { passive: true });
  elements.globalFilesDialog.addEventListener("close", () => {
    globalFilesLoadVersion += 1;
    elements.globalFilesList.removeAttribute("aria-busy");
  });
  elements.fileShareForm.addEventListener("submit", createFileShare);
  document.querySelector("#file-share-close").addEventListener("click", closeFileShareDialog);
  document.querySelector("#file-share-cancel").addEventListener("click", closeFileShareDialog);
  elements.fileShareDialog.addEventListener("close", () => {
    fileShareOpenVersion += 1;
    state.pendingFileShare = null;
    state.activeFileShareID = null;
  });
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
  window.addEventListener("focus", handleAppFocus);
  document.addEventListener("visibilitychange", handleAppVisibilityChange);
  document.addEventListener("fullscreenchange", handleCallFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleCallFullscreenChange);
  elements.voiceDraftClear.addEventListener("click", clearVoiceDraft);
  elements.replyClear.addEventListener("click", clearReplyTarget);
  bindExpirationDialog();
  elements.input.addEventListener("input", sendTyping);
  elements.conversationSearch.addEventListener("input", applyConversationSearch);
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
  button.classList.toggle("group-conversation-avatar", Boolean(display && conversation?.type === "group"));
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
  state.globalFileClears.clear();
  state.globalFileClearLoads.clear();
  invalidateGlobalFilesIndex();
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
  state.globalFileClears.clear();
  state.globalFileClearLoads.clear();
  invalidateGlobalFilesIndex();
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
  const loadVersion = ++conversationInfoLoadVersion;
  const members = await getMembers(conversation.id, { fresh: true, interactive: true });
  const display = await resolveConversationDisplay(conversation);
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
  const identity = peer ? identityTrustInput(peer) : null;
  const trust = identity ? await getIdentityTrust(identity) : null;

  if (loadVersion !== conversationInfoLoadVersion || !sameID(state.current?.id, conversation.id)) return;
  state.conversationInfoIdentity = identity;
  elements.conversationInfoTitle.textContent = t(isGroup ? "Informations du groupe" : "Informations du contact");
  elements.conversationInfoKind.textContent = t(isGroup ? "Groupe" : "Contact");
  elements.conversationInfoName.textContent = displayName;
  elements.conversationInfoNameLabel.textContent = t(isGroup ? "Nom du groupe" : "Nom affiché");
  elements.conversationInfoDisplayName.textContent = displayName;
  elements.conversationInfoUsernameRow.hidden = isGroup;
  elements.conversationInfoAddressRow.hidden = isGroup;
  elements.conversationInfoUsername.textContent = username
    ? (username.startsWith("@") ? username : `@${username}`)
    : t("Non renseigné");
  elements.conversationInfoAddress.textContent = conversationContactAddress(username, instance);
  elements.conversationInfoInstance.textContent = conversationInstanceLabel(instance);
  elements.conversationInfoInstance.title = instance || "";
  elements.conversationInfoDescription.textContent = description || t("Aucune description.");
  elements.conversationInfoFingerprintRow.hidden = isGroup;
  elements.conversationInfoFingerprint.textContent = identity
    ? formatPublicKeyFingerprint(trust?.record?.fingerprint)
    : "—";
  elements.conversationInfoTrustStatus.textContent = identity ? identityVerificationStatus(trust?.record) : "";
  elements.conversationInfoVerify.hidden = !identity || Boolean(trust?.record?.verifiedAt);
  elements.conversationInfoMembersSection.hidden = !isGroup;
  elements.conversationInfoMembersCount.textContent = "0";
  elements.conversationInfoMembers.replaceChildren();
  elements.conversationInfoAvatar.classList.toggle("group-conversation-avatar", isGroup);
  replaceAvatarContent(
    elements.conversationInfoAvatar,
    display.avatar,
    conversationAvatarFallback(display, conversation),
  );
  if (isGroup) renderConversationInfoMembers(members);
  if (!elements.conversationInfoDialog.open) elements.conversationInfoDialog.showModal();
  elements.conversationInfoTitle.setAttribute("tabindex", "-1");
  elements.conversationInfoTitle.focus({ preventScroll: true });
}

function renderConversationHeader(conversation, display) {
  elements.title.textContent = display.title;
  elements.description.textContent = display.description || t(
    conversation.is_personal ? "Messages et fichiers personnels" : conversation.type === "group" ? "Groupe" : "Contact",
  );
  elements.chatAvatar.hidden = false;
  elements.chatAvatar.classList.toggle("personal-note-avatar", Boolean(conversation.is_personal));
  elements.chatAvatar.classList.toggle("group-conversation-avatar", conversation.type === "group");
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
  state.conversationDisplays.set(String(expectedID), display);
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

function updateProfileDiscoveryControls({ keepStatus = false } = {}) {
  const invisible = document.querySelector("#profile-invisible").checked;
  const generate = document.querySelector("#profile-discovery-generate");
  const codeRow = document.querySelector("#profile-discovery-code-row");
  const status = document.querySelector("#profile-discovery-status");
  const savedInvisible = state.me?.is_discoverable === false;
  generate.disabled = !invisible || !savedInvisible;
  if (!invisible) codeRow.hidden = true;
  if (keepStatus) return;
  if (!invisible) {
    status.textContent = t("Votre profil reste visible dans l’annuaire de l’instance.");
  } else if (!savedInvisible) {
    status.textContent = t("Enregistrez le profil avant de générer votre code privé.");
  } else if (state.me?.has_discovery_code) {
    status.textContent = t("Un code privé est actif. Générez-en un nouveau pour invalider l’ancien.");
  } else {
    status.textContent = t("Aucun code privé actif.");
  }
}

async function generateProfileDiscoveryCode(event) {
  const button = event.currentTarget;
  const status = document.querySelector("#profile-discovery-status");
  setBusy(button, true, t("Génération…"));
  try {
    const result = await api("/api/me/discovery-code", {
      method: "POST",
    });
    state.me.has_discovery_code = true;
    const input = document.querySelector("#profile-discovery-code");
    input.value = result.discovery_code;
    document.querySelector("#profile-discovery-code-row").hidden = false;
    status.textContent = t("Copiez ce code maintenant : il ne sera plus affiché après la fermeture du profil.");
    input.focus();
    input.select();
  } catch (error) {
    status.textContent = frenchErrorMessage(error);
  } finally {
    setBusy(button, false);
    updateProfileDiscoveryControls({ keepStatus: true });
  }
}

async function copyProfileDiscoveryCode() {
  const input = document.querySelector("#profile-discovery-code");
  if (!input.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.focus();
    input.select();
    if (!document.execCommand("copy")) {
      toast(t("Sélectionnez puis copiez le code manuellement."), "error");
      return;
    }
  }
  toast(t("Code privé copié."), "success");
}

function deviceSessionTypeLabel(kind) {
  return t(({
    desktop: "Application de bureau",
    mobile: "Téléphone",
    tablet: "Tablette",
    browser: "Navigateur web",
  })[kind] || "Appareil");
}

function currentTrustedDeviceMetadata() {
  const userAgent = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || t("Appareil");
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /Firefox\//.test(userAgent) ? "Firefox"
      : /CriOS\//.test(userAgent) ? "Chrome"
        : /Chrome\//.test(userAgent) ? "Chrome"
          : /Safari\//.test(userAgent) ? "Safari"
            : "Vibration";
  const mobile = /Android|iPhone|iPod|Mobile/i.test(userAgent);
  const tablet = /iPad|Tablet/i.test(userAgent);
  return {
    device_name: `${browser} · ${platform}`.slice(0, 120),
    device_type: isDesktopClient() ? "desktop" : tablet ? "tablet" : mobile ? "mobile" : "browser",
  };
}

async function ensureTrustedDeviceEnrollment({ timeoutMS = 0 } = {}) {
  const credential = await trustedDeviceCredential(getInstanceURL());
  return api("/api/me/trusted-devices/enroll", {
    method: "POST",
    body: { ...credential, ...currentTrustedDeviceMetadata() },
    timeoutMS,
  });
}

function formatDeviceSessionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("date inconnue");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDeviceSessionCode(event) {
  const input = event.currentTarget;
  const normalized = input.value.toUpperCase().replace(/[^A-Z2-7]/g, "").slice(0, 8);
  input.value = normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

function stopSessionQRScanner() {
  if (sessionQRScannerFrame) cancelAnimationFrame(sessionQRScannerFrame);
  sessionQRScannerFrame = 0;
  sessionQRScannerBusy = false;
  sessionQRScannerLastFrame = 0;
  for (const track of sessionQRScannerStream?.getTracks?.() || []) track.stop();
  sessionQRScannerStream = null;
  const video = document.querySelector("#session-qr-scanner-video");
  video?.pause();
  if (video) video.srcObject = null;
}

function closeSessionQRScanner() {
  sessionQRScannerGeneration += 1;
  const dialog = document.querySelector("#session-qr-scanner-dialog");
  if (dialog?.open) dialog.close();
  else stopSessionQRScanner();
}

function sessionQRImageData(source, sourceWidth, sourceHeight, maximumDimension) {
  const canvas = document.querySelector("#session-qr-scanner-canvas");
  const scale = Math.min(1, maximumDimension / Math.max(sourceWidth, sourceHeight));
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function sessionQRImageDataFromFile(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      try {
        return sessionQRImageData(bitmap, bitmap.width, bitmap.height, 1600);
      } finally {
        bitmap.close();
      }
    } catch {
      // Safari versions without this option are handled by the Image fallback.
    }
  }
  const dataURL = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("image read failed"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const candidate = new Image();
    candidate.onload = () => resolve(candidate);
    candidate.onerror = () => reject(new Error("image decode failed"));
    candidate.src = dataURL;
  });
  return sessionQRImageData(image, image.naturalWidth, image.naturalHeight, 1600);
}

async function authorizeScannedDeviceSession(value) {
  const dialog = document.querySelector("#session-qr-scanner-dialog");
  const status = document.querySelector("#session-qr-scanner-status");
  const token = sessionApprovalTokenFromQR(value, getInstanceURL());
  if (!token) {
    status.textContent = t("Ce QR code n’est pas une demande Vibration valide pour cette instance.");
    return false;
  }
  status.textContent = t("Vérification de la demande en cours…");
  try {
    const pending = await api("/api/me/sessions/preview", { method: "POST", body: { token } });
    if (!dialog.open) return false;
    if (!confirm(t("Autoriser « {device} » à accéder à votre compte Vibration ?", {
      device: pending.device_name || t("Appareil non identifié"),
    }))) {
      status.textContent = t("Présentez le QR code à la caméra.");
      return false;
    }
    status.textContent = t("Autorisation…");
    await api("/api/me/sessions/approve", { method: "POST", body: { token } });
    closeSessionQRScanner();
    toast(t("Nouvel appareil autorisé."), "success");
    await loadDeviceSecurity().catch((error) => {
      toast(frenchErrorMessage(error, t("Impossible de charger les sessions.")), "error");
    });
    return true;
  } catch (error) {
    status.textContent = frenchErrorMessage(error, t("Le QR code a peut-être expiré ou déjà été utilisé."));
    return false;
  }
}

async function scanSessionQRCodeFrame(timestamp) {
  sessionQRScannerFrame = 0;
  const dialog = document.querySelector("#session-qr-scanner-dialog");
  const video = document.querySelector("#session-qr-scanner-video");
  if (!dialog.open || !sessionQRScannerStream) return;
  sessionQRScannerFrame = requestAnimationFrame(scanSessionQRCodeFrame);
  if (sessionQRScannerBusy || timestamp - sessionQRScannerLastFrame < 120 || video.readyState < 2) return;
  sessionQRScannerLastFrame = timestamp;
  let value = "";
  try {
    value = decodeQRImageData(sessionQRImageData(video, video.videoWidth, video.videoHeight, 720));
  } catch {
    return;
  }
  if (!value) return;
  sessionQRScannerBusy = true;
  await authorizeScannedDeviceSession(value);
  if (dialog.open) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    sessionQRScannerBusy = false;
  }
}

async function openSessionQRScanner() {
  const dialog = document.querySelector("#session-qr-scanner-dialog");
  const status = document.querySelector("#session-qr-scanner-status");
  const video = document.querySelector("#session-qr-scanner-video");
  if (dialog.open) return;
  const generation = ++sessionQRScannerGeneration;
  document.querySelector("#session-qr-scanner-file").value = "";
  status.textContent = t("Ouverture de la caméra…");
  dialog.showModal();
  if (typeof globalThis.jsQR !== "function") {
    status.textContent = t("Le lecteur de QR code est indisponible.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = t("La caméra n’est pas disponible. Choisissez une image du QR code.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    if (generation !== sessionQRScannerGeneration || !dialog.open) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    sessionQRScannerStream = stream;
    video.srcObject = stream;
    await video.play();
    status.textContent = t("Présentez le QR code à la caméra.");
    sessionQRScannerFrame = requestAnimationFrame(scanSessionQRCodeFrame);
  } catch (error) {
    if (generation !== sessionQRScannerGeneration || !dialog.open) return;
    stopSessionQRScanner();
    status.textContent = t(["NotAllowedError", "SecurityError"].includes(error?.name)
      ? "L’accès à la caméra a été refusé. Autorisez-la ou choisissez une image du QR code."
      : "La caméra n’est pas disponible. Choisissez une image du QR code.");
  }
}

async function scanSessionQRCodeFile(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file || sessionQRScannerBusy) return;
  const dialog = document.querySelector("#session-qr-scanner-dialog");
  const status = document.querySelector("#session-qr-scanner-status");
  sessionQRScannerBusy = true;
  status.textContent = t("Recherche du QR code dans l’image…");
  try {
    const value = decodeQRImageData(await sessionQRImageDataFromFile(file));
    if (!value) {
      status.textContent = t("Impossible de lire un QR code dans cette image.");
      return;
    }
    await authorizeScannedDeviceSession(value);
  } catch {
    status.textContent = t("Impossible de lire un QR code dans cette image.");
  } finally {
    if (dialog.open) sessionQRScannerBusy = false;
  }
}

function createDeviceSessionBadge(label, pending = false) {
  const badge = document.createElement("span");
  badge.className = `profile-session-badge${pending ? " pending" : ""}`;
  badge.textContent = label;
  return badge;
}

function createDeviceSessionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderDeviceSessions(sessions) {
  const list = document.querySelector("#profile-session-list");
  list.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = t("Aucune session active.");
    list.append(empty);
    return;
  }
  for (const session of sessions) {
    const item = document.createElement("li");
    item.className = `profile-session-item${session.pending ? " pending" : ""}`;
    const main = document.createElement("div");
    main.className = "profile-session-main";
    const title = document.createElement("strong");
    title.textContent = session.device_name || t("Appareil non identifié");
    const badges = document.createElement("div");
    badges.className = "profile-session-badges";
    badges.append(createDeviceSessionBadge(deviceSessionTypeLabel(session.device_type)));
    if (session.current) badges.append(createDeviceSessionBadge(t("Cet appareil")));
    if (session.pending) badges.append(createDeviceSessionBadge(t("En attente d’approbation"), true));
    const activity = document.createElement("small");
    activity.className = "profile-session-meta";
    activity.textContent = session.pending
      ? t("Demande créée le {date}", { date: formatDeviceSessionDate(session.created_at) })
      : t("Dernière activité : {date}", { date: formatDeviceSessionDate(session.last_seen_at) });
    const address = document.createElement("small");
    address.className = "profile-session-meta";
    address.textContent = session.ip_address
      ? t("Adresse IP : {address}", { address: session.ip_address })
      : t("Adresse IP non disponible");
    const deadline = document.createElement("small");
    deadline.className = "profile-session-meta";
    deadline.textContent = session.pending
      ? t("Validation possible jusqu’au {date}", { date: formatDeviceSessionDate(session.approval_expires_at) })
      : t("Session valable jusqu’au {date}", { date: formatDeviceSessionDate(session.expires_at) });
    main.append(title, badges, activity, address, deadline);

    const actions = document.createElement("div");
    actions.className = "profile-session-actions";
    if (session.pending) {
      actions.append(
        createDeviceSessionButton(t("Approuver"), "", (event) => approveDeviceSession(session, event.currentTarget)),
        createDeviceSessionButton(t("Refuser"), "outline danger-text", (event) => revokeDeviceSession(session, event.currentTarget)),
      );
    } else {
      actions.append(createDeviceSessionButton(
        session.current ? t("Déconnecter cet appareil") : t("Déconnecter"),
        "outline danger-text",
        (event) => revokeDeviceSession(session, event.currentTarget),
      ));
    }
    item.append(main, actions);
    list.append(item);
  }
}

function renderTrustedDevices(devices) {
  const list = document.querySelector("#profile-trusted-device-list");
  list.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = t("Aucun appareil de confiance.");
    list.append(empty);
    return;
  }
  for (const device of devices) {
    const item = document.createElement("li");
    item.className = "profile-session-item";
    const main = document.createElement("div");
    main.className = "profile-session-main";
    const title = document.createElement("strong");
    title.textContent = device.device_name || t("Appareil non identifié");
    const badges = document.createElement("div");
    badges.className = "profile-session-badges";
    badges.append(createDeviceSessionBadge(deviceSessionTypeLabel(device.device_type)));
    badges.append(createDeviceSessionBadge(t("De confiance")));
    if (device.current) badges.append(createDeviceSessionBadge(t("Cet appareil")));
    const activity = document.createElement("small");
    activity.className = "profile-session-meta";
    activity.textContent = t("Dernière validation : {date}", { date: formatDeviceSessionDate(device.last_used_at) });
    const created = document.createElement("small");
    created.className = "profile-session-meta";
    created.textContent = t("Ajouté le {date}", { date: formatDeviceSessionDate(device.created_at) });
    main.append(title, badges, activity, created);
    const actions = document.createElement("div");
    actions.className = "profile-session-actions";
    actions.append(createDeviceSessionButton(
      t("Retirer la confiance"),
      "outline danger-text",
      (event) => revokeTrustedDevice(device, event.currentTarget),
    ));
    item.append(main, actions);
    list.append(item);
  }
}

async function loadTrustedDevices() {
  const status = document.querySelector("#profile-trusted-device-status");
  try {
    const devices = await api("/api/me/trusted-devices");
    renderTrustedDevices(devices);
    status.textContent = t(devices.length === 1
      ? "1 appareil de confiance."
      : "{count} appareils de confiance.", { count: devices.length });
    return devices;
  } catch (error) {
    status.textContent = frenchErrorMessage(error, t("Impossible de charger les appareils de confiance."));
    throw error;
  }
}

async function loadDeviceSecurity() {
  return Promise.all([loadTrustedDevices(), loadDeviceSessions()]);
}

async function revokeTrustedDevice(device, button) {
  if (!confirm(t("Retirer la confiance accordée à « {device} » ? Toutes ses sessions seront déconnectées.", {
    device: device.device_name || t("cet appareil"),
  }))) return;
  setBusy(button, true, t("Révocation…"));
  try {
    const result = await api(`/api/me/trusted-devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
    if (device.current || result.current) {
      await forgetTrustedDeviceCredential(getInstanceURL()).catch(() => {});
      clearSessionToken();
      sessionStorage.removeItem("crypto_phrase");
      location.href = "/login.html";
      return;
    }
    toast(t("La confiance accordée à l’appareil a été retirée."), "success");
    await loadDeviceSecurity();
  } catch (error) {
    toast(frenchErrorMessage(error, t("Impossible de retirer cet appareil de confiance.")), "error");
  } finally {
    setBusy(button, false);
  }
}

async function loadDeviceSessions() {
  const status = document.querySelector("#profile-session-status");
  try {
    const sessions = await api("/api/me/sessions");
    renderDeviceSessions(sessions);
    const pending = sessions.filter((session) => session.pending).length;
    status.textContent = pending
      ? t(pending === 1
        ? "1 demande de nouvel appareil attend votre décision."
        : "{count} demandes de nouvel appareil attendent votre décision.", { count: pending })
      : t(sessions.length === 1 ? "1 session active." : "{count} sessions actives.", { count: sessions.length });
    return sessions;
  } catch (error) {
    status.textContent = frenchErrorMessage(error, t("Impossible de charger les sessions."));
    throw error;
  }
}

async function approveDeviceSession(session, button) {
  setBusy(button, true, t("Autorisation…"));
  try {
    await api("/api/me/sessions/approve", {
      method: "POST",
      body: { session_id: session.id },
    });
    toast(t("Nouvel appareil autorisé."), "success");
    await loadDeviceSecurity();
  } catch (error) {
    toast(frenchErrorMessage(error, t("Impossible d’autoriser cet appareil.")), "error");
  } finally {
    setBusy(button, false);
  }
}

async function approveDeviceSessionCode(event) {
  const button = event.currentTarget;
  const input = document.querySelector("#profile-session-code");
  const status = document.querySelector("#profile-session-status");
  const code = input.value.trim();
  if (code.replace("-", "").length !== 8) {
    status.textContent = t("Saisissez les huit caractères du code de validation.");
    input.focus();
    return;
  }
  setBusy(button, true, t("Vérification…"));
  try {
    const pending = await api("/api/me/sessions/preview", { method: "POST", body: { code } });
    if (!confirm(t("Autoriser « {device} » à accéder à votre compte Vibration ?", { device: pending.device_name || t("Appareil non identifié") }))) return;
    await api("/api/me/sessions/approve", { method: "POST", body: { code } });
    input.value = "";
    toast(t("Nouvel appareil autorisé."), "success");
    await loadDeviceSecurity();
  } catch (error) {
    status.textContent = frenchErrorMessage(error, t("Code invalide, expiré ou déjà utilisé."));
  } finally {
    setBusy(button, false);
  }
}

async function revokeDeviceSession(session, button) {
  if (!session.pending && !confirm(t("Déconnecter « {device} » de votre compte Vibration ?", { device: session.device_name || t("cet appareil") }))) return;
  setBusy(button, true, session.pending ? t("Refus…") : t("Déconnexion…"));
  try {
    const result = await api(`/api/me/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    if (result.current) {
      clearSessionToken();
      sessionStorage.removeItem("crypto_phrase");
      location.href = "/login.html";
      return;
    }
    toast(t(session.pending ? "Demande de connexion refusée." : "Session déconnectée."), "success");
    await loadDeviceSessions();
  } catch (error) {
    toast(frenchErrorMessage(error, t("Impossible de déconnecter cette session.")), "error");
  } finally {
    setBusy(button, false);
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
  const isDiscoverable = !document.querySelector("#profile-invisible").checked;
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
    || isDiscoverable !== (state.me.is_discoverable !== false)
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
        is_discoverable: isDiscoverable,
      },
    });
    state.me = { ...state.me, ...updated };
    updateIdentityLabel();
    syncCurrentUserProfileDisplay();
    document.querySelector("#profile-current-password").value = "";
    document.querySelector("#profile-new-password").value = "";
    document.querySelector("#profile-confirm-password").value = "";
    updateProfileDiscoveryControls();
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
      if (!appReady) {
        retryIncompleteBoot();
      } else {
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
let adminPanelPreload = null;
let adminPanelPreloadScheduled = false;
let adminShellPreloaded = false;

function bindAdminPanelPreload(link) {
  warmAdminShell();
  link.addEventListener("pointerenter", preloadAdminPanel, { passive: true });
  link.addEventListener("focus", preloadAdminPanel);
  link.addEventListener("touchstart", preloadAdminPanel, { passive: true });
}

function warmAdminShell() {
  if (adminShellPreloaded) return;
  adminShellPreloaded = true;
  for (const [rel, href] of [
    ["prefetch", "/admin.html?from=chat"],
    ["modulepreload", "/js/admin.js?v=community-1-0-25-v380"],
  ]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = href;
    document.head.append(link);
  }
}

function cachedAdminBootstrapIsFresh() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(ADMIN_BOOTSTRAP_CACHE_KEY) || "null");
    return cached?.value?.me?.id === state.me?.id && Number.isFinite(cached.cached_at) &&
      Date.now() - cached.cached_at <= ADMIN_BOOTSTRAP_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function preloadAdminPanel() {
  if (!state.edition?.admin_panel || (!state.me?.is_admin && !state.me?.is_manager)) return Promise.resolve();
  warmAdminShell();
  if (cachedAdminBootstrapIsFresh()) return Promise.resolve();
  if (adminPanelPreload) return adminPanelPreload;
  adminPanelPreload = api(`/api/admin/bootstrap?page=1&limit=${ADMIN_PAGE_SIZE}`)
    .then((value) => {
      if (!value?.access || value.me?.id !== state.me?.id) return;
      try {
        sessionStorage.setItem(ADMIN_BOOTSTRAP_CACHE_KEY, JSON.stringify({ cached_at: Date.now(), value }));
      } catch (error) {
        console.warn("Préchargement de l’administration non mémorisé", error);
      }
    })
    .catch((error) => console.warn("Préchargement de l’administration impossible", error))
    .finally(() => { adminPanelPreload = null; });
  return adminPanelPreload;
}

function scheduleAdminPanelPreload() {
  if (adminPanelPreloadScheduled || cachedAdminBootstrapIsFresh() ||
      !state.edition?.admin_panel || (!state.me?.is_admin && !state.me?.is_manager)) return;
  adminPanelPreloadScheduled = true;
  const run = () => {
    adminPanelPreloadScheduled = false;
    preloadAdminPanel();
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 1500 });
  } else {
    window.setTimeout(run, 250);
  }
}

function prepareAdminNavigation(event) {
  const nonPrimaryClick = typeof event.button === "number" && event.button !== 0;
  if (event.defaultPrevented || nonPrimaryClick || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  preloadAdminPanel();
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
  sessionStorage.removeItem(ADMIN_BOOTSTRAP_CACHE_KEY);
  adminPanelPreload = null;
  scheduleAdminPanelPreload();
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
      for (const { message, clear } of decrypted) {
        if (message.file) rememberGlobalFileClear(message, clear);
      }
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

function revealConversationLists() {
  elements.conversationLists.hidden = false;
  elements.conversationLists.removeAttribute("aria-busy");
  elements.conversationListLoading.hidden = true;
}

function refreshCarnetInBackground() {
  const loadVersion = ++carnetLoadVersion;
  return api("/api/carnet")
    .then((entries) => {
      if (loadVersion !== carnetLoadVersion) return;
      state.carnet = entries;
      state.carnetLoaded = true;
    })
    .catch((error) => {
      console.warn("Actualisation du carnet en arrière-plan impossible", error);
    });
}

async function refreshAll({ requestTimeoutMS = 0 } = {}) {
  const request = (path, options = {}) => api(path, requestTimeoutMS > 0
    ? { ...options, timeoutMS: requestTimeoutMS }
    : options);
  const cachedConversations = !state.conversations.length
    ? await state.cache?.getConversations()
    : null;
  if (cachedConversations?.length) {
    state.conversations = cachedConversations;
    state.members.clear();
    state.verifiedConversationMembers.clear();
    await renderConversations();
    revealConversationLists();
  }
  void refreshCarnetInBackground();
  try {
    let [contacts, conversations] = await Promise.all([
      request("/api/contacts"),
      request("/api/conversations"),
    ]);
    if (!conversations.some((conversation) => conversation.is_personal)) {
      await request("/api/conversations/personal", { method: "POST" });
      conversations = await request("/api/conversations");
    }
    state.contacts = contacts;
    state.conversations = conversations;
    state.members.clear();
    state.verifiedConversationMembers.clear();
    state.cache?.saveConversations(conversations);
    await renderConversations({ freshMembers: true });
    revealConversationLists();
    const preload = scheduleBackgroundConversationPreloads(conversations);
    if (document.documentElement.classList.contains("ios-pwa-starting")) await preload;
    dismissStartupSplash();
    syncSharedCalendarFeed().catch(() => {});
  } catch (error) {
    if (!cachedConversations?.length) throw error;
    state.conversations = cachedConversations;
    state.members.clear();
    state.verifiedConversationMembers.clear();
    await renderConversations();
    revealConversationLists();
    const preload = scheduleBackgroundConversationPreloads(cachedConversations);
    if (document.documentElement.classList.contains("ios-pwa-starting")) await preload;
    dismissStartupSplash();
  }
}

async function refreshConversationList() {
  const [conversations, carnetEntries] = await Promise.all([api("/api/conversations"), api("/api/carnet")]);
  state.conversations = conversations;
  state.carnet = carnetEntries;
  state.carnetLoaded = true;
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

function handleAppFocus() {
  if (!appReady) {
    retryIncompleteBoot();
    return;
  }
  refreshConversationListOnForeground();
}

function handleAppVisibilityChange() {
  if (document.hidden) {
    appHiddenAt = Date.now();
    closeSessionQRScanner();
    return;
  }
  const suspended = appHiddenAt > 0 && Date.now() - appHiddenAt >= 3000;
  appHiddenAt = 0;
  if (!appReady) {
    retryIncompleteBoot();
    return;
  }
  refreshConversationListOnForeground({ reconnectSocket: suspended });
}

function refreshConversationListOnForeground({ reconnectSocket = false } = {}) {
  if (!state.me || !appReady) {
    retryIncompleteBoot();
    return;
  }
  if (reconnectSocket) state.socket?.reconnect();
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

function keepConversationSelectedDuringTransition(button) {
  elements.personalConversationButton.classList.remove("active");
  elements.conversations.querySelectorAll(".conversation-item.active").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
}

function normalizedConversationSearch(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase(locale)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function conversationMatchesSearch(searchText, query) {
  const normalizedQuery = normalizedConversationSearch(query);
  return !normalizedQuery || normalizedConversationSearch(searchText).includes(normalizedQuery);
}

function applyConversationSearch() {
  const query = elements.conversationSearch.value;
  const candidates = [
    elements.personalConversationButton,
    ...elements.conversations.querySelectorAll("[data-conversation-search]"),
  ];
  let visibleCount = 0;
  for (const candidate of candidates) {
    const matches = conversationMatchesSearch(candidate.dataset.conversationSearch, query);
    candidate.classList.toggle("conversation-search-hidden", !matches);
    if (matches && !candidate.hidden) visibleCount += 1;
  }

  const normalizedQuery = normalizedConversationSearch(query);
  elements.conversations.querySelector(".conversation-list-base-empty")
    ?.classList.toggle("conversation-search-hidden", Boolean(normalizedQuery));
  let empty = elements.conversations.querySelector(".conversation-search-empty");
  if (normalizedQuery && visibleCount === 0) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "muted sidebar-empty conversation-search-empty";
      empty.setAttribute("role", "status");
      empty.textContent = t("Aucune discussion trouvée");
      elements.conversations.append(empty);
    }
  } else {
    empty?.remove();
  }
}

async function renderPersonalConversation(isCurrentRender = () => true) {
  const conversation = state.conversations.find((item) => item.is_personal);
  if (!conversation) {
    if (isCurrentRender()) {
      elements.personalConversationButton.hidden = true;
      delete elements.personalConversationButton.dataset.conversationSearch;
    }
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
  state.conversationDisplays.set(String(conversation.id), {
    title: t("Mes notes"),
    description: t("Messages et fichiers personnels"),
    avatar: null,
    customAvatar: null,
  });
  elements.personalConversationButton.hidden = false;
  elements.personalConversationButton.classList.toggle("active", sameID(conversationListActiveID(), conversation.id));
  elements.personalConversationUnread.hidden = unreadCount === 0;
  elements.personalConversationUnread.textContent = unreadCount > 99 ? "99+" : String(unreadCount || "");
  elements.personalConversationUnread.setAttribute("aria-label", t(
    unreadCount === 1 ? "{count} message non lu" : "{count} messages non lus",
    { count: unreadCount },
  ));
  elements.personalConversationPreview.textContent = preview;
  elements.personalConversationButton.dataset.conversationSearch = [
    t("Mes notes"),
    t("Messages et fichiers personnels"),
    preview,
  ].join(" ");
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
  const listedConversationIDs = new Set(state.conversations.map((conversation) => String(conversation.id)));
  for (const conversationID of state.conversationDisplays.keys()) {
    if (!listedConversationIDs.has(conversationID)) state.conversationDisplays.delete(conversationID);
  }
  listedConversations.forEach((conversation, index) => {
    const display = displays[index];
    if (display && !display.securityBlocked) state.conversationDisplays.set(String(conversation.id), display);
    else state.conversationDisplays.delete(String(conversation.id));
  });
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
  applyConversationSearch();
  if (renderKey === conversationListRenderKey) return;
  const list = document.createDocumentFragment();
  for (const contact of pendingContacts) {
    list.append(renderContactRequest(contact));
  }
  if (!listedConversations.length && !pendingContacts.length && elements.personalConversationButton.hidden) {
    const empty = document.createElement("p");
    empty.className = "muted sidebar-empty conversation-list-base-empty";
    empty.textContent = t("Aucune conversation");
    list.append(empty);
    conversationListRenderKey = renderKey;
    elements.conversations.replaceChildren(list);
    applyConversationSearch();
    return;
  }
  for (const { conversation, display, callState, typing, online, preview } of details) {
    if (conversation.type === "group" && conversation.role === "pending") {
      list.append(renderGroupInvitation(conversation, display));
      continue;
    }
    const row = document.createElement("div");
    row.className = "conversation-row swipe-row";
    row.dataset.conversationSearch = [display?.title, display?.description, preview].filter(Boolean).join(" ");
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
    avatar.className = conversation.type === "group" ? "avatar group-conversation-avatar" : "avatar";
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
      keepConversationSelectedDuringTransition(button);
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
    applyConversationSearch();
  }
}

function renderGroupInvitation(conversation, display = null) {
  const row = document.createElement("div");
  row.className = "contact-request-row";
  row.dataset.conversationSearch = [display?.title, display?.description, t("Invitation de groupe")].filter(Boolean).join(" ");
  const avatar = document.createElement("span");
  avatar.className = "avatar group-conversation-avatar";
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
    state.verifiedConversationMembers.delete(String(conversation.id));
    state.conversationDisplays.delete(String(conversation.id));
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
  row.dataset.conversationSearch = [
    contact.display_name,
    contact.username,
    t(contact.direction === "incoming" ? "Demande de contact" : "En attente d’acceptation"),
  ].filter(Boolean).join(" ");
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
      const discoveryCodes = Object.fromEntries((result.invitedUsers || [])
        .filter((member) => member.discovery_code && addedMemberIDs.some((userID) => sameID(userID, member.id)))
        .map((member) => [String(member.id), member.discovery_code]));
      await api(`/api/conversations/${conversation.id}/rotate-keys`, {
        method: "POST",
        body: {
          key_epoch: nextEpoch,
          removed_user_ids: removedMemberIDs,
          added_user_ids: addedMemberIDs,
          encrypted_keys: encryptedKeys,
          discovery_codes: discoveryCodes,
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
    state.verifiedConversationMembers.delete(String(conversation.id));
    state.conversationDisplays.delete(String(conversation.id));
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

function createNoConversationState() {
  const container = document.createElement("div");
  container.className = "no-conversation-state";

  const intro = document.createElement("div");
  intro.className = "conversation-exchange-intro no-conversation-intro";

  const icon = document.createElement("span");
  icon.className = "conversation-exchange-icon no-conversation-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg viewBox="0 0 120 120" focusable="false"><path d="M60 22 98 60 60 98 22 60Z"></path></svg>`;

  const copy = document.createElement("span");
  copy.className = "conversation-exchange-copy";
  const title = document.createElement("strong");
  title.textContent = "Vibration";
  const subtitle = document.createElement("span");
  subtitle.textContent = t("messagerie chiffrée, collaborative et souveraine");
  copy.append(title, subtitle);
  intro.append(icon, copy);

  const empty = document.createElement("div");
  empty.id = "empty-chat";
  empty.textContent = t("Sélectionnez une conversation ou créez-en une nouvelle.");

  container.append(intro, empty);
  return container;
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
  elements.messages.replaceChildren(createNoConversationState());
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
    state.verifiedConversationMembers.delete(String(conversation.id));
    state.conversationDisplays.delete(String(conversation.id));
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

function markConversationMembersVerified(conversationID) {
  state.verifiedConversationMembers.add(String(conversationID));
}

function conversationMembersAreVerified(conversationID) {
  return state.verifiedConversationMembers.has(String(conversationID));
}

async function getMembers(conversationID, { fresh = false, interactive = false } = {}) {
  if (!fresh && conversationMembersAreVerified(conversationID) && state.members.has(conversationID)) {
    return state.members.get(conversationID);
  }
  if (fresh) {
    try {
      const members = await trustMembers(
        await api(`/api/conversations/${conversationID}/members`),
        { interactive },
      );
      state.members.set(conversationID, members);
      markConversationMembersVerified(conversationID);
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
          markConversationMembersVerified(conversationID);
          await state.cache?.saveMembers(conversationID, members);
        })
        .catch((error) => reportIdentitySecurityError(error));
    } else {
      const members = await trustMembers(
        await api(`/api/conversations/${conversationID}/members`),
        { interactive },
      );
      state.members.set(conversationID, members);
      markConversationMembersVerified(conversationID);
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
  const selectionVersion = ++conversationSelectionVersion;
  const selectedID = conversation.id;
  const membersWereVerified = conversationMembersAreVerified(selectedID);
  const conversationChanged = !sameID(state.current?.id, conversation.id);
  closeReactionPicker();
  if (conversationChanged) {
    clearVoiceDraft();
    clearFileCache();
    const loading = document.createElement("div");
    loading.id = "empty-chat";
    loading.textContent = t("Chargement…");
    elements.messages.replaceChildren(loading);
  }
  state.current = conversation;
  conversation.unread_count = 0;
  const listed = state.conversations.find((item) => sameID(item.id, selectedID));
  if (listed) listed.unread_count = 0;
  elements.shell.classList.remove("sidebar-open");
  const sidebarButton = document.querySelector("#open-sidebar-logo");
  sidebarButton.setAttribute("aria-expanded", "false");
  sidebarButton.setAttribute("aria-label", t("Afficher les contacts, groupes et conversations"));
  sidebarButton.title = t("Afficher les contacts et groupes");
  const rememberedDisplay = state.conversationDisplays.get(String(selectedID));
  if (rememberedDisplay) {
    renderConversationHeader(conversation, rememberedDisplay);
  } else {
    elements.title.textContent = t("Chargement…");
    elements.description.textContent = "";
    elements.chatAvatar.hidden = true;
    setConversationInfoTrigger(null);
    renderMobileNavigationAvatar();
  }
  if (conversationChanged && !targetMessageID && !conversation.last_message_at) {
    const empty = document.createElement("div");
    empty.id = "empty-chat";
    empty.textContent = t("Aucun message. Écrivez le premier message chiffré.");
    elements.messages.replaceChildren(createConversationExchangeState(conversation, empty));
  }
  renderTypingIndicator(elements.typing, null);
  renderTypingIndicator(elements.threadTyping, null);
  elements.threadTyping.hidden = true;

  const canInteractImmediately = membersWereVerified && !conversation.rotation_required;
  elements.input.disabled = !canInteractImmediately;
  elements.send.disabled = !canInteractImmediately;
  elements.emojiButton.disabled = !canInteractImmediately;
  elements.voiceButton.disabled = !canInteractImmediately;
  elements.pollButton.disabled = !canInteractImmediately;
  elements.eventButton.disabled = !canInteractImmediately;
  elements.pinnedWindowButton.disabled = !membersWereVerified;
  elements.audioCallButton.disabled = true;
  elements.videoCallButton.disabled = true;

  let messagesLoading = membersWereVerified
    ? loadMessages(targetMessageID).then(() => null, (error) => error)
    : null;
  try {
    await getMembers(conversation.id, {
      fresh: !membersWereVerified,
      interactive: true,
    });
    if (selectionVersion !== conversationSelectionVersion) return;
    if (conversation.rotation_required && sameID(conversation.created_by, state.me.id)) {
      await repairRequiredGroupRotation(conversation);
      if (selectionVersion !== conversationSelectionVersion) return;
      toast("La clé du groupe a été renouvelée après le départ d’un membre.", "success");
    }
  } catch (error) {
    if (selectionVersion !== conversationSelectionVersion) return;
    closeCurrentConversation(selectedID);
    renderConversations().catch(() => {});
    error.conversationID = conversation.id;
    if (!reportIdentitySecurityError(error)) {
      toast(frenchErrorMessage(error, "Impossible de vérifier les participants de cette discussion."), "error");
    }
    return;
  }
  if (!messagesLoading) {
    messagesLoading = loadMessages(targetMessageID).then(() => null, (error) => error);
  }
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
  refreshCallCapability(conversation).catch(() => {});
  const display = await resolveConversationDisplay(conversation);
  if (selectionVersion !== conversationSelectionVersion || !sameID(state.current?.id, selectedID)) return;
  state.conversationDisplays.set(String(selectedID), display);
  renderConversationHeader(conversation, display);
  const typing = await typingIndicator(conversation);
  if (selectionVersion !== conversationSelectionVersion || !sameID(state.current?.id, selectedID)) return;
  renderTypingIndicator(elements.typing, typing);
  renderTypingIndicator(elements.threadTyping, typing);
  elements.threadTyping.hidden = !typing;
  const [, messageLoadError] = await Promise.all([renderConversations(), messagesLoading]);
  if (selectionVersion !== conversationSelectionVersion || !sameID(state.current?.id, selectedID)) return;
  if (messageLoadError) throw messageLoadError;
  if (!elements.pinnedPanel.hidden) await loadPinnedMessages();
  if (selectionVersion !== conversationSelectionVersion || !sameID(state.current?.id, selectedID)) return;
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

const callCapabilityCache = new Map();
const callCapabilityProbes = new Map();
// Bounded: one entry per conversation the user visits in a session. The oldest
// are evicted rather than kept for the lifetime of the tab.
const CALL_CAPABILITY_CACHE_LIMIT = 256;
const CALL_CAPABILITY_TTL_MS = 5 * 60 * 1000;
// A failed probe is retried quickly. It usually means a transient network
// error, and making the user wait out the full cache before the buttons can
// come back would turn a blip into a five-minute outage.
const CALL_CAPABILITY_RETRY_MS = 15 * 1000;

// callCapability reports whether every instance in a conversation speaks the
// versioned call protocol. A successful answer is cached for a few minutes: it
// changes only when an administrator upgrades or disables an instance, and
// probing it on every render would put an HTTP round trip in front of a button.
function callCapability(conversationID) {
  const entry = callCapabilityCache.get(String(conversationID));
  if (!entry) return null;
  const ttl = entry.verified ? CALL_CAPABILITY_TTL_MS : CALL_CAPABILITY_RETRY_MS;
  return Date.now() - entry.checkedAt < ttl ? entry : null;
}

function rememberCallCapability(key, entry) {
  callCapabilityCache.set(key, entry);
  while (callCapabilityCache.size > CALL_CAPABILITY_CACHE_LIMIT) {
    const oldest = callCapabilityCache.keys().next().value;
    if (oldest === key) break;
    callCapabilityCache.delete(oldest);
  }
}

async function refreshCallCapability(conversation = state.current) {
  if (!conversation?.id || !["private", "group"].includes(conversation.type)) return;
  const key = String(conversation.id);
  if (callCapability(key)) return;
  // One probe at a time per conversation: rendering a list can ask for the same
  // answer several times in the same tick.
  const inFlight = callCapabilityProbes.get(key);
  if (inFlight) {
    await inFlight;
    return;
  }
  const probe = (async () => {
    try {
      const result = await api(`/api/calls/capabilities?conversation_id=${encodeURIComponent(conversation.id)}`);
      rememberCallCapability(key, {
        supported: Boolean(result.supported),
        reason: result.reason || "",
        verified: true,
        checkedAt: Date.now(),
      });
    } catch (error) {
      // A federated conversation must never be enabled on a network error: we
      // would be asserting compatibility we could not check, and the user would
      // start a call whose signalling has nowhere to go. A purely local
      // conversation needs no remote instance, so it stays available.
      console.warn("Capacités d’appel indisponibles", error?.message || error);
      rememberCallCapability(key, {
        supported: !isFederatedConversation(conversation),
        reason: "unverified",
        verified: false,
        checkedAt: Date.now(),
      });
    } finally {
      callCapabilityProbes.delete(key);
    }
  })();
  callCapabilityProbes.set(key, probe);
  await probe;
  if (!sameID(state.current?.id, conversation.id)) return;
  updateCallButtons();
  scheduleCallCapabilityRetry(conversation);
}

let callCapabilityRetryTimer = null;

// scheduleCallCapabilityRetry brings the buttons back on their own once a
// transient failure clears. Without it an unverified conversation would stay
// disabled until the user navigated away and back.
function scheduleCallCapabilityRetry(conversation) {
  const entry = callCapabilityCache.get(String(conversation.id));
  if (entry?.verified) return;
  window.clearTimeout(callCapabilityRetryTimer);
  callCapabilityRetryTimer = window.setTimeout(() => {
    callCapabilityRetryTimer = null;
    if (!sameID(state.current?.id, conversation.id)) return;
    refreshCallCapability(conversation).catch(() => {});
  }, CALL_CAPABILITY_RETRY_MS);
}

function updateCallButtons() {
  const capability = state.current ? callCapability(state.current.id) : null;
  // An unknown capability keeps a federated conversation disabled while the
  // probe is in flight: starting a call that can never connect is worse than
  // waiting for the answer.
  const compatible = capability ? capability.supported : !isFederatedConversation(state.current);
  const enabled = canSignalCall() && !state.call && compatible;
  elements.audioCallButton.disabled = !enabled;
  elements.videoCallButton.disabled = !enabled;
  if (!compatible) {
    const explanation = callCapabilityMessage(capability?.reason);
    elements.audioCallButton.title = explanation;
    elements.videoCallButton.title = explanation;
    return;
  }
  elements.audioCallButton.title = t(state.current?.type === "group" ? "Appel audio de groupe" : "Appel audio");
  elements.videoCallButton.title = t(state.current?.type === "group" ? "Appel vidéo de groupe" : "Appel vidéo");
}

function isFederatedConversation(conversation = state.current) {
  return Boolean(conversation?.is_federated || conversation?.federation_instance_url);
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
  if (reason === "identity_unavailable") return "Le correspondant n’a pas pu charger sa configuration d’appel.";
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
    const identity = callPeerIdentity(userID);
    peers.set(userID, {
      userID,
      identity,
      // link and negotiation are created with the RTCPeerConnection in
      // ensureCallPeer; there is no second implementation to keep in step.
      link: null,
      negotiation: null,
      peer: null,
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

const callSequencer = createCallSequencer();
const callSignalLedger = createCallSignalLedger();

// localCallIdentity is this browser's canonical, cross-instance identity. It
// comes from the server, which is the only party that knows both this
// instance's federation base URL and the account behind the session.
function localCallIdentity() {
  return state.callIdentity || null;
}

// callPeerIdentity is the canonical identity of another participant. It is
// learned from the signals themselves — every call event carries its sender's
// identity alongside the numeric id this instance uses locally — so the two
// never have to be reconciled through a lookup that could disagree.
function callPeerIdentity(userID, call = state.call) {
  return call?.identities?.get(Number(userID)) || null;
}

// callKnownSenders lists every identity that may have signalled for this call:
// the remote participants learned from their own signals, plus this browser.
// A tombstone is per sender, so ending a call has to record one for each.
function callKnownSenders(call) {
  const senders = [];
  const local = localCallIdentity();
  if (local) senders.push(local);
  for (const identity of call?.identities?.values() ?? []) senders.push(identity);
  return senders;
}

function rememberCallPeerIdentity(userID, identity, call = state.call) {
  if (!call || !userID || !identity?.username) return null;
  const known = callIdentity(identity.instance, identity.username);
  if (!call.identities) call.identities = new Map();
  call.identities.set(Number(userID), known);
  const peerState = call.peers?.get(Number(userID));
  if (peerState) {
    peerState.identity = known;
    // The negotiation link must adopt the identity too. A peer is often created
    // before its canonical identity is known, and leaving the old one in place
    // would keep a polite/impolite role derived from nothing — which both sides
    // can pick identically, producing exactly the offer collision the role
    // exists to prevent.
    peerState.link?.learnIdentities(known, localCallIdentity());
  }
  return known;
}

// callNegotiationIdentityReady reports whether this browser knows its own
// canonical identity. Without it the polite/impolite role cannot be derived,
// and falling back to numeric identifiers is precisely the bug this protocol
// exists to remove — so a call that needs the role is refused instead.
function callNegotiationIdentityReady() {
  return Boolean(canonicalCallIdentity(localCallIdentity()));
}

// callNeedsCanonicalIdentity reports whether a conversation's negotiation
// depends on canonical identities. A private call between two users of this
// instance is decided by the call's own direction, so it keeps working even if
// the call configuration could not be loaded.
function callNeedsCanonicalIdentity(conversation = state.current) {
  return Boolean(conversation) && (conversation.type === "group" || isFederatedConversation(conversation));
}

// memberCallIdentity builds a participant's identity from the membership list.
// It is the fallback used before that participant has sent anything.
function memberCallIdentity(member) {
  if (!member) return null;
  if (member.is_remote) {
    if (!member.federation_instance_url || !member.remote_username) return null;
    return callIdentity(member.federation_instance_url, member.remote_username);
  }
  const local = localCallIdentity();
  if (!local) return null;
  return callIdentity(local.instance, member.username);
}

async function resolveCallPeerIdentity(conversationID, userID) {
  const known = callPeerIdentity(userID);
  if (known) return known;
  const members = await getMembers(conversationID).catch(() => []);
  const identity = memberCallIdentity(members.find((item) => sameID(item.user_id, userID)));
  return identity ? rememberCallPeerIdentity(userID, identity) : null;
}

function sendCallSignal(type, extra = {}) {
  const conversationID = extra.conversation_id || state.call?.conversationID || state.current?.id;
  if (!conversationID) return null;
  const { conversation_id: ignoredConversationID, target_user_id: targetUserID, target, ...payload } = extra;
  const callID = payload.call_id || state.call?.id || "";
  const eventID = newCallEventID();
  const createdAt = new Date();
  // The target is addressed by canonical identity. The numeric id is still sent
  // so a peer that has not reloaded keeps working, but the server resolves the
  // identity first and only falls back to the id when no identity is given.
  const resolvedTarget = target || (targetUserID ? callPeerIdentity(targetUserID) : null);
  state.socket.send({
    type,
    version: "federated-calls-v1",
    conversation_id: conversationID,
    event_id: eventID,
    // The sequence is scoped by conversation, sender, call *and* addressee: a
    // signal sent to one participant must never make a signal to another look
    // stale, and the same call id in another conversation must not share it.
    sequence: callSequencer.next({
      conversationID,
      sender: localCallIdentity(),
      callID,
      target: resolvedTarget,
    }),
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + CALL_EVENT_TTL_MS).toISOString(),
    ...(resolvedTarget ? { target: resolvedTarget } : {}),
    ...(targetUserID ? { target_user_id: targetUserID } : {}),
    ...payload,
  });
  return eventID;
}

async function startCallInvite(media) {
  if (!canSignalCall() || state.call) return;
  await loadCallConfig().catch(() => {});
  if (state.call) return;
  // A federated or group call cannot pick the polite/impolite role without the
  // canonical identity, so the configuration is retried once here rather than
  // failing on a stale earlier error.
  if (callNeedsCanonicalIdentity() && !(await ensureCallIdentity())) {
    toast(callCapabilityMessage("no_local_identity"), "error");
    return;
  }
  const call = {
    id: newCallID(),
    conversationID: state.current.id,
    media,
    direction: "outgoing",
    status: "ringing",
    facingMode: "user",
    peers: new Map(),
    identities: new Map(),
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
    // The identity is verified before the microphone or camera is opened. There
    // is no point prompting for device access for a call that cannot negotiate,
    // and no acceptance is announced until we know we can honour it.
    if (callNeedsCanonicalIdentity(callConversation()) && !(await ensureCallIdentity())) {
      sendCallSignal("call_reject", {
        call_id: state.call.id,
        media: state.call.media,
        reason: "identity_unavailable",
        target_user_id: state.call.callerID,
      });
      clearCallState();
      toast(callCapabilityMessage("no_local_identity"), "error");
      return;
    }
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
  // Drop the ordering state of the finished call but *keep* its tombstone.
  // Erasing the tombstone here would undo the protection it exists for: a late
  // offer or invitation for this call, carrying an event id never seen before,
  // would be admitted into a session the user has already ended.
  if (call?.id) {
    for (const identity of callKnownSenders(call)) {
      callSignalLedger.endCall({ conversationID: call.conversationID, sender: identity, callID: call.id });
    }
    callSequencer.forget({
      conversationID: call.conversationID,
      sender: localCallIdentity(),
      callID: call.id,
    });
  }
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
  // The link owns the pending candidate queue and the negotiation state; it dies
  // with the connection it drove rather than outliving it.
  peerState.link?.dropPendingCandidates();
  peerState.link = null;
  peerState.negotiation = null;
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
  // The negotiation state machine lives in call-negotiation.js and is the only
  // implementation: offers, glare resolution, candidate buffering and ICE
  // restarts all go through this link. Keeping a second copy here is what let
  // the unit tests pass while production ran different code.
  peerState.link = createPeerLink({
    peer,
    localIdentity: localCallIdentity(),
    remoteIdentity: peerState.identity || callPeerIdentity(userID),
    send: (signal) => {
      if (!state.call) return;
      sendCallSignal(signal.type, {
        call_id: state.call.id,
        media: state.call.media,
        target_user_id: userID,
        ...(signal.sdp ? { sdp: signal.sdp } : {}),
        ...(signal.candidate ? { candidate: signal.candidate } : {}),
      });
    },
  });
  peerState.negotiation = peerState.link.negotiation;
  peer.onicecandidate = ({ candidate }) => {
    if (!candidate || !state.call) return;
    peerState.link.emitCandidate(candidate);
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

// CALL_CONFIG_RETRY_MS is how long a fallback configuration is used before the
// server is asked again. A failed fetch used to be cached for the lifetime of
// the page, so one transient error left the browser without its canonical
// identity — and therefore unable to start a federated call — until reload.
const CALL_CONFIG_RETRY_MS = 15 * 1000;

let callConfigProbe = null;

// callConfigIsUsable reports whether the cached configuration came from the
// server. A fallback is usable for a local call but carries no identity, so a
// federated or group call must not be built on it.
function callConfigIsUsable(config) {
  return Boolean(config?.verified);
}

async function loadCallConfig({ force = false } = {}) {
  const cached = state.callConfig;
  const stale = cached && !cached.verified && Date.now() - cached.loadedAt >= CALL_CONFIG_RETRY_MS;
  if (cached && !force && !stale) return cached;
  // Concurrent callers share one request rather than each firing their own.
  if (callConfigProbe) return callConfigProbe;
  callConfigProbe = api("/api/calls/config")
    .then((config) => {
      const publicFallbackURLs = Array.isArray(config.public_fallback_urls) && config.public_fallback_urls.length
        ? config.public_fallback_urls
        : ["stun:stun.l.google.com:19302"];
      // iceTransportPolicy is applied here rather than dropped: a "relay"
      // policy is the only way to verify a TURN deployment, because with "all"
      // the browser silently succeeds over a direct path and a broken relay
      // stays invisible until a symmetric NAT hits it.
      const rtcConfig = callRTCConfigurationFrom(config);
      state.callIdentity = config.identity?.username
        ? callIdentity(config.identity.instance, config.identity.username)
        : null;
      const resolved = {
        verified: true,
        loadedAt: Date.now(),
        rtcConfig,
        relayPolicy: rtcConfig.iceTransportPolicy,
        publicFallbackURLs,
        privateTurnURLs: rtcConfig.iceServers.flatMap((server) => urlsOfIceServer(server))
          .filter((url) => /^turns?:/i.test(url) && !publicFallbackURLs.includes(url)),
        privateTurnConfigured: Boolean(config.private_turn_configured),
      };
      state.callConfig = resolved;
      return resolved;
    })
    .catch((error) => {
      // A fallback keeps purely local calls working, but it is marked unverified
      // and short-lived so the next attempt can recover without a reload.
      console.warn("Configuration WebRTC indisponible, STUN par défaut utilisé", error?.message || error);
      const fallback = {
        verified: false,
        loadedAt: Date.now(),
        rtcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], iceTransportPolicy: "all" },
        relayPolicy: "all",
        publicFallbackURLs: ["stun:stun.l.google.com:19302"],
        privateTurnURLs: [],
        privateTurnConfigured: false,
      };
      state.callConfig = fallback;
      return fallback;
    })
    .finally(() => {
      callConfigProbe = null;
    });
  return callConfigProbe;
}

async function callRTCConfiguration() {
  const config = await loadCallConfig();
  return config.rtcConfig;
}

// ensureCallIdentity forces a fresh attempt when a call genuinely needs the
// canonical identity, so a single earlier failure does not disable calling for
// the rest of the session.
async function ensureCallIdentity() {
  if (callNegotiationIdentityReady()) return true;
  await loadCallConfig({ force: true }).catch(() => null);
  return callNegotiationIdentityReady();
}

function urlsOfIceServer(server) {
  if (!server?.urls) return [];
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

async function callNetworkConfig() {
  return loadCallConfig();
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

// isCallNegotiationInitiator decides whether this browser is the side that
// creates the offer for one peer.
//
// It never compares numeric user ids. Those are per-database and mean nothing
// between instances: with A=1/B=2 on one server and A=7/B=3 on the other, the
// old comparison made both browsers believe they were the initiator, or
// neither. A private call follows its own direction — the caller offers once
// the callee accepts — and a group call falls back to the canonical identities,
// which both sides order identically.
function isCallNegotiationInitiator(userID, call = state.call) {
  if (!call) return false;
  if (!isGroupCall(call)) return shouldOfferAfterAccept(call);
  const remote = callPeerIdentity(userID, call);
  const local = localCallIdentity();
  if (!remote || !local) return false;
  return shouldOfferInGroup(local, remote);
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
  await peerState.link.offer({ iceRestart: true });
  startPeerIceRestartTimeout(peerState, userID);
  toast("Connexion média instable. Reprise de l’appel en cours.", "error");
}

// resumePendingCallIceRestarts runs after the WebSocket comes back. It does not
// replay anything that was buffered while the socket was down: those candidates
// describe transport paths the browser has already given up on, and the offers
// they belonged to may have been superseded. Instead each peer is asked to
// confirm it is still in the call, and only the side entitled to offer
// renegotiates.
function resumePendingCallIceRestarts() {
  if (!state.call?.peers) return;
  for (const peerState of state.call.peers.values()) {
    peerState.link?.dropPendingCandidates();
    sendCallSignal("call_resync", {
      call_id: state.call.id,
      media: state.call.media,
      target_user_id: peerState.userID,
    });
    if (!peerState.needsIceRestart || !isCallNegotiationInitiator(peerState.userID)) continue;
    restartPeerIce(peerState, peerState.userID).catch((error) => {
      console.warn("Reprise ICE différée impossible", error);
      finishCallPeerConnectionFailure(peerState.userID);
    });
  }
}

// handleCallResync answers a peer that reconnected. The side allowed to offer
// renegotiates with an ICE restart; the other side simply acknowledges, so the
// two never offer at once. A resync for a call this browser no longer has ends
// the peer's call instead of leaving it waiting for media that will not come.
async function handleCallResync(event) {
  // A resync only concerns the call it names. Matching on the peer alone would
  // let a straggler from a previous call restart ICE on the current one.
  const current = state.call?.id === event.call_id && sameID(state.call.conversationID, event.conversation_id)
    ? state.call
    : null;
  const peerState = current?.peers?.get(event.user_id);
  if (!peerState?.peer) {
    sendCallSignal("call_hangup", {
      conversation_id: event.conversation_id,
      call_id: event.call_id,
      media: event.media || "audio",
      reason: "session_gone",
      target_user_id: event.user_id,
    });
    return;
  }
  if (callPeerIsConnected(peerState) || !isCallNegotiationInitiator(event.user_id)) return;
  peerState.needsIceRestart = true;
  await restartPeerIce(peerState, event.user_id).catch((error) => {
    console.warn("Renégociation après reconnexion impossible", error);
    finishCallPeerConnectionFailure(event.user_id);
  });
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

async function beginOutgoingPeerOffer(userID) {
  clearCallAlerts();
  state.call.status = "connecting";
  updateCallUI();
  await ensureCallPeer(userID);
  await getCallPeer(userID).link.offer();
}

async function maybeBeginOutgoingPeerOffer(userID) {
  if (!state.call || !userID || userID === state.me.id) return;
  if (state.call.peers?.get(userID)?.peer) return;
  // Both identities must be known before the polite/impolite roles can be
  // decided, so the configuration (which carries this browser's identity) and
  // the peer's identity are resolved first.
  await loadCallConfig().catch(() => {});
  const peerIdentity = await resolveCallPeerIdentity(state.call.conversationID, userID).catch(() => null);
  if (!state.call) return;
  const conversation = callConversation();
  if (callNeedsCanonicalIdentity(conversation) && (!callNegotiationIdentityReady() || !peerIdentity)) {
    // Guessing the role here would let both browsers offer at once, or neither.
    // Failing loudly is the only honest option.
    toast(callCapabilityMessage("no_local_identity"), "error");
    hangupCall("identity_unavailable");
    return;
  }
  if (!isCallNegotiationInitiator(userID)) return;
  await beginOutgoingPeerOffer(userID);
}

async function connectAcceptedCallPeers() {
  if (!state.call?.acceptedUserIDs) return;
  for (const userID of state.call.acceptedUserIDs) {
    await maybeBeginOutgoingPeerOffer(userID);
  }
}

// acceptRemoteDescription applies an offer or an answer through the shared
// negotiation link.
//
// Glare handling — the case where both peers offer at once, which happens on
// every ICE restart and whenever two group members accept simultaneously — is
// implemented once, in call-negotiation.js, and exercised by the peer-link
// integration test. This function only supplies the surrounding call state.
async function acceptRemoteOffer(userID, sdp) {
  clearCallAlerts();
  state.call.status = "connecting";
  updateCallUI();
  await ensureCallPeer(userID);
  const peerState = getCallPeer(userID);
  const recoveringIce = Boolean(
    peerState.peer.remoteDescription || peerState.needsIceRestart || peerState.iceRestarting || peerState.iceRestartTimeout,
  );
  if (recoveringIce) clearPeerIceRestartTimer(peerState);
  const result = await peerState.link.acceptDescription(sdp);
  if (!result.applied) return;
  if (recoveringIce) {
    peerState.needsIceRestart = false;
    peerState.iceRestarting = true;
    startPeerIceRestartTimeout(peerState, userID);
  }
}

async function acceptRemoteAnswer(userID, sdp) {
  const peerState = getCallPeer(userID);
  if (!peerState?.link) return;
  await peerState.link.acceptDescription(sdp);
  peerState.needsIceRestart = false;
}

async function handleRemoteIceCandidate(userID, candidate) {
  if (!candidate) return;
  const peerState = getCallPeer(userID);
  if (!peerState?.link) return;
  await peerState.link.acceptCandidate(candidate);
}

function removeCallPeer(userID) {
  const peerState = state.call?.peers?.get(userID);
  if (!peerState) return;
  closeCallPeer(peerState);
  state.call.peers.delete(userID);
  updateCallUI();
  refreshConversationCallIndicators();
}

async function handleCallSignalFailure(event) {
  const call = state.call;
  if (!call || call.id !== event.call_id || !sameID(call.conversationID, event.conversation_id)) return;
  if (["call_hangup", "call_reject"].includes(event.signal_type)) return;
  // The failure names its target by canonical identity; the numeric id is only
  // used to look up a display name on this instance.
  const targetName = await memberDisplayName(event.conversation_id, event.target_user_id, "un participant");
  if (state.call !== call) return;
  const explanation = callFailureMessage(event.reason);
  if (isGroupCall(call)) {
    if (event.target_user_id) removeCallPeer(event.target_user_id);
    toast(`${targetName} : ${explanation}`, "error");
    return;
  }
  const history = call.status === "ringing"
    ? `${callHistoryLabel(call.media)} impossible : correspondant indisponible.`
    : `${callHistoryLabel(call.media)} interrompu : signalisation indisponible.`;
  logCallHistory(call, history);
  await clearCallState(call.conversationID);
  toast(`Appel interrompu. ${explanation}`, "error");
}

async function handleCallSignal(event) {
  if (event.type === "call_signal_failed") {
    await handleCallSignalFailure(event);
    return;
  }
  if (event.user_id === state.me.id) return;
  if (event.target_user_id && event.target_user_id !== state.me.id) return;
  // Drop duplicates, expired signals and offers older than one already applied
  // before they reach a peer connection. Re-applying an offer tears down a
  // working call, and a signal that outlived its window describes transport
  // candidates that no longer exist.
  const admission = callSignalLedger.accept(event);
  if (!admission.ok) return;
  const localIdentity = localCallIdentity();
  if (event.target && localIdentity && !sameCallIdentity(event.target, localIdentity)) return;
  if (event.sender?.username) rememberCallPeerIdentity(event.user_id, event.sender);
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
      identities: new Map(),
      acceptedUserIDs: new Set([event.user_id]),
    };
    rememberCallPeerIdentity(event.user_id, event.sender);
    startIncomingCallAlerts(state.call);
    showIncomingCallNotification(`${callLabel(state.call.media)} entrant`, `${callerName} vous appelle.`).catch(() => {});
    if (!sameID(state.current?.id, event.conversation_id)) {
      toast(`${callLabel(state.call.media)} entrant de ${callerName}. Ouvrez la conversation pour répondre.`);
    }
    updateCallUI();
    refreshConversationCallIndicators();
    return;
  }
  if (event.type === "call_resync") {
    await handleCallResync(event);
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
    if (state.call.direction === "outgoing" && !isGroupCall()
      && ["busy", "timeout", "media_error", "identity_unavailable"].includes(event.reason)) {
      const text = event.reason === "busy"
        ? `${callHistoryLabel(state.call.media)} impossible : correspondant occupé.`
        : event.reason === "media_error"
          ? `${callHistoryLabel(state.call.media)} impossible : média indisponible.`
        : event.reason === "identity_unavailable"
          ? `${callHistoryLabel(state.call.media)} impossible : configuration d’appel indisponible.`
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
    elements.messages.replaceChildren(createConversationExchangeState(conversation, empty));
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
    if (message.file) rememberGlobalFileClear(message, clear);
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
      reportMessage,
    );
    if (message.sender_id !== state.me.id) {
      api(`/api/messages/${message.id}/read`, { method: "POST", body: {} }).catch(() => {});
    }
  }
  const conversationExchangeState = createConversationExchangeState(conversation);
  if (conversationExchangeState) fragment.append(conversationExchangeState);
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

function setPinnedPanelVisibility(open) {
  elements.pinnedPanel.hidden = !open;
  elements.chatWorkspace.classList.toggle("pinned-open", open);
  elements.pinnedWindowButton.setAttribute("aria-expanded", String(open));
  elements.pinnedWindowButton.title = t(open ? "Masquer vos messages épinglés" : "Afficher vos messages épinglés");
  elements.pinnedWindowButton.setAttribute("aria-label", elements.pinnedWindowButton.title);
}

async function setPinnedPanelOpen(open) {
  if (!open) {
    pinnedPanelLoadVersion += 1;
    setPinnedPanelVisibility(false);
    elements.pinnedMessages.removeAttribute("aria-busy");
    if (pinnedPanelOpenTask) {
      pinnedPanelOpenTask = null;
      elements.pinnedWindowButton.disabled = !state.current;
      elements.pinnedWindowButton.removeAttribute("aria-busy");
    }
    return;
  }
  if (!state.current || !elements.pinnedPanel.hidden) return;
  if (pinnedPanelOpenTask) return pinnedPanelOpenTask;

  const loadVersion = ++pinnedPanelLoadVersion;
  elements.pinnedWindowButton.disabled = true;
  elements.pinnedWindowButton.setAttribute("aria-busy", "true");
  let openTask;
  openTask = (async () => {
    const loaded = await loadPinnedMessages({ allowHidden: true, renderLoading: false, throwOnError: true });
    if (!loaded || loadVersion !== pinnedPanelLoadVersion || !state.current) return;
    setPinnedPanelVisibility(true);
  })()
    .catch((error) => {
      if (loadVersion !== pinnedPanelLoadVersion) return;
      toast(frenchErrorMessage(error, "Impossible de charger les messages épinglés."), "error");
    })
    .finally(() => {
      if (pinnedPanelOpenTask !== openTask) return;
      pinnedPanelOpenTask = null;
      elements.pinnedWindowButton.disabled = false;
      elements.pinnedWindowButton.removeAttribute("aria-busy");
    });
  pinnedPanelOpenTask = openTask;
  return openTask;
}

async function loadPinnedMessages({ allowHidden = false, renderLoading = true, throwOnError = false } = {}) {
  if (!state.current || (!allowHidden && elements.pinnedPanel.hidden)) return false;
  const conversation = state.current;
  const isRelevant = () => sameID(state.current?.id, conversation.id)
    && (allowHidden || !elements.pinnedPanel.hidden);
  elements.pinnedMessages.setAttribute("aria-busy", "true");
  if (renderLoading) {
    const loading = document.createElement("p");
    loading.className = "pinned-message-empty";
    loading.textContent = t("Chargement…");
    elements.pinnedMessages.replaceChildren(loading);
  }
  try {
    const messages = await api(`/api/conversations/${conversation.id}/pinned-messages`);
    if (!isRelevant()) return false;
    if (!messages.length) {
      const empty = document.createElement("p");
      empty.className = "pinned-message-empty";
      empty.textContent = t("Vous n’avez épinglé aucun message dans cette conversation.");
      elements.pinnedMessages.replaceChildren(empty);
      return true;
    }
    const decrypted = await Promise.all(messages.map(async (message) => ({
      message: messageWithCurrentUserProfile(message),
      clear: await decryptMessageContent(message, await getMessageKey(message, conversation)),
    })));
    if (!isRelevant()) return false;
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
    return true;
  } catch (error) {
    if (!isRelevant()) return false;
    if (throwOnError) throw error;
    const failure = document.createElement("p");
    failure.className = "pinned-message-empty";
    failure.textContent = frenchErrorMessage(error, "Impossible de charger les messages épinglés.");
    elements.pinnedMessages.replaceChildren(failure);
    return false;
  } finally {
    if (isRelevant()) elements.pinnedMessages.removeAttribute("aria-busy");
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
    if (message.file) rememberGlobalFileClear(message, clear);
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
      reportMessage,
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

function globalFilesPageURL(before = null) {
  const parameters = new URLSearchParams({ limit: String(GLOBAL_FILES_PAGE_SIZE) });
  if (before != null) parameters.set("before", String(before));
  return `/api/files?${parameters}`;
}

function globalFileEntries(messages) {
  return messages.map((message) => {
    const conversation = state.conversations.find((item) => sameID(item.id, message.conversation_id));
    return conversation ? { message, conversation } : null;
  }).filter(Boolean);
}

function rememberGlobalFilesFirstPage(messages, generation) {
  if (generation !== state.globalFilesGeneration) return false;
  state.globalFileMessages = messages;
  state.globalFilesLoaded = true;
  state.globalFilesHasMore = messages.length === GLOBAL_FILES_PAGE_SIZE;
  state.globalFilesNextBefore = messages.at(-1)?.id ?? null;
  return true;
}

function rememberNextGlobalFilesPage(messages, generation) {
  if (generation !== state.globalFilesGeneration) return false;
  const byID = new Map(state.globalFileMessages.map((message) => [String(message.id), message]));
  for (const message of messages) byID.set(String(message.id), message);
  state.globalFileMessages = [...byID.values()].sort((left, right) => Number(right.id) - Number(left.id));
  state.globalFilesHasMore = messages.length === GLOBAL_FILES_PAGE_SIZE;
  state.globalFilesNextBefore = messages.at(-1)?.id ?? null;
  return true;
}

function invalidateGlobalFilesIndex() {
  state.globalFilesGeneration += 1;
  state.globalFileMessages = [];
  state.globalFilesLoaded = false;
  state.globalFilesHasMore = true;
  state.globalFilesNextBefore = null;
  state.globalFilesFirstPageLoad = null;
  state.globalFilesNextPageLoad = null;
  state.globalFileClearLoads.clear();
  elements.globalFilesList?.removeAttribute("aria-busy");
}

function loadGlobalFilesFirstPage() {
  if (state.globalFilesLoaded) return Promise.resolve(state.globalFileMessages);
  if (state.globalFilesFirstPageLoad) return state.globalFilesFirstPageLoad;
  const generation = state.globalFilesGeneration;
  const pending = api(globalFilesPageURL()).then((messages) => {
    if (!rememberGlobalFilesFirstPage(messages, generation)) return null;
    return messages;
  }).finally(() => {
    if (state.globalFilesFirstPageLoad === pending) state.globalFilesFirstPageLoad = null;
  });
  state.globalFilesFirstPageLoad = pending;
  return pending;
}

async function prewarmGlobalFileEntries(entries, generation) {
  const displayTasks = new Map();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(GLOBAL_FILES_BACKGROUND_CONCURRENCY, entries.length) }, async () => {
    while (nextIndex < entries.length && generation === state.globalFilesGeneration) {
      const index = nextIndex++;
      await prepareGlobalFileItem(entries[index], displayTasks);
    }
  });
  await Promise.all(workers);
}

async function preloadGlobalFiles() {
  const generation = state.globalFilesGeneration;
  const messages = await loadGlobalFilesFirstPage();
  if (!messages || generation !== state.globalFilesGeneration) return;
  await prewarmGlobalFileEntries(globalFileEntries(messages), generation);
}

function scheduleGlobalFilesPreload() {
  if (globalFilesPreloadScheduled || state.globalFilesLoaded) return;
  globalFilesPreloadScheduled = true;
  const run = () => {
    globalFilesPreloadScheduled = false;
    preloadGlobalFiles().catch((error) => console.warn("Préchargement du Dossier impossible", error));
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 2500 });
  } else {
    window.setTimeout(run, 0);
  }
}

async function renderGlobalFileMessages(messages, loadVersion, { append = false } = {}) {
  const entries = globalFileEntries(messages);
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const placeholders = renderGlobalFilePlaceholders(entries, dateFormatter, { append });
  await decryptGlobalFilesProgressively(entries, placeholders, dateFormatter, loadVersion);
}

async function openGlobalFiles() {
  const loadVersion = ++globalFilesLoadVersion;
  elements.globalFilesStatus.textContent = t("Chargement des fichiers…");
  if (!elements.globalFilesDialog.open) {
    elements.globalFilesDialog.showModal();
    document.querySelector("#global-files-close").focus({ preventScroll: true });
  }
  try {
    const messages = state.globalFilesLoaded ? state.globalFileMessages : await loadGlobalFilesFirstPage();
    if (!messages || loadVersion !== globalFilesLoadVersion) return;
    await renderGlobalFileMessages(messages, loadVersion);
    if (loadVersion !== globalFilesLoadVersion) return;
    await fillGlobalFilesViewport(loadVersion);
  } catch (error) {
    if (loadVersion !== globalFilesLoadVersion) return;
    elements.globalFilesStatus.textContent = frenchErrorMessage(error, "Impossible de charger les fichiers.");
  }
}

function globalFileMessagesMatch(left, right) {
  return sameID(left?.id, right?.id)
    && sameID(left?.conversation_id, right?.conversation_id)
    && sameID(left?.sender_id, right?.sender_id)
    && Number(left?.key_epoch || 1) === Number(right?.key_epoch || 1)
    && Number(left?.revision || 1) === Number(right?.revision || 1)
    && Number(left?.signature_version || 0) === Number(right?.signature_version || 0)
    && String(left?.signature || "") === String(right?.signature || "")
    && String(left?.signing_key_id || "") === String(right?.signing_key_id || "")
    && String(left?.signature_conversation_id || "") === String(right?.signature_conversation_id || "")
    && String(left?.signature_sender_id || "") === String(right?.signature_sender_id || "")
    && String(left?.signature_reply_to || "") === String(right?.signature_reply_to || "")
    && String(left?.message_kind || "") === String(right?.message_kind || "")
    && String(left?.file?.encrypted_name || "") === String(right?.file?.encrypted_name || "")
    && String(left?.file?.encrypted_mime || "") === String(right?.file?.encrypted_mime || "")
    && String(left?.file?.iv || "") === String(right?.file?.iv || "")
    && Number(left?.file?.size || 0) === Number(right?.file?.size || 0);
}

function forgetGlobalFileClearByMessageID(messageID) {
  for (const [fileID, cached] of state.globalFileClears) {
    if (sameID(cached.message?.id, messageID)) state.globalFileClears.delete(fileID);
  }
}

function validGlobalFileClear(clear) {
  return clear && typeof clear.name === "string" && typeof clear.mime === "string";
}

function rememberGlobalFileClear(message, clear) {
  if (!message?.file || !validGlobalFileClear(clear)) return;
  state.globalFileClears.set(String(message.file.id), { message, clear });
}

function cachedGlobalFileClear(message) {
  const cached = state.globalFileClears.get(String(message.file.id));
  if (cached && globalFileMessagesMatch(cached.message, message)) return cached.clear;
  const rendered = state.messageClears.get(message.conversation_id)?.get(message.id);
  if (validGlobalFileClear(rendered?.clear) && Number(rendered.keyEpoch || 1) === Number(message.key_epoch || 1)) {
    rememberGlobalFileClear(message, rendered.clear);
    return rendered.clear;
  }
  const prepared = state.preloadedMessages.get(conversationPreloadKey(message.conversation_id));
  const preparedEntry = prepared?.decrypted?.find(({ message: cachedMessage }) => globalFileMessagesMatch(cachedMessage, message));
  if (!validGlobalFileClear(preparedEntry?.clear)) return null;
  rememberGlobalFileClear(message, preparedEntry.clear);
  return preparedEntry.clear;
}

function globalFileFallbackItem(message, conversation, clear = null) {
  return {
    message,
    clear: clear || { name: t("Fichier impossible à déchiffrer"), mime: "application/octet-stream" },
    conversation,
    conversationTitle: t("Conversation"),
    conversationAvatar: null,
    conversationInitial: conversation.is_personal ? "N" : conversation.type === "group" ? "G" : "@",
  };
}

async function globalFileConversationDisplay(conversation, displayTasks) {
  const key = String(conversation.id);
  const remembered = state.conversationDisplays.get(key);
  if (remembered) return remembered;
  if (!displayTasks.has(key)) {
    displayTasks.set(key, resolveConversationDisplay(conversation).then((display) => {
      state.conversationDisplays.set(key, display);
      return display;
    }));
  }
  return displayTasks.get(key);
}

async function prepareGlobalFileItem({ message, conversation }, displayTasks) {
  let clear = cachedGlobalFileClear(message);
  if (!clear) {
    const fileID = String(message.file.id);
    const generation = state.globalFilesGeneration;
    let pending = state.globalFileClearLoads.get(fileID);
    if (!pending) {
      pending = (async () => {
        try {
          const key = await getMessageKey(message, conversation);
          const decrypted = await decryptMessageContent(message, key);
          if (generation === state.globalFilesGeneration) rememberGlobalFileClear(message, decrypted);
          return decrypted;
        } catch {
          return null;
        }
      })().finally(() => {
        if (state.globalFileClearLoads.get(fileID) === pending) state.globalFileClearLoads.delete(fileID);
      });
      state.globalFileClearLoads.set(fileID, pending);
    }
    clear = await pending;
  }
  let display;
  try {
    display = await globalFileConversationDisplay(conversation, displayTasks);
  } catch {
    return globalFileFallbackItem(message, conversation, clear);
  }
  return {
    message,
    clear: clear || { name: t("Fichier impossible à déchiffrer"), mime: "application/octet-stream" },
    conversation,
    conversationTitle: display.title,
    conversationAvatar: display.avatar || null,
    conversationInitial: display.title.slice(0, 1).toUpperCase(),
  };
}

function globalFileStatus(count, hasMore = false) {
  if (count && hasMore) {
    return t(count === 1
      ? "{count} fichier chargé. Faites défiler pour afficher la suite."
      : "{count} fichiers chargés. Faites défiler pour afficher la suite.", { count });
  }
  return count
    ? t(count === 1 ? "{count} fichier dans vos discussions." : "{count} fichiers dans vos discussions.", { count })
    : t("Aucun fichier dans vos discussions.");
}

function globalFileMetaText(message, dateFormatter) {
  const shareCount = Number(message.file.active_share_count || 0);
  const shared = shareCount > 0
    ? ` · ${t(shareCount === 1 ? "Partagé ({count} lien)" : "Partagé ({count} liens)", { count: shareCount })}`
    : "";
  return `${formatFileSize(message.file.size)} · ${dateFormatter.format(new Date(message.created_at))}${shared}`;
}

function updateCachedGlobalFileShareCount(fileID, count) {
  const normalized = Math.max(0, Number(count) || 0);
  for (const message of state.globalFileMessages) {
    if (sameID(message.file?.id, fileID)) message.file.active_share_count = normalized;
  }
  const pendingMessage = state.pendingFileShare?.message;
  if (sameID(pendingMessage?.file?.id, fileID)) pendingMessage.file.active_share_count = normalized;
}

function createGlobalFilePlaceholder({ message, conversation }, dateFormatter) {
  const clear = cachedGlobalFileClear(message);
  const display = state.conversationDisplays.get(String(conversation.id));
  const row = document.createElement("div");
  row.className = "global-file-row global-file-loading";
  row.setAttribute("aria-busy", "true");
  const open = document.createElement("div");
  open.className = "global-file-open";
  const kind = document.createElement("span");
  kind.className = "global-file-kind";
  kind.append(materialFileIcon(fileKindIcon(clear?.mime || "")));
  const content = document.createElement("span");
  content.className = "global-file-content";
  const name = document.createElement("strong");
  name.textContent = clear?.name || t("Chargement…");
  const meta = document.createElement("span");
  meta.className = "global-file-meta";
  meta.textContent = globalFileMetaText(message, dateFormatter);
  const source = document.createElement("span");
  source.className = "global-file-conversation";
  const title = document.createElement("span");
  title.className = "global-file-conversation-title";
  title.textContent = display?.title || t("Conversation");
  source.append(title);
  content.append(name, meta, source);
  open.append(kind, content);
  row.append(open);
  return { row, name };
}

function renderGlobalFilePlaceholders(entries, dateFormatter, { append = false } = {}) {
  if (!append) elements.globalFilesList.replaceChildren();
  elements.globalFilesStatus.textContent = globalFileStatus(state.globalFileMessages.length, state.globalFilesHasMore);
  if (!entries.length) {
    if (!append && !state.globalFileMessages.length) renderGlobalFiles([]);
    return [];
  }
  return entries.map((entry) => {
    const placeholder = createGlobalFilePlaceholder(entry, dateFormatter);
    elements.globalFilesList.append(placeholder.row);
    return placeholder;
  });
}

async function decryptGlobalFilesProgressively(entries, placeholders, dateFormatter, loadVersion) {
  const displayTasks = new Map();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const item = await prepareGlobalFileItem(entries[index], displayTasks);
      if (loadVersion !== globalFilesLoadVersion) return;
      placeholders[index].row.replaceWith(createGlobalFileRow(item, dateFormatter));
    }
  });
  await Promise.all(workers);
}

function loadNextGlobalFilesPage(loadVersion = globalFilesLoadVersion) {
  if (!state.globalFilesLoaded || !state.globalFilesHasMore || state.globalFilesNextBefore == null) return Promise.resolve(null);
  if (state.globalFilesNextPageLoad) return state.globalFilesNextPageLoad;
  const generation = state.globalFilesGeneration;
  const before = state.globalFilesNextBefore;
  const pending = (async () => {
    elements.globalFilesList.setAttribute("aria-busy", "true");
    const messages = await api(globalFilesPageURL(before));
    if (!rememberNextGlobalFilesPage(messages, generation)) return null;
    if (!elements.globalFilesDialog.open || loadVersion !== globalFilesLoadVersion) return messages;
    await renderGlobalFileMessages(messages, loadVersion, { append: true });
    return messages;
  })().catch((error) => {
    if (elements.globalFilesDialog.open && loadVersion === globalFilesLoadVersion) {
      elements.globalFilesStatus.textContent = frenchErrorMessage(error, "Impossible de charger les fichiers.");
    }
    throw error;
  }).finally(() => {
    if (state.globalFilesNextPageLoad === pending) {
      state.globalFilesNextPageLoad = null;
      elements.globalFilesList.removeAttribute("aria-busy");
    }
  });
  state.globalFilesNextPageLoad = pending;
  return pending;
}

async function fillGlobalFilesViewport(loadVersion = globalFilesLoadVersion) {
  while (elements.globalFilesDialog.open && loadVersion === globalFilesLoadVersion && state.globalFilesHasMore) {
    const remaining = elements.globalFilesList.scrollHeight - elements.globalFilesList.scrollTop - elements.globalFilesList.clientHeight;
    if (remaining > GLOBAL_FILES_SCROLL_THRESHOLD_PX) return;
    const before = state.globalFilesNextBefore;
    await loadNextGlobalFilesPage(loadVersion);
    if (before === state.globalFilesNextBefore) return;
  }
}

function handleGlobalFilesScroll() {
  if (!elements.globalFilesDialog.open) return;
  const remaining = elements.globalFilesList.scrollHeight - elements.globalFilesList.scrollTop - elements.globalFilesList.clientHeight;
  if (remaining > GLOBAL_FILES_SCROLL_THRESHOLD_PX) return;
  const loadVersion = globalFilesLoadVersion;
  loadNextGlobalFilesPage(loadVersion)
    .then(() => fillGlobalFilesViewport(loadVersion))
    .catch(() => {});
}

function renderGlobalFiles(items) {
  elements.globalFilesList.replaceChildren();
  elements.globalFilesStatus.textContent = globalFileStatus(items.length, false);
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "global-files-empty";
    empty.textContent = t("Les pièces jointes envoyées dans vos discussions apparaîtront ici.");
    elements.globalFilesList.append(empty);
    return;
  }
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  for (const item of items) {
    elements.globalFilesList.append(createGlobalFileRow(item, dateFormatter));
  }
}

function createGlobalFileRow(item, dateFormatter) {
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
    meta.textContent = globalFileMetaText(item.message, dateFormatter);
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
    openFileShareDialog(item.message, item.clear, item.conversation, share);
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
        updateCachedGlobalFileShareCount(item.message.file.id, 0);
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
  return row;
}

async function openGlobalFile(item) {
  elements.globalFilesDialog.close();
  await selectConversation(item.conversation, item.message.id);
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
  if (elements.calendarDialog.open) return;
  if (calendarOpenTask) return calendarOpenTask;

  elements.calendarButton.disabled = true;
  elements.calendarButton.setAttribute("aria-busy", "true");
  calendarOpenTask = (async () => {
    const items = await loadCalendarItems();
    state.calendarItems = items;
    showCurrentCalendarMonth();
    if (!elements.calendarDialog.open) elements.calendarDialog.showModal();
  })()
    .catch((error) => {
      toast(frenchErrorMessage(error, "Impossible de charger le calendrier."), "error");
    })
    .finally(() => {
      elements.calendarButton.disabled = false;
      elements.calendarButton.removeAttribute("aria-busy");
      calendarOpenTask = null;
    });
  return calendarOpenTask;
}

async function openCarnet() {
  const loadVersion = ++carnetLoadVersion;
  const hadCachedCarnet = state.carnetLoaded;
  if (hadCachedCarnet) renderCarnet();
  else {
    elements.carnetStatus.textContent = t("Chargement du carnet…");
    elements.carnetList.replaceChildren();
  }
  if (!elements.carnetDialog.open) elements.carnetDialog.showModal();
  elements.carnetList.setAttribute("aria-busy", "true");
  try {
    const entries = await api("/api/carnet");
    if (loadVersion !== carnetLoadVersion) return;
    state.carnet = entries;
    state.carnetLoaded = true;
    renderCarnet();
  } catch (error) {
    if (loadVersion !== carnetLoadVersion) return;
    if (!hadCachedCarnet) renderCarnet(false);
    elements.carnetStatus.textContent = frenchErrorMessage(error, "Impossible de charger le carnet.");
  } finally {
    if (loadVersion === carnetLoadVersion) elements.carnetList.removeAttribute("aria-busy");
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
    carnetLoadVersion += 1;
    elements.carnetList.removeAttribute("aria-busy");
    state.carnet = state.carnet.filter((item) => !sameID(item.id, entry.id));
    state.carnetLoaded = true;
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
    carnetLoadVersion += 1;
    elements.carnetList.removeAttribute("aria-busy");
    state.carnet = state.carnet.filter((entry) => entry.active);
    state.carnetLoaded = true;
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
const FILE_PREVIEW_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

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
    // Previewing very large sources makes browsers keep additional decoded
    // copies in memory. The preview is optional; the encrypted file is not.
    if (data.byteLength > FILE_PREVIEW_SOURCE_MAX_BYTES) return null;
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

async function encryptFileBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { iv: bytesToBase64(iv), data };
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
      encryptFileBytes(key, data),
      encryptEnvelope(key, file.name),
      encryptEnvelope(key, file.type || "application/octet-stream"),
      encryptedFilePreview(file, data, key),
    ]);
    const body = {
      conversation_id: conversation.id,
      encrypted_name: encryptedName,
      encrypted_mime: encryptedMIME,
      iv: encrypted.iv,
      encrypted_preview_data: preview?.data || "",
      preview_iv: preview?.iv || "",
      expires_in_seconds: expiresInSeconds,
      key_epoch: conversationKeyEpoch(conversation),
      ciphertext_sha256: await sha256Hex(encrypted.data),
      preview_sha256: preview?.data ? await sha256Hex(base64ToBytes(preview.data)) : "",
    };
    Object.assign(body, await messageSignature("file", conversation.id, body));
    const upload = new FormData();
    upload.append("metadata", JSON.stringify(body));
    upload.append("encrypted_data", new Blob([encrypted.data], { type: "application/octet-stream" }), "encrypted.bin");
    const message = await api("/api/files", {
      method: "POST",
      body: upload,
    });
    rememberGlobalFileClear(message, {
      name: file.name,
      mime: file.type || "application/octet-stream",
      fileID: message.file.id,
      size: message.file.size,
      hasPreview: message.file.has_preview === true,
      previewSize: message.file.preview_size || 0,
    });
    invalidateGlobalFilesIndex();
    scheduleGlobalFilesPreload();
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

async function openFileShareDialog(message, clear, conversation = state.current, trigger = null) {
  if (!message?.file?.id || !conversation || elements.fileShareDialog.open) return;
  if (
    fileShareOpenTask
    && sameID(state.pendingFileShare?.message?.file?.id, message.file.id)
    && sameID(state.pendingFileShare?.conversation?.id, conversation.id)
  ) return fileShareOpenTask;

  const openVersion = ++fileShareOpenVersion;
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
  if (trigger) {
    trigger.disabled = true;
    trigger.setAttribute("aria-busy", "true");
  }

  const isRelevant = () => openVersion === fileShareOpenVersion
    && sameID(state.pendingFileShare?.message?.file?.id, message.file.id)
    && sameID(state.pendingFileShare?.conversation?.id, conversation.id);
  let openTask;
  openTask = loadExistingFileShares(message, conversation, { isRelevant, throwOnError: true })
    .then((loaded) => {
      if (!loaded || !isRelevant()) return;
      elements.fileShareDialog.showModal();
    })
    .catch((error) => {
      if (!isRelevant()) return;
      state.pendingFileShare = null;
      toast(frenchErrorMessage(error, "Impossible de charger les liens de partage."), "error");
    })
    .finally(() => {
      if (trigger) {
        trigger.disabled = false;
        trigger.removeAttribute("aria-busy");
      }
      if (fileShareOpenTask === openTask) fileShareOpenTask = null;
    });
  fileShareOpenTask = openTask;
  return openTask;
}

async function loadExistingFileShares(
  message,
  conversation = state.current,
  { isRelevant = () => true, throwOnError = false } = {},
) {
  const fileID = message?.file?.id;
  if (!fileID || !conversation) return false;
  try {
    const shares = await api(`/api/files/${fileID}/shares`);
    if (!isRelevant()) return false;
    const active = shares.filter((share) => share.active);
    let conversationKey = null;
    if (active.some((share) => share.encrypted_link)) {
      try {
        conversationKey = await getMessageKey(message, conversation);
      } catch {}
    }
    if (!isRelevant()) return false;
    const fragment = document.createDocumentFragment();
    for (const share of active) {
      const row = document.createElement("div");
      row.className = "file-share-existing-row";
      const details = document.createElement("span");
      const label = document.createElement("strong");
      label.textContent = t("Valable jusqu’au {date}", { date: new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(share.expires_at)) });
      const downloads = document.createElement("small");
      downloads.textContent = `${share.download_count} téléchargement${share.download_count === 1 ? "" : "s"}`;
      details.append(label, downloads);
      const actions = document.createElement("div");
      actions.className = "file-share-existing-actions";
      if (conversationKey && share.encrypted_link) {
        try {
          const link = await decryptEnvelope(conversationKey, share.encrypted_link);
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "outline";
          copy.textContent = t("Copier le lien");
          copy.addEventListener("click", async () => {
            if (await copyTextToClipboard(link)) toast("Lien copié.", "success");
            else toast("Impossible de copier le lien.", "error");
          });
          actions.append(copy);
        } catch {}
      }
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
          updateCachedGlobalFileShareCount(fileID, elements.fileShareExistingList.children.length);
          toast("Lien de partage désactivé.", "success");
        } catch (error) {
          setBusy(revoke, false);
          elements.fileShareError.textContent = frenchErrorMessage(error, "Impossible de désactiver le lien.");
        }
      });
      actions.append(revoke);
      row.append(details, actions);
      fragment.append(row);
    }
    if (!isRelevant()) return false;
    updateCachedGlobalFileShareCount(fileID, active.length);
    elements.fileShareExistingList.replaceChildren(fragment);
    elements.fileShareExisting.hidden = active.length === 0;
    return true;
  } catch (error) {
    if (isRelevant()) {
      elements.fileShareExistingList.replaceChildren();
      elements.fileShareExisting.hidden = true;
    }
    if (throwOnError) throw error;
    return false;
  }
}

function closeFileShareDialog() {
  fileShareOpenVersion += 1;
  if (elements.fileShareDialog.open) elements.fileShareDialog.close();
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
    const shareToken = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const [encrypted, encryptedName, encryptedMIME, exportedKey] = await Promise.all([
      encryptFileBytes(shareKey, file.data),
      encryptEnvelope(shareKey, file.name),
      encryptEnvelope(shareKey, file.mime || "application/octet-stream"),
      exportShareKey(shareKey),
    ]);
    const publicURL = new URL("/share.html", `${getInstanceURL() || location.origin}/`);
    publicURL.searchParams.set("token", shareToken);
    publicURL.hash = new URLSearchParams({ key: exportedKey }).toString();
    const encryptedLink = await encryptEnvelope(conversationKey, publicURL.toString());
    const metadata = {
      token: shareToken,
      encrypted_link: encryptedLink,
      encrypted_name: encryptedName,
      encrypted_mime: encryptedMIME,
      iv: encrypted.iv,
      size: file.data.byteLength,
      expires_in_seconds: Number(elements.fileShareExpiration.value),
    };
    const upload = new FormData();
    upload.append("metadata", JSON.stringify(metadata));
    upload.append("encrypted_data", new Blob([encrypted.data], { type: "application/octet-stream" }), "encrypted.bin");
    let share;
    try {
      share = await api(`/api/files/${message.file.id}/shares`, {
        method: "POST",
        body: upload,
      });
    } catch (creationError) {
      // If a proxy loses the small JSON response after the database commit,
      // the client-generated token still lets us recover the usable link.
      try {
        const recovered = await api(`/api/file-shares/${shareToken}`);
        share = { ...recovered, token: shareToken };
      } catch {
        throw creationError;
      }
    }
    elements.fileShareURL.value = publicURL.toString();
    elements.fileShareValidity.textContent = t("Valable jusqu’au {date}.", { date: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(share.expires_at)) });
    elements.fileShareResult.hidden = false;
    elements.fileShareCreateActions.hidden = true;
    elements.fileShareExpiration.disabled = true;
    state.activeFileShareID = share.id;
    loadExistingFileShares(message, conversation);
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
  if (!await copyTextToClipboard(link, elements.fileShareURL)) {
    toast("Sélectionnez puis copiez le lien manuellement.", "error");
    return;
  }
  toast("Lien copié.", "success");
}

async function copyTextToClipboard(text, fallbackInput = null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const target = fallbackInput || document.createElement("textarea");
    if (!fallbackInput) {
      target.value = text;
      target.readOnly = true;
      target.style.position = "fixed";
      target.style.opacity = "0";
      document.body.append(target);
    }
    target.focus();
    target.select();
    const copied = document.execCommand("copy");
    if (!fallbackInput) target.remove();
    return copied;
  }
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
    if (state.pendingFileShare?.message?.file?.id) {
      const fileID = state.pendingFileShare.message.file.id;
      updateCachedGlobalFileShareCount(fileID, Number(state.pendingFileShare.message.file.active_share_count || 1) - 1);
      loadExistingFileShares(state.pendingFileShare.message, state.pendingFileShare.conversation);
    }
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
      const deletedFileSize = Math.max(0, Number(message.file.size) || 0);
      if (state.fileQuotas && deletedFileSize > 0) {
        const usedStorage = Math.max(0, Number(state.fileQuotas.used_storage) || 0);
        state.fileQuotas.used_storage = Math.max(0, usedStorage - deletedFileSize);
        updateProfileStorage();
      }
      const cached = state.files.get(message.file.id);
      if (cached) URL.revokeObjectURL(cached.url);
      const thumbnail = state.fileThumbnails.get(message.file.id);
      if (thumbnail) revokeFileThumbnail(thumbnail);
      state.files.delete(message.file.id);
      state.fileLoads.delete(message.file.id);
      state.fileThumbnails.delete(message.file.id);
      state.fileThumbnailLoads.delete(message.file.id);
      state.globalFileClears.delete(String(message.file.id));
      invalidateGlobalFilesIndex();
      scheduleGlobalFilesPreload();
      await refreshFileQuotas();
    }
    clearMessageExpiration(message);
    state.messageClears.get(message.conversation_id)?.delete(message.id);
    row.remove();
    if (!elements.messages.querySelector(".message")) {
      const empty = document.createElement("div");
      empty.id = "empty-chat";
      empty.textContent = t("Aucun message. Écrivez le premier message chiffré.");
      elements.messages.querySelector(".conversation-exchange-state")?.remove();
      elements.messages.append(createConversationExchangeState(state.current, empty));
    }
    toast("Message supprimé.", "success");
    await refreshAll();
  } catch (error) {
    row.classList.remove("message-deleting");
    row.dispatchEvent(new Event("swipe-close"));
    toast(frenchErrorMessage(error, "Impossible de supprimer le message."), "error");
  }
}

function chooseMessageReportReason() {
  const dialog = document.querySelector("#message-report-dialog");
  const form = document.querySelector("#message-report-form");
  const cancelButton = document.querySelector("#message-report-cancel");
  form.reset();
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (reason) => {
      form.removeEventListener("submit", submit);
      cancelButton.removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open) dialog.close();
      resolve(reason);
    };
    const submit = (event) => {
      event.preventDefault();
      finish(String(new FormData(form).get("reason") || ""));
    };
    const cancel = (event) => {
      event?.preventDefault();
      finish("");
    };
    form.addEventListener("submit", submit);
    cancelButton.addEventListener("click", cancel);
    dialog.addEventListener("cancel", cancel);
  });
}

function updateMessageReportButton(message, button) {
  if (!button) return;
  button.classList.toggle("is-reported", message.is_reported === true);
  button.textContent = message.is_reported ? "⚑" : "⚐";
  button.title = t(message.is_reported ? "Retirer le signalement" : "Signaler le message");
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(message.is_reported === true));
}

function storeMessageReportState(message, reported, button) {
  message.is_reported = reported;
  updateMessageReportButton(message, button);
  invalidateConversationPreload(message.conversation_id);
  const cachedMessage = { ...message };
  delete cachedMessage.reply_preview;
  delete cachedMessage.signature_valid;
  state.cache?.putMessages([cachedMessage]);
}

async function reportMessage(message, button) {
  if (message.is_reported) {
    if (!confirm(t("Retirer votre signalement pour ce message ?"))) return;
    if (button) button.disabled = true;
    try {
      await api(`/api/messages/${message.id}/report`, { method: "DELETE" });
      storeMessageReportState(message, false, button);
      toast("Signalement retiré.", "success");
    } catch (error) {
      if (error.status === 404) {
        storeMessageReportState(message, false, button);
        toast("Signalement retiré.", "success");
        return;
      }
      toast(frenchErrorMessage(error, "Impossible de retirer le signalement."), "error");
    } finally {
      if (button) button.disabled = false;
    }
    return;
  }
  const reason = await chooseMessageReportReason();
  if (!reason) return;
  if (button) button.disabled = true;
  try {
    await api(`/api/messages/${message.id}/report`, {
      method: "POST",
      body: { reason },
    });
    storeMessageReportState(message, true, button);
    toast("Signalement envoyé à la modération.", "success");
  } catch (error) {
    toast(frenchErrorMessage(error, "Impossible d’envoyer le signalement."), "error");
  } finally {
    if (button) button.disabled = false;
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

function safeFullFilePreviewSource(message, container) {
  const file = {
    name: container.dataset.fileName || "",
    mime: normalizedFileMIME(container.dataset.fileMime, container.dataset.fileName),
  };
  const size = Number(message.file?.size) || 0;
  return supportsFullFilePreview(file) && size > 0 && size <= FILE_PREVIEW_SOURCE_MAX_BYTES;
}

function renderUnavailableFilePreview(container) {
  container.classList.add("file-preview-empty");
  const unavailable = document.createElement("div");
  unavailable.className = "file-preview-unavailable";
  const icon = document.createElement("span");
  icon.className = "file-preview-unavailable-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.append(materialFileIcon("file"));
  const copy = document.createElement("span");
  copy.className = "file-preview-unavailable-copy";
  const label = document.createElement("strong");
  label.textContent = t("Aperçu non disponible pour ce format");
  const hint = document.createElement("small");
  hint.textContent = t("Le fichier reste disponible au téléchargement.");
  copy.append(label, hint);
  unavailable.append(icon, copy);
  container.replaceChildren(unavailable);
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
    // Do not fetch and decrypt an entire archive (or another very large file)
    // merely to discover that the browser cannot preview it. The explicit
    // download action remains available on the attachment.
    if (!safeFullFilePreviewSource(message, container)) {
      renderUnavailableFilePreview(container);
      return;
    }
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
    renderUnavailableFilePreview(container);
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
    if (!safeFullFilePreviewSource(message, container)) {
      renderUnavailableReplyPreview(container);
      return;
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
  const input = event.target;
  const query = input.value.trim();
  const searchVersion = ++contactSearchVersion;
  const directoryRole = contactDirectoryRole(query);
  const results = document.querySelector("#contact-results");
  results.replaceChildren();
  if (query.length < 2) return;
  try {
    const federated = !directoryRole && state.edition.federation && query.includes("@") && !isPrivateDiscoveryCode(query);
    const users = federated
      ? await api(`/api/federation/search?q=${encodeURIComponent(query)}`)
      : await searchInstanceUsers(query, directoryRole);
    if (searchVersion !== contactSearchVersion || input.value.trim() !== query) return;
    const acceptedContact = (user) => state.contacts.some((contact) => (
      contact.status === "accepted" && sameID(contact.contact_user_id, user.id)
    ));
    const availableUsers = directoryRole ? users : users.filter((user) => !acceptedContact(user));
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
      const isSelf = sameID(user.id, state.me.id);
      const isExistingContact = acceptedContact(user);
      row.classList.toggle("is-self", isSelf);
      row.disabled = isSelf;
      const description = user.description
        ? `<small class="contact-description">${escapeText(user.description)}</small>`
        : "";
      const identity = user.federated
        ? `@${escapeText(user.username)} · ${escapeText(new URL(user.instance_url).host)}`
        : `@${escapeText(user.username)}`;
      const roleBadge = directoryRole
        ? `<small class="contact-role-badge">${escapeText(t(directoryRole === "administrator" ? "Administrateur" : "Gestionnaire"))}</small>`
        : "";
      const actionLabel = isSelf ? t("Vous") : isExistingContact ? t("Ouvrir") : t("Ajouter");
      row.innerHTML = `<span><strong>${escapeText(user.display_name)}</strong>${description}<small>${identity}</small>${roleBadge}</span><span>${escapeText(actionLabel)}</span>`;
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
              await api("/api/contacts", {
                method: "POST",
                body: {
                  user_id: user.id,
                  discovery_code: isPrivateDiscoveryCode(query) ? query : "",
                },
              });
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
    if (searchVersion !== contactSearchVersion) return;
    toast(frenchErrorMessage(error), "error");
  }
}

function renderSelectedGroupMembers(list, members, { countElement = null, onRemove = null } = {}) {
  const seen = new Set();
  const normalizedMembers = members
    .map((member) => ({
      member,
      userID: Number(member.user_id ?? member.contact_user_id ?? member.id),
      displayName: member.display_name || member.username || t("Non renseigné"),
      username: String(member.username || "").replace(/^@+/, ""),
    }))
    .filter(({ userID }) => {
      if (!userID || seen.has(userID)) return false;
      seen.add(userID);
      return true;
    });
  const currentUser = normalizedMembers.find(({ userID }) => sameID(userID, state.me.id));
  const otherMembers = normalizedMembers
    .filter(({ userID }) => !sameID(userID, state.me.id))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, locale, { sensitivity: "base" }));
  const displayedMembers = [currentUser, ...otherMembers].filter(Boolean);
  if (countElement) countElement.textContent = String(displayedMembers.length);
  list.replaceChildren();

  for (const { member, userID, displayName, username } of displayedMembers) {
    const isCurrentUser = sameID(userID, state.me.id);
    const item = document.createElement("li");
    item.className = "conversation-info-member";

    const avatar = document.createElement("span");
    avatar.className = "conversation-info-member-avatar";
    avatar.setAttribute("aria-hidden", "true");
    replaceAvatarContent(avatar, member.avatar, displayName.slice(0, 1).toUpperCase());

    const identity = document.createElement("span");
    identity.className = "conversation-info-member-identity";
    const name = document.createElement("strong");
    name.textContent = displayName;
    const usernameElement = document.createElement("small");
    usernameElement.textContent = username ? `@${username}` : t("Non renseigné");
    identity.append(name, usernameElement);

    const statusOrAction = document.createElement(isCurrentUser ? "span" : "label");
    statusOrAction.className = isCurrentUser
      ? "conversation-info-member-statuses"
      : "conversation-info-member-statuses group-member-check";
    if (isCurrentUser) {
      const status = document.createElement("small");
      status.className = "conversation-info-member-status";
      status.textContent = t("Vous");
      statusOrAction.append(status);
    } else {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = String(userID);
      checkbox.checked = true;
      checkbox.setAttribute("aria-label", t("Retirer {name} du groupe", { name: displayName }));
      checkbox.addEventListener("change", () => {
        if (!checkbox.checked) onRemove?.(userID);
      });
      statusOrAction.append(checkbox);
    }

    item.append(avatar, identity, statusOrAction);
    list.append(item);
  }
}

function selectedNewGroupMemberIDs() {
  return new Set(
    [...document.querySelectorAll("#group-members input:checked")]
      .map((input) => Number(input.value))
      .filter(Boolean),
  );
}

function renderNewGroupMembers() {
  const list = document.querySelector("#group-members");
  const count = document.querySelector("#group-members-count");
  renderSelectedGroupMembers(list, [state.me, ...groupInvitedUsers.values()], {
    countElement: count,
    onRemove: (userID) => {
      groupInvitedUsers.delete(userID);
      renderNewGroupMembers();
    },
  });
}

async function searchNewGroupMembers(event) {
  const input = event.target;
  const query = input.value.trim();
  const directoryRole = contactDirectoryRole(query);
  const results = document.querySelector("#group-user-results");
  results.replaceChildren();
  if (query.length < 2) return;
  try {
    const users = await searchInstanceUsers(query, directoryRole);
    if (input.value.trim() !== query) return;
    const listedIDs = new Set(groupInvitedUsers.keys());
    const availableUsers = users.filter((user) => !sameID(user.id, state.me.id) && !listedIDs.has(user.id));
    for (const user of availableUsers) {
      appendGroupUserSearchResult(results, user, () => {
        groupInvitedUsers.set(user.id, userWithDiscoveryCode(user, query));
        input.value = "";
        results.replaceChildren();
        renderNewGroupMembers();
      }, directoryRole);
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
  renderNewGroupMembers();
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
    const selectedMembers = selectedIDs.map((userID) => groupInvitedUsers.get(userID));
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
    const discoveryCodes = Object.fromEntries(selectedMembers
      .filter((member) => member.discovery_code)
      .map((member) => [String(member.id), member.discovery_code]));
    const result = await api("/api/conversations/group", {
      method: "POST",
      body: {
        encrypted_title: encryptedTitle,
        encrypted_description: encryptedDescription,
        encrypted_avatar: encryptedAvatar,
        member_ids: selectedIDs,
        encrypted_keys: encryptedKeys,
        discovery_codes: discoveryCodes,
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
  } else if (event.type === "session_approval_requested") {
    toast(t("Un nouvel appareil demande l’accès à votre compte."));
    if (document.querySelector("#profile-dialog")?.open) loadDeviceSecurity().catch(() => {});
  } else if (event.type === "sessions_changed") {
    try {
      await loadDeviceSecurity();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        clearSessionToken();
        sessionStorage.removeItem("crypto_phrase");
        location.href = "/login.html";
      }
    }
  } else if (event.type === "new_message") {
    invalidateConversationPreload(event.message.conversation_id);
    if (event.message.file) {
      invalidateGlobalFilesIndex();
      scheduleGlobalFilesPreload();
    }
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
  } else if (event.type === "message_report_removed") {
    invalidateConversationPreload(event.conversation_id);
    if (sameID(state.current?.id, event.conversation_id)) {
      await loadMessages(null, false);
    }
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
    if (event.files_changed || event.deleted_message_id || event.deleted || event.removed) {
      invalidateGlobalFilesIndex();
      scheduleGlobalFilesPreload();
    }
    const currentID = state.current?.id;
    let profileIdentityBlocked = false;
    state.members.delete(event.conversation_id);
    state.verifiedConversationMembers.delete(String(event.conversation_id));
    state.conversationDisplays.delete(String(event.conversation_id));
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

startBoot();

window.addEventListener("pageshow", restoreChatFromHistory);
window.addEventListener("pagehide", finishAdminNavigation);
window.addEventListener("online", retryIncompleteBoot);
window.addEventListener("pageshow", retryIncompleteBoot);
window.addEventListener("focus", retryIncompleteBoot);
document.addEventListener("visibilitychange", retryIncompleteBoot);
