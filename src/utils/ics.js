/**
 * Generate iCalendar (ICS) content for a single event.
 * Used to send calendar invite to parent email.
 * @param {object} opts - { title, start (Date), end (Date), description?, location? }
 * @returns {string} ICS file content
 */
function formatDateForICS(d) {
    const date = d instanceof Date ? d : new Date(d);
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeICS(str) {
    if (str == null || str === '') return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
}

function generateICS(opts) {
    const { title, start, end, description = '', location = '' } = opts;
    const startDate = start instanceof Date ? start : new Date(start);
    const endDate = end instanceof Date ? end : new Date(end);
    const uid = `tour-${startDate.getTime()}-${Math.random().toString(36).slice(2, 10)}@nestops`;
    const now = formatDateForICS(new Date());
    const dtstart = formatDateForICS(startDate);
    const dtend = formatDateForICS(endDate);

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//NestOps//Tour Booking//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${now}`,
        `DTSTART:${dtstart}`,
        `DTEND:${dtend}`,
        `SUMMARY:${escapeICS(title)}`,
    ];
    if (description) lines.push(`DESCRIPTION:${escapeICS(description)}`);
    if (location) lines.push(`LOCATION:${escapeICS(location)}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');

    return lines.join('\r\n');
}

module.exports = { generateICS, formatDateForICS };
