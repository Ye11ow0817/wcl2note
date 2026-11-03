import { z } from "zod";
const base = {
  reportCode: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/)
    .max(128),
};
const fight = { ...base, fightId: z.number().int().positive().max(2147483647) };
export const querySchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("reportFights"),
      variables: z.object(base).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("fightSegments"),
      variables: z.object(fight).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("fightContext"),
      variables: z.object(fight).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("fightAbilityEvents"),
      variables: z
        .object({
          ...fight,
          startTime: z
            .number()
            .finite()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
          endTime: z
            .number()
            .finite()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
          hostilityType: z.enum(["Friendlies", "Enemies"]),
          dataType: z.enum(["Casts", "Buffs", "Debuffs"]),
          abilityIds: z
            .array(z.number().int().positive().safe())
            .min(1)
            .max(100)
            .optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type Query = z.infer<typeof querySchema>;
export const credentialSchema = z
  .object({
    clientId: z.string().trim().max(256),
    clientSecret: z.string().trim().max(2048),
  })
  .strict();
