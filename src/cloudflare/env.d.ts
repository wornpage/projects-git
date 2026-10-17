// Inference is optional. Reviewer identities have no builder or owner permissions.
interface Env extends Partial<Pick<TrialLocalEnv,'TRIAL_POLICY'|'TRIAL_REGISTRY'> & Pick<TrialSampleEnv,'TRIAL_ARTIFACTS'> & Pick<TrialWorkflowEnv,'TRIAL_LOADER'|'TRIAL_TURNSTILE_SITE_KEY'|'TRIAL_TURNSTILE_HOSTNAME'>> {
  TRIAL_TURNSTILE_SECRET?: string;
  MODEL_API_KEY?: string;
  ACCESS_REVIEWER_CLIENT_IDS?: string;
  ACCESS_REVIEWER_SUBJECTS?: string;
  ACCESS_MEMBER_SUBJECTS?: string;
}
interface SubscriptionServiceEnv {
  SUBSCRIPTIONS_API_TOKEN: string;
}
