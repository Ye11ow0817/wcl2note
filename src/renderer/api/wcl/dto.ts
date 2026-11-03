import { z } from "zod";
const id = z.number().int().safe();
const time = z.number().finite();
const actor = z
  .object({
    id,
    gameID: id.nullish(),
    name: z.string().nullish(),
    type: z.string().nullish(),
    subType: z.string().nullish(),
    petOwner: id.nullish(),
  })
  .passthrough();
const npc = z
  .object({
    id,
    gameID: id.nullish(),
    instanceCount: id.nonnegative().nullish(),
    petOwner: id.nullish(),
  })
  .passthrough();
const fightBase = {
  id,
  name: z.string().nullish(),
  startTime: time,
  endTime: time,
  encounterID: id.nullish(),
  difficulty: id.nullish(),
  kill: z.boolean().nullish(),
  bossPercentage: time.nullish(),
  fightPercentage: time.nullish(),
  lastPhase: id.nullish(),
  lastPhaseIsIntermission: z.boolean().nullish(),
  keystoneLevel: id.nullish(),
  keystoneTime: time.nullish(),
};
const fight = z
  .object({
    ...fightBase,
    dungeonPulls: z.array(z.object(fightBase).passthrough()).nullish(),
    phaseTransitions: z.array(z.object({ id, startTime: time })).nullish(),
    friendlyPlayers: z.array(id).nullish(),
    enemyPlayers: z.array(id).nullish(),
    friendlyNPCs: z.array(npc).nullish(),
    friendlyPets: z.array(npc).nullish(),
    enemyNPCs: z.array(npc).nullish(),
    enemyPets: z.array(npc).nullish(),
  })
  .passthrough();
export const reportSchema = z
  .object({
    startTime: time.optional().default(0),
    playerDetails: z.unknown().optional(),
    fights: z.array(fight).nullish(),
    phases: z
      .array(
        z.object({
          encounterID: id,
          phases: z.array(z.object({ id, name: z.string() })).nullish(),
        }),
      )
      .nullish(),
    masterData: z
      .object({
        actors: z.array(actor),
        abilities: z.array(
          z
            .object({
              gameID: id,
              name: z.string().nullish(),
              icon: z.string().nullish(),
              type: z.union([z.string(), z.number()]).nullish(),
            })
            .passthrough(),
        ),
      })
      .nullish(),
    events: z
      .object({
        data: z.array(
          z
            .object({ timestamp: time, abilityGameID: id.optional() })
            .passthrough(),
        ),
        nextPageTimestamp: time.nullish(),
      })
      .nullish(),
  })
  .passthrough();
