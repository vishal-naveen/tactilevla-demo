// A stage stand-in the rest of the page talks to from the start. Calls are no-ops until the real
// stage attaches (it may arrive late on a busy machine); the page never has to know which case it is in.
export function createStageProxy() {
  let real = null;
  const cellClicks = [], phaseClicks = [], tableClicks = [];
  const call = (name, ...args) => (real ? real[name]?.(...args) : undefined);
  return {
    get available() { return !!real; },
    get real() { return real; },
    attach(stage) {
      real = stage;
      cellClicks.forEach((cb) => stage.onCellClick(cb));
      if (typeof stage.onPhaseClick === 'function') phaseClicks.forEach((cb) => stage.onPhaseClick(cb));
      if (typeof stage.onTableClick === 'function') tableClicks.forEach((cb) => stage.onTableClick(cb));
    },
    setChapter: (...a) => call('setChapter', ...a),
    setProgress: (...a) => call('setProgress', ...a),
    setPolicy: (...a) => call('setPolicy', ...a),
    setTheme: (...a) => call('setTheme', ...a),
    setRingProgress: (...a) => call('setRingProgress', ...a),
    setReducedMotion: (...a) => call('setReducedMotion', ...a),
    reveal: (...a) => call('reveal', ...a),
    getRingScreenRect: () => (real && typeof real.getRingScreenRect === 'function' ? real.getRingScreenRect() : null),
    snapshot: (...a) => (real && typeof real.snapshot === 'function' ? real.snapshot(...a) : Promise.reject(new Error('no stage'))),
    runTask: (cell) => (real ? real.runTask(cell) : Promise.resolve()),
    onCellClick(cb) { cellClicks.push(cb); if (real) real.onCellClick(cb); },
    // Round 7 additions, all feature-detected: they quietly do nothing on a stage that lacks them.
    has: (name) => !!real && typeof real[name] === 'function',
    getTaskProgress: () => (real && typeof real.getTaskProgress === 'function' ? real.getTaskProgress() : null),
    pauseTask: () => call('pauseTask'),
    resumeTask: () => call('resumeTask'),
    scrubTask: (t) => call('scrubTask', t),
    setPhaseMarkers: (on) => call('setPhaseMarkers', on),
    runTaskAt: (pt) => (real && typeof real.runTaskAt === 'function' ? real.runTaskAt(pt) : Promise.resolve('unreachable')),
    onPhaseClick(cb) { phaseClicks.push(cb); if (real && typeof real.onPhaseClick === 'function') real.onPhaseClick(cb); },
    onTableClick(cb) { tableClicks.push(cb); if (real && typeof real.onTableClick === 'function') real.onTableClick(cb); },
    setPlaceHint: (on) => call('setPlaceHint', on),
    getPlaceHintScreenPos: () => (real && typeof real.getPlaceHintScreenPos === 'function' ? real.getPlaceHintScreenPos() : null),
    pause: () => call('pause'),
    resume: () => call('resume'),
  };
}
