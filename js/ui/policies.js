import { $, $$ } from './env.js';

export function initPolicies(stage) {
  const buttons = $$('.seg-btn');
  const specs = $$('[data-spec]');
  const select = (which) => {
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.policy === which)));
    specs.forEach((s) => { s.hidden = s.dataset.spec !== which; });
    stage.setPolicy(which);
  };
  buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.policy)));
  stage.setPolicy('act');
}
