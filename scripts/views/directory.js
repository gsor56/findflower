(function () {
    'use strict';

    var handle = null;

    async function renderDirectory(opts) {
        var o = opts || {};
        var grid = o.grid || document.getElementById('dirGrid');
        if (!grid) return null;

        if (!window.ffDirectory || typeof ffDirectory.mount !== 'function') {
            console.error('views/directory: directory.js is not loaded.');
            return null;
        }
        if (handle) return handle;

        handle = ffDirectory.mount({
            grid:     grid,
            sentinel: o.sentinel || document.getElementById('dirSentinel'),
            spinner:  o.spinner  || document.getElementById('dirSpinner'),
            endNote:  o.endNote  || document.getElementById('dirEnd'),
            errorBox: o.errorBox || document.getElementById('dirError'),
            retryBtn: o.retryBtn || document.getElementById('dirRetry'),
            countEl:  o.countEl  || document.getElementById('dirCount'),
            infinite: true,
            link:     'species',
            restore:  'ff_dir_scroll',
        });
        await handle.start();
        return handle;
    }

    function teardown() {
        if (window.ffDirectoryInline) {
            try { ffDirectoryInline.stop(); } catch (e) { }
            window.ffDirectoryInline = null;
        }
        if (!handle) return;
        try { handle.stop(); } catch (e) { }
        handle = null;
    }

    async function mount(ctx) {
        if (ctx && ctx.initial) return;
        var grid = document.getElementById('dirGrid');
        if (grid && !grid.querySelector('article')) await renderDirectory({ grid: grid });
    }

    window.ffViews = window.ffViews || {};
    window.ffViews['directory.html'] = { mount: mount, unmount: teardown };

    window.ffDirectoryView = {
        renderDirectory: renderDirectory,
        teardown: teardown,
        get running() { return !!handle; },
    };
})();
