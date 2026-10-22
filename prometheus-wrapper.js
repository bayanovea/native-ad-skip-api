const client = require('prom-client');

const videoCalculatedLookupTotal = new client.Counter({
    name: 'video_calculated_lookup_total',
    help: 'GET /video-calculated outcomes by lookup state, provider and the table served (ai | human)',
    labelNames: ['outcome', 'provider', 'source'],
});

const requestWithoutVersionTotal = new client.Counter({
    name: 'request_without_version_total',
    help: 'Requests from legacy clients that do not include the v query param',
    labelNames: ['method', 'provider'],
});

// Heartbeat of the Go calculator (calculator_heartbeats, one row per
// provider), read from the DB on every scrape. Registered from server.js once
// the DB is set up, so this module stays DB-free for the unit tests. A failing
// query is logged once and leaves the gauges empty for that scrape.
function registerCalculatorHeartbeat(sequelize) {
    const lastRun = new client.Gauge({
        name: 'calculator_last_run_timestamp_seconds',
        help: 'Unix time of the last calculator run per provider',
        labelNames: ['provider'],
    });
    const lastSuccess = new client.Gauge({
        name: 'calculator_last_success_timestamp_seconds',
        help: 'Unix time of the last calculator run with no failed video per provider',
        labelNames: ['provider'],
    });
    const failedVideos = new client.Gauge({
        name: 'calculator_failed_videos',
        help: 'Videos that failed in the last calculator run per provider',
        labelNames: ['provider'],
    });
    let logged = false;
    async function refresh() {
        let rows;
        try {
            [rows] = await sequelize.query(
                `SELECT provider, EXTRACT(EPOCH FROM last_run_at) AS last_run,
                        EXTRACT(EPOCH FROM last_success_at) AS last_success, failed_videos
                   FROM calculator_heartbeats`);
            logged = false;
        } catch (err) {
            if (!logged) console.error('Calculator heartbeat query failed:', err.message);
            logged = true;
            rows = [];
        }
        lastRun.reset();
        lastSuccess.reset();
        failedVideos.reset();
        for (const { provider, last_run, last_success, failed_videos } of rows) {
            lastRun.set({ provider }, Number(last_run));
            if (last_success !== null) lastSuccess.set({ provider }, Number(last_success));
            failedVideos.set({ provider }, Number(failed_videos));
        }
    }
    // The registry collects every metric in parallel, so all three gauges await
    // the same query of the scrape instead of each running it.
    let inFlight = null;
    const collect = () => {
        if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
        return inFlight;
    };
    lastRun.collect = collect;
    lastSuccess.collect = collect;
    failedVideos.collect = collect;
}

function incrementVideoCalculatedLookup(outcome, provider, source = 'human') {
    videoCalculatedLookupTotal.inc({ outcome, provider, source });
}

function incrementRequestWithoutVersion(method, provider) {
    requestWithoutVersionTotal.inc({ method, provider });
}

module.exports = {
    registerCalculatorHeartbeat,
    incrementVideoCalculatedLookup,
    incrementRequestWithoutVersion,
};
