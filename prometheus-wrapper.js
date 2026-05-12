const client = require('prom-client');

const videoCalculatedLookupTotal = new client.Counter({
    name: 'video_calculated_lookup_total',
    help: 'GET /video-calculated outcomes by lookup state and provider',
    labelNames: ['outcome', 'provider'],
});

const requestWithoutVersionTotal = new client.Counter({
    name: 'request_without_version_total',
    help: 'Requests from legacy clients that do not include the v query param',
    labelNames: ['method', 'provider'],
});

function incrementVideoCalculatedLookup(outcome, provider) {
    videoCalculatedLookupTotal.inc({ outcome, provider });
}

function incrementRequestWithoutVersion(method, provider) {
    requestWithoutVersionTotal.inc({ method, provider });
}

module.exports = {
    incrementVideoCalculatedLookup,
    incrementRequestWithoutVersion,
};
