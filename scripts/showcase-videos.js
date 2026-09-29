(function () {
    'use strict';
    var cleanup = function () {};
    var mounted = null;

    function unmount() {
        cleanup();
        cleanup = function () {};
        mounted = null;
    }

    function mount() {
        var main = document.querySelector('main');
        if (mounted === main) return;
        unmount();
        var videos = main ? Array.from(main.querySelectorAll('video[data-showcase]')) : [];
        if (!videos.length) return;
        mounted = main;
        var toggle = main.querySelector('[data-showcase-toggle]');
        var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        var paused = motion.matches || !!(window.ffPrefs && ffPrefs.get('reduceMotion'));
        var visible = new Set();

        function sync() {
            if (toggle) {
                toggle.textContent = paused ? 'Play demonstrations' : 'Pause demonstrations';
                toggle.setAttribute('aria-pressed', String(paused));
            }
            videos.forEach(function (video) {
                if (paused || document.hidden || !visible.has(video)) {
                    video.pause();
                    return;
                }
                // No src exists before intersection, so preload/autoplay cannot
                // accidentally fetch the lower three videos at page load.
                if (!video.getAttribute('src')) {
                    video.src = video.dataset.src;
                    video.load();
                }
                video.muted = true;
                var play = video.play();
                if (play && play.catch) play.catch(function () {});
            });
        }
        var observer = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) visible.add(entry.target);
                else visible.delete(entry.target);
            });
            sync();
        }, { threshold: 0.05 }) : null;
        videos.forEach(function (video) {
            if (observer) observer.observe(video);
            else visible.add(video);
        });
        function togglePlayback() { paused = !paused; sync(); }
        function motionChanged() {
            paused = motion.matches || !!(window.ffPrefs && ffPrefs.get('reduceMotion'));
            sync();
        }
        if (toggle) toggle.addEventListener('click', togglePlayback);
        motion.addEventListener('change', motionChanged);
        document.addEventListener('visibilitychange', sync);
        var unsubscribe = window.ffPrefs ? ffPrefs.subscribe(function (key) {
            if (key === 'reduceMotion' || key === null) motionChanged();
        }) : function () {};
        sync();
        cleanup = function () {
            if (observer) observer.disconnect();
            videos.forEach(function (video) { video.pause(); });
            if (toggle) toggle.removeEventListener('click', togglePlayback);
            motion.removeEventListener('change', motionChanged);
            document.removeEventListener('visibilitychange', sync);
            unsubscribe();
        };
    }
    window.ffViews = window.ffViews || {};
    window.ffViews['how.html'] = { mount: mount, unmount: unmount };
})();
