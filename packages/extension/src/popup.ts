import type { ApprovalState, TabInfo } from '@wasmcheat/protocol';

interface TrustedSite {
  origin: string;
  at: number;
  label: string;
}

interface PopupState {
  approvals: Record<string, { state: ApprovalState; reason: string; at: number }>;
  tabs: TabInfo[];
  activeTabId: number | null;
  trusted: TrustedSite[];
  bridgeConnected: boolean;
  tokenConfigured: boolean;
  tokenSource?: 'paired' | 'pasted' | 'none';
}

const tabsList = document.getElementById('tabs') as HTMLUListElement;
const currentList = document.getElementById('current') as HTMLUListElement;
const otherList = document.getElementById('others-list') as HTMLUListElement;
const otherCount = document.getElementById('others-count') as HTMLSpanElement;
const trustedList = document.getElementById('trusted') as HTMLUListElement;
const trustedSection = document.getElementById('trusted-section') as HTMLElement;
const trustedEmpty = document.getElementById('trusted-empty') as HTMLSpanElement;
const bridgePill = document.getElementById('bridge') as HTMLSpanElement;
const hint = document.getElementById('hint') as HTMLSpanElement;
const refresh = document.getElementById('refresh') as HTMLButtonElement;
const tokenInput = document.getElementById('bridge-token') as HTMLInputElement;
const tokenSave = document.getElementById('token-save') as HTMLButtonElement;
const tokenHint = document.getElementById('token-hint') as HTMLSpanElement;
const tokenTitle = document.getElementById('token-title') as HTMLLabelElement;

function send<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function describeState(state: ApprovalState): string {
  switch (state) {
    case 'pending':
      return 'needs approval';
    case 'granted':
      return 'approved';
    case 'revoked':
      return 'revoked';
    default:
      return 'not approved';
  }
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', async () => {
    element.disabled = true;
    try {
      await onClick();
      await render();
    } finally {
      element.disabled = false;
    }
  });
  return element;
}

/** Buttons a row offers, by state. Trust is the way out of the prompt, so it sits next to Approve. */
function actionsFor(tab: TabInfo): HTMLButtonElement[] {
  if (tab.approval === 'pending') {
    return [
      button('Approve', 'primary', () => send({ type: 'popup.approve', tabId: tab.tabId })),
      button('Deny', 'danger', () => send({ type: 'popup.deny', tabId: tab.tabId })),
      button('Always allow this site', 'ghost', () => send({ type: 'popup.trust', tabId: tab.tabId })),
    ];
  }
  if (tab.approval === 'granted') {
    return [button('Revoke', 'danger', () => send({ type: 'popup.deny', tabId: tab.tabId }))];
  }
  return [
    button('Approve', 'primary', () => send({ type: 'popup.approve', tabId: tab.tabId })),
    button('Reload & attach', 'ghost', async () => {
      await send({ type: 'popup.approve', tabId: tab.tabId });
      await chrome.tabs.reload(tab.tabId);
    }),
    button('Always allow this site', 'ghost', () => send({ type: 'popup.trust', tabId: tab.tabId })),
  ];
}

function renderTab(tab: TabInfo): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'tab';
  item.dataset.state = tab.approval;
  item.dataset.tabId = String(tab.tabId);

  const title = document.createElement('span');
  title.className = 'tab__title';
  title.textContent = tab.title || '(untitled tab)';
  title.title = tab.title;

  const state = document.createElement('span');
  // The one row that needs a decision is the only thing in the popup allowed to carry colour.
  state.className = tab.approval === 'pending' ? 'tab__state tab__state--pending' : 'tab__state';
  state.textContent = describeState(tab.approval);

  const url = document.createElement('span');
  url.className = 'tab__url';
  url.textContent = tab.url;

  const actions = document.createElement('div');
  actions.className = 'tab__actions';
  actions.append(...actionsFor(tab));

  item.append(title, state, url, actions);
  return item;
}

/**
 * The tab in front of you gets the first row, in the same shape as every other row: one selector
 * (`li.tab[data-tab-id]`) finds a tab wherever the popup put it, which is what the docs and the
 * end-to-end suite rely on.
 */
function renderCurrent(tab: TabInfo | undefined, trusted: TrustedSite[]): void {
  currentList.replaceChildren();
  if (!tab) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No page in front. Open the game or app you want to inspect, then reload it.';
    currentList.append(empty);
    return;
  }
  const item = renderTab(tab);
  item.classList.add('tab--current');
  const origin = originOf(tab.url);
  if (trusted.some((site) => site.origin === origin) && tab.approval !== 'granted') {
    const state = item.querySelector('.tab__state');
    if (state) state.textContent = 'trusted site';
  }
  currentList.append(item);
}

function renderTrusted(sites: TrustedSite[]): void {
  trustedSection.hidden = false;
  trustedList.replaceChildren();
  trustedEmpty.hidden = sites.length > 0;
  for (const site of sites) {
    const row = document.createElement('li');
    row.className = 'trusted__row';
    const origin = document.createElement('span');
    origin.className = 'trusted__origin';
    origin.textContent = site.origin;
    origin.title = site.label;
    row.append(
      origin,
      button('Forget', 'ghost', () => send({ type: 'popup.untrust', origin: site.origin })),
    );
    trustedList.append(row);
  }
}

/**
 * The token is normally invisible: the service worker pairs with the local bridge on first connect.
 * The field stays for the one setup where pairing is switched off, and it must actually save — an
 * input that looks editable and does nothing is worse than no input.
 */
async function renderToken(state: PopupState): Promise<void> {
  const stored = await chrome.storage.local.get('bridgeToken');
  const saved = typeof stored.bridgeToken === 'string' ? (stored.bridgeToken as string) : '';
  if (document.activeElement !== tokenInput && tokenInput.value === '') tokenInput.value = saved;
  // When pairing did its job the field is not needed, so it is not shown: an empty-looking form asks
  // a question the human does not have to answer.
  const paired = state.tokenSource === 'paired';
  tokenInput.hidden = paired;
  tokenSave.hidden = paired;
  tokenTitle.textContent = paired ? 'Bridge' : 'Bridge token';
  tokenHint.textContent = paired
    ? 'Paired with this machine. Nothing to paste.'
    : state.tokenSource === 'pasted'
      ? 'Token saved. The bridge reconnects by itself.'
      : 'The server pairs with this extension on its own. Paste a token only if pairing is off.';
}

async function render(): Promise<void> {
  const state = await send<PopupState>({ type: 'popup.state' });
  bridgePill.textContent = state.bridgeConnected ? 'bridge connected' : 'bridge offline';
  bridgePill.className = `pill ${state.bridgeConnected ? 'pill--live' : 'pill--idle'}`;

  const current = state.tabs.find((tab) => tab.tabId === state.activeTabId);
  renderCurrent(current, state.trusted);

  // Tabs you already decided about stay visible; the rest of the browser is behind one click,
  // because it is not your business until you attach to it.
  const decided = state.tabs.filter((tab) => tab.approval !== 'none' && tab.tabId !== state.activeTabId);
  tabsList.replaceChildren();
  // Nothing decided yet is not worth a paragraph: the line under the card already says so.
  tabsList.hidden = decided.length === 0;
  for (const tab of decided) tabsList.append(renderTab(tab));

  const others = state.tabs.filter((tab) => tab.approval === 'none' && tab.tabId !== state.activeTabId);
  otherList.replaceChildren();
  otherCount.textContent = String(others.length);
  for (const tab of others) otherList.append(renderTab(tab));

  renderTrusted(state.trusted);
  await renderToken(state);

  const pending = state.tabs.filter((tab) => tab.approval === 'pending').length;
  const granted = state.tabs.filter((tab) => tab.approval === 'granted').length;
  hint.textContent =
    pending > 0
      ? `${pending} request${pending === 1 ? '' : 's'} waiting for you`
      : granted > 0
        ? `${granted} tab${granted === 1 ? '' : 's'} approved`
        : state.bridgeConnected
          ? 'Bridge is up. Nothing is approved yet.'
          : 'Start the MCP server to connect the bridge.';
}

tokenSave.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (token === '') {
    tokenHint.textContent = 'Paste the contents of ~/.wasmcheat/token first.';
    return;
  }
  await chrome.storage.local.set({ bridgeToken: token, bridgeTokenSource: 'pasted' });
  tokenHint.textContent = 'Token saved. The bridge reconnects by itself.';
});

refresh.addEventListener('click', () => void render());
void render();
setInterval(() => void render(), 2000);
