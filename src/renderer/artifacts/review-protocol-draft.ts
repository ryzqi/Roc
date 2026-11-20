import {useEffect} from 'react';
import type {ResearchReviewProtocolSaveRequest} from '../../shared/schemas/research-systematic-review';

export type ReviewProtocolBody = ResearchReviewProtocolSaveRequest['body'];
export type ReviewProtocolDraft = {
  body: ReviewProtocolBody;
  deviationReason: string;
  reviewNote: string;
  editing: boolean;
  saveRequestId: string;
  freezeRequestId: string;
};

/** Window-local unconfirmed form input, keyed by project and exact protocol version. */
export type ReviewProtocolDrafts = Map<string, ReviewProtocolDraft>;

/** The shell retains these drafts after the inspector is closed. */
export function useReviewProtocolDraftGuard(drafts: ReviewProtocolDrafts): void {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (drafts.size === 0) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [drafts]);
}

export function emptyReviewProtocolBody(): ReviewProtocolBody {
  return {
    question: '', pico: null,
    inclusionCriteria: [{id: crypto.randomUUID(), text: ''}],
    exclusionCriteria: [{id: crypto.randomUUID(), text: ''}],
    publicationYears: {from: null, to: null},
    databases: [{source: 'openalex', queries: [''], pageSize: 10, maxPages: 1}],
    screening: {titleAbstractReviewers: 1, fullTextReviewers: 1, conflictResolution: 'human_adjudication'},
    qualityAssessment: [{studyDesign: '', framework: '', version: ''}],
    extractionFields: [{id: crypto.randomUUID(), label: '', unit: null, required: true}]
  };
}
