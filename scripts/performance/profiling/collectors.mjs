/** Bounded profiling-only counters. No props, IPC arguments, responses or document text are retained. */
export function createReactProfileCollector({now = () => performance.now(), maxBoundaries = 16, slowestLimit = 8} = {}) {
  let active = false, label = '', started = 0, ended = 0;
  let boundaries = new Map();
  const snapshot = () => ({label, elapsedMs: Math.max(0, (active ? now() : ended) - started),
    rootCommits: boundaries.get('root')?.commits ?? 0,
    boundaries: [...boundaries.values()].map(row => ({...row, phases: {...row.phases}, slowest: row.slowest.map(sample => ({...sample}))}))
      .sort((a,b) => b.actualRenderMs - a.actualRenderMs),
    measurement: 'React Profiler onRender actualDuration is inclusive subtree render time, not commit-phase duration. Nested boundaries overlap and must not be summed. baseDuration is React\'s estimate, not an observed unoptimized render.'});
  return {
    begin(name) {active = true; label = String(name); started = now(); ended = started; boundaries = new Map();},
    end() {ended = now(); active = false; return snapshot();},
    snapshot,
    onRender(id, phase, actualDuration, baseDuration, startTime, commitTime) {
      if (!active) return;
      if (![actualDuration, baseDuration, startTime, commitTime].every(Number.isFinite)) throw new Error('react_profile_invalid_timing');
      let row = boundaries.get(id);
      if (row === undefined) {
        if (boundaries.size >= maxBoundaries) throw new Error('react_profile_boundary_limit');
        row = {id, commits: 0, actualRenderMs: 0, maxActualRenderMs: 0, latestBaseRenderMs: 0,
          phases: {mount: 0, update: 0, 'nested-update': 0}, slowest: []};
        boundaries.set(id, row);
      }
      if (!(phase in row.phases)) throw new Error('react_profile_unknown_phase');
      row.commits++;
      row.phases[phase]++;
      row.actualRenderMs += actualDuration;
      row.maxActualRenderMs = Math.max(row.maxActualRenderMs, actualDuration);
      row.latestBaseRenderMs = baseDuration;
      row.slowest.push({phase, actualRenderMs: actualDuration, baseRenderMs: baseDuration, startTime, commitTime});
      row.slowest.sort((a,b) => b.actualRenderMs - a.actualRenderMs);
      row.slowest.length = Math.min(slowestLimit, row.slowest.length);
    }
  };
}

export function createIpcProfileCollector(invoke, {now = () => performance.now(), maxChannels = 1024} = {}) {
  let active = false, epoch = 0, label = '', started = 0, ended = 0, channels = new Map();
  const snapshot = () => ({label, elapsedMs: Math.max(0, (active ? now() : ended) - started),
    calls: [...channels.values()].reduce((sum,row) => sum + row.calls,0),
    channels: [...channels.values()].map(row => ({...row})).sort((a,b) => b.calls - a.calls || a.channel.localeCompare(b.channel)),
    measurement: 'Exact ipcRenderer.invoke starts during this window, by channel. Round-trip timings cover replies completed before end; inFlight calls are explicit. Main-to-renderer events and callback deliveries are not invoke requests. No payload or wire-byte estimate is collected.'});
  return {
    begin(name) {epoch++; active = true; label = String(name); started = now(); ended = started; channels = new Map();},
    end() {ended = now(); active = false; return snapshot();},
    snapshot,
    invoke(channel, ...args) {
      if (!active) return invoke(channel, ...args);
      const requestEpoch = epoch, callStarted = now();
      let row = channels.get(channel);
      if (row === undefined) {
        if (channels.size >= maxChannels) throw new Error('ipc_profile_channel_limit');
        row = {channel, calls: 0, fulfilled: 0, rejected: 0, applicationFailures: 0, inFlight: 0,
          maxInFlight: 0, completedRoundTripMs: 0, maxRoundTripMs: 0};
        channels.set(channel, row);
      }
      row.calls++; row.inFlight++;
      row.maxInFlight = Math.max(row.maxInFlight, row.inFlight);
      const finish = (rejected, result) => {
        if (!active || requestEpoch !== epoch) return;
        row.inFlight--;
        row[rejected ? 'rejected' : 'fulfilled']++;
        if (!rejected && result?.ok === false) row.applicationFailures++;
        const ms = now() - callStarted;
        row.completedRoundTripMs += ms;
        row.maxRoundTripMs = Math.max(row.maxRoundTripMs, ms);
      };
      try {
        const result = invoke(channel, ...args);
        // Observe completion while returning the original promise and preserving rejection semantics.
        result.then(value => finish(false,value), () => finish(true));
        return result;
      } catch (error) {finish(true); throw error;}
    }
  };
}
