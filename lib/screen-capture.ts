export interface Screenshot {
  dataUrl: string;
  width: number;
  height: number;
}

export function screenCaptureSupport(): "supported" | "insecure" | "unsupported" {
  if (typeof window === "undefined" || !window.isSecureContext) return "insecure";
  return typeof navigator.mediaDevices?.getDisplayMedia === "function" ? "supported" : "unsupported";
}

/** Called directly by a click; browser/OS consent is never bypassed or persisted. */
export function captureScreenshot(signal: AbortSignal): Promise<Screenshot> {
  if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  if (screenCaptureSupport() !== "supported") return Promise.reject(new DOMException("Screen capture unavailable", "NotSupportedError"));
  // Include the current tab where supported; other browsers ignore the hint.
  const options: DisplayMediaStreamOptions & { selfBrowserSurface: string } = {
    video: true, audio: false, selfBrowserSurface: "include",
  };
  const request = navigator.mediaDevices.getDisplayMedia(options);
  return new Promise((resolve, reject) => {
    let stream: MediaStream | undefined;
    let video: HTMLVideoElement | undefined;
    let track: MediaStreamTrack | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    let settled = false;
    const stop = (source?: MediaStream) => source?.getTracks().forEach(item => item.stop());
    const finish = (error?: Error, result?: Screenshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      track?.removeEventListener("ended", ended);
      if (video) {
        video.removeEventListener("loadeddata", draw);
        video.removeEventListener("error", failed);
        if (frame !== undefined) video.cancelVideoFrameCallback(frame);
        video.pause();
        video.srcObject = null;
        video.remove();
      }
      stop(stream);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    const ended = () => finish(new DOMException("Sharing stopped", "AbortError"));
    const failed = () => finish(new DOMException("No screen frame", "NotReadableError"));
    function draw() {
      if (settled || !video || video.readyState < 2) return;
      const { videoWidth: width, videoHeight: height } = video;
      if (!width || !height) return;
      try {
        const scale = Math.min(1, 2560 / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new DOMException("Canvas unavailable", "NotReadableError");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Stop sharing before encoding or showing the local preview.
        stop(stream);
        const dataUrl = canvas.toDataURL("image/png");
        if (!dataUrl.startsWith("data:image/png;base64,")) throw new DOMException("Empty screenshot", "NotReadableError");
        if (dataUrl.length > 12 * 1024 * 1024) throw new DOMException("Screenshot too large", "QuotaExceededError");
        finish(undefined, { dataUrl, width: canvas.width, height: canvas.height });
      } catch (error) { finish(error instanceof Error ? error : new Error("Screen capture failed")); }
    }
    signal.addEventListener("abort", abort, { once: true });
    request.then(source => {
      // A picker can resolve after the composer unmounts or the user cancels.
      if (settled || signal.aborted) { stop(source); abort(); return; }
      stream = source;
      try {
        track = source.getVideoTracks()[0];
        if (!track || track.readyState === "ended") { failed(); return; }
        track.addEventListener("ended", ended, { once: true });
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("aria-hidden", "true");
        video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
        document.body.appendChild(video);
        video.srcObject = source;
        video.addEventListener("error", failed, { once: true });
        // Prefer a decoded frame, rather than metadata that can produce a blank PNG.
        if (typeof video.requestVideoFrameCallback === "function") frame = video.requestVideoFrameCallback(draw);
        else video.addEventListener("loadeddata", draw);
        timer = setTimeout(() => finish(new DOMException("No frame received", "TimeoutError")), 10_000);
        void video.play().then(() => { if (frame === undefined) draw(); }, failed);
      } catch (error) { finish(error instanceof Error ? error : new Error("Screen capture failed")); }
    }, error => finish(error));
  });
}
