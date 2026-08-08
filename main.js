/**
 * FindFlower scanner runtime.
 *
 * Shared, page-agnostic logic for the camera scanner: backend liveness,
 * confidence tiering, and camera lifecycle. try.html wires its own DOM to
 * these; nothing here touches the DOM except the status indicator it is
 * handed. The pre-inference focus check lives in its own file, blur.js.
 *
 * Exposes window.ffStatus, window.ffConfidence, window.ffCamera.
 */
(function () {
  "use strict";

  // === Confidence tiering ==================================================
  //
  // Three outcomes, because a 45%-confident species name is worse than no name
  // at all -- the user photographs it, believes it, and misidentifies a plant.
  //   high      >= 80%  trust it, save it, count it toward the streak
  //   uncertain >= 40%  show the candidates, let the human decide
  //   low        < 40%  refuse to name anything
  const HIGH = 0.80;
  const UNCERTAIN = 0.40;

  const ffConfidence = {
    HIGH,
    UNCERTAIN,
    tier(p) {
      const v = typeof p === "number" ? p : 0;
      if (v >= HIGH) return "high";
      if (v >= UNCERTAIN) return "uncertain";
      return "low";
    },
    LOW_MESSAGE:
      "Unable to clearly identify a flower. Please move closer and ensure good lighting.",
    UNCERTAIN_PROMPT: "Uncertain match — does it look like one of these?",
  };

  // === Blur shield =========================================================
  //
  // MOVED. The Laplacian-variance focus check now lives in blur.js, which
  // try.html loads before this file, so there is exactly one implementation
  // and one threshold to calibrate. window.ffBlur is defined there.
  //
  // Nothing is re-exported here: a stub would silently shadow the real module
  // if the script order ever changed, which is worse than a clear failure.

  // === Backend status ======================================================
  //
  // NOTE ON THE PROBE TARGET. The proxy Worker has no /health route and is
  // off-limits to edit, and the inference backend sends no CORS headers, so its
  // /health cannot be read from a browser at all. Its URL is also a Worker
  // secret and deliberately absent from this file -- publishing it here would
  // undo the whole point of gating the model behind the proxy.
  //
  // What is actually readable: a GET to the Worker returns 405 with CORS
  // headers. That is a real liveness signal for the hop the browser depends on.
  // So: reachable+fast => Ready, reachable+slow => degraded, unreachable =>
  // Offline. Cold start is then confirmed from real evidence by the inference
  // path calling markColdStart() when a request runs long or 502s.
  const PROBE_TIMEOUT_MS = 8000;
  const SLOW_MS = 1500;

  const STATES = {
    ready:   { dot: "bg-sage-500",    text: "Ready to identify" },
    cold:    { dot: "bg-amber-500",   text: "Waking up the model…" },
    offline: { dot: "bg-red-500",     text: "Scanner offline" },
    checking:{ dot: "bg-neutral-300", text: "Checking scanner…" },
  };

  const ffStatus = {
    state: "checking",
    _els: null,
    _onChange: null,

    /** Bind the indicator elements once. Both are optional. */
    bind({ dot, label, onChange } = {}) {
      this._els = { dot, label };
      this._onChange = onChange || null;
      this._paint();
      return this;
    },

    _paint() {
      const s = STATES[this.state] || STATES.checking;
      if (this._els && this._els.dot) {
        this._els.dot.className = "w-1.5 h-1.5 rounded-full " + s.dot;
      }
      if (this._els && this._els.label) {
        this._els.label.textContent = s.text;
      }
      if (this._onChange) {
        try { this._onChange(this.state, s.text); } catch { /* caller's problem */ }
      }
    },

    _set(state) {
      if (this.state === state) return;
      this.state = state;
      this._paint();
    },

    markReady() { this._set("ready"); },
    markColdStart() { this._set("cold"); },
    markOffline() { this._set("offline"); },

    /**
     * Probe the proxy. Resolves to "ready" | "cold" | "offline".
     * Never rejects.
     */
    async probe(apiUrl) {
      if (!apiUrl) return this.state;
      this._set("checking");

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      const started = (performance && performance.now) ? performance.now() : Date.now();

      try {
        // GET is intentional: it is the cheapest request that proves the Worker
        // is up without spending an inference on the backend.
        const res = await fetch(apiUrl, {
          method: "GET",
          cache: "no-store",
          signal: ctl.signal,
        });
        const elapsed = ((performance && performance.now) ? performance.now() : Date.now()) - started;

        // Any readable status means the Worker answered and CORS let us see it.
        // 405 is the expected one (it only accepts POST).
        if (res.status >= 500) this._set("cold");
        else this._set(elapsed > SLOW_MS ? "cold" : "ready");
      } catch {
        // Abort, DNS failure, offline, or CORS refusal -- all indistinguishable
        // from here, and all mean the user cannot scan right now.
        this._set("offline");
      } finally {
        clearTimeout(timer);
      }
      return this.state;
    },
  };

  // === Camera lifecycle ====================================================
  //
  // Stopping every track matters for more than tidiness: an un-stopped track
  // keeps the hardware capture light on and the sensor powered, which drains a
  // phone battery in the field and reads to the user as "this site is still
  // watching me".
  const ffCamera = {
    stream: null,

    get active() {
      return !!(this.stream && this.stream.getTracks().some((t) => t.readyState === "live"));
    },

    async start(videoEl, constraints) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera not supported in this browser.");
      }
      this.stop(videoEl);
      const wanted = constraints || {
        video: {
          facingMode: { ideal: "environment" }, // rear camera for field use
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      };
      this.stream = await navigator.mediaDevices.getUserMedia(wanted);
      if (videoEl) {
        videoEl.srcObject = this.stream;
        videoEl.setAttribute("playsinline", ""); // iOS: don't go fullscreen
        try { await videoEl.play(); } catch { /* autoplay policy; user gesture already happened */ }
      }
      return this.stream;
    },

    /** Release the hardware. Safe to call when already stopped. */
    stop(videoEl) {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* already dead */ }
        });
        this.stream = null;
      }
      if (videoEl) {
        try { videoEl.pause(); } catch { /* not playing */ }
        videoEl.srcObject = null;
      }
    },

    /** Grab the current frame as a JPEG blob. */
    capture(videoEl, quality) {
      return new Promise((resolve, reject) => {
        const w = videoEl.videoWidth, h = videoEl.videoHeight;
        if (!w || !h) { reject(new Error("Camera is not ready yet.")); return; }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(videoEl, 0, 0, w, h);
        c.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Could not read the frame."))),
          "image/jpeg",
          typeof quality === "number" ? quality : 0.92
        );
      });
    },
  };

  /** Best-effort coordinates for a scan record. Resolves null if denied. */
  function ffGeolocate(timeoutMs) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      navigator.geolocation.getCurrentPosition(
        (pos) => finish({
          lat: +pos.coords.latitude.toFixed(5),   // ~1m; no need to store more
          lon: +pos.coords.longitude.toFixed(5),
          accuracy: Math.round(pos.coords.accuracy || 0),
        }),
        () => finish(null),
        { timeout: timeoutMs || 5000, maximumAge: 300000, enableHighAccuracy: false }
      );
      setTimeout(() => finish(null), (timeoutMs || 5000) + 500);
    });
  }

  window.ffConfidence = ffConfidence;
  window.ffStatus = ffStatus;
  window.ffCamera = ffCamera;
  window.ffGeolocate = ffGeolocate;
})();
