
let pc = null;
let ws = null;
let dc = null;
let bufferLogTimer = null;
let clientId = null;
let disconnecting = false;
let gamepadLoopId = null;
let lastGamepadPayload = null;
let remoteStream = null;
let selectedGamepadIndex = null;
let uiLocked = false;
let hasConnectedOnce = false;
let reloadScheduled = false;

const STORAGE_KEY = "remoteplay_guest_settings";
const LOG_STORAGE_KEY = "remoteplay_guest_log";
const DEFAULT_VIDEO_QUEUE_FRAMES = 4;
const MIN_VIDEO_QUEUE_FRAMES = 1;
const DEFAULT_VIDEO_FPS = 60;

let logBuffer = "";


const logElem = document.getElementById("log");
const videoElem = document.getElementById("video");
const gamepadSelect = document.getElementById("gamepad-select");
const refreshGamepadsBtn = document.getElementById("refresh-gamepads-btn");
const guestNameInput = document.getElementById("guest-name");
const wsUrlInput = document.getElementById("ws-url");
const videoBufferFramesInput = document.getElementById("video-buffer-frames");
const clearLogBtn = document.getElementById("clear-log-btn");
const saveLogBtn = document.getElementById("save-log-btn");


const savedSettings = loadSavedSettings();
const initialVideoQueueFrames = getInitialVideoQueueFrames(savedSettings);
let configuredVideoQueueFrames = initialVideoQueueFrames;
let dynamicVideoQueueFrames = initialVideoQueueFrames;
let videoReceiver = null;
let videoTrack = null;
let videoFrameRateEstimate = DEFAULT_VIDEO_FPS;
let lastInboundVideoStats = null;
let lastBufferLogJitterSeconds = null;


function log(msg) {
  console.log(msg);
  if (typeof msg !== "string") {
    try {
      msg = JSON.stringify(msg);
    } catch (e) {
      msg = String(msg);
    }
  }
  logBuffer += msg + "\n";
  // keep last ~1M characters to avoid unbounded growth
  if (logBuffer.length > 1_000_000) {
    logBuffer = logBuffer.slice(logBuffer.length - 800_000);
  }
  logElem.textContent = logBuffer;
  try {
    localStorage.setItem(LOG_STORAGE_KEY, logBuffer);
  } catch (err) {
    // ignore quota errors
  }
}


function loadSavedSettings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (err) {
    console.warn("Failed to read saved settings", err);
    return {};
  }
}

function clampVideoQueueFrames(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_VIDEO_QUEUE_FRAMES;
  }
  return Math.max(MIN_VIDEO_QUEUE_FRAMES, Math.round(value));
}

function getInitialVideoQueueFrames(saved = {}) {
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get("videoQueueFrames") ?? params.get("video_queue_frames");
  const fromQuery = clampVideoQueueFrames(Number(queryValue));

  if (Number.isFinite(fromQuery) && queryValue !== null) {
    log(`Using videoQueueFrames from query string: ${fromQuery}`);
    return fromQuery;
  }

  if (Number.isFinite(saved.videoQueueFrames)) {
    return clampVideoQueueFrames(saved.videoQueueFrames);
  }

  return DEFAULT_VIDEO_QUEUE_FRAMES;
}

function persistGuestSettings(overrides = {}) {
  const current = loadSavedSettings();
  const next = {
    ...current,
    wsUrl: wsUrlInput?.value || current.wsUrl,
    guestName: guestNameInput?.value || current.guestName,
    gamepadIndex: selectedGamepadIndex,
    videoQueueFrames:
      overrides.videoQueueFrames ??
      clampVideoQueueFrames(Number(videoBufferFramesInput?.value ?? current.videoQueueFrames)),
    ...overrides,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("Failed to save guest settings", err);
  }
}

function restoreGuestSettings(saved = savedSettings) {
  if (wsUrlInput && typeof saved.wsUrl === "string") {
    wsUrlInput.value = saved.wsUrl;
  }
  if (guestNameInput && typeof saved.guestName === "string") {
    guestNameInput.value = saved.guestName;
  }
  if (videoBufferFramesInput) {
    videoBufferFramesInput.value = configuredVideoQueueFrames;
  }
  if (typeof saved.gamepadIndex === "number" && Number.isFinite(saved.gamepadIndex)) {
    selectedGamepadIndex = saved.gamepadIndex;
  }
}

function scheduleReload() {
  if (reloadScheduled || !hasConnectedOnce) {
    return;
  }
  reloadScheduled = true;
  persistGuestSettings();
  setTimeout(() => window.location.reload(), 50);
}

function getVideoFrameRate(track) {
  const settings = typeof track?.getSettings === "function" ? track.getSettings() : undefined;
  const frameRate = Number(settings?.frameRate);
  if (Number.isFinite(frameRate) && frameRate > 0) {
    return frameRate;
  }
  return DEFAULT_VIDEO_FPS;
}

function updateVideoFrameRateEstimate(track) {
  const nextFrameRate = getVideoFrameRate(track ?? videoTrack);
  if (!Number.isFinite(nextFrameRate) || nextFrameRate <= 0) {
    return;
  }

  const frameRateChanged =
    !Number.isFinite(videoFrameRateEstimate) ||
    Math.abs(videoFrameRateEstimate - nextFrameRate) >= 0.25;

  videoFrameRateEstimate = nextFrameRate;

  if (frameRateChanged) {
    log(`Video frameRate estimate updated: ${nextFrameRate.toFixed(2)}fps`);
    applyVideoJitterBufferTarget("Frame rate updated");
  }
}

function logVideoBufferUpdate(reason = "") {
  const frameRate = Math.max(videoFrameRateEstimate || DEFAULT_VIDEO_FPS, 1);
  const queueSeconds = dynamicVideoQueueFrames / frameRate;
  const reasonText = reason ? `${reason}: ` : "";
  log(
    `${reasonText}jitterBufferTarget=${queueSeconds.toFixed(3)}s (~${dynamicVideoQueueFrames} frames @ ${frameRate.toFixed(1)}fps)`
  );
  lastBufferLogJitterSeconds = queueSeconds;
}

function getMaxVideoQueueFrames() {
  return Math.max(MIN_VIDEO_QUEUE_FRAMES, configuredVideoQueueFrames + 2);
}

function applyVideoJitterBufferTarget(reason = "") {
  const frameRate = Math.max(videoFrameRateEstimate || DEFAULT_VIDEO_FPS, 1);
  const maxFrames = getMaxVideoQueueFrames();
  dynamicVideoQueueFrames = clampVideoQueueFrames(
    Math.min(dynamicVideoQueueFrames, maxFrames)
  );
  const queueSeconds = dynamicVideoQueueFrames / frameRate;

  if (!videoReceiver || !("jitterBufferTarget" in videoReceiver)) {
    log(
      `Video receiver not ready; target buffer ${queueSeconds.toFixed(3)}s will be applied once available`
    );
    return;
  }

  try {
    videoReceiver.jitterBufferTarget = queueSeconds;
    if (lastBufferLogJitterSeconds !== queueSeconds || reason) {
      logVideoBufferUpdate(reason || "Updated video jitterBufferTarget");
    }
  } catch (err) {
    log(`Failed to set video jitterBufferTarget: ${err}`);
  }
}

function setConfiguredVideoQueueFrames(frames, reason = "") {
  configuredVideoQueueFrames = clampVideoQueueFrames(frames);
  dynamicVideoQueueFrames = Math.min(dynamicVideoQueueFrames, getMaxVideoQueueFrames());
  applyVideoJitterBufferTarget(reason || "Configured video buffer updated");
}

function adjustVideoJitterBufferFromStats(lossRate, nackDelta, retransDelta) {
  const maxFrames = getMaxVideoQueueFrames();
  let nextFrames = dynamicVideoQueueFrames;

  const shouldGrow =
    lossRate > 0.02 || nackDelta > 10 || retransDelta > 20 || Number.isNaN(lossRate);
  const shouldShrink = lossRate >= 0 && lossRate < 0.005 && nackDelta === 0 && retransDelta < 5;

  if (shouldGrow) {
    nextFrames = Math.min(maxFrames, dynamicVideoQueueFrames + 1);
  } else if (shouldShrink) {
    nextFrames = Math.max(MIN_VIDEO_QUEUE_FRAMES, dynamicVideoQueueFrames - 1);
  }

  if (nextFrames !== dynamicVideoQueueFrames) {
    const changeKind = nextFrames > dynamicVideoQueueFrames ? "increase" : "decrease";
    dynamicVideoQueueFrames = nextFrames;
    applyVideoJitterBufferTarget(
      `Auto ${changeKind} (loss=${(lossRate * 100).toFixed(2)}%, nack=${nackDelta}, retrans=${retransDelta})`
    );
  }
}

function setButtonLabel(label) {
  document.getElementById("connect-btn").textContent = label;
}

function setConnectionUiLocked(locked) {
  uiLocked = locked;
  const wsUrlInput = document.getElementById("ws-url");
  if (wsUrlInput) {
    wsUrlInput.disabled = locked;
  }
  if (guestNameInput) {
    guestNameInput.disabled = locked;
  }
  if (refreshGamepadsBtn) {
    refreshGamepadsBtn.disabled = locked;
  }
  refreshGamepadOptions();
}

function resetState() {
  pc = null;
  ws = null;
  dc = null;
  clientId = null;
  disconnecting = false;
  remoteStream = null;
  if (videoElem) {
    videoElem.srcObject = null;
  }
}

function createPeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: [
      {
        urls: ["stun:stun.l.google.com:19302"]
      }
    ],
    sdpSemantics: "unified-plan"
  });

  const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
  applyCodecPreference(videoTransceiver, "video", (codec) => {
    const mime = codec.mimeType?.toLowerCase() || "";
    const fmtp = codec.sdpFmtpLine || "";
    return mime === "video/h264" && fmtp.includes("packetization-mode=1");
  });

  const audioTransceiver = pc.addTransceiver("audio", { direction: "recvonly" });
  applyCodecPreference(audioTransceiver, "audio", (codec) => {
    const mime = codec.mimeType?.toLowerCase() || "";
    return mime === "audio/opus";
  });

  pc.onconnectionstatechange = () => {
    log("pc.connectionState=" + pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    log("pc.iceConnectionState=" + pc.iceConnectionState);
  };

  return pc;
}

function applyCodecPreference(transceiver, kind, predicate) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== "function") {
    return;
  }

  const caps = RTCRtpReceiver.getCapabilities(kind);
  const preferred = caps?.codecs?.filter((codec) => predicate(codec)) || [];
  if (preferred.length === 0) {
    return;
  }

  try {
    transceiver.setCodecPreferences(preferred);
    log(`Preferred ${kind} codecs: ${preferred.map((c) => c.mimeType).join(", ")}`);
  } catch (err) {
    log(`Failed to set ${kind} codec preferences: ${err}`);
  }
}

function setupIceHandlers(conn) {
  conn.onicecandidate = (e) => {
    if (disconnecting || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (e.candidate) {
      ws.send(
        JSON.stringify({
          type: "candidate",
          candidate: e.candidate.toJSON()
        })
      );
    }
  };
}

function setupTrackHandlers(conn) {
  conn.ontrack = (event) => {
    log("ontrack: kind=" + event.track.kind + ", streams=" + event.streams.length);

    if (event.receiver && "playoutDelayHint" in event.receiver) {
      try {
        event.receiver.playoutDelayHint = 0;
        log("Set receiver playoutDelayHint to 0");
      } catch (err) {
        log("Failed to set playoutDelayHint: " + err);
      }
    }

    attachTrack(event.track, event.receiver);
  };
}

function attachTrack(track, receiver) {
  if (!track) {
    return;
  }

  if (!remoteStream) {
    remoteStream = new MediaStream();
  }

  const alreadyAdded = remoteStream.getTracks().some((t) => t.id === track.id);
  if (!alreadyAdded) {
    remoteStream.addTrack(track);
  }

  if (videoElem && videoElem.srcObject !== remoteStream) {
    videoElem.srcObject = remoteStream;
  }

  if (track.kind === "video" && receiver && "jitterBufferTarget" in receiver) {
    videoReceiver = receiver;
    videoTrack = track;
    lastInboundVideoStats = null;
    updateVideoFrameRateEstimate(track);
    dynamicVideoQueueFrames = clampVideoQueueFrames(configuredVideoQueueFrames);
    applyVideoJitterBufferTarget("Initial video track attachment");
  }

  if (track.kind === "audio" && videoElem) {
    videoElem.muted = false;
  }

  const startPlayback = () => {
    if (receiver && track.kind === "video") {
      startReceiverBufferLogging(receiver, track);
    }

    const playPromise = videoElem?.play?.();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        log("video.play error: " + err);
      });
    }
  };

  if (typeof track.addEventListener === "function") {
    track.addEventListener("unmute", startPlayback, { once: true });
  }

  startPlayback();
}

function setupDataChannel(conn) {
  dc = conn.createDataChannel("input");
  dc.onopen = () => {
    if (disconnecting) {
      return;
    }
    log("DataChannel open");
    startGamepadLoop();
  };
  dc.onclose = () => {
    stopGamepadLoop();
    log("DataChannel closed");
  };
  dc.onmessage = (ev) => {
    handleDataChannelMessage(ev.data);
  };
}

async function start() {
  const wsUrl = wsUrlInput?.value || "";
  const guestName = (guestNameInput?.value || "").trim();

  ws = new WebSocket(wsUrl);
  disconnecting = false;
  setConnectionUiLocked(true);
  setButtonLabel("切断");

  ws.onopen = async () => {
    hasConnectedOnce = true;
    persistGuestSettings({ wsUrl, guestName });
    if (disconnecting) {
        ws.close();
        return;
    }
    log("WebSocket open");

    if (guestName !== "") {
      sendGuestName(guestName);
    }

    pc = createPeerConnection();
    setupIceHandlers(pc);
    setupTrackHandlers(pc);
    setupDataChannel(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
      type: "offer",
      sdp: offer.sdp
    }));
  };

  ws.onmessage = async (event) => {
    if (disconnecting) {
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.type === "answer") {
      log("Received answer");
      const desc = new RTCSessionDescription({
        type: "answer",
        sdp: msg.sdp
      });
      await pc.setRemoteDescription(desc);
    } else if (msg.type === "welcome") {
      clientId = msg.client_id;
      log("Received client id from host: " + clientId);
    } else if (msg.type === "disconnect") {
      handleRemoteDisconnect(msg.reason || "Host requested disconnect");
    } else if (msg.type === "candidate") {
      log("Received candidate from host");
      const normalized = normalizeCandidate(msg.candidate);
      try {
        await pc.addIceCandidate(normalized);
      } catch (err) {
        log("addIceCandidate error: " + err);
      }
    }
  };

  ws.onerror = (e) => {
    log("WebSocket error: " + e);
    handleRemoteDisconnect("WebSocket error");
  };

  ws.onclose = () => {
    log("WebSocket closed");
    if (bufferLogTimer !== null) {
      clearInterval(bufferLogTimer);
      bufferLogTimer = null;
    }
    if (!disconnecting) {
      setButtonLabel("接続");
      resetState();
    }
    setConnectionUiLocked(false);
    scheduleReload();
  };
}

restoreGuestSettings();

document.getElementById("connect-btn").onclick = () => {
  if (ws || pc) {
    disconnect();
  } else {
    start();
  }
};


if (refreshGamepadsBtn) {
  refreshGamepadsBtn.onclick = refreshGamepadOptions;
}

if (gamepadSelect) {
  gamepadSelect.onchange = (event) => {
    const { value } = event.target;
    selectedGamepadIndex = value === "" ? null : Number(value);
    if (Number.isNaN(selectedGamepadIndex)) {
      selectedGamepadIndex = null;
    }
    persistGuestSettings();
  };
}

if (guestNameInput) {
  guestNameInput.onchange = (event) => {
    const nextName = (event.target.value || "").trim();
    sendGuestName(nextName);
    persistGuestSettings({ guestName: nextName });
  };
}

if (wsUrlInput) {
  wsUrlInput.onchange = (event) => {
    persistGuestSettings({ wsUrl: event.target.value });
  };
}

if (videoBufferFramesInput) {
  videoBufferFramesInput.onchange = (event) => {
    const parsed = clampVideoQueueFrames(Number(event.target.value));
    videoBufferFramesInput.value = parsed;
    setConfiguredVideoQueueFrames(parsed, "Manual video buffer update");
    persistGuestSettings({ videoQueueFrames: parsed });
  };
}

window.addEventListener("gamepadconnected", (event) => {
  log(`Gamepad connected: ${event.gamepad.id} (index ${event.gamepad.index})`);
  refreshGamepadOptions();
});

window.addEventListener("gamepaddisconnected", (event) => {
  log(`Gamepad disconnected: ${event.gamepad.id} (index ${event.gamepad.index})`);
  if (event.gamepad.index === selectedGamepadIndex) {
    selectedGamepadIndex = null;
  }
  refreshGamepadOptions();
});

refreshGamepadOptions();



function startGamepadLoop() {
  if (gamepadLoopId !== null) {
    return;
  }

  const pollIntervalMs = 10;
  lastGamepadPayload = null;

  const loop = () => {
    if (!dc || dc.readyState !== "open" || disconnecting) {
      gamepadLoopId = null;
      return;
    }

    const gamepadState = serializeGamepad(getSelectedGamepad());
    if (!gamepadState) {
      gamepadLoopId = setTimeout(loop, pollIntervalMs);
      return;
    }

    const payload = { type: "gamepad", gamepad: gamepadState };
    const serialized = JSON.stringify(payload);
    if (serialized !== lastGamepadPayload) {
      try {
        dc.send(serialized);
        lastGamepadPayload = serialized;
      } catch (err) {
        log("Failed to send gamepad state: " + err);
      }
    }

    gamepadLoopId = setTimeout(loop, pollIntervalMs);
  };

  gamepadLoopId = setTimeout(loop, pollIntervalMs);
}

function stopGamepadLoop() {
  if (gamepadLoopId !== null) {
    clearTimeout(gamepadLoopId);
    gamepadLoopId = null;
  }
  lastGamepadPayload = null;
}

function refreshGamepadOptions() {
  if (!gamepadSelect) {
    return;
  }

  if (!navigator.getGamepads) {
    gamepadSelect.innerHTML = "<option>Gamepad API がサポートされていません</option>";
    gamepadSelect.disabled = true;
    selectedGamepadIndex = null;
    return;
  }

  const pads = navigator.getGamepads();
  const available = Array.from(pads).filter(Boolean);

  gamepadSelect.innerHTML = "";

  if (available.length === 0) {
    const option = document.createElement("option");
    option.textContent = "接続されたゲームパッドはありません";
    option.value = "";
    gamepadSelect.appendChild(option);
    gamepadSelect.disabled = true;
    selectedGamepadIndex = null;
    return;
  }

  gamepadSelect.disabled = false;

  let nextSelectedIndex = selectedGamepadIndex;
  if (nextSelectedIndex === null || !pads[nextSelectedIndex]) {
    nextSelectedIndex = available[0].index;
  }

  for (const pad of available) {
    const option = document.createElement("option");
    option.value = pad.index;
    option.textContent = `${pad.id} (index ${pad.index})`;
    if (pad.index === nextSelectedIndex) {
      option.selected = true;
    }
    gamepadSelect.appendChild(option);
  }

  selectedGamepadIndex = nextSelectedIndex;
  gamepadSelect.disabled = uiLocked || gamepadSelect.disabled;
  persistGuestSettings();
}

function getSelectedGamepad() {
  if (!navigator.getGamepads) {
    return null;
  }

  const pads = navigator.getGamepads();

  if (selectedGamepadIndex !== null) {
    const selected = pads[selectedGamepadIndex];
    if (selected) {
      return selected;
    }
  }

  for (const pad of pads) {
    if (pad) {
      selectedGamepadIndex = pad.index;
      if (gamepadSelect) {
        gamepadSelect.value = String(pad.index);
      }
      return pad;
    }
  }

  return null;
}

function serializeGamepad(gp) {
  if (!gp) {
    return null;
  }

  return {
    id: gp.id,
    index: gp.index,
    buttons: gp.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
    axes: Array.from(gp.axes),
    connected: gp.connected,
    mapping: gp.mapping,
    timestamp: gp.timestamp,
  };
}

function handleDataChannelMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg?.type === "ping" && typeof msg.sent_at === "number") {
      sendPong(msg.sent_at);
      return;
    }
  } catch (err) {
    log("recv from host: " + raw);
    return;
  }

  log("recv from host: " + raw);
}

function sendPong(sentAt) {
  if (!dc || dc.readyState !== "open" || disconnecting) {
    return;
  }

  const payload = { type: "pong", sent_at: sentAt };
  try {
    dc.send(JSON.stringify(payload));
  } catch (err) {
    log("Failed to send pong: " + err);
  }
}


function handleRemoteDisconnect(reason) {
  if (disconnecting) {
    return;
  }
  disconnecting = true;
  log("Disconnecting: " + reason);
  if (pc) {
    pc.getSenders().forEach((sender) => sender.track && sender.track.stop());
    pc.close();
  }
  if (dc) {
    dc.close();
  }
  if (bufferLogTimer !== null) {
    clearInterval(bufferLogTimer);
    bufferLogTimer = null;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  setButtonLabel("接続");
  resetState();
  setConnectionUiLocked(false);
  scheduleReload();
}

function disconnect() {
  if (disconnecting || (!ws && !pc)) {
    return;
  }
  disconnecting = true;
  stopGamepadLoop();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "disconnect", reason: "Guest requested" }));
    ws.close();
  }
  if (pc) {
    pc.close();
  }
  if (bufferLogTimer !== null) {
    clearInterval(bufferLogTimer);
    bufferLogTimer = null;
  }
  setButtonLabel("接続");
  resetState();
  setConnectionUiLocked(false);
  scheduleReload();
}

function sendGuestName(name) {
  if (disconnecting || !ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type: "name", name }));
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }

  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? candidate.sdp_mid,
    sdpMLineIndex: candidate.sdpMLineIndex ?? candidate.sdp_mline_index,
    usernameFragment: candidate.usernameFragment ?? candidate.username_fragment,
  };
}

function startReceiverBufferLogging(receiver, track) {
  if (bufferLogTimer !== null) {
    clearInterval(bufferLogTimer);
    bufferLogTimer = null;
  }

  if (!receiver || typeof receiver.getStats !== "function") {
    log("Receiver stats unavailable; cannot log jitter buffer");
    return;
  }

  let lastVideoFpsSample = null;
  lastInboundVideoStats = null;
  updateVideoFrameRateEstimate(track);
  logVideoBufferUpdate("Starting jitter buffer logging");

  bufferLogTimer = setInterval(async () => {
    try {
      updateVideoFrameRateEstimate(track);
      const stats = await receiver.getStats();
      let logged = false;
      stats.forEach((report) => {
        if (
          report.type === "inbound-rtp" &&
          (report.kind === "video" || report.mediaType === "video")
        ) {
          logged = true;
          const emitted = Number(report.jitterBufferEmittedCount ?? 0);
          const delaySeconds = Number(report.jitterBufferDelay ?? 0);
          if (emitted > 0) {
            const avgMs = (delaySeconds / emitted) * 1000;
            const totalMs = delaySeconds * 1000;
            log(
              `Receiver jitter buffer avg=${avgMs.toFixed(2)} ms (total=${totalMs.toFixed(2)} ms / emitted=${emitted})`
            );
          } else {
            log(
              `Receiver jitter buffer delay=${(delaySeconds * 1000).toFixed(2)} ms (emitted=${emitted})`
            );
          }

          const framesDecoded = Number(report.framesDecoded ?? report.framesReceived ?? 0);
          const timestampMs = Number(report.timestamp ?? 0);
          const packetsReceived = Number(report.packetsReceived ?? 0);
          const packetsLost = Number(report.packetsLost ?? 0);
          const nackCount = Number(report.nackCount ?? report.nacksReceived ?? 0);
          const retransmissions = Number(report.retransmittedPacketsReceived ?? 0);

          if (
            lastVideoFpsSample &&
            Number.isFinite(framesDecoded) &&
            Number.isFinite(timestampMs) &&
            timestampMs > lastVideoFpsSample.timestampMs
          ) {
            const deltaFrames = framesDecoded - lastVideoFpsSample.framesDecoded;
            const deltaMs = timestampMs - lastVideoFpsSample.timestampMs;
            if (deltaFrames >= 0 && deltaMs > 0) {
              const fps = (deltaFrames * 1000) / deltaMs;
              log(
                `Receiver video FPS=${fps.toFixed(2)} (frames=${deltaFrames}, ${(deltaMs / 1000).toFixed(2)}s)`
              );
            }
          }

          if (lastInboundVideoStats) {
            const deltaReceived = Math.max(
              0,
              packetsReceived - lastInboundVideoStats.packetsReceived
            );
            const deltaLost = Math.max(0, packetsLost - lastInboundVideoStats.packetsLost);
            const deltaNack = Math.max(0, nackCount - lastInboundVideoStats.nackCount);
            const deltaRetrans = Math.max(
              0,
              retransmissions - lastInboundVideoStats.retransmissions
            );
            const total = deltaReceived + deltaLost;
            const lossRate = total > 0 ? Math.max(0, deltaLost) / total : 0;
            adjustVideoJitterBufferFromStats(lossRate, deltaNack, deltaRetrans);
          }

          if (Number.isFinite(framesDecoded) && Number.isFinite(timestampMs)) {
            lastVideoFpsSample = { framesDecoded, timestampMs };
          }

          lastInboundVideoStats = {
            packetsReceived,
            packetsLost,
            nackCount,
            retransmissions,
          };
        }
      });

      if (!logged) {
        log("No inbound video stats found for jitter buffer logging");
      }
    } catch (err) {
      log("Failed to fetch receiver stats: " + err);
    }
  }, 1000);
}
// Restore saved log and set up log control buttons
(function initLogControls() {
  try {
    const saved = localStorage.getItem(LOG_STORAGE_KEY);
    if (saved) {
      logBuffer = saved;
      logElem.textContent = saved;
    }
  } catch (e) {
    // ignore
  }

  if (clearLogBtn) {
    clearLogBtn.addEventListener("click", () => {
      logBuffer = "";
      logElem.textContent = "";
      try {
        localStorage.removeItem(LOG_STORAGE_KEY);
      } catch (e) {
        // ignore
      }
    });
  }

  if (saveLogBtn) {
    saveLogBtn.addEventListener("click", () => {
      const text = logBuffer || logElem.textContent || "";
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `guest-log-${ts}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }
})();
