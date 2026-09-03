"use strict";

let stopped = false;
let activeTrack = null;

function postError(error) {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({ type: "error", message });
}

async function run(canvas, track) {
  activeTrack = track;
  if (typeof MediaStreamTrackProcessor !== "function") {
    throw new Error("MediaStreamTrackProcessor is not available in this browser worker");
  }

  const context = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });
  if (!context) throw new Error("Could not create desynchronized 2D canvas context");

  const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
  const reader = processor.readable.getReader();
  let lastReportAt = 0;
  self.postMessage({ type: "ready" });

  try {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (width && height) {
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          // Draw immediately instead of waiting for requestAnimationFrame. The
          // desynchronized context is explicitly intended to reduce canvas
          // presentation latency, and maxBufferSize=1 makes this a latest-frame
          // sink rather than a playback queue.
          context.drawImage(frame, 0, 0, width, height);
          const now = performance.now();
          if (now - lastReportAt >= 100) {
            lastReportAt = now;
            self.postMessage({
              type: "frame",
              width,
              height,
              processorDroppedFrames: processor.discardedFrames || 0,
            });
          }
        }
      } finally {
        frame.close();
      }
    }
  } finally {
    try { await reader.cancel(); } catch (_) {}
    try { track.stop(); } catch (_) {}
    activeTrack = null;
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === "stop") {
    stopped = true;
    try { activeTrack?.stop(); } catch (_) {}
    return;
  }
  if (data?.type !== "start") return;
  stopped = false;
  run(data.canvas, data.track).catch(postError);
};
