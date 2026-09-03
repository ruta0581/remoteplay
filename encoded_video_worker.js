"use strict";

const DEFAULT_CODEC = "avc1.42E01F";
const MAX_DECODE_QUEUE = 3;
const KEYFRAME_REQUEST_COOLDOWN_MS = 500;
const REPORT_INTERVAL_MS = 250;

let stopped = false;
let decoder = null;
let decoderConfig = null;
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
let decodeChain = Promise.resolve();
const arrivalByTimestamp = new Map();

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
  self.postMessage({ type: "request-keyframe", reason });
}

function isAnnexB(data) {
  return (
    data.byteLength >= 4 &&
    data[0] === 0 &&
    data[1] === 0 &&
    ((data[2] === 1) || (data[2] === 0 && data[3] === 1))
  );
}

function avccToAnnexB(data) {
  let offset = 0;
  let total = 0;
  const nalUnits = [];
  while (offset + 4 <= data.byteLength) {
    const length =
      (data[offset] * 0x1000000) +
      (data[offset + 1] << 16) +
      (data[offset + 2] << 8) +
      data[offset + 3];
    offset += 4;
    if (length <= 0 || offset + length > data.byteLength) return data.slice();
    nalUnits.push(data.subarray(offset, offset + length));
    total += 4 + length;
    offset += length;
  }
  if (offset !== data.byteLength || nalUnits.length === 0) return data.slice();

  const out = new Uint8Array(total);
  let outOffset = 0;
  for (const nal of nalUnits) {
    out.set([0, 0, 0, 1], outOffset);
    outOffset += 4;
    out.set(nal, outOffset);
    outOffset += nal.byteLength;
  }
  return out;
}

function copyAsAnnexB(buffer) {
  const data = new Uint8Array(buffer);
  return isAnnexB(data) ? data.slice() : avccToAnnexB(data);
}

function forEachAnnexBNal(data, visitor) {
  let index = 0;
  const length = data.byteLength;
  const nextStartCode = (from) => {
    for (let i = from; i + 3 < length; i += 1) {
      if (data[i] !== 0 || data[i + 1] !== 0) continue;
      if (data[i + 2] === 1) return { start: i, header: i + 3 };
      if (data[i + 2] === 0 && data[i + 3] === 1) return { start: i, header: i + 4 };
    }
    return null;
  };

  let current = nextStartCode(0);
  while (current) {
    const next = nextStartCode(current.header + 1);
    const end = next ? next.start : length;
    if (current.header < end) visitor(data.subarray(current.header, end));
    current = next;
    index += 1;
    if (index > 4096) break;
  }
}

function h264Metadata(data) {
  let key = false;
  let codec = null;
  forEachAnnexBNal(data, (nal) => {
    if (!nal.byteLength) return;
    const type = nal[0] & 0x1f;
    if (type === 5) key = true;
    if (type === 7 && nal.byteLength >= 4 && !codec) {
      const profile = [nal[1], nal[2], nal[3]]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
      codec = `avc1.${profile}`;
    }
  });
  return { key, codec };
}

async function supportedConfig(codec) {
  const candidates = [
    {
      codec: codec || DEFAULT_CODEC,
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    },
    {
      codec: codec || DEFAULT_CODEC,
      hardwareAcceleration: "no-preference",
      optimizeForLatency: true,
    },
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
  if (stopped || !pendingFrame || !context || !canvas) {
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
    if (now - lastReportAt >= REPORT_INTERVAL_MS) {
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
  decodedFrames += 1;
  if (pendingFrame) {
    try { pendingFrame.frame.close(); } catch (_) {}
  }
  const encodedArrivalAt = arrivalByTimestamp.get(frame.timestamp) ?? performance.now();
  arrivalByTimestamp.delete(frame.timestamp);
  pendingFrame = {
    frame,
    encodedArrivalAt,
    timestamp: frame.timestamp,
  };
  if (!drawQueued) {
    drawQueued = true;
    queueMicrotask(drawLatest);
  }
}

function onDecoderError(error) {
  console.warn("RemotePlay WebCodecs decoder error", error);
  waitingForKeyframe = true;
  const config = decoderConfig;
  if (config) {
    try { createDecoder(config); } catch (recreateError) { postError(recreateError); }
  }
  requestKeyframe("webcodecs_decoder_error");
}

function createDecoder(config) {
  if (decoder) {
    try { decoder.close(); } catch (_) {}
  }
  decoderConfig = config;
  decoder = new VideoDecoder({
    output: onDecodedFrame,
    error: onDecoderError,
  });
  decoder.configure(config);
}

async function reconfigureForCodec(codec) {
  if (!codec || codec === decoderConfig?.codec) return;
  const config = await supportedConfig(codec);
  createDecoder(config);
}

function resetForCatchup(reason) {
  decodeResets += 1;
  waitingForKeyframe = true;
  closePendingFrame();
  arrivalByTimestamp.clear();
  if (decoder && decoderConfig) {
    try {
      if (decoder.state === "closed") {
        createDecoder(decoderConfig);
      } else {
        decoder.reset();
        decoder.configure(decoderConfig);
      }
    } catch (error) {
      postError(error);
    }
  }
  requestKeyframe(reason);
}

function prepareEncodedFrame(encodedFrame) {
  const encodedArrivalAt = performance.now();
  const data = copyAsAnnexB(encodedFrame.data);
  const metadata = h264Metadata(data);
  const isKey = encodedFrame.type === "key" || metadata.key;
  const timestamp = Number.isFinite(encodedFrame.timestamp)
    ? Number(encodedFrame.timestamp)
    : Math.max(latestChunkTimestamp + 1, Math.round(performance.now() * 1000));
  latestChunkTimestamp = Math.max(latestChunkTimestamp, timestamp);
  return { data, metadata, isKey, timestamp, encodedArrivalAt };
}

async function decodePrepared(prepared) {
  if (stopped || !decoder) return;
  const { data, metadata, isKey, timestamp, encodedArrivalAt } = prepared;

  if (metadata.codec && metadata.codec !== decoderConfig?.codec && isKey) {
    try {
      await reconfigureForCodec(metadata.codec);
      waitingForKeyframe = true;
    } catch (error) {
      console.debug("SPS-derived WebCodecs profile was rejected; keeping negotiated profile", error);
    }
  }

  if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
    resetForCatchup("webcodecs_decode_backlog");
  }

  if (waitingForKeyframe) {
    if (!isKey) {
      requestKeyframe("webcodecs_waiting_for_keyframe");
      return;
    }
    waitingForKeyframe = false;
  }

  arrivalByTimestamp.set(timestamp, encodedArrivalAt);
  if (arrivalByTimestamp.size > 32) {
    const oldest = arrivalByTimestamp.keys().next().value;
    arrivalByTimestamp.delete(oldest);
  }

  try {
    decoder.decode(new EncodedVideoChunk({
      type: isKey ? "key" : "delta",
      timestamp,
      data,
    }));
  } catch (error) {
    arrivalByTimestamp.delete(timestamp);
    console.warn("RemotePlay WebCodecs decode() rejected a frame", error);
    resetForCatchup("webcodecs_decode_rejected");
  }
}

async function startTransform(transformer) {
  if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") {
    throw new Error("WebCodecs VideoDecoder is not available in this worker");
  }

  const options = transformer.options || {};
  canvas = options.canvas || null;
  if (!canvas) throw new Error("Encoded Transform did not receive an OffscreenCanvas");
  context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) throw new Error("Could not create desynchronized OffscreenCanvas context");

  const initialConfig = await supportedConfig(options.codec || DEFAULT_CODEC);
  createDecoder(initialConfig);

  const transform = new TransformStream({
    transform(encodedFrame, controller) {
      // Copy before enqueueing the original RTCEncodedVideoFrame. The custom
      // WebCodecs path renders from this copy, while the original frame is
      // immediately returned to WebRTC to keep receiver state/RTCP healthy.
      // The displayed surface never consumes the built-in decoded track.
      const prepared = prepareEncodedFrame(encodedFrame);
      controller.enqueue(encodedFrame);
      decodeChain = decodeChain
        .then(() => decodePrepared(prepared))
        .catch((error) => {
          console.warn("RemotePlay encoded-frame decode failed", error);
          resetForCatchup("webcodecs_decode_error");
        });
    },
  });

  transformer.readable
    .pipeThrough(transform)
    .pipeTo(transformer.writable)
    .catch((error) => {
      if (!stopped) postError(error);
    });

  self.postMessage({ type: "ready", codec: decoderConfig.codec });
}

addEventListener("rtctransform", (event) => {
  if (event.transformer?.options?.name !== "remoteplay-webcodecs-video") return;
  void startTransform(event.transformer).catch(postError);
});

self.onmessage = ({ data }) => {
  if (data?.type !== "stop") return;
  stopped = true;
  closePendingFrame();
  arrivalByTimestamp.clear();
  if (decoder) {
    try { decoder.close(); } catch (_) {}
    decoder = null;
  }
};
