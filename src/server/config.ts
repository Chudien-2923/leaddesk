import "server-only";
import { z } from "zod";

// Validate only the capability being used: database work does not need auth or integration keys.
export function getDatabaseConfig() {
  return z.object({
    DATABASE_URL: z.string().url().refine((url) => /^postgres(?:ql)?:/.test(url), "Expected a PostgreSQL URL"),
  }).parse({ DATABASE_URL: process.env.DATABASE_URL });
}

export function getAdminAuthConfig() {
  return z.object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
    ADMIN_USER_ID: z.string().uuid(),
  }).parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ADMIN_USER_ID: process.env.ADMIN_USER_ID,
  });
}
