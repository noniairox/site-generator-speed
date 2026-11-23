// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// Own implementation, written from the README and the reference program's behaviour.
// Semantics match makefun-site exactly (verified against the kit's practice set and
// differential tests against the reference oracle); only the internals are faster:
//   - HTML escaping is fused into the inline scan (no per-character regex calls),
//   - inline rendering works on index ranges, never on string slices,
//   - Markdown is lexed and rendered in one pass, with no token objects,
//   - word counting is one manual scan (no /\S+/g match array),
//   - slugify/longDate are cached (pure functions; tag names repeat heavily),
//   - each source's card is computed once and reused for its page,
//   - tags slugify each name once (the reference does it three times).

/* ------------------------------------------------------------------ text */

/** HTML escape table (README: & < > " '). */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const SPECIAL_RE = /[&<>"']/;

/** Append s[a..b) HTML-escaped to out. */
function pushEsc(out, s, a, b) {
  if (a >= b) return;
  const seg = s.slice(a, b);
  if (!SPECIAL_RE.test(seg)) {
    out.push(seg);
    return;
  }
  let start = 0;
  for (let i = 0; i < seg.length; i++) {
    const e = ESC[seg[i]];
    if (e !== undefined) {
      if (i > start) out.push(seg.slice(start, i));
      out.push(e);
      start = i + 1;
    }
  }
  if (seg.length > start) out.push(seg.slice(start));
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A slug's cache: slugify is pure, and tag names repeat across a site. */
const slugCache = new Map();
const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // NFKD is the identity on ASCII, and combining marks are never ASCII.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `longDate` cached: dates repeat across a site. */
const dateCache = new Map();
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const res = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateCache.set(date, res);
  return res;
}

/* ------------------------------------------------------------ front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigits(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return b > a;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const okShape = raw.length === 10 && raw[4] === '-' && raw[7] === '-' &&
        isDigits(raw, 0, 4) && isDigits(raw, 5, 7) && isDigits(raw, 8, 10);
      const y = okShape ? Number(raw.slice(0, 4)) : 0;
      const mo = okShape ? Number(raw.slice(5, 7)) : 0;
      const d = okShape ? Number(raw.slice(8, 10)) : 0;
      if (!okShape || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
      let i = 0;
      while (i < raw.length) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return { error: 'key "slug": not a slug' };
        i++;
        if (i < raw.length && raw.charCodeAt(i) === 45) {
          i++;
          if (i >= raw.length) return { error: 'key "slug": not a slug' };
        }
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are scanned by index,
 * never split into an array.
 */
export function parseFrontMatter(text) {
  const len = text.length;
  let firstEnd = text.indexOf('\n');
  if (firstEnd === -1) firstEnd = len;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing '---' line, collecting the lines between.
  const lines = []; // {a, b, num} with num 1-based over the whole text
  let pos = firstEnd + 1;
  let num = 2;
  let closePos = -1;
  let closed = false;
  while (pos <= len) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = len;
    if (eol - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closed = true;
      closePos = eol === len ? len : eol + 1;
      break;
    }
    lines.push({ a: pos, b: eol, num });
    num++;
    if (eol === len) break;
    pos = eol + 1;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (const { a, b, num: n } of lines) {
    if (isBlankLine(text, a, b) || text.charCodeAt(a) === 35) continue; // blank or '#...'
    // LINE: ^([a-z_]+):(?: (.*))?$
    let colon = -1;
    for (let j = a; j < b; j++) {
      if (text.charCodeAt(j) === 58) { colon = j; break; }
    }
    let keyOk = colon > a;
    if (keyOk) {
      for (let j = a; j < colon; j++) {
        const c = text.charCodeAt(j);
        if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
      }
    }
    if (!keyOk || (colon + 1 < b && text.charCodeAt(colon + 1) !== 32)) return { error: `line ${n} is not "key: value"` };
    const key = text.slice(a, colon);
    let rawEnd = b;
    while (rawEnd > colon + 1 && (text.charCodeAt(rawEnd - 1) === 32 || text.charCodeAt(rawEnd - 1) === 9)) rawEnd--;
    const rawStart = colon + 1 < b && text.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1;
    const raw = rawStart >= rawEnd ? '' : text.slice(rawStart, rawEnd);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closePos) };
}

/* --------------------------------------------------------------- markdown */

// Whitespace per JavaScript \s (for word runs and list continuations).
function isWS(code) {
  return code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d || code === 0x20 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(s) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Printable ASCII (33..126) is never whitespace; the rest is a short test.
    const ws = c <= 32
      ? c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32
      : c >= 127 && (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
    if (ws) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** The characters a backslash escapes. */
function isEscapable(code) {
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 ||
    code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 ||
    code === 33 || code === 62;
}

/** The first index from `from` where s holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
const MARK_RE = /[\\`*[]/;
const INLINE_RE = /[\\`*&<>"'\[]/g;

/**
 * s[lo..hi) rendered inline into out; linkFn(target) is a link's href.
 * Works on index ranges, never on string slices. The scan jumps from one
 * interesting character to the next (a regex finds them), so plain text is
 * copied in whole chunks and HTML escaping is fused into the scan: a chunk
 * between two interesting characters holds no escape character by construction.
 */
function inlineRange(s, lo, hi, linkFn, out) {
  const re = INLINE_RE;
  re.lastIndex = lo;
  let chunk = lo;
  let m;
  while ((m = re.exec(s)) !== null && m.index < hi) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > chunk) out.push(s.slice(chunk, i));
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      chunk = i + 1;
      re.lastIndex = i + 1;
      continue;
    }
    if (c === 92) { // backslash
      if (i + 1 < hi && isEscapable(s.charCodeAt(i + 1))) {
        if (i > chunk) out.push(s.slice(chunk, i));
        const n = s.charCodeAt(i + 1);
        out.push(n === 62 ? '&gt;' : s[i + 1]);
        chunk = i + 2;
        re.lastIndex = i + 2;
      } else re.lastIndex = i + 1;
      continue;
    }
    if (c === 96) { // backtick: code span to the next backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        if (i > chunk) out.push(s.slice(chunk, i));
        out.push('<code>');
        pushEsc(out, s, i + 1, j);
        out.push('</code>');
        chunk = j + 1;
        re.lastIndex = j + 1;
      } else re.lastIndex = i + 1;
      continue;
    }
    if (c === 42) { // *
      if (i + 1 < hi && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          if (i > chunk) out.push(s.slice(chunk, i));
          out.push('<strong>');
          inlineRange(s, i + 2, j, linkFn, out);
          out.push('</strong>');
          chunk = j + 2;
          re.lastIndex = j + 2;
        } else re.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        if (i > chunk) out.push(s.slice(chunk, i));
        out.push('<em>');
        inlineRange(s, i + 1, j, linkFn, out);
        out.push('</em>');
        chunk = j + 1;
        re.lastIndex = j + 1;
      } else re.lastIndex = i + 1;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1, hi);
    let m2 = -1;
    let target = '';
    if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
      m2 = s.indexOf(')', k + 2);
      if (m2 === -1 || m2 >= hi) m2 = -1;
      else target = s.slice(k + 2, m2);
    }
    if (m2 !== -1 && target !== '' && !WS_RE.test(target)) {
      if (i > chunk) out.push(s.slice(chunk, i));
      out.push('<a href="');
      const href = linkFn(target);
      pushEsc(out, href, 0, href.length);
      out.push('">');
      inlineRange(s, i + 1, k, linkFn, out);
      out.push('</a>');
      chunk = m2 + 1;
      re.lastIndex = m2 + 1;
    } else re.lastIndex = i + 1;
  }
  if (hi > chunk) out.push(s.slice(chunk, hi));
}

/** A whole string rendered inline into out (fast path when it holds no markup). */
function inlineText(text, linkFn, out) {
  if (!MARK_RE.test(text)) {
    pushEsc(out, text, 0, text.length);
    return;
  }
  inlineRange(text, 0, text.length, linkFn, out);
}

/* --- line classifiers over src[a..b) (no slicing) --- */

function lineIsBlank(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** [start, end) of the line with spaces/tabs trimmed at both ends. */
function trimRange(s, a, b) {
  let x = a;
  let y = b;
  while (x < y && (s.charCodeAt(x) === 32 || s.charCodeAt(x) === 9)) x++;
  while (y > x && (s.charCodeAt(y - 1) === 32 || s.charCodeAt(y - 1) === 9)) y--;
  return [x, y];
}

/** A fence's language, or null when the line does not open one. */
function fenceLang(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return s.slice(a + 3, langEnd);
}

/** Whether the line closes a fence. */
function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text range, or null. */
function headingOf(s, a, b) {
  let i = a;
  let depth = 0;
  while (i < b && s.charCodeAt(i) === 35 && depth < 6) {
    i++;
    depth++;
  }
  if (depth === 0 || i >= b) return null;
  const c = s.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  let e = b;
  while (e > i && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  if (e === i) return null;
  return { depth, ts: i, te: e };
}

/** Whether the line is a thematic break. */
function isHR(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(a + 1) !== c0 || s.charCodeAt(a + 2) !== c0) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's content start, or null. */
function bulletOf(s, a, b) {
  if (b - a < 2) return null;
  const c = s.charCodeAt(a);
  if ((c === 45 || c === 42) && s.charCodeAt(a + 1) === 32) return a + 2;
  return null;
}

/** An ordered item's start number and content start, or null. */
function orderedOf(s, a, b) {
  let i = a;
  let digits = 0;
  while (i < b && digits < 9) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
    digits++;
  }
  if (digits === 0) return null;
  if (i + 1 >= b) return null;
  if (s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(s.slice(a, i)), cs: i + 2 };
}

/** Whether the line continues a list item (2+ spaces, then a non-space). */
function isContinued(s, a, b) {
  if (b - a < 3) return false;
  if (s.charCodeAt(a) !== 32 || s.charCodeAt(a + 1) !== 32) return false;
  let i = a + 2;
  while (i < b && s.charCodeAt(i) === 32) i++;
  if (i >= b) return false;
  return !isWS(s.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(s, a, b) {
  if (a === b) return true;
  const c0 = s.charCodeAt(a);
  if (c0 === 32 || c0 === 9) return lineIsBlank(s, a, b);
  if (c0 === 96) return fenceLang(s, a, b) !== null;
  if (c0 === 35) return headingOf(s, a, b) !== null;
  if (c0 === 45 || c0 === 42) return isHR(s, a, b);
  return false;
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (level 2 and 3
 * headings), its excerpt (the first paragraph's inline HTML, or "") and its
 * word count. `linkFn(target)` is a link's href.
 */
function renderBody(src, linkFn) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const len = src.length;
  const lineEnd = (p) => {
    const e = src.indexOf('\n', p);
    return e === -1 ? len : e;
  };
  const adv = (e) => (e === len ? len + 1 : e + 1);
  let pos = 0;
  while (pos <= len) {
    const eol = lineEnd(pos);
    const a = pos;
    const b = eol;
    if (a === b) {
      pos = adv(eol);
      continue;
    }
    // Dispatch on the first character: a block type is fixed by it, so the
    // other kinds need no test at all.
    const c0 = src.charCodeAt(a);
    let listInfo = null;
    if (c0 === 32 || c0 === 9) {
      if (lineIsBlank(src, a, b)) {
        pos = adv(eol);
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(src, a, b);
      if (lang !== null) {
        out.push('<pre><code');
        if (lang !== '') {
          out.push(' class="language-');
          pushEsc(out, lang, 0, lang.length);
          out.push('"');
        }
        out.push('>');
        pos = adv(eol);
        while (pos <= len) {
          const be = lineEnd(pos);
          if (fenceClose(src, pos, be)) {
            pos = adv(be);
            break;
          }
          pushEsc(out, src, pos, be);
          out.push('\n');
          if (be === len) {
            pos = len + 1;
            break;
          }
          pos = be + 1;
        }
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(src, a, b);
      if (hd !== null) {
        const text = src.slice(hd.ts, hd.te);
        const id = uniqueSlug(slugify(text), ids);
        const hOut = [];
        inlineText(text, linkFn, hOut);
        const hhtml = hOut.join('');
        out.push(`<h${hd.depth} id="${id}">${hhtml}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html: hhtml });
        pos = adv(eol);
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(src, a, b)) {
        out.push('<hr>\n');
        pos = adv(eol);
        continue;
      }
      const bl = bulletOf(src, a, b);
      if (bl !== null) listInfo = { ordered: false, start: 1 };
    } else if (c0 === 62) { // blockquote
      const qlines = [];
      while (pos <= len) {
        const qe = lineEnd(pos);
        if (src.charCodeAt(pos) !== 62) break;
        let s2 = pos + 1;
        if (s2 < qe && src.charCodeAt(s2) === 32) s2++;
        const [ts, te] = trimRange(src, s2, qe);
        if (te > ts) qlines.push(src.slice(ts, te));
        if (qe === len) {
          pos = len + 1;
          break;
        }
        pos = qe + 1;
      }
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineText(qlines.join('\n'), linkFn, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const od = orderedOf(src, a, b);
      if (od !== null) listInfo = { ordered: true, start: od.start };
    }
    if (listInfo !== null) {
      const isOrdered = listInfo.ordered;
      const start = listInfo.start;
      const items = [];
      while (pos <= len) {
        const le = lineEnd(pos);
        let m = null;
        let cs = 0;
        if (isOrdered) {
          const o = orderedOf(src, pos, le);
          if (o !== null) {
            m = o;
            cs = o.cs;
          }
        } else {
          const bb = bulletOf(src, pos, le);
          if (bb !== null) {
            m = bb;
            cs = bb;
          }
        }
        if (m !== null) {
          const [ts, te] = trimRange(src, cs, le);
          items.push([src.slice(ts, te)]);
          if (le === len) {
            pos = len + 1;
            break;
          }
          pos = le + 1;
        } else if (isContinued(src, pos, le)) {
          const [ts, te] = trimRange(src, pos, le);
          items[items.length - 1].push(src.slice(ts, te));
          if (le === len) {
            pos = len + 1;
            break;
          }
          pos = le + 1;
        } else break;
      }
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${isOrdered ? 'ol' : 'ul'}>`);
      out.push('\n');
      for (const parts of items) {
        out.push('<li>');
        inlineText(parts.join('\n'), linkFn, out);
        out.push('</li>\n');
      }
      out.push(`</${isOrdered ? 'ol' : 'ul'}>\n`);
      continue;
    }
    // paragraph
    const plines = [];
    {
      const [ts, te] = trimRange(src, a, b);
      plines.push(src.slice(ts, te));
      pos = adv(eol);
      while (pos <= len) {
        const pe = lineEnd(pos);
        if (endsParagraph(src, pos, pe)) break;
        const [ts2, te2] = trimRange(src, pos, pe);
        plines.push(src.slice(ts2, te2));
        if (pe === len) {
          pos = len + 1;
          break;
        }
        pos = pe + 1;
      }
    }
    const pOut = [];
    inlineText(plines.join('\n'), linkFn, pOut);
    const phtml = pOut.join('');
    if (excerpt === null) excerpt = phtml;
    out.push('<p>', phtml, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words: countWords(src) };
}

/* --------------------------------------------------------------- templates */

const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** The top-level names `nodes` read from the scope, and the templates it includes. */
function collectReads(nodes, bound, reads, includes) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) reads.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) reads.add(n.path[0]);
      collectReads(n.then, bound, reads, includes);
      if (n.else !== null) collectReads(n.else, bound, reads, includes);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) reads.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      collectReads(n.body, inner, reads, includes);
    } else if (n.kind === 'include') includes.push(n.name);
  }
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  const reads = new Set();
  const includes = [];
  collectReads(root.body, new Set(), reads, includes);
  return { name, nodes: root.body, reads, includes };
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A value written into out: escaped when `esc`, raw otherwise. */
function renderVar(out, v, esc) {
  if (typeof v === 'string') {
    if (esc) pushEsc(out, v, 0, v.length);
    else out.push(v);
    return;
  }
  if (typeof v === 'number') {
    out.push(String(v));
    return;
  }
  if (typeof v === 'boolean') {
    out.push(v ? 'true' : 'false');
    return;
  }
  if (Array.isArray(v)) {
    const s = v.map(textOf).join(', ');
    if (esc) pushEsc(out, s, 0, s.length);
    else out.push(s);
    return;
  }
}

/** The top-level name `name` in the scope chain, or undefined. */
function lookupTop(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** A value's part in a memo key: primitives by value, objects by identity. */
function idOf(v, ctx) {
  if (v === null || v === undefined) return 'n';
  const t = typeof v;
  if (t === 'string') return `s${v}`;
  if (t === 'number') return `#${v}`;
  if (t === 'boolean') return v ? 't' : 'f';
  let id = ctx.ids.get(v);
  if (id === undefined) {
    id = ctx.nextId;
    ctx.nextId += 1;
    ctx.ids.set(v, id);
  }
  return `o${id}`;
}

/** The memo key for rendering template `t` in `scope` at include `depth`. */
function memoKey(t, scope, depth, ctx) {
  let key = `${t.name}@${depth}`;
  for (const r of t.reads) key += `\0${idOf(lookupTop(scope, r), ctx)}`;
  return key;
}

/**
 * `nodes` rendered into out, in `scope` ({ vars, parent }). `ctx` holds the
 * parsed templates (`templates`, a Map of name to { nodes, reads, includes })
 * and the include memo (`memo`, `ids`, `nextId`).
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        renderVar(out, lookup(scope, n.path), true);
        break;
      case 'raw':
        renderVar(out, lookup(scope, n.path), false);
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const key = memoKey(t, scope, depth, ctx);
        const hit = ctx.memo.get(key);
        if (hit !== undefined) {
          out.push(hit);
          break;
        }
        const tmp = [];
        renderNodes(t.nodes, scope, ctx, depth + 1, tmp);
        const s = tmp.join('');
        ctx.memo.set(key, s);
        out.push(s);
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------- build */

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // An included template's reads are its own plus, transitively, the reads of
  // everything it includes: the memo key must capture all of them.
  {
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of templates.values()) {
        for (const inc of t.includes) {
          const u = templates.get(inc);
          if (u === undefined) continue;
          for (const r of u.reads) {
            if (!t.reads.has(r)) {
              t.reads.add(r);
              changed = true;
            }
          }
        }
      }
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths.
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) {
        b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
      } else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks: each page's output directory and url.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Markdown: each body's HTML, its links resolved.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const linkFn = (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      };
      const md = renderBody(s.body, linkFn);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
      s.words = md.words;
    }
  }

  // 5. Collections: the posts, newest first and then by slug.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. Tags: grouped by slug, each named as first met in the posts' order.
  {
    const bySlug = new Map();
    for (const p of b.posts) {
      p.tagRefs = [];
      const seen = new Set();
      for (const name of p.data.tags ?? []) {
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (s.post) continue;
      s.tagRefs = [];
      const seen = new Set();
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Layouts: every page through its layout, the index and tag pages.
  {
    for (const s of b.sources) s.card = cardOf(s);
    b.cards = new Map(b.posts.map((p) => [p, p.card]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const ctx = { templates: b.templates, memo: new Map(), ids: new WeakMap(), nextId: 0 };
    const render = (name, vars) => {
      const t = b.templates.get(name);
      if (t === undefined) return null;
      const out = [];
      renderNodes(t.nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
      return out.join('');
    };
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
