/**
 * DevTools bootstrap. Chrome loads this page once per DevTools window and expects it to
 * register the panels; the page itself is never shown, so it does nothing else.
 *
 * The panel is created with no icon: an empty string is a valid icon slot, and shipping a
 * binary blob for a 16px tab label would be the only asset this extension cannot generate.
 */
chrome.devtools.panels.create('WasmCheat', '', 'panel.html');
