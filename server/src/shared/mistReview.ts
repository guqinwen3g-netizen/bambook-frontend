/** Server-derived review tasks. They expose only the submitted business snapshot. */
export type MistReviewTask = {
  id:string; kind:'procurement'|'quotation'|'claim'|'order'; entityId:string; title:string;
  requesterId:string; reviewerIds:string[]; status:'pending'|'approved'|'rejected'; submittedAt:string;
  requiredPermission:string; fileIds?:string[]; target:{view:string;id:string}; details:Array<{label:string;value:string}>;
};
