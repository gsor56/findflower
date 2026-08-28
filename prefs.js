(function () {
    'use strict';

    var KEY = 'ff_prefs';

    var DEFAULTS = {
        attachLocation: false,
        keepPhotos: true,
        recordHistory: true,
        reduceMotion: false,
        modelTier: 'standard'
    };

    var CHOICES = {
        modelTier: ['lite', 'standard', 'pro']
    };

    var ENGINES = [
        {
            id: 'lite',
            name: 'Flora-Micro',
            note: 'Identifies on this device. Your photo stays in this browser and is never sent to the server.',
            blurb: 'Flora-Micro is reading your photos: it works inside this tab, knows 107 species, and the picture never leaves the browser.',
            ready: true
        },
        {
            id: 'standard',
            name: 'Flora-Flash',
            note: '116 species. The scanner sends the photo to the FindFlower server and gets the top five back.',
            blurb: 'Flora-Flash is reading your photos: it knows 116 species and runs on the server, so the picture is uploaded, read, and dropped.',
            ready: true
        },
        {
            id: 'pro',
            name: 'Flora-Ultra',
            note: 'A wider vocabulary, on the same server path as Flora-Flash.',
            blurb: '',
            ready: false,
            why: 'Not trained yet.'
        }
    ];

    function engine(id) {
        for (var e = 0; e < ENGINES.length; e++) if (ENGINES[e].id === id) return ENGINES[e];
        return ENGINES[1];
    }

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
        }
        return out;
    }

    function write() {
        try {
            localStorage.setItem(KEY, JSON.stringify(cache));
            return true;
        } catch (e) {
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
            try { listeners[i](key, cache[key]); } catch (e) { }
        }
        return stored;
    }

    function reset() {
        cache = null;
        try { localStorage.removeItem(KEY); } catch (e) { }
        cache = read();
        apply();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](null, null); } catch (e) { }
        }
    }

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
        ENGINES: ENGINES,
        engine: engine,
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
