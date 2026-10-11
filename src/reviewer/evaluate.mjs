export function scoreReviews(cases,attempts){
  if(!Array.isArray(cases)||!Array.isArray(attempts))throw new Error('Supply explicit cases and retained attempts.');
  const observations=new Map(attempts.map(item=>[item.caseId,item]));
  if(observations.size!==attempts.length)throw new Error('One retained attempt per case is required.');
  const summary={format:'projects-review-quality/v1',matchBasis:'path, side, and line overlap; exact priority is scored separately, and semantic findings require source review',
    cases:{total:cases.length,attempted:0,completed:0,failed:0,notRun:0},
    blockingFindings:{expected:0,assessable:0,notAssessed:0,locationMatches:0,priorityMatches:0,priorityMismatches:0,missedLocations:0,reported:0,unmatchedLocations:0},
    verdicts:{expectedPass:0,expectedChanges:0,correct:0,falsePass:0,falseReject:0},perCase:[]};
  for(const item of cases){
    if(typeof item?.id!=='string'||!Array.isArray(item.expected?.blocking)||!['pass','changes_requested'].includes(item.expected.verdict)
      ||item.expected.blocking.some(target=>!Number.isInteger(target.priority)||target.priority<0||target.priority>3))throw new Error('Malformed reviewer evaluation case.');
    const observation=observations.get(item.id),expected=item.expected.blocking;
    summary.blockingFindings.expected+=expected.length;
    if(item.expected.verdict==='pass')summary.verdicts.expectedPass++;else summary.verdicts.expectedChanges++;
    if(!observation){summary.cases.notRun++;summary.blockingFindings.notAssessed+=expected.length;
      summary.perCase.push({caseId:item.id,status:'not_run',expected:expected.length});continue;}
    summary.cases.attempted++;
    if(observation.status!=='evaluated'||!Array.isArray(observation.assessment?.findings)){
      summary.cases.failed++;summary.blockingFindings.notAssessed+=expected.length;
      summary.perCase.push({caseId:item.id,status:'failed',expected:expected.length});continue;
    }
    summary.cases.completed++;
    summary.blockingFindings.assessable+=expected.length;
    const assessment=observation.assessment,findings=assessment.findings,reported=findings.filter(finding=>finding.priority<=1);
    summary.blockingFindings.reported+=reported.length;
    const used=new Set();let matched=0,priorityMatches=0,priorityMismatches=0;
    for(const target of expected){
      const match=findings.findIndex((finding,index)=>!used.has(index)
        && finding.location?.path===target.path && finding.location.side===target.side
        && finding.location.startLine<=target.endLine && finding.location.endLine>=target.startLine);
      if(match>=0){used.add(match);matched++;if(findings[match].priority===target.priority)priorityMatches++;else priorityMismatches++;}
    }
    const falseAlarms=findings.filter((finding,index)=>finding.priority<=1&&!used.has(index)).length;
    const missed=expected.length-matched;
    summary.blockingFindings.locationMatches+=matched;summary.blockingFindings.priorityMatches+=priorityMatches;
    summary.blockingFindings.priorityMismatches+=priorityMismatches;summary.blockingFindings.missedLocations+=missed;
    summary.blockingFindings.unmatchedLocations+=falseAlarms;
    if(assessment.verdict===item.expected.verdict)summary.verdicts.correct++;
    else if(assessment.verdict==='pass')summary.verdicts.falsePass++;else summary.verdicts.falseReject++;
    summary.perCase.push({caseId:item.id,status:'evaluated',expected:expected.length,matched,priorityMatches,priorityMismatches,missed,falseAlarms,verdict:assessment.verdict});
  }
  for(const attempt of attempts)if(!cases.some(item=>item.id===attempt.caseId))throw new Error('An attempt targets an unknown evaluation case.');
  return summary;
}
