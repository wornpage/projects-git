// Owns workspace reads and polling. Forced refreshes wait for a read started
// after the current one; reads never retry an action that changes the workspace.
import {workspaceAccessLost} from './api-client.js';
export function createWorkspaceConnection({api, getWorkspace, setWorkspace, activity,
  onChange, onSnapshot, onError, now = () => new Date().toISOString(),
  setTimer = setTimeout, clearTimer = clearTimeout, getPath = () => '/api/workspace', normalizeSnapshot = data => data}) {
  const state = {loading:false, error:null, lastSyncedAt:null, lastSyncedVersion:null};
  let pending = null, timer = null, epoch = 0;

  function invalidate(error) {
    const previous=getWorkspace();
    epoch++;pending=null;clearTimer(timer);timer=null;
    error.accessLost=true;
    setWorkspace(null);state.loading=false;state.error=error;
    state.lastSyncedAt=null;state.lastSyncedVersion=null;
    onError(error,{accessLost:true,previous});onChange();
  }

  function captureSession() {
    const started = epoch, workspaceId = getWorkspace()?.id, principal = JSON.stringify(getWorkspace()?.authentication?.principal ?? null);
    return () => started === epoch && workspaceId === getWorkspace()?.id && principal === JSON.stringify(getWorkspace()?.authentication?.principal ?? null);
  }
  function applySnapshot(data) {
    data = normalizeSnapshot(data);
    if (typeof data?.id !== 'string' || !Number.isSafeInteger(data.version)
      || !Array.isArray(data.tasks) || !Array.isArray(data.runs) || !Array.isArray(data.events))
      throw new Error('The server returned an invalid workspace model.');
    const current = getWorkspace();
    if (current?.id === data.id && current.version > data.version) return false;
    if (current?.id !== data.id || JSON.stringify(current?.authentication?.principal ?? null) !== JSON.stringify(data.authentication?.principal ?? null)) epoch++;
    setWorkspace(data);
    return true;
  }
  function schedulePoll() {
    clearTimer(timer); timer = null;
    if (pending || workspaceAccessLost(state.error)) return;
    const {taskStarting, active} = activity();
    timer = setTimer(() => refresh(), state.error ? 7000 : taskStarting ? 400 : active ? 1400 : 7000);
  }
  function refresh(force = false) {
    if (pending) {
      if (force) pending.again = true;
      return pending.promise;
    }
    clearTimer(timer); timer = null;
    const flight = {force, again:false, promise:null};
    pending = flight;
    flight.promise = read(flight);
    return flight.promise;
  }
  async function read(flight) {
    let succeeded = false;
    try {
      do {
        const force = flight.force;
        flight.again = false;
        state.loading = true; onChange();
        const isCurrent=captureSession();
        try {
          const path = getPath(), data = await api(path);
          if (pending !== flight || !isCurrent()) return false;
          // The caller needs state after an action. Do not briefly publish the
          // older read: it could invalidate the newly selected task or candidate.
          if (flight.again || path !== getPath()) { flight.force = true; flight.again = true; continue; }
          const previous = getWorkspace(), recoveredError = state.error;
          if (applySnapshot(data)) {
            state.lastSyncedAt = now(); state.lastSyncedVersion = data.version;
          }
          state.error = null; state.loading = false; succeeded = true;
          onSnapshot(getWorkspace(), previous, {force, recoveredError});
        } catch (error) {
          if (pending !== flight || !isCurrent()) return false;
          if(workspaceAccessLost(error)){invalidate(error);return false;}
          if (flight.again) { flight.force = true; continue; }
          state.loading = false; state.error = error; succeeded = false;
          onError(error);
        }
        flight.force = true;
      } while (pending === flight && flight.again);
      return succeeded;
    } finally {
      if (pending === flight) {
        pending = null; state.loading = false; onChange(); schedulePoll();
      }
    }
  }
  function reconnect() {
    // A replaced credential may select another workspace. Old reads and action
    // completions cannot publish into this connection, even if its ID repeats.
    epoch++; pending = null;
    return refresh(true);
  }
  return {state, refresh, reconnect, invalidate, schedulePoll, captureSession, applySnapshot};
}
