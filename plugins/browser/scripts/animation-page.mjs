// A test page that only becomes usable when the browser actually runs its
// animations — the failure mode of an occluded Safari automation window
// (document.visibilityState "hidden": requestAnimationFrame and CSS animations
// are suspended, so a framework page transition never finishes).
//
// On load it plays the same "out-in" layout swap as Vue 2's <transition>
// (Nuxt 2 wraps every layout in one): add `leave leave-active`, wait for the
// next frame via requestAnimationFrame, swap `leave` for `leave-to`, wait for
// `transitionend`, remove the old layout, then mount the real content —
// a sign-up form, `#form`. Until then only a spinner (`#loading`) shows.
// Alongside, three independent probes: a CSS @keyframes animation
// (`animationend`), a Web Animations API animation (`.finished`) and a
// requestAnimationFrame counter. Everything lands in `window.__anim`:
//
//   { form: bool, transition: 'pending'|'done', cssAnimation, webAnimation,
//     frames: number, visibility: [states seen, in order], elapsedMs }
//
// `ANIMATION_OK` is the predicate scripts/live-parking.mjs waits for.

export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>animation-test</title>
<style>
  body { font: 15px -apple-system, system-ui, sans-serif; margin: 40px; }
  .layout { transition: opacity 300ms ease; }
  .leave { opacity: 1; } .leave-active { transition: opacity 300ms ease; } .leave-to { opacity: 0; }
  @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
  #css-probe { width: 12px; height: 12px; background: #36c; animation: spin 250ms linear 1; }
</style></head><body>
<div id="old" class="layout"><p id="loading">Loading…</p></div>
<div id="css-probe"></div><div id="waapi-probe" style="width:12px;height:12px;background:#c63"></div>
<pre id="report"></pre>
<script>
const t0 = performance.now();
const s = window.__anim = { form: false, transition: 'pending', cssAnimation: 'pending', webAnimation: 'pending', frames: 0, visibility: [document.visibilityState], elapsedMs: 0 };
const report = () => { s.elapsedMs = Math.round(performance.now() - t0); document.getElementById('report').textContent = JSON.stringify(s, null, 1); };
document.addEventListener('visibilitychange', () => { s.visibility.push(document.visibilityState); report(); });
(function tick() { s.frames++; if (s.frames % 10 === 0) report(); requestAnimationFrame(tick); })();
document.getElementById('css-probe').addEventListener('animationend', () => { s.cssAnimation = 'done'; report(); });
document.getElementById('waapi-probe').animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 250 }).finished.then(() => { s.webAnimation = 'done'; report(); });
// Vue 2 transition, leave phase of mode="out-in": nextFrame = double rAF.
const old = document.getElementById('old');
old.classList.add('leave', 'leave-active');
requestAnimationFrame(() => requestAnimationFrame(() => {
  old.classList.remove('leave'); old.classList.add('leave-to');
  old.addEventListener('transitionend', () => {
    old.remove(); s.transition = 'done';
    const form = document.createElement('form'); form.id = 'form';
    form.innerHTML = '<label>Email <input name="email" type="email"></label> <button type="button">Continue</button>';
    document.body.prepend(form); s.form = true; report();
  }, { once: true });
}));
report();
</script></body></html>`

/** JS function body (for `wait.expression`): true once every probe finished. */
export const ANIMATION_OK = 'const s = window.__anim; return !!s && s.form && s.cssAnimation === "done" && s.webAnimation === "done" && s.frames > 5'
