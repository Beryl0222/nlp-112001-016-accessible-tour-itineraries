// Deterministic multilingual text helpers. All offsets are JavaScript string
// offsets and every helper keeps the original text untouched.

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};

export function chineseNumber(input) {
  if (input == null) return null;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (!s) return null;
  if (s === '十') return 10;
  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
    } else {
      return null;
    }
  }
  return total + current;
}

export function parseClock(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value <= 24 ? value * 60 : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;

  const iso = raw.match(/T?(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (iso && /^\d{1,2}:/.test(raw.replace(/^.*?(\d{1,2}:\d{2})/, '$1')) === false) {
    // Still accept a clock embedded in a longer ISO string.
  }
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [h, m] = raw.split(':').map(Number);
    return h * 60 + m;
  }

  const cn = raw.match(/(凌晨|早上|上午|中午|下午|晚上)?\s*([零〇一二两兩三四五六七八九十\d]{1,4})\s*[點点时時:：]\s*(?:([零〇一二两兩三四五六七八九十\d]{1,4})\s*分?)?/);
  if (cn) {
    let hour = chineseNumber(cn[2]);
    let minute = cn[3] ? chineseNumber(cn[3]) : 0;
    if (hour == null || minute == null) return null;
    const period = cn[1] || '';
    if ((period === '下午' || period === '晚上' || period === '中午') && hour < 12) hour += 12;
    if (period === '凌晨' && hour === 12) hour = 0;
    return hour * 60 + minute;
  }

  const en = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (en) {
    let hour = Number(en[1]);
    let minute = en[2] ? Number(en[2]) : 0;
    const period = (en[3] || '').replace(/\./g, '').toLowerCase();
    if (period === 'pm' && hour < 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    return hour * 60 + minute;
  }
  return null;
}

export function formatClock(minutes) {
  if (!Number.isInteger(minutes)) return null;
  const dayMinutes = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(dayMinutes / 60);
  const m = dayMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function sentenceRanges(text) {
  const ranges = [];
  const re = /[^。！？!?；;\n]+[。！？!?；;]?/g;
  let match;
  while ((match = re.exec(text))) {
    const value = match[0];
    if (value.trim()) {
      const leading = value.match(/^\s*/)[0].length;
      const trailing = value.match(/\s*$/)[0].length;
      ranges.push({
        start: match.index + leading,
        end: match.index + value.length - trailing,
        text: value.slice(leading, value.length - trailing)
      });
    }
  }
  if (ranges.length === 0 && text) ranges.push({ start: 0, end: text.length, text });
  return ranges;
}

export function sentenceAt(text, start, end = start) {
  const ranges = sentenceRanges(text);
  return ranges.find(r => start >= r.start && start < r.end)
    || ranges.find(r => start <= r.end && end >= r.start)
    || { start: 0, end: text.length, text };
}

function augmentRegex(re) {
  if (re.flags.includes('d')) return re;
  return new RegExp(re.source, `${re.flags}d`);
}

// Return an immutable evidence locator for the first pattern match.
export function evidenceForMatch(record, pattern, options = {}) {
  const text = record?.text ?? '';
  const re = pattern instanceof RegExp ? augmentRegex(pattern) : new RegExp(pattern, 'diu');
  const match = re.exec(text);
  if (!match) return null;
  const start = match.indices?.[0]?.[0] ?? match.index;
  const end = match.indices?.[0]?.[1] ?? start + match[0].length;
  const sentence = sentenceAt(text, start, end);
  const id = options.sourceId || record.id || options.recordId || 'unknown';
  return {
    recordId: id,
    sourceId: id,
    field: 'text',
    start,
    end,
    range: [start, end],
    quote: text.slice(start, end),
    sentence: sentence.text,
    sentenceRange: [sentence.start, sentence.end],
    locator: `${id}#text[${start}:${end}]`,
    ...(options.extra || {})
  };
}

export function allEvidenceForMatch(record, pattern, options = {}) {
  const text = record?.text ?? '';
  const re = pattern instanceof RegExp
    ? new RegExp(pattern.source, `${pattern.flags.includes('g') ? pattern.flags : pattern.flags}gd`)
    : new RegExp(pattern, 'gdiu');
  const out = [];
  let match;
  while ((match = re.exec(text))) {
    const start = match.indices[0][0];
    const end = match.indices[0][1];
    const sentence = sentenceAt(text, start, end);
    const id = options.sourceId || record.id || 'unknown';
    out.push({
      recordId: id,
      sourceId: id,
      field: 'text',
      start,
      end,
      range: [start, end],
      quote: text.slice(start, end),
      sentence: sentence.text,
      sentenceRange: [sentence.start, sentence.end],
      locator: `${id}#text[${start}:${end}]`,
      groups: match.slice(1),
      ...(options.extra || {})
    });
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

export function uniqueById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item?.id || item?.locator || JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export function parseDurationMinutes(text) {
  if (!text) return null;
  const cn = String(text).match(/(?:用时|需时|大约|约)?\s*([零〇一二两兩三四五六七八九十\d]+)\s*分(?:钟|鐘)?/);
  if (cn) return chineseNumber(cn[1]);
  const en = String(text).match(/(\d+)\s*(?:minute|min)s?\b/i);
  if (en) return Number(en[1]);
  return null;
}

export function parseTimeWindow(text) {
  const raw = String(text || '');
  const cn = raw.match(/([零〇一二两兩三四五六七八九十\d]{1,3})\s*[點点]\s*(?:([零〇一二两兩三四五六七八九十\d]{1,3})\s*分?)?\s*(?:开始|開始)?\s*(?:到|至|[-–—~～])\s*(?:下?午|晚上)?\s*([零〇一二两兩三四五六七八九十\d]{1,3})\s*[點点]?\s*(?:([零〇一二两兩三四五六七八九十\d]{1,3})\s*分?)?/);
  if (cn) {
    let startH = chineseNumber(cn[1]);
    const startM = cn[2] ? chineseNumber(cn[2]) : 0;
    let endH = chineseNumber(cn[3]);
    const endM = cn[4] ? chineseNumber(cn[4]) : 0;
    // The phrase often says 下午 only before the first hour.
    if (/下午|晚上/.test(raw) && startH < 12) startH += 12;
    if (endH < startH && endH < 12) endH += 12;
    return { start: startH * 60 + startM, end: endH * 60 + endM };
  }
  const en = raw.match(/\bbetween\s+(\d{1,2})(?::(\d{2}))?\s*(?:and|to|-)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i)
    || raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:to|-|–|—)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (en) {
    let sh = Number(en[1]);
    const sm = Number(en[2] || 0);
    let eh = Number(en[3]);
    const em = Number(en[4] || 0);
    const period = (en[5] || '').replace(/\./g, '').toLowerCase();
    if (period === 'pm') {
      if (sh < 12) sh += 12;
      if (eh < 12) eh += 12;
    }
    return { start: sh * 60 + sm, end: eh * 60 + em };
  }
  return null;
}

export function isWithinWindow(slot, window) {
  const t = parseClock(slot);
  if (t == null || !window) return null;
  return t >= window.start && t <= window.end;
}
