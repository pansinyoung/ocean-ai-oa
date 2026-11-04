export function utcIso(millis: number): string {
  return new Date(millis).toISOString();
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

export function toLocalDate(utcIso: string, ianaTimeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ianaTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(utcIso));
}

export function toLocalDateTime(utcIso: string, ianaTimeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ianaTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(new Date(utcIso));
  const year = part(parts, 'year');
  const month = part(parts, 'month');
  const day = part(parts, 'day');
  let hour = part(parts, 'hour');
  if (hour === '24') hour = '00';
  const minute = part(parts, 'minute');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
