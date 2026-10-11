import {indexedSearchResults} from '../retained-work.js';

export function createRetainedSearch({
  getContext,
  retainedSearches, currentProject, api, render, announce, showError
}) {
  async function loadIndexedSearch(project, state, offset = 0) {
    const workspaceId = getContext().workspace.id, request = (state.request ?? 0) + 1;
    const query = offset ? state.remote.query : state.query;
    const mode = offset ? state.remote.mode : state.mode;
    state.request = request; state.loading = true; state.error = '';
    render(true);
    try {
      const response = await api(`/api/projects/${encodeURIComponent(project.id)}/search?` + new URLSearchParams({ q: query, mode, offset: String(offset) }));
      if (getContext().workspace.id !== workspaceId || retainedSearches.get(project.id) !== state || state.request !== request) return;
      indexedSearchResults(getContext().workspace, project.id, response.items); // Fail closed before retaining foreign results.
      if (offset && state.remote?.generation !== response.generation) throw new Error('The history index changed while paging. Search again to load the current results.');
      state.remote = { ...response, query, items: offset ? [...state.remote.items, ...response.items] : response.items };
      state.resultQuery = query;
    } catch (error) {
      if (getContext().workspace.id !== workspaceId || retainedSearches.get(project.id) !== state || state.request !== request) return;
      state.error = error.message;
      if (getContext().view === 'evidence' && currentProject()?.id === project.id) showError(error.message,{id:'retained-submit'});
    } finally {
      if (getContext().workspace.id === workspaceId && retainedSearches.get(project.id) === state && state.request === request) {
        state.loading = false;
        if (getContext().view === 'evidence' && currentProject()?.id === project.id) { render(true); if(!state.error)announce(`${state.remote.items.length} indexed results shown.`); }
      }
    }
  }


  async function rebuildSearch(project, state) {
    const revision = state.remote?.index?.revision;
    if (!Number.isSafeInteger(revision) || state.loading) return;
    const workspaceId = getContext().workspace.id, request = (state.request ?? 0) + 1;
    const isCurrent = () => getContext().workspace.id === workspaceId && retainedSearches.get(project.id) === state && state.request === request;
    state.request = request; state.loading = true; state.error = ''; render(true);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/search-index`, { expectedRevision: revision });
      if (!isCurrent()) return;
      state.query = state.draft.trim();
      await loadIndexedSearch(project, state);
    } catch (error) { if (isCurrent()) {
      state.error = error.message;
      if(getContext().view === 'evidence' && currentProject()?.id === project.id)showError(error.message,{id:'retained-rebuild'});
    } }
    finally {
      if (isCurrent()) {
        state.loading = false;
        if (getContext().view === 'evidence' && currentProject()?.id === project.id) render(true);
      }
    }
  }
  return {loadIndexedSearch, rebuildSearch};
}
