"use strict";

// Change this manually when intentionally breaking Host/Guest compatibility.
// Do not auto-increment this value for ordinary code changes.
const PROTOCOL_VERSION = "1";

const CONNECTION_TIMEOUT_MS = 45_000;
const WELCOME_TIMEOUT_MS = 10_000;
const AUDIO_JITTER_TARGET_MS = 20;
const VIDEO_JITTER_TARGET_MS = 4;
const VIDEO_PLAYOUT_DELAY_SECONDS = VIDEO_JITTER_TARGET_MS / 1_000;
const RECONNECT_GRACE_MS = 5_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;
const NETWORK_FEEDBACK_INTERVAL_MS = 2_000;
const MAX_INPUT_BUFFER_BYTES = 64 * 1024;
const VIDEO_STALL_MS = 2_000;
const VIDEO_STALL_REQUEST_COOLDOWN_MS = 3_000;
const NETWORK_MODES = ["auto", "ipv6_direct", "stun"];
const MAX_EXTERNAL_POOL_CANDIDATES = 32;

const byId = (id) => document.getElementById(id);
const element = {
  form: byId("form"),
  name: byId("name"),
  url: byId("url"),
  error: byId("error"),
  connect: byId("connect"),
  connectText: byId("connectText"),
  badge: byId("badge"),
  badgeText: byId("badgeText"),
  video: byId("video"),
  audioOut: byId("audioOut"),
  stage: byId("stage"),
  stageTitle: byId("stageTitle"),
  stageDetail: byId("stageDetail"),
  audio: byId("audio"),
  resync: byId("resync"),
  fullscreen: byId("fullscreen"),
  mobileMode: byId("mobileMode"),
  mobilePad: byId("mobilePad"),
  gamepad: byId("gamepad"),
  gamepadHelp: byId("gamepadHelp"),
  inputPulse: byId("inputPulse"),
  rtt: byId("rtt"),
  buffer: byId("buffer"),
  fps: byId("fps"),
  loss: byId("loss"),
  display: byId("display"),
  resolution: byId("resolution"),
  protocolVersion: byId("protocolVersion"),
};

const lowPower =
  (navigator.hardwareConcurrency || 4) <= 4 ||
  (navigator.deviceMemory || 8) <= 4 ||
  matchMedia("(pointer: coarse)").matches;

const state = {
  generation: 0,
  websocket: null,
  peer: null,
  inputChannel: null,
  controlChannel: null,
  videoStream: null,
  audioStream: null,
  remoteCandidates: [],
  hostNetworkMode: null,
  hostStunServers: [],
  lastGoodExternalReported: false,
  baseUrl: null,
  traversalSession: null,
  guestName: "",
  connected: false,
  manual: false,
  retrying: false,
  peerStarting: false,
  videoStarted: false,
  lastVideoFrameAt: 0,
  lastDecodedFrameAt: 0,
  lastStallRequestAt: 0,
  frameCallbackId: null,
  connectionTimer: null,
  welcomeTimer: null,
  reconnectTimer: null,
  retryTimer: null,
  reconnectAttempt: 0,
  statsTimer: null,
  syncTimer: null,
  padFrame: null,
  padIndex: null,
  padChoiceExplicit: false,
  lockedPad: null,
  padSignature: "",
  lastPad: null,
  lastPadAt: 0,
  lastInputAt: 0,
  inputActive: false,
  previousInbound: null,
  previousFeedback: null,
  nextFeedbackAt: 0,
  measuredRttMs: null,
  mobile: false,
  virtualButtons: new Array(16).fill(0),
  virtualCounts: new Array(16).fill(0),
  virtualPointers: new Map(),
};

function setStatus(kind, label, title, detail) {
  element.badge.dataset.state = kind;
  element.badgeText.textContent = label;
  if (title) element.stageTitle.textContent = title;
  if (detail) element.stageDetail.textContent = detail;
}

function connectionActive() {
  return Boolean(
    state.connected || state.websocket || state.peer || state.retryTimer || state.retrying,
  );
}

function retryDelay(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, attempt - 1)));
}

function setControls(active) {
  element.connect.dataset.action = active ? "disconnect" : "connect";
  element.connectText.textContent = active ? "切断する" : "ホストへ接続";
  element.name.disabled = active;
  element.gamepad.disabled = active;
  element.url.disabled = active;
  element.mobileMode.disabled = active;
  element.audio.disabled = !active;
  element.resync.disabled = !active;
  element.fullscreen.disabled = !active;
}

function normalizeWebSocketUrl(raw) {
  let value = raw.trim();
  if (!value) throw new Error("公開接続URLを入力してください。");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    value = `${location.protocol === "https:" ? "wss" : "ws"}://${value}`;
  }

  const url = new URL(value);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("URLは wss:// または ws:// で入力してください。");
  }
  if (location.protocol === "https:" && url.protocol === "ws:") {
    throw new Error("HTTPSページではwss://の公開接続URLが必要です。");
  }
  if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
  url.hash = "";
  return url.toString();
}

function sendSignal(payload) {
  if (state.websocket?.readyState !== WebSocket.OPEN) return false;
  state.websocket.send(JSON.stringify(payload));
  return true;
}

function sendChannel(channel, payload, bounded = true) {
  if (channel?.readyState !== "open") return false;
  if (bounded && channel.bufferedAmount > MAX_INPUT_BUFFER_BYTES) return false;
  try {
    channel.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    console.warn("DataChannel send failed", error);
    return false;
  }
}

function sendInput(payload) {
  return sendChannel(state.inputChannel, payload);
}

function requestKeyframe(reason) {
  return sendInput({ type: "keyframe_request", reason });
}

function requestSyncFrame(reason) {
  return sendInput({ type: "sync_frame", reason });
}

function configureReceiverLatency(receiver) {
  // Audio cannot use the video path's zero-buffer policy. A zero target makes
  // the browser's audio renderer underrun on ordinary packet/scheduler jitter,
  // which is heard as continuous crackle or noise. Match the Rust guest's
  // initial 20 ms Opus cushion while still allowing the browser to grow the
  // buffer when the network needs it.
  if (receiver.track?.kind === "audio") {
    try {
      if ("jitterBufferTarget" in receiver) {
        receiver.jitterBufferTarget = AUDIO_JITTER_TARGET_MS;
      }
    } catch (error) {
      console.debug(`audio jitterBufferTarget=${AUDIO_JITTER_TARGET_MS} was rejected`, error);
    }
    return;
  }

  // Remote play prefers freshness over smooth playout. Ask Chromium for only
  // a few milliseconds of explicit video cushion. jitterBufferTarget is the
  // modern control; use playoutDelayHint only as a fallback instead of setting
  // two overlapping delay hints on the same receiver.
  let configured = false;
  try {
    if ("jitterBufferTarget" in receiver) {
      receiver.jitterBufferTarget = VIDEO_JITTER_TARGET_MS;
      configured = true;
    }
  } catch (error) {
    console.debug(`video jitterBufferTarget=${VIDEO_JITTER_TARGET_MS} was rejected`, error);
  }
  if (!configured) {
    try {
      if ("playoutDelayHint" in receiver) {
        receiver.playoutDelayHint = VIDEO_PLAYOUT_DELAY_SECONDS;
      }
    } catch (error) {
      console.debug(`video playoutDelayHint=${VIDEO_PLAYOUT_DELAY_SECONDS} was rejected`, error);
    }
  }
}

function preferH264(transceiver) {
  try {
    const codecs = RTCRtpReceiver.getCapabilities?.("video")?.codecs || [];
    const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264");
    const preferred = h264.filter((codec) =>
      codec.sdpFmtpLine?.includes("packetization-mode=1"),
    );
    const remaining = h264.filter((codec) => !preferred.includes(codec));
    if (h264.length && transceiver.setCodecPreferences) {
      transceiver.setCodecPreferences([...preferred, ...remaining]);
    }
  } catch (error) {
    console.warn("H.264 codec preference was rejected", error);
  }
}

function iceServersForMode(networkMode, stunServers) {
  if (networkMode === "ipv6_direct") return [];
  return [
    {
      urls: stunServers.length
        ? stunServers
        : ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
    },
  ];
}

async function createPeer(generation, networkMode, stunServers) {
  if (generation !== state.generation || state.peer || state.peerStarting) return;
  state.peerStarting = true;

  try {
    const peer = new RTCPeerConnection({
      iceServers: iceServersForMode(networkMode, stunServers),
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });
    state.peer = peer;
    state.videoStream = new MediaStream();
    state.audioStream = new MediaStream();
    element.video.srcObject = state.videoStream;
    element.audioOut.srcObject = state.audioStream;

    peer.onicecandidate = ({ candidate }) => {
      if (generation !== state.generation || !candidate) return;
      sendSignal({ type: "candidate", candidate: candidate.toJSON() });
    };

    peer.ontrack = ({ track, receiver }) => {
      if (generation !== state.generation) return;
      configureReceiverLatency(receiver);
      if (track.kind === "video") {
        addTrackOnce(state.videoStream, track);
        element.video.play().catch(onVideoAutoplayBlocked);
        monitorVideoFrames(generation);
      } else if (track.kind === "audio") {
        addTrackOnce(state.audioStream, track);
        if (!element.audioOut.muted) {
          element.audioOut.play().catch(onAudioAutoplayBlocked);
        }
      }
    };

    peer.onconnectionstatechange = () => handlePeerState(generation, peer);

    const input = peer.createDataChannel("input", {
      ordered: false,
      maxPacketLifeTime: 50,
    });
    const control = peer.createDataChannel("control", { ordered: true });
    state.inputChannel = input;
    state.controlChannel = control;
    configureInputChannel(input, generation);
    configureControlChannel(control, generation);

    const video = peer.addTransceiver("video", { direction: "recvonly" });
    preferH264(video);
    peer.addTransceiver("audio", { direction: "recvonly" });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (generation === state.generation) {
      sendSignal({ type: "offer", sdp: peer.localDescription.sdp });
    }
  } finally {
    state.peerStarting = false;
  }
}

function addTrackOnce(stream, track) {
  if (!stream.getTracks().some((current) => current.id === track.id)) {
    stream.addTrack(track);
  }
}

function handlePeerState(generation, peer) {
  if (generation !== state.generation) return;
  switch (peer.connectionState) {
    case "connected":
      clearTimeout(state.connectionTimer);
      clearTimeout(state.reconnectTimer);
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      state.reconnectAttempt = 0;
      state.retrying = false;
      element.error.textContent = "";
      state.connected = true;
      setControls(true);
      setStatus("connected", "接続済み", "映像を受信しています", "WebRTC接続が確立しました");
      peer.getReceivers().forEach(configureReceiverLatency);
      startStats();
      break;
    case "connecting":
      setStatus("connecting", "接続中", "映像経路を確立しています", "ICE接続を確認しています");
      break;
    case "disconnected":
      state.connected = false;
      setStatus("connecting", "再接続中", "通信が一時中断しました", "ネットワークの復帰を待っています");
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => {
        if (generation === state.generation && peer.connectionState === "disconnected") {
          void fail("WebRTC接続が復帰しませんでした。再接続してください。");
        }
      }, RECONNECT_GRACE_MS);
      break;
    case "failed":
      void fail("WebRTC接続に失敗しました。URLとネットワークを確認してください。");
      break;
    case "closed":
      if (!state.manual) void fail("WebRTC接続が終了しました。");
      break;
    default:
      break;
  }
}

function configureInputChannel(channel, generation) {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 16 * 1024;
  channel.onopen = () => {
    if (generation !== state.generation) return;
    sendInput({ type: "decoder_status", backend: "browser" });
    requestInitialKeyframes(generation);
    startPadPolling();
  };
  channel.onclose = () => {
    if (generation === state.generation && !state.manual) {
      void fail("入力チャンネルが切断されました。");
    }
  };
}

function configureControlChannel(channel, generation) {
  channel.binaryType = "arraybuffer";
  channel.onmessage = async (event) => {
    if (generation !== state.generation) return;
    try {
      const message = JSON.parse(await messageText(event.data));
      if (message.type === "ping" && Number.isFinite(message.sent_at)) {
        if (Number.isFinite(message.rtt_ms)) {
          state.measuredRttMs = Math.max(1, message.rtt_ms);
        }
        sendInput({ type: "pong", sent_at: message.sent_at });
      } else if (message.type === "disconnect") {
        await acknowledgeDisconnect(channel);
        await stop(false, message.reason || "ホストから切断されました");
      }
    } catch (error) {
      console.warn("Unknown reliable control message", error);
    }
  };
  channel.onclose = () => {
    if (generation === state.generation && !state.manual) {
      void fail("制御チャンネルが切断されました。");
    }
  };
}

async function acknowledgeDisconnect(channel) {
  if (!sendChannel(channel, { type: "disconnect_ack" }, false)) return;
  const deadline = performance.now() + 100;
  while (
    channel.readyState === "open" &&
    channel.bufferedAmount > 0 &&
    performance.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  return new TextDecoder().decode(data);
}

function requestInitialKeyframes(generation) {
  clearInterval(state.syncTimer);
  let attempts = 0;
  const request = () => {
    if (generation !== state.generation || state.videoStarted || attempts >= 3) {
      clearInterval(state.syncTimer);
      return;
    }
    attempts += 1;
    requestKeyframe("browser_data_channel_open");
  };
  request();
  state.syncTimer = setInterval(request, 250);
}

function externalPoolCandidates(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value.trim());
    if (!match) continue;
    const ip = match[1];
    const port = Number(match[2]);
    if (!isPublicIpv4(ip) || port < 1 || port > 65535 || seen.has(value)) continue;
    seen.add(value);
    const priority = 1694498815 - result.length;
    result.push({
      candidate: `candidate:rpweb${result.length} 1 udp ${priority} ${ip} ${port} typ srflx`,
      sdpMid: "0",
      sdpMLineIndex: 0,
      _remotePlayExternal: true,
    });
    if (result.length >= MAX_EXTERNAL_POOL_CANDIDATES) break;
  }
  return result;
}

function isPublicIpv4(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function handleSignal(raw, generation) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (generation !== state.generation) return;

  switch (message.type) {
    case "welcome": {
      if (typeof message.protocol_version !== "string") {
        await fatal(`このHostは内部バージョン確認に対応していません。旧Hostは接続できません。Guest version=${PROTOCOL_VERSION}`);
        return;
      }
      if (message.protocol_version !== PROTOCOL_VERSION) {
        await fatal(`内部バージョンが一致しません。Host=${message.protocol_version} / Guest=${PROTOCOL_VERSION}`);
        return;
      }
      const mode = String(message.network_mode || "auto").toLowerCase();
      if (!NETWORK_MODES.includes(mode)) {
        await fatal("ホストから未対応の接続方式が通知されました。HostとGuestを同じ版にしてください。");
        return;
      }
      if (state.hostNetworkMode && state.hostNetworkMode !== mode) {
        await fatal("接続中にホストの接続方式が変更されました。一度切断して再接続してください。");
        return;
      }
      state.hostNetworkMode = mode;
      state.hostStunServers = Array.isArray(message.stun_servers)
        ? message.stun_servers.filter((url) => typeof url === "string" && url.startsWith("stun:"))
        : [];
      clearTimeout(state.welcomeTimer);
      clearTimeout(state.connectionTimer);
      state.connectionTimer = setTimeout(() => {
        if (generation === state.generation && !state.connected) {
          void fail(`${mode} の接続がタイムアウトしました。`);
        }
      }, CONNECTION_TIMEOUT_MS);
      setStatus("connecting", "接続中", "接続方式を準備しています", `ホスト設定: ${mode}`);
      await createPeer(generation, mode, state.hostStunServers);
      break;
    }
    case "answer":
      if (!state.peer || !message.sdp) return;
      await state.peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
      for (const candidate of state.remoteCandidates.splice(0)) {
        try {
          await state.peer.addIceCandidate(candidate);
        } catch (error) {
          if (!candidate._remotePlayExternal) throw error;
          console.warn("Host external STUN candidate was rejected", candidate.candidate, error);
        }
      }
      break;
    case "candidate":
      if (!state.peer || !message.candidate) return;
      if (state.peer.remoteDescription) {
        await state.peer.addIceCandidate(message.candidate);
      } else {
        state.remoteCandidates.push(message.candidate);
      }
      break;
    case "external_candidate_pool": {
      const candidates = externalPoolCandidates(message.candidates);
      for (const candidate of candidates) {
        if (state.peer?.remoteDescription) {
          try {
            await state.peer.addIceCandidate(candidate);
          } catch (error) {
            console.warn("Host external STUN candidate was rejected", candidate.candidate, error);
          }
        } else {
          state.remoteCandidates.push(candidate);
        }
      }
      break;
    }
    case "error":
      await fatal(message.message || `ホストが接続を拒否しました (${message.code || "unknown"})`);
      break;
    case "disconnect":
      await stop(false, message.reason || "ホストから切断されました");
      break;
    default:
      break;
  }
}

async function openRouteAttempt() {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  const generation = ++state.generation;
  state.manual = false;
  state.retrying = false;
  state.hostNetworkMode = null;
  state.hostStunServers = [];
  state.lastGoodExternalReported = false;
  state.remoteCandidates = [];
  state.videoStarted = false;
  state.lastVideoFrameAt = 0;
  state.lastDecodedFrameAt = 0;
  state.lastStallRequestAt = 0;
  element.stage.classList.remove("has-video");
  setControls(true);
  setStatus(
    "connecting",
    state.reconnectAttempt > 0 ? `再試行 ${state.reconnectAttempt}` : "接続中",
    "ホストへ接続しています",
    state.reconnectAttempt > 0
      ? `同じSTUNセッションで再接続しています（${state.reconnectAttempt}回目）`
      : "WebSocketシグナリングを開始しています",
  );

  try {
    const signalingUrl = new URL(state.baseUrl);
    if (state.traversalSession) signalingUrl.searchParams.set("rp_session", state.traversalSession);
    state.websocket = new WebSocket(signalingUrl);
  } catch (error) {
    await fail(error.message);
    return;
  }

  state.connectionTimer = setTimeout(() => {
    if (generation === state.generation && !state.connected) {
      void fail("接続がタイムアウトしました。URLとネットワークを確認してください。");
    }
  }, CONNECTION_TIMEOUT_MS);

  state.websocket.onopen = () => {
    if (generation !== state.generation) return;
    // Hello must be the first text signal. Host intentionally rejects older
    // browser/Rust Guests that do not identify their internal protocol version.
    sendSignal({ type: "hello", protocol_version: PROTOCOL_VERSION });
    sendSignal({ type: "name", name: state.guestName });
    setStatus(
      "connecting",
      "接続中",
      "ホスト設定を待っています",
      `内部バージョン ${PROTOCOL_VERSION} を確認しています`,
    );
    state.welcomeTimer = setTimeout(() => {
      if (generation === state.generation && !state.hostNetworkMode) {
        void fail("ホストから接続方式が通知されませんでした。HostとGuestを同じ版にしてください。");
      }
    }, WELCOME_TIMEOUT_MS);
  };

  state.websocket.onmessage = ({ data }) => {
    void handleSignal(data, generation).catch((error) =>
      fail(`シグナリング処理に失敗しました: ${error.message}`),
    );
  };
  state.websocket.onerror = () => {
    if (!state.connected) element.error.textContent = "WebSocketへ接続できませんでした。URLを確認してください。";
  };
  state.websocket.onclose = () => {
    if (generation !== state.generation || state.manual) return;
    if (state.peer?.connectionState === "connected") {
      setStatus("connected", "接続済み", "映像を受信しています", "WebRTC接続は継続しています");
    } else {
      void fail("ホストとのシグナリング接続が終了しました。");
    }
  };
}

async function start() {
  element.error.textContent = "";
  let url;
  try {
    url = normalizeWebSocketUrl(element.url.value);
  } catch (error) {
    element.error.textContent = error.message;
    return;
  }

  const selectedPad = padSelection(element.gamepad.value);
  const name = element.name.value.trim() || "ブラウザゲスト";
  await teardown(false, false);
  state.baseUrl = url;
  state.traversalSession = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  state.reconnectAttempt = 0;
  state.guestName = name;
  state.lockedPad = selectedPad;
  state.padIndex = selectedPad;
  element.url.value = url;
  await openRouteAttempt();
}

async function stop(notify = true, reason = "切断しました") {
  await teardown(notify, true, reason);
}

async function fail(message) {
  if (state.manual || state.retrying) return;
  state.retrying = true;
  const nextAttempt = state.reconnectAttempt + 1;
  const delay = retryDelay(nextAttempt);
  await teardown(false, false, "", true);
  state.manual = false;
  state.retrying = true;
  state.reconnectAttempt = nextAttempt;
  element.error.textContent = `${message} 自動再試行します。`;
  setControls(true);
  setStatus(
    "connecting",
    `再試行 ${nextAttempt}`,
    "接続を再試行します",
    `${Math.ceil(delay / 1_000)}秒後に同じSTUNセッションで再接続します`,
  );
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.manual) return;
    void openRouteAttempt();
  }, delay);
}

async function fatal(message) {
  await teardown(false, false);
  element.error.textContent = message;
  setStatus("error", "接続失敗", "接続できませんでした", message);
}

async function teardown(notify, showIdle, reason = "切断しました", preserveSession = false) {
  const preserved = preserveSession
    ? {
        baseUrl: state.baseUrl,
        traversalSession: state.traversalSession,
        guestName: state.guestName,
        lockedPad: state.lockedPad,
        padIndex: state.padIndex,
        reconnectAttempt: state.reconnectAttempt,
      }
    : null;
  state.manual = true;
  state.connected = false;
  if (notify) sendSignal({ type: "disconnect", reason: "Browser guest disconnected" });
  sendPadDisconnected();
  state.generation += 1;

  clearTimeout(state.connectionTimer);
  clearTimeout(state.welcomeTimer);
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.retryTimer);
  clearInterval(state.statsTimer);
  clearInterval(state.syncTimer);
  if (state.padFrame !== null) cancelAnimationFrame(state.padFrame);
  if (state.frameCallbackId !== null && element.video.cancelVideoFrameCallback) {
    element.video.cancelVideoFrameCallback(state.frameCallbackId);
  }

  const input = state.inputChannel;
  const control = state.controlChannel;
  const peer = state.peer;
  const websocket = state.websocket;
  if (input) input.onclose = null;
  if (control) control.onclose = null;
  if (peer) peer.onconnectionstatechange = null;
  if (websocket) websocket.onclose = null;
  input?.close();
  control?.close();
  peer?.close();
  websocket?.close();

  Object.assign(state, {
    websocket: null,
    peer: null,
    inputChannel: null,
    controlChannel: null,
    videoStream: null,
    audioStream: null,
    remoteCandidates: [],
    hostNetworkMode: null,
    hostStunServers: [],
    lastGoodExternalReported: false,
    baseUrl: null,
    traversalSession: null,
    guestName: "",
    retrying: false,
    peerStarting: false,
    videoStarted: false,
    lastVideoFrameAt: 0,
    lastDecodedFrameAt: 0,
    lastStallRequestAt: 0,
    frameCallbackId: null,
    connectionTimer: null,
    welcomeTimer: null,
    reconnectTimer: null,
    retryTimer: null,
    reconnectAttempt: 0,
    statsTimer: null,
    syncTimer: null,
    padFrame: null,
    lastPad: null,
    lockedPad: null,
    inputActive: false,
    previousInbound: null,
    previousFeedback: null,
    nextFeedbackAt: 0,
    measuredRttMs: null,
  });

  if (preserved) Object.assign(state, preserved);

  resetVirtualPad();
  element.inputPulse.classList.remove("active");
  element.video.pause();
  element.video.srcObject = null;
  element.audioOut.pause();
  element.audioOut.srcObject = null;
  element.stage.classList.remove("has-video");
  resetMetrics();
  setControls(false);
  refreshPads(true);
  if (showIdle) {
    element.error.textContent = "";
    setStatus("idle", "未接続", reason, "ホスト画面の公開接続URLを貼り付けてください");
  }
}

function onVideoAutoplayBlocked(error) {
  console.warn("Video autoplay was blocked", error);
  element.error.textContent = "映像をクリックすると再生を開始できます。";
}

function onAudioAutoplayBlocked(error) {
  console.warn("Audio autoplay was blocked", error);
  element.audioOut.muted = true;
  element.audio.textContent = "音声 OFF";
  element.error.textContent = "音声を再生するには「音声 OFF」を一度押してください。";
}

function resyncVideo() {
  state.peer?.getReceivers().forEach(configureReceiverLatency);
  element.video.playbackRate = 1;
  element.video.play().catch(onVideoAutoplayBlocked);
  requestSyncFrame("browser_manual_start");
}

function monitorVideoFrames(generation) {
  if (!element.video.requestVideoFrameCallback || state.frameCallbackId !== null) return;
  let lastUiUpdate = 0;
  const onFrame = (now, metadata) => {
    if (generation !== state.generation) return;
    state.lastVideoFrameAt = performance.now();
    if (!state.videoStarted) {
      state.videoStarted = true;
      element.stage.classList.add("has-video");
      clearInterval(state.syncTimer);
    }
    if (now - lastUiUpdate >= 250) {
      lastUiUpdate = now;
      element.resolution.textContent = `${metadata.width || element.video.videoWidth} × ${metadata.height || element.video.videoHeight}`;
      const origin = Number.isFinite(metadata.captureTime)
        ? metadata.captureTime
        : metadata.receiveTime;
      if (Number.isFinite(origin) && Number.isFinite(metadata.expectedDisplayTime)) {
        element.display.textContent = `${Math.round(Math.max(0, metadata.expectedDisplayTime - origin))} ms`;
      }
    }
    state.frameCallbackId = element.video.requestVideoFrameCallback(onFrame);
  };
  state.frameCallbackId = element.video.requestVideoFrameCallback(onFrame);
}

function startStats() {
  clearInterval(state.statsTimer);
  state.nextFeedbackAt = performance.now() + NETWORK_FEEDBACK_INTERVAL_MS;
  void updateStats();
  state.statsTimer = setInterval(updateStats, state.mobile || lowPower ? 2_000 : 1_000);
}

async function updateStats() {
  if (!state.peer || state.peer.connectionState === "closed") return;
  try {
    const reports = await state.peer.getStats();
    let inbound;
    let pair;
    reports.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video" && !report.isRemote) {
        inbound = report;
      }
      if (
        report.type === "candidate-pair" &&
        report.state === "succeeded" &&
        (report.nominated || report.selected)
      ) {
        pair = report;
      }
    });

    const pairRttMs = Number.isFinite(pair?.currentRoundTripTime)
      ? pair.currentRoundTripTime * 1_000
      : null;
    const rttMs = state.measuredRttMs ?? pairRttMs;
    if (Number.isFinite(rttMs)) {
      element.rtt.textContent = rttMs > 0 && rttMs < 1 ? "<1 ms" : `${Math.round(rttMs)} ms`;
    }

    if (pair && !state.lastGoodExternalReported) {
      const remote = reports.get(pair.remoteCandidateId);
      const candidateType = String(remote?.candidateType || "").toLowerCase();
      const address = remote?.address || remote?.ip;
      const port = Number(remote?.port);
      if (
        (candidateType === "srflx" || candidateType === "prflx") &&
        typeof address === "string" &&
        isPublicIpv4(address) &&
        Number.isInteger(port) &&
        port > 0 &&
        port <= 65535 &&
        sendSignal({ type: "last_good_external_candidate", candidate: `${address}:${port}` })
      ) {
        state.lastGoodExternalReported = true;
      }
    }

    if (!inbound) return;
    element.loss.textContent = String(inbound.packetsLost || 0);
    updateInboundMetrics(inbound);
    sendNetworkFeedbackIfDue(inbound);

    const now = performance.now();
    if (
      !document.hidden &&
      state.connected &&
      state.videoStarted &&
      now - state.lastVideoFrameAt >= VIDEO_STALL_MS &&
      now - state.lastDecodedFrameAt >= VIDEO_STALL_MS &&
      now - state.lastStallRequestAt >= VIDEO_STALL_REQUEST_COOLDOWN_MS
    ) {
      state.lastStallRequestAt = now;
      requestKeyframe("browser_video_stalled");
    }
  } catch (error) {
    console.warn("WebRTC stats failed", error);
  }
}

function updateInboundMetrics(inbound) {
  const previous = state.previousInbound;
  const decodedTotal = inbound.framesDecoded || 0;
  if (decodedTotal > (previous?.decoded || 0)) {
    state.lastDecodedFrameAt = performance.now();
  }
  if (previous) {
    const elapsedSeconds = (inbound.timestamp - previous.timestamp) / 1_000;
    const decoded = (inbound.framesDecoded || 0) - previous.decoded;
    const emitted = (inbound.jitterBufferEmittedCount || 0) - previous.emitted;
    const delay = (inbound.jitterBufferDelay || 0) - previous.delay;
    const minimumDelay = (inbound.jitterBufferMinimumDelay || 0) - previous.minimumDelay;
    const targetDelay = (inbound.jitterBufferTargetDelay || 0) - previous.targetDelay;
    const decodeTime = (inbound.totalDecodeTime || 0) - previous.decodeTime;
    const dropped = (inbound.framesDropped || 0) - previous.dropped;
    if (elapsedSeconds > 0 && decoded >= 0) {
      element.fps.textContent = `${Math.round(decoded / elapsedSeconds)} fps`;
    }
    if (emitted > 0 && delay >= 0) {
      element.buffer.textContent = `${Math.round((delay / emitted) * 1_000)} ms`;
    }
    if (emitted > 0 || decoded > 0 || dropped > 0) {
      console.debug("RemotePlay video playout stats", {
        jitterMs: emitted > 0 && delay >= 0 ? (delay / emitted) * 1_000 : null,
        jitterMinimumMs: emitted > 0 && minimumDelay >= 0 ? (minimumDelay / emitted) * 1_000 : null,
        jitterTargetMs: emitted > 0 && targetDelay >= 0 ? (targetDelay / emitted) * 1_000 : null,
        decodeMs: decoded > 0 && decodeTime >= 0 ? (decodeTime / decoded) * 1_000 : null,
        droppedFrames: Math.max(0, dropped),
      });
    }
  } else if (Number.isFinite(inbound.framesPerSecond)) {
    element.fps.textContent = `${Math.round(inbound.framesPerSecond)} fps`;
  }

  state.previousInbound = {
    timestamp: inbound.timestamp,
    decoded: decodedTotal,
    emitted: inbound.jitterBufferEmittedCount || 0,
    delay: inbound.jitterBufferDelay || 0,
    minimumDelay: inbound.jitterBufferMinimumDelay || 0,
    targetDelay: inbound.jitterBufferTargetDelay || 0,
    decodeTime: inbound.totalDecodeTime || 0,
    dropped: inbound.framesDropped || 0,
  };
}

function sendNetworkFeedbackIfDue(inbound) {
  const now = performance.now();
  const current = {
    received: Math.max(0, inbound.packetsReceived || 0),
    lost: Math.max(0, inbound.packetsLost || 0),
  };
  if (now < state.nextFeedbackAt) {
    if (!state.previousFeedback) state.previousFeedback = current;
    return;
  }

  const previous = state.previousFeedback || { received: 0, lost: 0 };
  sendInput({
    type: "network_feedback",
    received_packets: Math.max(0, current.received - previous.received),
    lost_packets: Math.max(0, current.lost - previous.lost),
    jitter_ms: Math.round(Math.max(0, (inbound.jitter || 0) * 1_000)),
  });
  state.previousFeedback = current;
  state.nextFeedbackAt = now + NETWORK_FEEDBACK_INTERVAL_MS;
}

function resetMetrics() {
  [element.rtt, element.buffer, element.fps, element.loss, element.display].forEach((item) => {
    item.textContent = "--";
  });
  element.resolution.textContent = "-- × --";
}

function padSelection(value) {
  if (value === "virtual") return "virtual";
  if (value === "") return null;
  const index = Number(value);
  return Number.isInteger(index) ? index : null;
}

function refreshPads(force = false) {
  if (connectionActive() && !force) return;
  const pads = Array.from(navigator.getGamepads?.() || []).filter(Boolean);
  const signature = `${state.mobile}|${pads.map((pad) => `${pad.index}:${pad.id}`).join("|")}`;
  const previous = state.padIndex;
  if (!force && signature === state.padSignature) return;
  state.padSignature = signature;

  element.gamepad.replaceChildren();
  element.gamepad.add(new Option("コントローラーなし（映像のみ）", ""));
  if (state.mobile) element.gamepad.add(new Option("スマホ仮想デジタルパッド", "virtual"));
  pads.forEach((pad) => element.gamepad.add(new Option(`#${pad.index + 1} ${pad.id}`, String(pad.index))));

  const previousExists =
    (previous === null && state.padChoiceExplicit) ||
    (previous === "virtual" && state.mobile) ||
    (Number.isInteger(previous) && pads.some((pad) => pad.index === previous));
  state.padIndex = previousExists ? previous : state.mobile ? "virtual" : (pads[0]?.index ?? null);
  element.gamepad.value = state.padIndex === null ? "" : String(state.padIndex);
  element.gamepadHelp.textContent =
    state.padIndex === "virtual"
      ? "画面下の仮想パッドを使用します。接続後は変更できません。"
      : pads.length
        ? `${pads.length}台検出 / 接続後はコントローラーを変更できません。`
        : "コントローラーのボタンを一度押すと、ブラウザが検出します。";
}

function gamepadPayload(pad, connected = true) {
  const sourceButtons = pad?.buttons || [];
  const sourceAxes = pad?.axes || [];
  return {
    type: "gamepad",
    gamepad: {
      id: pad?.id || "Browser Gamepad",
      connected,
      mapping: pad?.mapping || "standard",
      buttons: Array.from(sourceButtons, (button) => ({
        pressed: button.pressed,
        value: Math.round(button.value * 1_000) / 1_000,
      })),
      axes: Array.from(sourceAxes.slice(0, 4), (axis) => Math.round(axis * 1_000) / 1_000),
    },
  };
}

function virtualPad() {
  return {
    id: "RemotePlay Mobile Digital Pad",
    mapping: "standard",
    buttons: state.virtualButtons.map((value) => ({ pressed: value > 0, value })),
    axes: [0, 0, 0, 0],
  };
}

function encodedButton(button) {
  return Math.round(button.value * 1_000) + (button.pressed ? 2_001 : 0);
}

function padChanged(pad) {
  const previous = state.lastPad;
  const axisCount = Math.min(4, pad.axes.length);
  if (
    !previous ||
    previous.id !== pad.id ||
    previous.mapping !== pad.mapping ||
    previous.buttons.length !== pad.buttons.length ||
    previous.axes.length !== axisCount
  ) {
    return true;
  }
  for (let index = 0; index < pad.buttons.length; index += 1) {
    if (previous.buttons[index] !== encodedButton(pad.buttons[index])) return true;
  }
  for (let index = 0; index < axisCount; index += 1) {
    if (previous.axes[index] !== Math.round(pad.axes[index] * 1_000)) return true;
  }
  return false;
}

function rememberPad(pad) {
  const axisCount = Math.min(4, pad.axes.length);
  state.lastPad = {
    id: pad.id,
    mapping: pad.mapping,
    buttons: Array.from(pad.buttons, encodedButton),
    axes: Array.from(pad.axes.slice(0, axisCount), (axis) => Math.round(axis * 1_000)),
  };
}

function startPadPolling() {
  if (state.padFrame !== null) cancelAnimationFrame(state.padFrame);
  state.lastPad = null;
  state.lastPadAt = 0;
  const tick = () => {
    pollPad();
    state.padFrame = state.inputChannel?.readyState === "open" ? requestAnimationFrame(tick) : null;
  };
  state.padFrame = requestAnimationFrame(tick);
}

function pollPad() {
  if (state.inputChannel?.readyState !== "open" || state.lockedPad === null) {
    updateInputPulse();
    return;
  }
  const pad =
    state.lockedPad === "virtual"
      ? virtualPad()
      : navigator.getGamepads?.()[state.lockedPad];
  if (!pad) {
    updateInputPulse();
    return;
  }

  const now = performance.now();
  if (padChanged(pad) || now - state.lastPadAt >= 100) {
    if (sendInput(gamepadPayload(pad))) {
      rememberPad(pad);
      state.lastPadAt = now;
    }
  }
  if (pad.buttons.some((button) => button.pressed || button.value > .1) || pad.axes.some((axis) => Math.abs(axis) > .12)) {
    state.lastInputAt = now;
  }
  updateInputPulse();
}

function updateInputPulse() {
  const active = performance.now() - state.lastInputAt < 180;
  if (active !== state.inputActive) {
    state.inputActive = active;
    element.inputPulse.classList.toggle("active", active);
  }
}

function sendPadDisconnected() {
  if (state.inputChannel?.readyState !== "open" || state.lockedPad === null) return;
  const pad = state.lockedPad === "virtual" ? virtualPad() : navigator.getGamepads?.()[state.lockedPad];
  sendInput(gamepadPayload(pad, false));
}

function resetVirtualPad() {
  state.virtualButtons.fill(0);
  state.virtualCounts.fill(0);
  state.virtualPointers.clear();
  element.mobilePad.querySelectorAll(".is-pressed").forEach((button) => button.classList.remove("is-pressed"));
}

function pressVirtualButton(event) {
  event.preventDefault();
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (state.virtualPointers.has(event.pointerId)) return;
  const button = event.currentTarget;
  const index = Number(button.dataset.button);
  button.setPointerCapture?.(event.pointerId);
  state.virtualPointers.set(event.pointerId, { index, button });
  state.virtualCounts[index] += 1;
  state.virtualButtons[index] = 1;
  button.classList.add("is-pressed");
  state.lastInputAt = performance.now();
  updateInputPulse();
}

function releaseVirtualButton(event) {
  const active = state.virtualPointers.get(event.pointerId);
  if (!active) return;
  state.virtualPointers.delete(event.pointerId);
  state.virtualCounts[active.index] = Math.max(0, state.virtualCounts[active.index] - 1);
  state.virtualButtons[active.index] = state.virtualCounts[active.index] > 0 ? 1 : 0;
  if (!state.virtualButtons[active.index]) active.button.classList.remove("is-pressed");
  event.preventDefault();
}

function addressFromPageUrl() {
  const params = new URLSearchParams(location.search);
  const named = params.get("ws") || params.get("host") || params.get("url");
  if (named) return named;
  for (const raw of [location.search.slice(1), location.hash.slice(1)]) {
    if (!raw) continue;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* use raw input */ }
    if (/^wss?:\/\//i.test(decoded)) return decoded;
  }
  return "";
}

element.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (connectionActive()) void stop(true);
  else void start();
});

element.gamepad.addEventListener("change", () => {
  if (connectionActive()) return;
  state.padChoiceExplicit = true;
  state.padIndex = padSelection(element.gamepad.value);
  state.lastPad = null;
  refreshPads(true);
});

element.mobileMode.addEventListener("click", () => {
  if (connectionActive()) return;
  state.mobile = !state.mobile;
  state.padChoiceExplicit = true;
  document.body.classList.toggle("mobile-mode", state.mobile);
  element.mobileMode.textContent = state.mobile ? "PC表示" : "スマホ操作";
  resetVirtualPad();
  state.padIndex = state.mobile ? "virtual" : null;
  state.padSignature = "";
  refreshPads(true);
});

element.mobilePad.querySelectorAll("[data-button]").forEach((button) => {
  button.addEventListener("pointerdown", pressVirtualButton);
  button.addEventListener("pointerup", releaseVirtualButton);
  button.addEventListener("pointercancel", releaseVirtualButton);
  button.addEventListener("lostpointercapture", releaseVirtualButton);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
});

element.audio.addEventListener("click", () => {
  element.audioOut.muted = !element.audioOut.muted;
  element.audio.textContent = element.audioOut.muted ? "音声 OFF" : "音声 ON";
  if (!element.audioOut.muted) element.audioOut.play().catch(onAudioAutoplayBlocked);
});
element.resync.addEventListener("click", resyncVideo);
element.fullscreen.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void element.stage.requestFullscreen?.();
});
element.video.addEventListener("click", () => {
  element.video.play().catch(onVideoAutoplayBlocked);
  if (!element.audioOut.muted) element.audioOut.play().catch(onAudioAutoplayBlocked);
});
element.video.addEventListener("pause", () => {
  if (state.connected) element.video.play().catch(onVideoAutoplayBlocked);
});
element.video.addEventListener("playing", () => {
  state.videoStarted = true;
  state.lastVideoFrameAt = performance.now();
  element.stage.classList.add("has-video");
});
element.video.addEventListener("timeupdate", () => {
  if (!element.video.requestVideoFrameCallback) state.lastVideoFrameAt = performance.now();
});

window.addEventListener("gamepadconnected", () => {
  if (!connectionActive()) refreshPads();
});
window.addEventListener("gamepaddisconnected", (event) => {
  if (connectionActive()) {
    if (state.lockedPad === event.gamepad.index) sendPadDisconnected();
  } else {
    refreshPads();
  }
});
window.addEventListener("beforeunload", () => {
  sendSignal({ type: "disconnect", reason: "Browser page closed" });
  sendPadDisconnected();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.connected) requestKeyframe("browser_became_visible");
});

document.body.classList.toggle("low-power", lowPower);
if (element.protocolVersion) element.protocolVersion.textContent = PROTOCOL_VERSION;
element.url.value = addressFromPageUrl();
element.name.value = "";
refreshPads(true);
setInterval(() => refreshPads(), lowPower ? 10_000 : 5_000);
resetMetrics();
setControls(false);
setStatus("idle", "未接続", "ホストに接続してください", "ホスト画面の公開接続URLを貼り付けてください");
