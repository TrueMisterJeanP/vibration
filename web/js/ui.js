export function escapeHTML(value) {
  const element = document.createElement("div");
  element.textContent = value ?? "";
  return element.innerHTML;
}

export function toast(message, kind = "info") {
  const region = document.querySelector("#toasts");
  const openDialog = document.querySelector("dialog[open]");
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = message;
  if (openDialog && "showPopover" in HTMLElement.prototype) {
    item.classList.add("popover-toast");
    item.popover = "manual";
    document.body.append(item);
    item.showPopover();
  } else {
    region.append(item);
  }
  setTimeout(() => {
    if (item.matches(":popover-open")) item.hidePopover();
    item.remove();
  }, 4000);
}

export function frenchErrorMessage(error, fallback = "Une erreur inattendue est survenue.") {
  const message = typeof error === "string" ? error.trim() : error?.message?.trim();
  if (!message) return fallback;
  if (
    /[àâçéèêëîïôùûüÿœ’]/i.test(message)
    || /\b(aucun|authentification|ce|cette|dans|de|des|du|erreur|est|fichier|groupe|impossible|introuvable|la|le|les|mot|pour|requise|requête|serveur|un|une|utilisateur|votre|vous)\b/i.test(message)
  ) {
    return message;
  }
  if (/load failed|failed to fetch|network(?: request)? failed/i.test(message)) {
    return "Serveur inaccessible";
  }
  if (/abort|cancel/i.test(message)) {
    return "L’opération a été annulée.";
  }
  return fallback;
}

export function formatTime(value) {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function actionIcon(kind) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("action-icon");
  const paths = kind === "edit"
    ? ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"]
    : ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 15H6L5 6", "M10 10v7", "M14 10v7"];
  for (const data of paths) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}

export function materialFileIcon(kind = "file") {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("file-kind-icon");
  const paths = {
    image: ["M3 5h18v14H3Z", "m5 16 4-4 3 3 2-2 4 3", "M16 9h.01"],
    video: ["M3 5h18v14H3Z", "m10 9 5 3-5 3Z"],
    audio: ["M9 18V6l10-2v12", "M9 10l10-2"],
    pdf: ["M6 2h8l4 4v16H6Z", "M14 2v5h5", "M9 16h6M9 12h6"],
    file: ["M6 2h8l4 4v16H6Z", "M14 2v5h5", "M9 12h6M9 16h6"],
  }[kind] || ["M6 2h8l4 4v16H6Z", "M14 2v5h5"];
  for (const data of paths) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}

export function renderMessage(
  container, message, clear, mine, onFilePreview, onFileDownload, onMessageEdit, onMessageDelete,
  onMessageReply = () => {}, onMessageReact = () => {}, onMessagePin = () => {}, onReplyFilePreview = () => {},
  onPollVote = () => {}, onFileShare = () => {},
) {
  if (!message.file && isCallHistoryText(clear)) {
    renderCallHistoryMessage(container, message, clear);
    return;
  }
  const row = document.createElement("div");
  row.className = `message-row ${message.file ? "file-message" : message.poll ? "poll-message" : message.event ? "event-message" : "text-message"} ${mine ? "mine" : "theirs"}`;
  row.dataset.id = message.id;
  applyMessageVisualOrder(row, message);
  const article = document.createElement("article");
  article.className = `message swipe-surface ${mine ? "mine" : "theirs"}`;
  const authorRow = document.createElement("div");
  authorRow.className = "message-author-row";
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  if (message.sender_avatar) {
    const image = document.createElement("img");
    image.src = message.sender_avatar;
    image.alt = "";
    avatar.append(image);
  } else {
    avatar.textContent = (message.sender_username || "?").slice(0, 1).toUpperCase();
  }
  const author = document.createElement("small");
  author.className = "message-author";
  author.textContent = mine ? "Vous" : message.sender_username;
  authorRow.append(avatar, author);
  if (message.is_pinned) {
    const pinned = document.createElement("small");
    pinned.className = "message-pin-badge";
    pinned.textContent = "Épinglé";
    authorRow.append(pinned);
  }
  const quickActions = document.createElement("span");
  quickActions.className = "message-quick-actions";
  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.textContent = "↩";
  replyButton.title = "Répondre";
  replyButton.setAttribute("aria-label", replyButton.title);
  replyButton.onclick = () => onMessageReply(message, clear);
  const reactButton = document.createElement("button");
  reactButton.type = "button";
  reactButton.textContent = "♡";
  reactButton.title = "Réagir";
  reactButton.setAttribute("aria-label", reactButton.title);
  reactButton.onclick = () => onMessageReact(message);
  const pinButton = document.createElement("button");
  pinButton.type = "button";
  pinButton.textContent = message.is_pinned ? "⌖" : "⌑";
  pinButton.title = message.is_pinned ? "Désépingler" : "Épingler";
  pinButton.setAttribute("aria-label", pinButton.title);
  pinButton.onclick = () => onMessagePin(message);
  quickActions.append(replyButton, reactButton, pinButton);
  authorRow.append(quickActions);
  if (message.file) {
    const download = document.createElement("button");
    download.type = "button";
    download.className = "file-download-button";
    download.textContent = "↓";
    download.title = "Télécharger le fichier";
    download.setAttribute("aria-label", `Télécharger ${clear.name}`);
    download.addEventListener("click", () => onFileDownload(message, clear.name, download));
    authorRow.append(download);
  }
  let filePreview;
  article.append(authorRow);
  if (message.reply_preview) {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = `message-reply-preview ${message.reply_preview.type === "file" ? "has-file" : ""}`;
    if (message.reply_preview.type === "file") {
      const thumb = document.createElement("span");
      thumb.className = "message-reply-file-thumb";
      thumb.textContent = "Aperçu";
      const label = document.createElement("span");
      label.className = "message-reply-file-label";
      label.textContent = message.reply_preview.name || "Fichier";
      reply.append(thumb, label);
      onReplyFilePreview(message.reply_preview, thumb);
    } else {
      reply.textContent = message.reply_preview.text || String(message.reply_preview);
    }
    reply.onclick = () => document.querySelector(`[data-id="${message.reply_to}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    article.append(reply);
  } else if (message.reply_to) {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "message-reply-preview";
    reply.textContent = `Réponse au message #${message.reply_to}`;
    reply.onclick = () => document.querySelector(`[data-id="${message.reply_to}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    article.append(reply);
  }
  if (message.file) {
    const attachment = document.createElement("section");
    attachment.className = "file-attachment";
    const title = document.createElement("div");
    title.className = "file-title";
    const name = document.createElement("strong");
    name.textContent = clear.name;
    const share = document.createElement("button");
    share.type = "button";
    share.className = "file-share-button";
    share.title = "Partager le fichier";
    share.setAttribute("aria-label", `Partager ${clear.name}`);
    const shareIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    shareIcon.setAttribute("viewBox", "0 0 24 24");
    shareIcon.setAttribute("aria-hidden", "true");
    shareIcon.classList.add("file-share-icon");
    for (const attributes of [
      { element: "circle", cx: "18", cy: "5", r: "3" },
      { element: "circle", cx: "6", cy: "12", r: "3" },
      { element: "circle", cx: "18", cy: "19", r: "3" },
    ]) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", attributes.element);
      for (const [key, value] of Object.entries(attributes)) if (key !== "element") node.setAttribute(key, value);
      shareIcon.append(node);
    }
    for (const data of ["m8.6 10.7 6.8-4.4", "m8.6 13.3 6.8 4.4"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", data);
      shareIcon.append(path);
    }
    share.append(shareIcon);
    share.addEventListener("click", () => onFileShare(message, clear));
    const size = document.createElement("small");
    size.textContent = `${Math.max(1, Math.ceil(message.file.size / 1024))} Ko`;
    const actions = document.createElement("span");
    actions.className = "file-title-actions";
    actions.append(share, size);
    title.append(name, actions);
    const preview = document.createElement("div");
    preview.className = "file-preview";
    preview.textContent = "Chargement de l’aperçu…";
    attachment.append(title, preview);
    article.append(attachment);
    filePreview = preview;
  } else if (message.event) {
    const event = document.createElement("section");
    event.className = "event-card";
    const name = document.createElement("h4");
    name.textContent = clear?.name || "Évènement impossible à déchiffrer";
    event.append(name);
    if (clear?.description) {
      const description = document.createElement("p");
      description.className = "event-description";
      description.textContent = clear.description;
      event.append(description);
    }
    if (clear?.location) {
      const location = document.createElement("span");
      location.className = "event-location";
      location.textContent = `📍 ${clear.location}`;
      event.append(location);
    }
    const dates = document.createElement("span");
    dates.className = "event-dates";
    dates.textContent = eventDateRange(message.event.starts_at, message.event.ends_at);
    event.append(dates);
    article.append(event);
  } else if (message.poll) {
    const poll = document.createElement("section");
    poll.className = "poll-card";
    const question = document.createElement("h4");
    question.textContent = clear?.question || "Sondage impossible à déchiffrer";
    const options = document.createElement("div");
    options.className = "poll-options";
    const deadline = Date.parse(message.poll.expires_at || "");
    const closed = Boolean(message.poll.closed) || (Number.isFinite(deadline) && deadline <= Date.now());
    for (const option of message.poll.options || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `poll-option ${option.mine ? "mine" : ""}`;
      button.disabled = Boolean(message.poll.has_voted) || closed;
      const percent = message.poll.total_votes ? Math.round((option.vote_count / message.poll.total_votes) * 100) : 0;
      button.style.setProperty("--poll-percent", `${percent}%`);
      const label = document.createElement("span");
      label.textContent = clear?.options?.[option.position] || `Réponse ${option.position + 1}`;
      const result = document.createElement("span");
      result.textContent = `${option.vote_count} · ${percent} %`;
      button.append(label, result);
      button.onclick = () => onPollVote(message, option.id);
      options.append(button);
    }
    const summary = document.createElement("small");
    summary.className = "poll-summary";
    const validity = closed
      ? " · Terminé"
      : Number.isFinite(deadline)
        ? ` · Clôture le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(deadline))}`
        : " · Sans limite";
    summary.textContent = `${message.poll.total_votes} vote${message.poll.total_votes === 1 ? "" : "s"}${message.poll.has_voted ? " · Vous avez voté" : ""}${validity}`;
    poll.append(question, options, summary);
    article.append(poll);
  } else {
    const body = document.createElement("p");
    body.textContent = clear;
    article.append(body);
  }
  const time = document.createElement("time");
  const status = mine ? { sent: " ✓", delivered: " ✓✓", read: " ✓✓" }[message.status] || "" : "";
  const expiry = message.expires_at ? ` · expire ${formatTime(message.expires_at)}` : "";
  time.textContent = `${formatTime(message.created_at)}${message.updated_at ? " · modifié" : ""}${expiry}${status}`;
  if (message.status === "read") time.classList.add("read");
  article.append(time);
  if (message.reactions?.length) {
    const reactions = document.createElement("div");
    reactions.className = "message-reactions";
    for (const reaction of message.reactions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = reaction.mine ? "mine" : "";
      button.textContent = `${reaction.emoji} ${reaction.count}`;
      button.onclick = () => onMessageReact(message, reaction.emoji);
      reactions.append(button);
    }
    article.append(reactions);
  }
  if (mine) {
    const actions = document.createElement("div");
    actions.className = "swipe-actions message-swipe-actions";
    if (!message.file) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "swipe-edit";
      edit.append(actionIcon("edit"));
      edit.title = "Modifier le message";
      edit.setAttribute("aria-label", edit.title);
      edit.onclick = () => onMessageEdit(message, clear, row);
      actions.append(edit);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "swipe-delete";
    remove.append(actionIcon("delete"));
    remove.title = "Supprimer le message";
    remove.setAttribute("aria-label", remove.title);
    remove.onclick = () => onMessageDelete(message, row);
    actions.append(remove);
    row.append(actions, article);
    const swipe = bindSwipeActions(article, row, message.file ? 56 : 112);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "swipe-toggle";
    toggle.textContent = "•••";
    toggle.title = "Afficher les actions";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.onclick = (event) => {
      event.stopPropagation();
      swipe.toggle();
    };
    author.after(toggle);
  } else {
    row.append(article);
  }
  container.append(row);
  if (filePreview) onFilePreview(message, filePreview);
}

function eventDateRange(startsAt, endsAt) {
  const formatter = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return "Date inconnue";
  return `Du ${formatter.format(start)} au ${formatter.format(end)}`;
}

function isCallHistoryText(clear) {
  return typeof clear === "string" && /^Appel (audio|vidéo) (annulé|refusé|terminé|manqué|interrompu|impossible)(?:[ :.].*)?\.$/.test(clear);
}

function renderCallHistoryMessage(container, message, clear) {
  const row = document.createElement("div");
  row.className = "message-row call-history-message";
  row.dataset.id = message.id;
  applyMessageVisualOrder(row, message);
  const event = document.createElement("div");
  event.className = "call-history-event";
  const label = document.createElement("span");
  label.textContent = clear;
  const time = document.createElement("time");
  time.textContent = formatTime(message.created_at);
  event.append(label, time);
  row.append(event);
  container.append(row);
}

function applyMessageVisualOrder(row, message) {
  const timestamp = Date.parse(message.created_at);
  if (Number.isFinite(timestamp)) {
    row.style.order = String(-Math.floor(timestamp / 1000));
  }
}

let outsideSwipeCloseBound = false;

export function bindSwipeActions(surface, row, distance = 104) {
  if (!outsideSwipeCloseBound) {
    document.addEventListener("click", (event) => {
      document.querySelectorAll(".swipe-open").forEach((openRow) => {
        if (!openRow.contains(event.target)) {
          openRow.dispatchEvent(new Event("swipe-close"));
        }
      });
    });
    outsideSwipeCloseBound = true;
  }
  let startX = 0;
  let startY = 0;
  let offset = 0;
  let dragging = false;
  let horizontal = false;
  let suppressClick = false;
  const apply = (value, animate = false) => {
    offset = Math.max(-distance, Math.min(0, value));
    surface.style.transition = animate ? "transform .18s ease" : "none";
    surface.style.transform = `translateX(${offset}px)`;
    row.classList.toggle("swipe-open", offset < -distance / 2);
    row.style.setProperty("--swipe-offset", `${Math.abs(offset)}px`);
  };
  const start = (x, y) => {
    document.querySelectorAll(".swipe-open").forEach((openRow) => {
      if (openRow !== row) openRow.dispatchEvent(new Event("swipe-close"));
    });
    startX = x - offset;
    startY = y;
    dragging = true;
    horizontal = false;
    surface.style.transition = "none";
  };
  const move = (x, y) => {
    if (!dragging) return;
    const deltaX = x - startX;
    const deltaY = y - startY;
    if (!horizontal && Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 8) {
      dragging = false;
      return;
    }
    if (Math.abs(deltaX - offset) > 6) horizontal = true;
    if (!horizontal) return;
    suppressClick = true;
    apply(deltaX);
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    apply(offset < -distance / 2 ? -distance : 0, true);
  };
  surface.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    if (event.target.closest("button, a, input, textarea, audio, video")) return;
    start(event.clientX, event.clientY);
    surface.setPointerCapture?.(event.pointerId);
  });
  surface.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") {
      move(event.clientX, event.clientY);
      if (horizontal) event.preventDefault();
    }
  });
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);
  surface.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    if (event.target.closest("button, a, input, textarea, audio, video")) return;
    const touch = event.touches[0];
    start(touch.clientX, touch.clientY);
  }, { passive: true });
  surface.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    move(touch.clientX, touch.clientY);
    if (horizontal) event.preventDefault();
  }, { passive: false });
  surface.addEventListener("touchend", end);
  surface.addEventListener("touchcancel", end);
  surface.addEventListener("click", (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);
  row.addEventListener("swipe-close", () => apply(0, true));
  apply(0);
  return {
    close: () => apply(0, true),
    open: () => apply(-distance, true),
    toggle: () => apply(offset < -distance / 2 ? 0 : -distance, true),
  };
}

export function setBusy(button, busy, text = "Traitement…") {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}
