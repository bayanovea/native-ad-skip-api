#!/usr/bin/env python3
"""Snapshot of the public AI-pipeline Grafana dashboard: prints the key numbers, the deltas
against the previous snapshot and the raw tables that explain them; appends the snapshot to
~/Web/data/ai-dashboard/snapshots.jsonl. Usage: check.py [--no-save] [--days N] [--all]"""
import json, sys, time, urllib.request, os, datetime

TOKEN_FILE = os.path.expanduser('~/Web/data/ai-dashboard/public-token')
TOKEN = os.environ.get('AI_DASHBOARD_TOKEN') or open(TOKEN_FILE).read().strip()
GRAFANA_URL = os.environ.get('GRAFANA_URL')  # the Grafana base URL, not in the repo
if not GRAFANA_URL: sys.exit('GRAFANA_URL is not set (e.g. http://<host>:3024)')
BASE = f'{GRAFANA_URL.rstrip("/")}/api/public/dashboards/{TOKEN}'
LOG = os.path.expanduser('~/Web/data/ai-dashboard/snapshots.jsonl')
save = '--no-save' not in sys.argv
show_all = '--all' in sys.argv
days = int(sys.argv[sys.argv.index('--days') + 1]) if '--days' in sys.argv else 3

def get(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))

db = get(BASE); db = db.get('dashboard', db)
panels = []
def walk(l):
    for p in l:
        panels.append(p)
        if p.get('panels'): walk(p['panels'])
walk(db['panels'])
by_title = {p['title']: p for p in panels}

now = int(time.time() * 1000)
def query(p):
    r = get(f"{BASE}/panels/{p['id']}/query",
            {'intervalMs': 60000, 'maxDataPoints': 200,
             'timeRange': {'from': str(now - days * 86400000), 'to': str(now)}})
    out = []
    for res in r.get('results', {}).values():
        if res.get('error'):
            raise RuntimeError(res['error'])
        for fr in res.get('frames', []):
            names = [f.get('name') + (json.dumps(f.get('labels'), ensure_ascii=False) if f.get('labels') else '')
                     for f in fr['schema']['fields']]
            vals = fr['data']['values']
            n = len(vals[0]) if vals else 0
            out.append([{nm: v[i] for nm, v in zip(names, vals)} for i in range(n)])
    return out

def single(title, key=None):
    """Last value of a stat panel (first frame, first row, the named or the last non-time field)."""
    rows = query(by_title[title])
    row = rows[0][-1] if rows and rows[0] else {}
    if key: return row.get(key)
    for k, v in row.items():
        if not k.startswith('Time'): return v

def ts_last(title):
    """timeseries → {series: last non-null value}."""
    rows = query(by_title[title]); out = {}
    for frame in rows:
        for k in (frame[0].keys() if frame else []):
            if k.startswith('Time'): continue
            nn = [r[k] for r in frame if r[k] is not None]
            if nn: out[k] = nn[-1]
    return out

def bar(title, key, val):
    try: return {r[key]: r[val] for r in query(by_title[title])[0]}
    except Exception as e: return {'error': str(e)}

snap = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}
errors = {}
def put(k, fn):
    try: snap[k] = fn()
    except Exception as e: errors[k] = str(e)

put('ai_first', lambda: single('AI_FIRST: отдаём AI-сегменты клиентам'))
put('detect_on', lambda: single('Детектор (ai detect)'))
put('judge_on', lambda: single('Судья (ai judge)'))
put('since_tick_s', lambda: {k.split('"provider": "')[1].rstrip('"}'): round(v)
                             for frame in query(by_title['Секунд с последнего успешного тика'])
                             for k, v in frame[-1].items() if 'provider' in k})
put('usd_total', lambda: round(single('Потрачено всего'), 2))
put('usd_24h', lambda: round(single('Потрачено за 24 ч'), 2))
put('usd_per_video', lambda: round(single('Средняя цена видео'), 4))
put('seen', lambda: single('Видео увидели'))
put('seen_24h', lambda: single('Новых видео за 24 ч'))
put('through_model', lambda: single('Видео прошло через модель'))
put('runs_24h', lambda: single('Запусков модели за 24 ч'))
put('budget_pct', lambda: round(single('Суточный бюджет модели'), 1))
put('queue_now', lambda: single('В очереди сейчас'))
put('below_threshold', lambda: single('Ждут порога'))
put('funnel', lambda: bar('Стадии обработки сейчас', 'stage', 'видео'))
put('ready_videos', lambda: single('Видео с AI-сегментами готовы к отдаче'))
put('ready_segments', lambda: single('Сегментов готово к отдаче'))
put('review_open', lambda: single('Открытых вопросов у асессоров'))
put('withdrawn', lambda: single('Отозвано'))
put('fetching', lambda: single('Качаем сейчас (fetching)'))
put('fetching_stuck', lambda: single('Зависли в fetching > 1 ч'))
put('retry_wait', lambda: single('Ждут повторной попытки'))
put('detecting', lambda: query(by_title['Ждём ответ модели (detecting)'])[0][-1])
put('dropped', lambda: query(by_title['Отсеяно: по статусу'])[0][-1])
put('dropped_pct', lambda: round(single('Доля отсеянных среди прошедших обкачку'), 1))
put('status_hist', lambda: {k.split('"status": "')[1].rstrip('"}'): v for k, v in
                           ts_last('Видео по статусу prv_ai_videos (история из Prometheus)').items()})
put('result_now', lambda: bar('Результат разметки сейчас (по видео)', 'исход', 'видео'))
put('segments_by_conf', lambda: bar('Сегменты, готовые к отдаче: категория / уверенность', 'сегмент', 'шт.'))
put('drop_reasons', lambda: bar('Причины отсева', 'причина', 'видео'))
put('judgements', lambda: bar('Судейства за всё время: решение / кто', 'решение', 'шт.'))
put('verdicts', lambda: bar('Вердикты асессоров по AI-сегментам', 'вердикт', 'сегментов'))
put('votes', lambda: bar('Голоса за AI-сегменты (рейтинг записей)', 'рейтинг', 'сегментов'))
put('lookups_per_h', lambda: ts_last('Ответов GET /video-calculated (prv) в час: AI vs пользовательская'))
put('ai_share_24h', lambda: single('Доля ответов с AI-сегментами за 24 ч'))
put('with_human', lambda: single('Видео, по которым пользователи тоже разметили'))
put('ai_only', lambda: single('Видео только с AI-разметкой'))
put('misses', lambda: single('Модель не нашла рекламу, а пользователи разметили'))
put('retry_table', lambda: query(by_title['Ждут повторной попытки: когда и почему'])[0])
put('dropped_table', lambda: query(by_title['Последние отсеянные видео'])[0])
put('against_table', lambda: query(by_title['Видео с сигналами против: отозванные, с открытыми вопросами или минусовым сегментом'])[0])
put('misses_table', lambda: query(by_title['Пропуски модели: какие видео'])[0])
put('prompt_model', lambda: query(by_title['Промпт и модель'])[0])

prev = None
if os.path.exists(LOG):
    lines = [l for l in open(LOG) if l.strip()]
    if lines: prev = json.loads(lines[-1])

def fmt(k):
    v = snap.get(k); d = ''
    if prev and isinstance(v, (int, float)) and isinstance(prev.get(k), (int, float)) and v != prev[k]:
        d = f"  ({'+' if v > prev[k] else ''}{round(v - prev[k], 4)} since {prev['at']})"
    return f"{k}: {v}{d}"

print(f"snapshot {snap['at']}  (prev: {prev['at'] if prev else 'none'})")
print('--- switches / health')
for k in ['ai_first', 'detect_on', 'judge_on', 'since_tick_s', 'fetching', 'fetching_stuck', 'detecting']: print(' ', fmt(k))
print('--- volume / cost')
for k in ['seen', 'seen_24h', 'through_model', 'runs_24h', 'budget_pct', 'queue_now', 'below_threshold', 'usd_total', 'usd_24h', 'usd_per_video']: print(' ', fmt(k))
print('--- outcome')
for k in ['funnel', 'ready_videos', 'ready_segments', 'result_now', 'segments_by_conf', 'retry_wait', 'dropped', 'dropped_pct', 'drop_reasons', 'status_hist']: print(' ', fmt(k))
print('--- judge / assessors / users')
for k in ['judgements', 'review_open', 'withdrawn', 'verdicts', 'votes', 'misses', 'with_human', 'ai_only']: print(' ', fmt(k))
print('--- serving')
for k in ['lookups_per_h', 'ai_share_24h']: print(' ', fmt(k))
for k in ['retry_table', 'dropped_table', 'against_table', 'misses_table', 'prompt_model']:
    rows = snap.get(k) or []
    print(f"--- {k} ({len(rows)} rows)")
    for r in (rows if show_all else rows[:8]):
        print('  ', {a: (datetime.datetime.fromtimestamp(b / 1000, datetime.timezone.utc).strftime('%m-%d %H:%MZ') if isinstance(b, (int, float)) and b > 1e12 else b) for a, b in r.items()})
if errors:
    print('--- panel errors'); [print(f'  {k}: {v}') for k, v in errors.items()]
if save:
    with open(LOG, 'a') as f: f.write(json.dumps(snap, ensure_ascii=False) + '\n')
    print(f'saved → {LOG}')
