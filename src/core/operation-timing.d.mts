export type TimingPhase='verification'|'recovery';
export type TimingOutcome='completed'|'reconciled'|'failed'|'unconfirmed';
export interface OperationTiming {phase:TimingPhase;attemptId:string;startedAt:string;finishedAt:string|null;outcome:TimingOutcome|null}
export interface TimedOperation {state:string;attemptId?:string;timings?:OperationTiming[]}
export const TIMING_PHASES:readonly TimingPhase[];
export const TIMING_OUTCOMES:readonly TimingOutcome[];
export function timestamp(value:unknown):number|null;
export function operationTimings(operation:TimedOperation):OperationTiming[];
export function beginOperationTiming(operation:TimedOperation,phase:TimingPhase,attemptId:string,at?:string):void;
export function finishOperationTiming(operation:TimedOperation,phase:TimingPhase,attemptId:string,outcome:TimingOutcome,at?:string):void;
