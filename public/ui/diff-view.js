import {el, shortSha} from './dom.js';
import {recordedDiff, diffWindow, DIFF_PAGE_LINES} from '../review-diff.js';
import {highlightSyntax,paintSyntax,syntaxLanguage,syntaxLabel,syntaxRenderWithinLimit} from '../code-syntax.js';

export function createDiffView({getContext}) {
  const states = new Map();
  const preventSubmit = event => {
    if (event.key !== 'Enter') return false;
    event.preventDefault(); event.stopPropagation(); return true;
  };
  return function diffPanel(run) {
    if (!run.diff) return el('section', {class: 'panel diff-panel'},
      el('div', {class: 'panel-header'}, el('h2', {}, 'Changes against task base')),
      el('div', {class: 'no-candidate diff-empty'}, run.status === 'failed' ? 'This candidate failed before producing a diff.' : 'The diff will appear when this candidate produces a commit.'));
    const key = [getContext().workspace.id, run.id, run.baseCommit, run.headCommit].join(':');
    const paths = run.changedFiles ?? [], pathKey = JSON.stringify(paths);
    let state = states.get(key);
    if (!state || state.diff !== run.diff || state.pathKey !== pathKey) {
      state = {diff: run.diff, pathKey, model: recordedDiff(run.diff, paths), selected: 0, offset: 0, query: '', filesExpanded:false, syntaxEnabled:true, syntax:new Map()};
      states.set(key, state);
      if (states.size > 16) states.delete(states.keys().next().value);
    }
    for(const [otherKey,other] of states)if(otherKey!==key)other.syntax.clear();
    const {model} = state, prefix = 'diff-' + run.id + '-' + shortSha(run.headCommit);
    const title = (section, index) => section.path ?? (model.sections.length === 1 ? 'Recorded diff · unmapped file' : 'Unmapped section ' + (index + 1));
    const fileList = el('ul', {class: 'diff-files', 'aria-label': 'Changed file sections'});
    const fileCount = el('p', {class: 'diff-file-count', role: 'status'});
    const pane = el('div', {class: 'diff-pane'});
    const filesToggle=el('button',{class:'button button-small diff-files-toggle',type:'button',hidden:model.sections.length===1&&!model.unmapped&&!model.missingPaths.length,
      'aria-controls':prefix+'-files','aria-expanded':state.filesExpanded,onclick:()=>{state.filesExpanded=!state.filesExpanded;fileNav.setAttribute('data-expanded',String(state.filesExpanded));filesToggle.setAttribute('aria-expanded',String(state.filesExpanded));}},'Files');
    const renderFiles = () => {
      const matches = model.sections.map((section, index) => ({section, index})).filter(({section, index}) => title(section, index).toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
      fileCount.textContent = `${matches.length} of ${model.sections.length} ${model.unmapped ? 'diff sections' : 'files'}${state.query ? ' match' : ''}`;
      filesToggle.textContent='Files · '+matches.length+' / '+model.sections.length;
      fileList.replaceChildren(...matches.map(({section, index}) => el('li', {}, el('button', {
        type: 'button', class: 'diff-file-button', 'aria-pressed': index === state.selected,
        onclick: () => { state.selected = index; state.offset = 0; state.filesExpanded=false;fileNav.setAttribute('data-expanded','false');filesToggle.setAttribute('aria-expanded','false');renderFiles(); renderPane(true); }
      }, el('span', {class: 'diff-file-path'}, title(section, index)),
      section.path ? el('span', {class: 'diff-file-counts', 'aria-label': `${section.added} additions, ${section.removed} deletions`}, '+' + section.added + ' / −' + section.removed) : null))));
      if (!matches.length) fileList.append(el('li', {class: 'diff-no-files'}, 'No matching paths. Clear the filter to see every section.'));
    };
    const renderPane = (focus = false,focusSyntax=false) => {
      const section = model.sections[state.selected], slice = diffWindow(section, state.offset);
      const selected=state.selected,language=syntaxLanguage(section.path);
      const syntaxStatus=el('span',{role:'status'},syntaxLabel(language,null,state.syntaxEnabled));
      const syntaxButton=el('button',{type:'button',class:'syntax-toggle','aria-pressed':state.syntaxEnabled,disabled:!language,
        title:'Toggle code colors. Source text and added or removed line markers stay unchanged.',
        onclick:()=>{const previous=pane.querySelector('pre'),position=[previous.scrollTop,previous.scrollLeft];
          state.syntaxEnabled=!state.syntaxEnabled;renderPane(false,true);const next=pane.querySelector('pre');
          next.scrollTop=position[0];next.scrollLeft=position[1];}},'Syntax colors');
      const lineNodes=slice.rows.map(row=>el('span',{class:'diff-line '+row.kind},row.text||' '));
      const code=el('code',{},lineNodes);
      const heading = el('h3', {id: prefix + '-selected', tabindex: '-1'}, title(section, state.selected));
      const jump = el('input', {id: prefix + '-line', type: 'text', inputmode: 'numeric', maxlength: 10, value: slice.start + 1,
        'aria-describedby': prefix + '-jump-help', onkeydown: event => {
          if (preventSubmit(event)) go();
        }});
      const jumpHelp = el('span', {id: prefix + '-jump-help', class: 'diff-jump-help', role: 'status'});
      const move = offset => { state.offset = offset; renderPane(true); };
      const go = () => {
        const line = Number(jump.value);
        if (Number.isSafeInteger(line) && line >= 1 && line <= slice.total) move(line - 1);
        else { jump.setAttribute('aria-invalid', 'true'); jumpHelp.textContent = `Enter a diff line from 1 to ${slice.total}.`; }
      };
      pane.replaceChildren(...[el('div', {class: 'diff-pane-heading'}, heading,
        el('p', {class: 'diff-window-count', role: 'status'}, `Diff lines ${slice.start + 1}–${slice.end} of ${slice.total} · commit ${shortSha(run.headCommit)}`)),
      el('div',{class:'syntax-toolbar'},syntaxStatus,syntaxButton),
      el('pre', {class: 'diff', role:'region', tabindex: '0', 'aria-label': 'Recorded diff for ' + title(section, state.selected)},code),
      slice.total > DIFF_PAGE_LINES ? el('div', {class: 'diff-pagination'},
        el('button', {type: 'button', class: 'button button-small', disabled: slice.start === 0, onclick: () => move(Math.max(0, slice.start - DIFF_PAGE_LINES))}, 'Previous lines'),
        el('button', {type: 'button', class: 'button button-small', disabled: slice.end === slice.total, onclick: () => move(slice.end)}, 'Next lines'),
        el('div', {class: 'diff-jump'}, el('label', {for: jump.id}, 'Diff line'), jump,
          el('button', {type: 'button', class: 'button button-small', onclick: go}, 'Go'), jumpHelp)) : null].filter(Boolean));
      if (focus) heading.focus({preventScroll: true});
      if (focusSyntax) syntaxButton.focus({preventScroll:true});
      if(state.syntaxEnabled&&language){
        if(!state.syntax.has(selected)){
          state.syntax.set(selected,highlightSyntax(section.path,{mode:'diff',rows:section.rows}));
          if(state.syntax.size>2)state.syntax.delete(state.syntax.keys().next().value);
        }
        state.syntax.get(selected).then(result=>{
          if(!code.isConnected||state.selected!==selected||!state.syntaxEnabled)return;
          syntaxStatus.textContent=syntaxLabel(language,result);
          if(result.status==='colored'){
            const lines=result.lines?.slice(slice.start,slice.end);
            if(!syntaxRenderWithinLimit(lines)){syntaxStatus.textContent=syntaxLabel(language,{status:'plain',reason:'large'});return;}
            lineNodes.forEach((node,index)=>paintSyntax(node,slice.rows[index].text||' ',lines[index]));
          }
        });
      }
    };
    const filter = el('input', {id: prefix + '-filter', type: 'search', maxlength: 200, value: state.query,
      placeholder: 'Filter paths', onkeydown: preventSubmit, oninput: event => { state.query = event.target.value; renderFiles(); }});
    const fileNav=el('nav', {id:prefix+'-files',class: 'diff-file-nav','data-expanded':String(state.filesExpanded), 'aria-label': 'Changed files'}, el('label', {for: filter.id}, 'Files in this candidate'), filter, fileCount, fileList);
    renderFiles(); renderPane();
    return el('section', {class: 'panel diff-panel'},
      el('div', {class: 'panel-header'}, el('h2', {}, 'Changes against task base'),
        el('span', {class: 'section-kicker'}, `${paths.length} recorded ${paths.length === 1 ? 'path' : 'paths'} · ${model.unmapped || model.missingPaths.length ? 'diff mapping incomplete' : '+' + model.added + ' / −' + model.removed}`)),
      model.unmapped || model.missingPaths.length ? el('p', {class: 'diff-mapping-note'}, `${model.unmapped} unmapped diff sections; ${model.missingPaths.length} recorded paths without a matching section. All recorded patch text remains available.`) : null,
      el('div', {class: 'diff-browser'},
        filesToggle,fileNav,pane));
  };
}
