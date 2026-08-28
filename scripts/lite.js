(function () {
    'use strict';

    var MODEL_URL = new URL('../models/lite/model.json', document.currentScript.src).href;
    var LABELS_URL = new URL('../models/lite/class_names.json', document.currentScript.src).href;
    var EXPECTED_CLASSES = 107;
    var modelPromise = null;
    var labelsPromise = null;

    function resetLoadState() {
        modelPromise = null;
        labelsPromise = null;
    }

    async function chooseBackend() {
        await window.tf.ready();
        if (window.tf.getBackend() === 'webgl') return;
        try {
            await window.tf.setBackend('webgl');
        } catch (err) {
            if (window.tf.getBackend() !== 'cpu') await window.tf.setBackend('cpu');
        }
        await window.tf.ready();
    }

    function validateModel(model, labels) {
        var inputShape = model.inputs && model.inputs[0] && model.inputs[0].shape;
        var outputShape = model.outputs && model.outputs[0] && model.outputs[0].shape;
        var outputClasses = outputShape && outputShape[outputShape.length - 1];
        if (!inputShape || inputShape.length !== 4 || inputShape[3] !== 3) {
            throw new Error('Lite model has an unsupported input shape.');
        }
        if (!Array.isArray(labels) || labels.length !== EXPECTED_CLASSES || outputClasses !== labels.length) {
            throw new Error('Lite model labels do not match its output classes.');
        }
    }

    async function warmModel(model) {
        var input = window.tf.zeros([1, 224, 224, 3]);
        var output;
        try {
            output = model.predict(input);
            if (Array.isArray(output)) output = output[0];
            await output.data();
        } finally {
            input.dispose();
            if (output && output.dispose) output.dispose();
        }
    }

    function collectKerasHistories(value, histories) {
        if (!value || typeof value !== 'object') return;
        if (value.class_name === '__keras_tensor__' && value.config && value.config.keras_history) {
            histories.push(value.config.keras_history);
            return;
        }
        Object.keys(value).forEach(function (key) { collectKerasHistories(value[key], histories); });
    }

    function patchKeras3Metadata(value, nestModelIO) {
        if (!value || typeof value !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(value, 'batch_shape')) {
            value.batch_input_shape = value.batch_shape;
            delete value.batch_shape;
        }
        if (value.dtype && typeof value.dtype === 'object' && value.dtype.config && value.dtype.config.name) {
            value.dtype = value.dtype.config.name;
        }
        if (nestModelIO && (value.class_name === 'Functional' || value.class_name === 'Model') && value.config) {
            ['input_layers', 'output_layers'].forEach(function (key) {
                if (Array.isArray(value.config[key]) && typeof value.config[key][0] === 'string') {
                    value.config[key] = [value.config[key]];
                }
            });
        }
        if (Array.isArray(value.inbound_nodes) && value.inbound_nodes.some(function (node) { return !Array.isArray(node); })) {
            value.inbound_nodes = value.inbound_nodes.map(function (node) {
                var histories = [];
                collectKerasHistories(node.args, histories);
                var legacy = histories.map(function (history) { return [history[0], history[1], history[2], {}]; });
                return legacy;
            });
        }
        Object.keys(value).forEach(function (key) { patchKeras3Metadata(value[key], nestModelIO); });
    }

    function flattenNestedModels(modelTopology) {
        var root = modelTopology && modelTopology.model_config;
        if (!root || !root.config || !Array.isArray(root.config.layers)) return;

        function asRef(value) {
            if (!Array.isArray(value) || !value.length) return null;
            return typeof value[0] === 'string' ? value : value[0];
        }
        function replaceRefs(nodes, fromName, toRef) {
            if (!Array.isArray(nodes)) return;
            nodes.forEach(function (node) {
                if (!Array.isArray(node)) return;
                node.forEach(function (ref) {
                    if (Array.isArray(ref) && ref[0] === fromName) {
                        ref[0] = toRef[0];
                        ref[1] = toRef[1];
                        ref[2] = toRef[2];
                    }
                });
            });
        }

        var layers = root.config.layers;
        for (var i = 0; i < layers.length; i++) {
            var nested = layers[i];
            if (!nested || (nested.class_name !== 'Functional' && nested.class_name !== 'Model') || !nested.config) continue;
            var nestedConfig = nested.config;
            if (!Array.isArray(nestedConfig.layers)) continue;
            var nestedInput = asRef(nestedConfig.input_layers);
            var nestedOutput = asRef(nestedConfig.output_layers);
            var outerInput = nested.inbound_nodes && nested.inbound_nodes[0] && nested.inbound_nodes[0][0];
            if (!nestedInput || !nestedOutput || !outerInput) continue;

            var innerLayers = nestedConfig.layers.filter(function (layer) {
                return !layer || layer.name !== nestedInput[0];
            });
            innerLayers.forEach(function (layer) {
                if (!layer || !Array.isArray(layer.inbound_nodes)) return;
                layer.inbound_nodes.forEach(function (node) {
                    node.forEach(function (ref) {
                        if (Array.isArray(ref) && ref[0] === nestedInput[0]) {
                            ref[0] = outerInput[0];
                            ref[1] = outerInput[1];
                            ref[2] = outerInput[2];
                        }
                    });
                });
            });

            layers.forEach(function (layer) {
                if (layer && layer !== nested) replaceRefs(layer.inbound_nodes, nested.name, nestedOutput);
            });
            layers.splice.apply(layers, [i, 1].concat(innerLayers));
            i += innerLayers.length - 1;
        }
    }

    function normalizeWeightSpecs(modelTopology, weightSpecs) {
        var depthwiseLayers = {};
        function visit(value) {
            if (!value || typeof value !== 'object') return;
            if (value.class_name === 'DepthwiseConv2D' && value.name) depthwiseLayers[value.name] = true;
            Object.keys(value).forEach(function (key) { visit(value[key]); });
        }
        visit(modelTopology);
        return weightSpecs.map(function (spec) {
            if (spec && typeof spec.name === 'string') {
                var slash = spec.name.lastIndexOf('/');
                var layerName = slash > 0 ? spec.name.slice(0, slash) : '';
                if (depthwiseLayers[layerName] && spec.name.slice(slash + 1) === 'kernel') {
                    return Object.assign({}, spec, { name: layerName + '/depthwise_kernel' });
                }
            }
            return spec;
        });
    }

    async function loadCompatibleModel() {
        var artifacts = await window.tf.io.browserHTTPRequest(MODEL_URL).load();
        var lastError;
        for (var i = 0; i < 2; i++) {
            try {
                var candidate = Object.assign({}, artifacts, {
                    modelTopology: JSON.parse(JSON.stringify(artifacts.modelTopology))
                });
                // Keras 3 exports `batch_shape` and object-style nodes; TFJS
                // Layers still reads the legacy forms. Repair metadata only.
                patchKeras3Metadata(candidate.modelTopology, i === 1);
                flattenNestedModels(candidate.modelTopology);
                candidate.weightSpecs = normalizeWeightSpecs(candidate.modelTopology, candidate.weightSpecs);
                return await window.tf.loadLayersModel(window.tf.io.fromMemory(candidate));
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error('Lite model could not be loaded.');
    }

    async function load() {
        if (!window.tf) throw new Error('TensorFlow.js is unavailable.');
        await chooseBackend();
        if (!modelPromise) {
            modelPromise = loadCompatibleModel().catch(function (err) {
                modelPromise = null;
                throw err;
            });
        }
        if (!labelsPromise) {
            labelsPromise = fetch(LABELS_URL, { cache: 'default' }).then(function (response) {
                if (!response.ok) throw new Error('Lite labels could not be loaded.');
                return response.json();
            }).catch(function (err) {
                labelsPromise = null;
                throw err;
            });
        }
        try {
            var parts = await Promise.all([modelPromise, labelsPromise]);
            validateModel(parts[0], parts[1]);
            if (!parts[0].ffWarmed) {
                await warmModel(parts[0]);
                parts[0].ffWarmed = true;
            }
            return parts;
        } catch (err) {
            resetLoadState();
            throw err;
        }
    }

    function decodeWithImage(blob) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(blob);
            var image = new Image();
            image.onload = function () {
                URL.revokeObjectURL(url);
                resolve(image);
            };
            image.onerror = function () {
                URL.revokeObjectURL(url);
                reject(new Error('The selected image could not be decoded.'));
            };
            image.src = url;
        });
    }

    async function decodeImage(blob) {
        if (!(blob instanceof Blob) || !blob.size) throw new Error('No image was supplied to the Lite model.');
        if (typeof createImageBitmap === 'function') {
            try {
                return await createImageBitmap(blob, { imageOrientation: 'from-image' });
            } catch (err) {
                // Safari and older mobile browsers can reject valid camera JPEGs here.
            }
        }
        return decodeWithImage(blob);
    }

    async function predict(blob, limit) {
        var parts = await load();
        var model = parts[0], labels = parts[1];
        var decoded = await decodeImage(blob);
        var input = window.tf.tidy(function () {
            var pixels = window.tf.browser.fromPixels(decoded, 3);
            var resized = window.tf.image.resizeBilinear(pixels, [224, 224], true);
            // The exported model contains its own Rescaling(2, -1) layer.
            return resized.toFloat().div(255).expandDims(0);
        });
        var output;
        try {
            output = model.predict(input);
            if (Array.isArray(output)) output = output[0];
            var values = Array.from(await output.data());
            if (values.length !== labels.length || values.some(function (p) { return !Number.isFinite(p); })) {
                throw new Error('Lite model returned an invalid prediction.');
            }
            return values.map(function (p, i) { return { name: labels[i], p: p }; })
                .sort(function (a, b) { return b.p - a.p; })
                .slice(0, Math.max(1, limit || 5));
        } finally {
            input.dispose();
            if (output && output.dispose) output.dispose();
            if (decoded && typeof decoded.close === 'function') decoded.close();
        }
    }

    window.ffLite = { load: load, predict: predict, modelUrl: MODEL_URL, labelsUrl: LABELS_URL };
})();
