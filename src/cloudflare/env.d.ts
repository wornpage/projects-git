// Inference is optional. Reviewer identities have no builder or owner permissions.
interface Env {
  MODEL_API_KEY?: string;
  ACCESS_REVIEWER_CLIENT_IDS?: string;
  ACCESS_REVIEWER_SUBJECTS?: string;
}
interface SubscriptionServiceEnv {
  SUBSCRIPTIONS_API_TOKEN: string;
}
