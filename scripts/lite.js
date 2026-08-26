(function () {
    'use strict';

    var MODEL_URL = 'models/lite/model.json';
    var LABELS_URL = 'models/lite/class_names.json';
    var modelPromise = null;
    var labelsPromise = null;

    function load() {
        if (!window.tf) return Promise.reject(new Error('TensorFlow.js is unavailable.'));
        if (!modelPromise) modelPromise = window.tf.loadLayersModel(MODEL_URL);
        if (!labelsPromise) {
            labelsPromise = fetch(LABELS_URL, { cache: 'force-cache' }).then(function (r) {
                if (!r.ok) throw new Error('Lite labels could not be loaded.');
                return r.json();
            });
        }
        return Promise.all([modelPromise, labelsPromise]);
    }

    function predict(blob, limit) {
        return load().then(function (parts) {
            var model = parts[0], labels = parts[1];
            return createImageBitmap(blob).then(function (bitmap) {
                var input = window.tf.tidy(function () {
                    var pixels = window.tf.browser.fromPixels(bitmap);
                    var resized = window.tf.image.resizeBilinear(pixels, [224, 224]);
                    return resized.toFloat().div(255).expandDims(0);
                });
                var output;
                try {
                    output = model.predict(input);
                    if (Array.isArray(output)) output = output[0];
                    var values = Array.from(output.dataSync());
                    var top = values.map(function (p, i) { return { name: labels[i] || ('Class ' + i), p: p }; })
                        .sort(function (a, b) { return b.p - a.p; })
                        .slice(0, limit || 5);
                    return top;
                } finally {
                    input.dispose();
                    if (output && output.dispose) output.dispose();
                    bitmap.close();
                }
            });
        });
    }

    window.ffLite = { load: load, predict: predict, modelUrl: MODEL_URL };
})();
