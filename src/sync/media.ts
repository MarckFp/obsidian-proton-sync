/** Media type used when the extension says nothing useful. */
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/**
 * Media types by extension.
 *
 * Drive stores the type with the file and its apps use it to decide how to
 * preview it, so an attachment uploaded as `application/octet-stream` shows up
 * on the web and on mobile as an opaque blob instead of an image or a video.
 * Covers what Obsidian itself can embed, plus the common office formats people
 * attach to notes.
 */
const MEDIA_TYPES: Record<string, string> = {
    // Notes and data
    md: 'text/markdown',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    canvas: 'application/json',
    base: 'text/yaml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    css: 'text/css',
    js: 'text/javascript',
    html: 'text/html',
    htm: 'text/html',
    xml: 'application/xml',
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    heic: 'image/heic',
    heif: 'image/heif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',
    flac: 'audio/flac',
    aac: 'audio/aac',
    '3gp': 'audio/3gpp',
    // Video
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    // Documents
    pdf: 'application/pdf',
    epub: 'application/epub+zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf',
    zip: 'application/zip',
};

export function mediaTypeOf(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return DEFAULT_MEDIA_TYPE;
    }
    return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_MEDIA_TYPE;
}

/** Whether a path holds text that can be compared or merged line by line. */
export function isTextPath(path: string): boolean {
    const mediaType = mediaTypeOf(path);
    return mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/xml';
}
