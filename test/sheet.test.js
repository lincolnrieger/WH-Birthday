import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, describeColumns, columnLetter } from '../src/sheet.js';

const HEADERS = [
  'Timestamp', 'Email Address', 'Who should we call for all the details? ', 'Where can we reach you? ',
  "Who's the Star of the show?", 'How many candles are on the cake this year? ', 'How big is the adventure crew? ',
  'How many grown-ups / spectators will be tagging along?', 'When’s the big adventure happening? ', 'Got a Plan B? ',
  'Is your adventurer a morning explorer or an afternoon thrill-seeker? ',
  'We’ve got birthday party packages to suit every adventurer! ',
  'Want to keep the adventure going? Add a night of camping for just $10 per camper!',
  'Party bags? Yes, please! We can deliver them in a keepsake Woodhouse camping mug for just $14 per child!',
  'How Woodhouse are you? ', "Anything else you'd like us to know??? ", 'Column 1', 'Column 2', 'Column 3',
];

test('form questions get short labels', () => {
  const cols = describeColumns([HEADERS]);
  const byKey = Object.fromEntries(cols.filter((c) => c.key).map((c) => [c.key, c]));
  assert.equal(byKey.childName.label, 'Birthday child');
  assert.equal(byKey.partyBags.index, 13, 'party bags question is not mistaken for camping');
  assert.equal(byKey.camping.index, 12);
  assert.equal(byKey.package.index, 11);
});

test('Column 1 becomes Notes and the first empty spare column becomes Status', () => {
  const row = Array(19).fill('');
  row[0] = '8/23/2025 20:27:10';
  row[16] = 'emailed 29/8/25';
  const cols = describeColumns([HEADERS, row]);
  assert.equal(cols.find((c) => c.key === 'notes').index, 16);
  assert.equal(cols.find((c) => c.key === 'status').index, 17);
  assert.equal(cols[18].hidden, true, 'unused spare columns are hidden');
});

test('existing Status and Notes headings are reused', () => {
  const headers = [...HEADERS];
  headers[16] = 'Notes';
  headers[18] = 'Status';
  const cols = describeColumns([headers, Array(19).fill('')]);
  assert.equal(cols.find((c) => c.key === 'notes').index, 16);
  assert.equal(cols.find((c) => c.key === 'status').index, 18);
  assert.equal(cols[17].hidden, true);
});

test('Status and Notes are added as new columns when there are no spare ones', () => {
  const cols = describeColumns([HEADERS.slice(0, 16)]);
  assert.deepEqual(cols.filter((c) => c.key === 'notes' || c.key === 'status').map((c) => c.index), [16, 17]);
});

test('column letters', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(27), 'AB');
});

test('CSV parsing handles quotes, commas and newlines', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","line1\nline2 ""q"""\n'), [['a', 'b'], ['x, y', 'line1\nline2 "q"']]);
});
