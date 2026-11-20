/** Explicit synthetic methods and outcomes for engineering tests only. */
export function reviewProtocolBodyFixture() {
  return {question:'Which synthetic source reports the controlled group difference?',pico:null,
    inclusionCriteria:[{id:'controlled',text:'Controlled synthetic group comparison.'}],
    exclusionCriteria:[{id:'no-outcome',text:'No reported group outcome.'}],
    publicationYears:{from:2020,to:2026},
    databases:[{source:'openalex',queries:['controlled synthetic group'],pageSize:5,maxPages:1}],
    screening:{titleAbstractReviewers:2,fullTextReviewers:2,conflictResolution:'human_adjudication'},
    qualityAssessment:[{studyDesign:'Synthetic controlled engineering fixture',framework:'Explicit engineering fixture checklist',version:'1'}],
    extractionFields:[{id:'difference',label:'Group mean difference',unit:'mg/L',required:true}]};
}
