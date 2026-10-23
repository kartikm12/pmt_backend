import { supabase } from '../utils/supabase.js';
import { ApiError } from '../utils/apiError.js';
import crypto from 'crypto';
import path from 'path';

// Attachments live in a PRIVATE bucket (nothing there has a public address); profile photos stay in the
// public "uploads" bucket because every page shows them. A private file is stored as "private:<path>".
export const FILES_BUCKET = process.env.FILES_BUCKET || "pmt-files";
const PRIVATE = "private:";
// Thumbnails: at most this many pixels wide or tall (enough for an 80 px square on a 3x phone screen)
const THUMB_SIZE = 240;
const thumbPath = (filePath: string) => `thumbs/${filePath}.webp`;

export class StorageService {
  static async uploadPrivateFile(fileBuffer: Buffer, originalName: string, mimeType: string) {
    const filePath = `attachments/${crypto.randomUUID()}${path.extname(originalName)}`;
    const { error } = await supabase.storage.from(FILES_BUCKET).upload(filePath, fileBuffer, { contentType: mimeType, upsert: false });
    if (error) {
      console.error(`Failed to upload to Supabase (${FILES_BUCKET}): ${error.message}`);
      throw new ApiError(502, "File storage is unavailable right now. Please try again.");
    }
    return `${PRIVATE}${filePath}`;
  }

  // Where to send someone who opened a checked file link: a 60-second storage link for private files;
  // files stored before the change still have their old public address
  static async openUrl(ref: string, fileName?: string) {
    if (!ref.startsWith(PRIVATE)) return ref;
    const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrl(ref.slice(PRIVATE.length), 60, fileName ? { download: fileName } : undefined);
    if (error || !data?.signedUrl) {
      console.error(`Couldn't sign ${ref}: ${error?.message ?? "no URL"}`);
      throw new ApiError(502, "File storage is unavailable right now. Please try again.");
    }
    return data.signedUrl;
  }

  // A small version of a picture for lists and comment thumbnails (a 48-80 px square doesn't need the full
  // screenshot). Made once, on first request, and kept next to the original; null = use the original.
  static async openThumbUrl(ref: string): Promise<string | null> {
    if (!ref.startsWith(PRIVATE)) return null;
    const original = ref.slice(PRIVATE.length);
    const thumb = thumbPath(original);
    const bucket = supabase.storage.from(FILES_BUCKET);
    const existing = await bucket.createSignedUrl(thumb, 60);
    if (!existing.error && existing.data?.signedUrl) return existing.data.signedUrl;
    try {
      const { data, error } = await bucket.download(original);
      if (error || !data) return null;
      const { default: sharp } = await import("sharp");
      const small = await sharp(Buffer.from(await data.arrayBuffer()))
        .rotate() // phone photos: respect the camera's orientation
        .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      const saved = await bucket.upload(thumb, small, { contentType: "image/webp", upsert: true });
      if (saved.error) return null;
      const signed = await bucket.createSignedUrl(thumb, 60);
      return signed.data?.signedUrl ?? null;
    } catch (err) {
      console.error(`Couldn't make a thumbnail for ${ref}:`, err);
      return null;
    }
  }

  static async uploadFile(fileBuffer: Buffer, originalName: string, mimeType: string, folder: string = 'uploads') {
    const ext = path.extname(originalName);
    const fileName = `${folder}/${crypto.randomUUID()}${ext}`;
    
    const { data, error } = await supabase.storage
      .from('uploads')
      .upload(fileName, fileBuffer, {
        contentType: mimeType,
        upsert: false
      });

    if (error) {
      console.error(`Failed to upload to Supabase: ${error.message}`);
      throw new ApiError(502, "File storage is unavailable right now. Please try again.");
    }

    const { data: publicUrlData } = supabase.storage
      .from('uploads')
      .getPublicUrl(fileName);

    return publicUrlData.publicUrl;
  }

  static async deleteFile(fileUrl: string) {
    if (fileUrl.startsWith(PRIVATE)) {
      const filePath = fileUrl.slice(PRIVATE.length);
      // Its thumbnail goes too, if one was made (a missing one is simply skipped)
      const { data, error } = await supabase.storage.from(FILES_BUCKET).remove([filePath, thumbPath(filePath)]);
      if (error) console.error(`Failed to delete from Supabase (${FILES_BUCKET}): ${error.message}`);
      else if (!data?.length) console.error(`Supabase did not delete ${filePath} from ${FILES_BUCKET} (no permission? set SUPABASE_SERVICE_ROLE_KEY)`);
      return;
    }
    if (!fileUrl.includes('supabase.co')) return; // Ignore if it's not a Supabase URL
    
    try {
      const urlParts = new URL(fileUrl);
      const pathParts = urlParts.pathname.split('/');
      // e.g. /storage/v1/object/public/uploads/uploads/file.jpg
      const bucketIndex = pathParts.indexOf('uploads'); // finds the bucket name
      if (bucketIndex !== -1 && pathParts.length > bucketIndex + 1) {
        // the rest is the file path inside the bucket
        const filePath = pathParts.slice(bucketIndex + 1).join('/');
        
        const { data, error } = await supabase.storage
          .from('uploads')
          .remove([filePath]);

        if (error) {
          console.error(`Failed to delete from Supabase: ${error.message}`);
        } else if (!data?.length) {
          // Supabase reports a permission-blocked delete as success with nothing removed
          console.error(`Supabase did not delete ${filePath} (no permission? set SUPABASE_SERVICE_ROLE_KEY)`);
        }
      }
    } catch (e) {
      console.error('Invalid URL during file deletion', e);
    }
  }
}
