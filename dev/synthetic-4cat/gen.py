"""Generate the synthetic "Wellness Month" study (see CASE.md) as two files
ready to upload to 4CAT:

  wellness_month_oct2026_all_messages_canonical_4cat.csv
      the merge page's all_messages_canonical_4cat.csv: the canonical message
      columns without platform_specific_json, first row without quotes.
  wellness_month_oct2026_all_sources_canonical.csv
      the merge page's all_sources_canonical.csv, with every cell quoted (see
      write_sources).

Same conventions as the extension: UTF-8 with BOM, CRLF, the formula-prefix
rule, per-platform ID formats and timestamps, source_file / source_sha256.
Nothing is derived (no topics, no codes); the patterns in CASE.md come from
who asks what, where and when. Texts are invented, see conversations.py.

    python3 dev/synthetic-4cat/gen.py [output_dir]
"""
import csv
import hashlib
import json
import os
import random
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from conversations import FOLLOW_UPS, TOPICS  # noqa: E402

SEED = 1031
START = datetime(2026, 10, 1, tzinfo=timezone.utc)
DAYS = 31
EXTRACTOR_VERSION = '3.1.0'
PREFIX = 'wellness_month_oct2026_'

COLUMNS = ['donor_id', 'platform', 'conversation_id', 'message_id', 'parent_message_id',
           'turn_index', 'role', 'text', 'text_cleaned', 'created_at_iso', 'model_identifier',
           'schema_version', 'extractor_version', 'platform_specific_json',
           'source_file', 'source_sha256']
# utils/merge_sources.js SOURCES_HEADERS.
SOURCE_COLUMNS = ['donor_id', 'platform', 'conversation_id', 'message_id', 'created_at_iso', 'url', 'url_clean', 'domain',
                  'title', 'snippet', 'source_schema', 'source_file', 'source_sha256']

SCHEMA = {'chatgpt': '1.1.0', 'claude': '1.1.0', 'gemini': '1.0.0', 'google_ai_overview': '1.0.0'}
CHATGPT_MODELS = ['gpt-6', 'gpt-6', 'gpt-5-5', 'gpt-5-3']
GEMINI_MODELS = ['3.5 Flash-Lite', '3.5 Flash', '3.5 Flash', '3.5 Pro']

rng = random.Random(SEED)

# --- the case ----------------------------------------------------------------
# Expected conversations per day on each platform (g = Google AI Overview).
# groups: topic groups the person asks about, weights relative.
PERSONAS = [
    # A: gym and optimisation
    dict(id='P01', groups={'A': 5, 'S': 1}, rates=dict(chatgpt=2.2, g=0.8), style='terse'),
    dict(id='P02', groups={'A': 5, 'S': 1}, rates=dict(chatgpt=1.2, g=1.4), style=None),
    dict(id='P03', groups={'A': 5, 'S': 1}, rates=dict(chatgpt=3.5, g=0.3), style='terse'),
    dict(id='P04', groups={'A': 5, 'E': 1, 'S': 1}, rates=dict(chatgpt=1.0, gemini=1.0, g=1.0), style=None,
         arc='drift_to_E'),
    # B: students in exam season
    dict(id='P05', groups={'B': 5, 'S': 1}, rates=dict(claude=2.0, chatgpt=0.4, g=0.5), style='polite', exams=True),
    dict(id='P06', groups={'B': 5, 'S': 1}, rates=dict(chatgpt=2.0, g=1.0), style='anxious', exams=True),
    dict(id='P07', groups={'B': 5, 'S': 1}, rates=dict(claude=1.4, gemini=1.0, g=0.4), style=None, exams=True),
    dict(id='P08', groups={'B': 5, 'S': 1}, rates=dict(chatgpt=1.5, g=0.6), style=None, exams=True,
         arc='switch_to_claude'),
    # C: weight loss and GLP-1
    dict(id='P09', groups={'C': 5, 'S': 1}, rates=dict(g=3.0, chatgpt=0.4), style=None),
    dict(id='P10', groups={'C': 5, 'S': 1}, rates=dict(chatgpt=1.5, g=1.5), style=None, arc='glp1_journey'),
    dict(id='P11', groups={'C': 5, 'S': 1}, rates=dict(gemini=2.0, g=1.0), style=None),
    # D: new parents
    dict(id='P12', groups={'D': 5}, rates=dict(gemini=1.8, g=2.0), style='night_parent', night=True),
    dict(id='P13', groups={'D': 5}, rates=dict(g=3.0, chatgpt=0.5), style='night_parent', night=True),
    dict(id='P14', groups={'D': 5, 'S': 1}, rates=dict(claude=1.5, g=1.0), style='polite'),
    # E: natural health
    dict(id='P15', groups={'E': 5, 'S': 1}, rates=dict(chatgpt=1.0, gemini=1.5, g=1.0), style=None,
         pushback=True),
    dict(id='P16', groups={'E': 5, 'S': 1}, rates=dict(g=2.5, gemini=0.5), style=None),
    # light users
    dict(id='P17', groups={'A': 1, 'B': 1, 'S': 2}, rates=dict(chatgpt=0.8, g=0.6), style='terse', drop_out=10),
    dict(id='P18', groups={'S': 3, 'C': 1}, rates=dict(claude=0.5, g=0.5), style='polite'),
]

TREND_DAYS = range(13, 21)      # mouth taping goes viral, 14–21 October
CLOCK_DAYS = range(23, 28)      # clocks go back on Sunday 25 October

# Which kind of source each platform tends to cite, and how often it cites at all.
CITE_RATE = {'chatgpt': 0.55, 'claude': 0.15, 'gemini': 0.5}
KIND_WEIGHT = {
    'chatgpt': dict(forum=5, media=2, video=1, science=1, health=1, shop=0.3),
    'claude': dict(science=5, health=4, media=1, forum=0.3, video=0.1, shop=0.1),
    'gemini': dict(video=6, media=2, health=1, forum=1, science=0.5, shop=0.5),
    'google_ai_overview': dict(shop=4, media=3, health=2, forum=1.5, video=1, science=0.3),
}

# How each assistant frames the same core answer.
STYLE = {
    'chatgpt': dict(
        intro=["", "", "Good question! ", "Short answer: it depends, but here's the breakdown 👇\n\n",
               "Here's what the research says:\n\n"],
        outro=["", "\n\nIf you want, I can turn this into a simple plan for this week. 💪",
               "\n\nWant me to make a quick checklist you can save?",
               "\n\nWant me to tailor this to your routine?"]),
    'claude': dict(
        intro=["", "", "That's a really common question, and a reasonable thing to look into. ",
               "It makes sense to want a clear answer here. "],
        outro=["\n\nOne caveat: I can't assess your individual situation, so if this keeps bothering you, a doctor or pharmacist can give you advice that fits you.",
               "\n\nI'd also gently note that the evidence on this is more mixed than a lot of online content suggests, so it's worth being a bit sceptical of strong claims either way.",
               "\n\nIf it would help, I'm happy to think through your specific situation with you.",
               ""]),
    'gemini': dict(
        intro=["Here's a quick overview:\n\n", "", ""],
        outro=["\n\nYou can find helpful videos on this topic below.",
               "\n\nWould you like me to find some YouTube videos that explain this?", "", ""]),
}


# --- formats ---------------------------------------------------------------

def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


def slug_time(t):
    return t.strftime('%Y-%m-%dT%H-%M-%SZ')


def uuid4():
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def hex16():
    return f'{rng.getrandbits(64):016x}'


def clean(text):
    """Mirrors utils/text_cleaner.js for the cases in this data: citation
    placeholders removed, trailing spaces trimmed. Markdown is kept."""
    text = re.sub(r'\s?cite(turn\d+(search|news)\d+)+', '', text)
    text = '\n'.join(line.rstrip(' \t') for line in text.split('\n'))
    return re.sub(r'\n{3,}', '\n\n', text).strip()


FORMULA_START = tuple('=+-@|\t\r\n＝＋－＠')


def cell(value):
    """The extension's escapeCSVField formula prefix."""
    value = '' if value is None else str(value)
    return "'" + value if value and value.startswith(FORMULA_START) else value


def psj(download, **fields):
    return json.dumps({'donor_id_type': 'persistent', 'download_time': iso(download), **fields},
                      separators=(',', ':'), ensure_ascii=False)


def domain(url):
    """utils/merge_sources.js domainOf."""
    return re.sub(r'^www\.', '', re.match(r'https?://([^/?#]+)', url).group(1).lower())


# --- how people type ---------------------------------------------------------

def typed(text, style):
    if style == 'terse':
        text = re.sub(r"[?.,!']", '', text.lower())
        return text + rng.choice(['', '', '??', ' pls'])
    if style == 'polite':
        return rng.choice(['Hi! ', 'Hello, ', '']) + text[0].upper() + text[1:] + rng.choice(
            [' Thank you!', ' Thanks in advance.', ''])
    if style == 'anxious':
        return rng.choice(["sorry if this is a dumb question but ", "I'm really stressed, ", "ok so ", ""]) + \
            text + rng.choice([" is this normal??", " I'm freaking out a bit", "", ""])
    if style == 'night_parent':
        return text + rng.choice(["", "", " (it's the middle of the night and I'm worried)", " please help"])
    r = rng.random()
    if r < 0.2:
        return text[0].lower() + text[1:]
    if r < 0.3:
        return text.rstrip('?.!')
    return text


def pick_sources(topic, platform, k):
    pool = list(TOPICS[topic]['sources'])
    out = []
    while pool and len(out) < k:
        w = [KIND_WEIGHT[platform][s[3]] for s in pool]
        out.append(pool.pop(rng.choices(range(len(pool)), weights=w)[0]))
    return [(u, t, sn) for u, t, sn, _ in out]


# --- one conversation per platform ------------------------------------------

def reply(platform, core, cited):
    s = STYLE[platform]
    if platform == 'gemini' and rng.random() < 0.5:
        core = core.split('\n\n')[0]        # Gemini often answers shorter
    text = rng.choice(s['intro']) + core
    if cited and platform == 'chatgpt':
        text += ' cite' + ''.join(f'turn0search{i}' for i in range(len(cited)))
    return text + rng.choice(s['outro'])


def chatgpt(chat, start, download):
    cid = '6' + uuid4()[1:]
    model = rng.choice(CHATGPT_MODELS)
    rows, idx, t = [], 0, start
    # Hidden system nodes at the top of every ChatGPT conversation.
    for _ in range(rng.choice([1, 1, 2, 3])):
        rows.append(dict(message_id=uuid4(), parent_message_id='', turn_index=idx, role='system', text='',
                         created_at_iso='', model_identifier='',
                         extra=dict(content_type='text', tool_name='', is_visually_hidden=True, has_image=False,
                                    image_ids='', status='finished_successfully', end_turn=True, on_visible_path=True)))
        idx += 1
    parent = ''
    for user, assistant, cited in chat:
        t += timedelta(seconds=rng.randint(15, 600), milliseconds=rng.randint(0, 999))
        uid = uuid4()
        rows.append(dict(message_id=uid, parent_message_id=parent, turn_index=idx, role='user', text=user,
                         created_at_iso=iso(t), model_identifier='',
                         extra=dict(content_type='text', tool_name='', is_visually_hidden=False, has_image=False,
                                    image_ids='', status='finished_successfully', end_turn='', on_visible_path=True)))
        idx += 1
        prev = uid
        if cited:
            # Web search: a tool node (empty text) before the answer.
            t += timedelta(seconds=rng.randint(1, 3), milliseconds=rng.randint(0, 999))
            tid = uuid4()
            rows.append(dict(message_id=tid, parent_message_id=uuid4(), turn_index=idx + 1, role='tool', text='',
                             created_at_iso=iso(t), model_identifier=model,
                             extra=dict(content_type='text', tool_name='web.run', is_visually_hidden=False,
                                        has_image=False, image_ids='', status='finished_successfully',
                                        end_turn=False, on_visible_path=True)))
            idx += 2
            prev = tid
        t += timedelta(seconds=rng.randint(2, 20), milliseconds=rng.randint(0, 999))
        aid = uuid4()
        rows.append(dict(message_id=aid, parent_message_id=prev, turn_index=idx, role='assistant', text=assistant,
                         created_at_iso=iso(t), model_identifier=model, cites=cited,
                         extra=dict(content_type='text', tool_name='', is_visually_hidden=False, has_image=False,
                                    image_ids='', status='finished_successfully', end_turn=True,
                                    on_visible_path=True)))
        idx += 1
        parent = aid
    return cid, f'chatgpt_messages_canonical_{cid}_{slug_time(download)}.csv', rows


def claude(chat, start, download):
    cid = uuid4()
    rows, t, parent = [], start, ''
    for user, assistant, cited in chat:
        for role, text, wait in (('user', user, (15, 600)), ('assistant', assistant, (3, 30))):
            t += timedelta(seconds=rng.randint(*wait), milliseconds=rng.randint(0, 999))
            mid = uuid4()
            web = role == 'assistant' and bool(cited)
            rows.append(dict(message_id=mid, parent_message_id=parent, turn_index='', role=role, text=text,
                             created_at_iso=iso(t), model_identifier='', cites=cited if web else [],
                             extra=dict(sender='human' if role == 'user' else 'assistant', content_types=['text'],
                                        on_visible_path=True, thinking_mode='', thinking_text='',
                                        thinking_summary='', tool_result_text='', has_thinking=False,
                                        has_tool_use=web, has_tool_result=web, has_attachments=False,
                                        truncated=False, stop_reason='end_turn' if role == 'assistant' else '',
                                        updated_at=iso(t))))
            parent = mid
    return cid, f'claude_messages_canonical_{cid}_{slug_time(download)}.csv', rows


def gemini(chat, start, download):
    cid = 'c_' + hex16()
    model = rng.choice(GEMINI_MODELS)
    title = chat[0][0][:48].rstrip(' ,.?')
    rows, t, parent, prev_rc = [], start, '', ''
    for turn, (user, assistant, cited) in enumerate(chat):
        # Gemini gives the user message and the reply the same timestamp.
        t += timedelta(seconds=rng.randint(20, 600), milliseconds=rng.randint(0, 999))
        rid, rc = 'r_' + hex16(), 'rc_' + hex16()
        for role, text, mid, cand in (('user', user, 'user-' + rid, ''), ('assistant', assistant, rid, rc)):
            c = cited if role == 'assistant' else []
            rows.append(dict(message_id=mid, parent_message_id=parent, turn_index=turn, role=role, text=text,
                             created_at_iso=iso(t), model_identifier=model, cites=c,
                             extra=dict(candidate_id=cand, parent_candidate_id=prev_rc, cited_source_count=len(c),
                                        has_citations=bool(c), conversation_title=title)))
            parent = mid
        prev_rc = rc
    return cid, f'gemini_messages_canonical_{cid}_{slug_time(download)}.csv', rows


def google(donor, topic, query, start, download):
    t = TOPICS[topic]
    cited = pick_sources(topic, 'google_ai_overview', rng.randint(2, 4))
    slug = re.sub(r'[^a-z0-9]', '', query)
    row = dict(message_id='0', parent_message_id='', turn_index=0, role='assistant', text=t['overview'],
               created_at_iso=iso(start), model_identifier='', cites=cited,
               extra=dict(donor_id=donor, source_page_url='https://www.google.com/search?q=' + query.replace(' ', '+'),
                          source_urls=', '.join(u for u, _, _ in cited), source_titles='',
                          follow_up_questions=', '.join(t['paa']), follow_up_count=len(t['paa'])))
    return query, f'google_ai_overview_canonical_{slug}_{slug_time(download)}.csv', [row]


BUILDERS = {'chatgpt': chatgpt, 'claude': claude, 'gemini': gemini}


# --- study -----------------------------------------------------------------

def topic_weights(p, day):
    w = {}
    for name, t in TOPICS.items():
        g = t['group']
        base = p['groups'].get(g, 0)
        if p.get('arc') == 'drift_to_E':
            # Gym talk slowly turns into seed oils, raw milk and detox.
            if g == 'A':
                base = 6 * (1 - day / DAYS) + 0.3
            elif g == 'E':
                base = 10 * day / DAYS
        if p.get('arc') == 'glp1_journey':
            if name == 'glp1_start':
                base = 8 if day < 9 else 0.3
            elif name == 'glp1_side':
                base = 0 if day < 9 else (9 if day < 20 else 3)
            elif name == 'plateau':
                base = 0 if day < 20 else 6
        if p.get('exams') and name in ('exam_anxiety', 'all_nighter', 'caffeine_exam'):
            base *= 0.3 + 2.5 * day / DAYS       # exams start in the last week of October
        if g == 'T' and name == 'mouth_taping':
            base = 7 if day in TREND_DAYS and set(p['groups']) & {'A', 'B', 'E', 'S'} else 0
        if g == 'T' and name == 'clock_change':
            base = (8 if 'D' in p['groups'] else 1.5) if day in CLOCK_DAYS else 0
        if base:
            w[name] = base
    return w


def conversation(p, platform, topic):
    t = TOPICS[topic]
    cited = pick_sources(topic, platform, rng.randint(2, 4)) if rng.random() < CITE_RATE[platform] else []
    turns = [(typed(rng.choice(t['prompts']), p['style']), reply(platform, t['answer'], cited), cited)]
    if t.get('follow') and (p.get('pushback') and topic == 'seed_oils' or rng.random() < 0.35):
        u, a = t['follow'][0]
        turns.append((typed(u, p['style']), reply(platform, a, []), []))
    if p.get('pushback') and rng.random() < 0.6:
        turns.append((rng.choice(["but a lot of people online say it really works",
                                  "my naturopath says otherwise though",
                                  "you sound like big pharma lol"]),
                      reply(platform, "I understand, and personal experiences can be really convincing. What I can tell you is what larger studies show, and on this point the evidence is limited. If you'd like, I can show you how to look up the studies yourself so you can judge them.", []),
                      []))
    if rng.random() < 0.2:
        turns.append(rng.choice(FOLLOW_UPS) + ([],))
    return turns


def main(out_dir):
    donors = {p['id']: uuid4() for p in PERSONAS}
    final = []  # (rows, source_file, donor, platform, download, conversation_id)
    for day in range(DAYS):
        date = START + timedelta(days=day)
        weekend = date.weekday() >= 5
        for p in PERSONAS:
            if p.get('drop_out') and day >= p['drop_out']:
                continue
            if rng.random() < 0.07:          # missed a day
                continue
            download = date + timedelta(hours=19, minutes=rng.randint(0, 179), seconds=rng.randint(0, 59),
                                        milliseconds=rng.randint(0, 999))
            weights = topic_weights(p, day)
            rates = dict(p['rates'])
            if p.get('arc') == 'switch_to_claude' and day >= 14:
                rates['claude'], rates['chatgpt'] = rates.pop('chatgpt'), 0.2
            for platform, rate in rates.items():
                platform = 'google_ai_overview' if platform == 'g' else platform
                rate *= 0.6 if weekend else 1
                if p.get('exams'):
                    rate *= 0.8 + 0.8 * day / DAYS
                n = sum(rng.random() < rate / 5 for _ in range(5))
                for _ in range(n):
                    topic = rng.choices(list(weights), weights=list(weights.values()))[0]
                    if p.get('night') and rng.random() < 0.5:
                        hour = rng.choice([0, 1, 2, 3, 4])
                    elif p.get('exams') and rng.random() < 0.3:
                        hour = rng.choice([0, 1, 2])
                    else:
                        hour = rng.randint(7, 18)
                    start = date + timedelta(hours=hour, minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))
                    donor = donors[p['id']]
                    if platform == 'google_ai_overview':
                        query = typed(rng.choice(TOPICS[topic]['prompts']), 'terse' if p['style'] == 'terse' else None)
                        query = re.sub(r'[?!.]', '', query.lower()).strip()
                        cid, src, rows = google(donor, topic, query, start, download)
                    else:
                        cid, src, rows = BUILDERS[platform](conversation(p, platform, topic), start, download)
                    final.append((rows, src, donor, platform, download, cid))

    final.sort(key=lambda v: (v[4], v[1]))
    msg_rows, src_rows = [], []
    for rows, src, donor, platform, download, cid in final:
        lines = [[donor, platform, cid, r['message_id'], r['parent_message_id'], r['turn_index'], r['role'],
                  r['text'], clean(r['text']), r['created_at_iso'], r['model_identifier'], SCHEMA[platform],
                  EXTRACTOR_VERSION, psj(download, **r['extra'])] for r in rows]
        sha = hashlib.sha256(json.dumps(lines, ensure_ascii=False).encode()).hexdigest()
        msg_rows += [[cell(v) for v in line] + [src, sha] for line in lines]

        if platform == 'google_ai_overview':
            schema, file = 'google_sources', src.replace('google_ai_overview_canonical_', 'google_sources_')
        else:
            schema, file = f'{platform}_sources', src.replace('_messages_canonical_', '_sources_')
        # ChatGPT tags the links it cites; url_clean drops the tracking parameter.
        tag = '?utm_source=chatgpt.com' if platform == 'chatgpt' else ''
        cites = [[donor, platform, cid, r['message_id'], r['created_at_iso'], u + (tag if '?' not in u else ''), u, domain(u), t, sn]
                 for r in rows for u, t, sn in r.get('cites') or []]
        if platform == 'google_ai_overview':
            for c in cites:
                c[9] = ''                    # Google's sources have no snippet
        if cites:
            ssha = hashlib.sha256(json.dumps([file] + cites, ensure_ascii=False).encode()).hexdigest()
            src_rows += [[cell(v) for v in c] + [schema, file, ssha] for c in cites]

    # Messages: the merge page's 4CAT copy (utils/merge.js fourCatCopy).
    drop = COLUMNS.index('platform_specific_json')
    four = [[v for i, v in enumerate(r) if i != drop] for r in msg_rows]
    if any('"' in v for v in four[0]):
        four.insert(0, four.pop(next(i for i, r in enumerate(four) if not any('"' in v for v in r))))
    msg_out = os.path.join(out_dir, PREFIX + 'all_messages_canonical_4cat.csv')
    with open(msg_out, 'w', newline='', encoding='utf-8-sig') as fh:
        w = csv.writer(fh, lineterminator='\r\n')
        w.writerow([c for c in COLUMNS if c != 'platform_specific_json'])
        w.writerows(four)

    # Sources: every cell quoted. Page titles contain apostrophes ('Affect' vs.
    # Europe's ...), and with minimal quoting 4CAT's format sniffer then picks '
    # as the quote character and splits titles that contain commas.
    src_out = os.path.join(out_dir, PREFIX + 'all_sources_canonical.csv')
    with open(src_out, 'w', newline='', encoding='utf-8-sig') as fh:
        w = csv.writer(fh, lineterminator='\r\n', quoting=csv.QUOTE_ALL)
        w.writerow(SOURCE_COLUMNS)
        w.writerows(src_rows)

    print(f'{len(msg_rows)} messages, {len(final)} conversations -> {msg_out}')
    print(f'{len(src_rows)} sources -> {src_out}')
    print('participants:', ', '.join(f"{p['id']}={donors[p['id']][:8]}" for p in PERSONAS))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)))
