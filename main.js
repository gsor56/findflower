(function () {
  "use strict";

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
        try { this._onChange(this.state, s.text); } catch { }
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

    async probe(apiUrl) {
      if (!apiUrl) return this.state;
      this._set("checking");

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      const started = (performance && performance.now) ? performance.now() : Date.now();

      try {
        const res = await fetch(apiUrl, {
          method: "GET",
          cache: "no-store",
          signal: ctl.signal,
        });
        const elapsed = ((performance && performance.now) ? performance.now() : Date.now()) - started;

        if (res.status >= 500) this._set("cold");
        else this._set(elapsed > SLOW_MS ? "cold" : "ready");
      } catch {
        this._set("offline");
      } finally {
        clearTimeout(timer);
      }
      return this.state;
    },
  };

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
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      };
      this.stream = await navigator.mediaDevices.getUserMedia(wanted);
      if (videoEl) {
        videoEl.srcObject = this.stream;
        videoEl.setAttribute("playsinline", "");
        try { await videoEl.play(); } catch { }
      }
      return this.stream;
    },

    stop(videoEl) {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => {
          try { t.stop(); } catch { }
        });
        this.stream = null;
      }
      if (videoEl) {
        try { videoEl.pause(); } catch { }
        videoEl.srcObject = null;
      }
    },

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

  function ffGeolocate(timeoutMs) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      navigator.geolocation.getCurrentPosition(
        (pos) => finish({
          lat: +pos.coords.latitude.toFixed(5),
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
