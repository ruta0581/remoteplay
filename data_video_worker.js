"use strict";

const MAGIC = [0x52, 0x50, 0x56, 0x31]; // "RPV1"
const WIRE_VERSION = 1;
const HEADER_BYTES = 40;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 4096;
const MAX_ASSEMBLIES = 3;
const MAX_PENDING_ASSEMBLY_BYTES = 4 * 1024 * 1024;
const MAX_DECODER_QUEUE = 1;
const REPORT_INTERVAL_MS = 250;
const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 300;
const DEFAULT_CODEC = "avc1.42E01F";

let stopped = false;
let canvas = null;
let context = null;
let decoder = null;
let decoderConfig = null;
let waitingForKeyframe = true;
let pendingFrame = null;
let drawQueued = false;
let assemblies = new Map();
let pendingAssemblyBytes = 0;
let lastDecodedFrameId = null;
let gapTimer = null;
let cachedParameterSets = [];
let arrivalByTimestamp = new Map();
let decodedFrames = 0;
let renderedFrames = 0;
let decoderResets = 0;
let receivedChunks = 0;
let receivedBytes = 0;
let lostChunks = 0;
let droppedAssemblies = 0;
let lastReportAt = 0;
let fpsWindowStartedAt = performance.now();
let fpsWindowFrames = 0;
let lastFormat = "unknown";
let lastKeyframeRequestAt = -Infinity;
let clockOffsetMs = null; // browser wall clock - host wall clock
let clockSyncRttMs = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function postError(error) {
  self.postMessage({ type: "error", message: errorMessage(error) });
}

function requestKeyframe(reason, force = false) {
  const now = performance.now();
  if (!force && now - lastKeyframeRequestAt < KEYFRAME_REQUEST_MIN_INTERVAL_MS) return;
  lastKeyframeRequestAt = now;
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
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 1;
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
    const nal = data.subarray(offset, offset + length);
    const type = nal[0] & 0x1f;
    if (!nal.byteLength || type < 1 || type > 23) return null;
    nals.push(nal);
    offset += length;
  }
  return offset === data.byteLength && nals.length ? concatNals(nals) : null;
}

function normalizeAccessUnit(source) {
  if (!source.byteLength) throw new Error("received an empty H.264 access unit");
  // Host fast-video normally sends Annex-B already. Do not normalize/copy a
  // complete AU just to rewrite start codes; WebCodecs accepts Annex-B as-is.
  if (isAnnexB(source)) return { data: source, format: "annexb-zero-copy" };
  for (const lengthBytes of [4, 2, 1]) {
    const converted = tryLengthPrefixed(source, lengthBytes);
    if (converted) return { data: converted, format: `avcc-${lengthBytes}` };
  }
  const nalType = source[0] & 0x1f;
  if (nalType >= 1 && nalType <= 23) {
    return { data: concatNals([source]), format: `raw-nal-${nalType}` };
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
  const nals = [...cachedParameterSets];
  forEachAnnexBNal(data, (nal) => nals.push(nal));
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

function reportFrame(frame, timing) {
  const width = frame.displayWidth || frame.codedWidth;
  const height = frame.displayHeight || frame.codedHeight;
  if (!width || !height) return;
  // Resizing a canvas reallocates its backing surface. Only do it on an actual
  // source resolution change, never per frame.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(frame, 0, 0, width, height);
  renderedFrames += 1;
  fpsWindowFrames += 1;

  const nowPerf = performance.now();
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

  if (nowPerf - lastReportAt >= REPORT_INTERVAL_MS || renderedFrames === 1) {
    lastReportAt = nowPerf;
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
      receivedBytes,
      lostChunks,
      droppedAssemblies,
      pendingAssemblies: assemblies.size,
      pendingAssemblyBytes,
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
    // Explicitly release the decoded GPU-backed surface. Do not leave this to
    // GC, which can create large latency spikes after many frames.
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
  const timing = arrivalByTimestamp.get(frame.timestamp) || {
    firstArrivalAt: performance.now(),
    completeAt: performance.now(),
    capturedUnixMs: null,
    encodedUnixMs: null,
  };
  arrivalByTimestamp.delete(frame.timestamp);
  pendingFrame = { frame, timing };
  if (!drawQueued) {
    drawQueued = true;
    queueMicrotask(drawLatest);
  }
  // Keep at most one delta AU queued in WebCodecs. As soon as one output
  // arrives, continue feeding the next sequential dependency-safe AU.
  void drainCompleteFrames().catch(postError);
}

function createDecoder(config) {
  if (decoder) {
    try { decoder.close(); } catch (_) {}
  }
  decoderConfig = config;
  decoder = new VideoDecoder({
    output: onDecodedFrame,
    error(error) {
      console.warn("RemotePlay fast-video WebCodecs decoder error", error);
      resetForLoss("browser_fast_video_decoder_error");
    },
  });
  decoder.configure(config);
}

function clearGapTimer() {
  if (gapTimer !== null) clearTimeout(gapTimer);
  gapTimer = null;
}

function dropAssembly(assembly, countLoss = true) {
  if (!assembly) return;
  const removed = assemblies.delete(assembly.frameId);
  if (!removed) return;
  if (assembly.expiryTimer !== null) {
    clearTimeout(assembly.expiryTimer);
    assembly.expiryTimer = null;
  }
  pendingAssemblyBytes = Math.max(0, pendingAssemblyBytes - assembly.frameSize);
  droppedAssemblies += 1;
  if (countLoss) lostChunks += Math.max(1, assembly.chunkCount - assembly.receivedCount);
}

function resetDecoderForAvailableKeyframe() {
  closePendingFrame();
  arrivalByTimestamp.clear();
  decoderResets += 1;
  if (decoder && decoderConfig) {
    decoder.reset();
    decoder.configure(decoderConfig);
  }
}

function resetForLoss(reason) {
  waitingForKeyframe = true;
  clearGapTimer();
  for (const assembly of [...assemblies.values()]) dropAssembly(assembly, true);
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

function sortByFrameId(items) {
  return items.sort((a, b) => (isAhead(a.frameId, b.frameId) ? 1 : -1));
}

function frameGapGraceMs(expectedAssembly, newerComplete) {
  // If a newer IDR is already complete, there is no dependency reason to wait
  // long for a missing delta frame; jump to the recovery boundary quickly.
  if (newerComplete?.keyframe) return 2;
  if (!expectedAssembly) return 4;
  const chunks = expectedAssembly.chunkCount;
  if (expectedAssembly.keyframe) return Math.min(20, Math.max(12, 10 + chunks * 0.45));
  if (chunks <= 2) return 3;
  if (chunks <= 5) return 6;
  return Math.min(10, 6 + chunks * 0.25);
}

function assemblyExpiryMs(keyframe, chunkCount) {
  // Normal P-frames stay extremely aggressive. IDRs are much larger and are
  // the only safe H.264 resynchronization boundary, so give them a little more
  // time without turning the transport into a playout buffer.
  if (keyframe) return Math.min(35, Math.max(16, 14 + chunkCount * 0.75));
  if (chunkCount <= 2) return 5;
  if (chunkCount <= 5) return 8;
  return Math.min(12, 8 + chunkCount * 0.35);
}

async function decodeAssembly(assembly) {
  if (!assembly.keyframe && !waitingForKeyframe && decoder?.decodeQueueSize >= MAX_DECODER_QUEUE) {
    return "deferred";
  }
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
  data = prependCachedParameterSets(data, metadata, key);
  metadata = h264Metadata(data);

  if (waitingForKeyframe && !key) return "ignored";
  if (key && metadata.codec && decoderConfig?.codec !== metadata.codec) {
    const config = await supportedConfig(metadata.codec);
    createDecoder(config);
  }
  if (!decoder) {
    const config = await supportedConfig(metadata.codec || decoderConfig?.codec || DEFAULT_CODEC);
    createDecoder(config);
  }

  // latest-wins without breaking H.264 references: do not queue a second
  // dependent P-frame while one is still decoding. Leave this assembly in the
  // map and resume from onDecodedFrame(). A newly available IDR may supersede
  // that queue and reset the decoder safely.
  if (!key && decoder.decodeQueueSize >= MAX_DECODER_QUEUE) return "deferred";
  if (key && decoder.decodeQueueSize > 0) {
    try { resetDecoderForAvailableKeyframe(); } catch (error) { postError(error); }
  }

  assemblies.delete(assembly.frameId);
  if (assembly.expiryTimer !== null) {
    clearTimeout(assembly.expiryTimer);
    assembly.expiryTimer = null;
  }
  pendingAssemblyBytes = Math.max(0, pendingAssemblyBytes - assembly.frameSize);
  if (key) waitingForKeyframe = false;
  const timestamp = assembly.frameId * 16667;
  arrivalByTimestamp.set(timestamp, {
    firstArrivalAt: assembly.firstArrivalAt,
    completeAt: assembly.completeAt || performance.now(),
    capturedUnixMs: assembly.capturedUnixMs,
    encodedUnixMs: assembly.encodedUnixMs,
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
  return "decoded";
}

async function drainCompleteFrames() {
  if (stopped) return;
  if (waitingForKeyframe) {
    const keys = sortByFrameId([...assemblies.values()].filter((assembly) => assembly.complete && assembly.keyframe));
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
      const result = await decodeAssembly(next);
      if (result === "deferred") break;
      continue;
    }

    const newerComplete = sortByFrameId(
      [...assemblies.values()].filter((assembly) => assembly.complete && isAhead(assembly.frameId, expected)),
    )[0];
    if (!newerComplete || gapTimer !== null) break;
    const graceMs = frameGapGraceMs(next, newerComplete);
    gapTimer = setTimeout(() => {
      gapTimer = null;
      const expectedNow = lastDecodedFrameId === null ? null : ((lastDecodedFrameId + 1) >>> 0);
      if (expectedNow === null || assemblies.get(expectedNow)?.complete) {
        void drainCompleteFrames().catch(postError);
        return;
      }
      const key = sortByFrameId(
        [...assemblies.values()].filter(
          (assembly) => assembly.complete && assembly.keyframe && isAhead(assembly.frameId, lastDecodedFrameId),
        ),
      ).pop();
      if (key) {
        waitingForKeyframe = true;
        void drainCompleteFrames().catch(postError);
      } else {
        resetForLoss("browser_fast_video_frame_gap");
      }
    }, graceMs);
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
    frameId,
    frameSize,
    chunkIndex,
    chunkCount,
    offset,
    keyframe: Boolean(flags & 0x01),
    capturedUnixMs,
    encodedUnixMs,
    payload,
  };
}

function onChunk(buffer) {
  if (stopped) return;
  const chunk = parseChunk(buffer);
  if (!chunk) return;
  receivedChunks += 1;
  receivedBytes += chunk.payload.byteLength;
  if (waitingForKeyframe && !chunk.keyframe) return;

  let assembly = assemblies.get(chunk.frameId);
  if (!assembly) {
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
      expiryTimer: null,
    };
    assemblies.set(chunk.frameId, assembly);
    pendingAssemblyBytes += chunk.frameSize;
    const expiryMs = assemblyExpiryMs(chunk.keyframe, chunk.chunkCount);
    assembly.expiryTimer = setTimeout(() => {
      const current = assemblies.get(chunk.frameId);
      if (!current || current.complete || stopped) return;
      dropAssembly(current, true);
      // Any missing delta breaks the dependency chain; a missing IDR prevents
      // recovery altogether. In both cases restart at a fresh keyframe.
      resetForLoss(current.keyframe ? "browser_fast_video_keyframe_timeout" : "browser_fast_video_frame_timeout");
    }, expiryMs);
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
      if (assembly.expiryTimer !== null) {
        clearTimeout(assembly.expiryTimer);
        assembly.expiryTimer = null;
      }
    }
  }

  // Bound memory and latency, not just frame count. A burst of giant IDRs must
  // never leave multiple megabytes of stale AUs waiting behind WebCodecs.
  if (assemblies.size > MAX_ASSEMBLIES || pendingAssemblyBytes > MAX_PENDING_ASSEMBLY_BYTES) {
    resetForLoss("browser_fast_video_reassembly_backlog");
    return;
  }
  if (assembly.complete) void drainCompleteFrames().catch(postError);
}

async function start(data) {
  if (typeof VideoDecoder !== "function") throw new Error("WebCodecs VideoDecoder is not available in this browser");
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
  closePendingFrame();
  for (const assembly of [...assemblies.values()]) dropAssembly(assembly, false);
  arrivalByTimestamp.clear();
  pendingAssemblyBytes = 0;
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
