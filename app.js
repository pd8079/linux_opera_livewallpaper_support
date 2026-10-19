(() => {
  "use strict";

  const BUILTIN_ID = "builtin-neon-fallback";
  const SESSION_ID = "session-wallpaper";
  const DB_NAME = "gx-local-live-wallpaper";
  const DB_VERSION = 1;
  const STORE_NAME = "wallpapers";
  const PREFS_KEY = "gx-live-wallpaper-prefs";
  const MAX_FILE_BYTES = 512 * 1024 * 1024;
  const VALID_SCALES = new Set(["cover", "contain", "fill"]);
  const VALID_SPEEDS = new Set(["0.5", "0.75", "1", "1.25", "1.5", "2"]);
  const DEFAULT_PREFS = {
    activeId: BUILTIN_ID,
    muted: true,
    volume: 0.4,
    scale: "cover",
    speed: "1",
    paused: false,
    accent: "#ff1b8d"
  };

  const elements = {
    body: document.body,
    video: document.querySelector("#wallpaper-video"),
    panel: document.querySelector("#control-panel"),
    togglePanel: document.querySelector("#toggle-panel"),
    closePanel: document.querySelector("#close-panel"),
    status: document.querySelector("#wallpaper-status"),
    list: document.querySelector("#wallpaper-list"),
    count: document.querySelector("#wallpaper-count"),
    importInput: document.querySelector("#video-import"),
    importProgress: document.querySelector("#import-progress"),
    playPause: document.querySelector("#play-pause"),
    muteToggle: document.querySelector("#mute-toggle"),
    reset: document.querySelector("#reset-wallpaper"),
    remove: document.querySelector("#remove-wallpaper"),
    volume: document.querySelector("#volume-control"),
    volumeValue: document.querySelector("#volume-value"),
    scale: document.querySelector("#scale-control"),
    speed: document.querySelector("#speed-control"),
    accent: document.querySelector("#accent-control"),
    storageNote: document.querySelector("#storage-note"),
    motionNote: document.querySelector("#motion-note")
  };

  const state = {
    db: null,
    prefs: { ...DEFAULT_PREFS },
    library: [],
    currentId: BUILTIN_ID,
    currentRecord: null,
    sessionRecord: null,
    currentUrl: null,
    loading: false,
    importing: false,
    activationQueue: Promise.resolve(),
    sourceToken: 0,
    motionOverride: false,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    wasPlayingBeforeHidden: false
  };

  function setStatus(message, kind = "info") {
    elements.status.textContent = message;
    elements.status.dataset.kind = kind;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes;
    let unit = -1;
    do {
      value /= 1024;
      unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "video";
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const remainder = String(total % 60).padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function filenameWithoutExtension(name) {
    return name.replace(/\.[^.]+$/, "") || "Imported wallpaper";
  }

  function isVideoFile(file) {
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    return ["video/mp4", "video/webm"].includes(type) || /\.(mp4|webm)$/.test(name);
  }

  function extensionStorage() {
    return globalThis.chrome?.storage?.local ?? null;
  }

  async function readStoredPrefs() {
    const storage = extensionStorage();
    if (storage?.get) {
      return new Promise((resolve) => {
        storage.get(null, (result) => {
          // lastError is only readable inside this callback in Chromium APIs.
          if (globalThis.chrome?.runtime?.lastError) {
            resolve({});
            return;
          }
          resolve(result || {});
        });
      });
    }

    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  async function savePrefs(changes) {
    state.prefs = { ...state.prefs, ...changes };
    const storage = extensionStorage();
    if (storage?.set) {
      return new Promise((resolve) => {
        storage.set(state.prefs, () => resolve(!globalThis.chrome?.runtime?.lastError));
      });
    }

    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
      return true;
    } catch {
      return false;
    }
  }

  function waitForTransaction(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  async function openDatabase() {
    if (state.db) return state.db;
    if (!globalThis.indexedDB) throw new Error("IndexedDB is not available in this browser profile");

    state.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open IndexedDB"));
      request.onblocked = () => reject(new Error("IndexedDB is busy in another tab"));
    });
    return state.db;
  }

  async function getWallpapers() {
    const db = await openDatabase();
    return requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll());
  }

  async function putWallpaper(record) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    return waitForTransaction(transaction);
  }

  async function deleteWallpaper(id) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    return waitForTransaction(transaction);
  }

  function mediaErrorMessage(video) {
    const code = video.error?.code;
    if (code === MediaError.MEDIA_ERR_ABORTED) return "Playback was cancelled.";
    if (code === MediaError.MEDIA_ERR_NETWORK) return "The browser could not read the local video.";
    if (code === MediaError.MEDIA_ERR_DECODE) return "The video codec could not be decoded by this Opera GX build.";
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return "This MP4/WebM container or codec is not supported.";
    return "The video could not be played.";
  }

  function inspectVideo(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const probe = document.createElement("video");
      let settled = false;
      const timeout = window.setTimeout(() => finish(false, new Error("The video took too long to become playable.")), 12000);

      function cleanup() {
        window.clearTimeout(timeout);
        probe.pause();
        probe.removeAttribute("src");
        probe.load();
        URL.revokeObjectURL(url);
      }

      function finish(ok, value) {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok) resolve(value);
        else reject(value);
      }

      probe.muted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      probe.addEventListener("canplay", () => finish(true, {
        duration: probe.duration,
        width: probe.videoWidth,
        height: probe.videoHeight
      }), { once: true });
      probe.addEventListener("error", () => finish(false, new Error(mediaErrorMessage(probe))), { once: true });
      probe.src = url;
      probe.load();
    });
  }

  function createWallpaperRecord(file, metadata) {
    const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    return {
      id: `wallpaper-${Date.now()}-${random}`,
      name: filenameWithoutExtension(file.name || "Imported wallpaper"),
      filename: file.name || "Imported wallpaper",
      mime: file.type || "video/mp4",
      size: file.size,
      createdAt: Date.now(),
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      blob: file
    };
  }

  function findRecord(id) {
    if (id === SESSION_ID) return state.sessionRecord;
    return state.library.find((record) => record.id === id) || null;
  }

  function applyAccent(value) {
    const color = /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_PREFS.accent;
    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent-strong", color);
    document.documentElement.style.setProperty("--accent-soft", `${color}2e`);
    elements.accent.value = color;
  }

  function applyVideoPreferences() {
    const scale = VALID_SCALES.has(state.prefs.scale) ? state.prefs.scale : DEFAULT_PREFS.scale;
    const speed = VALID_SPEEDS.has(String(state.prefs.speed)) ? String(state.prefs.speed) : DEFAULT_PREFS.speed;
    const volume = Math.min(1, Math.max(0, Number(state.prefs.volume)));
    elements.video.loop = true;
    elements.video.muted = Boolean(state.prefs.muted);
    elements.video.volume = Number.isFinite(volume) ? volume : DEFAULT_PREFS.volume;
    elements.video.playbackRate = Number(speed);
    elements.video.style.objectFit = scale;
    elements.volume.value = String(elements.video.volume);
    elements.volumeValue.value = `${Math.round(elements.video.volume * 100)}%`;
    elements.volumeValue.textContent = `${Math.round(elements.video.volume * 100)}%`;
    elements.scale.value = scale;
    elements.speed.value = speed;
    updateControls();
  }

  function updateControls() {
    const hasVideo = Boolean(state.currentRecord);
    const isPlaying = hasVideo && !elements.video.paused;
    elements.playPause.textContent = isPlaying ? "Pause" : "Play";
    elements.playPause.setAttribute("aria-pressed", String(isPlaying));
    elements.playPause.disabled = !hasVideo;
    elements.muteToggle.textContent = elements.video.muted ? "Unmute" : "Mute";
    elements.muteToggle.setAttribute("aria-pressed", String(elements.video.muted));
    elements.muteToggle.disabled = !hasVideo;
    elements.reset.disabled = state.currentId === BUILTIN_ID;
    elements.remove.disabled = state.currentId === BUILTIN_ID;
  }

  function showFallback() {
    state.sourceToken += 1;
    state.loading = false;
    elements.video.pause();
    elements.video.removeAttribute("src");
    elements.video.load();
    if (state.currentUrl) URL.revokeObjectURL(state.currentUrl);
    state.currentUrl = null;
    state.currentRecord = null;
    elements.body.classList.add("is-fallback");
    updateControls();
  }

  function waitForPlayableSource(url, token) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish(false, new Error("The video took too long to load.")), 15000);

      function cleanup() {
        window.clearTimeout(timeout);
        elements.video.removeEventListener("canplay", onCanPlay);
        elements.video.removeEventListener("error", onError);
      }

      function finish(ok, value) {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok) resolve(value);
        else reject(value);
      }

      function onCanPlay() {
        if (token !== state.sourceToken) {
          finish(false, new Error("Wallpaper activation was superseded."));
          return;
        }
        finish(true);
      }

      function onError() {
        if (token !== state.sourceToken) {
          finish(false, new Error("Wallpaper activation was superseded."));
          return;
        }
        finish(false, new Error(mediaErrorMessage(elements.video)));
      }

      elements.video.addEventListener("canplay", onCanPlay);
      elements.video.addEventListener("error", onError);
      elements.video.src = url;
      elements.video.load();
    });
  }

  async function activateVideo(record) {
    if (!record?.blob) return false;
    const oldUrl = state.currentUrl;
    const url = URL.createObjectURL(record.blob);
    const token = state.sourceToken + 1;
    state.sourceToken = token;
    state.loading = true;
    try {
      await waitForPlayableSource(url, token);
      if (token !== state.sourceToken) {
        URL.revokeObjectURL(url);
        return false;
      }
      state.currentUrl = url;
      state.currentRecord = record;
      elements.body.classList.remove("is-fallback");
      applyVideoPreferences();
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      state.loading = false;
      if (state.prefs.paused || (state.reducedMotion && !state.motionOverride)) {
        elements.video.pause();
      } else {
        await tryPlay(false);
      }
      updateControls();
      return true;
    } catch {
      if (token !== state.sourceToken) return false;
      state.loading = false;
      URL.revokeObjectURL(url);
      elements.video.pause();
      elements.video.removeAttribute("src");
      elements.video.load();
      return false;
    }
  }

  async function tryPlay(announce = true) {
    if (!state.currentRecord) return false;
    try {
      await elements.video.play();
      state.prefs.paused = false;
      void savePrefs({ paused: false });
      updateControls();
      return true;
    } catch {
      state.prefs.paused = true;
      void savePrefs({ paused: true });
      updateControls();
      if (announce) setStatus("Autoplay was blocked. Press Play to start the wallpaper.", "error");
      return false;
    }
  }

  async function selectWallpaperNow(id, suppliedRecord = null) {
    const previousId = state.currentId;
    const previousRecord = state.currentRecord;
    const record = suppliedRecord || findRecord(id);
    let activated = false;

    if (id === BUILTIN_ID) {
      showFallback();
      activated = true;
    } else {
      activated = await activateVideo(record);
    }

    if (!activated) {
      if (previousRecord) {
        await activateVideo(previousRecord);
      } else {
        showFallback();
      }
      state.currentId = previousId;
      renderLibrary();
      setStatus(`Could not play ${record?.filename || "that wallpaper"}. Your previous wallpaper was kept.`, "error");
      return false;
    }

    state.currentId = id;
    await savePrefs({ activeId: id });
    renderLibrary();
    updateControls();
    return true;
  }

  // All operations that replace the shared video element run in order. This
  // prevents a slow decoder event from making an older click win over a newer
  // wallpaper selection or import.
  function selectWallpaper(id, suppliedRecord = null) {
    const operation = state.activationQueue.then(() => selectWallpaperNow(id, suppliedRecord));
    state.activationQueue = operation.catch(() => {});
    return operation;
  }

  function renderLibrary() {
    const items = [{
      id: BUILTIN_ID,
      name: "Neon fallback",
      meta: "Always available",
      builtin: true
    }, ...state.library];
    if (state.sessionRecord) {
      items.push({ ...state.sessionRecord, id: SESSION_ID, meta: "This tab only" });
    }

    elements.list.replaceChildren();
    elements.count.textContent = String(items.length);
    for (const item of items) {
      const listItem = document.createElement("li");
      listItem.className = "wallpaper-item";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wallpaper-choice";
      button.dataset.wallpaperId = item.id;
      button.setAttribute("aria-current", String(item.id === state.currentId));

      const thumb = document.createElement("span");
      thumb.className = "wallpaper-thumb";
      thumb.setAttribute("aria-hidden", "true");
      thumb.textContent = item.builtin ? "✦" : "▶";

      const name = document.createElement("span");
      name.className = "wallpaper-name";
      name.textContent = item.name || "Imported wallpaper";

      const meta = document.createElement("span");
      meta.className = "wallpaper-meta";
      meta.textContent = item.meta || `${formatBytes(item.size)} · ${formatDuration(item.duration)}`;

      button.append(thumb, name, meta);
      listItem.append(button);
      elements.list.append(listItem);
    }
    updateControls();
  }

  async function importOne(file) {
    const displayName = file.name || "selected video";
    if (!isVideoFile(file)) {
      setStatus(`${displayName}: choose an MP4 or WebM file.`, "error");
      return false;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus(`${displayName} is larger than the 512 MB safety limit.`, "error");
      return false;
    }

    setStatus(`Checking ${displayName}…`);
    let metadata;
    try {
      metadata = await inspectVideo(file);
    } catch (error) {
      setStatus(`${displayName}: ${error.message}`, "error");
      return false;
    }

    const record = createWallpaperRecord(file, metadata);
    let persisted = false;
    try {
      await putWallpaper(record);
      persisted = true;
      state.library.push(record);
      elements.storageNote.textContent = "Saved in this browser profile";
    } catch {
      state.db = null;
      state.sessionRecord = record;
      elements.storageNote.textContent = "Storage unavailable · current tab only";
    }

    const id = persisted ? record.id : SESSION_ID;
    const activated = await selectWallpaper(id, record);
    if (!activated) {
      if (persisted) {
        try {
          await deleteWallpaper(record.id);
        } catch {
          // The previous wallpaper remains usable even if cleanup fails.
        }
        state.library = state.library.filter((item) => item.id !== record.id);
      } else {
        state.sessionRecord = null;
      }
      renderLibrary();
      return false;
    }

    const persistenceMessage = persisted ? "saved locally" : "playing for this tab only; it could not be saved";
    setStatus(`${record.name} is ready and ${persistenceMessage}.`, persisted ? "success" : "error");
    return true;
  }

  async function importFiles(files) {
    if (state.importing || files.length === 0) return;
    state.importing = true;
    elements.importInput.disabled = true;
    elements.importProgress.hidden = false;
    elements.importProgress.value = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        await importOne(files[index]);
        elements.importProgress.value = (index + 1) / files.length;
      }
    } finally {
      state.importing = false;
      elements.importInput.disabled = false;
      window.setTimeout(() => {
        elements.importProgress.hidden = true;
      }, 500);
      elements.importInput.value = "";
    }
  }

  async function removeSelected() {
    if (state.currentId === BUILTIN_ID) return;
    const id = state.currentId;
    if (id === SESSION_ID) {
      state.sessionRecord = null;
    } else {
      try {
        await deleteWallpaper(id);
      } catch {
        setStatus("The saved wallpaper could not be removed. Try again after reloading this tab.", "error");
        return;
      }
      state.library = state.library.filter((record) => record.id !== id);
    }
    await selectWallpaper(BUILTIN_ID);
    setStatus("Wallpaper removed. The built-in fallback is active.", "success");
  }

  function wireEvents() {
    elements.togglePanel.addEventListener("click", () => {
      const hidden = elements.panel.classList.toggle("is-hidden");
      elements.togglePanel.setAttribute("aria-expanded", String(!hidden));
    });
    elements.closePanel.addEventListener("click", () => {
      elements.panel.classList.add("is-hidden");
      elements.togglePanel.setAttribute("aria-expanded", "false");
      elements.togglePanel.focus();
    });
    elements.list.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-wallpaper-id]");
      if (!button) return;
      const id = button.dataset.wallpaperId;
      void selectWallpaper(id);
    });
    elements.playPause.addEventListener("click", () => {
      if (!state.currentRecord) return;
      if (elements.video.paused) {
        state.motionOverride = true;
        state.prefs.paused = false;
        void savePrefs({ paused: false });
        void tryPlay(true);
      } else {
        elements.video.pause();
        state.prefs.paused = true;
        void savePrefs({ paused: true });
        updateControls();
      }
    });
    elements.muteToggle.addEventListener("click", () => {
      if (!state.currentRecord) return;
      elements.video.muted = !elements.video.muted;
      void savePrefs({ muted: elements.video.muted });
      updateControls();
    });
    elements.reset.addEventListener("click", () => {
      void selectWallpaper(BUILTIN_ID).then(() => setStatus("The built-in fallback is active.", "success"));
    });
    elements.remove.addEventListener("click", () => void removeSelected());
    elements.importInput.addEventListener("change", () => void importFiles([...elements.importInput.files]));
    elements.volume.addEventListener("input", () => {
      const volume = Number(elements.volume.value);
      elements.video.volume = volume;
      elements.volumeValue.value = `${Math.round(volume * 100)}%`;
      elements.volumeValue.textContent = `${Math.round(volume * 100)}%`;
      void savePrefs({ volume });
    });
    elements.scale.addEventListener("change", () => {
      const scale = elements.scale.value;
      if (!VALID_SCALES.has(scale)) return;
      elements.video.style.objectFit = scale;
      void savePrefs({ scale });
    });
    elements.speed.addEventListener("change", () => {
      const speed = elements.speed.value;
      if (!VALID_SPEEDS.has(speed)) return;
      elements.video.playbackRate = Number(speed);
      void savePrefs({ speed });
    });
    elements.accent.addEventListener("input", () => {
      applyAccent(elements.accent.value);
      void savePrefs({ accent: elements.accent.value });
    });
    elements.video.addEventListener("error", () => {
      if (state.loading || !state.currentRecord) return;
      const failedName = state.currentRecord.name;
      const failure = mediaErrorMessage(elements.video);
      showFallback();
      state.currentId = BUILTIN_ID;
      void savePrefs({ activeId: BUILTIN_ID });
      renderLibrary();
      setStatus(`${failedName}: ${failure} The fallback is active.`, "error");
    });
    elements.video.addEventListener("play", updateControls);
    elements.video.addEventListener("pause", updateControls);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        state.wasPlayingBeforeHidden = Boolean(state.currentRecord && !elements.video.paused);
        if (state.wasPlayingBeforeHidden) elements.video.pause();
      } else if (state.wasPlayingBeforeHidden) {
        state.wasPlayingBeforeHidden = false;
        void tryPlay(false);
      }
    });
  }

  async function init() {
    showFallback();
    applyAccent(DEFAULT_PREFS.accent);
    applyVideoPreferences();
    renderLibrary();

    const stored = await readStoredPrefs();
    state.prefs = { ...DEFAULT_PREFS, ...stored };
    if (state.reducedMotion) {
      state.prefs.paused = true;
    }
    applyAccent(state.prefs.accent);
    applyVideoPreferences();
    elements.motionNote.textContent = state.reducedMotion
      ? "Reduced motion is enabled, so animation starts paused. Press Play when you want to watch."
      : "Animation starts muted. Reduced-motion preferences are respected.";

    try {
      await openDatabase();
      state.library = await getWallpapers();
      elements.storageNote.textContent = "Saved in this browser profile";
    } catch {
      state.db = null;
      elements.storageNote.textContent = "IndexedDB unavailable · imports are session-only";
    }
    renderLibrary();
    wireEvents();

    const desiredId = state.prefs.activeId;
    if (desiredId && desiredId !== BUILTIN_ID) {
      const record = findRecord(desiredId);
      if (record) {
        const activated = await selectWallpaper(desiredId, record);
        if (!activated) {
          await selectWallpaper(BUILTIN_ID);
          setStatus("The saved video could not be decoded, so the fallback is active.", "error");
        }
      } else {
        await selectWallpaper(BUILTIN_ID);
        setStatus("The saved video is no longer available. Choose another local file.", "error");
      }
    } else {
      await selectWallpaper(BUILTIN_ID);
      setStatus("Choose a local MP4 or WebM to turn this page into a live wallpaper.");
    }
  }

  void init().catch((error) => {
    showFallback();
    setStatus(`The wallpaper page loaded with a fallback: ${error.message}`, "error");
  });
})();
