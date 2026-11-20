# Wellness Month: a synthetic data-donation case for 4CAT

**All data here is invented.** Participants, conversations, search queries and
sources were all made up to practise analysis in 4CAT. The page titles and
URLs look like real websites, but the pages, threads and videos don't exist.

## The case

In October 2026, 18 adults in Belgium donated their AI-chatbot and Google
Search data every evening for a month, using the browser extension. The
research question:

> *Where do people get health and wellness advice from AI, and does the
> platform they use change what they hear and which sources they are sent to?*

The participants fall into five groups by recruitment channel, plus two light
users:

| Group | Participants | What they ask about | Main platforms |
|---|---|---|---|
| A. Gym and optimisation | P01–P04 | creatine, protein, cold plunges, testosterone, pre-workout | ChatGPT |
| B. Students in exam season | P05–P08 | insomnia, caffeine, exam anxiety, all-nighters, focus | Claude, ChatGPT |
| C. Weight loss | P09–P11 | Ozempic/Wegovy, side effects, calories, plateaus | Google, ChatGPT, Gemini |
| D. New parents | P12–P14 | baby fever, sleep regressions, vitamin D drops, teething | Gemini, Google, Claude |
| E. Natural health | P15–P16 | seed oils, apple cider vinegar, detox, raw milk, fasting | Gemini, Google |
| Light users | P17–P18 | a bit of everything | ChatGPT / Claude, Google |

Everyone also asks about **magnesium** and **vitamin D**, which lets you compare
the same topic across groups and platforms. There are also two events:

- **14–21 October:** a viral TikTok trend, *mouth taping for sleep*, reaches
  groups A, B and E.
- **25 October:** the clocks go back, which brings sleep questions, mostly
  from the parents.

## The files

Both files are written by `python3 dev/synthetic-4cat/gen.py` and are
gitignored. Running it again gives exactly the same files (fixed seed).

| File | Rows | What it is |
|---|---|---|
| `wellness_month_oct2026_all_messages_canonical_4cat.csv` | 3,470 messages, 1,329 conversations | Same layout as the merge page's `all_messages_canonical_4cat.csv` |
| `wellness_month_oct2026_all_sources_canonical.csv` | 2,688 cited sources, 140 URLs, 48 domains | Same columns as the merge page's `all_sources_canonical.csv`, including `created_at_iso`: the time of the message that cites the source |

Join the two files on `platform` + `message_id`; every source row links to a
message. Google AI Overview sources have no snippet, as in real exports. The
columns contain only data as exported: no topic, group or participant labels.
You'll have to find the patterns yourself. Use the participant table below to
tell people apart.

## Uploading to 4CAT

Go to **Create new dataset → Import/upload CSV file**, choose *Custom/other*
as the CSV format and leave **Strip HTML** unticked. Name each dataset after
its file so you can tell them apart later:

| Dataset name in 4CAT | File | Column mapping |
|---|---|---|
| `wellness-oct2026-messages` | `..._all_messages_canonical_4cat.csv` | id → *[generate sequential IDs]*, thread_id → `conversation_id`, author → `donor_id`, body → `text_cleaned` (or `text`), timestamp → `created_at_iso` |
| `wellness-oct2026-sources` | `..._all_sources_canonical.csv` | id → *[generate sequential IDs]*, thread_id → `conversation_id`, author → `donor_id`, body → `title` (or `snippet`), timestamp → `created_at_iso` |

Notes:

- In the sources file, `created_at_iso` is the time of the message citing
  the source, so you can plot sources over time too: for example, when the
  mouth-tape shops show up.
- In the messages dataset, also filter out rows with an empty `text`. These
  are ChatGPT's hidden system rows and web-search tool rows, which have no
  text and, for the system rows, no timestamp. Then filter on `role`:
  `user` for what participants ask, `assistant` for what they are told.
  Google AI Overview rows are all `assistant`; the participant's search query
  is in `conversation_id`.

## Participants

`donor_id` starts with:

| P | donor_id starts with | P | donor_id starts with | P | donor_id starts with |
|---|---|---|---|---|---|
| P01 | `0a1db1c4` | P07 | `7bb92388` | P13 | `5562c143` |
| P02 | `ff573061` | P08 | `0261445d` | P14 | `87b34d6a` |
| P03 | `dc53f7f8` | P09 | `32b2043f` | P15 | `fe52576b` |
| P04 | `a10f8ba1` | P10 | `9490c5e4` | P16 | `96480b17` |
| P05 | `76e14023` | P11 | `d6f80edb` | P17 | `c42ca240` |
| P06 | `508724b0` | P12 | `35c09eb9` | P18 | `eee84e2b` |

## What there is to find

These patterns are built into the data. The numbers are from the current
files.

### Comparing platforms

**The same answer is framed differently on each platform.** The advice itself
is the same everywhere; what changes are the openings and closings each
assistant adds. Word counts per platform on `assistant` rows show it at once:

- **ChatGPT** sells action: *plan*, *checklist*, *breakdown*, *research*,
  "👇", "💪". It offers to make a plan or a checklist.
- **Claude** hedges and refers people on: *caveat*, *sceptical*, *doctor*,
  *evidence*. "doctor" is about 2.5 times as frequent as on ChatGPT or Gemini.
- **Gemini** points to video: *videos* and *YouTube* appear only in Gemini
  replies. Its answers are often shorter, because about half the time only the
  first paragraph is given.
- **Google AI Overview** is short, impersonal and has no follow-up
  conversation. Its rows are the "People also ask" end of the spectrum.

**Each platform sends people to different kinds of sources** (sources file,
`domain`):

| Platform | Citations | Most cited kind of source |
|---|---|---|
| ChatGPT | 605 | forums: **reddit.com** is about a third of its citations |
| Gemini | 339 | video: **youtube.com** is about 30% |
| Claude | 93 | public health: nhs.uk, mayoclinic.org, EFSA (about 40%), and it rarely cites at all |
| Google AI Overview | 1,651 | **shops** are the largest single category (about a quarter): Amazon, Myprotein, Wegovy.com, Teatox, Myotape, Goli … |

Commercial domains next to health advice is a strong finding for the Google
data. For example, mouth-tape shops are cited next to the Sleep Foundation,
and a detox-tea shop next to the NHS's "there is no evidence" page.

### Comparing participants and groups

- **Vocabulary separates the groups cleanly.** Top words in `user` rows per
  participant cluster into: creatine/protein/gym, exam/sleep/caffeine,
  wegovy/calories/nausea, baby/fever/teething, and seed oils/detox/raw milk.
- **How people type** (mean words per prompt):
  - P06 writes the longest prompts (~14 words), with "sorry if this is a dumb
    question", "I'm really stressed" and "is this normal??".
  - P05 and P14 are polite: "Hi!" and "Thank you!".
  - P01, P03 and P17 are terse: lowercase, no punctuation, "pls" and "??".
- **Heavy and light users:** P03 has 100 conversations and P05 has 106, while
  P18 has 25 and P17 has 8.

### Changes over the month

- **The trend:** *mouth taping* appears only from 14 to 21 October, across
  groups A, B and E and on every platform. Plot the term by day.
- **Clock change:** *clock* and *5am* appear around 25–28 October, mostly from
  parents.
- **Exams:** words like *exam* and *all nighter* rise over the month in group
  B, peaking in the week of 22–28 October.
- **Night-time use:** the new parents P12 and P13 send about 45% of their
  messages between midnight and 5 am (UTC). The students send about 30%. The
  gym group sends almost none.
- **Participant stories:**
  - **P10's GLP-1 journey.** Until 9 October they ask about Ozempic vs Wegovy,
    price and prescriptions. Then come nausea, constipation and "sulfur
    burps", and later "stalled" and "plateau". Their own words trace
    starting a medicine.
  - **P08 switches platforms.** They use ChatGPT for the first two weeks, then
    almost only Claude.
  - **P04 drifts.** They start as a gym user (creatine, protein) and end up
    asking about seed oils, beef tallow, raw milk and detox. Compare their
    vocabulary in the first and second half of the month.
  - **P15 pushes back.** In 24 conversations they reply with "you sound like
    big pharma lol" or "my naturopath says otherwise though". It's the only
    participant who argues with the assistant, and the assistant's answer is
    the same each time.
  - **P17 drops out.** No data after 9 October, which gives you attrition to
    deal with.

### Suggested exercises

1. Word frequencies on `assistant` rows split by `platform`: which words are
   distinctive for each assistant?
2. Domain counts in the sources file by `platform`: classify domains into
   forum, video, public health, science, health media and shop, and compare.
3. Plot *mouth taping* by day: when did the trend start and end, and on which
   platforms? In the sources dataset, do the mouth-tape shops (myotape.com,
   hostage-tape.com) and tiktok.com follow the same curve?
4. Compare P04's vocabulary in the first and second half of the month.
5. Join sources to messages (`platform` + `message_id`): which participants
   are sent to shops most often, and for which questions?
