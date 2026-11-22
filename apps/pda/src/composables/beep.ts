let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 短促提示音（成功：单音；失败：双低音） */
export function beep(kind: 'ok' | 'fail' = 'ok') {
  const ac = getCtx();
  if (!ac) return;
  const notes = kind === 'ok' ? [{ f: 880, t: 0, d: 0.09 }] : [
    { f: 320, t: 0, d: 0.13 },
    { f: 240, t: 0.14, d: 0.18 },
  ];
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.f;
    gain.gain.setValueAtTime(0.0001, ac.currentTime + n.t);
    gain.gain.exponentialRampToValueAtTime(0.22, ac.currentTime + n.t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + n.t + n.d);
    osc.connect(gain).connect(ac.destination);
    osc.start(ac.currentTime + n.t);
    osc.stop(ac.currentTime + n.t + n.d + 0.02);
  }
}

export function vibrate(pattern: number | number[] = 40) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern);
}
