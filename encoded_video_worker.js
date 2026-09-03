"use strict";

const DEFAULT_CODEC = "avc1.42E01F";
const MAX_DECODE_QUEUE = 3;
const KEYFRAME_REQUEST_COOLDOWN_MS = 500;
const REPORT_INTERVAL_MS = 250;
const MAX_FORMAT_FAILURES = 4;
const MAX_DECODER_FAILURES = 3;

let stopped = false;
let passthroughOnly = false;
let transformerRef = null;
let decoder = null;
let decoderConfig = null;
let decoderReady = false;
let canvas = null;
let context = null;
let pendingFrame = null;
let drawQueued = false;
let waitingForKeyframe = true;
let lastKeyframeRequestAt = -Infinity;
let lastReportAt = 0;
let decodedFrames = 0;
let renderedFrames = 0;
let decodeResets = 0;
let latestChunkTimestamp = 0;
let formatFailures = 0;
let decoderFailures = 0;
let diagnosticFrames = 0;
const arrivalByTimestamp = new Map();
let cachedParameterSets = [];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function postError(error) {
  self.postMessage({ type: "error", message: errorMessage(error) });
}

function requestKeyframe(reason) {
  const now = performance.now();
  if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return;
  lastKeyframeRequestAt = now;

  // Prefer the receiver-side WebRTC API. This emits a normal key-frame request
  // without waiting for the application's control data channel.
  if (transformerRef && typeof transformerRef.sendKeyFrameRequest === "function") {
    try {
      const pending = transformerRef.sendKeyFrameRequest();
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => self.postMessage({ type: "request-keyframe", reason }));
      }
      return;
    } catch (_) {}
  }
  self.postMessage({ type: "request-keyframe", reason });
}

function isAnnexB(data) {
  return (
    data.byteLength >= 4 &&
    data[0] === 0 &&
    data[1] === 0 &&
    (data[2] === 1 || (data[2] === 0 && data[3] === 1))
  );
}

function startCodeLengthAt(data, offset) {
  if (offset + 3 <= data.byteLength && data[offset] === 0 && data[offset + 1] === 0) {
    if (data[offset + 2] === 1) return 3;
    if (offset + 4 <= data.byteLength && data[offset + 2] === 0 && data[offset + 3] === 1) return 4;
  }
  return 0;
}

function concatNals(nals) {
  let total = 0;
  for (const nal of nals) total += 4 + nal.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of nals) {
    out.set([0, 0, 0, 1], offset);
    offset += 4;
    out.set(nal, offset);
    offset += nal.byteLength;
  }
  return out;
}

function normalizeAnnexB(data) {
  const nals = [];
  let offset = 0;
  while (offset < data.byteLength) {
    let sc = startCodeLengthAt(data, offset);
    if (!sc) {
      offset += 1;
      continue;
    }
    const nalStart = offset + sc;
    let next = nalStart;
    while (next < data.byteLength && !startCodeLengthAt(data, next)) next += 1;
    if (next > nalStart) nals.push(data.slice(nalStart, next));
    offset = next;
  }
  return nals.length ? concatNals(nals) : null;
}

function tryLengthPrefixed(data, lengthBytes) {
  let offset = 0;
  const nals = [];
  while (offset + lengthBytes <= data.byteLength) {
    let length = 0;
    for (let i = 0; i < lengthBytes; i += 1) length = (length * 256) + data[offset + i];
    offset += lengthBytes;
    if (length <= 0 || offset + length > data.byteLength) return null;
    const nal = data.slice(offset, offset + length);
    const type = nal[0] & 0x1f;
    if (!nal.byteLength || type < 1 || type > 23) return null;
    nals.push(nal);
    offset += length;
  }
  if (offset !== data.byteLength || nals.length === 0) return null;
  return concatNals(nals);
}

function tryStapAWithTail(data) {
  if (!data.byteLength || (data[0] & 0x1f) !== 24) return null;
  const nals = [];
  let offset = 1;
  while (offset + 2 <= data.byteLength) {
    const length = (data[offset] << 8) | data[offset + 1];
    if (length <= 0 || offset + 2 + length > data.byteLength) break;
    const nal = data.slice(offset + 2, offset + 2 + length);
    const type = nal[0] & 0x1f;
    if (!nal.byteLength || type < 1 || type > 23) break;
    nals.push(nal);
    offset += 2 + length;
  }

  // rtc/libwebrtc can expose an assembled H.264 receiver frame as a STAP-A
  // payload followed by a reconstructed FU-A NAL. The packet boundary is no
  // longer exposed, but after the valid STAP lengths the remainder is one raw
  // NAL in the stream produced by our host.
  if (offset < data.byteLength) {
    const tail = data.slice(offset);
    const type = tail[0] & 0x1f;
    if (type >= 1 && type <= 23) nals.push(tail);
  }
  return nals.length ? concatNals(nals) : null;
}

function copyReceiverH264AsAnnexB(encodedFrame) {
  const source = new Uint8Array(encodedFrame.data);
  if (!source.byteLength) throw new Error("received an empty H.264 encoded frame");

  if (isAnnexB(source)) {
    const normalized = normalizeAnnexB(source);
    if (normalized) return { data: normalized, format: "annexb" };
  }

  // Some implementations expose decoder-ready AVCC. Try the common length
  // sizes before interpreting the data as libwebrtc's depacketized H.264.
  for (const lengthBytes of [4, 2, 1]) {
    const converted = tryLengthPrefixed(source, lengthBytes);
    if (converted) return { data: converted, format: `avcc-${lengthBytes}` };
  }

  const firstType = source[0] & 0x1f;
  if (firstType === 24) {
    const converted = tryStapAWithTail(source);
    if (converted) return { data: converted, format: "webrtc-stap-a" };
  }

  // A FU-A is reassembled by libwebrtc before the receiver transform. A P
  // frame from this host is therefore normally one raw type-1 NAL, and an IDR
  // may be one raw type-5 NAL. Prefixing a start code restores Annex B.
  if (firstType >= 1 && firstType <= 23) {
    return { data: concatNals([source.slice()]), format: `webrtc-raw-nal-${firstType}` };
  }

  throw new Error(`unsupported receiver H.264 frame layout (first NAL type ${firstType}, ${source.byteLength} bytes)`);
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

function prependCachedParameterSets(data, metadata, isKey) {
  if (!isKey) return data;
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
  throw new Error(`WebCodecs H.264 decoder is unavailable for ${codec || DEFAULT_CODEC}`);
}

function closePendingFrame() {
  if (!pendingFrame) return;
  try { pendingFrame.frame.close(); } catch (_) {}
  pendingFrame = null;
}

function drawLatest() {
  drawQueued = false;
  if (stopped || passthroughOnly || !pendingFrame || !context || !canvas) {
    closePendingFrame();
    return;
  }
  const item = pendingFrame;
  pendingFrame = null;
  const frame = item.frame;
  try {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (!width || !height) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(frame, 0, 0, width, height);
    renderedFrames += 1;
    const now = performance.now();
    const pipelineMs = Math.max(0, now - item.encodedArrivalAt);
    if (now - lastReportAt >= REPORT_INTERVAL_MS || renderedFrames === 1) {
      lastReportAt = now;
      self.postMessage({
        type: "frame",
        width,
        height,
        pipelineMs,
        decoderQueue: decoder?.decodeQueueSize || 0,
        decodedFrames,
        renderedFrames,
        decodeResets,
      });
    }
  } finally {
    frame.close();
  }
}

function onDecodedFrame(frame) {
  if (passthroughOnly || stopped) {
    frame.close();
    return;
  }
  decodedFrames += 1;
  decoderFailures = 0;
  if (pendingFrame) {
    try { pendingFrame.frame.close(); } catch (_) {}
  }
  const encodedArrivalAt = arrivalByTimestamp.get(frame.timestamp) ?? performance.now();
  arrivalByTimestamp.delete(frame.timestamp);
  pendingFrame = { frame, encodedArrivalAt, timestamp: frame.timestamp };
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
      decoderFailures += 1;
      console.warn("RemotePlay WebCodecs decoder error", error);
      waitingForKeyframe = true;
      requestKeyframe("webcodecs_decoder_error");
      if (decoderFailures >= MAX_DECODER_FAILURES) {
        passthroughOnly = true;
        postError(`WebCodecs decoder repeatedly failed: ${errorMessage(error)}`);
        return;
      }
      try { createDecoder(decoderConfig); } catch (recreateError) { postError(recreateError); }
    },
  });
  decoder.configure(config);
}

function resetForCatchup(reason) {
  decodeResets += 1;
  waitingForKeyframe = true;
  closePendingFrame();
  arrivalByTimestamp.clear();
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

function prepareEncodedFrame(encodedFrame) {
  const encodedArrivalAt = performance.now();
  const converted = copyReceiverH264AsAnnexB(encodedFrame);
  let data = converted.data;
  let metadata = h264Metadata(data);
  const isKey = encodedFrame.type === "key" || metadata.key;
  data = prependCachedParameterSets(data, metadata, isKey);
  metadata = h264Metadata(data);
  const timestamp = Number.isFinite(encodedFrame.timestamp)
    ? Number(encodedFrame.timestamp)
    : Math.max(latestChunkTimestamp + 1, Math.round(performance.now() * 1000));
  latestChunkTimestamp = Math.max(latestChunkTimestamp, timestamp);

  if (diagnosticFrames < 4) {
    diagnosticFrames += 1;
    let rtcMetadata = {};
    try { rtcMetadata = encodedFrame.getMetadata?.() || {}; } catch (_) {}
    self.postMessage({
      type: "diagnostic",
      frameType: encodedFrame.type,
      byteLength: encodedFrame.data.byteLength,
      convertedLength: data.byteLength,
      format: converted.format,
      firstNalType: data.byteLength >= 5 ? data[4] & 0x1f : null,
      codec: metadata.codec,
      mimeType: rtcMetadata.mimeType || null,
    });
  }

  return { data, metadata, isKey, timestamp, encodedArrivalAt };
}

function decodePrepared(prepared) {
  if (stopped || passthroughOnly || !decoderReady || !decoder) return;
  const { data, metadata, isKey, timestamp, encodedArrivalAt } = prepared;

  // SDP normally gives the right profile, but hardware encoders can emit a
  // more specific SPS profile. WebCodecs is stricter than Chromium's WebRTC
  // decoder, so follow the SPS on an IDR before feeding that access unit.
  if (isKey && metadata.codec && metadata.codec !== decoderConfig?.codec) {
    try {
      createDecoder({ ...decoderConfig, codec: metadata.codec });
      waitingForKeyframe = true;
      self.postMessage({ type: "diagnostic", codecReconfigured: metadata.codec });
    } catch (error) {
      console.debug("SPS-derived WebCodecs profile reconfigure failed", error);
    }
  }

  if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) resetForCatchup("webcodecs_decode_backlog");

  if (waitingForKeyframe) {
    if (!isKey) {
      requestKeyframe("webcodecs_waiting_for_keyframe");
      return;
    }
    waitingForKeyframe = false;
  }

  arrivalByTimestamp.set(timestamp, encodedArrivalAt);
  if (arrivalByTimestamp.size > 32) arrivalByTimestamp.delete(arrivalByTimestamp.keys().next().value);

  try {
    decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp, data }));
    formatFailures = 0;
  } catch (error) {
    arrivalByTimestamp.delete(timestamp);
    console.warn("RemotePlay WebCodecs decode() rejected a frame", error);
    resetForCatchup("webcodecs_decode_rejected");
  }
}

function startTransform(transformer) {
  if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") {
    throw new Error("WebCodecs VideoDecoder is not available in this worker");
  }

  transformerRef = transformer;
  const options = transformer.options || {};
  canvas = options.canvas || null;
  if (!canvas) throw new Error("Encoded Transform did not receive an OffscreenCanvas");
  context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) throw new Error("Could not create desynchronized OffscreenCanvas context");

  // Start pass-through immediately. Decoder probing/configuration must never
  // block Chromium's normal WebRTC receive pipeline.
  const transform = new TransformStream({
    transform(encodedFrame, controller) {
      let prepared = null;
      if (!stopped && !passthroughOnly && decoderReady) {
        try {
          prepared = prepareEncodedFrame(encodedFrame);
        } catch (error) {
          formatFailures += 1;
          if (formatFailures <= MAX_FORMAT_FAILURES) {
            self.postMessage({ type: "diagnostic", formatError: errorMessage(error) });
          }
          if (formatFailures >= MAX_FORMAT_FAILURES) {
            passthroughOnly = true;
            postError(`Could not reconstruct receiver H.264 for WebCodecs: ${errorMessage(error)}`);
          }
        }
      }

      // The original frame must always be returned to the WebRTC pipeline.
      controller.enqueue(encodedFrame);
      if (prepared) decodePrepared(prepared);
    },
  });

  transformer.readable
    .pipeThrough(transform)
    .pipeTo(transformer.writable)
    .catch((error) => {
      if (!stopped) postError(error);
    });

  void supportedConfig(options.codec || DEFAULT_CODEC)
    .then((config) => {
      if (stopped || passthroughOnly) return;
      createDecoder(config);
      decoderReady = true;
      waitingForKeyframe = true;
      self.postMessage({ type: "ready", codec: decoderConfig.codec });
      requestKeyframe("webcodecs_start");
    })
    .catch((error) => {
      passthroughOnly = true;
      postError(error);
    });
}

addEventListener("rtctransform", (event) => {
  if (event.transformer?.options?.name !== "remoteplay-webcodecs-video") return;
  try { startTransform(event.transformer); } catch (error) { postError(error); }
});

self.onmessage = ({ data }) => {
  if (data?.type === "passthrough-only") {
    passthroughOnly = true;
    decoderReady = false;
    closePendingFrame();
    arrivalByTimestamp.clear();
    if (decoder) {
      try { decoder.close(); } catch (_) {}
      decoder = null;
    }
    self.postMessage({ type: "passthrough" });
    return;
  }
  if (data?.type !== "stop") return;
  stopped = true;
  passthroughOnly = true;
  closePendingFrame();
  arrivalByTimestamp.clear();
  if (decoder) {
    try { decoder.close(); } catch (_) {}
    decoder = null;
  }
};
