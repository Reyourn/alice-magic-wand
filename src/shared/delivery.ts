export type DeliveryActionKind = 'push'|'pull-request'|'deploy';
export interface DeliveryActionInput {
  kind:DeliveryActionKind; remote?:string; branch?:string; base?:string;
  title?:string; body?:string; draft?:boolean; command?:string; args?:string[];
}
export interface DeliveryCommand { command:string; args:string[]; }
export interface DeliveryAction {
  id:string; workflowId:string; projectId:string; kind:DeliveryActionKind;
  commit:string; worktree:string; fingerprint:string; createdAt:string;
  state:'prepared'|'running'|'succeeded'|'failed'|'unknown';
  input:DeliveryActionInput; commands:DeliveryCommand[];
  remoteFingerprint?:string; destination?:string; confirmedAt?:string; completedAt?:string;
  receipts:{command:DeliveryCommand; exitCode:number; log:string}[];
  detail?:string; url?:string; reconciliation?:{reason:string;at:string;result:'succeeded'|'failed'};
}
