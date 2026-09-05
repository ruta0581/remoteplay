"use strict";

const MAGIC = [0x52, 0x50, 0x56, 0x31]; // "RPV1"
const WIRE_VERSION = 1;
const HEADER_BYTES = 40;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 4096;
const MAX_ASSEMBLIES = 4;
const FRAME_GAP_GRACE_MS = 6;
const KEYFRAME_GAP_GRACE_MS = 25;
const INCOMPLETE_KEYFRAME_TIMEOUT_MS = 500;
const MAX_DECODER_QUEUE = 2;
// A delayed P-frame cannot be skipped independently because later H.264
// frames may reference it. Once the dependency chain is visibly old, abandon
// it and resume at a fresh IDR instead of decoding toward live video.
const MIN_CAPTURE_AGE_LIMIT_MS = 180;
const MAX_CAPTURE_AGE_LIMIT_MS = 300;
const REPORT_INTERVAL_MS = 250;
const DEFAULT_CODEC = "avc1.42E01F";
const ANNEX_B_START_CODE = new Uint8Array([0, 0, 0, 1]);

let stopped = false;
let debugLogging = false;
let canvas = null;
let context = null;
let decoder = null;
let decoderConfig = null;
let waitingForKeyframe = true;
let pendingFrame = null;
let drawQueued = false;
let assemblies = new Map();
let lastDecodedFrameId = null;
let gapTimer = null;
let incompleteKeyframeTimer = null;
let incompleteKeyframeFrameId = null;
let cachedParameterSets = [];
let arrivalByTimestamp = new Map();
let decodedFrames = 0;
let renderedFrames = 0;
let decoderResets = 0;
let receivedChunks = 0;
let lostChunks = 0;
let droppedAssemblies = 0;
let droppedStaleFrames = 0;
let lastReportAt = 0;
let fpsWindowStartedAt = performance.now();
let fpsWindowFrames = 0;
let lastFormat = "unknown";
let clockOffsetMs = null; // browser wall clock - host wall clock
let clockSyncRttMs = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function postError(error) {
  self.postMessage({ type: "error", message: errorMessage(error) });
}

function debugWarn(...args) {
  if (debugLogging) console.warn(...args);
}

function requestKeyframe(reason) {
  self.postMessage({ type: "request-keyframe", reason });
}

function startCodeLengthAt(data, offset) {
  if (offset + 3 <= data.byteLength && data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1) {
    return 3;
  }
  if (
    offset + 4 <= data.byteLength &&
    data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 0 && data[offset + 3] === 1
  ) {
    return 4;
  }
  return 0;
}

function isAnnexB(data) {
  return Boolean(startCodeLengthAt(data, 0));
}

function concatNals(nals) {
  let total = 0;
  for (const nal of nals) total += 4 + nal.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of nals) {
    out.set(ANNEX_B_START_CODE, offset);
    offset += 4;
    out.set(nal, offset);
    offset += nal.byteLength;
  }
  return out;
}

function tryLengthPrefixed(data, lengthBytes) {
  const nals = [];
  let offset = 0;
  while (offset + lengthBytes <= data.byteLength) {
    let length = 0;
    for (let i = 0; i < lengthBytes; i += 1) length = (length << 8) | data[offset + i];
    offset += lengthBytes;
    if (length <= 0 || offset + length > data.byteLength) return null;
    const nal = data.slice(offset, offset + length);
    const type = nal[0] & 0x1f;
    if (!nal.byteLength || type < 1 || type > 23) return null;
    nals.push(nal);
    offset += length;
  }
  return offset === data.byteLength && nals.length ? concatNals(nals) : null;
}

function normalizeAccessUnit(source) {
  if (!source.byteLength) throw new Error("received an empty H.264 access unit");
  if (isAnnexB(source)) {
    // The Host already sends complete Annex-B access units. Keep the assembled
    // buffer instead of copying the full encoded frame once more before decode.
    return { data: source, format: "annexb" };
  }
  for (const lengthBytes of [4, 2, 1]) {
    const converted = tryLengthPrefixed(source, lengthBytes);
    if (converted) return { data: converted, format: `avcc-${lengthBytes}` };
  }
  const nalType = source[0] & 0x1f;
  if (nalType >= 1 && nalType <= 23) {
    return { data: concatNals([source.slice()]), format: `raw-nal-${nalType}` };
  }
  throw new Error(`unsupported H.264 access-unit layout (NAL type ${nalType})`);
}

function forEachAnnexBNal(data, visitor) {
  let offset = 0;
  while (offset < data.byteLength) {
    const sc = startCodeLengthAt(data, offset);
    if (!sc) {
      offset += 1;
      continue;
    }
    const start = offset + sc;
    let end = start;
    while (end < data.byteLength && !startCodeLengthAt(data, end)) end += 1;
    if (end > start) visitor(data.subarray(start, end));
    offset = end;
  }
}

function h264Metadata(data) {
  let key = false;
  let codec = null;
  let hasSps = false;
  let hasPps = false;
  const parameterSets = [];
  forEachAnnexBNal(data, (nal) => {
    if (!nal.byteLength) return;
    const type = nal[0] & 0x1f;
    if (type === 5) key = true;
    if (type === 7) {
      hasSps = true;
      parameterSets.push(nal.slice());
      if (nal.byteLength >= 4 && !codec) {
        const profile = [nal[1], nal[2], nal[3]]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase();
        codec = `avc1.${profile}`;
      }
    }
    if (type === 8) {
      hasPps = true;
      parameterSets.push(nal.slice());
    }
  });
  return { key, codec, hasSps, hasPps, parameterSets };
}

function prependCachedParameterSets(data, metadata, key) {
  if (!key) return data;
  if (metadata.parameterSets.length) cachedParameterSets = metadata.parameterSets.map((nal) => nal.slice());
  if ((metadata.hasSps && metadata.hasPps) || cachedParameterSets.length === 0) return data;
  const nals = cachedParameterSets.map((nal) => nal.slice());
  forEachAnnexBNal(data, (nal) => nals.push(nal.slice()));
  return concatNals(nals);
}

async function supportedConfig(codec) {
  const candidates = [
    { codec: codec || DEFAULT_CODEC, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
    { codec: codec || DEFAULT_CODEC, hardwareAcceleration: "no-preference", optimizeForLatency: true },
  ];
  for (const candidate of candidates) {
    try {
      const result = await VideoDecoder.isConfigSupported(candidate);
      if (result?.supported) return result.config || candidate;
    } catch (_) {}
  }
  throw new Error(`WebCodecs H.264 decoder unavailable for ${codec || DEFAULT_CODEC}`);
}

function closePendingFrame() {
  if (!pendingFrame) return;
  try { pendingFrame.frame.close(); } catch (_) {}
  pendingFrame = null;
}

function captureAgeLimitMs() {
  // Keep enough margin for the best measured RTT and clock-offset error while
  // still preventing a browser/SCTP backlog from turning into playout delay.
  const rttMargin = Number.isFinite(clockSyncRttMs) ? Math.max(0, clockSyncRttMs) : 60;
  return Math.min(MAX_CAPTURE_AGE_LIMIT_MS, Math.max(MIN_CAPTURE_AGE_LIMIT_MS, 120 + rttMargin));
}

function captureAgeMs(capturedUnixMs) {
  if (!Number.isFinite(clockOffsetMs) || !Number.isFinite(capturedUnixMs)) return null;
  return Date.now() - (capturedUnixMs + clockOffsetMs);
}

function frameIsStale(capturedUnixMs) {
  const ageMs = captureAgeMs(capturedUnixMs);
  return Number.isFinite(ageMs) && ageMs > captureAgeLimitMs();
}

function reportFrame(frame, timing) {
  const width = frame.displayWidth || frame.codedWidth;
  const height = frame.displayHeight || frame.codedHeight;
  if (!width || !height) return;
  // Only resize the backing surface when the source resolution actually changes.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(frame, 0, 0, width, height);
  renderedFrames += 1;
  fpsWindowFrames += 1;
  const nowPerf = performance.now();
  if (nowPerf - lastReportAt >= REPORT_INTERVAL_MS || renderedFrames === 1) {
    lastReportAt = nowPerf;
    const nowWall = Date.now();
    const elapsed = Math.max(1, nowPerf - fpsWindowStartedAt);
    const fps = (fpsWindowFrames * 1000) / elapsed;
    const pipelineMs = Math.max(0, nowPerf - timing.firstArrivalAt);
    const assemblyMs = Math.max(0, timing.completeAt - timing.firstArrivalAt);
    const captureToDisplayMs = Number.isFinite(clockOffsetMs) && Number.isFinite(timing.capturedUnixMs)
      ? Math.max(0, nowWall - (timing.capturedUnixMs + clockOffsetMs))
      : null;
    const encodedToDisplayMs = Number.isFinite(clockOffsetMs) && Number.isFinite(timing.encodedUnixMs)
      ? Math.max(0, nowWall - (timing.encodedUnixMs + clockOffsetMs))
      : null;
    if (elapsed >= 1000) {
      fpsWindowStartedAt = nowPerf;
      fpsWindowFrames = 0;
    }
    self.postMessage({
      type: "frame",
      width,
      height,
      pipelineMs,
      assemblyMs,
      captureToDisplayMs,
      encodedToDisplayMs,
      clockSyncRttMs,
      fps,
      decoderQueue: decoder?.decodeQueueSize || 0,
      decodedFrames,
      renderedFrames,
      decoderResets,
      receivedChunks,
      lostChunks,
      droppedAssemblies,
      droppedStaleFrames,
      pendingAssemblies: assemblies.size,
      pendingAssemblyBytes: 0,
      format: lastFormat,
    });
  }
}

function drawLatest() {
  drawQueued = false;
  if (stopped || !pendingFrame || !context || !canvas) {
    closePendingFrame();
    return;
  }
  const item = pendingFrame;
  pendingFrame = null;
  try {
    reportFrame(item.frame, item.timing);
  } finally {
    item.frame.close();
  }
}

function onDecodedFrame(frame) {
  if (stopped) {
    frame.close();
    return;
  }
  decodedFrames += 1;
  if (pendingFrame) {
    try { pendingFrame.frame.close(); } catch (_) {}
  }
  const now = performance.now();
  const timing = arrivalByTimestamp.get(frame.timestamp) || {
    firstArrivalAt: now,
    completeAt: now,
    capturedUnixMs: null,
    encodedUnixMs: null,
  };
  arrivalByTimestamp.delete(frame.timestamp);
  if (frameIsStale(timing.capturedUnixMs)) {
    droppedStaleFrames += 1;
    frame.close();
    // A stale keyframe is still useful as a decoder reference and can be
    // hidden while fresh dependent frames catch up. A stale delta means the
    // whole dependency chain is late, so restart it at a new IDR.
    if (!timing.keyframe) resetForLoss("browser_fast_video_stale_decoded_frame");
    return;
  }
  pendingFrame = { frame, timing };
  if (!drawQueued) {
    drawQueued = true;
    queueMicrotask(drawLatest);
  }
}

function createDecoder(config) {
  if (decoder) {
    try { decoder.close(); } catch (_) {}
  }
  decoderConfig = config;
  decoder = new VideoDecoder({
    output: onDecodedFrame,
    error(error) {
      debugWarn("RemotePlay fast-video WebCodecs decoder error", error);
      resetForLoss("browser_fast_video_decoder_error");
    },
  });
  decoder.configure(config);
}

function clearGapTimer() {
  if (gapTimer !== null) clearTimeout(gapTimer);
  gapTimer = null;
}

function clearIncompleteKeyframeTimer() {
  if (incompleteKeyframeTimer !== null) clearTimeout(incompleteKeyframeTimer);
  incompleteKeyframeTimer = null;
  incompleteKeyframeFrameId = null;
}

function armIncompleteKeyframeTimer(frameId) {
  clearIncompleteKeyframeTimer();
  incompleteKeyframeFrameId = frameId;
  incompleteKeyframeTimer = setTimeout(() => {
    incompleteKeyframeTimer = null;
    const expectedFrameId = incompleteKeyframeFrameId;
    incompleteKeyframeFrameId = null;
    if (stopped || !waitingForKeyframe) return;
    const assembly = assemblies.get(expectedFrameId);
    if (!assembly || assembly.complete) return;
    resetForLoss("browser_fast_video_incomplete_keyframe");
  }, INCOMPLETE_KEYFRAME_TIMEOUT_MS);
}

function dropAssembly(assembly, countLoss = true) {
  if (!assembly) return;
  assemblies.delete(assembly.frameId);
  droppedAssemblies += 1;
  if (countLoss) lostChunks += Math.max(1, assembly.chunkCount - assembly.receivedCount);
}

function resetForLoss(reason) {
  waitingForKeyframe = true;
  clearGapTimer();
  clearIncompleteKeyframeTimer();
  for (const assembly of assemblies.values()) dropAssembly(assembly, true);
  assemblies.clear();
  closePendingFrame();
  arrivalByTimestamp.clear();
  lastDecodedFrameId = null;
  decoderResets += 1;
  if (decoder && decoderConfig) {
    try {
      decoder.reset();
      decoder.configure(decoderConfig);
    } catch (error) {
      postError(error);
    }
  }
  requestKeyframe(reason);
}

function idDelta(a, b) {
  return (a - b) >>> 0;
}

function isAhead(a, b) {
  const delta = idDelta(a, b);
  return delta !== 0 && delta < 0x80000000;
}

async function decodeAssembly(assembly) {
  assemblies.delete(assembly.frameId);
  if (assembly.keyframe) clearIncompleteKeyframeTimer();
  let converted;
  try {
    converted = normalizeAccessUnit(assembly.data);
  } catch (error) {
    resetForLoss("browser_fast_video_bad_h264");
    throw error;
  }
  lastFormat = converted.format;
  let data = converted.data;
  let metadata = h264Metadata(data);
  const key = assembly.keyframe || metadata.key;
  const preparedData = prependCachedParameterSets(data, metadata, key);
  if (preparedData !== data) {
    data = preparedData;
    metadata = h264Metadata(data);
  }

  if (waitingForKeyframe && !key) return false;
  if (!key && frameIsStale(assembly.capturedUnixMs)) {
    droppedStaleFrames += 1;
    resetForLoss("browser_fast_video_stale_encoded_frame");
    return false;
  }
  if (key && metadata.codec && decoderConfig?.codec !== metadata.codec) {
    const config = await supportedConfig(metadata.codec);
    createDecoder(config);
  }
  if (!decoder) {
    const config = await supportedConfig(metadata.codec || decoderConfig?.codec || DEFAULT_CODEC);
    createDecoder(config);
  }

  if (decoder.decodeQueueSize > MAX_DECODER_QUEUE) {
    resetForLoss("browser_fast_video_decode_backlog");
    return false;
  }

  if (key) waitingForKeyframe = false;
  const timestamp = assembly.frameId * 16667;
  arrivalByTimestamp.set(timestamp, {
    firstArrivalAt: assembly.firstArrivalAt,
    completeAt: assembly.completeAt || performance.now(),
    capturedUnixMs: assembly.capturedUnixMs,
    encodedUnixMs: assembly.encodedUnixMs,
    keyframe: key,
  });
  try {
    decoder.decode(new EncodedVideoChunk({
      type: key ? "key" : "delta",
      timestamp,
      data,
    }));
  } catch (error) {
    arrivalByTimestamp.delete(timestamp);
    resetForLoss("browser_fast_video_decode_submit_error");
    throw error;
  }
  lastDecodedFrameId = assembly.frameId;
  return true;
}

async function drainCompleteFrames() {
  if (stopped) return;
  if (waitingForKeyframe) {
    const keys = [...assemblies.values()]
      .filter((assembly) => assembly.complete && assembly.keyframe)
      .sort((a, b) => (isAhead(a.frameId, b.frameId) ? 1 : -1));
    if (!keys.length) return;
    const selected = keys[keys.length - 1];
    for (const assembly of [...assemblies.values()]) {
      if (assembly.frameId !== selected.frameId) dropAssembly(assembly, false);
    }
    await decodeAssembly(selected);
  }

  while (!waitingForKeyframe && lastDecodedFrameId !== null) {
    const expected = (lastDecodedFrameId + 1) >>> 0;
    const next = assemblies.get(expected);
    if (next?.complete) {
      clearGapTimer();
      await decodeAssembly(next);
      continue;
    }

    const newerComplete = [...assemblies.values()].find(
      (assembly) => assembly.complete && isAhead(assembly.frameId, expected),
    );
    if (!newerComplete || gapTimer !== null) break;
    // Large IDRs are split across many unordered SCTP messages. Give only the
    // expected keyframe extra time to finish reassembly; ordinary P-frame gaps
    // keep the aggressive 6 ms freshness budget.
    const expectedAssembly = assemblies.get(expected);
    const gapGraceMs = expectedAssembly?.keyframe
      ? KEYFRAME_GAP_GRACE_MS
      : FRAME_GAP_GRACE_MS;
    gapTimer = setTimeout(() => {
      gapTimer = null;
      const expectedNow = lastDecodedFrameId === null ? null : ((lastDecodedFrameId + 1) >>> 0);
      if (expectedNow === null || assemblies.get(expectedNow)?.complete) {
        void drainCompleteFrames().catch(postError);
        return;
      }
      const key = [...assemblies.values()]
        .filter((assembly) => assembly.complete && assembly.keyframe && isAhead(assembly.frameId, lastDecodedFrameId))
        .sort((a, b) => (isAhead(a.frameId, b.frameId) ? 1 : -1))
        .pop();
      if (key) {
        waitingForKeyframe = true;
        void drainCompleteFrames().catch(postError);
      } else {
        resetForLoss("browser_fast_video_frame_gap");
      }
    }, gapGraceMs);
    break;
  }
}

function getUint64LE(view, offset) {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x1_0000_0000 + lo;
}

function parseChunk(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes[i] !== MAGIC[i]) return null;
  const view = new DataView(buffer);
  const version = view.getUint8(4);
  const flags = view.getUint8(5);
  const headerBytes = view.getUint16(6, true);
  const frameId = view.getUint32(8, true);
  const frameSize = view.getUint32(12, true);
  const chunkIndex = view.getUint16(16, true);
  const chunkCount = view.getUint16(18, true);
  const offset = view.getUint32(20, true);
  const capturedUnixMs = getUint64LE(view, 24);
  const encodedUnixMs = getUint64LE(view, 32);
  if (
    version !== WIRE_VERSION ||
    headerBytes !== HEADER_BYTES ||
    frameSize <= 0 || frameSize > MAX_FRAME_BYTES ||
    chunkCount <= 0 || chunkCount > MAX_CHUNKS ||
    chunkIndex >= chunkCount ||
    offset >= frameSize ||
    headerBytes >= buffer.byteLength
  ) return null;
  const payload = bytes.subarray(headerBytes);
  if (!payload.byteLength || offset + payload.byteLength > frameSize) return null;
  return {
    frameId, frameSize, chunkIndex, chunkCount, offset,
    keyframe: Boolean(flags & 0x01),
    capturedUnixMs, encodedUnixMs, payload,
  };
}

function onChunk(buffer) {
  if (stopped) return;
  const chunk = parseChunk(buffer);
  if (!chunk) return;
  receivedChunks += 1;
  if (waitingForKeyframe && !chunk.keyframe) return;

  let assembly = assemblies.get(chunk.frameId);
  if (!assembly) {
    if (waitingForKeyframe && chunk.keyframe) {
      // If a newer recovery IDR starts arriving, the older incomplete one can
      // no longer lead to the freshest decodable chain.
      for (const current of [...assemblies.values()]) {
        if (current.keyframe && current.frameId !== chunk.frameId) dropAssembly(current, true);
      }
    }
    assembly = {
      frameId: chunk.frameId,
      keyframe: chunk.keyframe,
      frameSize: chunk.frameSize,
      chunkCount: chunk.chunkCount,
      receivedCount: 0,
      seen: new Uint8Array(chunk.chunkCount),
      data: new Uint8Array(chunk.frameSize),
      firstArrivalAt: performance.now(),
      completeAt: null,
      capturedUnixMs: chunk.capturedUnixMs,
      encodedUnixMs: chunk.encodedUnixMs,
      complete: false,
    };
    assemblies.set(chunk.frameId, assembly);
    if (waitingForKeyframe && chunk.keyframe) armIncompleteKeyframeTimer(chunk.frameId);
  }
  if (
    assembly.frameSize !== chunk.frameSize ||
    assembly.chunkCount !== chunk.chunkCount ||
    assembly.keyframe !== chunk.keyframe ||
    assembly.capturedUnixMs !== chunk.capturedUnixMs ||
    assembly.encodedUnixMs !== chunk.encodedUnixMs
  ) {
    dropAssembly(assembly, true);
    resetForLoss("browser_fast_video_chunk_mismatch");
    return;
  }
  if (!assembly.seen[chunk.chunkIndex]) {
    assembly.seen[chunk.chunkIndex] = 1;
    assembly.receivedCount += 1;
    assembly.data.set(chunk.payload, chunk.offset);
    if (assembly.receivedCount === assembly.chunkCount) {
      assembly.complete = true;
      assembly.completeAt = performance.now();
      if (assembly.keyframe) clearIncompleteKeyframeTimer();
    }
  }

  if (assemblies.size > MAX_ASSEMBLIES) {
    const candidates = [...assemblies.values()].filter((item) => item.frameId !== chunk.frameId);
    candidates.sort((a, b) => (isAhead(a.frameId, b.frameId) ? 1 : -1));
    const oldest = candidates[0];
    if (oldest) {
      dropAssembly(oldest, true);
      resetForLoss("browser_fast_video_reassembly_backlog");
      return;
    }
  }
  if (assembly.complete) void drainCompleteFrames().catch(postError);
}

async function start(data) {
  if (typeof VideoDecoder !== "function") throw new Error("WebCodecs VideoDecoder is not available in this browser");
  debugLogging = data.debugLogging === true;
  canvas = data.canvas;
  context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) throw new Error("Could not create desynchronized canvas context");
  if (Number.isFinite(data.clockOffsetMs)) clockOffsetMs = Number(data.clockOffsetMs);
  if (Number.isFinite(data.clockSyncRttMs)) clockSyncRttMs = Number(data.clockSyncRttMs);
  decoderConfig = await supportedConfig(data.codec || DEFAULT_CODEC);
  createDecoder(decoderConfig);
  self.postMessage({ type: "ready", codec: decoderConfig.codec });
}

function stop() {
  stopped = true;
  clearGapTimer();
  clearIncompleteKeyframeTimer();
  closePendingFrame();
  for (const assembly of assemblies.values()) dropAssembly(assembly, false);
  assemblies.clear();
  arrivalByTimestamp.clear();
  if (decoder) {
    try { decoder.close(); } catch (_) {}
    decoder = null;
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === "stop") {
    stop();
    return;
  }
  if (data?.type === "clock-sync") {
    if (Number.isFinite(data.offsetMs)) clockOffsetMs = Number(data.offsetMs);
    if (Number.isFinite(data.rttMs)) clockSyncRttMs = Number(data.rttMs);
    return;
  }
  if (data?.type === "chunk") {
    onChunk(data.buffer);
    return;
  }
  if (data?.type !== "start") return;
  stopped = false;
  start(data).catch(postError);
};
