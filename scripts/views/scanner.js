/* ============================================================================
   FindFlower — scanner view (scripts/views/scanner.js)
   ----------------------------------------------------------------------------
   Camera lifecycle for the scanner route.

   IMPORTANT: try.html is NOT router-swapped. It is listed in RELOAD in
   scripts/router.js and always gets a real page load, because its scanner is one
   ~700-line inline block holding the Hugging Face inference path — re-executing
   that on a swap is exactly how inference breaks quietly. Nothing in this file
   touches, wraps, or re-implements that logic.

   What this file adds is the teardown that a real navigation does NOT reliably
   give you. Leaving the page tears down the document, but an un-stopped
   MediaStreamTrack can outlive it long enough to matter: on mobile the capture
   LED stays lit and the sensor stays powered while the page sits in the
   back/forward cache, which drains the battery in the field and reads to the
   user as "this site is still watching me". ffCamera.stop() releases the
   hardware immediately instead of waiting for GC.

   The camera is never started here. It starts only from the user's explicit tap
   on #camStart in try.html, which is the correct gesture-gated behaviour and the
   only thing that satisfies browser autoplay/permission rules anyway.
   ========================================================================== */
(function () {
    'use strict';

    function videoEl() { return document.getElementById('camVideo'); }

    /** Release the camera if one is running. Safe to call any number of times. */
    function stopCamera() {
        if (!window.ffCamera || typeof ffCamera.stop !== 'function') return false;
        var was = !!ffCamera.active;
        try { ffCamera.stop(videoEl()); } catch (e) { /* already dead */ }
        return was;
    }

    /** Route entry. Deliberately does not start the camera — see the header. */
    function mount() {
        // Nothing to do: try.html's inline script owns first paint and wiring.
        // Present so the router has a symmetrical lifecycle for this key if
        // try.html is ever lifted out of RELOAD.
    }

    /** Route exit: hand the hardware back. */
    function unmount() {
        stopCamera();
        // The coach layer's own node is tagged [data-ff-page], so the router
        // removes it on the swap; this is what disconnects its observers and
        // window listeners. stop() rather than dismiss(): leaving the page is
        // not the user saying they have finished with the tips.
        if (window.ffTryCoach) {
            try { ffTryCoach.stop(); } catch (e) { /* never started */ }
        }
    }

    // Real navigations away from try.html (the normal case, since the router
    // does not swap this page). pagehide covers back/forward-cache entry, which
    // is where a stream is most likely to be left running; visibilitychange
    // covers tab-switching and the phone being locked mid-scan.
    window.addEventListener('pagehide', stopCamera);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') stopCamera();
    });

    window.ffViews = window.ffViews || {};
    window.ffViews['try.html'] = { mount: mount, unmount: unmount };

    window.ffScannerView = { stopCamera: stopCamera };
})();
