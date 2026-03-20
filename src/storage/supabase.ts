import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

let supabaseClient: SupabaseClient | null = null;

export function hasSupabaseStorage(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase(): SupabaseClient {
  if (!hasSupabaseStorage()) {
    throw new Error('Supabase storage is not configured.');
  }

  if (!supabaseClient) {
    supabaseClient = createClient(
      String(process.env.SUPABASE_URL),
      String(process.env.SUPABASE_SERVICE_ROLE_KEY)
    );
  }

  return supabaseClient;
}

export async function ensureBucket(): Promise<string> {
  if (!hasSupabaseStorage()) {
    return 'jtt1078-media';
  }

  try {
    const supabase = getSupabase();
    const { data: buckets } = await supabase.storage.listBuckets();

    if (buckets && buckets.length > 0) {
      console.log(`Using existing bucket: ${buckets[0].name}`);
      return buckets[0].name;
    }

    const bucketName = 'jtt1078-media';
    const { error } = await supabase.storage.createBucket(bucketName, {
      public: true,
      fileSizeLimit: 52428800
    });

    if (error) {
      console.warn('Supabase bucket creation warning:', error.message);
      return bucketName;
    }

    console.log(`Created Supabase bucket: ${bucketName}`);
    return bucketName;
  } catch (error) {
    console.warn('Supabase bucket initialization skipped:', error);
    return 'jtt1078-media';
  }
}
