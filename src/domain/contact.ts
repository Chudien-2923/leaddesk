import { z } from "zod";

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  phone: z.string().trim().min(3).max(32).optional(),
}).strict();
