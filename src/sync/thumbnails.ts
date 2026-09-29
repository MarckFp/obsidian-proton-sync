import { ThumbnailType, type Thumbnail } from '@protontech/drive-sdk';

/** Formats Chromium can decode into a bitmap. SVG is left out: it has no intrinsic size to scale from. */
const THUMBNAIL_SOURCES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

/** Drive's small thumbnail: the longest side and the encoded size it accepts. */
const THUMBNAIL_MAX_SIDE = 512;
const THUMBNAIL_MAX_BYTES = 60 * 1024;

/**
 * A preview for Drive's file browser, for image types the renderer can decode.
 *
 * Drive does not generate thumbnails itself: with end-to-end encryption the
 * server never sees the image, so the uploading client has to provide one or
 * the image appears in Drive as a generic icon. Best effort by design; any
 * failure means no thumbnail, never a failed upload.
 */
export async function imageThumbnails(data: ArrayBuffer, mediaType: string): Promise<Thumbnail[]> {
    if (
        !THUMBNAIL_SOURCES.has(mediaType) ||
        typeof createImageBitmap !== 'function' ||
        typeof OffscreenCanvas !== 'function'
    ) {
        return [];
    }
    try {
        const bitmap = await createImageBitmap(new Blob([data], { type: mediaType }));
        const scale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) {
            bitmap.close();
            return [];
        }
        // JPEG has no alpha channel; without a backdrop, transparent areas of
        // a PNG turn black.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        for (const quality of [0.85, 0.7, 0.5, 0.3]) {
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
            if (blob.size <= THUMBNAIL_MAX_BYTES) {
                return [{ type: ThumbnailType.Type1, thumbnail: new Uint8Array(await blob.arrayBuffer()) }];
            }
        }
    } catch {
        // Undecodable or unsupported; Drive falls back to a generic icon.
    }
    return [];
}
