/**
 * safari_get_youtube_notes: structured video metadata + show notes from a
 * YouTube watch page, read through an isolated reader (reader-pool.mjs).
 *
 * The rendered page never contains the full description (YouTube collapses it
 * behind "…more" and lazily renders the rest), but the watch page embeds
 * `ytInitialPlayerResponse` in an inline script with `videoDetails`, which is
 * what this module extracts in-page and post-processes here.
 */

const WATCH_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'])

/**
 * Normalize any common YouTube URL form to a canonical watch URL.
 * @param {string} input - watch / youtu.be / shorts / embed / live URL, or a bare 11-char id.
 * @returns {{ url: string, videoId: string }}
 * @throws when no video id can be recognized.
 */
export function canonicalWatchUrl(input) {
  const text = input.trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return { url: `https://www.youtube.com/watch?v=${text}`, videoId: text }
  let url
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    throw new Error(`Not a YouTube URL or video id: ${input}`)
  }
  let videoId
  if (url.hostname === 'youtu.be') videoId = url.pathname.slice(1).split('/')[0]
  else if (WATCH_HOSTS.has(url.hostname)) {
    videoId = url.searchParams.get('v')
      ?? /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname)?.[1]
      ?? undefined
  }
  if (videoId === undefined || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error(`Could not find a YouTube video id in: ${input}`)
  }
  return { url: `https://www.youtube.com/watch?v=${videoId}`, videoId }
}

/** In-page function body: pull videoDetails out of the inline ytInitialPlayerResponse script. */
export const EXTRACT_SCRIPT = `
const key = 'var ytInitialPlayerResponse = ';
for (const s of document.scripts) {
  const text = s.textContent;
  const start = text.indexOf(key);
  if (start < 0) continue;
  let json = text.slice(start + key.length);
  json = json.slice(0, json.lastIndexOf('};') + 1);
  const response = JSON.parse(json);
  const d = response.videoDetails || {};
  const micro = (response.microformat && response.microformat.playerMicroformatRenderer) || {};
  return {
    videoId: d.videoId, title: d.title, author: d.author, channelId: d.channelId,
    lengthSeconds: Number(d.lengthSeconds) || null, viewCount: Number(d.viewCount) || null,
    isLive: !!d.isLiveContent, keywords: d.keywords || [],
    publishDate: micro.publishDate || null, category: micro.category || null,
    description: d.shortDescription || ''
  };
}
return null;`

const CHAPTER_LINE = /^\s*\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[-–—:|]?\s*(.+?)\s*$/

/**
 * Post-process the in-page extraction into the tool's canonical value.
 * @param {object | null} raw - value returned by EXTRACT_SCRIPT.
 * @param {string} url - canonical watch URL.
 * @returns {object}
 */
export function shapeNotes(raw, url) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`YouTube page data not found at ${url}: the video may be unavailable, age-restricted, or the page layout changed.`)
  }
  const description = typeof raw.description === 'string' ? raw.description : ''
  const chapters = []
  for (const line of description.split('\n')) {
    const match = CHAPTER_LINE.exec(line)
    if (match !== null && !/^https?:/i.test(match[2])) chapters.push({ time: match[1], title: match[2] })
  }
  const links = [...new Set(description.match(/https?:\/\/[^\s)>\]]+/g) ?? [])]
  return {
    url,
    videoId: raw.videoId,
    title: raw.title,
    author: raw.author,
    channelId: raw.channelId,
    publishDate: raw.publishDate,
    category: raw.category,
    lengthSeconds: raw.lengthSeconds,
    viewCount: raw.viewCount,
    isLive: raw.isLive,
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    chapters,
    links,
    description,
  }
}

/** Model-facing text for the notes value. */
export function renderNotes(value) {
  const duration = value.lengthSeconds ? ` · ${Math.floor(value.lengthSeconds / 60)}:${String(value.lengthSeconds % 60).padStart(2, '0')}` : ''
  const views = value.viewCount ? ` · ${value.viewCount.toLocaleString('en-US')} views` : ''
  const lines = [
    `# ${value.title ?? '(untitled)'}`,
    `${value.author ?? ''}${duration}${views}${value.publishDate ? ` · published ${value.publishDate}` : ''}`,
    `URL: ${value.url}`,
  ]
  if (value.chapters.length > 0) {
    lines.push('', `## Chapters (${value.chapters.length})`)
    for (const chapter of value.chapters) lines.push(`- ${chapter.time} ${chapter.title}`)
  }
  lines.push('', '## Description', value.description.trim() === '' ? '(empty)' : value.description)
  return lines.join('\n')
}
