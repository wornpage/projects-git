// Explicit local-fixture permissions only. These values never approve real
// Cloudflare spending, and no fixture exposes a remote Artifacts binding.
export const unapprovedTrialResources=Object.freeze({approval:null,approvalExpiresAt:null,
  dailySetups:0,totalSetups:0,setupAttempts:0,providerCalls:0,cleanupDelayMs:86400_000});
export const approvedTrialResources=Object.freeze({approval:'local-fixture-only',approvalExpiresAt:8.64e15,
  dailySetups:20,totalSetups:1000,setupAttempts:10,providerCalls:200,cleanupDelayMs:300_000});
export const approvedTrialAllowance={spending:'approved',setupAvailable:true,reason:null,setupAttempts:{used:0,limit:10},
  providerCalls:{used:0,limit:200},billingCapGuaranteed:false};
