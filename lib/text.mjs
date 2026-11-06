/** Shared HTML entity decoding + tag stripping for article/feed text. */
const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  deg: '°',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  rarr: '→',
  larr: '←',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
}

/** Decode named and numeric HTML entities in one pass. */
export function decodeEntities(value) {
  return String(value == null ? '' : value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
    }
    const mapped = NAMED[body]
    return mapped === undefined ? match : mapped
  })
}

/** Collapse a chunk of HTML to a single normalized text line. */
export function stripTags(value) {
  return decodeEntities(String(value == null ? '' : value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}
