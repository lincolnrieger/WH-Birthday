import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, normaliseRows, parsePartyDate, parseTimestamp } from '../src/sheet.js';

const at = (s) => parseTimestamp(s);

test('form timestamps are read as M/D/YYYY', () => {
  assert.equal(at('10/14/2024 21:30:32').toISOString(), '2024-10-14T21:30:32.000Z');
  assert.equal(at('7/6/2025 13:26:11').toISOString(), '2025-07-06T13:26:11.000Z');
});

test('party dates in the many ways people write them', () => {
  const cases = [
    ['16th of November', '10/5/2024 16:14:27', '2024-11-16', true],
    ['20/10/2024', '10/8/2024 19:43:30', '2024-10-20', false],
    ['11/3/2024', '10/14/2024 21:30:32', '2024-11-03', true], // ambiguous, only Nov 3 is after the enquiry
    ['11/30/2024', '10/15/2024 19:56:51', '2024-11-30', false],
    ['1/12/2024', '10/15/2024 19:56:51', '2024-12-01', true],
    ['18/10/25', '7/6/2025 13:26:11', '2025-10-18', false],
    ['19 October 2025 or 25 October 2025', '7/6/2025 13:26:11', '2025-10-19', false],
    ['19th of October or 11th of October', '8/28/2025 8:19:45', '2025-10-19', true],
    ['March 3rd', '11/1/2025 9:00:00', '2026-03-03', true],
    ['2025-12-06', '11/1/2025 9:00:00', '2025-12-06', false],
  ];
  for (const [raw, ts, date, uncertain] of cases) {
    const r = parsePartyDate(raw, at(ts));
    assert.equal(r.date, date, raw);
    assert.equal(r.uncertain, uncertain, `${raw} uncertain`);
  }
  assert.deepEqual(parsePartyDate('', at('1/1/2025 0:00:00')), { date: null, uncertain: false });
  assert.equal(parsePartyDate('sometime soon', at('1/1/2025 0:00:00')).date, null);
});

test('CSV parsing handles quotes, commas and newlines', () => {
  const rows = parseCsv('a,b\n"x, y","line1\nline2 ""q"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'line1\nline2 "q"']]);
});

test('rows are mapped by question wording, extra columns become sheet notes', async () => {
  const headers = [
    'Timestamp', 'Email Address', 'Who should we call for all the details? ', 'Where can we reach you? ',
    "Who's the Star of the show?", 'How many candles are on the cake this year? ', 'How big is the adventure crew? ',
    'How many grown-ups / spectators will be tagging along?', 'When’s the big adventure happening? ', 'Got a Plan B? ',
    'Is your adventurer a morning explorer or an afternoon thrill-seeker? ',
    'We’ve got birthday party packages to suit every adventurer! ',
    'Want to keep the adventure going? Add a night of camping for just $10 per camper!',
    'Party bags? Yes, please! We can deliver them in a keepsake Woodhouse camping mug for just $14 per child!',
    'How Woodhouse are you? ', "Anything else you'd like us to know??? ", 'Column 1',
  ];
  const row = ['8/23/2025 20:27:10', 'jess@example.com', 'Jess', '0400 000 000', 'Ewan', '8', '9', '4', '29/11/2025', '',
    '', 'Silver Party Package', 'No thanks', 'Not sure yet', 'This will be our first time', '', 'emailed 29/8/25'];
  const [e] = await normaliseRows([headers, row, ['', '', '', '']]);
  assert.equal(e.childName, 'Ewan');
  assert.equal(e.package, 'Silver Party Package');
  assert.equal(e.camping, 'No thanks');
  assert.equal(e.partyBags, 'Not sure yet');
  assert.equal(e.partyDate, '2025-11-29');
  assert.equal(e.kidsCount, 9);
  assert.equal(e.sheetNotes, 'emailed 29/8/25');
  assert.match(e.id, /^[0-9a-f]{16}$/);
  const [again] = await normaliseRows([headers, row]);
  assert.equal(again.id, e.id, 'ids are stable between reads');
});
