// One bounded archive contract for the browser, Worker and offline recovery CLI.
export const WORKSPACE_BACKUP_MIB = 4;
export const MAX_WORKSPACE_BACKUP_BYTES = WORKSPACE_BACKUP_MIB * 1024 * 1024;
export const WORKSPACE_BACKUP_REQUEST_BYTES = MAX_WORKSPACE_BACKUP_BYTES + 64 * 1024;
export const BACKUP_LIMITS = Object.freeze({projects:80,currentProjects:32,historicalProjects:64,resources:64,tasks:256,runs:512,operations:2000,events:10000,policies:512,gitMappings:1024,jobs:512,
  artifactSubscriptions:128,artifactSubscriptionAttempts:4096,artifactEvents:4096,artifactEventAttempts:16384,artifactDeliveries:4096});
