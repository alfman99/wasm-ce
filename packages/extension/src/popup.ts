import type { TabInfo } from '@wasmcheat/protocol';

/**
 * The toolbar popup answers one question ("is this tab set up?") and gets out of the way.
 *
 * There is nothing to approve: the panel targets the tab you open it on, and a game is a game
 * because you opened it. The only thing worth surfacing here is the bridge, because a missing or
 * misconfigured bridge makes the panel look broken.
 */

interface PopupState {
  tabs: TabInfo[];
  activeTabId: number | null;
  bridgeConnected: boolean;
  bridgeRejected: boolean;
  tokenConfigured: boolean;
  tokenSource: 'paired' | 'pasted' | 'none';
  pairingHint?: string;
}

const bridge = document.getElementById('bridge') as HTMLSpanElement;
const target = document.getElementById('target') as HTMLParagraphElement;
const stateLine = document.getElementById('state') as HTMLParagraphElement;
const hint = document.getElementById('hint') as HTMLParagraphElement;
const note = document.getElementById('note') as HTMLSpanElement;
const tokenBox = document.getElementById('token-box') as HTMLDetailsElement;
const tokenTitle = document.getElementById('token-title') as HTMLElement;
const tokenInput = document.getElementById('bridge-token') as HTMLInputElement;
const tokenSave = document.getElementById('token-save') as HTMLButtonElement;
const tokenHint = document.getElementById('token-hint') as HTMLSpanElement;

function setPill(text: string, tone: 'idle' | 'live' | 'warn' | 'bad'): void {
  bridge.textContent = text;
  bridge.className = `pill pill--${tone}`;
}

function renderBridge(info: PopupState): void {
  if (info.bridgeRejected) setPill('token refused', 'bad');
  else if (info.bridgeConnected && info.tokenSource !== 'none') setPill('bridge live', 'live');
  else if (info.pairingHint) setPill('waiting for bridge', 'warn');
  else setPill('bridge offline', 'warn');

  // The token field is a repair tool, not a step: show it only when the bridge is unhappy about it.
  const needsToken = info.bridgeRejected || (!info.tokenConfigured && !info.pairingHint);
  tokenBox.hidden = !needsToken;
  tokenTitle.textContent = info.tokenSource === 'paired' ? 'Bridge · paired' : 'Bridge token';
  tokenHint.textContent = info.bridgeRejected
    ? 'The bridge refused this extension. Paste ~/.wasmcheat/token if pairing is off.'
    : info.tokenSource === 'paired'
      ? 'Paired with this machine. Nothing to paste.'
      : '';
}

async function refresh(): Promise<void> {
  let response: PopupState | undefined;
  try {
    response = (await chrome.runtime.sendMessage({ type: 'popup.state' })) as PopupState | undefined;
  } catch (error) {
    response = undefined;
    note.textContent = String((error as Error)?.message ?? error);
  }
  if (!response) {
    setPill('extension not answering', 'bad');
    target.textContent = 'The extension did not answer.';
    stateLine.textContent = 'Press Refresh. If it keeps failing, reload WasmCheat in chrome://extensions.';
    hint.textContent = '';
    return;
  }
  renderBridge(response);

  const tab = response.tabs.find((entry) => entry.tabId === response.activeTabId);
  if (!tab) {
    target.textContent = 'No web page in front.';
    stateLine.textContent = '';
    hint.textContent =
      'Switch to the page you want to work on and open DevTools there. Chrome extension pages and browser settings cannot be attached to.';
    note.textContent = `${response.tabs.length} ${response.tabs.length === 1 ? 'tab' : 'tabs'} visible`;
    return;
  }

  target.textContent = tab.title || tab.url;
  stateLine.textContent = tab.agentAttached
    ? 'Page agent running. Open DevTools → WasmCheat to scan.'
    : 'Nothing attached yet. Open DevTools → WasmCheat on this tab and press Attach.';
  hint.textContent =
    'Scan for a number you can see, narrow the list, then write or freeze it. The panel works on the tab you open it on.';
  note.textContent = `tab ${tab.tabId}`;
}

document.getElementById('refresh')?.addEventListener('click', () => void refresh());
tokenSave.addEventListener('click', () => {
  void (async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      tokenHint.textContent = 'Paste the contents of ~/.wasmcheat/token first.';
      return;
    }
    await chrome.storage.local.set({ bridgeToken: token, bridgeTokenSource: 'pasted' });
    await refresh();
  })();
});
window.addEventListener('focus', () => void refresh());
void refresh();
