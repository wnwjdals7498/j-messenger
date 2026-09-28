import { test } from 'node:test';
import assert from 'node:assert/strict';

// This import will fail because we do not create src/lib/format.ts yet.
// That's expected for this test task.
import { formatTime, formatDateLabel, isSameDay } from '../src/lib/format.ts';
const TZ = 'Asia/Seoul';

test('formatTime returns 24-hour HH:mm in the given time zone', () => {
  assert.strictEqual(formatTime('2026-09-23T05:07:00Z', TZ), '14:07');
  assert.strictEqual(formatTime('2026-09-23T15:30:00Z', TZ), '00:30');
  assert.strictEqual(formatTime('2026-09-23T15:30:00Z', 'UTC'), '15:30');
  assert.strictEqual(formatTime('2026-09-23T15:30:00.123Z', 'UTC'), '15:30');
});

test('formatTime returns an empty string for invalid input', () => {
  assert.strictEqual(formatTime('not-a-date', TZ), '');
  assert.strictEqual(formatTime('', TZ), '');
});

test('formatDateLabel returns YYYY-MM-DD in the given time zone', () => {
  assert.strictEqual(formatDateLabel('2026-09-23T14:59:00Z', TZ), '2026-09-23');
  assert.strictEqual(formatDateLabel('2026-09-23T15:00:00Z', TZ), '2026-09-24');
  assert.strictEqual(formatDateLabel('2026-01-05T00:00:00Z', 'UTC'), '2026-01-05');
});

test('formatDateLabel returns an empty string for invalid input', () => {
  assert.strictEqual(formatDateLabel('garbage', TZ), '');
});

test('isSameDay compares calendar days in the given time zone', () => {
  assert.strictEqual(isSameDay('2026-09-23T00:00:00Z', '2026-09-23T14:59:00Z', TZ), true);
  assert.strictEqual(isSameDay('2026-09-23T14:59:00Z', '2026-09-23T15:00:00Z', TZ), false);
  assert.strictEqual(isSameDay('2026-09-23T14:59:00Z', '2026-09-23T15:00:00Z', 'UTC'), true);
});

test('isSameDay is false when either value is invalid', () => {
  assert.strictEqual(isSameDay('bad', 'bad', TZ), false);
  assert.strictEqual(isSameDay('2026-09-23T00:00:00Z', 'bad', TZ), false);
});

