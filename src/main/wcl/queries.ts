export const queries = {
  reportFights: `query GetReportFights($reportCode: String!) {
      reportData {
        report(code: $reportCode, allowUnlisted: true) {
          startTime
          fights(translate: true) {
            id
            name
            encounterID
            difficulty
            kill
            bossPercentage
            fightPercentage
            lastPhase
            lastPhaseIsIntermission
            keystoneLevel
            keystoneTime
            startTime
            endTime
          }
        }
      }
    }`,
  fightSegments:
    "query GetFightSegments($reportCode: String!, $fightId: Int!) {\n          reportData {\n            report(code: $reportCode, allowUnlisted: true) {\n              startTime\n              phases {\n                encounterID\n                phases {\n                  id\n                  name\n                  isIntermission\n                }\n              }\n              fights(fightIDs: [$fightId], translate: true) {\n                id\n                name\n                encounterID\n                difficulty\n                kill\n                startTime\n                endTime\n                dungeonPulls {\n                  id\n                  name\n                  encounterID\n                  kill\n                  startTime\n                  endTime\n                }\n                phaseTransitions {\n                  id\n                  startTime\n                }\n              }\n            }\n          }\n        }",
  fightContext:
    "query GetFightContext($reportCode: String!, $fightId: Int!) {\n          reportData {\n            report(code: $reportCode, allowUnlisted: true) {\n              startTime\n              fights(fightIDs: [$fightId], translate: true) {\n                id\n                startTime\n                endTime\n                friendlyPlayers\n                enemyPlayers\n                friendlyNPCs { id gameID instanceCount petOwner }\n                friendlyPets { id gameID instanceCount petOwner }\n                enemyNPCs { id gameID instanceCount petOwner }\n                enemyPets { id gameID instanceCount petOwner }\n              }\n              playerDetails(fightIDs: [$fightId], includeCombatantInfo: false)\n              masterData(translate: true) {\n                actors {\n                  id\n                  gameID\n                  name\n                  type\n                  subType\n                  petOwner\n                }\n                abilities {\n                  gameID\n                  name\n                  icon\n                  type\n                }\n              }\n            }\n          }\n        }",
  fightAbilityEvents: `query GetFightAbilityEvents(
    $reportCode: String!
    $fightId: Int!
    $startTime: Float!
    $endTime: Float!
    $hostilityType: HostilityType!
    $dataType: EventDataType!
    $viewOptions: Int
    $filterExpression: String
  ) {
    reportData {
      report(code: $reportCode, allowUnlisted: true) {
        events(
          dataType: $dataType
          fightIDs: [$fightId]
          startTime: $startTime
          endTime: $endTime
          hostilityType: $hostilityType
          limit: 10000
          translate: true
          viewOptions: $viewOptions
          filterExpression: $filterExpression
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }`,
} as const;
