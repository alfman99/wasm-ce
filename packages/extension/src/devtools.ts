/**
 * DevTools bootstrap. Chrome loads this page once per DevTools window and expects it to
 * register the panels; the page itself is never shown, so it only registers the panel and tells it
 * when it is on screen.
 *
 * The panel is created with no icon: an empty string is a valid icon slot, and shipping a
 * binary blob for a 16px tab label would be the only asset this extension cannot generate.
 */
chrome.devtools.panels.create('WasmCheat', '', 'panel.html', (panel) => {
  // The panel's document stays alive and "visible" while another DevTools tab is in front, so its
  // live reads would keep running. Tell it when it is actually on screen.
  let shown: Window | undefined;
  panel.onShown.addListener((window) => {
    shown = window;
    window.dispatchEvent(new Event('wasmcheat:shown'));
  });
  panel.onHidden.addListener(() => shown?.dispatchEvent(new Event('wasmcheat:hidden')));
});
