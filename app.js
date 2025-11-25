
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

const logElem = document.getElementById("log");
const videoElem = document.getElementById("video");

function restoreLogFromStorage() {
  if (!logElem) return;
  try {
    const stored = localStorage.getItem(LOG_STORAGE_KEY);
    if (stored) {
      logElem.textContent = stored;
      console.log("Restored previous log from storage");
    }
  } catch (err) {
    console.warn("Failed to restore log", err);
  }
}


const gamepadSelect = document.getElementById("gamepad-select");
const refreshGamepadsBtn = document.getElementById("refresh-gamepads-btn");
const guestNameInput = document.getElementById("guest-name");
const wsUrlInput = document.getElementById("ws-url");

if (videoElem) {
  ["pause", "playing", "waiting", "stalled", "ended"].forEach((ev) => {
    videoElem.addEventListener(ev, () => log("video event: " + ev));
  });
  videoElem.addEventListener("error", () => {
    const err = videoElem.error;
    log("video event: error " + (err ? err.message : ""));
  });
}

function log(msg) {
  console.log(msg);
  if (logElem) {
    logElem.textContent += msg + "\n";
  }
  try {
    const prev = localStorage.getItem(LOG_STORAGE_KEY) || "";
    let next = prev + msg + "\n";
    const maxLen = 100000;
    if (next.length > maxLen) {
      next = next.slice(next.length - maxLen);
    }
    localStorage.setItem(LOG_STORAGE_KEY, next);
  } catch (err) {
    console.warn("Failed to persist log", err);
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

function persistGuestSettings(overrides = {}) {
  const current = loadSavedSettings();
  const next = {
    ...current,
    wsUrl: wsUrlInput?.value || current.wsUrl,
    guestName: guestNameInput?.value || current.guestName,
    gamepadIndex: selectedGamepadIndex,
    ...overrides,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("Failed to save guest settings", err);
  }
}

function restoreGuestSettings() {
  const saved = loadSavedSettings();
  if (wsUrlInput && typeof saved.wsUrl === "string") {
    wsUrlInput.value = saved.wsUrl;
  }
  if (guestNameInput && typeof saved.guestName === "string") {
    guestNameInput.value = saved.guestName;
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

function setButtonLabel(label) {
  document.getElementById("connect-btn").textContent = label;
}

function setConnectionUiLocked(locked) {
  uiLocked = locked;
  const wsUrlInput = document.getElementById("ws-url");

if (videoElem) {
  ["pause", "playing", "waiting", "stalled", "ended"].forEach((ev) => {
    videoElem.addEventListener(ev, () => log("video event: " + ev));
  });
  videoElem.addEventListener("error", () => {
    const err = videoElem.error;
    log("video event: error " + (err ? err.message : ""));
  });
}
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

    pc = new RTCPeerConnection({
      iceServers: []
    });

    pc.onicecandidate = (e) => {
      if (disconnecting || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (e.candidate) {
        ws.send(JSON.stringify({
          type: "candidate",
          candidate: e.candidate.toJSON()
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      log("pc.connectionState=" + pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      log("pc.iceConnectionState=" + pc.iceConnectionState);
    };

    pc.ontrack = (event) => {
      if (event.track) {
        event.track.onmute = () => log("track muted: " + event.track.kind);
        event.track.onunmute = () => log("track unmuted: " + event.track.kind);
        event.track.onended = () => log("track ended: " + event.track.kind);
      }

      log("ontrack: kind=" + event.track.kind + ", streams=" + event.streams.length);

      if (event.receiver && "playoutDelayHint" in event.receiver) {
        try {
          event.receiver.playoutDelayHint = 0;
          log("Set receiver playoutDelayHint to 0");
        } catch (err) {
          log("Failed to set playoutDelayHint: " + err);
        }
      }

      if (event.track.kind === "video") {
        startReceiverBufferLogging(event.receiver);
      }

      if (!remoteStream) {
        remoteStream = new MediaStream();
        videoElem.srcObject = remoteStream;
      }

      if (!remoteStream.getTracks().includes(event.track)) {
        remoteStream.addTrack(event.track);
      }

      if (event.track.kind === "audio") {
        videoElem.muted = false;
      }

      const p = videoElem.play();
      if (p !== undefined) {
        p.catch((err) => {
          log("video.play error: " + err);
        });
      }
    };

    // ホストからの映像を受信したいことを SDP に表明
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    // DataChannel（テスト用）
    dc = pc.createDataChannel("input");
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

restoreLogFromStorage();

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

function startReceiverBufferLogging(receiver) {
  if (bufferLogTimer !== null) {
    clearInterval(bufferLogTimer);
    bufferLogTimer = null;
  }

  if (!receiver || typeof receiver.getStats !== "function") {
    log("Receiver stats unavailable; cannot log jitter buffer");
    return;
  }

  let lastVideoFpsSample = null;
  let zeroFpsCount = 0;

  bufferLogTimer = setInterval(async () => {
    try {
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
          const packetsReceived = Number(report.packetsReceived ?? 0);
          const packetsLost = Number(report.packetsLost ?? 0);
          const framesDecoded = Number(report.framesDecoded ?? report.framesReceived ?? 0);
          const framesDropped = Number(report.framesDropped ?? 0);
          const freezeCount = Number(report.freezeCount ?? 0);
          const totalDecodeTime = Number(report.totalDecodeTime ?? 0);
          const jitter = Number(report.jitter ?? 0);
          const timestampMs = Number(report.timestamp ?? 0);

          if (emitted > 0) {
            const avgMs = (delaySeconds / emitted) * 1000;
            const totalMs = delaySeconds * 1000;
            log(
              `Receiver jitter buffer avg=${avgMs.toFixed(2)} ms (total=${totalMs.toFixed(
                2
              )} ms / emitted=${emitted})`
            );
          } else {
            log(
              `Receiver jitter buffer delay=${(delaySeconds * 1000).toFixed(
                2
              )} ms (emitted=${emitted})`
            );
          }

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
                `Receiver video FPS=${fps.toFixed(2)} (frames=${deltaFrames}, ${(deltaMs / 1000).toFixed(
                  2
                )}s)`
              );

              if (fps < 0.5) {
                zeroFpsCount += 1;
              } else {
                zeroFpsCount = 0;
              }

              if (zeroFpsCount >= 5) {
                log("Video seems frozen (FPS ~0 for 5s); disconnecting and scheduling reload");
                if (!disconnecting) {
                  disconnect();
                }
                return;
              }
            }
          }

          if (Number.isFinite(framesDecoded) && Number.isFinite(timestampMs)) {
            lastVideoFpsSample = { framesDecoded, timestampMs };
          }

          log(
            `Receiver video stats: packetsReceived=${packetsReceived}, packetsLost=${packetsLost}, ` +
              `framesDecoded=${framesDecoded}, framesDropped=${framesDropped}, freezeCount=${freezeCount}, ` +
              `totalDecodeTime=${totalDecodeTime.toFixed ? totalDecodeTime.toFixed(3) : totalDecodeTime}, ` +
              `jitter=${jitter}`
          );
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
