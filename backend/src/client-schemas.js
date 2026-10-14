import { z } from "zod";

export const normalizeDigits = (value = "") =>
  String(value)
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

export function isValidIranianNationalCode(value) {
  const code = normalizeDigits(value).trim();
  if (!/^\d{10}$/.test(code) || /^([0-9])\1{9}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const sum = digits.slice(0, 9).reduce((total, digit, index) => total + digit * (10 - index), 0);
  const remainder = sum % 11;
  const check = remainder < 2 ? remainder : 11 - remainder;
  return digits[9] === check;
}

const optionalText = z.string().trim().max(5000).optional().nullable();
const emailSchema = z.string().trim().email().max(320).transform((v) => v.toLowerCase());
const nationalIdSchema = z.string().trim().transform(normalizeDigits)
  .pipe(z.string().regex(/^\d{10}$/))
  .refine(isValidIranianNationalCode, { message: "invalid_national_id_checksum" });

const commonClientSchema = {
  mobile: z.string().trim().max(20).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().max(320).optional().nullable(),
  source: z.string().trim().max(80).optional().nullable(),
  address: optionalText,
  notes: optionalText,
  status: z.enum(["active", "needs_followup", "inactive"]).optional().default("active")
};

const individualClientSchema = z.object({
  client_type: z.literal("individual"),
  full_name: z.string().trim().min(2).max(160),
  national_id: nationalIdSchema,
  birth_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  occupation: z.string().trim().max(160).optional().nullable(),
  company_name: z.null().optional().default(null),
  national_company_id: z.null().optional().default(null),
  registration_no: z.null().optional().default(null),
  ...commonClientSchema
});

const companyClientSchema = z.object({
  client_type: z.literal("company"),
  company_name: z.string().trim().min(2).max(240),
  national_company_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10,20}$/)),
  registration_no: z.string().trim().max(40).optional().nullable(),
  full_name: z.null().optional().default(null),
  national_id: z.null().optional().default(null),
  birth_date: z.null().optional().default(null),
  occupation: z.null().optional().default(null),
  ...commonClientSchema
});

export const clientCreateSchema = z.discriminatedUnion("client_type", [
  individualClientSchema,
  companyClientSchema
]);

export const clientPatchSchema = z.object({
  client_type: z.enum(["individual", "company"]).optional(),
  full_name: z.string().trim().min(2).max(160).optional().nullable(),
  national_id: nationalIdSchema.optional().nullable(),
  birth_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  occupation: z.string().trim().max(160).optional().nullable(),
  company_name: z.string().trim().min(2).max(240).optional().nullable(),
  national_company_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10,20}$/)).optional().nullable(),
  registration_no: z.string().trim().max(40).optional().nullable(),
  mobile: z.string().trim().max(20).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().max(320).optional().nullable(),
  source: z.string().trim().max(80).optional().nullable(),
  address: optionalText,
  notes: optionalText,
  status: z.enum(["active", "needs_followup", "inactive"]).optional()
}).strict();
