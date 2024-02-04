const client = require('prom-client');
const counters = {};

function incrementVideoCalculatedFound(fullNativeVideoId) {
    const [nativeOwnerIdPart, nativeVideoIdPart] = fullNativeVideoId.split('_');
    _incrementCounter('video_calculated_found', { owner_id: nativeOwnerIdPart, video_id: nativeVideoIdPart });
}

function incrementVideoCalculatedNotFound(fullNativeVideoId) {
    const [nativeOwnerIdPart, nativeVideoIdPart] = fullNativeVideoId.split('_');
    _incrementCounter('video_calculated_not_found', { owner_id: nativeOwnerIdPart, video_id: nativeVideoIdPart });
}

function incrementRequestWithoutVersion(method, originalVideoId) {
    _incrementCounter('request_without_version', { method: nativeOwnerIdPart, originalVideoId: originalVideoId });
}

function _incrementCounter(name, labels) {
  const counter = _getOrCreateCounter(name, name, Object.keys(labels));
  counter.inc(labels);
}

function _getOrCreateCounter(name, help, labelNames) {
    if (!counters[name]) {
      counters[name] = new client.Counter({name, help, labelNames});
    }

    return counters[name];
}

module.exports = {
    incrementVideoCalculatedFound,
    incrementVideoCalculatedNotFound,
    incrementRequestWithoutVersion
};
