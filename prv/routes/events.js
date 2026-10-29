const express = require('express');
const handler = require('../../middleware/handler');
const { LEGACY_PRV } = require('../../lib/legacy-field');

const EVENT_TYPES = ['interval_undo', 'interval_click', 'time_saved', 'client_failed'];

function validateEvent(event) {
    if (!event || typeof event !== 'object') return 'each event must be an object';
    if (!EVENT_TYPES.includes(event.type)) return `unknown event type: ${event.type}`;
    if (typeof event.user_id !== 'string') return 'user_id must be a string';

    if (event.type === 'interval_undo' || event.type === 'interval_click') {
        if (typeof event.video_native_id !== 'string') return 'video_native_id must be a string';
        if (!Number.isInteger(event.category_id)) return 'category_id must be an integer';
        if (!Number.isInteger(event.start)) return 'start must be an integer';
        if (!Number.isInteger(event.end)) return 'end must be an integer';
        if (event.type === 'interval_click' && !Number.isInteger(event.click_time)) {
            return 'click_time must be an integer';
        }
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

        const validEvents = [];
        for (const event of events) {
            const err = validateEvent(event);
            if (err) {
                console.error('events: skipping invalid event:', err, event);
            } else {
                validEvents.push(event);
            }
        }

        const undoEvents = validEvents.filter(e => e.type === 'interval_undo');
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

        await Promise.all([
            ...undoEvents.map(e => tryHandle('interval_undo', () => models.IntervalUndo.create({
                user_id: e.user_id,
                prv_user_id: e.prv_user_id ?? null,
                video_native_id: e.video_native_id,
                category_id: e.category_id,
                start: e.start,
                end: e.end,
            }))),
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
