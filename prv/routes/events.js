const express = require('express');
const handler = require('../../middleware/handler');
const { LEGACY_PRV } = require('../../lib/legacy-field');

const EVENT_TYPES = ['interval_skip', 'interval_undo', 'interval_overrun', 'interval_click', 'time_saved', 'client_failed'];
const BOUNDS_TYPES = ['interval_skip', 'interval_undo', 'interval_overrun', 'interval_click'];
const MAX_EVENTS = 100;
const isCount = (v) => Number.isInteger(v) && v >= 0;

function validateEvent(event) {
    if (!event || typeof event !== 'object') return 'each event must be an object';
    if (!EVENT_TYPES.includes(event.type)) return `unknown event type: ${event.type}`;
    if (typeof event.user_id !== 'string') return 'user_id must be a string';

    if (BOUNDS_TYPES.includes(event.type)) {
        if (typeof event.video_native_id !== 'string') return 'video_native_id must be a string';
        if (!Number.isInteger(event.category_id)) return 'category_id must be an integer';
        if (!Number.isInteger(event.start)) return 'start must be an integer';
        if (!Number.isInteger(event.end)) return 'end must be an integer';
        if (event.duration != null && !Number.isInteger(event.duration)) return 'duration must be an integer';
        if (event.type === 'interval_click' && !Number.isInteger(event.click_time)) {
            return 'click_time must be an integer';
        }
    }

    if (event.type === 'interval_skip' && !['auto', 'suggested'].includes(event.via)) {
        return 'via must be auto or suggested';
    }

    if (event.type === 'interval_undo' && event.via != null && !['button', 'seek'].includes(event.via)) {
        return 'via must be button or seek';
    }

    if (event.type === 'interval_overrun') {
        if (!isCount(event.delta)) return 'delta must be an integer >= 0';
        if (!isCount(event.after)) return 'after must be an integer >= 0';
    }

    if (event.type === 'time_saved') {
        if (event.inc != null && !Number.isInteger(event.inc)) return 'inc must be an integer';
    }

    if (event.type === 'client_failed') {
        if (typeof event.video_native_id !== 'string') return 'video_native_id must be a string';
        if (typeof event.reason !== 'string') return 'reason must be a string';
    }

    return null;
}

module.exports = function createEventsRoute(models) {
    const router = express.Router();

    router.post('/events', handler(async (req, res) => {
        const events = req.body;

        if (!Array.isArray(events)) {
            return res.status(400).json({ error: 'body must be an array of events' });
        }

        if (events.length > MAX_EVENTS) {
            return res.status(413).json({ error: `at most ${MAX_EVENTS} events per request` });
        }

        const validEvents = [];
        for (const event of events) {
            const err = validateEvent(event);
            if (err) {
                console.error('events: skipping invalid event:', err, event);
            } else {
                validEvents.push(event);
            }
        }

        const clickEvents = validEvents.filter(e => e.type === 'interval_click');
        const timeSavedEvents = validEvents.filter(e => e.type === 'time_saved');
        const clientFailedEvents = validEvents.filter(e => e.type === 'client_failed');

        async function tryHandle(label, fn) {
            try {
                await fn();
            } catch (err) {
                console.error(`events: failed to handle ${label}:`, err);
            }
        }

        const bounds = (e) => ({
            user_id: e.user_id,
            prv_user_id: e.prv_user_id ?? null,
            video_native_id: e.video_native_id,
            duration: e.duration ?? null,
            category_id: e.category_id,
            start: e.start,
            end: e.end,
        });
        const signals = [
            ['interval_skip', models.IntervalSkip, (e) => ({ ...bounds(e), via: e.via })],
            ['interval_undo', models.IntervalUndo, (e) => ({ ...bounds(e), via: e.via ?? null })],
            ['interval_overrun', models.IntervalOverrun, (e) => ({ ...bounds(e), delta: e.delta, after: e.after })],
        ];

        await Promise.all([
            ...signals.map(([type, model, row]) => {
                const rows = validEvents.filter(e => e.type === type).map(row);
                return rows.length && tryHandle(type, () => model.bulkCreate(rows));
            }),
            ...clickEvents.map(e => tryHandle('interval_click', () => models.IntervalClick.create({
                user_id: e.user_id,
                prv_user_id: e.prv_user_id ?? null,
                video_native_id: e.video_native_id,
                category_id: e.category_id,
                start: e.start,
                end: e.end,
                click_time: e.click_time,
            }))),
            ...clientFailedEvents.map(e => tryHandle('client_failed', () => models.ClientFailed.create({
                user_id: e.user_id,
                prv_user_id: e.prv_user_id ?? null,
                video_native_id: e.video_native_id,
                reason: e.reason,
                data: e.data ?? null,
            }))),
        ]);

        let timeSavedResponse = null;

        if (timeSavedEvents.length > 0) {
            const last = timeSavedEvents[timeSavedEvents.length - 1];
            const { user_id, prv_user_id } = last;

            let user;
            try {
                [user] = await models.User.findOrCreate({
                    where: { generated_user_id: user_id, prv_user_id: prv_user_id ?? null },
                });
            } catch (err) {
                console.error('events: failed to findOrCreate user for time_saved:', err);
            }

            await Promise.all(timeSavedEvents.map(e => tryHandle('time_saved log', () => models.TimeSavedEvent.create({
                user_id: e.user_id,
                prv_user_id: e.prv_user_id ?? null,
                inc: e.inc ?? null,
            }))));

            if (user) {
                for (const e of timeSavedEvents) {
                    if (e.inc != null) {
                        await tryHandle('time_saved increment', () => user.increment('time_saved', { by: e.inc }));
                    }
                }

                try {
                    const [byUserId, byPrvUserId] = await Promise.all([
                        models.User.findAll({ where: { generated_user_id: user_id }, attributes: ['time_saved'] }),
                        prv_user_id != null
                            ? models.User.findAll({ where: { prv_user_id }, attributes: ['time_saved'] })
                            : Promise.resolve([]),
                    ]);

                    await user.reload();

                    const byPrv = byPrvUserId.reduce((sum, r) => sum + (r.time_saved || 0), 0);
                    timeSavedResponse = {
                        by_user_id: byUserId.reduce((sum, r) => sum + (r.time_saved || 0), 0),
                        by_prv_user_id: byPrv,
                        // Old clients read the key under the legacy field name.
                        ...(LEGACY_PRV && { [`by_${LEGACY_PRV}_user_id`]: byPrv }),
                        by_user: user.time_saved,
                    };
                } catch (err) {
                    console.error('events: failed to build time_saved response:', err);
                }
            }
        }

        const data = {};
        if (timeSavedResponse) data.time_saved = timeSavedResponse;

        res.json({ data });
    }));

    return router;
};
