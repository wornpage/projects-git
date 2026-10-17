// Inference is optional. Reviewer identities have no builder or owner permissions.
interface Env extends Partial<Pick<TrialLocalEnv,'TRIAL_POLICY'|'TRIAL_REGISTRY'>> {
  MODEL_API_KEY?: string;
  ACCESS_REVIEWER_CLIENT_IDS?: string;
  ACCESS_REVIEWER_SUBJECTS?: string;
  ACCESS_MEMBER_SUBJECTS?: string;
}
interface SubscriptionServiceEnv {
  SUBSCRIPTIONS_API_TOKEN: string;
}
