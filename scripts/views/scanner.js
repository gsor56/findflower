(function () {
    'use strict';

    function videoEl() { return document.getElementById('camVideo'); }

    function stopCamera() {
        if (!window.ffCamera || typeof ffCamera.stop !== 'function') return false;
        var was = !!ffCamera.active;
        try { ffCamera.stop(videoEl()); } catch (e) { }
        return was;
    }

    function mount() {
    }

    function unmount() {
        stopCamera();
        if (window.ffTryCoach) {
            try { ffTryCoach.stop(); } catch (e) { }
        }
    }

    window.addEventListener('pagehide', stopCamera);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') stopCamera();
    });

    window.ffViews = window.ffViews || {};
    window.ffViews['try.html'] = { mount: mount, unmount: unmount };

    window.ffScannerView = { stopCamera: stopCamera };
})();
