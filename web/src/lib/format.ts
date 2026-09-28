export function formatTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone
  }).format(date);
}

export function formatDateLabel(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone
  }).format(date);
}

export function isSameDay(aIso: string, bIso: string, timeZone: string): boolean {
  const aLabel = formatDateLabel(aIso, timeZone);
  const bLabel = formatDateLabel(bIso, timeZone);
  return aLabel !== '' && bLabel !== '' && aLabel === bLabel;
}
