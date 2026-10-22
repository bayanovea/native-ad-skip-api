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
    shareCollect(refresh, [lastRun, lastSuccess, failedVideos]);
}

// The registry collects every metric in parallel, so the gauges of one query
// await the same refresh of the scrape instead of each running it.
function shareCollect(refresh, gauges) {
    let inFlight = null;
    const collect = () => {
        if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
        return inFlight;
    };
    for (const g of gauges) g.collect = collect;
}

// AI-first state (prv tables), read on every scrape; registered like the
// heartbeat. A failing query is logged once and leaves the gauges empty
// (ai_review_open reads 0: prom-client always exposes a label-less gauge).
function registerAiMetrics(sequelize) {
    const videos = new client.Gauge({
        name: 'ai_videos',
        help: 'prv_ai_videos rows per status',
        labelNames: ['status'],
    });
    const cost = new client.Gauge({
        name: 'ai_cost_usd',
        help: 'Model cost in USD so far: detect (prv_ai_runs) and judge (prv_ai_judgements)',
        labelNames: ['kind'],
    });
    const cost24h = new client.Gauge({
        name: 'ai_cost_usd_24h',
        help: 'Model cost in USD over the last 24 h: detect (prv_ai_runs) and judge (prv_ai_judgements)',
        labelNames: ['kind'],
    });
    const judgements = new client.Gauge({
        name: 'ai_judgements',
        help: 'prv_ai_judgements rows per decision and judge',
        labelNames: ['decision', 'by'],
    });
    const reviewOpen = new client.Gauge({
        name: 'ai_review_open',
        help: 'AI review items without a verdict',
    });
    const costOf = (kind, table) => `SELECT '${kind}' AS kind, COALESCE(SUM(cost_usd), 0) AS total,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) AS day FROM ${table}`;
    let logged = false;
    async function refresh() {
        let results;
        try {
            results = await Promise.all([
                'SELECT status, COUNT(*) AS n FROM prv_ai_videos GROUP BY status',
                `${costOf('detect', 'prv_ai_runs')} UNION ALL ${costOf('judge', 'prv_ai_judgements')}`,
                'SELECT decision, "by", COUNT(*) AS n FROM prv_ai_judgements GROUP BY decision, "by"',
                `SELECT COUNT(*) AS n FROM prv_review_items i
                  WHERE i.kind = 'ai' AND NOT EXISTS (SELECT 1 FROM prv_review_verdicts v WHERE v.item_id = i.id)`,
            ].map(async sql => (await sequelize.query(sql))[0]));
            logged = false;
        } catch (err) {
            if (!logged) console.error('AI metrics query failed:', err.message);
            logged = true;
            results = [[], [], [], []];
        }
        const [videoRows, costRows, judgementRows, openRows] = results;
        for (const g of [videos, cost, cost24h, judgements, reviewOpen]) g.reset();
        for (const { status, n } of videoRows) videos.set({ status }, Number(n));
        for (const { kind, total, day } of costRows) {
            cost.set({ kind }, Number(total));
            cost24h.set({ kind }, Number(day));
        }
        for (const { decision, by, n } of judgementRows) judgements.set({ decision, by }, Number(n));
        for (const { n } of openRows) reviewOpen.set(Number(n));
    }
    shareCollect(refresh, [videos, cost, cost24h, judgements, reviewOpen]);
}

function incrementVideoCalculatedLookup(outcome, provider, source = 'human') {
    videoCalculatedLookupTotal.inc({ outcome, provider, source });
}

function incrementRequestWithoutVersion(method, provider) {
    requestWithoutVersionTotal.inc({ method, provider });
}

module.exports = {
    registerCalculatorHeartbeat,
    registerAiMetrics,
    incrementVideoCalculatedLookup,
    incrementRequestWithoutVersion,
};
