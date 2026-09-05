import { supabase } from '../utils/supabase.js';
import crypto from 'crypto';
import path from 'path';
export class StorageService {
    static async uploadFile(fileBuffer, originalName, mimeType, folder = 'uploads') {
        const ext = path.extname(originalName);
        const fileName = `${folder}/${crypto.randomUUID()}${ext}`;
        const { data, error } = await supabase.storage
            .from('uploads')
            .upload(fileName, fileBuffer, {
            contentType: mimeType,
            upsert: false
        });
        if (error) {
            throw new Error(`Failed to upload to Supabase: ${error.message}`);
        }
        const { data: publicUrlData } = supabase.storage
            .from('uploads')
            .getPublicUrl(fileName);
        return publicUrlData.publicUrl;
    }
    static async deleteFile(fileUrl) {
        if (!fileUrl.includes('supabase.co'))
            return; // Ignore if it's not a Supabase URL
        try {
            const urlParts = new URL(fileUrl);
            const pathParts = urlParts.pathname.split('/');
            // e.g. /storage/v1/object/public/uploads/uploads/file.jpg
            const bucketIndex = pathParts.indexOf('uploads'); // finds the bucket name
            if (bucketIndex !== -1 && pathParts.length > bucketIndex + 1) {
                // the rest is the file path inside the bucket
                const filePath = pathParts.slice(bucketIndex + 1).join('/');
                const { error } = await supabase.storage
                    .from('uploads')
                    .remove([filePath]);
                if (error) {
                    console.error(`Failed to delete from Supabase: ${error.message}`);
                }
            }
        }
        catch (e) {
            console.error('Invalid URL during file deletion', e);
        }
    }
}
