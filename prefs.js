/* ============================================================================
   FindFlower — device preferences (prefs.js)
   ----------------------------------------------------------------------------
   Five settings the dashboard exposes and the rest of the site obeys. Every one
   of them changes real behaviour somewhere; there is no toggle here that only
   remembers its own position.

     attachLocation  try.html asks for coordinates before writing a scan
     keepPhotos      the thumbnail addScan stores with a scan
     recordHistory   whether a scan is written to IndexedDB at all
     reduceMotion    the <html> class app.css keys its rest state off
     modelTier       which identification engine the scanner asks for

   localStorage, not IndexedDB, and that is a decision rather than laziness.
   try.html reads attachLocation on the capture path, where an await on an
   IndexedDB open would sit in front of the geolocation call; and reduceMotion
   has to be applied before the first paint or the reader sees the animation it
   asked not to see. localStorage is synchronous, so both are free. The cost is
   that preferences are per-device and do not follow an Auth0 account across
   browsers, which is the right trade for settings that describe THIS device.

   Loaded blocking in <head>, next to storage.js and auth.js, for the same
   reason: apply() has to run before the body paints.
   ========================================================================== */
(function () {
    'use strict';

    var KEY = 'ff_prefs';

    // Defaults chosen so a first-time visitor is not surprised. attachLocation
    // is off because the alternative is a geolocation permission dialog nobody
    // asked for -- try.html used to call ffGeolocate() on every single scan.
    var DEFAULTS = {
        attachLocation: false,
        keepPhotos: true,
        recordHistory: true,
        reduceMotion: false,
        modelTier: 'standard'
    };

    // Keys that hold one of a fixed set of strings instead of a flag. Both read()
    // and set() check against this list, so neither a hand-edited localStorage
    // value nor a caller can name an engine the scanner has no branch for.
    var CHOICES = {
        modelTier: ['lite', 'standard', 'pro']
    };

    var MOTION_CLASS = 'ff-reduce-motion';

    var listeners = [];
    var cache = null;

    function read() {
        var out = {};
        for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) out[k] = DEFAULTS[k];
        try {
            var raw = localStorage.getItem(KEY);
            if (raw) {
                var saved = JSON.parse(raw);
                // Only known keys, and only a value of the right shape. A
                // hand-edited localStorage value must not be able to put a
                // string where try.html expects a flag, and a key we have since
                // removed must not come back.
                for (var j in DEFAULTS) {
                    if (!DEFAULTS.hasOwnProperty(j)) continue;
                    if (CHOICES[j]) {
                        if (CHOICES[j].indexOf(saved[j]) !== -1) out[j] = saved[j];
                    } else if (typeof saved[j] === 'boolean') {
                        out[j] = saved[j];
                    }
                }
            }
        } catch (e) {
            // Private mode, disabled storage, or malformed JSON. Defaults stand.
        }
        return out;
    }

    function write() {
        try {
            localStorage.setItem(KEY, JSON.stringify(cache));
            return true;
        } catch (e) {
            // Quota or a locked-down browser: the setting still applies for this
            // page load, it just will not survive a reload. Reported so a caller
            // can say so rather than showing a switch that silently forgets.
            return false;
        }
    }

    function all() {
        if (!cache) cache = read();
        var copy = {};
        for (var k in cache) if (cache.hasOwnProperty(k)) copy[k] = cache[k];
        return copy;
    }

    function get(key) {
        if (!cache) cache = read();
        return cache.hasOwnProperty(key) ? cache[key] : DEFAULTS[key];
    }

    /** The one side effect that belongs to this file rather than to a caller:
     *  reduceMotion is a class on <html>, so it has to be re-applied whenever
     *  the value changes and once at load before anything paints. */
    function apply() {
        var root = document.documentElement;
        if (!root) return;
        if (get('reduceMotion')) root.classList.add(MOTION_CLASS);
        else root.classList.remove(MOTION_CLASS);
    }

    function set(key, value) {
        if (!DEFAULTS.hasOwnProperty(key)) return false;
        if (!cache) cache = read();
        if (CHOICES[key]) {
            if (CHOICES[key].indexOf(value) === -1) return false;
            cache[key] = value;
        } else {
            cache[key] = !!value;
        }
        var stored = write();
        if (key === 'reduceMotion') apply();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](key, cache[key]); } catch (e) { /* a bad listener is not fatal */ }
        }
        return stored;
    }

    function reset() {
        cache = null;
        try { localStorage.removeItem(KEY); } catch (e) { /* nothing to remove */ }
        cache = read();
        apply();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](null, null); } catch (e) { /* ignore */ }
        }
    }

    /** Notified on every set(), with (key, value); (null, null) after reset().
     *  Returns an unsubscribe so a router view can drop its handler on unmount. */
    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () {
            var i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
        };
    }

    window.ffPrefs = {
        DEFAULTS: DEFAULTS,
        CHOICES: CHOICES,
        KEY: KEY,
        MOTION_CLASS: MOTION_CLASS,
        all: all,
        get: get,
        set: set,
        reset: reset,
        apply: apply,
        subscribe: subscribe
    };

    apply();
})();
